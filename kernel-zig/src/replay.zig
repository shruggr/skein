// `skein-kernel replay <source.db> <out.db>`: the log alone into a fresh store,
// a runtime with no wallet, attested answers served from the source's records
// (the replay path the TypeScript runtime had, deleted in #55). The fresh
// store first gets the pinned modules (skein-dev install, from $SKEIN_WASM_DIR
// or the repo's wasm/) and every module (raw block) the source holds, so an
// old log runs the handlers it ran. Prints {lines, state, index} as
// JSON: the runtime's log lines, the emits handed to the outbox, the log tip,
// and the index's costs and final state record (#30). The source may be in
// either store format (sqlite_store.zig imports the old one in memory).
// equiv/replays.ts compares a replay with its source.
const std = @import("std");
const envm = @import("env.zig");
const cbor = @import("cbor");
const cidm = @import("cid");
const logm = @import("log.zig");
const programs = @import("programs.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const tree = @import("tree.zig");
const beefm = @import("beef.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Value = cbor.Value;

const Capture = struct {
    gpa: std.mem.Allocator,
    lines: std.array_list.Managed([]u8),
    echo: bool,

    fn say(ctx: *anyopaque, line: []const u8) void {
        const c: *Capture = @ptrCast(@alignCast(ctx));
        c.lines.append(c.gpa.dupe(u8, line) catch return) catch return;
        if (c.echo) std.debug.print("{s}\n", .{line});
    }
};

pub fn wasmDir(gpa: std.mem.Allocator, io: std.Io) ![]const u8 {
    if (envm.get("SKEIN_WASM_DIR")) |d| return d;
    const exe = try std.process.executableDirPathAlloc(io, gpa);
    return std.fs.path.join(gpa, &.{ exe, "..", "..", "..", "wasm" });
}

/// skein-dev install: the pinned modules from the wasm directory, checked against their CIDs.
pub fn install(gpa: std.mem.Allocator, io: std.Io, ss: *SqliteStore, say: ?*const fn (line: []const u8) void) !void {
    const s = ss.store();
    const dir = try wasmDir(gpa, io);
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    for (programs.modules) |m| {
        const c = try cidm.parse(a, m.cid);
        if (try s.has(c)) continue;
        const file = try std.fmt.allocPrint(a, "{s}.wasm", .{m.name});
        const path = try std.fmt.allocPrint(a, "{s}/{s}", .{ dir, file });
        const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(1 << 30));
        if (!std.mem.eql(u8, try cidm.ofRaw(a, bytes), c)) {
            std.debug.print("wasm/{s} does not match the pinned {s}\n", .{ file, m.cid });
            return error.ModuleMismatch;
        }
        _ = try s.putBlock(c, bytes);
        if (say) |f| f(try std.fmt.allocPrint(a, "installed {s} {s}", .{ m.name, m.cid }));
    }
    // SKEIN_EXTRA_MODULES=<file>:<file>…: modules that are not pinned, installed
    // under their raw CIDs — how equiv/wallet.ts runs the wallet's component
    // build (issue #34) without pinning it. Not for live instances.
    if (envm.get("SKEIN_EXTRA_MODULES")) |list| {
        var it = std.mem.tokenizeScalar(u8, list, ':');
        while (it.next()) |path| {
            const bytes = try std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(1 << 30));
            const c = try cidm.ofRaw(a, bytes);
            if (try s.has(c)) continue;
            _ = try s.putBlock(c, bytes);
            if (say) |f| f(try std.fmt.allocPrint(a, "installed {s} {s}", .{ path, try cidm.format(a, c) }));
        }
    }
}

/// log.ts copyLog: the entries exactly as written and the records they name.
pub fn copyLog(a: std.mem.Allocator, from: *SqliteStore, to: *SqliteStore) !void {
    const src = from.store();
    const dst = to.store();
    const g = try logm.genesisOf(a, src);
    for (g.get("programs").?.map) |p| {
        const b = (try src.bytes(a, p.value.cid)) orelse return error.NotFound;
        _ = try dst.putBlock(p.value.cid, b);
    }
    // Programs the genesis's dispatch rows name that are not among its programs (the wallet, #29; a
    // route handler the middleware's steps call, #68): replay needs them as the source holds them.
    if (g.get("dispatch")) |rs| if (rs == .array) for (rs.array) |r| {
        const h = Value.cidOf(r.get("program")) orelse continue;
        if (try dst.has(h)) continue;
        const b = (try src.bytes(a, h)) orelse continue;
        _ = try dst.putBlock(h, b);
    };
    // The system tree the genesis booted from (issue #4): pre-filled, not carried by any entry.
    if (Value.cidOf(g.get("tree"))) |t| try copyTree(a, src, dst, t);
    for (try src.logFrom(a, 0)) |c| {
        const e = (try src.get(a, c)) orelse return error.NotFound;
        if (!logm.isLogEntry(e)) {
            std.debug.print("log: entry #{d} is not a format-5 entry (issue #68: requests; #40: messages as mail records)\n", .{Value.intOf(e.get("n")) orelse -1});
            return error.BadSignature;
        }
        for ([_][]const u8{ "genesis", "mail", "event", "request" }) |k| if (Value.cidOf(e.get(k))) |x| {
            const b = (try src.bytes(a, x)) orelse return error.NotFound;
            _ = try dst.putBlock(x, b);
        };
        // A message's body (#40), beside its record.
        if (Value.cidOf(e.get("mail"))) |mc| if (src.getOpt(a, mc)) |m| if (Value.cidOf(m.get("body"))) |bc| {
            if (try src.bytes(a, bc)) |b| {
                _ = try dst.putBlock(bc, b);
            }
        };
        // #121: what the door put for a request, beside it.
        if (Value.cidOf(e.get("request"))) |rc| if (src.getOpt(a, rc)) |req| try copyDoor(a, src, dst, req);
        switch (try dst.logAppend(a, e)) {
            .ok => |got| if (!std.mem.eql(u8, got, c)) return error.CopiedToDifferentCid,
            .rejected => |r| {
                std.debug.print("{s}\n", .{r.message});
                return error.Rejected;
            },
        }
    }
}

/// What the door put for a request (#121), beside it: every pointer record the package links (and,
/// for a signed message carried in, the body the door put — the package's `body` bytes — and the
/// records it links), each with the blocks it names: its transactions, its BUMPs' bytes, and the
/// merkle nodes each BUMP the door checked reveals.
fn copyDoor(a: std.mem.Allocator, src: @import("store.zig").Store, dst: @import("store.zig").Store, req: Value) !void {
    try copyLinked(a, src, dst, req);
    if (std.mem.eql(u8, Value.str(req.get("kind")) orelse "", "message")) if (Value.bytesOf(req.get("body"))) |bb| {
        const body = cbor.decode(a, bb) catch return;
        const bc = try cbor.cidOfValue(a, body);
        if (try src.bytes(a, bc)) |b| {
            _ = try dst.putBlock(bc, b);
        }
        try copyLinked(a, src, dst, body);
    };
}

fn copyLinked(a: std.mem.Allocator, src: @import("store.zig").Store, dst: @import("store.zig").Store, v: Value) anyerror!void {
    switch (v) {
        .cid => |c| {
            const rec = src.getOpt(a, c) orelse return;
            if (!beefm.isRecord(rec)) return;
            _ = try dst.putBlock(c, (try src.bytes(a, c)).?);
            if (rec.get("txs")) |ts| if (ts == .array) for (ts.array) |t| if (Value.cidOf(t)) |tc| {
                if (try src.bytes(a, tc)) |b| {
                    _ = try dst.putBlock(tc, b);
                }
            };
            if (rec.get("bumps")) |bs| if (bs == .array) for (bs.array) |b| {
                const pc = Value.cidOf(b.get("path")) orelse continue;
                const pb = (try src.bytes(a, pc)) orelse continue;
                _ = try dst.putBlock(pc, pb);
                if (Value.cidOf(b.get("block")) == null) continue;
                const rev = beefm.reveal(a, beefm.bumpOf(a, pb) catch continue) catch continue;
                for (rev.nodes) |n| {
                    const nc = try beefm.txCid(a, n.hash);
                    if (try src.bytes(a, nc)) |x| {
                        _ = try dst.putBlock(nc, x);
                    }
                }
            };
        },
        .map => |m| for (m) |e| try copyLinked(a, src, dst, e.value),
        .array => |xs| for (xs) |x| try copyLinked(a, src, dst, x),
        else => {},
    }
}

/// A git tree and everything under it (blobs, subtrees, gitlinked records the source holds).
fn copyTree(a: std.mem.Allocator, src: @import("store.zig").Store, dst: @import("store.zig").Store, t: []const u8) !void {
    if (try dst.has(t)) return;
    const b = (try src.bytes(a, t)) orelse return error.NotFound;
    _ = try dst.putBlock(t, b);
    for (try tree.parseTree(a, b)) |e| switch (e.mode) {
        .dir => try copyTree(a, src, dst, e.cid),
        .module => if (try src.bytes(a, e.cid)) |x| {
            _ = try dst.putBlock(e.cid, x);
        },
        else => if (!(try dst.has(e.cid))) {
            _ = try dst.putBlock(e.cid, (try src.bytes(a, e.cid)) orelse return error.NotFound);
        },
    };
}

pub fn main(gpa: std.mem.Allocator, io: std.Io, source: []const u8, out: []const u8) !u8 {
    const src = try SqliteStore.openReadOnly(gpa, source);
    defer src.close();
    const dst = try SqliteStore.open(gpa, io, out);
    defer dst.close();
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    try install(gpa, io, dst, null);
    for (try src.blocksOfCodec(a, cidm.RAW)) |b| {
        _ = try dst.store().putBlock(b[0], b[1]);
    }
    try copyLog(a, src, dst);

    const r = try runner.Runner.init(gpa);
    // SKEIN_REPLAY_MODULE=<cid>=<file>: run <file> wherever the log runs module
    // <cid> (issue #34: a program's component build against its preview1 log).
    if (envm.get("SKEIN_REPLAY_MODULE")) |spec| {
        const eq = std.mem.indexOfScalar(u8, spec, '=') orelse return error.BadReplayModule;
        r.subst = .{ .cid = try cidm.parse(a, spec[0..eq]), .bytes = try std.Io.Dir.cwd().readFileAlloc(io, spec[eq + 1 ..], a, .limited(1 << 30)) };
    }
    var cap = Capture{ .gpa = gpa, .lines = .init(gpa), .echo = envm.get("SKEIN_REPLAY_ECHO") != null };
    const rt = try scheduler.Runtime.init(gpa, dst.store(), r, .{ .ctx = &cap, .say = Capture.say });
    rt.witness = try scheduler.Witness.from(gpa, src.store());
    try rt.start();
    rt.kick();
    rt.stop();

    const tip = (try dst.store().logTip(a)) orelse "";
    var o = std.array_list.Managed(u8).init(gpa);
    const w = &o;
    try w.appendSlice("{\"lines\":[");
    for (cap.lines.items, 0..) |l, i| try w.print("{s}{f}", .{ if (i > 0) "," else "", std.json.fmt(l, .{}) });
    try dst.store().commit();
    const st = dst.ix.stats();
    try w.print("],\"state\":\"{s}\",\"index\":{{\"states\":{d},\"commits\":{d},\"nodes\":{d},\"bytes\":{d},\"record\":\"{s}\"}}}}\n", .{
        if (tip.len > 0) try cidm.format(a, tip) else "", st.states, st.commits, st.nodes, st.node_bytes, try cidm.format(a, try dst.ix.stateCid(a)),
    });
    try std.Io.File.stdout().writeStreamingAll(io, o.items);
    return 0;
}
