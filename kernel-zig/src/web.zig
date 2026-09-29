// The kernel compiled to wasm for the browser (issue #35): the root of
// `zig build web` (→ zig-out/web/skein-kernel.wasm). The same kernel as
// `skein-kernel serve` — log, scheduler, index, programs — with the engine
// and the store behind the JS shim (engine_v8.zig, web_store.zig). What
// `serve` takes as frames on stdin is exported here as functions; what it
// asks and tells the router it asks and tells the shim (`skein_peer`).
//
// Exports (pointers are into this module's memory; a result is left in the
// result buffer: skein_result() / its length the call's return value; a
// failure returns -(length + 1) with its message there):
//
//   skein_alloc(n) → ptr · skein_free(ptr, n)       buffers for arguments
//   skein_result() → ptr                            the last call's result bytes
//   skein_args() → ptr                              16 × i64: a host call's arguments / result
//   skein_open(store) → 0 | < 0                       open the shim's store `store` and a runtime over it
//   skein_modules() → n                             dag-cbor [{name, cid}]: the pinned modules and files to install
//   skein_put_block(cid, n, bytes, n) → 0 | < 0     a block, checked against its CID (install, import)
//   skein_get_block(cid, n) → n | -1                a block's bytes
//   skein_admit(frame, n) → n                       serve's `admit` ({entry, body?}): the one call in that writes; not yet processed
//   skein_start() → n                               resume what the last run left (serve's `start`)
//   skein_drain() → n                               process everything admitted (the step loop)
//   skein_next_deadline() → ms | -1                 the earliest sleeper's deadline (the waker)
//   skein_state() → n                               dag-cbor {state, log, cursor}
//   skein_call(frame, n) → n                        any other serve op: {op, v} → {ok} | {error, rejected?}
//                                                   (tip get put append programs head genesis boxes byEnvelope sleepers)
//   skein_replay(src, dst) → n                      `skein-kernel replay`: the source store's log into dst, no
//                                                   wallet; the same JSON report
//   skein_host_call(instance, index, nargs, memlen) → 0 | 1   a program's import (engine_v8.zig)
//
// Imports: `skein_engine` (engine_v8.zig), `skein_store` (web_store.zig), and
// `skein_peer`: request(op, v) → the answer (wallet, http: blocking,
// like serve's requests), notify(op, v) (sleepers, onSleep, say), take. Ops include `call` (#40).
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const logm = @import("log.zig");
const programsm = @import("programs.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const storem = @import("store.zig");
const engine_v8 = @import("engine_v8.zig");
const WebStore = @import("web_store.zig").WebStore;
const Value = cbor.Value;

const gpa = std.heap.wasm_allocator;

const peer = struct {
    /// Blocks until answered: the answer's length (dag-cbor), or -1 (the error message's length); both via take.
    extern "skein_peer" fn request(op: [*]const u8, op_len: usize, v: [*]const u8, v_len: usize) i32;
    extern "skein_peer" fn notify(op: [*]const u8, op_len: usize, v: [*]const u8, v_len: usize) void;
    extern "skein_peer" fn take(ptr: [*]u8) void;
};

pub const std_options: std.Options = .{ .logFn = logFn };

fn logFn(comptime level: std.log.Level, comptime scope: @TypeOf(.enum_literal), comptime fmt: []const u8, args: anytype) void {
    _ = scope;
    var buf: [2048]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "[" ++ @tagName(level) ++ "] " ++ fmt, args) catch return;
    say(s);
}

pub const panic = std.debug.FullPanic(panicFn);

fn panicFn(msg: []const u8, _: ?usize) noreturn {
    var buf: [1024]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "kernel panic: {s}", .{msg}) catch "kernel panic";
    peer.notify("panic", 5, s.ptr, s.len);
    @trap();
}

fn say(line: []const u8) void {
    peer.notify("say", 3, line.ptr, line.len);
}

fn notifyValue(op: []const u8, v: Value) void {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const b = cbor.encode(arena.allocator(), v) catch return;
    peer.notify(op.ptr, op.len, b.ptr, b.len);
}

// ------------------------------------------------------------------ buffers

var result: []u8 = &.{};

fn setResult(b: []const u8) i32 {
    if (result.len > 0) gpa.free(result);
    result = gpa.dupe(u8, b) catch return -1;
    return @intCast(result.len);
}

fn setValue(a: std.mem.Allocator, v: Value) i32 {
    return setResult(cbor.encode(a, v) catch return -1);
}

export fn skein_alloc(n: usize) ?[*]u8 {
    const b = gpa.alloc(u8, n) catch return null;
    return b.ptr;
}

export fn skein_free(p: [*]u8, n: usize) void {
    gpa.free(p[0..n]);
}

export fn skein_result() [*]const u8 {
    return result.ptr;
}

export fn skein_args() [*]i64 {
    return &engine_v8.args;
}

export fn skein_host_call(inst: i32, index: u32, nargs: u32, mem_len: u32) i32 {
    return engine_v8.hostCall(inst, index, nargs, mem_len);
}

// ------------------------------------------------------------------ the instance

var the_runner: ?*runner.Runner = null;
var ws: ?*WebStore = null;
var rt: ?*scheduler.Runtime = null;
var last_sleepers: []u8 = &.{};
var last_peer_error: []const u8 = "";

fn getRunner() !*runner.Runner {
    if (the_runner == null) the_runner = try runner.Runner.init(gpa);
    return the_runner.?;
}

/// A failure: its message in the result buffer, returned as -(length + 1).
fn fail(msg: []const u8) i32 {
    const n = setResult(msg);
    return if (n < 0) -1 else -n - 1;
}

export fn skein_open(store: u32) i32 {
    if (rt != null) return fail("already open");
    const s = WebStore.open(gpa, store, false) catch |err| return fail(@errorName(err));
    if (s.predatesFuel()) {
        s.close();
        return fail("a store written in an older format (before format 3, issue #40): refused (start a new store: re-genesis)");
    }
    ws = s;
    const r = getRunner() catch |err| return fail(@errorName(err));
    rt = scheduler.Runtime.init(gpa, s.store(), r, .{
        .ctx = @ptrCast(s),
        .wallet = pWallet,
        .http = pHttp,
        // #51: no libp2p host in a tab yet. A request with no recorded answer is refused (nothing recorded);
        // a replay's recorded answers are served as natively.
        .libp2p_refusal = "libp2p: unsupported in the browser (this build has no libp2p host)",
        .on_sleep = pOnSleep,
        .say = pSay,
    }) catch |err| return fail(@errorName(err));
    return 0;
}

fn request(a: std.mem.Allocator, op: []const u8, v: Value) !Value {
    const b = try cbor.encode(a, v);
    const n = peer.request(op.ptr, op.len, b.ptr, b.len);
    const len: usize = @intCast(if (n < 0) -(n + 1) else n);
    // n >= 0: the answer; n < 0: -(message length) - 1
    const out = try a.alloc(u8, len);
    if (len > 0) peer.take(out.ptr);
    if (n < 0) {
        last_peer_error = gpa.dupe(u8, out) catch "peer error";
        return error.PeerError;
    }
    return try cbor.decode(a, out);
}

fn pWallet(_: *anyopaque, a: std.mem.Allocator, fr: []const u8) anyerror![]u8 {
    const r = try request(a, "wallet", .{ .bytes = fr });
    return @constCast(Value.bytesOf(r) orelse return error.BadAnswer);
}

fn pHttp(_: *anyopaque, a: std.mem.Allocator, req: []const u8) anyerror![]u8 {
    const r = try request(a, "http", .{ .bytes = req });
    return @constCast(Value.bytesOf(r) orelse return error.BadAnswer);
}

fn pOnSleep(_: *anyopaque, _: []const u8, _: i64) void {
    syncSleepers();
    notifyValue("onSleep", .null);
}

fn pSay(_: *anyopaque, line: []const u8) void {
    say(line);
}

/// serve's syncSleepers: the sleepers (earliest first), told when they change.
fn syncSleepers() void {
    const r = rt orelse return;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const v = sleepersValue(a, r) catch return;
    const enc = cbor.encode(a, v) catch return;
    if (std.mem.eql(u8, enc, last_sleepers)) return;
    if (last_sleepers.len > 0) gpa.free(last_sleepers);
    last_sleepers = gpa.dupe(u8, enc) catch &.{};
    peer.notify("sleepers", 8, enc.ptr, enc.len);
}

fn sleepersValue(a: std.mem.Allocator, r: *scheduler.Runtime) !Value {
    const due = try r.sleepersDue(a);
    var list = std.array_list.Managed(Value).init(a);
    for (due) |d| {
        var m = cbor.MapBuilder.init(a);
        try m.put("thread", cbor.cidv(d.thread));
        try m.put("until", cbor.int(d.until));
        try list.append(m.value());
    }
    return .{ .array = list.items };
}

// ------------------------------------------------------------------ blocks

export fn skein_modules() i32 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var list = std.array_list.Managed(Value).init(a);
    for (programsm.modules ++ programsm.files, 0..) |m, i| {
        var e = cbor.MapBuilder.init(a);
        const file = if (i < programsm.modules.len) std.fmt.allocPrint(a, "{s}.wasm", .{m.name}) catch return -1 else m.name;
        e.put("name", cbor.string(m.name)) catch return -1;
        e.put("file", cbor.string(file)) catch return -1;
        e.put("cid", cbor.cidv(cidm.parse(a, m.cid) catch return -1)) catch return -1;
        list.append(e.value()) catch return -1;
    }
    return setValue(a, .{ .array = list.items });
}

export fn skein_put_block(c: [*]const u8, cn: usize, b: [*]const u8, bn: usize) i32 {
    const s = ws orelse return fail("no store open");
    const cid = c[0..cn];
    const bytes = b[0..bn];
    if (!cidm.isValid(cid) or !cidm.hashMatches(cid, bytes)) return fail("the bytes do not match the CID");
    s.store().putBlock(cid, bytes) catch |err| return fail(@errorName(err));
    return 0;
}

export fn skein_get_block(c: [*]const u8, cn: usize) i32 {
    const s = ws orelse return fail("no store open");
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const b = (s.store().bytes(arena.allocator(), c[0..cn]) catch |err| return fail(@errorName(err))) orelse return -1;
    return setResult(b);
}

// ------------------------------------------------------------------ the serve ops

fn reply(a: std.mem.Allocator, ok: ?Value, err: ?[]const u8, rejected: ?[]const u8) i32 {
    var m = cbor.MapBuilder.init(a);
    if (ok) |v| m.put("ok", v) catch return -1 else if (err == null) m.put("ok", .null) catch return -1;
    m.put("error", cbor.optStr(err)) catch return -1;
    m.put("rejected", cbor.optStr(rejected)) catch return -1;
    return setValue(a, m.value());
}

export fn skein_call(p: [*]const u8, n: usize) i32 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const f = cbor.decode(a, p[0..n]) catch return reply(a, null, "frame: not dag-cbor", null);
    const op = Value.str(f.get("op")) orelse return reply(a, null, "frame: no op", null);
    return handleOp(a, op, f.get("v") orelse .null) catch |err| reply(a, null, @errorName(err), null);
}

export fn skein_admit(p: [*]const u8, n: usize) i32 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const v = cbor.decode(a, p[0..n]) catch return reply(a, null, "admit: not dag-cbor", null);
    return handleOp(a, "admit", v) catch |err| reply(a, null, @errorName(err), null);
}

export fn skein_start() i32 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    return handleOp(a, "start", .null) catch |err| reply(a, null, @errorName(err), null);
}

export fn skein_drain() i32 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    return handleOp(a, "drain", .null) catch |err| reply(a, null, @errorName(err), null);
}

export fn skein_state() i32 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    return handleOp(a, "state", .null) catch |err| reply(a, null, @errorName(err), null);
}

export fn skein_next_deadline() i64 {
    const r = rt orelse return -1;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const due = r.sleepersDue(arena.allocator()) catch return -1;
    return if (due.len > 0) due[0].until else -1;
}

fn handleOp(a: std.mem.Allocator, op: []const u8, v: Value) !i32 {
    const eq = std.mem.eql;
    const r = rt orelse return reply(a, null, "no store open", null);
    const s = r.store;
    if (eq(u8, op, "tip")) return reply(a, cbor.optCid(try s.logTip(a)) orelse .null, null, null);
    if (eq(u8, op, "get")) {
        const c = Value.cidOf(v) orelse return error.BadRequest;
        return reply(a, (try s.get(a, c)) orelse .null, null, null);
    }
    if (eq(u8, op, "put")) return reply(a, cbor.cidv(try s.put(a, v)), null, null);
    if (eq(u8, op, "append")) return switch (try s.logAppend(a, v)) {
        .ok => |c| reply(a, cbor.cidv(c), null, null),
        .rejected => |x| reply(a, null, x.message, x.reason.text()),
    };
    if (eq(u8, op, "programs")) {
        var m = cbor.MapBuilder.init(a);
        for (programsm.program_names) |name| try m.put(name, cbor.cidv(try s.put(a, try programsm.program(a, name))));
        return reply(a, m.value(), null, null);
    }
    if (eq(u8, op, "head")) {
        const name = Value.str(v) orelse return error.BadRequest;
        return reply(a, cbor.optCid(try s.headTree(a, name)) orelse .null, null, null);
    }
    if (eq(u8, op, "genesis")) return reply(a, logm.genesisOf(a, s) catch .null, null, null);
    if (eq(u8, op, "boxes")) {
        const bs = try r.boxes(a);
        const arr = try a.alloc(Value, bs.len);
        for (bs, 0..) |b, i| arr[i] = cbor.string(b);
        return reply(a, .{ .array = arr }, null, null);
    }
    if (eq(u8, op, "byEnvelope")) {
        const c = Value.cidOf(v) orelse return error.BadRequest;
        return reply(a, cbor.optCid(try s.byEnvelope(a, c)) orelse .null, null, null);
    }
    if (eq(u8, op, "admit")) {
        const entry = v.get("entry") orelse return error.BadRequest;
        const res = try r.admit(a, entry, Value.bytesOf(v.get("body")));
        // Not processed here: skein_drain runs the step loop (the shim acknowledges first, once it is durable).
        return switch (res) {
            .ok => |c| reply(a, cbor.cidv(c), null, null),
            .rejected => |x| reply(a, null, x.message, x.reason.text()),
            .invalid => |m| reply(a, null, m, null),
        };
    }
    if (eq(u8, op, "start")) {
        try r.start();
        syncSleepers();
        return reply(a, .null, null, null);
    }
    if (eq(u8, op, "drain")) {
        r.kick();
        syncSleepers();
        return reply(a, .null, null, null);
    }
    if (eq(u8, op, "call")) {
        // The kernel's `call` (#40), as serve's: {program: cid | name, fn, arg, caller?, now?} → {ok, result | error, fuel}.
        try r.loadGenesis();
        const g = r.genesis orelse return reply(a, null, "call: no genesis", null);
        const prog: []const u8 = Value.cidOf(v.get("program")) orelse blk: {
            const name = Value.str(v.get("program")) orelse return error.BadRequest;
            const progs: Value = g.get("programs") orelse .null;
            break :blk Value.cidOf(if (progs == .map) progs.get(name) else null) orelse return reply(a, null, "call: no such program in the genesis", null);
        };
        const now = Value.intOf(v.get("now")) orelse return reply(a, null, "call: the browser build wants `now` (ms)", null);
        const res = try r.call(a, prog, Value.str(v.get("fn")) orelse return error.BadRequest, Value.bytesOf(v.get("arg")) orelse "", Value.bytesOf(v.get("caller")), @intCast(now));
        var m = cbor.MapBuilder.init(a);
        try m.put("ok", .{ .bool = res.ok });
        if (res.ok) try m.put("result", .{ .bytes = res.result }) else try m.put("error", cbor.string(res.err));
        try m.put("fuel", cbor.int(res.fuel));
        return reply(a, m.value(), null, null);
    }
    if (eq(u8, op, "idle")) return reply(a, .null, null, null); // nothing runs between calls
    if (eq(u8, op, "sleepers")) return reply(a, try sleepersValue(a, r), null, null);
    if (eq(u8, op, "state")) {
        var m = cbor.MapBuilder.init(a);
        try m.put("state", cbor.cidv(try ws.?.ix.stateCid(a)));
        try m.put("log", cbor.optCid(try s.logTip(a)) orelse .null);
        try m.put("cursor", cbor.int(try s.cursorGet()));
        return reply(a, m.value(), null, null);
    }
    return reply(a, null, "unknown op", null);
}

// ------------------------------------------------------------------ replay

const Capture = struct {
    lines: std.array_list.Managed([]u8),

    fn say(ctx: *anyopaque, line: []const u8) void {
        const c: *Capture = @ptrCast(@alignCast(ctx));
        c.lines.append(gpa.dupe(u8, line) catch return) catch return;
    }
};

/// replay.zig copyLog over any two stores: the entries exactly as written and the records they name.
fn copyLog(a: std.mem.Allocator, src: storem.Store, dst: storem.Store) !void {
    const g = try logm.genesisOf(a, src);
    for (g.get("programs").?.map) |p| {
        const b = (try src.bytes(a, p.value.cid)) orelse return error.NotFound;
        try dst.putBlock(p.value.cid, b);
    }
    for (g.get("subscriptions").?.array) |sub| {
        const h = Value.cidOf(sub.get("handler")) orelse continue;
        if (try dst.has(h)) continue;
        const b = (try src.bytes(a, h)) orelse continue;
        try dst.putBlock(h, b);
    }
    // Route handlers not among the programs (replay.zig: #40's routes, #51's libp2p: sources).
    if (g.get("routes")) |rs| if (rs == .array) for (rs.array) |r| {
        const h = Value.cidOf(r.get("program")) orelse continue;
        if (try dst.has(h)) continue;
        const b = (try src.bytes(a, h)) orelse continue;
        try dst.putBlock(h, b);
    };
    for (try src.logFrom(a, 0)) |c| {
        const e = (try src.get(a, c)) orelse return error.NotFound;
        if (!logm.isLogEntry(e)) return error.BadSignature;
        for ([_][]const u8{ "genesis", "mail", "event" }) |k| if (Value.cidOf(e.get(k))) |x| {
            const b = (try src.bytes(a, x)) orelse return error.NotFound;
            try dst.putBlock(x, b);
        };
        // A message's body (#40), beside its record.
        if (Value.cidOf(e.get("mail"))) |mc| if (src.getOpt(a, mc)) |m| if (Value.cidOf(m.get("body"))) |bc| {
            if (try src.bytes(a, bc)) |b| try dst.putBlock(bc, b);
        };
        switch (try dst.logAppend(a, e)) {
            .ok => |got| if (!std.mem.eql(u8, got, c)) return error.CopiedToDifferentCid,
            .rejected => |x| {
                say(x.message);
                return error.Rejected;
            },
        }
    }
}

/// `skein-kernel replay`, in the browser: the shim has put the source's raw
/// blocks (the modules) into `dst` first, as replay.zig does after install.
export fn skein_replay(src_id: u32, dst_id: u32) i32 {
    return replayInto(src_id, dst_id) catch |err| fail(@errorName(err));
}

fn replayInto(src_id: u32, dst_id: u32) !i32 {
    const src = try WebStore.open(gpa, src_id, true);
    defer src.close();
    const dst = try WebStore.open(gpa, dst_id, false);
    defer dst.close();
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    try copyLog(a, src.store(), dst.store());

    const r = try getRunner();
    var cap = Capture{ .lines = .init(gpa) };
    const run = try scheduler.Runtime.init(gpa, dst.store(), r, .{ .ctx = &cap, .say = Capture.say });
    run.witness = try scheduler.Witness.from(gpa, src.store());
    try run.start();
    run.kick();
    run.stop();

    const tip = (try dst.store().logTip(a)) orelse "";
    var o = std.array_list.Managed(u8).init(a);
    const w = o.writer();
    try w.writeAll("{\"lines\":[");
    for (cap.lines.items, 0..) |l, i| try w.print("{s}{f}", .{ if (i > 0) "," else "", std.json.fmt(l, .{}) });
    try dst.store().commit();
    const st = dst.ix.stats();
    try w.print("],\"state\":\"{s}\",\"index\":{{\"states\":{d},\"commits\":{d},\"nodes\":{d},\"bytes\":{d},\"record\":\"{s}\"}}}}\n", .{
        if (tip.len > 0) try cidm.format(a, tip) else "", st.states, st.commits, st.nodes, st.node_bytes, try cidm.format(a, try dst.ix.stateCid(a)),
    });
    return setResult(o.items);
}
