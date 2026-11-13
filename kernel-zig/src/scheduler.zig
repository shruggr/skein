// The scheduler: the log consumer (docs/VM.md is the design record; skein next, SPEC.md sections
// 1-5). An instance is a log, a store, a route table with roles, and programs. An arrival earns its
// log entry in one of two ways — its SENDER is proven (a signed request) or its CONTENT is proven
// (the row's checks) — through two kernel calls:
//
//   CHECK(arrival)  reads only (any number at once, each over a committed view of the state): the
//                   request's signature verified if it has one (door.zig), its row matched
//                   (dispatch.zig: by path; an event by name), the row's role gated (grants.zig),
//                   the row's checks run in order (programs' functions as deterministic calls).
//                   A refusal is sent back and NOTHING is stored or logged; a read row's handler
//                   answers as a read-only call; otherwise a READY package {row, principal?,
//                   scheme?, request, blocks, snapshot} — the blocks the checks named carried in
//                   it, not written.
//   COMMIT(ready)   under the instance's one writer (the runtime is single-threaded; the host runs
//                   it on the instance's worker): the row's `recheck` at the current tip, the gate
//                   again if the grants moved since the snapshot, then the blocks written, the
//                   entry appended with its `door`, its step run to completion, and the entry and
//                   the handler's answer returned — or the refusal, nothing written.
//
// A request entry runs its row's handler directly: a kernel operation (objects, head, route,
// grant, claim: done here, its answer data) or an app's function as a thread of its own (the
// request's thread), whose last update's stdout is the answer. An event entry runs its row's
// handler as a thread. The genesis seeds the route table and the grants.
//
// Later work is exactly three imports: `launch` (a thread kicked off; the launcher does not wait),
// `await(x)` (x a fact's name, or a thread's identity: THIS thread resumes, once) and `on(name, fn)`
// (a function of the app stepped on each fact of that name). A step's way out is `emit`: a
// broadcast, a fact under the emitting app's name, or one of the host's membership declarations
// (subscribe, beacon, liveness) — handed to the host once the step is committed. Nothing outside
// is asked mid-step but the signer, a recorded call served from the witness on replay.
//
// The kernel's tables: objects (the store), heads (heads.zig), the route table (dispatch.zig) and
// the grants (grants.zig, the head `grants`). No program import reaches a table: a step advances a
// head only in its write scope (an app's `<app>/…`), and everything else is a request at a kernel
// row, taken by the kernel itself.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const json = @import("json.zig");
const secp = @import("secp");
const logm = @import("log.zig");
const heads = @import("heads.zig");
const dispatch = @import("dispatch.zig");
const programs = @import("programs.zig");
const syscalls = @import("syscalls.zig");
const program = @import("program.zig");
const runner = @import("runner.zig");
const wasi = @import("wasi.zig");
const engine = @import("engine.zig");
const doorm = @import("door.zig");
const grants = @import("grants.zig");
const subsm = @import("subscriptions.zig");
const onm = @import("on.zig");
const bitcoin = @import("bitcoin.zig");
const Store = @import("store.zig").Store;
const Rejected = @import("store.zig").Rejected;
const Value = cbor.Value;

/// Fuel per step when the genesis's `defaults` do not set `fuelPerStep` (issue #5):
/// 10^12 wasm instructions, generous until something hits it.
pub const FUEL_PER_STEP: u64 = 1_000_000_000_000;

/// The one limit on a step's fuel: the genesis's `defaults.fuelPerStep` (a
/// decimal string, as every default is), else FUEL_PER_STEP.
pub fn fuelPerStep(g: ?Value) u64 {
    const d = (g orelse return FUEL_PER_STEP).get("defaults") orelse return FUEL_PER_STEP;
    const v = Value.str(d.get("fuelPerStep")) orelse return FUEL_PER_STEP;
    const n = std.fmt.parseInt(u64, v, 10) catch return FUEL_PER_STEP;
    return if (n == 0 or n > engine.UNMETERED) FUEL_PER_STEP else n;
}

/// Fuel for a kernel `call` (#40), a check and a read, when the genesis's `defaults` do not set
/// `callFuelLimit`: 10^10 wasm instructions.
pub const CALL_FUEL: u64 = 10_000_000_000;

/// The one limit on a call's fuel (a check's, a read's): the genesis's `defaults.callFuelLimit`, else CALL_FUEL.
pub fn callFuelLimit(g: ?Value) u64 {
    const d = (g orelse return CALL_FUEL).get("defaults") orelse return CALL_FUEL;
    const v = Value.str(d.get("callFuelLimit")) orelse return CALL_FUEL;
    const n = std.fmt.parseInt(u64, v, 10) catch return CALL_FUEL;
    return if (n == 0 or n > engine.UNMETERED) CALL_FUEL else n;
}

/// How deep in-VM calls may nest.
const MAX_CALL_DEPTH = 8;
/// A call's result (its stdout) may be this big: a listing, a page of the log.
const CALL_OUTPUT_LIMIT = 64 << 20;

/// BRC-100 wire call codes a program may make: key derivation and crypto only.
const wallet_calls = [_]u8{ 8, 11, 12, 13, 14, 15, 16 };

/// The signer's answers by (thread, step, i): what replay serves instead of a wallet.
pub const Witness = struct {
    arena: std.heap.ArenaAllocator,
    map: std.StringHashMap(Value),

    fn key(a: std.mem.Allocator, thread: []const u8, step: i128, i: i128) ![]u8 {
        return std.fmt.allocPrint(a, "{x} {d} {d}", .{ thread, step, i });
    }

    /// Every signer record the source's thread chains list (scheduler.ts witnessFrom).
    pub fn from(gpa: std.mem.Allocator, s: Store) !*Witness {
        const w = try gpa.create(Witness);
        w.* = .{ .arena = std.heap.ArenaAllocator.init(gpa), .map = std.StringHashMap(Value).init(gpa) };
        const a = w.arena.allocator();
        for (try s.threads(a)) |t| {
            for ((try s.chainUpdates(a, t)) orelse &.{}) |u| {
                const uv = (try s.get(a, u)) orelse continue;
                const calls = uv.get("calls") orelse continue;
                if (calls != .array) continue;
                for (calls.array) |c| {
                    if (c != .cid) continue;
                    const av = s.getOpt(a, c.cid);
                    if (!logm.isSignerCall(av)) continue;
                    const k = try key(a, Value.cidOf(av.?.get("thread")).?, Value.intOf(av.?.get("step")) orelse -1, Value.intOf(av.?.get("i")) orelse -1);
                    try w.map.put(k, av.?);
                }
            }
        }
        return w;
    }

    fn find(w: *Witness, a: std.mem.Allocator, thread: []const u8, step: i64, i: usize) !?Value {
        return w.map.get(try key(a, thread, step, @intCast(i)));
    }
};

/// What the host carries out (#65, #119): an event a step emitted — `transport` "event",
/// `address` its name (`broadcast`, or the record's `event`), `message` the record's dag-cbor,
/// `body` a broadcast's transaction bytes (empty for any other event). `place` (#148; 0.8.0): its
/// place — the instance's step number of the update listing it (`s`), the record's index in that
/// update's `emitted` (`i`), the thread's origin — carried beside the record, never in it. No
/// message to a key goes out (SPEC 5: out of this cut).
pub const Outgoing = struct { message: []const u8, body: []const u8, transport: []const u8, address: []const u8, place: ?Place = null };
pub const Place = @import("store.zig").Place;

/// The peers the runtime calls out to (all optional; replay has none but the witness).
pub const Peers = struct {
    ctx: *anyopaque,
    /// A BRC-100 wire frame to the instance wallet → its result frame (a step's signer calls, and
    /// the brc104 scheme's checks at CHECK).
    wallet: ?*const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8 = null,
    /// An event for the host to carry out, handed over once the step that emitted it is committed.
    /// Nothing comes back here. Absent (replay): nothing goes out.
    emit: ?*const fn (ctx: *anyopaque, out: Outgoing) void = null,
    /// A request's thread came to rest for good — finished or errored — after its COMMIT returned
    /// (it waited on something first): its answer is on its last update (answerOf). The host that
    /// still holds the client's connection answers it now.
    on_answer: ?*const fn (ctx: *anyopaque, thread: []const u8, entry: []const u8) void = null,
    say: ?*const fn (ctx: *anyopaque, line: []const u8) void = null,
    /// 0.9.1: a monotonic clock (ns), read around a step only for the duration on its log line —
    /// never into an update, a record, an event, the in-step clock or anything a replay reads.
    now_ns: ?*const fn (ctx: *anyopaque) u64 = null,
};

/// A log entry the processing of which drives a step.
const Ctx = struct { cid: []const u8, e: Value };

/// What a request's handler answered (SPEC 5: the handler contract's answer, a kernel operation's
/// data): {status, type?, headers?, body}.
pub const Answer = struct {
    status: i128,
    type: ?[]const u8 = null,
    headers: ?Value = null,
    body: []const u8 = "",

    pub fn value(x: Answer, a: std.mem.Allocator) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(x.status));
        try m.put("type", cbor.optStr(x.type));
        try m.put("headers", x.headers);
        try m.put("body", .{ .bytes = x.body });
        return m.value();
    }

    /// A handler's stdout: dag-cbor {status, type?, headers?, body: bytes | text}.
    pub fn of(a: std.mem.Allocator, stdout: []const u8) ?Answer {
        const v = cbor.decode(a, stdout) catch return null;
        if (v != .map) return null;
        const status = Value.intOf(v.get("status")) orelse return null;
        const body: []const u8 = if (v.get("body")) |b| (Value.bytesOf(b) orelse Value.str(b) orelse "") else "";
        const hs = v.get("headers");
        return .{ .status = status, .type = Value.str(v.get("type")), .headers = if (hs != null and hs.? == .map) hs else null, .body = body };
    }
};

/// A refusal (CHECK's or COMMIT's): nothing was stored or logged. `principal`: who the signature
/// said it was from, if it got that far; `fuel`: what the checks spent (the host's ledger).
pub const Refusal = struct {
    status: i128,
    code: ?[]const u8 = null,
    reason: []const u8,
    principal: ?[]const u8 = null,
    fuel: u64 = 0,

    pub fn value(x: Refusal, a: std.mem.Allocator) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(x.status));
        try m.put("code", cbor.optStr(x.code));
        try m.put("reason", cbor.string(x.reason));
        if (x.principal) |p| try m.put("principal", .{ .bytes = p });
        try m.put("fuel", cbor.int(x.fuel));
        return m.value();
    }
};

fn refusal(status: i128, code: ?[]const u8, reason: []const u8) Refusal {
    return .{ .status = status, .code = code, .reason = reason };
}

pub const Runtime = struct {
    gpa: std.mem.Allocator,
    store: Store,
    runner: *runner.Runner,
    peers: Peers,
    witness: ?*Witness = null,
    has_wallet: bool = false,

    life: std.heap.ArenaAllocator,
    genesis: ?Value = null,
    cursor: i64 = 0,
    started: bool = false,
    stopped: bool = false,
    draining: bool = false,
    again: bool = false,

    stepping: std.StringHashMap(void),
    /// A field for the next program step's input: `event` (a fact a thread awaited by name) or
    /// `resolved` (the thread a thread awaited came to rest). Set by the waker, taken by stepBody.
    step_extra: ?cbor.Entry = null,
    /// Events for the host to carry out, handed over after the next commit (gpa-owned copies).
    outbox: std.array_list.Managed(Outgoing),
    /// What the request entry being processed answered (COMMIT reads it once the step ran): a kernel
    /// operation's answer, or the request's thread (gpa-owned; replaced by the next).
    answered: ?Answered = null,

    const Answered = struct { entry: []u8, thread: ?[]u8 = null, answer: ?Answer = null };

    fn setAnswered(rt: *Runtime, entry: []const u8, thread: ?[]const u8, answer: ?Answer) !void {
        rt.clearAnswered();
        rt.answered = .{
            .entry = try rt.gpa.dupe(u8, entry),
            .thread = if (thread) |t| try rt.gpa.dupe(u8, t) else null,
            .answer = if (answer) |x| .{ .status = x.status, .type = x.type, .body = try rt.gpa.dupe(u8, x.body) } else null,
        };
    }

    fn clearAnswered(rt: *Runtime) void {
        const x = rt.answered orelse return;
        rt.gpa.free(x.entry);
        if (x.thread) |t| rt.gpa.free(t);
        if (x.answer) |y| rt.gpa.free(y.body);
        rt.answered = null;
    }

    pub fn init(gpa: std.mem.Allocator, s: Store, r: *runner.Runner, peers: Peers) !*Runtime {
        const rt = try gpa.create(Runtime);
        rt.* = .{
            .gpa = gpa,
            .store = s,
            .runner = r,
            .peers = peers,
            .life = std.heap.ArenaAllocator.init(gpa),
            .stepping = std.StringHashMap(void).init(gpa),
            .outbox = std.array_list.Managed(Outgoing).init(gpa),
        };
        rt.has_wallet = peers.wallet != null;
        return rt;
    }

    fn say(rt: *Runtime, comptime f: []const u8, args: anytype) void {
        const s = rt.peers.say orelse return;
        var buf = std.array_list.Managed(u8).init(rt.gpa);
        defer buf.deinit();
        buf.print(f, args) catch return;
        s(rt.peers.ctx, buf.items);
    }

    /// The instance's identity key (33 bytes).
    pub fn identity(rt: *Runtime) []const u8 {
        const g = rt.genesis orelse return "";
        return Value.bytesOf(g.get("identity")) orelse "";
    }

    // ------------------------------------------------------------ small helpers

    fn short(a: std.mem.Allocator, c: []const u8) []const u8 {
        const s = cidm.format(a, c) catch return "?";
        return s[s.len -| 8..];
    }
    fn fmtCid(a: std.mem.Allocator, c: []const u8) []const u8 {
        return cidm.format(a, c) catch "?";
    }

    fn tipOf(rt: *Runtime, a: std.mem.Allocator, thread: []const u8) !?Value {
        const tip = (try rt.store.chainTip(a, thread)) orelse return rt.failf(a, "not found: {s}", .{fmtCid(a, thread)});
        if (std.mem.eql(u8, tip, thread)) return null;
        return try rt.getOrNotFound(a, tip);
    }

    /// store.get: the record, or NotFound ("not found: <cid>").
    fn getOrNotFound(rt: *Runtime, a: std.mem.Allocator, c: []const u8) !Value {
        const b = (try rt.store.bytes(a, c)) orelse return rt.failf(a, "not found: {s}", .{fmtCid(a, c)});
        return cbor.decode(a, b) catch rt.failf(a, "CBOR decode error", .{});
    }

    fn cidIn(list: ?Value, c: []const u8) bool {
        const l = list orelse return false;
        if (l != .array) return false;
        for (l.array) |x| if (x == .cid and std.mem.eql(u8, x.cid, c)) return true;
        return false;
    }

    fn stateIs(u: ?Value, s: []const u8) bool {
        const v = u orelse return false;
        const st = Value.str(v.get("state")) orelse return false;
        return std.mem.eql(u8, st, s);
    }

    // ------------------------------------------------------------ lifecycle

    pub fn loadGenesis(rt: *Runtime) !void {
        if (rt.genesis != null) return;
        if ((try rt.store.logTip(rt.life.allocator())) == null) return;
        rt.genesis = try logm.genesisOf(rt.life.allocator(), rt.store);
    }

    /// Resume what the last process left mid-flight (a thread launched or begun whose first step
    /// never ended); the caller then kick()s (consumes the log).
    pub fn start(rt: *Runtime) !void {
        var arena = std.heap.ArenaAllocator.init(rt.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        try rt.loadGenesis();
        rt.cursor = try rt.store.cursorGet();
        if (rt.cursor > 0 and (try rt.store.chainTip(a, try dispatch.origin(a))) == null) return error.PredatesDispatch;
        rt.say("runtime {s} · log {d} processed{s}", .{ shortKey(rt.identity()), rt.cursor, if (rt.has_wallet) "" else " · no wallet (replay)" });
        rt.started = true;
        for (try rt.store.resting(a)) |t| rt.resume_(a, t) catch |err| rt.say("runtime: {s}", .{@errorName(err)});
        try rt.store.commit();
        rt.flushOutbox();
    }

    /// A broadcast event (#65): {kind: "broadcast", tx: <cid>, beef?: bytes}.
    fn isBroadcast(m: Value) bool {
        if (m != .map) return false;
        if (!std.mem.eql(u8, Value.str(m.get("kind")) orelse "", "broadcast")) return false;
        return Value.cidOf(m.get("tx")) != null;
    }

    const isEvent = logm.isEvent;

    /// Queue an event for the host (#65, #119): transport "event", address its name (`broadcast`,
    /// or the record's `event`); `message` the record's dag-cbor, `body` a broadcast's transaction
    /// bytes (empty for any other). `place`: the record's place in the log (placeIn).
    fn handOverEvent(rt: *Runtime, a: std.mem.Allocator, c: []const u8, m: Value, place: ?Place) !void {
        if (rt.peers.emit == null) return;
        const bytes = (try rt.store.bytes(a, c)) orelse return;
        const broadcast = isBroadcast(m);
        const tx: []const u8 = if (broadcast) (try rt.store.bytes(a, Value.cidOf(m.get("tx")).?)) orelse return else "";
        const name = if (broadcast) "broadcast" else Value.str(m.get("event")) orelse return;
        try rt.outbox.append(.{
            .message = try rt.gpa.dupe(u8, bytes),
            .body = try rt.gpa.dupe(u8, tx),
            .transport = try rt.gpa.dupe(u8, "event"),
            .address = try rt.gpa.dupe(u8, name),
            .place = if (place) |p| .{ .s = p.s, .i = p.i, .thread = try rt.gpa.dupe(u8, p.thread) } else null,
        });
    }

    /// #148: where event record `c` is, in update `tip` of `thread` (the update that listed it):
    /// 0.8.0: the update's step number (`ord`), the record's index in its `emitted`. Null when the
    /// update does not list it, or is no thread run's (no `ord`).
    fn placeIn(c: []const u8, tip: Value, thread: []const u8) ?Place {
        const emitted = tip.get("emitted") orelse return null;
        if (emitted != .array) return null;
        const i = for (emitted.array, 0..) |x, k| {
            if (std.mem.eql(u8, Value.cidOf(x) orelse continue, c)) break k;
        } else return null;
        const ord = Value.intOf(tip.get("ord")) orelse return null;
        if (ord <= 0) return null;
        return .{ .s = @intCast(ord), .i = @intCast(i), .thread = thread };
    }

    /// What is in the outbox goes to the host: after a commit, so nothing leaves before the step that emitted it is durable.
    fn flushOutbox(rt: *Runtime) void {
        const f = rt.peers.emit orelse return;
        const items = rt.outbox.toOwnedSlice() catch return;
        defer rt.gpa.free(items);
        for (items) |o| {
            if (!rt.stopped) f(rt.peers.ctx, o);
            rt.gpa.free(o.message);
            rt.gpa.free(o.body);
            rt.gpa.free(o.transport);
            rt.gpa.free(o.address);
            if (o.place) |p| rt.gpa.free(p.thread);
        }
    }

    pub fn stop(rt: *Runtime) void {
        rt.stopped = true;
    }

    /// Free the runtime (#158: `skein-kernel host` frees an instance the host closes). Stopped first;
    /// what the outbox still held is dropped.
    pub fn deinit(rt: *Runtime) void {
        rt.stop();
        rt.flushOutbox();
        rt.clearAnswered();
        rt.outbox.deinit();
        rt.stepping.deinit();
        rt.life.deinit();
        rt.gpa.destroy(rt);
    }

    // ------------------------------------------------------------ CHECK (SPEC 4)

    pub const CheckOut = union(enum) {
        /// Nothing stored or logged: the host sends this back.
        refused: Refusal,
        /// The READY package (dag-cbor), for COMMIT.
        ready: Value,
        /// A read row's answer (nothing written), and the fuel its call spent.
        read: struct { answer: Answer, fuel: u64, principal: ?[]const u8 = null },
        /// A malformed arrival (the host's bug).
        invalid: []const u8,
    };

    /// CHECK over the runtime's own state (the Node host: CHECK then COMMIT in order on the instance's worker).
    pub fn check(rt: *Runtime, a: std.mem.Allocator, arrival: Value) !CheckOut {
        try rt.loadGenesis();
        return rt.checkIn(a, rt.store, rt.genesis, arrival);
    }

    /// CHECK over `view`, a committed view of the instance's state (#158: `skein-kernel host` runs it
    /// on any worker, beside the instance's step): nothing of the runtime's working state is read.
    pub fn checkOver(rt: *Runtime, a: std.mem.Allocator, view: Store, arrival: Value) !CheckOut {
        const g: ?Value = if ((try view.logTip(a)) != null) logm.genesisOf(a, view) catch null else null;
        return rt.checkIn(a, view, g, arrival);
    }

    /// The package as the checks hand it on: the record (kind "request"), who it is from, what they
    /// stored (CID → bytes; null bytes: a block the store held already), what ran, the fuel.
    const Pkg = struct {
        record: Value,
        principal: ?[]const u8 = null,
        ran: std.array_list.Managed(Value),
        blocks: std.StringArrayHashMapUnmanaged(?[]const u8) = .empty,
        fuel: u64 = 0,
    };

    /// CHECK (SPEC 4): an arrival {request: <record>, time} | {event: <record>, name, time}.
    pub fn checkIn(rt: *Runtime, a: std.mem.Allocator, store: Store, genesis: ?Value, arrival: Value) !CheckOut {
        const g = genesis orelse return .{ .invalid = "check: no genesis" };
        if (arrival != .map) return .{ .invalid = "check: want {request, time} or {event, name, time}" };
        if (logm.stampOf(arrival.get("time")) == null) return .{ .invalid = "check: the arrival's stamp, `time: [sec, nsec]`, the host's clock at arrival" };
        const at = logm.stampOf(arrival.get("time")).?.ms();
        const rows = (try dispatch.current(a, store)) orelse &.{};
        const gr = try grants.load(a, store);
        const identity_key = Value.bytesOf(g.get("identity")).?;
        if (arrival.get("request")) |rec| {
            if (arrival.get("event") != null) return .{ .invalid = "check: a request or an event, not both" };
            if (!logm.isRequest(rec)) return .{ .invalid = "check: a request record {kind: \"request\", payload: {method, path, query, headers, body}, signature?} (log.zig)" };
            const rc = try cbor.cidOfValue(a, rec);
            var principal: ?[]const u8 = null;
            var scheme: ?[]const u8 = null;
            if (logm.isSigned(rec)) {
                // Replay of an identical signed request: refused by its content hash (the `unique` map).
                if (try store.byUnique(a, rc)) |_| return .{ .refused = refusal(409, "ERR_REPLAYED", "this signed request is admitted already (an identical request is admitted once)") };
                const w: ?doorm.Signer = if (rt.peers.wallet) |f| .{ .ctx = rt.peers.ctx, .call = f } else null;
                switch (try doorm.verify(a, w, identity_key, rec)) {
                    .refused => |x| return .{ .refused = .{ .status = x.status, .code = x.code, .reason = x.reason } },
                    .ok => |x| {
                        principal = x.principal;
                        scheme = x.scheme;
                    },
                }
            }
            const payload = rec.get("payload").?;
            const signed_path = Value.str(payload.get("path")).?;
            const path = routePath(g, signed_path) orelse return .{ .refused = .{ .status = 404, .code = "ERR_NOT_FOUND", .reason = "the path names another instance (/@<handle>/…)", .principal = principal } };
            const row = dispatch.forPath(rows, path) orelse return .{ .refused = .{ .status = 404, .code = "ERR_NOT_FOUND", .reason = "no row for this path", .principal = principal } };
            switch (grants.gate(gr, row.role.?, principal)) {
                .pass => {},
                .no_principal => return .{ .refused = .{ .status = 401, .code = "ERR_UNAUTHORIZED", .reason = try std.fmt.allocPrint(a, "{s} names role {s}: the request names no proven sender (sign it)", .{ row.key, row.role.? }) } },
                .not_granted => return .{ .refused = .{ .status = 403, .code = "ERR_FORBIDDEN", .reason = try std.fmt.allocPrint(a, "{s} names role {s}, which the sender does not hold", .{ row.key, row.role.? }), .principal = principal } },
            }
            if (row.isRead()) return rt.readRow(a, store, g, row, rec, principal, at);
            var pkg = Pkg{ .record = rec, .principal = principal, .ran = .init(a) };
            for (row.checks) |c| {
                if (try rt.runCheck(a, store, g, c.string, row, &pkg, rc, at, false)) |no| {
                    var x = no;
                    x.fuel = pkg.fuel;
                    if (x.principal == null) x.principal = pkg.principal;
                    return .{ .refused = x };
                }
            }
            return .{ .ready = try readyValue(a, "request", arrival.get("time").?, rec, null, row, pkg, principal, scheme, try grantsTip(a, store)) };
        }
        const rec = arrival.get("event") orelse return .{ .invalid = "check: want {request, time} or {event, name, time}" };
        if (rec != .map) return .{ .invalid = "check: an event record is a map" };
        const name = Value.str(arrival.get("name")) orelse return .{ .invalid = "check: an event names itself: {event, name, time}" };
        if (!dispatch.isBox(name)) return .{ .invalid = "check: an event's name is not empty and has no space or NUL" };
        const ec = try cbor.cidOfValue(a, rec);
        const row = dispatch.forName(rows, name) orelse return .{ .refused = refusal(404, "ERR_NOT_FOUND", try std.fmt.allocPrint(a, "no event row for {s}", .{name})) };
        var pkg = Pkg{ .record = rec, .ran = .init(a) };
        for (row.checks) |c| {
            if (try rt.runCheck(a, store, g, c.string, row, &pkg, ec, at, false)) |no| {
                var x = no;
                x.fuel = pkg.fuel;
                rt.say("check: an event {s} refused by {s}: {s}", .{ name, c.string, x.reason });
                return .{ .refused = x };
            }
        }
        return .{ .ready = try readyValue(a, "event", arrival.get("time").?, rec, name, row, pkg, null, null, try grantsTip(a, store)) };
    }

    /// The grants head's tree as it stands (the snapshot COMMIT compares), or null.
    fn grantsTip(a: std.mem.Allocator, store: Store) !?[]u8 {
        return store.headTree(a, grants.HEAD);
    }

    /// The READY package (SPEC 4): {kind: "ready", arrival, time, record, name?, row, principal?,
    /// scheme?, checks, request? | event? (the package as the checks handed it back, when they
    /// rewrote it), blocks: [{cid, bytes?}], snapshot: {grants, signer?}, fuel}.
    fn readyValue(a: std.mem.Allocator, kind: []const u8, time: Value, rec: Value, name: ?[]const u8, row: dispatch.Row, pkg: Pkg, signer_key: ?[]const u8, scheme: ?[]const u8, gtip: ?[]const u8) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("ready"));
        try m.put("arrival", cbor.string(kind));
        try m.put("time", time);
        try m.put("record", rec);
        if (name) |n| try m.put("name", cbor.string(n));
        try m.put("row", row.value);
        if (pkg.principal) |p| try m.put("principal", .{ .bytes = p });
        try m.put("scheme", cbor.optStr(scheme));
        try m.put("checks", .{ .array = pkg.ran.items });
        const same = std.mem.eql(u8, try cbor.encode(a, pkg.record), try cbor.encode(a, rec));
        if (!same) try m.put(kind, pkg.record);
        const bs = try a.alloc(Value, pkg.blocks.count());
        var it = pkg.blocks.iterator();
        var i: usize = 0;
        while (it.next()) |e| : (i += 1) {
            var b = cbor.MapBuilder.init(a);
            try b.put("cid", cbor.cidv(e.key_ptr.*));
            if (e.value_ptr.*) |bytes| try b.put("bytes", .{ .bytes = bytes });
            bs[i] = b.value();
        }
        try m.put("blocks", .{ .array = bs });
        var snap = cbor.MapBuilder.init(a);
        try snap.put("grants", cbor.optCid(gtip) orelse .null);
        if (signer_key) |k| try snap.put("signer", .{ .bytes = k });
        try m.put("snapshot", snap.value());
        try m.put("fuel", cbor.int(pkg.fuel));
        return m.value();
    }

    /// One check (or, `recheck`, the row's recheck at COMMIT) of the row over the package (SPEC 4):
    /// a function of an app's program, run as a call in the deterministic profile — its clock the
    /// arrival's time, its random seeded by the arrival record's CID, the blocks earlier checks
    /// named visible to it, nothing written. It answers {reject: {status, code?, reason}} or
    /// {pass: {principal?, request?, blocks?}}. Null: passed on (`pkg` updated); else the refusal.
    fn runCheck(rt: *Runtime, a: std.mem.Allocator, store: Store, g: Value, name: []const u8, row: dispatch.Row, pkg: *Pkg, seed: []const u8, at: i64, recheck: bool) !?Refusal {
        if (!recheck) try pkg.ran.append(cbor.string(name));
        const what = if (recheck) "recheck" else "check";
        const f = (try resolveFn(a, store, name)) orelse return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "{s} {s}: no such function (the app's record at <app>/app names no program for it)", .{ what, name }));
        const arg = try checkArg(a, g, row, pkg);
        var pending = std.StringHashMap([]const u8).init(a);
        var it = pkg.blocks.iterator();
        while (it.next()) |e| if (e.value_ptr.*) |b| try pending.put(e.key_ptr.*, b);
        const res = try rt.callIn(a, store, g, f.program, f.func, try cbor.encode(a, arg), null, at, .{ .seed = seed, .pending = &pending });
        pkg.fuel += res.result.fuel;
        if (!res.result.ok) return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "{s} {s} failed: {s}", .{ what, name, res.result.err }));
        const out = cbor.decode(a, res.result.result) catch return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "{s} {s} answered no dag-cbor", .{ what, name }));
        if (out.get("reject")) |x| return .{ .status = Value.intOf(x.get("status")) orelse 400, .code = Value.str(x.get("code")), .reason = Value.str(x.get("reason")) orelse "refused" };
        const pass = out.get("pass") orelse return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "{s} {s} answered neither reject nor pass", .{ what, name }));
        if (recheck or pass != .map) return null;
        if (pass.get("principal")) |p| if (p != .null) {
            const k = Value.bytesOf(p) orelse return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "check {s}: a principal is a key (33 bytes)", .{name}));
            if (!secp.isKey(k)) return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "check {s}: a principal is a key (33 bytes)", .{name}));
            pkg.principal = k;
        };
        if (pass.get("request")) |q| if (q != .null) {
            // The package handed on: a record of the same kind as the one it was handed.
            if (q != .map or !std.mem.eql(u8, Value.str(q.get("kind")) orelse "", Value.str(pkg.record.get("kind")) orelse "")) return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "check {s} handed on a package not of its kind", .{name}));
            pkg.record = q;
        };
        if (pass.get("blocks")) |bs| if (bs != .null) {
            if (bs != .array) return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "check {s}: blocks is a list of CIDs it put", .{name}));
            for (bs.array) |b| {
                const c = Value.cidOf(b) orelse return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "check {s}: blocks is a list of CIDs it put", .{name}));
                if (pkg.blocks.contains(c)) continue;
                if (res.puts.get(c)) |bytes| {
                    try pkg.blocks.put(a, try a.dupe(u8, c), try a.dupe(u8, bytes));
                } else if (try store.has(c)) {
                    try pkg.blocks.put(a, try a.dupe(u8, c), null);
                } else return refusal(500, "ERR_CHECK", try std.fmt.allocPrint(a, "check {s}: block {s} is not one it put", .{ name, fmtCid(a, c) }));
            }
        };
        return null;
    }

    /// What a check is called with (input kind "call", `check: true`; arg dag-cbor): a request's
    /// {request: <the package as it stands>, row, principal?, caller?, method, path, query, headers,
    /// body} (the payload's fields as the package stands); an event's {event: <the record as it
    /// stands>, row}.
    fn checkArg(a: std.mem.Allocator, g: Value, row: dispatch.Row, pkg: *const Pkg) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("row", row.value);
        if (row.kind == .event) {
            try m.put("event", pkg.record);
            return m.value();
        }
        try m.put("request", pkg.record);
        if (pkg.principal) |p| {
            try m.put("principal", .{ .bytes = p });
            try m.put("caller", .{ .bytes = p });
        }
        if (pkg.record.get("payload")) |p| if (p == .map) try putPayload(&m, g, p);
        return m.value();
    }

    /// A read row (SPEC 4 [P]): the handler as a read-only call — input kind "call", `read: true`,
    /// fn the row's function, arg dag-cbor {caller?, method, path, query, headers, body, row} — its
    /// stdout the answer {status, type?, headers?, body}. Nothing is written.
    fn readRow(rt: *Runtime, a: std.mem.Allocator, store: Store, g: Value, row: dispatch.Row, rec: Value, principal: ?[]const u8, at: i64) !CheckOut {
        const f = (try resolveFn(a, store, row.handler)) orelse return .{ .refused = refusal(500, "ERR_HANDLER", try std.fmt.allocPrint(a, "read {s}: no such function (the app's record names no program for it)", .{row.handler})) };
        var m = cbor.MapBuilder.init(a);
        if (principal) |p| try m.put("caller", .{ .bytes = p });
        try putPayload(&m, g, rec.get("payload").?);
        try m.put("row", row.value);
        const res = try rt.callIn(a, store, g, f.program, f.func, try cbor.encode(a, m.value()), principal, at, .{ .read = true });
        if (!res.result.ok) return .{ .read = .{ .answer = try errAnswer(a, 500, res.result.err), .fuel = res.result.fuel, .principal = principal } };
        const ans = Answer.of(a, res.result.result) orelse return .{ .read = .{ .answer = try errAnswer(a, 500, "the read's handler answered no {status, body}"), .fuel = res.result.fuel, .principal = principal } };
        return .{ .read = .{ .answer = ans, .fuel = res.result.fuel, .principal = principal } };
    }

    fn errAnswer(a: std.mem.Allocator, status: i128, why: []const u8) !Answer {
        var m = cbor.MapBuilder.init(a);
        try m.put("error", cbor.string(why));
        return .{ .status = status, .type = "application/cbor", .body = try cbor.encode(a, m.value()) };
    }

    /// What the route table matches for a request's path (KF1): `payload.path` is the path exactly as
    /// the client signed it; a leading `/@<this instance's handle>` (followed by `/` or the end) is
    /// stripped ("/" when nothing is left). A path naming another instance (`/@<other>…`): null.
    pub fn routePath(g: Value, path: []const u8) ?[]const u8 {
        if (!std.mem.startsWith(u8, path, "/@")) return path;
        const handle = Value.str(g.get("handle")) orelse return null;
        const rest = path[2..];
        if (!std.mem.startsWith(u8, rest, handle)) return null;
        const after = rest[handle.len..];
        if (after.len == 0) return "/";
        if (after[0] != '/') return null;
        return after;
    }

    /// A payload's fields as a check, a read and a handler get them: method, path (as the route
    /// table matched it: routePath), query, headers, body.
    fn putPayload(m: *cbor.MapBuilder, g: Value, p: Value) !void {
        for ([_][]const u8{ "method", "query", "headers", "body" }) |k| try m.put(k, p.get(k));
        const sp = Value.str(p.get("path")) orelse "/";
        try m.put("path", cbor.string(routePath(g, sp) orelse sp));
    }

    /// An app's function "<app>.<fn>" (dispatch.zig fnRef: "<app>.<role>.<fn>", or "<app>.<fn>" for an
    /// app with one program): its program record's CID and the function, through the app record at
    /// `<app>/app` (its `programs`), as the store stands; null when it names none.
    pub fn resolveFn(a: std.mem.Allocator, store: Store, ref: []const u8) !?struct { program: []const u8, func: []const u8, app: []const u8 } {
        const f = dispatch.fnRef(ref) orelse return null;
        const rec = (try appRecord(a, store, f.app)) orelse return null;
        const ps = rec.get("programs");
        switch (try onm.handlerOf(a, f.func, f.app, ps)) {
            .bad => return null,
            .ok => |h| return .{ .program = Value.cidOf(ps.?.get(h.role)).?, .func = h.func, .app = f.app },
        }
    }

    /// The app record at `<app>/app`, or null.
    fn appRecord(a: std.mem.Allocator, s: Store, app: []const u8) !?Value {
        const head = try std.fmt.allocPrint(a, "{s}/app", .{app});
        if (!heads.isHeadName(head)) return null;
        const root = (try heads.headTree(a, s, head)) orelse return null;
        const v = s.getOpt(a, root) orelse return null;
        if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", "app")) return null;
        return v;
    }

    // ------------------------------------------------------------ COMMIT (SPEC 4)

    pub const CommitOut = union(enum) {
        committed: struct {
            entry: []const u8,
            /// The handler's answer, when its step came to rest (or a kernel operation's); null: its
            /// thread waits (on_answer tells the host when it rests), or an event (no answer).
            answer: ?Answer = null,
            thread: ?[]const u8 = null,
            /// The thread's state after its step: finished | errored | waiting; "kernel" for a kernel
            /// operation; "none" when nothing ran.
            state: []const u8,
        },
        refused: Refusal,
        invalid: []const u8,
    };

    /// COMMIT (SPEC 4): the READY package CHECK made, under the instance's one writer. The row's
    /// recheck at the current tip; the gate again if the grants moved since the snapshot; then the
    /// blocks written, the entry appended with its `door`, its step run to completion, the entry and
    /// the handler's answer returned — or the refusal, nothing written. The Node host calls CHECK
    /// then COMMIT in order on the instance's worker; the READY package is the host's to carry
    /// between them (the host is the kernel's one driver, as it is for the genesis).
    pub fn commit(rt: *Runtime, a: std.mem.Allocator, ready: Value) !CommitOut {
        try rt.loadGenesis();
        const g = rt.genesis orelse return .{ .invalid = "commit: no genesis" };
        if (ready != .map or !std.mem.eql(u8, Value.str(ready.get("kind")) orelse "", "ready")) return .{ .invalid = "commit: want the READY package CHECK made ({kind: \"ready\", …})" };
        const kind = Value.str(ready.get("arrival")) orelse return .{ .invalid = "commit: no arrival kind" };
        const is_request = std.mem.eql(u8, kind, "request");
        if (!is_request and !std.mem.eql(u8, kind, "event")) return .{ .invalid = "commit: arrival is request or event" };
        const time = ready.get("time") orelse return .{ .invalid = "commit: no time" };
        if (logm.stampOf(time) == null) return .{ .invalid = "commit: time is [sec, nsec]" };
        const at = logm.stampOf(time).?.ms();
        const rec = ready.get("record") orelse return .{ .invalid = "commit: no record" };
        const row_v = ready.get("row") orelse return .{ .invalid = "commit: no row" };
        if (try dispatch.problem(a, row_v)) |bad| return .{ .invalid = try std.fmt.allocPrint(a, "commit: row: {s}", .{bad}) };
        const row = dispatch.rowOf(row_v).?;
        if (is_request and !logm.isRequest(rec)) return .{ .invalid = "commit: the record is not a request record" };
        if (!is_request and rec != .map) return .{ .invalid = "commit: an event record is a map" };
        const name: ?[]const u8 = if (is_request) null else Value.str(ready.get("name")) orelse return .{ .invalid = "commit: an event names itself" };
        const principal = Value.bytesOf(ready.get("principal"));
        const handed = ready.get(kind);
        const rc = try cbor.cidOfValue(a, rec);
        // A signed request admitted meanwhile: refused (the unique map, as at CHECK).
        if (is_request and logm.isSigned(rec)) if (try rt.store.byUnique(a, rc)) |_| return .{ .refused = refusal(409, "ERR_REPLAYED", "this signed request is admitted already (an identical request is admitted once)") };
        // The grants moved since the snapshot: the gate again, for the key the gate checked.
        const snap = ready.get("snapshot") orelse .null;
        const was = if (snap == .map) Value.cidOf(snap.get("grants")) else null;
        const now = try grantsTip(a, rt.store);
        const moved = if (was == null or now == null) (was == null) != (now == null) else !std.mem.eql(u8, was.?, now.?);
        if (moved) if (row.role) |role| {
            const signer_key = if (snap == .map) Value.bytesOf(snap.get("signer")) else null;
            switch (grants.gate(try grants.load(a, rt.store), role, signer_key)) {
                .pass => {},
                else => return .{ .refused = .{ .status = 403, .code = "ERR_FORBIDDEN", .reason = try std.fmt.allocPrint(a, "{s} names role {s}: the grants changed since the check, and the sender no longer holds it", .{ row.key, role }), .principal = principal } },
            }
        };
        // The blocks the checks named, visible to the recheck before anything is written.
        var blocks = std.array_list.Managed(Value).init(a);
        var pending = std.StringHashMap([]const u8).init(a);
        if (ready.get("blocks")) |bs| if (bs == .array) for (bs.array) |b| {
            const c = Value.cidOf(b.get("cid")) orelse return .{ .invalid = "commit: blocks: each {cid, bytes?}" };
            if (Value.bytesOf(b.get("bytes"))) |bytes| {
                if (!cidm.hashMatches(c, bytes)) return .{ .invalid = try std.fmt.allocPrint(a, "commit: block {s}: bytes do not hash to it", .{fmtCid(a, c)}) };
                try pending.put(c, bytes);
            } else if (!(try rt.store.has(c))) return .{ .invalid = try std.fmt.allocPrint(a, "commit: block {s} is named, not carried, and not in the store", .{fmtCid(a, c)}) };
            try blocks.append(cbor.cidv(c));
        };
        var fuel: u64 = @intCast(std.math.clamp(Value.intOf(ready.get("fuel")) orelse 0, 0, std.math.maxInt(u64)));
        if (row.recheck) |rn| {
            var pkg = Pkg{ .record = handed orelse rec, .principal = principal, .ran = .init(a) };
            var it = pending.iterator();
            while (it.next()) |e| try pkg.blocks.put(a, e.key_ptr.*, e.value_ptr.*);
            if (try rt.runCheck(a, rt.store, g, rn, row, &pkg, rc, at, true)) |no| {
                var x = no;
                fuel += pkg.fuel;
                x.fuel = fuel;
                x.principal = principal;
                rt.say("commit: {s} refused by its recheck {s}: {s}", .{ row.key, rn, x.reason });
                return .{ .refused = x };
            }
        }
        // Written: the blocks, the record as received, the package as handed back, the entry.
        var pit = pending.iterator();
        while (pit.next()) |e| if (!(try rt.store.has(e.key_ptr.*))) try rt.store.putBlock(e.key_ptr.*, e.value_ptr.*);
        _ = try rt.store.put(a, rec);
        var d = cbor.MapBuilder.init(a);
        if (principal) |p| try d.put("principal", .{ .bytes = p });
        try d.put("scheme", ready.get("scheme"));
        try d.put("row", row_v);
        try d.put("checks", ready.get("checks") orelse Value{ .array = &.{} });
        if (blocks.items.len > 0) try d.put("blocks", .{ .array = blocks.items });
        if (handed) |h| try d.put(kind, cbor.cidv(try rt.store.put(a, h)));
        var body = cbor.MapBuilder.init(a);
        try body.put("time", time);
        try body.put(kind, cbor.cidv(rc));
        if (name) |n| try body.put("name", cbor.string(n));
        try body.put("door", d.value());
        const entry = switch (try rt.store.logAppend(a, try rt.extend(a, body.value()))) {
            .ok => |c| c,
            .rejected => |r| return .{ .refused = refusal(409, r.reason.text(), r.message) },
        };
        // The step, to completion, before anything else is admitted.
        rt.clearAnswered();
        rt.kick();
        const done = rt.answered orelse return .{ .committed = .{ .entry = entry, .state = "none" } };
        defer rt.clearAnswered();
        if (!std.mem.eql(u8, done.entry, entry)) return .{ .committed = .{ .entry = entry, .state = "none" } };
        if (done.answer) |ans| return .{ .committed = .{ .entry = entry, .answer = .{ .status = ans.status, .type = ans.type, .body = try a.dupe(u8, ans.body) }, .state = "kernel" } };
        const t = try a.dupe(u8, done.thread orelse return .{ .committed = .{ .entry = entry, .state = "none" } });
        const r = try rt.answerOf(a, t);
        return .{ .committed = .{ .entry = entry, .thread = t, .state = r.state, .answer = r.answer } };
    }

    /// #163: `e` as the next entry of the log as it stands — {kind: "log", prev: <the tip>, n: <the
    /// tip's n + 1>, time: <e's stamp, raised to the tip's>, …e}.
    fn extend(rt: *Runtime, a: std.mem.Allocator, e: Value) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("log"));
        for (e.map) |x| try m.put(x.key, x.value);
        const stamp = logm.stampOf(e.get("time")).?;
        const t = (try rt.store.logTip(a)) orelse return error.NoGenesis;
        const tip = (try rt.store.get(a, t)) orelse return error.NotFound;
        const ts = logm.stampOf(tip.get("time")) orelse return error.BadTip;
        try m.put("prev", cbor.cidv(t));
        try m.put("n", cbor.int((Value.intOf(tip.get("n")) orelse return error.BadTip) + 1));
        if (stamp.ns() < ts.ns()) try m.put("time", tip.get("time").?);
        return m.value();
    }

    pub const AppendResult = union(enum) {
        ok: []u8,
        rejected: struct { reason: Rejected, message: []const u8 },
        invalid: []const u8,
    };

    /// The host's `append` frame (K24): the genesis entry and nothing else, only as the log's
    /// first entry, its record in the store and well formed (log.zig isGenesis). Every other
    /// entry comes in through CHECK and COMMIT.
    pub fn appendGenesis(rt: *Runtime, a: std.mem.Allocator, entry: Value) !AppendResult {
        if (!logm.isLogEntry(entry) or entry.get("genesis") == null) return .{ .invalid = "append: only the genesis entry is appended (every other entry is checked and committed)" };
        if ((try rt.store.logTip(a)) != null) return .{ .invalid = "append: the log has its genesis already" };
        const gc = Value.cidOf(entry.get("genesis")).?;
        if (!logm.isGenesis(rt.store.getOpt(a, gc))) return .{ .invalid = "append: the genesis record is not in the store, or is malformed (put it first)" };
        return switch (try rt.store.logAppend(a, entry)) {
            .ok => |c| .{ .ok = c },
            .rejected => |r| .{ .rejected = .{ .reason = r.reason, .message = r.message } },
        };
    }

    // ------------------------------------------------------------ the loop

    pub fn kick(rt: *Runtime) void {
        if (!rt.started or rt.stopped) return;
        if (rt.draining) {
            rt.again = true;
            return;
        }
        rt.draining = true;
        defer rt.draining = false;
        while (true) {
            rt.drain() catch |err| rt.say("runtime: {s}", .{rt.errText(err)});
            if (!rt.again) break;
            rt.again = false;
        }
        rt.store.commit() catch |err| rt.say("runtime: commit: {s}", .{@errorName(err)});
        rt.flushOutbox();
    }

    // Per thread (#158: `skein-kernel host` steps instances on a pool of workers): the message of
    // the error the entry being processed on this thread failed with.
    threadlocal var last_error: []const u8 = "";
    fn errText(rt: *Runtime, err: anyerror) []const u8 {
        _ = rt;
        return if (last_error.len > 0) last_error else @errorName(err);
    }

    fn drain(rt: *Runtime) !void {
        while (true) {
            var any = false;
            var outer = std.heap.ArenaAllocator.init(rt.gpa);
            defer outer.deinit();
            const list = try rt.store.logFrom(outer.allocator(), rt.cursor);
            for (list) |cid| {
                if (rt.stopped) return;
                any = true;
                var arena = std.heap.ArenaAllocator.init(rt.gpa);
                defer arena.deinit();
                const a = arena.allocator();
                const e = try rt.getOrNotFound(a, cid);
                last_error = "";
                try rt.process(a, cid, e);
                rt.cursor = @intCast((Value.intOf(e.get("n")) orelse rt.cursor) + 1);
                try rt.store.cursorSet(rt.cursor);
            }
            if (!any or rt.stopped) return;
        }
    }

    fn process(rt: *Runtime, a: std.mem.Allocator, entry: []const u8, e: Value) !void {
        const n = Value.intOf(e.get("n")) orelse 0;
        if (Value.cidOf(e.get("genesis"))) |gc| {
            const bytes = (try rt.store.bytes(rt.life.allocator(), gc)) orelse return error.NotFound;
            const g = cbor.decode(rt.life.allocator(), bytes) catch return error.Cbor;
            if (!logm.isGenesis(g)) {
                last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d}: genesis record is malformed", .{n});
                return error.Malformed;
            }
            rt.genesis = g;
        }
        const g = rt.genesis orelse {
            last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d}: no genesis", .{n});
            return error.NoGenesis;
        };
        if (!logm.isLogEntry(e)) {
            last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d} {s}: not a format-12 log entry; stopping", .{ n, short(a, entry) });
            return error.BadSignature;
        }
        const at = logm.stampOf(e.get("time")).?.ms();

        if (e.get("genesis") != null) {
            const by = heads.By{ .thread = null, .input = entry, .at = at };
            // The route table's seed, the chain's first updates (no thread).
            _ = try dispatch.open(a, rt.store);
            const rows = g.get("routes").?.array;
            for (rows) |r| _ = try dispatch.apply(a, rt.store, "add", r, .{ .thread = null, .input = entry, .at = at });
            // A system tree (issue #4): the loader pre-filled its objects; `main` starts there.
            if (Value.cidOf(g.get("tree"))) |tree| {
                if (!(try rt.store.has(tree))) {
                    last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d}: the genesis tree {s} is not in the store", .{ n, fmtCid(a, tree) });
                    return error.NotFound;
                }
                _ = try heads.advanceHead(a, rt.store, "main", tree, by);
                rt.say("#{d} genesis: main → {s} (system tree)", .{ n, short(a, tree) });
            }
            // #141: an image's installed apps — `<app>/app` (the app record) — their records pre-filled by the loader.
            if (g.get("heads")) |hs| for (hs.map) |h| {
                const root = Value.cidOf(h.value).?;
                if (!(try rt.store.has(root))) {
                    last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d}: the genesis head {s}'s record {s} is not in the store", .{ n, h.key, fmtCid(a, root) });
                    return error.NotFound;
                }
                _ = try heads.advanceHead(a, rt.store, h.key, root, by);
                rt.say("#{d} genesis: {s} → {s}", .{ n, h.key, short(a, root) });
            };
            // The starting grants (who builds the image decides what they hold).
            var granted: usize = 0;
            if (g.get("grants")) |gs| for (gs.map) |e2| for (e2.value.array) |k| {
                if (try grants.apply(a, rt.store, "add", e2.key, Value.bytesOf(k).?, by)) granted += 1;
            };
            // Call permissions (grants.zig): the genesis's approvals and kernel services, written at birth like any grant.
            if (g.get("calls")) |cs| if (cs == .map) for (cs.map) |byc| if (byc.value == .map) for (byc.value.map) |byt| {
                if (Value.str(byt.value)) |nm| {
                    _ = try grants.applyCalls(a, rt.store, "add", byc.key, byt.key, nm, by);
                } else if (byt.value == .array) for (byt.value.array) |x| if (Value.str(x)) |nm| {
                    _ = try grants.applyCalls(a, rt.store, "add", byc.key, byt.key, nm, by);
                };
            };
            if (g.get("services")) |sv| if (sv == .map) for (sv.map) |se| if (se.value == .array) for (se.value.array) |x| if (Value.str(x)) |svc| {
                _ = try grants.applyService(a, rt.store, "add", se.key, svc, by);
            };
            rt.say("#{d} genesis: {s}@{s}, {d} routes, {d} grant{s}{s}", .{ n, Value.str(g.get("handle")).?, Value.str(g.get("domain")).?, rows.len, granted, if (granted == 1) "" else "s", if (grants.hasRoot(try grants.load(a, rt.store))) "" else " (no root)" });
            return;
        }
        const d = e.get("door").?;
        const row = dispatch.rowOf(d.get("row") orelse .null) orelse {
            rt.say("#{d} {s}: its door names no row; recorded, nothing runs", .{ n, short(a, entry) });
            return;
        };
        if (Value.cidOf(e.get("request"))) |rc| return rt.processRequest(a, n, .{ .cid = entry, .e = e }, rc, d, row, at);
        if (Value.cidOf(e.get("event"))) |ev| return rt.processEvent(a, n, .{ .cid = entry, .e = e }, ev, d, row, at);
    }

    // ------------------------------------------------------------ requests and events

    /// A request entry (SPEC 5): its row's handler, run directly. A kernel operation is done here
    /// (no thread; its answer data); an app's function is the request's thread — input `args`:
    /// {fn, caller?, method, path, query, headers, body, row, request: <the package's CID>} (the
    /// package as the checks handed it back, else as received), launched by the request record.
    fn processRequest(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, rc: []const u8, d: Value, row: dispatch.Row, at: i64) !void {
        const pc = Value.cidOf(d.get("request")) orelse rc;
        const pkg = rt.store.getOpt(a, pc) orelse return error.NotFound;
        const principal = Value.bytesOf(d.get("principal"));
        const payload = pkg.get("payload") orelse .null;
        const what = try std.fmt.allocPrint(a, "#{d} request {s} {s}{s}{s}", .{ n, short(a, rc), Value.str(payload.get("path")) orelse "?", if (principal != null) " from " else "", if (principal) |p| shortKey(p) else "" });
        if (row.op) |op| {
            const by = heads.By{ .thread = null, .input = ctx.cid, .at = at };
            try rt.setAnswered(ctx.cid, null, try rt.kernelOp(a, op, payload, principal, row, by, what));
            return;
        }
        const f = (try resolveFn(a, rt.store, row.handler)) orelse {
            rt.say("{s}: {s} names no program of its app now; recorded, nothing runs", .{ what, row.handler });
            try rt.setAnswered(ctx.cid, null, try errAnswer(a, 500, try std.fmt.allocPrint(a, "{s}: no such function", .{row.handler})));
            return;
        };
        var args = cbor.MapBuilder.init(a);
        try args.put("fn", cbor.string(f.func));
        if (principal) |p| try args.put("caller", .{ .bytes = p });
        try putPayload(&args, rt.genesis.?, payload);
        try args.put("row", row.value);
        try args.put("request", cbor.cidv(pc));
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(f.program));
        try origin.put("args", args.value());
        try origin.put("launchedBy", cbor.cidv(rc));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(at));
        const t = try rt.store.chainOpen(a, origin.value());
        try rt.setAnswered(ctx.cid, t, null);
        rt.say("{s} → {s} {s}", .{ what, row.handler, short(a, t) });
        try rt.run(a, t);
    }

    /// Whether a thread is a request's (processRequest's origin: args name the request's package,
    /// launched by the request record its entry names).
    fn isRequestThread(rt: *Runtime, a: std.mem.Allocator, o: Value) bool {
        const args = o.get("args") orelse return false;
        if (args != .map or Value.cidOf(args.get("request")) == null or args.get("method") == null) return false;
        const by = Value.cidOf(o.get("launchedBy")) orelse return false;
        const ic = Value.cidOf(o.get("input")) orelse return false;
        const e = rt.store.getOpt(a, ic) orelse return false;
        return std.mem.eql(u8, Value.cidOf(e.get("request")) orelse return false, by);
    }

    pub const RequestAnswer = struct { state: []const u8, answer: ?Answer = null };

    /// A request thread's state and, at rest for good, its answer: the last update's stdout (the
    /// handler's {status, type?, headers?, body}) when it finished, a 500 with its error when it
    /// errored (or finished with no such answer).
    pub fn answerOf(rt: *Runtime, a: std.mem.Allocator, thread: []const u8) !RequestAnswer {
        const tip = (try rt.tipOf(a, thread)) orelse return .{ .state = "new" };
        const state = Value.str(tip.get("state")) orelse "?";
        if (std.mem.eql(u8, state, "finished")) {
            const stdout = if (tip.get("result")) |r| Value.bytesOf(r.get("stdout")) orelse "" else "";
            return .{ .state = state, .answer = Answer.of(a, stdout) orelse try errAnswer(a, 500, "the handler finished with no {status, body} on its stdout") };
        }
        if (std.mem.eql(u8, state, "errored")) {
            const em = tip.get("error");
            return .{ .state = state, .answer = try errAnswer(a, 500, if (em) |x| Value.str(x.get("message")) orelse "errored" else "errored") };
        }
        return .{ .state = state };
    }

    /// An event entry (SPEC 4): its row's handler as a thread — input `args`: {fn, event: <the
    /// record's CID (as the checks handed it back, else as received)>, box: <the event's name>}.
    fn processEvent(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, ev: []const u8, d: Value, row: dispatch.Row, at: i64) !void {
        const name = Value.str(ctx.e.get("name")).?;
        const rc = Value.cidOf(d.get("event")) orelse ev;
        const rec = rt.store.getOpt(a, rc);
        const kind = if (rec) |r| Value.str(r.get("kind")) orelse "?" else "?";
        const what = try std.fmt.allocPrint(a, "#{d} {s} {s} in {s}", .{ n, kind, short(a, rc), name });
        const f = (try resolveFn(a, rt.store, row.handler)) orelse {
            rt.say("{s}: {s} names no program of its app now; recorded, nothing runs", .{ what, row.handler });
            return;
        };
        var args = cbor.MapBuilder.init(a);
        try args.put("fn", cbor.string(f.func));
        try args.put("event", cbor.cidv(rc));
        try args.put("box", cbor.string(name));
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(f.program));
        try origin.put("args", args.value());
        try origin.put("launchedBy", cbor.cidv(ev));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(at));
        const t = try rt.store.chainOpen(a, origin.value());
        rt.say("{s} → {s} {s}", .{ what, row.handler, short(a, t) });
        try rt.run(a, t);
    }

    /// The last 8 hex digits of a key's bytes, for log lines.
    fn shortKey(k: []const u8) []const u8 {
        const S = struct {
            threadlocal var bufs: [4][8]u8 = undefined;
            threadlocal var next: usize = 0;
        };
        if (k.len < 4) return "?";
        const hex = std.fmt.bytesToHex(k[k.len - 4 ..][0..4].*, .lower);
        const buf = &S.bufs[S.next % 4];
        S.next +%= 1;
        buf.* = hex;
        return buf;
    }

    // ------------------------------------------------------------ the kernel's operations (SPEC 3)

    /// A request at a kernel row: the kernel itself performs the table write — validated whole, then
    /// written, under the entry (no thread; the chain updates carry `thread: null`) — and RETURNS
    /// DATA: done, or refused with the reason (nothing written). The body is the payload's body,
    /// dag-cbor. The row's role gated the sender already (root; the claim: user).
    ///   objects   {records: [{cid, bytes}], root?} → {done: {stored, main?}}: each block stored
    ///             under its CID (hash-checked); `root` becomes `main` if the instance has none
    ///   head      {name, tree | root} → {done: {name, tree}}: the head advanced to the record
    ///   route     {op: "add" | "remove", row} → {done: {op, changed}}: the route table changed
    ///             (dispatch.zig); a claim row is refused while root is held
    ///   grant     {op, role, principal} | {op, calls: {caller, callee, name}} | {op, service:
    ///             {caller, service}} → {done: {changed}}: the grants (grants.zig)
    ///   claim     {handle?, domain?} → {done: {root: <the claimant>}}: in one step, root granted to
    ///             the sender, the claim's own row removed, the head `claim` → {claimant, handle?,
    ///             domain?}. Refused when root is held already.
    fn kernelOp(rt: *Runtime, a: std.mem.Allocator, op: []const u8, payload: Value, principal: ?[]const u8, row: dispatch.Row, by: heads.By, what: []const u8) !Answer {
        const raw = Value.bytesOf(payload.get("body")) orelse "";
        const body: Value = if (raw.len == 0) .{ .map = &.{} } else cbor.decode(a, raw) catch return rt.opRefused(a, what, op, "the body is not dag-cbor");
        const done = (if (std.mem.eql(u8, op, "claim"))
            rt.claim(a, row, principal orelse return rt.opRefused(a, what, op, "no proven sender"), body, by)
        else
            rt.kernelOpBody(a, op, body, by)) catch |err| switch (err) {
            error.Refused => return rt.opRefused(a, what, op, last_error),
            else => return err,
        };
        var m = cbor.MapBuilder.init(a);
        try m.put("done", done);
        return .{ .status = 200, .type = "application/cbor", .body = try cbor.encode(a, m.value()) };
    }

    fn opRefused(rt: *Runtime, a: std.mem.Allocator, what: []const u8, op: []const u8, why: []const u8) !Answer {
        rt.say("{s}: kernel {s} refused: {s}; nothing done", .{ what, op, why });
        var m = cbor.MapBuilder.init(a);
        try m.put("refused", cbor.string(why));
        return .{ .status = 400, .type = "application/cbor", .body = try cbor.encode(a, m.value()) };
    }

    fn refuse(a: std.mem.Allocator, comptime f: []const u8, args: anytype) error{ Refused, OutOfMemory } {
        last_error = try std.fmt.allocPrint(a, f, args);
        return error.Refused;
    }

    fn kernelOpBody(rt: *Runtime, a: std.mem.Allocator, op: []const u8, body: Value, by: heads.By) !Value {
        if (body != .map) return refuse(a, "the body is not a map", .{});
        var out = cbor.MapBuilder.init(a);
        if (std.mem.eql(u8, op, "objects")) {
            const records = body.get("records") orelse return refuse(a, "want {{records: [{{cid, bytes}}], root?}}", .{});
            if (records != .array) return refuse(a, "records: not a list", .{});
            // Checked whole before anything is stored.
            for (records.array, 0..) |r, i| {
                const c = Value.cidOf(r.get("cid")) orelse return refuse(a, "record {d}: cid is not a CID", .{i});
                const bytes = Value.bytesOf(r.get("bytes")) orelse return refuse(a, "record {d}: bytes: not bytes", .{i});
                if (!cidm.hashMatches(c, bytes)) return refuse(a, "record {d}: bytes do not hash to {s}", .{ i, fmtCid(a, c) });
            }
            var root: ?[]const u8 = null;
            if (body.get("root")) |x| if (x != .null) {
                root = Value.cidOf(x) orelse return refuse(a, "root: not a CID", .{});
            };
            for (records.array) |r| try rt.store.putBlock(Value.cidOf(r.get("cid")).?, Value.bytesOf(r.get("bytes")).?);
            rt.say("kernel objects: {d} record{s} stored", .{ records.array.len, if (records.array.len == 1) "" else "s" });
            try out.put("stored", cbor.int(records.array.len));
            if (root) |t| if ((try rt.store.headTree(a, "main")) == null) {
                if (!(try rt.store.has(t))) return refuse(a, "root {s} is not in the store", .{fmtCid(a, t)});
                _ = try heads.advanceHead(a, rt.store, "main", t, by);
                rt.say("kernel objects: main → {s}", .{short(a, t)});
                try out.put("main", cbor.cidv(t));
            };
            return out.value();
        }
        if (std.mem.eql(u8, op, "head")) {
            const name = Value.str(body.get("name")) orelse return refuse(a, "want {{name, tree}}", .{});
            const tree = Value.cidOf(body.get("tree")) orelse Value.cidOf(body.get("root")) orelse return refuse(a, "want {{name, tree}}", .{});
            if (!heads.isHeadName(name)) return refuse(a, "bad head name {s}", .{try json.quoted(a, name)});
            if (std.mem.eql(u8, name, grants.HEAD)) return refuse(a, "the head {s} is the kernel's own (the grants; the `grant` operation changes them)", .{grants.HEAD});
            if (!(try rt.store.has(tree))) return refuse(a, "tree {s} is not in the store", .{fmtCid(a, tree)});
            _ = try heads.advanceHead(a, rt.store, name, tree, by);
            rt.say("kernel head: {s} → {s} (owner {s})", .{ name, short(a, tree), heads.ownerOf(name) });
            try out.put("name", cbor.string(name));
            try out.put("tree", cbor.cidv(tree));
            return out.value();
        }
        if (std.mem.eql(u8, op, "route")) {
            const what = Value.str(body.get("op")) orelse return refuse(a, "want {{op: add|remove, row}}", .{});
            if (!std.mem.eql(u8, what, "add") and !std.mem.eql(u8, what, "remove")) return refuse(a, "op {s}: add or remove", .{try json.quoted(a, what)});
            const row = body.get("row") orelse return refuse(a, "want {{op: add|remove, row}}", .{});
            if (try dispatch.problem(a, row)) |bad| return refuse(a, "row: {s}", .{bad});
            const r = dispatch.rowOf(row).?;
            if (std.mem.eql(u8, what, "add") and r.op != null and std.mem.eql(u8, r.op.?, "claim") and grants.hasRoot(try grants.load(a, rt.store))) return refuse(a, "a claim row: root is held already (the claim grants root to a claimant of an unclaimed instance)", .{});
            const c = try dispatch.apply(a, rt.store, what, row, .{ .thread = null, .input = by.input, .at = by.at });
            rt.say("kernel route: {s} {s} {s}{s} → {s}{s}", .{ what, @tagName(r.kind), r.key, if (r.prefix) "*" else "", r.handler, if (c == null) " (no change)" else "" });
            try out.put("op", cbor.string(what));
            try out.put("changed", .{ .bool = c != null });
            return out.value();
        }
        if (std.mem.eql(u8, op, "grant")) {
            const what = Value.str(body.get("op")) orelse return refuse(a, "want {{op: add|remove, role, principal}}, {{op, calls: {{caller, callee, name}}}} or {{op, service: {{caller, service}}}}", .{});
            if (!std.mem.eql(u8, what, "add") and !std.mem.eql(u8, what, "remove")) return refuse(a, "op {s}: add or remove", .{try json.quoted(a, what)});
            var moved = false;
            if (body.get("calls")) |c| {
                // Call permissions: who may call whom under which name.
                const caller = Value.str(c.get("caller")) orelse "";
                const callee = Value.str(c.get("callee")) orelse "";
                const name = Value.str(c.get("name")) orelse "";
                if (!grants.isParty(caller)) return refuse(a, "calls.caller {s}: an app's name", .{try json.quoted(a, caller)});
                if (!grants.isParty(callee)) return refuse(a, "calls.callee {s}: an app's name", .{try json.quoted(a, callee)});
                if (!grants.isCallName(name)) return refuse(a, "calls.name: 1 to {d} bytes of UTF-8 with no NUL (\"*\": any name)", .{grants.MAX_NAME});
                moved = try grants.applyCalls(a, rt.store, what, caller, callee, name, by);
                rt.say("kernel grant: {s} calls {s} → {s} as {s}{s}", .{ what, caller, callee, try json.quoted(a, name), if (moved) "" else " (no change)" });
            } else if (body.get("service")) |c| {
                // A kernel service (the raw signer: "signer").
                const caller = Value.str(c.get("caller")) orelse "";
                const service = Value.str(c.get("service")) orelse "";
                if (!grants.isParty(caller)) return refuse(a, "service.caller {s}: an app's name", .{try json.quoted(a, caller)});
                if (!grants.isService(service)) return refuse(a, "service {s}: not a kernel service (signer)", .{try json.quoted(a, service)});
                moved = try grants.applyService(a, rt.store, what, caller, service, by);
                rt.say("kernel grant: {s} service {s} to {s}{s}", .{ what, service, caller, if (moved) "" else " (no change)" });
            } else {
                const role = Value.str(body.get("role")) orelse return refuse(a, "want {{op: add|remove, role, principal}}", .{});
                if (!grants.isGrantable(role)) return refuse(a, "role {s}: root, or <app>.<role> (user and anyone are never granted)", .{try json.quoted(a, role)});
                const key = grants.keyOf(a, body.get("principal")) orelse return refuse(a, "`principal` is not an identity key", .{});
                moved = try grants.apply(a, rt.store, what, role, key, by);
                rt.say("kernel grant: {s} {s} {s}{s}", .{ what, role, shortKey(key), if (moved) "" else " (no change)" });
            }
            try out.put("changed", .{ .bool = moved });
            return out.value();
        }
        return refuse(a, "no such operation", .{});
    }

    /// The head the claim leaves (#89): its root is {claimant: the claim's sender, handle?, domain?}.
    pub const CLAIM_HEAD = "claim";

    /// The claim (#89, #127, #143): root to the sender, the claim's row removed, in one step.
    fn claim(rt: *Runtime, a: std.mem.Allocator, row: dispatch.Row, sender: []const u8, body: Value, by: heads.By) !Value {
        if (body != .map) return refuse(a, "the body is not a map", .{});
        if (!secp.isKey(sender)) return refuse(a, "the sender is not an identity key: the claimant is the claim's sender", .{});
        if (grants.hasRoot(try grants.load(a, rt.store))) return refuse(a, "root is held already: this instance is claimed", .{});
        var claimed = cbor.MapBuilder.init(a);
        try claimed.put("claimant", .{ .bytes = sender });
        if (Value.str(body.get("handle"))) |x| try claimed.put("handle", cbor.string(x));
        if (Value.str(body.get("domain"))) |x| try claimed.put("domain", cbor.string(x));
        _ = try grants.apply(a, rt.store, "add", grants.ROOT, sender, by);
        _ = try dispatch.apply(a, rt.store, "remove", row.value, .{ .thread = null, .input = by.input, .at = by.at });
        _ = try heads.advanceHead(a, rt.store, CLAIM_HEAD, try rt.store.put(a, claimed.value()), by);
        rt.say("kernel claim: root {s}; the claim row removed", .{shortKey(sender)});
        var out = cbor.MapBuilder.init(a);
        try out.put("root", .{ .bytes = sender });
        return out.value();
    }

    // ------------------------------------------------------------ facts (0.5.2: on; await on a name)

    /// The events a step emitted go out (#65, #119), in order: each handed to the host after the
    /// commit, and each fact (log.zig indexedName) steps every subscription to its name (on.zig),
    /// then every thread awaiting the name. A function of the update and the state, so replay steps
    /// the same threads (and hands nothing over: it has no host). Each event's place is in
    /// `update`, the step's own update, never the thread's tip.
    fn deliver(rt: *Runtime, a: std.mem.Allocator, ctx: Ctx, thread: []const u8, update: []const u8, emitted: []const []const u8) !void {
        const u = try rt.getOrNotFound(a, update);
        for (emitted) |mc| {
            if (rt.stopped) return;
            const m = rt.store.getOpt(a, mc) orelse continue;
            const place = placeIn(mc, u, thread);
            try rt.handOverEvent(a, mc, m, place);
            if (logm.indexedName(m)) |name| if (place) |p| {
                try rt.deliverFact(a, ctx, mc, name, p);
                try rt.wakeAwaiting(a, ctx, mc, name, p);
            };
        }
    }

    /// 0.5.2: a fact a step emitted, `ev` under `name`, steps every subscription to the name (an
    /// `on` a step made, on.zig), in the order they were made: each a thread launched by the event
    /// record under the entry that drove the emitting step, its program the subscribing app's role
    /// as its record names it now (`<app>/app`; none: nothing runs), its args {event, box: <the
    /// name>, fn, place: {s, i, thread}} (the place makes two like records two threads).
    fn deliverFact(rt: *Runtime, a: std.mem.Allocator, ctx: Ctx, ev: []const u8, name: []const u8, place: Place) !void {
        const subs = try rt.store.subscribers(a, name);
        if (subs.len == 0) return;
        for (subs) |sub| {
            if (rt.stopped) return;
            const ps = try subsm.programsOf(a, rt.store, sub.app);
            const handler = if (ps) |x| if (x == .map) Value.cidOf(x.get(sub.role)) else null else null;
            const prog = handler orelse {
                rt.say("event {s} {s}: app {s} names no program {s} now; nothing runs", .{ name, short(a, ev), sub.app, sub.role });
                continue;
            };
            var info = cbor.MapBuilder.init(a);
            try info.put("event", cbor.cidv(ev));
            try info.put("box", cbor.string(name));
            try info.put("fn", cbor.string(sub.func));
            try info.put("place", try placeValue(a, place));
            var origin = cbor.MapBuilder.init(a);
            try origin.put("kind", cbor.string("thread"));
            try origin.put("program", cbor.cidv(prog));
            try origin.put("args", info.value());
            try origin.put("launchedBy", cbor.cidv(ev));
            try origin.put("input", cbor.cidv(ctx.cid));
            try origin.put("at", cbor.int(logm.stampOf(ctx.e.get("time")).?.ms()));
            const t = try rt.store.chainOpen(a, origin.value());
            if (try rt.store.chainTip(a, t)) |tip| if (!std.mem.eql(u8, tip, t)) continue;
            rt.say("event {s} {s} → {s}.{s} {s}", .{ name, short(a, ev), sub.app, sub.func, short(a, t) });
            try rt.run(a, t);
        }
    }

    fn placeValue(a: std.mem.Allocator, place: Place) !Value {
        var p = cbor.MapBuilder.init(a);
        try p.put("s", cbor.int(place.s));
        try p.put("i", cbor.int(place.i));
        try p.put("thread", cbor.cidv(place.thread));
        return p.value();
    }

    /// `await(name)` (SPEC 5): a fact a step emitted, `ev` under `name`, resumes every thread awaiting
    /// the name — once: in the order they began waiting (the waits index, index.zig `awaits`), each
    /// stepped at the emitting entry with `event` {event, box: <the name>, place: {s, i, thread}}
    /// beside its own context; it waits on the name no more (stepBody carries no rest forward).
    fn wakeAwaiting(rt: *Runtime, a: std.mem.Allocator, ctx: Ctx, ev: []const u8, name: []const u8, place: Place) !void {
        const ts = try rt.store.restingOn(a, name);
        if (ts.len == 0) return;
        for (ts) |t| {
            if (rt.stopped) return;
            const tip = rt.tipOf(a, t) catch null orelse continue;
            if (!stateIs(tip, "waiting") or !awaitsName(tip, name)) continue;
            var info = cbor.MapBuilder.init(a);
            try info.put("event", cbor.cidv(ev));
            try info.put("box", cbor.string(name));
            try info.put("place", try placeValue(a, place));
            rt.say("event {s} {s} → {s} (awaits it)", .{ name, short(a, ev), short(a, t) });
            rt.step_extra = .{ .key = "event", .value = info.value() };
            try rt.step(a, t, ctx);
        }
    }

    /// Whether a waiting update awaits the name `name` (its `restsOn`: [{name, s}]).
    fn awaitsName(tip: Value, name: []const u8) bool {
        const l = tip.get("restsOn") orelse return false;
        if (l != .array) return false;
        for (l.array) |x| if (std.mem.eql(u8, Value.str(x.get("name")) orelse "", name)) return true;
        return false;
    }

    // ------------------------------------------------------------ threads

    fn programOf(rt: *Runtime, a: std.mem.Allocator, o: Value) !Value {
        const pc = Value.cidOf(o.get("program")) orelse return rt.failf(a, "program {s} is not a program record in this store", .{"undefined"});
        const p = rt.store.getOpt(a, pc);
        if (!programs.isProgram(p)) return rt.failf(a, "program {s} is not a program record in this store", .{short(a, pc)});
        return p.?;
    }

    fn failf(rt: *Runtime, a: std.mem.Allocator, comptime f: []const u8, args: anytype) error{ Failed, OutOfMemory } {
        _ = rt;
        last_error = try std.fmt.allocPrint(a, f, args);
        return error.Failed;
    }

    fn hasWasm(p: Value) bool {
        const code = p.get("code") orelse return false;
        return code.get("wasm") != null;
    }

    /// Start a thread that has no updates yet: its first step, under the entry it was launched by.
    fn run(rt: *Runtime, a: std.mem.Allocator, origin: []const u8) anyerror!void {
        const o = try rt.getOrNotFound(a, origin);
        const input = Value.cidOf(o.get("input")).?;
        try rt.step(a, origin, .{ .cid = input, .e = try rt.getOrNotFound(a, input) });
    }

    /// A thread the last process left with no update (launched, its first step never ended): stepped
    /// now. A waiting thread waits for what it awaits.
    fn resume_(rt: *Runtime, a: std.mem.Allocator, origin: []const u8) !void {
        const o = try rt.getOrNotFound(a, origin);
        if ((try rt.tipOf(a, origin)) != null) return;
        const p = rt.programOf(a, o) catch return;
        rt.say("{s} {s}: stepping (interrupted before its first step ended)", .{ short(a, origin), Value.str(p.get("name")).? });
        try rt.run(a, origin);
    }

    /// A thread came to rest for good: every thread awaiting it (`await(<its identity>)`) resumes,
    /// once, with `resolved` [{thread, state, result, error}], under the entry that brought it to rest.
    fn rested(rt: *Runtime, a: std.mem.Allocator, child: []const u8) anyerror!void {
        const awaiters = try rt.store.awaiting(a, child);
        if (awaiters.len == 0) return;
        const ct = (try rt.tipOf(a, child)) orelse return;
        if (!stateIs(ct, "finished") and !stateIs(ct, "errored")) return;
        var m = cbor.MapBuilder.init(a);
        try m.put("thread", cbor.cidv(child));
        try m.put("state", ct.get("state"));
        try m.put("result", ct.get("result"));
        try m.put("error", ct.get("error"));
        const resolved = Value{ .array = try a.dupe(Value, &.{m.value()}) };
        const ic = Value.cidOf(ct.get("input")) orelse return error.NotFound;
        const driver = Ctx{ .cid = ic, .e = try rt.getOrNotFound(a, ic) };
        for (awaiters) |t| {
            const tip = rt.tipOf(a, t) catch null orelse continue;
            if (!stateIs(tip, "waiting") or !cidIn(tip.get("awaits"), child)) continue;
            rt.say("{s} → {s} (awaits the thread)", .{ short(a, child), short(a, t) });
            rt.step_extra = .{ .key = "resolved", .value = resolved };
            try rt.step(a, t, driver);
        }
    }

    // ------------------------------------------------------------ program steps

    const StepState = struct {
        rt: *Runtime,
        a: std.mem.Allocator,
        origin: []const u8,
        entry: []const u8,
        n: i64,
        at: i64,
        input: []const u8,
        clock: syscalls.ThreadClock = .{},
        random: syscalls.Entropy,
        calls: *std.array_list.Managed([]const u8),
        launched: std.array_list.Managed([]const u8),
        kept: std.array_list.Managed([]const u8),
        /// The threads this step awaits (`await(<thread>)`), in order, once each.
        awaits: std.array_list.Managed([]const u8),
        moves: std.array_list.Managed([2][]const u8),
        children: std.array_list.Managed(Value),
        /// The program running now (the thread's, and under it each in-VM callee): its write scope.
        progs: std.array_list.Managed(Running),
        /// The events the step emitted, in order: listed on its update, handed over when it ends without error.
        emitted: std.array_list.Managed([]const u8),
        /// 0.8.0: each CID in `emitted` → its index there (the first): a record is listed once, in O(1).
        emitted_at: std.StringHashMap(u32),
        /// 0.8.0: the facts among them (log.zig indexedName), in order, and by name — what the
        /// step's `events` reads see beside the index (program.zig eventsRows).
        facts: std.array_list.Managed(program.PendingFact),
        fact_names: std.StringHashMap(std.ArrayListUnmanaged(u32)),
        /// 0.8.0: the instance's step number this step's update takes (its facts' place `s`).
        ord: i64,
        /// 0.5.2: the `on` / `off` calls the step made, in order (on.zig): kept when it ends without error.
        ons: std.array_list.Managed(OnCall),
        /// The names this step awaits (`await(<name>)`), in order, once each.
        rests: std.array_list.Managed([]const u8),
        /// For in-VM calls (#40): the step's host and services, and how deep the calls nest.
        host: ?*const program.Host = null,
        svc: ?*wasi.Services = null,
        depth: u8 = 0,
    };

    fn stepOf(imp: *program.Imports) *StepState {
        return @ptrCast(@alignCast(imp.host.ctx));
    }

    fn step(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, ctx: Ctx) anyerror!void {
        if (rt.stepping.contains(origin) or rt.stopped) {
            rt.step_extra = null;
            return;
        }
        const key = try rt.gpa.dupe(u8, origin);
        try rt.stepping.put(key, {});
        var after_launched: []const []const u8 = &.{};
        var after_emitted: []const []const u8 = &.{};
        var after_update: []const u8 = "";
        var after_rested = false;
        // The step's fuel: one budget for the whole step, read from the genesis at its start.
        var meter = engine.Meter.init(fuelPerStep(rt.genesis));
        // The signer calls the step made, kept even when it fails: an errored update lists them, so
        // a replay has their answers.
        var calls = std.array_list.Managed([]const u8).init(a);
        blk: {
            defer {
                _ = rt.stepping.remove(key);
                rt.gpa.free(key);
            }
            // 0.9.1: the step's wall-clock start, for its log line only.
            const t0: ?u64 = if (rt.peers.now_ns) |f| f(rt.peers.ctx) else null;
            const r = rt.stepBody(a, origin, ctx, &meter, &calls, t0) catch |err| {
                const exhausted = err == error.FuelExhausted;
                const msg = if (exhausted) runner.FUEL_EXHAUSTED else if (err == error.Failed or err == error.Fatal or err == error.Diverged or err == error.NoWitness) last_error else @errorName(err);
                const label = if (err == error.Diverged) "DIVERGED" else if (err == error.NoWitness) "cannot run" else "failed";
                rt.say("{s} step {s}{s}: {s}", .{ short(a, origin), label, try rt.timing(a, t0, &meter), msg });
                if (err == error.Diverged or err == error.NoWitness) return;
                var m = cbor.MapBuilder.init(a);
                try m.put("state", cbor.string("errored"));
                try m.put("input", cbor.cidv(ctx.cid));
                try m.put("at", cbor.int(logm.stampOf(ctx.e.get("time")).?.ms()));
                // 0.8.0: the instance's next step number, as any thread update the scheduler appends.
                try m.put("ord", cbor.int((try rt.store.lastStep()) + 1));
                try m.put("fuel", cbor.int(meter.used()));
                if (calls.items.len > 0) try m.put("calls", try cbor.cidArray(a, calls.items));
                var em = cbor.MapBuilder.init(a);
                // Out of fuel is stable (the same step burns the same fuel again): can't-do, never retried.
                try em.put("kind", cbor.string(if (exhausted) "cant-do" else "blew-up"));
                try em.put("message", cbor.string(msg));
                try m.put("error", em.value());
                _ = rt.store.chainAppend(a, origin, m.value()) catch {};
                after_rested = true;
                break :blk;
            };
            after_launched = r.launched;
            after_emitted = r.emitted;
            after_update = r.update;
            after_rested = r.rested;
        }
        // A request's thread at rest after its COMMIT returned (it waited first): the host hears now.
        if (after_rested and !rt.stopped) if (rt.peers.on_answer) |f| {
            const o = rt.store.getOpt(a, origin);
            if (o != null and rt.isRequestThread(a, o.?)) {
                const answering = if (rt.answered) |x| x.thread != null and std.mem.eql(u8, x.thread.?, origin) else false;
                if (!answering) f(rt.peers.ctx, origin, Value.cidOf(o.?.get("input")).?);
            }
        };
        // What the step emitted goes out.
        if (after_emitted.len > 0 and !rt.stopped) try rt.deliver(a, ctx, origin, after_update, after_emitted);
        // What it launched runs (the launcher does not wait for it).
        for (after_launched) |c| try rt.run(a, c);
        if (after_rested) try rt.rested(a, origin);
    }

    /// 0.8.0: a step's log line is a summary, bounded by construction: each list (emitted, launched,
    /// moved, awaits) shows its first LINE_LIST_MAX and its count, the program's stderr its first
    /// LINE_TEXT_MAX bytes — the update record holds them all.
    const LINE_LIST_MAX = 8;
    const LINE_TEXT_MAX = 2048;

    fn shortList(w: *std.array_list.Managed(u8), a: std.mem.Allocator, items: []const []const u8) !void {
        for (items[0..@min(items.len, LINE_LIST_MAX)], 0..) |c, i| try w.print("{s}{s}", .{ if (i > 0) "," else "", short(a, c) });
        if (items.len > LINE_LIST_MAX) try w.print(",… ({d} in all)", .{items.len});
    }

    /// The longest prefix of `s` at most `max` bytes that does not cut a UTF-8 sequence.
    fn utf8Floor(s: []const u8, max: usize) usize {
        var k = @min(s.len, max);
        while (k > 0 and k < s.len and (s[k] & 0xC0) == 0x80) k -= 1;
        return k;
    }

    const After = struct { launched: []const []const u8, emitted: []const []const u8 = &.{}, update: []const u8 = "", rested: bool };

    /// 0.9.1: a step line's ` · 12.3 ms · fuel 1234567` — the wall-clock time since `t0` (when the
    /// host gave a clock) and the fuel the step used. Text for the line only.
    fn timing(rt: *Runtime, a: std.mem.Allocator, t0: ?u64, meter: *engine.Meter) ![]const u8 {
        if (t0) |s| if (rt.peers.now_ns) |f| {
            const t1 = f(rt.peers.ctx);
            const us = (if (t1 > s) t1 - s else 0) / 1000;
            return std.fmt.allocPrint(a, " · {d}.{d} ms · fuel {d}", .{ us / 1000, (us % 1000) / 100, meter.used() });
        };
        return std.fmt.allocPrint(a, " · fuel {d}", .{meter.used()});
    }

    fn stepBody(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, ctx: Ctx, meter: *engine.Meter, calls: *std.array_list.Managed([]const u8), t0: ?u64) anyerror!After {
        const o = try rt.getOrNotFound(a, origin);
        const prog = try rt.programOf(a, o);
        if (!hasWasm(prog)) return rt.failf(a, "not a wasm program", .{});
        const n: i64 = @intCast(1 + if (try rt.store.chainUpdates(a, origin)) |us| us.len else 0);
        const tip_cid = (try rt.store.chainTip(a, origin)).?;
        // 0.8.0: the instance's step number this step's update takes (`ord`): the next one. Its facts
        // are read in the step at that place, and the index gives them the same.
        const ord: i64 = (try rt.store.lastStep()) + 1;
        const time = logm.stampOf(ctx.e.get("time")).?;
        const at = time.ms();
        const g = rt.genesis.?;

        var input = cbor.MapBuilder.init(a);
        try input.put("kind", cbor.string("step"));
        try input.put("thread", cbor.cidv(origin));
        try input.put("step", cbor.int(n));
        try input.put("entry", cbor.cidv(ctx.cid));
        try input.put("at", cbor.int(at));
        var self = cbor.MapBuilder.init(a);
        try self.put("handle", g.get("handle"));
        try self.put("domain", g.get("domain"));
        try self.put("identity", g.get("identity"));
        try input.put("self", self.value());
        try input.put("args", o.get("args"));
        if (!std.mem.eql(u8, tip_cid, origin)) try input.put("tip", cbor.cidv(tip_cid));
        try input.put("defaults", g.get("defaults"));
        if (rt.step_extra) |x| try input.put(x.key, x.value);
        rt.step_extra = null;

        var st = StepState{
            .rt = rt,
            .a = a,
            .origin = origin,
            .entry = ctx.cid,
            .n = n,
            .at = at,
            .input = try cbor.encode(a, input.value()),
            .random = syscalls.Entropy.seeded("", ctx.cid, origin),
            .calls = calls,
            .launched = .init(a),
            .kept = .init(a),
            .awaits = .init(a),
            .moves = .init(a),
            .children = .init(a),
            .progs = .init(a),
            .emitted = .init(a),
            .emitted_at = .init(a),
            .facts = .init(a),
            .fact_names = .init(a),
            .ord = ord,
            .ons = .init(a),
            .rests = .init(a),
        };
        try st.progs.append(.{ .record = prog, .cid = Value.cidOf(o.get("program")).? });
        st.clock.drive(time.ns());
        st.clock.meter = meter; // the in-step clock runs on the step's fuel (issue #38)

        var msg: []const u8 = "";
        const mod = rt.runner.load(rt.store, a, programs.wasmOf(prog) orelse return rt.failf(a, "not a wasm program", .{}), &msg) catch |err| switch (err) {
            error.NotInStore, error.BadHash, error.Compile => {
                last_error = msg;
                return error.Failed;
            },
            else => return err,
        };
        const host = program.Host{
            .ctx = &st,
            .input = hInput,
            .get = hGet,
            .put = hPut,
            .putBlock = hPutBlock,
            .keep = hKeep,
            .launch = hLaunch,
            .awaitOn = hAwait,
            .head = hHead,
            .advance = hAdvance,
            .wallet = hWallet,
            .emit = hEmit,
            .call = hCall,
            .callAs = hCallAs,
            .edges = hEdges,
            .events = hEvents,
            .on = hOn,
            .off = hOff,
        };
        var rs = wasi.RunState{ .meter = meter };
        var svc = wasi.Services{ .ctx = &st, .state = &rs, .clock = stClock, .random = stRandom };
        st.host = &host;
        st.svc = &svc;
        const name = Value.str(prog.get("name")).?;
        const out = program.runProgram(a, rt.runner, mod, name, &host, &svc) catch |err| switch (err) {
            error.Fatal => {
                const f = rs.fatal orelse wasi.Fatal{ .message = "fatal" };
                last_error = f.message;
                return switch (f.kind) {
                    .diverged => error.Diverged,
                    .no_witness => error.NoWitness,
                    .fuel => error.FuelExhausted,
                    .plain => error.Failed,
                };
            },
            else => return err,
        };

        if (rt.stopped) return .{ .launched = &.{}, .rested = false };
        // 0.8.0: an invariant, checked before anything of the step is written: no thread update was
        // appended while its program ran (in-VM calls append none), so its update takes `ord`, the
        // place its facts were read at. Were it ever otherwise the step fails here, nothing written.
        {
            const now = try rt.store.lastStep();
            if (now + 1 != ord) return rt.failf(a, "the instance's step number moved to {d} while step {d} ran: the place of its facts is not known", .{ now, ord });
        }
        // The names this step awaits, each with (0.8.0) the step number that began the wait. Once:
        // a woken thread awaits nothing it did not await again in the step that woke it.
        var rests = std.array_list.Managed(Value).init(a);
        if (out.exit_code == 0) for (st.rests.items) |nm| {
            var r = cbor.MapBuilder.init(a);
            try r.put("name", cbor.string(nm));
            try r.put("s", cbor.int(ord));
            try rests.append(r.value());
        };
        const state: []const u8 = if (out.exit_code != 0) "errored" else if (st.awaits.items.len > 0 or rests.items.len > 0) "waiting" else "finished";
        const errored = std.mem.eql(u8, state, "errored");
        for (st.children.items) |c| _ = try rt.store.chainOpen(a, c);
        var head_updates = std.array_list.Managed([]const u8).init(a);
        if (!errored) for (st.moves.items) |m| try head_updates.append(try heads.advanceHead(a, rt.store, m[0], m[1], .{ .thread = origin, .input = ctx.cid, .at = at }));
        // 0.5.2: the subscriptions the step made, in order (on.zig).
        if (!errored) for (st.ons.items) |c| {
            _ = try onm.apply(a, rt.store, c.op, c.name, c.app, c.role, c.func, .{ .thread = origin, .input = ctx.cid, .at = at });
        };
        const waiting = std.mem.eql(u8, state, "waiting");

        var u = cbor.MapBuilder.init(a);
        try u.put("state", cbor.string(state));
        try u.put("step", cbor.int(n));
        try u.put("ord", cbor.int(ord));
        try u.put("input", cbor.cidv(ctx.cid));
        try u.put("at", cbor.int(at));
        try u.put("fuel", cbor.int(meter.used()));
        if (waiting) try u.put("awaits", try cbor.cidArray(a, st.awaits.items));
        if (waiting and rests.items.len > 0) try u.put("restsOn", .{ .array = rests.items });
        try u.put("calls", try cbor.cidArray(a, st.calls.items));
        if (!errored) try u.put("emitted", try cbor.cidArray(a, st.emitted.items));
        try u.put("launched", try cbor.cidArray(a, st.launched.items));
        try u.put("kept", try cbor.cidArray(a, st.kept.items));
        try u.put("heads", try cbor.cidArray(a, head_updates.items));
        var res = cbor.MapBuilder.init(a);
        try res.put("exitCode", cbor.int(out.exit_code));
        try res.put("stdout", .{ .bytes = out.stdout });
        try res.put("stderr", .{ .bytes = out.stderr });
        try u.put("result", res.value());
        const stderr_text = try jsTrim(a, out.stderr);
        if (errored) {
            var last = stderr_text;
            if (std.mem.lastIndexOfScalar(u8, last, '\n')) |i| last = last[i + 1 ..];
            var em = cbor.MapBuilder.init(a);
            try em.put("kind", cbor.string("blew-up"));
            try em.put("message", cbor.string(if (last.len > 0) last else try std.fmt.allocPrint(a, "exit {d}", .{out.exit_code})));
            try u.put("error", em.value());
        }
        const uc = try rt.store.chainAppend(a, origin, u.value());

        // The log line.
        var line = std.array_list.Managed(u8).init(a);
        const w = &line;
        try w.print("{s} {s} step {d} → {s}", .{ short(a, origin), name, n, state });
        if (st.calls.items.len > 0) try w.print(" · {d} signer", .{st.calls.items.len});
        if (!errored and st.emitted.items.len > 0) {
            try w.appendSlice(" · emitted ");
            try shortList(w, a, st.emitted.items);
        }
        if (st.kept.items.len > 0) try w.print(" · {d} kept", .{st.kept.items.len});
        if (st.launched.items.len > 0) {
            try w.appendSlice(" · launched ");
            try shortList(w, a, st.launched.items);
        }
        if (head_updates.items.len > 0) {
            try w.appendSlice(" · moved ");
            for (st.moves.items[0..@min(st.moves.items.len, LINE_LIST_MAX)], 0..) |m, i| try w.print("{s}{s}→{s}", .{ if (i > 0) "," else "", m[0], short(a, m[1]) });
            if (st.moves.items.len > LINE_LIST_MAX) try w.print(",… ({d} in all)", .{st.moves.items.len});
        }
        if (st.awaits.items.len > 0) {
            try w.appendSlice(" · awaits ");
            try shortList(w, a, st.awaits.items);
        }
        for (st.rests.items) |nm| try w.print(" · awaits {s}", .{nm});
        // 0.9.1: the step's duration and fuel, before any program text, so always on the first line.
        try w.appendSlice(try rt.timing(a, t0, meter));
        // 0.8.0: bounded (the line is a summary; the program's whole stderr is in the update's result).
        const err_text = if (stderr_text.len > LINE_TEXT_MAX) try std.fmt.allocPrint(a, "{s}… ({d} bytes in all)", .{ stderr_text[0..utf8Floor(stderr_text, LINE_TEXT_MAX)], stderr_text.len }) else stderr_text;
        if (errored) try w.print(" · {s}", .{err_text}) else if (err_text.len > 0) try w.print(" · stderr: {s}", .{err_text});
        rt.say("{s}", .{line.items});

        return .{ .launched = st.launched.items, .emitted = if (errored) &.{} else st.emitted.items, .update = uc, .rested = !waiting };
    }

    // -------------------------------------------------- the program host (skein imports)

    fn stClock(ctx: *anyopaque, _: u32) u64 {
        const st: *StepState = @ptrCast(@alignCast(ctx));
        return @intCast(st.clock.read());
    }
    fn stRandom(ctx: *anyopaque, out: []u8) void {
        const st: *StepState = @ptrCast(@alignCast(ctx));
        st.random.fill(out);
    }

    fn notFound(imp: *program.Imports, c: []const u8) program.Err {
        return imp.failFmt("not found: {s}", .{fmtCid(imp.alloc, c)});
    }

    fn hInput(imp: *program.Imports) []const u8 {
        return stepOf(imp).input;
    }
    fn hGet(imp: *program.Imports, c: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        return (st.rt.store.bytes(st.a, c) catch return imp.failWith("store error")) orelse notFound(imp, c);
    }
    fn hPut(imp: *program.Imports, bytes: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const v = cbor.decode(st.a, bytes) catch return imp.failWith("CBOR decode error");
        return st.rt.store.put(st.a, v) catch return imp.failWith("store error");
    }
    fn hPutBlock(imp: *program.Imports, c: []const u8, bytes: []const u8) program.Err!void {
        const st = stepOf(imp);
        if (!cidm.hashMatches(c, bytes)) return imp.failFmt("putblock: bytes do not hash to {s}", .{fmtCid(st.a, c)});
        st.rt.store.putBlock(c, bytes) catch return imp.failWith("store error");
    }
    fn hKeep(imp: *program.Imports, c: []const u8) program.Err!void {
        const st = stepOf(imp);
        if (!(st.rt.store.has(c) catch false)) return imp.failFmt("keep: {s} is not in the store", .{fmtCid(st.a, c)});
        try st.kept.append(c);
    }
    /// `launch` (SPEC 5): a thread of `prog` on `args` (a record in the store) kicked off — it runs
    /// once this step is written. The launcher is NOT put into waiting: it follows the launch with
    /// `await(<the thread>)` if it wants the result.
    fn hLaunch(imp: *program.Imports, prog: []const u8, args: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const a = st.a;
        if (!programs.isProgram(st.rt.store.getOpt(a, prog))) return imp.failFmt("launch: {s} is not a program", .{fmtCid(a, prog)});
        const av = (st.rt.store.get(a, args) catch return imp.failWith("CBOR decode error")) orelse return notFound(imp, args);
        var child = cbor.MapBuilder.init(a);
        try child.put("kind", cbor.string("thread"));
        try child.put("program", cbor.cidv(prog));
        try child.put("args", av);
        try child.put("launchedBy", cbor.cidv(st.origin));
        try child.put("input", cbor.cidv(st.entry));
        try child.put("at", cbor.int(st.at));
        try child.put("nonce", cbor.string(try std.fmt.allocPrint(a, "{d}.{d}", .{ st.n, st.launched.items.len })));
        const c = cbor.cidOfValue(a, child.value()) catch return imp.failWith("the args are not IPLD");
        try st.children.append(child.value());
        try st.launched.append(c);
        return c;
    }
    /// `await(x)` (SPEC 5): x a THREAD's identity (a binary CID naming a thread origin — one this
    /// step launched, or any other) or a fact's NAME (text: an event name, no intention's). THIS
    /// thread resumes, once: when the thread comes to rest for good (input `resolved`), or when a
    /// fact of that name lands (input `event`). The step ends waiting.
    fn hAwait(imp: *program.Imports, x: []const u8) program.Err!void {
        const st = stepOf(imp);
        const a = st.a;
        if (cidm.parts(x)) |_| {
            if (isThreadIn(st, x)) {
                if (st.rt.threadAtRest(a, x)) return imp.failFmt("await: thread {s} has come to rest; read its state instead", .{fmtCid(a, x)});
                for (st.awaits.items) |y| if (std.mem.eql(u8, x, y)) return;
                return st.awaits.append(try a.dupe(u8, x));
            }
        } else |_| {}
        const name = cbor.utf8Fix(a, x) catch return error.OutOfMemory;
        if (logm.isIntention(name) or !logm.isEventName(name)) return imp.failWith("await: want a thread's identity (a thread this instance runs or launched) or a fact's name (a slash path of segments: no empty segment, no space or NUL; no intention)");
        for (st.rests.items) |y| if (std.mem.eql(u8, y, name)) return;
        return st.rests.append(try a.dupe(u8, name));
    }
    fn hHead(imp: *program.Imports, name: []const u8) program.Err!?[]const u8 {
        const st = stepOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("head: bad name {s}", .{try json.quoted(st.a, name)});
        // A step sees its own moves (#40: an in-VM call may advance a head its caller then reads).
        var i = st.moves.items.len;
        while (i > 0) : (i -= 1) if (std.mem.eql(u8, st.moves.items[i - 1][0], name)) return st.moves.items[i - 1][1];
        return heads.headTree(st.a, st.rt.store, name) catch imp.failWith("store error");
    }
    /// `advance` (#77): only a head in the running program's write scope — an app's program (listed
    /// in its app's record at `<app>/app`) writes `<app>/…`. Any other program record (one a step
    /// put and launched or called) runs, and writes no head (K1).
    fn hAdvance(imp: *program.Imports, name: []const u8, t: []const u8) program.Err!void {
        const st = stepOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("advance: bad head name {s}", .{try json.quoted(st.a, name)});
        if (std.mem.eql(u8, name, grants.HEAD)) return imp.failFmt("advance: {s} is the kernel's own (the grants); no program writes it", .{grants.HEAD});
        const run_ = &st.progs.items[st.progs.items.len - 1];
        const prog = run_.record;
        const pname = Value.str(prog.get("name")) orelse "?";
        if (run_.install == null) run_.install = installedIn(st.a, st.rt.store, run_.cid, prog) catch return imp.failWith("store error");
        if (run_.install.? == .none) return imp.failFmt("advance: {s} is outside the write scope of {s}: its program record {s} is not listed in its app's record at <app>/app, so it writes no head", .{ try json.quoted(st.a, name), pname, fmtCid(st.a, run_.cid) });
        if (!mayAdvance(prog, run_.install.?, name)) return imp.failFmt("advance: {s} is outside the write scope of {s} (app {s} writes only heads under its own name, {s}/…)", .{ try json.quoted(st.a, name), pname, Value.str(prog.get("app")) orelse "?", Value.str(prog.get("app")) orelse "?" });
        if (!(st.rt.store.has(t) catch false)) return imp.failFmt("advance: tree {s} is not in the store", .{fmtCid(st.a, t)});
        try st.moves.append(.{ name, t });
    }

    /// A program running in a step (the thread's, or an in-VM callee): its record, the record's
    /// CID, and how it is installed (looked up at its first `advance`, then kept for the step).
    const Running = struct { record: Value, cid: []const u8, install: ?Install = null };

    /// How a program record is installed (K1): `app` — listed under `programs` in the app record at
    /// `<app>/app` for the `app` its record names, so it writes `<app>/…` and nothing else; `none` —
    /// any other record (one a step put), which runs (launch and call take any program record) but
    /// writes no head, emits no fact and holds no grant.
    pub const Install = enum { app, none };

    fn mapHasCid(m: ?Value, c: []const u8) bool {
        const v = m orelse return false;
        if (v != .map) return false;
        for (v.map) |e| if (Value.cidOf(e.value)) |x| if (std.mem.eql(u8, x, c)) return true;
        return false;
    }

    /// The lookup over the tables as they stand (the store's state at this point in the log — the
    /// same on replay).
    pub fn installedIn(a: std.mem.Allocator, store: Store, c: []const u8, record: Value) !Install {
        const app = Value.str(record.get("app")) orelse return .none;
        const ar = (try appRecord(a, store, app)) orelse return .none;
        return if (mapHasCid(ar.get("programs"), c)) .app else .none;
    }

    /// A running program's party name for call permissions and kernel services (grants.zig): an
    /// installed app's program is its app's name; a record a step put has none.
    pub fn partyOf(record: Value, install: Install) ?[]const u8 {
        if (install == .none) return null;
        return Value.str(record.get("app"));
    }

    /// Why the program running now (`me`) may not use the raw signer — the `signer` kernel service
    /// (grants.zig) — or null when it may.
    fn signerProblem(a: std.mem.Allocator, store: Store, me: *Running) !?[]const u8 {
        if (me.install == null) me.install = try installedIn(a, store, me.cid, me.record);
        const party = partyOf(me.record, me.install.?) orelse return try std.fmt.allocPrint(a, "wallet: {s} (a program record no app lists) does not hold the signer service", .{fmtCid(a, me.cid)});
        if (grants.holdsService(try grants.load(a, store), party, grants.SIGNER)) return null;
        return try std.fmt.allocPrint(a, "wallet: {s} does not hold the signer service", .{party});
    }

    /// Why `caller` (the program running now) may not call `prog` (`callee`, its record) under
    /// `name`, or null when it may: both installed, and the grants' `calls` approve (caller app,
    /// callee app, name) exactly, or "*".
    fn namedCallProblem(a: std.mem.Allocator, store: Store, caller: *Running, prog: []const u8, callee: Value, name: []const u8) !?[]const u8 {
        if (!grants.isCallName(name)) return try std.fmt.allocPrint(a, "callAs: the name is not 1 to {d} bytes of UTF-8 with no NUL", .{grants.MAX_NAME});
        if (caller.install == null) caller.install = try installedIn(a, store, caller.cid, caller.record);
        const from = partyOf(caller.record, caller.install.?) orelse return try a.dupe(u8, "callAs: a named call needs an installed caller (this program record was put by a step)");
        const to = partyOf(callee, try installedIn(a, store, prog, callee)) orelse return try std.fmt.allocPrint(a, "callAs: {s} is no installed app's program", .{fmtCid(a, prog)});
        if (grants.mayCall(try grants.load(a, store), from, to, name)) return null;
        return try std.fmt.allocPrint(a, "callAs: {s} is not approved to call {s} as {s}", .{ from, to, try json.quoted(a, name) });
    }

    /// Whether a program record installed as `install` may advance `name`: an app's `<app>/…`.
    pub fn mayAdvance(prog: Value, install: Install, name: []const u8) bool {
        return switch (install) {
            .none => false,
            .app => if (Value.str(prog.get("app"))) |app| appScope(app, name) else false,
        };
    }

    fn appScope(app: []const u8, name: []const u8) bool {
        return name.len > app.len and std.mem.startsWith(u8, name, app) and name[app.len] == '/';
    }

    fn hWallet(imp: *program.Imports, frame: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        var allowed = false;
        if (frame.len > 0) for (wallet_calls) |w| if (w == frame[0]) {
            allowed = true;
        };
        if (!allowed) return imp.failFmt("wallet: call {s} is not allowed to programs", .{if (frame.len > 0) try std.fmt.allocPrint(st.a, "{d}", .{frame[0]}) else "undefined"});
        // Call permissions: the raw signer is the `signer` kernel service's, held by the program running now's app.
        if (signerProblem(st.a, st.rt.store, &st.progs.items[st.progs.items.len - 1]) catch return imp.failWith("store error")) |why| return imp.failWith(why);
        return signerCall(st, imp, frame);
    }

    /// The `emit` import (#65, #119; SPEC 5): an event — {event: "broadcast", tx: <cid>, beef?:
    /// bytes}, a fact {event: <a name under the emitting app's>, …fields}, or one of the host's
    /// membership declarations (subscribe, unsubscribe, beacon, unbeacon, liveness, unliveness) →
    /// the record's CID. Listed on the update and handed to the host once the step is committed;
    /// no signature, no signer call. A message to a key is out of this cut (SPEC 5): refused.
    fn hEmit(imp: *program.Imports, msg: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const m = cbor.decode(st.a, msg) catch return imp.failWith("emit: the message is not dag-cbor");
        if (m != .map) return imp.failWith("emit: want {event: \"broadcast\", tx: <cid>, beef?: bytes} or {event: <name>, …fields}");
        const ev = m.get("event") orelse {
            if (m.get("to") != null) return imp.failWith("emit: a message to a key is out of this cut (skein next: emit an event — a fact under the app's name — or call in-VM)");
            return imp.failWith("emit: want {event: \"broadcast\", tx: <cid>, beef?: bytes} or {event: <name>, …fields}");
        };
        return emitEvent(st, imp, m, ev);
    }

    fn emitEvent(st: *StepState, imp: *program.Imports, m: Value, ev: Value) program.Err![]const u8 {
        const a = st.a;
        const name = Value.str(ev) orelse return imp.failWith("emit: `event` is a name");
        if (!dispatch.isBox(name)) return imp.failFmt("emit: event {s}: a name is not empty and has no space or NUL", .{try json.quoted(a, name)});
        if (!std.mem.eql(u8, name, "broadcast")) return emitOther(st, imp, m, name);
        const tx = Value.cidOf(m.get("tx")) orelse return imp.failWith("emit: a broadcast names its transaction: {event: \"broadcast\", tx: <cid>, beef?: bytes}");
        if (cidm.codecOf(tx) != cidm.BITCOIN_TX or !(st.rt.store.has(tx) catch false)) return imp.failFmt("emit: {s} is not a transaction in the store (put it first)", .{fmtCid(a, tx)});
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("broadcast"));
        try rec.put("tx", cbor.cidv(tx));
        if (m.get("beef")) |b| if (b != .null) try rec.put("beef", .{ .bytes = Value.bytesOf(b) orelse return imp.failWith("emit: `beef` is bytes (an Atomic BEEF)") });
        return listEvent(st, imp, rec.value());
    }

    fn emitOther(st: *StepState, imp: *program.Imports, m: Value, name: []const u8) program.Err![]const u8 {
        const a = st.a;
        const app = try callingApp(st, imp);
        // 0.5.0: a fact (any name but an intention's) is a slash path under the emitting app's own
        // name — the event index's key (index.zig `events`), as a head is under its app's name.
        if (!logm.isIntention(name)) {
            if (!logm.isEventName(name)) return imp.failFmt("emit: event {s}: a name is a slash path of segments: no empty segment, no space or NUL", .{try json.quoted(a, name)});
            if (app == null or !logm.underApp(name, app.?)) return imp.failFmt("emit: event {s}: an app emits under its own name", .{try json.quoted(a, name)});
        }
        // The host's membership declarations: their shapes checked as they are emitted.
        if (std.mem.eql(u8, name, "subscribe") or std.mem.eql(u8, name, "unsubscribe")) {
            if (subsm.subscribeProblem(a, name, m, app) catch return error.OutOfMemory) |why| return imp.failWith(why);
        }
        if (std.mem.eql(u8, name, "beacon") or std.mem.eql(u8, name, "unbeacon")) {
            if (subsm.beaconProblem(a, name, m, app) catch return error.OutOfMemory) |why| return imp.failWith(why);
        }
        if (std.mem.eql(u8, name, "liveness") or std.mem.eql(u8, name, "unliveness")) {
            if (subsm.livenessProblem(a, name, m, app) catch return error.OutOfMemory) |why| return imp.failWith(why);
        }
        const rec = logm.eventRecord(a, m, name, app) catch |err| switch (err) {
            error.Reserved => return imp.failWith("emit: an event's `kind` and `app` are the kernel's to set"),
            error.OutOfMemory => return error.OutOfMemory,
        };
        return listEvent(st, imp, rec);
    }

    /// Put an event record and list it on the update (once per step).
    fn listEvent(st: *StepState, imp: *program.Imports, rec: Value) program.Err![]const u8 {
        const c = st.rt.store.put(st.a, rec) catch return imp.failWith("emit: the event is not IPLD, or a store error");
        if (st.emitted_at.contains(c)) return c;
        try appendEmitted(st, c);
        // 0.8.0: a fact (as index.zig writeEvents takes it) is seen by the step's own `events` reads.
        if (logm.indexedName(rec)) |name| {
            const k: u32 = @intCast(st.facts.items.len);
            try st.facts.append(.{ .name = name, .i = @intCast(st.emitted.items.len - 1), .record = c });
            const g = try st.fact_names.getOrPut(name);
            if (!g.found_existing) g.value_ptr.* = .empty;
            try g.value_ptr.append(st.a, k);
        }
        return c;
    }

    /// Append `c` to the step's `emitted`, its first index kept in `emitted_at`.
    fn appendEmitted(st: *StepState, c: []const u8) !void {
        const g = try st.emitted_at.getOrPut(c);
        if (!g.found_existing) g.value_ptr.* = @intCast(st.emitted.items.len);
        try st.emitted.append(c);
    }

    /// The edges into a record (#42): the index, plus the links of the bitcoin blocks this step kept so far.
    fn hEdges(imp: *program.Imports, to: []const u8, rel: ?[]const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        return program.edgesRead(st.a, st.rt.store, to, rel, st.kept.items) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("edges: {s}", .{@errorName(err)}),
        };
    }
    const OnCall = struct { op: onm.Op, name: []const u8, app: []const u8, role: []const u8 = "", func: []const u8 = "" };

    /// 0.5.2: the app of the program running now (the thread's, or an in-VM callee's) when its
    /// record is installed, else null.
    fn callingApp(st: *StepState, imp: *program.Imports) program.Err!?[]const u8 {
        const run_ = &st.progs.items[st.progs.items.len - 1];
        if (run_.install == null) run_.install = installedIn(st.a, st.rt.store, run_.cid, run_.record) catch return imp.failWith("store error");
        return if (run_.install.? == .none) null else Value.str(run_.record.get("app"));
    }

    /// 0.5.2: a fact's name a subscription may take: an event name (a slash path, no empty
    /// segment, no space or NUL), no intention's.
    fn onName(imp: *program.Imports, what: []const u8, name: []const u8) program.Err!void {
        if (logm.isIntention(name) or !logm.isEventName(name)) return imp.failFmt("{s}: {s} is not a fact's name (a slash path of segments: no empty segment, no space or NUL; no intention)", .{ what, try json.quoted(stepOf(imp).a, name) });
    }

    /// `on(name, fn)` (SPEC 5): the calling app registers `fn` of one of its programs on the facts
    /// named `name`; kept when the step ends without error (on.zig). Always a function: an empty
    /// one is refused (a thread that wants to resume on a name awaits it).
    fn hOn(imp: *program.Imports, name: []const u8, func: []const u8) program.Err!void {
        const st = stepOf(imp);
        const a = st.a;
        try onName(imp, "on", name);
        if (func.len == 0) return imp.failWith("on: name the function to run on each fact (`on(name, fn)`); to resume this thread on a fact, await its name");
        const app = (try callingApp(st, imp)) orelse return imp.failWith("on: the calling program is not installed (an app's program), so it has no subscriptions");
        const ps = subsm.programsOf(a, st.rt.store, app) catch return imp.failWith("store error");
        switch (onm.handlerOf(a, func, app, ps) catch return error.OutOfMemory) {
            .bad => |why| return imp.failWith(why),
            .ok => |h| try st.ons.append(.{ .op = .on, .name = try a.dupe(u8, name), .app = app, .role = h.role, .func = h.func }),
        }
    }

    /// 0.5.3: `off(name, fn)` — the calling app's one subscription of `fn` to `name` ends (the
    /// same two arguments as `on`), when the step ends without error (on.zig).
    fn hOff(imp: *program.Imports, name: []const u8, func: []const u8) program.Err!void {
        const st = stepOf(imp);
        const a = st.a;
        try onName(imp, "off", name);
        const app = (try callingApp(st, imp)) orelse return imp.failWith("off: the calling program is not installed (an app's program), so it has no subscriptions");
        const ps = subsm.programsOf(a, st.rt.store, app) catch return imp.failWith("store error");
        switch (onm.handlerOf(a, func, app, ps) catch return error.OutOfMemory) {
            .bad => |why| return imp.failWith(why),
            .ok => |h| try st.ons.append(.{ .op = .off, .name = try a.dupe(u8, name), .app = app, .role = h.role, .func = h.func }),
        }
    }

    /// 0.5.0: the event index read (program.zig eventsRead); 0.8.0: with the facts this step (and
    /// its in-VM callees, one `emitted`) emitted so far, at the places its update will give them.
    fn hEvents(imp: *program.Imports, query: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const pending: ?program.Pending = .{ .s = st.ord, .thread = st.origin, .facts = st.facts.items, .by_name = &st.fact_names };
        return eventsAnswer(imp, st.a, st.rt.store, query, pending);
    }

    fn eventsAnswer(imp: *program.Imports, a: std.mem.Allocator, store: Store, query: []const u8, pending: ?program.Pending) program.Err![]const u8 {
        const q = switch (program.eventsQueryOf(a, query) catch return error.OutOfMemory) {
            .ok => |x| x,
            .bad => |why| return imp.failWith(why),
        };
        return program.eventsReadWith(a, store, q, pending) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("events: {s}", .{@errorName(err)}),
        };
    }

    /// A signer call's answer, recorded (#67: the one call a step makes out mid-step): the
    /// witness's on replay (a differing request is a divergence), else the wallet's. The record:
    /// {kind: "oracle", thread, step, i, request, result}.
    fn signerCall(st: *StepState, imp: *program.Imports, frame: []const u8) program.Err![]const u8 {
        const rt = st.rt;
        const a = st.a;
        const i = st.calls.items.len;
        var result: []const u8 = undefined;
        const w: ?Value = if (rt.witness) |wi| (wi.find(a, st.origin, st.n, i) catch null) else null;
        if (w) |x| {
            if (!std.mem.eql(u8, Value.bytesOf(x.get("request")) orelse "", frame)) {
                return imp.fatalWith(.diverged, try std.fmt.allocPrint(a, "{s} step {d} call {d}: the request differs from the recorded one", .{ short(a, st.origin), st.n, i }));
            }
            result = Value.bytesOf(x.get("result")).?;
        } else if (rt.has_wallet) {
            // The router gone mid-call is the environment failing, not the step: nothing is
            // recorded, and the thread runs again at the next hydration (#33).
            result = rt.peers.wallet.?(rt.peers.ctx, a, frame) catch |err| return if (err == error.PeerGone)
                imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (signer): the router is gone", .{ short(a, st.origin), st.n, i }))
            else
                imp.failFmt("{s}", .{@errorName(err)});
        } else {
            return imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (signer): no wallet and no recorded answer", .{ short(a, st.origin), st.n, i }));
        }
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("oracle"));
        try rec.put("thread", cbor.cidv(st.origin));
        try rec.put("step", cbor.int(st.n));
        try rec.put("i", cbor.int(i));
        try rec.put("request", .{ .bytes = frame });
        try rec.put("result", .{ .bytes = result });
        try st.calls.append(rt.store.put(a, rec.value()) catch return imp.failWith("store error"));
        return result;
    }

    /// Whether `c` is a thread that has come to rest for good (finished or errored).
    fn threadAtRest(rt: *Runtime, a: std.mem.Allocator, c: []const u8) bool {
        const tip = (rt.tipOf(a, c) catch return false) orelse return false;
        return stateIs(tip, "finished") or stateIs(tip, "errored");
    }

    // ------------------------------------------------------------ calls (#40)

    /// An in-VM call from a step: the callee runs as part of the step — its recorded calls, kept
    /// records, launches and head moves are the step's, on the step's fuel and clock — with its own input.
    fn hCall(imp: *program.Imports, prog: []const u8, func: []const u8, arg: []const u8) program.Err![]const u8 {
        return stepCall(imp, prog, func, null, arg);
    }

    /// A named in-VM call from a step (call permissions): checked against the grants' `calls`
    /// before the callee runs; the callee's input carries the name as `as`.
    fn hCallAs(imp: *program.Imports, prog: []const u8, func: []const u8, name: []const u8, arg: []const u8) program.Err![]const u8 {
        return stepCall(imp, prog, func, name, arg);
    }

    fn stepCall(imp: *program.Imports, prog: []const u8, func: []const u8, name: ?[]const u8, arg: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const a = st.a;
        if (st.depth >= MAX_CALL_DEPTH) return imp.failWith("call: nested too deep");
        const loaded = try loadCallee(st.rt, st.rt.store, imp, a, prog);
        if (name) |n| if (namedCallProblem(a, st.rt.store, &st.progs.items[st.progs.items.len - 1], prog, loaded.record, n) catch return imp.failWith("store error")) |why| return imp.failWith(why);
        // #77: the callee's writes are the step's, in the callee's own write scope.
        try st.progs.append(.{ .record = loaded.record, .cid = prog });
        defer _ = st.progs.pop();
        var ctx = callContext(a, st.rt.store, st.rt.genesis, func, arg, st.origin, st.at) catch |err| return imp.failFmt("call: {s}", .{@errorName(err)});
        // Call permissions: the checked name, written by the kernel only (a nameless call has none).
        if (name) |n| try ctx.put("as", cbor.string(n));
        var extra = cbor.MapBuilder.init(a);
        try extra.put("thread", cbor.cidv(st.origin));
        try extra.put("step", cbor.int(st.n));
        try extra.put("entry", cbor.cidv(st.entry));
        try extra.put("at", cbor.int(st.at));
        try ctx.put("step", extra.value());
        const saved = st.input;
        st.input = cbor.encode(a, ctx.value()) catch return error.OutOfMemory;
        st.depth += 1;
        defer {
            st.input = saved;
            st.depth -= 1;
        }
        return runCallee(imp, a, st.rt, loaded, func, st.host.?, st.svc.?);
    }

    const Callee = struct { mod: *runner.Compiled, name: []const u8, record: Value };

    fn loadCallee(rt: *Runtime, store: Store, imp: *program.Imports, a: std.mem.Allocator, prog: []const u8) program.Err!Callee {
        const p = store.getOpt(a, prog);
        if (!programs.isProgram(p) or !hasWasm(p.?)) return imp.failFmt("call: {s} is not a wasm program record in the store", .{fmtCid(a, prog)});
        var msg: []const u8 = "";
        const mod = rt.runner.load(store, a, programs.wasmOf(p.?).?, &msg) catch |err| return switch (err) {
            error.NotInStore, error.BadHash, error.Compile => imp.failFmt("call: {s}", .{msg}),
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("call: {s}", .{@errorName(err)}),
        };
        return .{ .mod = mod, .name = Value.str(p.?.get("name")).?, .record = p.? };
    }

    fn runCallee(imp: *program.Imports, a: std.mem.Allocator, rt: *Runtime, c: Callee, func: []const u8, host: *const program.Host, svc: *wasi.Services) program.Err![]const u8 {
        const out = program.runProgramLimit(a, rt.runner, c.mod, c.name, host, svc, CALL_OUTPUT_LIMIT) catch |err| switch (err) {
            // Diverged, no witness, out of fuel: the callee's fatal is its caller's.
            error.Fatal => {
                imp.fatal = svc.state.fatal;
                return error.Fatal;
            },
            error.OutOfMemory => return error.OutOfMemory,
        };
        if (out.exit_code != 0) return imp.failFmt("call {s}.{s}: {s}", .{ c.name, func, lastLine(a, out.stderr, out.exit_code) });
        return out.stdout;
    }

    /// The input a called program reads (`kind: "call"`): what it is asked, by whom, and the
    /// instance it runs in — the genesis's facts and the route table as it stands.
    fn callContext(a: std.mem.Allocator, store: Store, genesis: ?Value, func: []const u8, arg: []const u8, caller: ?[]const u8, now: i64) !cbor.MapBuilder {
        const g = genesis orelse return error.NoGenesis;
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("call"));
        try m.put("fn", cbor.string(func));
        try m.put("arg", .{ .bytes = arg });
        if (caller) |c| try m.put("caller", .{ .bytes = c });
        try m.put("now", cbor.int(now));
        var self = cbor.MapBuilder.init(a);
        try self.put("handle", g.get("handle"));
        try self.put("domain", g.get("domain"));
        try self.put("identity", g.get("identity"));
        try m.put("self", self.value());
        try m.put("defaults", g.get("defaults"));
        try m.put("routes", try dispatch.valueOf(a, (try dispatch.current(a, store)) orelse &.{}));
        return m;
    }

    pub const CallResult = struct { ok: bool, result: []const u8 = "", err: []const u8 = "", fuel: u64 };

    /// The kernel's `call` (#40): run `prog`'s entry as a function over the current state and return
    /// what it wrote to stdout. No entry, no writes: `put` keeps records in memory for the call only;
    /// heads, the store and the log are read as they stand (plus the entries admitted and not yet
    /// processed, `pending`, and the committed state record, `state`). The signer (`wallet`) is
    /// answered by the host and not recorded, so a call is not deterministic and nothing replays
    /// it. Fuel is limited by `callFuelLimit` and reported.
    pub fn call(rt: *Runtime, a: std.mem.Allocator, prog: []const u8, func: []const u8, arg: []const u8, caller: ?[]const u8, now: i64) !CallResult {
        try rt.loadGenesis();
        return (try rt.callIn(a, rt.store, rt.genesis, prog, func, arg, caller, now, .{})).result;
    }

    /// The same call (#40) over `view`, a store other than the runtime's (#158: `skein-kernel host`
    /// runs a call on any worker against the state as committed).
    pub fn callOver(rt: *Runtime, a: std.mem.Allocator, view: Store, prog: []const u8, func: []const u8, arg: []const u8, caller: ?[]const u8, now: i64) !CallResult {
        const g: ?Value = if ((try view.logTip(a)) != null) logm.genesisOf(a, view) catch null else null;
        return (try rt.callIn(a, view, g, prog, func, arg, caller, now, .{})).result;
    }

    /// How a call runs: a plain call; a check's (`seed`: the arrival record's CID — the
    /// deterministic profile; `pending`: the blocks earlier checks named, visible to it); a read's.
    const CallMode = struct {
        seed: ?[]const u8 = null,
        pending: ?*const std.StringHashMap([]const u8) = null,
        read: bool = false,
    };

    /// A call (#40), a check's in the deterministic profile (CHECK, COMMIT's recheck), or a read
    /// row's. Its random is the one rule (syscalls.Entropy.seeded): the head is the log's tip as the
    /// call reads it; a check's input is the arrival record's CID and it runs in (program, fn); a
    /// call's input is (program, fn, arg, caller) and nothing else. The blocks it put come back.
    fn callIn(rt: *Runtime, a: std.mem.Allocator, store: Store, genesis: ?Value, prog: []const u8, func: []const u8, arg: []const u8, caller: ?[]const u8, now: i64, mode: CallMode) !struct { result: CallResult, puts: std.StringHashMap([]const u8) } {
        var cs = CallState{ .rt = rt, .store = store, .a = a, .overlay = std.StringHashMap([]const u8).init(a), .meter = undefined, .random = undefined, .genesis = genesis, .progs = .init(a) };
        if (genesis == null) return .{ .result = .{ .ok = false, .err = "call: no genesis", .fuel = 0 }, .puts = cs.overlay };
        if (mode.pending) |p| cs.visible = p;
        var meter = engine.Meter.init(callFuelLimit(genesis));
        cs.meter = &meter;
        const head: []const u8 = (try store.logTip(a)) orelse "";
        if (mode.seed) |rc| {
            cs.random = syscalls.Entropy.seeded(head, rc, try std.mem.concat(a, u8, &.{ prog, func }));
        } else {
            var in = cbor.MapBuilder.init(a);
            try in.put("program", cbor.cidv(prog));
            try in.put("fn", cbor.string(func));
            try in.put("arg", .{ .bytes = arg });
            try in.put("caller", if (caller) |c| Value{ .bytes = c } else .null);
            cs.random = syscalls.Entropy.seeded(head, try cbor.encode(a, in.value()), "");
        }
        cs.clock.drive(@as(i128, now) * 1_000_000);
        cs.clock.meter = &meter;
        var ctx = try callContext(a, store, genesis, func, arg, caller, now);
        if (mode.seed != null) {
            try ctx.put("check", .{ .bool = true });
        } else if (mode.read) {
            try ctx.put("read", .{ .bool = true });
        } else {
            var pend = std.array_list.Managed(Value).init(a);
            for (try store.logFrom(a, try store.cursorGet())) |c| try pend.append(cbor.cidv(c));
            try ctx.put("pending", .{ .array = pend.items });
        }
        try ctx.put("state", cbor.optCid(try store.state(a)));
        cs.input = try cbor.encode(a, ctx.value());
        var host = callHost;
        host.ctx = &cs;
        var rs = wasi.RunState{ .meter = &meter };
        var svc = wasi.Services{ .ctx = &cs, .state = &rs, .clock = csClock, .random = csRandom };
        cs.svc = &svc;
        cs.host = &host;
        var imp = program.Imports{ .host = &host, .alloc = a };
        const loaded = loadCallee(rt, store, &imp, a, prog) catch |err| switch (err) {
            error.Failed => return .{ .result = .{ .ok = false, .err = imp.last_error, .fuel = 0 }, .puts = cs.overlay },
            else => return err,
        };
        try cs.progs.append(.{ .record = loaded.record, .cid = prog });
        const out = program.runProgramLimit(a, rt.runner, loaded.mod, loaded.name, &host, &svc, CALL_OUTPUT_LIMIT) catch |err| switch (err) {
            error.Fatal => {
                const f = rs.fatal orelse wasi.Fatal{ .message = "fatal" };
                return .{ .result = .{ .ok = false, .err = if (f.kind == .fuel) runner.FUEL_EXHAUSTED else f.message, .fuel = meter.used() }, .puts = cs.overlay };
            },
            error.OutOfMemory => return error.OutOfMemory,
        };
        if (out.exit_code != 0) return .{ .result = .{ .ok = false, .err = lastLine(a, out.stderr, out.exit_code), .fuel = meter.used() }, .puts = cs.overlay };
        return .{ .result = .{ .ok = true, .result = out.stdout, .fuel = meter.used() }, .puts = cs.overlay };
    }

    /// A call's world: the records it put (in memory only), what it may read beside the store, its
    /// clock, its random, its fuel.
    const CallState = struct {
        rt: *Runtime,
        /// What the call reads: the runtime's store, or (#158) a view of it as committed.
        store: Store,
        a: std.mem.Allocator,
        overlay: std.StringHashMap([]const u8),
        /// A check's: the blocks earlier checks named, not written (readable, never returned as its own).
        visible: ?*const std.StringHashMap([]const u8) = null,
        meter: *engine.Meter,
        clock: syscalls.ThreadClock = .{},
        random: syscalls.Entropy,
        input: []const u8 = "",
        svc: ?*wasi.Services = null,
        host: ?*const program.Host = null,
        depth: u8 = 0,
        /// What the call reads as its genesis (the runtime's, or #158's view's).
        genesis: ?Value = null,
        /// The program running now (the call's, and under it each nested callee): who asks the signer
        /// and who makes a named call (call permissions).
        progs: std.array_list.Managed(Running),
    };

    const callHost = program.Host{
        .ctx = undefined,
        .input = cInput,
        .get = cGet,
        .put = cPut,
        .putBlock = cPutBlock,
        .keep = cKeep,
        .launch = cLaunch,
        .awaitOn = cAwait,
        .head = cHead,
        .advance = cAdvance,
        .wallet = cWallet,
        .emit = cEmit,
        .call = cCall,
        .callAs = cCallAs,
        .edges = cEdges,
        .events = cEvents,
        .on = cOn,
        .off = cOff,
    };

    fn callOf(imp: *program.Imports) *CallState {
        return @ptrCast(@alignCast(imp.host.ctx));
    }
    fn csClock(ctx: *anyopaque, _: u32) u64 {
        const cs: *CallState = @ptrCast(@alignCast(ctx));
        return @intCast(cs.clock.read());
    }
    fn csRandom(ctx: *anyopaque, out: []u8) void {
        const cs: *CallState = @ptrCast(@alignCast(ctx));
        cs.random.fill(out);
    }
    fn readOnly(imp: *program.Imports, what: []const u8) program.Err {
        return imp.failFmt("{s}: a call reads only (no entry, no writes)", .{what});
    }
    fn cInput(imp: *program.Imports) []const u8 {
        return callOf(imp).input;
    }
    fn cGet(imp: *program.Imports, c: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        if (cs.overlay.get(c)) |b| return b;
        if (cs.visible) |v| if (v.get(c)) |b| return b;
        return (cs.store.bytes(cs.a, c) catch return imp.failWith("store error")) orelse notFound(imp, c);
    }
    fn cPut(imp: *program.Imports, bytes: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        const v = cbor.decode(cs.a, bytes) catch return imp.failWith("CBOR decode error");
        const blk = cbor.block(cs.a, v) catch return imp.failWith("the value is not IPLD");
        try cs.overlay.put(blk.cid, blk.bytes);
        return blk.cid;
    }
    fn cPutBlock(imp: *program.Imports, c: []const u8, bytes: []const u8) program.Err!void {
        const cs = callOf(imp);
        if (!cidm.hashMatches(c, bytes)) return imp.failFmt("putblock: bytes do not hash to {s}", .{fmtCid(cs.a, c)});
        try cs.overlay.put(try cs.a.dupe(u8, c), try cs.a.dupe(u8, bytes));
    }
    fn cKeep(imp: *program.Imports, _: []const u8) program.Err!void {
        return readOnly(imp, "keep");
    }
    fn cLaunch(imp: *program.Imports, _: []const u8, _: []const u8) program.Err![]const u8 {
        return readOnly(imp, "launch");
    }
    fn cAwait(imp: *program.Imports, _: []const u8) program.Err!void {
        return readOnly(imp, "await");
    }
    fn cAdvance(imp: *program.Imports, _: []const u8, _: []const u8) program.Err!void {
        return readOnly(imp, "advance");
    }
    /// A kernel call sends nothing: only a step emits.
    fn cEmit(imp: *program.Imports, _: []const u8) program.Err![]const u8 {
        return imp.failWith("emit: a kernel call sends nothing (emit from a step)");
    }
    /// The edges into a record (#42), as the index holds them (a call keeps nothing).
    fn cEdges(imp: *program.Imports, to: []const u8, rel: ?[]const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        return program.edgesRead(cs.a, cs.store, to, rel, &.{}) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("edges: {s}", .{@errorName(err)}),
        };
    }
    fn cOn(imp: *program.Imports, _: []const u8, _: []const u8) program.Err!void {
        return readOnly(imp, "on");
    }
    fn cOff(imp: *program.Imports, _: []const u8, _: []const u8) program.Err!void {
        return readOnly(imp, "off");
    }
    fn cEvents(imp: *program.Imports, query: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        return eventsAnswer(imp, cs.a, cs.store, query, null);
    }
    fn cHead(imp: *program.Imports, name: []const u8) program.Err!?[]const u8 {
        const cs = callOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("head: bad name {s}", .{try json.quoted(cs.a, name)});
        return heads.headTree(cs.a, cs.store, name) catch imp.failWith("store error");
    }
    /// The signer, answered by the host and not recorded (a call is never replayed).
    fn cWallet(imp: *program.Imports, frame: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        var allowed = false;
        if (frame.len > 0) for (wallet_calls) |w| if (w == frame[0]) {
            allowed = true;
        };
        if (!allowed) return imp.failFmt("wallet: call {s} is not allowed to programs", .{if (frame.len > 0) try std.fmt.allocPrint(cs.a, "{d}", .{frame[0]}) else "undefined"});
        if (signerProblem(cs.a, cs.store, &cs.progs.items[cs.progs.items.len - 1]) catch return imp.failWith("store error")) |why| return imp.failWith(why);
        const f = cs.rt.peers.wallet orelse return imp.failWith("wallet: this host has no signer");
        return f(cs.rt.peers.ctx, cs.a, frame) catch |err| imp.failFmt("wallet: {s}", .{@errorName(err)});
    }
    /// A call within a call: the same world (records put, fuel, clock), its own fn and arg.
    fn cCall(imp: *program.Imports, prog: []const u8, func: []const u8, arg: []const u8) program.Err![]const u8 {
        return callCall(imp, prog, func, null, arg);
    }
    /// A named call within a call: checked as from a step (call permissions).
    fn cCallAs(imp: *program.Imports, prog: []const u8, func: []const u8, name: []const u8, arg: []const u8) program.Err![]const u8 {
        return callCall(imp, prog, func, name, arg);
    }
    fn callCall(imp: *program.Imports, prog: []const u8, func: []const u8, name: ?[]const u8, arg: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        const a = cs.a;
        if (cs.depth >= MAX_CALL_DEPTH) return imp.failWith("call: nested too deep");
        const loaded = try loadCallee(cs.rt, cs.store, imp, a, prog);
        if (name) |n| if (namedCallProblem(a, cs.store, &cs.progs.items[cs.progs.items.len - 1], prog, loaded.record, n) catch return imp.failWith("store error")) |why| return imp.failWith(why);
        const outer = cbor.decode(a, cs.input) catch return imp.failWith("call: bad input");
        var m = cbor.MapBuilder.init(a);
        for (outer.map) |e| {
            // `as` is the kernel's for this call alone: never inherited by a nested one.
            if (std.mem.eql(u8, e.key, "fn") or std.mem.eql(u8, e.key, "arg") or std.mem.eql(u8, e.key, "as")) continue;
            try m.put(e.key, e.value);
        }
        try m.put("fn", cbor.string(func));
        try m.put("arg", .{ .bytes = arg });
        if (name) |n| try m.put("as", cbor.string(n));
        try cs.progs.append(.{ .record = loaded.record, .cid = prog });
        defer _ = cs.progs.pop();
        const saved = cs.input;
        cs.input = cbor.encode(a, m.value()) catch return error.OutOfMemory;
        cs.depth += 1;
        defer {
            cs.input = saved;
            cs.depth -= 1;
        }
        return runCallee(imp, a, cs.rt, loaded, func, cs.host.?, cs.svc.?);
    }
};

/// The step's view of whether `c` is a thread: a record of kind "thread" in the store, or one this
/// step launched (its origin is written when the step ends).
fn isThreadIn(st: anytype, c: []const u8) bool {
    for (st.launched.items) |x| if (std.mem.eql(u8, x, c)) return true;
    const o = st.rt.store.getOpt(st.a, c) orelse return false;
    return std.mem.eql(u8, Value.str(o.get("kind")) orelse "", "thread");
}

fn hasJsSpace(s: []const u8) bool {
    var it = std.unicode.Utf8View.initUnchecked(s).iterator();
    while (it.nextCodepoint()) |c| if (heads.isJsSpace(c)) return true;
    return false;
}

/// Buffer.toString("utf8").trim().
fn jsTrim(a: std.mem.Allocator, b: []const u8) ![]const u8 {
    const s = try cbor.utf8Fix(a, b);
    var start: usize = 0;
    var end: usize = s.len;
    while (start < end) {
        const l = std.unicode.utf8ByteSequenceLength(s[start]) catch 1;
        const c = std.unicode.utf8Decode(s[start .. start + l]) catch break;
        if (!heads.isJsSpace(c)) break;
        start += l;
    }
    while (end > start) {
        var k = end - 1;
        while (k > start and (s[k] & 0xC0) == 0x80) k -= 1;
        const c = std.unicode.utf8Decode(s[k..end]) catch break;
        if (!heads.isJsSpace(c)) break;
        end = k;
    }
    return s[start..end];
}

/// The last line of a program's stderr, or "exit N": what a failed call reports.
fn lastLine(a: std.mem.Allocator, stderr: []const u8, code: i32) []const u8 {
    var t = jsTrim(a, stderr) catch "";
    if (std.mem.lastIndexOfScalar(u8, t, '\n')) |i| t = t[i + 1 ..];
    return if (t.len > 0) t else std.fmt.allocPrint(a, "exit {d}", .{code}) catch "failed";
}

/// A CHECK's outcome as the host frame's value: {refused: {status, code?, reason, principal?,
/// fuel}} | {ready: <the READY package>} | {read: {answer: {status, type?, headers?, body}, fuel,
/// principal?}}. An invalid arrival is the frame's error (null here).
pub fn checkOutValue(a: std.mem.Allocator, out: Runtime.CheckOut) !?Value {
    var m = cbor.MapBuilder.init(a);
    switch (out) {
        .invalid => return null,
        .refused => |r| try m.put("refused", try r.value(a)),
        .ready => |v| try m.put("ready", v),
        .read => |r| {
            var x = cbor.MapBuilder.init(a);
            try x.put("answer", try r.answer.value(a));
            try x.put("fuel", cbor.int(r.fuel));
            if (r.principal) |p| try x.put("principal", .{ .bytes = p });
            try m.put("read", x.value());
        },
    }
    return m.value();
}

/// A COMMIT's outcome as the host frame's value: {committed: {entry, state, thread?, answer?}} |
/// {refused: {status, code?, reason, principal?, fuel}}. An invalid READY is the frame's error.
pub fn commitOutValue(a: std.mem.Allocator, out: Runtime.CommitOut) !?Value {
    var m = cbor.MapBuilder.init(a);
    switch (out) {
        .invalid => return null,
        .refused => |r| try m.put("refused", try r.value(a)),
        .committed => |c| {
            var x = cbor.MapBuilder.init(a);
            try x.put("entry", cbor.cidv(c.entry));
            try x.put("state", cbor.string(c.state));
            if (c.thread) |t| try x.put("thread", cbor.cidv(t));
            if (c.answer) |ans| try x.put("answer", try ans.value(a));
            try m.put("committed", x.value());
        },
    }
    return m.value();
}

/// What the host is told when a request's thread comes to rest after its COMMIT returned (the
/// `answered` notice): {entry, thread, state, answer?}.
pub fn answeredValue(rt: *Runtime, a: std.mem.Allocator, thread: []const u8, entry: []const u8) !Value {
    const r = try rt.answerOf(a, thread);
    var m = cbor.MapBuilder.init(a);
    try m.put("entry", cbor.cidv(entry));
    try m.put("thread", cbor.cidv(thread));
    try m.put("state", cbor.string(r.state));
    if (r.answer) |ans| try m.put("answer", try ans.value(a));
    return m.value();
}
