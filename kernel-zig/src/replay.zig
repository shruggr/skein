// `skein-kernel replay <source.db> <out.db>`: the log alone into a fresh store,
// a runtime with no wallet, attested answers served from the source's records
// (the TS runtime's replay path: copyLog + Runtime + witnessFrom). The fresh
// store first gets the pinned modules (skein-dev install, from $SKEIN_WASM_DIR
// or the repo's wasm/) and every module (raw block) the source holds, so an
// old log runs the handlers it ran. Prints {lines, sent, state} as JSON: the
// runtime's log lines, the emits handed to the outbox, the state hash.
// equiv/replay.ts does the same with the TypeScript runtime; equiv/run.sh
// compares the two stores table by table.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const logm = @import("log.zig");
const programs = @import("programs.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Value = cbor.Value;

const Capture = struct {
    gpa: std.mem.Allocator,
    lines: std.array_list.Managed([]u8),
    sent: std.array_list.Managed([]u8),
    echo: bool,

    fn say(ctx: *anyopaque, line: []const u8) void {
        const c: *Capture = @ptrCast(@alignCast(ctx));
        c.lines.append(c.gpa.dupe(u8, line) catch return) catch return;
        if (c.echo) std.debug.print("{s}\n", .{line});
    }
    fn send(ctx: *anyopaque, a: std.mem.Allocator, o: Value) anyerror!void {
        const c: *Capture = @ptrCast(@alignCast(ctx));
        try c.sent.append(try c.gpa.dupe(u8, try cidm.format(a, Value.cidOf(o.get("emit")).?)));
    }
};

pub fn wasmDir(gpa: std.mem.Allocator) ![]const u8 {
    if (std.posix.getenv("SKEIN_WASM_DIR")) |d| return d;
    const exe = try std.fs.selfExeDirPathAlloc(gpa);
    return std.fs.path.join(gpa, &.{ exe, "..", "..", "..", "wasm" });
}

/// skein-dev install: the pinned modules from the wasm directory, checked against their CIDs.
pub fn install(gpa: std.mem.Allocator, ss: *SqliteStore, say: ?*const fn (line: []const u8) void) !void {
    const s = ss.store();
    const dir = try wasmDir(gpa);
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    for (programs.modules) |m| {
        const c = try cidm.parse(a, m.cid);
        if (try s.has(c)) continue;
        const path = try std.fmt.allocPrint(a, "{s}/{s}.wasm", .{ dir, m.name });
        const bytes = try std.fs.cwd().readFileAlloc(a, path, 1 << 30);
        if (!std.mem.eql(u8, try cidm.ofRaw(a, bytes), c)) {
            std.debug.print("wasm/{s}.wasm does not match the pinned {s}\n", .{ m.name, m.cid });
            return error.ModuleMismatch;
        }
        try s.putBlock(c, bytes);
        if (say) |f| f(try std.fmt.allocPrint(a, "installed {s} {s}", .{ m.name, m.cid }));
    }
}

/// log.ts copyLog: the entries exactly as signed and the records they name.
pub fn copyLog(a: std.mem.Allocator, from: *SqliteStore, to: *SqliteStore) !void {
    const src = from.store();
    const dst = to.store();
    const g = try logm.genesisOf(a, src);
    for (g.get("programs").?.map) |p| {
        const b = (try src.bytes(a, p.value.cid)) orelse return error.NotFound;
        try dst.putBlock(p.value.cid, b);
    }
    const host = Value.str(g.get("host")).?;
    for (try src.logFrom(a, 0)) |c| {
        const e = (try src.get(a, c)) orelse return error.NotFound;
        if (!logm.verifyEntry(a, e, host)) {
            std.debug.print("log: entry #{d} has a bad signature\n", .{Value.intOf(e.get("n")) orelse -1});
            return error.BadSignature;
        }
        for ([_][]const u8{ "genesis", "envelope", "body" }) |k| if (Value.cidOf(e.get(k))) |x| {
            const b = (try src.bytes(a, x)) orelse return error.NotFound;
            try dst.putBlock(x, b);
        };
        switch (try dst.logAppend(a, e)) {
            .ok => |got| if (!std.mem.eql(u8, got, c)) return error.CopiedToDifferentCid,
            .rejected => |r| {
                std.debug.print("{s}\n", .{r.message});
                return error.Rejected;
            },
        }
    }
}

pub fn main(gpa: std.mem.Allocator, source: []const u8, out: []const u8) !u8 {
    const src = try SqliteStore.openReadOnly(gpa, source);
    defer src.close();
    const dst = try SqliteStore.open(gpa, out);
    defer dst.close();
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    try install(gpa, dst, null);
    for (try src.blocksOfCodec(a, cidm.RAW)) |b| try dst.store().putBlock(b[0], b[1]);
    try copyLog(a, src, dst);

    const r = try runner.Runner.init(gpa);
    var cap = Capture{ .gpa = gpa, .lines = .init(gpa), .sent = .init(gpa), .echo = std.posix.getenv("SKEIN_REPLAY_ECHO") != null };
    const rt = try scheduler.Runtime.init(gpa, dst.store(), r, .{ .ctx = &cap, .say = Capture.say, .send = Capture.send });
    rt.witness = try scheduler.Witness.from(gpa, src.store());
    try rt.start();
    rt.kick();
    rt.stop();

    const tip = (try dst.store().logTip(a)) orelse "";
    var o = std.array_list.Managed(u8).init(gpa);
    const w = o.writer();
    try w.writeAll("{\"lines\":[");
    for (cap.lines.items, 0..) |l, i| try w.print("{s}{f}", .{ if (i > 0) "," else "", std.json.fmt(l, .{}) });
    try w.writeAll("],\"sent\":[");
    for (cap.sent.items, 0..) |l, i| try w.print("{s}\"{s}\"", .{ if (i > 0) "," else "", l });
    try dst.store().commit();
    const st = dst.ix.stats();
    try w.print("],\"state\":\"{s}\",\"index\":{{\"states\":{d},\"commits\":{d},\"nodes\":{d},\"bytes\":{d},\"record\":\"{s}\"}}}}\n", .{
        if (tip.len > 0) try cidm.format(a, tip) else "", st.states, st.commits, st.nodes, st.node_bytes, try cidm.format(a, try dst.ix.stateCid(a)),
    });
    try std.fs.File.stdout().writeAll(o.items);
    return 0;
}
