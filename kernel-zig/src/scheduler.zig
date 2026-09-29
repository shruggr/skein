// The scheduler: the log consumer (first a line-by-line port of the TypeScript
// scheduler, deleted in #55; docs/VM.md is the design record). Entries come in finished
// and signed through `admit`; the runtime checks them and consumes them in
// order: genesis → the seed subscriptions; a message (`mail`, #40) → a reply
// to the thread awaiting the message it answers, else route by subscription
// and launch the handler; wake → a sleeping thread; event → the thread
// awaiting its subject, else a sender-less subscription on its box.
//
// A shell thread that sleeps is not parked mid-instance (there is no JSPI
// here). The run is abandoned at the sleep, having written its `waiting`
// update, and when the wake entry comes the thread is re-executed from its
// origin — verifying every update it recomputes against its chain — and
// carries on past the sleep under the wake entry. Same updates, same CIDs; a
// sleeping shell costs a re-execution per wake.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const json = @import("json.zig");
const secp = @import("secp.zig");
const logm = @import("log.zig");
const heads = @import("heads.zig");
const subs = @import("subscriptions.zig");
const programs = @import("programs.zig");
const syscalls = @import("syscalls.zig");
const shell = @import("shell.zig");
const program = @import("program.zig");
const runner = @import("runner.zig");
const wasi = @import("wasi.zig");
const engine = @import("engine.zig");
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

/// Fuel for a kernel `call` (#40) when the genesis's `defaults` do not set
/// `callFuelLimit`: 10^10 wasm instructions (a front door answers in far less).
pub const CALL_FUEL: u64 = 10_000_000_000;

/// The one limit on a call's fuel: the genesis's `defaults.callFuelLimit`, else CALL_FUEL.
pub fn callFuelLimit(g: ?Value) u64 {
    const d = (g orelse return CALL_FUEL).get("defaults") orelse return CALL_FUEL;
    const v = Value.str(d.get("callFuelLimit")) orelse return CALL_FUEL;
    const n = std.fmt.parseInt(u64, v, 10) catch return CALL_FUEL;
    return if (n == 0 or n > engine.UNMETERED) CALL_FUEL else n;
}

/// How deep in-VM calls may nest (a front door calling a handler calling another).
const MAX_CALL_DEPTH = 8;
/// A call's result (its stdout) may be this big: a listing, a page of the log.
const CALL_OUTPUT_LIMIT = 64 << 20;

/// BRC-100 wire call codes a program may make: key derivation and crypto only.
const wallet_calls = [_]u8{ 8, 11, 12, 13, 14, 15, 16 };

/// Answers to attested calls by (thread, step, i): what replay serves instead of a wallet.
pub const Witness = struct {
    arena: std.heap.ArenaAllocator,
    map: std.StringHashMap(Value),

    fn key(a: std.mem.Allocator, thread: []const u8, step: i128, i: i128) ![]u8 {
        return std.fmt.allocPrint(a, "{x} {d} {d}", .{ thread, step, i });
    }

    /// Every attested record the source's thread chains list (scheduler.ts witnessFrom).
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
                    if (!logm.isAttested(av)) continue;
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

/// The peers the runtime calls out to (all optional; replay has none but the witness).
pub const Peers = struct {
    ctx: *anyopaque,
    /// A BRC-100 wire frame to the instance wallet → its result frame.
    wallet: ?*const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8 = null,
    /// One HTTP request (dag-cbor {method, url, headers?, body?}) → the response
    /// (dag-cbor {status, headers, body}): a program's `http` import (#29, pre-#15).
    http: ?*const fn (ctx: *anyopaque, a: std.mem.Allocator, request: []const u8) anyerror![]u8 = null,
    /// One libp2p request (#51, dag-cbor {op, …}) → its result (dag-cbor), from
    /// `thread` (the host wakes it when a frame arrives for a pending `receive`).
    libp2p: ?*const fn (ctx: *anyopaque, a: std.mem.Allocator, request: []const u8, thread: []const u8) anyerror![]u8 = null,
    /// Why this host has no libp2p at all (the browser build): a request with
    /// no recorded answer fails with it, and nothing is recorded.
    libp2p_refusal: ?[]const u8 = null,
    /// A thread started sleeping (the tick's cue).
    on_sleep: ?*const fn (ctx: *anyopaque, thread: []const u8, until: i64) void = null,
    say: ?*const fn (ctx: *anyopaque, line: []const u8) void = null,
    /// The host's Io (native): a call's real randomness. The browser build has none.
    io: ?std.Io = null,
};

const Sleeper = struct { origin: []u8, deadline: i128 };

/// A log entry the processing of which drives a step or a shell.
const Ctx = struct { cid: []const u8, e: Value };

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

    /// Shell threads with a run in progress or parked on a sleep (TS `live`).
    live: std.StringHashMap(void),
    sleepers: std.array_list.Managed(Sleeper),
    stepping: std.StringHashMap(void),
    /// A field for the next program step's input (#29): `event` (a plain
    /// entry's record, to the thread awaiting its subject) or `woke` (the
    /// thread's deadline came). Set by process(), taken by stepBody.
    step_extra: ?cbor.Entry = null,

    pub fn init(gpa: std.mem.Allocator, s: Store, r: *runner.Runner, peers: Peers) !*Runtime {
        const rt = try gpa.create(Runtime);
        rt.* = .{
            .gpa = gpa,
            .store = s,
            .runner = r,
            .peers = peers,
            .life = std.heap.ArenaAllocator.init(gpa),
            .live = std.StringHashMap(void).init(gpa),
            .sleepers = std.array_list.Managed(Sleeper).init(gpa),
            .stepping = std.StringHashMap(void).init(gpa),
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
    fn shortStr(s: []const u8) []const u8 {
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

    /// Resume what the last process left mid-flight; the caller then kick()s (consumes the log).
    pub fn start(rt: *Runtime) !void {
        var arena = std.heap.ArenaAllocator.init(rt.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        try rt.loadGenesis();
        rt.cursor = try rt.store.cursorGet();
        if (rt.cursor > 0 and (try rt.store.chainTip(a, try subs.origin(a))) == null) return error.PredatesSubscriptions;
        rt.say("runtime {s} · log {d} processed{s}", .{ shortKey(rt.identity()), rt.cursor, if (rt.has_wallet) "" else " · no wallet (replay)" });
        rt.started = true;
        for (try rt.store.resting(a)) |t| rt.resume_(a, t) catch |err| rt.say("runtime: {s}", .{@errorName(err)});
        try rt.store.commit();
    }

    pub fn stop(rt: *Runtime) void {
        rt.stopped = true;
        rt.sleepers.clearRetainingCapacity();
        rt.live.clearRetainingCapacity();
    }

    /// Every sleeper and its deadline (ms, rounded up), earliest first.
    pub fn sleepersDue(rt: *Runtime, a: std.mem.Allocator) ![]struct { thread: []const u8, until: i64 } {
        const T = struct { thread: []const u8, until: i64 };
        const items = try a.dupe(Sleeper, rt.sleepers.items);
        std.mem.sort(Sleeper, items, {}, struct {
            fn lt(_: void, x: Sleeper, y: Sleeper) bool {
                return x.deadline < y.deadline;
            }
        }.lt);
        const out = try a.alloc(T, items.len);
        for (items, 0..) |s, i| out[i] = .{ .thread = s.origin, .until = @intCast(@divFloor(s.deadline + 999_999, 1_000_000)) };
        return @ptrCast(out);
    }

    /// The boxes the subscriptions route plus the genesis's `collect`.
    pub fn boxes(rt: *Runtime, a: std.mem.Allocator) ![]const []const u8 {
        try rt.loadGenesis();
        const seeded = (try rt.store.cursorGet()) > 0;
        var out = std.array_list.Managed([]const u8).init(a);
        const add = struct {
            fn f(o: *std.array_list.Managed([]const u8), b: []const u8) !void {
                for (o.items) |x| if (std.mem.eql(u8, x, b)) return;
                try o.append(b);
            }
        }.f;
        const current: ?[]subs.Sub = if (seeded) try subs.current(a, rt.store) else null;
        if (current) |rules| {
            for (rules) |s| if (s.box) |b| if (b.len > 0) try add(&out, b);
        } else if (rt.genesis) |g| {
            if (g.get("subscriptions")) |ss| for (ss.array) |s| {
                if (Value.str(s.get("match").?.get("box"))) |b| if (b.len > 0) try add(&out, b);
            };
        }
        if (rt.genesis) |g| if (g.get("collect")) |c| for (c.array) |b| try add(&out, b.string);
        return out.items;
    }

    // ------------------------------------------------------------ admission

    pub const AdmitResult = union(enum) {
        ok: []u8,
        rejected: struct { reason: Rejected, message: []const u8 },
        invalid: []const u8, // a TypeError / Error: the provider's bug
    };

    /// Admit a finished entry (Runtime.admit). A message entry names its
    /// record, which the host put first; `body` is the message body's bytes.
    pub fn admit(rt: *Runtime, a: std.mem.Allocator, entry: Value, body: ?[]const u8) !AdmitResult {
        if (try rt.check(a, entry, body)) |r| return r;
        const res = try rt.store.logAppend(a, entry);
        switch (res) {
            .ok => |c| return .{ .ok = c }, // the caller kick()s: the entry is processed after the host hears back
            .rejected => |r| return .{ .rejected = .{ .reason = r.reason, .message = r.message } },
        }
    }

    fn check(rt: *Runtime, a: std.mem.Allocator, entry: Value, body: ?[]const u8) !?AdmitResult {
        if (!logm.isLogEntry(entry) or entry.get("genesis") != null) return .{ .invalid = "admit: want a mail, wake or event entry (format 3, #40)" };
        try rt.loadGenesis();
        if (rt.genesis == null) return .{ .invalid = "admit: no genesis" };
        if (Value.cidOf(entry.get("event"))) |ev| {
            if (!(try rt.store.has(ev))) return .{ .invalid = "admit: a plain entry's event record must be in the store (put it first)" };
            return null;
        }
        const mc = Value.cidOf(entry.get("mail")) orelse return null;
        const rec = rt.store.getOpt(a, mc);
        if (!logm.isMail(rec)) return .{ .invalid = "admit: a message entry names its mail record, put first: {kind: \"mail\", op: \"put\", sender, recipient, box, body, json?, session?}" };
        const bc = Value.cidOf(rec.?.get("body")).?;
        if (body) |bb| {
            const bv = cbor.decode(a, bb) catch return .{ .invalid = "admit: the body is not dag-cbor" };
            const blk = try cbor.block(a, bv);
            if (!std.mem.eql(u8, blk.bytes, bb)) return .{ .invalid = "admit: the body is not canonical dag-cbor" };
            if (!std.mem.eql(u8, blk.cid, bc)) return .{ .invalid = "admit: the body is not the one the message names" };
            try rt.store.putBlock(blk.cid, bb);
        } else if (!(try rt.store.has(bc))) return .{ .invalid = "admit: a message entry needs its body" };
        return null;
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
        // What a resumed or woken thread derived outside an entry's processing.
        rt.store.commit() catch |err| rt.say("runtime: commit: {s}", .{@errorName(err)});
    }

    var last_error: []const u8 = "";
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
            last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d} {s}: not a format-2 log entry; stopping", .{ n, short(a, entry) });
            return error.BadSignature;
        }
        const time = logm.stampOf(e.get("time")).?;
        const at = time.ms();

        if (e.get("genesis") != null) {
            _ = try subs.open(a, rt.store);
            const ss = g.get("subscriptions").?.array;
            for (ss) |s| {
                const m = s.get("match").?;
                _ = try subs.subscribe(a, rt.store, .{ .op = "add", .sender = Value.bytesOf(m.get("sender")), .box = Value.str(m.get("box")), .handler = Value.cidOf(s.get("handler")).? }, .{ .thread = null, .input = entry, .at = at });
            }
            // A system tree (issue #4): the loader pre-filled its objects; `main` starts there.
            if (Value.cidOf(g.get("tree"))) |tree| {
                if (!(try rt.store.has(tree))) {
                    last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d}: the genesis tree {s} is not in the store", .{ n, fmtCid(a, tree) });
                    return error.NotFound;
                }
                _ = try heads.advanceHead(a, rt.store, "main", tree, .{ .thread = null, .input = entry, .at = at });
                rt.say("#{d} genesis: main → {s} (system tree)", .{ n, short(a, tree) });
            }
            rt.say("#{d} genesis: {s}@{s}, owner {s}, {d} subscriptions", .{ n, Value.str(g.get("handle")).?, Value.str(g.get("domain")).?, shortKey(Value.bytesOf(g.get("owner")).?), ss.len });
            return;
        }

        if (Value.cidOf(e.get("wake"))) |wk| {
            var idx: ?usize = null;
            for (rt.sleepers.items, 0..) |s, i| if (std.mem.eql(u8, s.origin, wk)) {
                idx = i;
            };
            // Early is fine for a thread resting on a libp2p stream (#51): the router wakes it when a frame arrives.
            if (idx == null or (rt.sleepers.items[idx.?].deadline > time.ns() and !rt.restsOnStream(a, wk))) {
                rt.say("#{d} wake {s}: not sleeping or not due; nothing runs", .{ n, short(a, wk) });
                return;
            }
            rt.say("#{d} wake → {s}", .{ n, short(a, wk) });
            const s = rt.sleepers.orderedRemove(idx.?);
            defer rt.gpa.free(s.origin);
            try rt.wakeSleeper(a, try a.dupe(u8, s.origin), .{ .cid = entry, .e = e });
            return;
        }

        if (Value.cidOf(e.get("event"))) |ev| return rt.processEvent(a, n, .{ .cid = entry, .e = e }, ev, at);

        if (Value.cidOf(e.get("mail"))) |mc| return rt.processMail(a, n, .{ .cid = entry, .e = e }, mc, at);
    }

    /// Whether a thread rests on a libp2p stream (#51): it is waiting, and the
    /// last call its last step recorded is a `libp2p` receive answered
    /// {pending}. A wake before its deadline steps such a thread (the router
    /// admits one when a frame arrives on the stream); any other early wake
    /// runs nothing. A function of the log: replay decides the same.
    fn restsOnStream(rt: *Runtime, a: std.mem.Allocator, origin: []const u8) bool {
        const tip = (rt.tipOf(a, origin) catch return false) orelse return false;
        if (!stateIs(tip, "waiting")) return false;
        const calls = tip.get("calls") orelse return false;
        if (calls != .array or calls.array.len == 0) return false;
        const last = Value.cidOf(calls.array[calls.array.len - 1]) orelse return false;
        const rec = rt.store.getOpt(a, last);
        if (!logm.isAttested(rec)) return false;
        if (!std.mem.eql(u8, Value.str(rec.?.get("op")) orelse "", "libp2p")) return false;
        const req = cbor.decode(a, Value.bytesOf(rec.?.get("request")) orelse return false) catch return false;
        if (!std.mem.eql(u8, Value.str(req.get("op")) orelse "", "receive")) return false;
        const res = cbor.decode(a, Value.bytesOf(rec.?.get("result")) orelse return false) catch return false;
        return res == .map and res.get("pending") != null;
    }

    /// A message (#40): a reply to a message this instance sent — the thread
    /// awaiting that record steps with it; else routed by subscription on
    /// (sender, box), and the handler launched with {message, body, box,
    /// sender}. A message for an identity this instance keeps mail for (its
    /// owner, in a mailbox instance) is never a reply here: it is routed.
    fn processMail(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, mc: []const u8, at: i64) !void {
        const m = rt.store.getOpt(a, mc) orelse return error.NotFound;
        const sender = Value.bytesOf(m.get("sender")).?;
        const recipient = Value.bytesOf(m.get("recipient")).?;
        const box = Value.str(m.get("box")).?;
        const body = Value.cidOf(m.get("body")).?;
        const what = try std.fmt.allocPrint(a, "#{d} message {s} in {s} from {s}", .{ n, short(a, mc), box, shortKey(sender) });
        if (std.mem.eql(u8, recipient, rt.identity())) {
            switch (rt.replyToOf(a, body)) {
                .none => {},
                .not_cid => {
                    rt.say("{s}: replyTo is not a CID; recorded, nothing runs", .{what});
                    return;
                },
                .cid => |reply_to| {
                    const t = try rt.awaiter(a, reply_to, sender);
                    if (t == null) {
                        rt.say("{s}: reply to {s}, which no thread awaits from this sender; recorded, nothing runs", .{ what, short(a, reply_to) });
                        return;
                    }
                    rt.say("{s}: reply to {s} → {s}", .{ what, short(a, reply_to), short(a, t.?) });
                    var r = cbor.MapBuilder.init(a);
                    try r.put("message", cbor.cidv(mc));
                    try r.put("body", cbor.cidv(body));
                    try r.put("box", cbor.string(box));
                    try r.put("sender", .{ .bytes = sender });
                    try r.put("replyTo", cbor.cidv(reply_to));
                    try rt.step(a, t.?, ctx, null, r.value());
                    return;
                },
            }
        }
        var sub: ?subs.Sub = null;
        for ((try subs.current(a, rt.store)) orelse &.{}) |s| if (subs.matches(s, sender, box)) {
            sub = s;
            break;
        };
        if (sub == null) {
            rt.say("{s}: no subscription; recorded, nothing runs", .{what});
            return;
        }
        var args = cbor.MapBuilder.init(a);
        try args.put("message", cbor.cidv(mc));
        try args.put("body", cbor.cidv(body));
        try args.put("box", cbor.string(box));
        try args.put("sender", .{ .bytes = sender });
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(sub.?.handler));
        try origin.put("args", args.value());
        try origin.put("launchedBy", cbor.cidv(mc));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(at));
        const t = try rt.store.chainOpen(a, origin.value());
        rt.say("{s} → {s} {s}", .{ what, try rt.programName(a, sub.?.handler), short(a, t) });
        try rt.run(a, t);
    }

    /// A plain entry (#29: a header, a proof, a transaction status the host
    /// admits from a feed): the thread whose tip awaits the event's `subject`
    /// (a CID; a transaction's is its txid) steps with it; else a
    /// subscription with no sender on the entry's box launches its handler.
    fn processEvent(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, ev: []const u8, at: i64) !void {
        const box = Value.str(ctx.e.get("box")).?;
        const rec = rt.store.getOpt(a, ev);
        const kind = if (rec) |r| Value.str(r.get("kind")) orelse "?" else "?";
        const what = try std.fmt.allocPrint(a, "#{d} {s} {s} in {s}", .{ n, kind, short(a, ev), box });
        var info = cbor.MapBuilder.init(a);
        try info.put("event", cbor.cidv(ev));
        try info.put("box", cbor.string(box));
        if (rec) |r| if (Value.cidOf(r.get("subject"))) |subj| {
            try info.put("subject", cbor.cidv(subj));
            for (try rt.store.awaiting(a, subj)) |t| {
                const tip = rt.tipOf(a, t) catch null orelse continue;
                if (!stateIs(tip, "waiting") or !cidIn(tip.get("awaits"), subj)) continue;
                rt.say("{s} → {s} (awaits {s})", .{ what, short(a, t), short(a, subj) });
                rt.step_extra = .{ .key = "event", .value = info.value() };
                try rt.step(a, t, ctx, null, null);
                return;
            }
        };
        var sub: ?subs.Sub = null;
        for ((try subs.current(a, rt.store)) orelse &.{}) |s| if (s.sender == null and (s.box == null or std.mem.eql(u8, s.box.?, box))) {
            sub = s;
            break;
        };
        if (sub == null) {
            rt.say("{s}: no subscription; recorded, nothing runs", .{what});
            return;
        }
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(sub.?.handler));
        try origin.put("args", info.value());
        try origin.put("launchedBy", cbor.cidv(ev));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(at));
        const t = try rt.store.chainOpen(a, origin.value());
        rt.say("{s} → {s} {s}", .{ what, try rt.programName(a, sub.?.handler), short(a, t) });
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

    const ReplyTo = union(enum) { none, not_cid, cid: []const u8 };

    fn replyToOf(rt: *Runtime, a: std.mem.Allocator, body: ?[]const u8) ReplyTo {
        const b = body orelse return .none;
        const bytes = (rt.store.bytes(a, b) catch return .none) orelse return .none;
        const v = cbor.decode(a, bytes) catch return .none;
        if (v != .map) return .none;
        const r = v.get("replyTo") orelse return .none;
        return if (r == .cid) .{ .cid = r.cid } else .not_cid;
    }

    /// The thread whose tip awaits the message `sent` (a record this instance
    /// holds: what it sent `from`) — the reply is `from` the one it was sent to.
    fn awaiter(rt: *Runtime, a: std.mem.Allocator, sent: []const u8, from: []const u8) !?[]const u8 {
        const rec = rt.store.getOpt(a, sent) orelse return null;
        if (!logm.isMail(rec) or !std.mem.eql(u8, Value.bytesOf(rec.get("recipient")).?, from)) return null;
        for (try rt.store.awaiting(a, sent)) |t| {
            const tip = rt.tipOf(a, t) catch null orelse continue;
            if (stateIs(tip, "waiting") and cidIn(tip.get("awaits"), sent)) return t;
        }
        return null;
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

    fn programName(rt: *Runtime, a: std.mem.Allocator, c: []const u8) ![]const u8 {
        const p = rt.store.getOpt(a, c);
        return if (programs.isProgram(p)) Value.str(p.?.get("name")).? else short(a, c);
    }

    fn hasWasm(p: Value) bool {
        const code = p.get("code") orelse return false;
        return code.get("wasm") != null;
    }

    /// Start a thread that has no updates yet, by its program's kind.
    fn run(rt: *Runtime, a: std.mem.Allocator, origin: []const u8) anyerror!void {
        const o = try rt.getOrNotFound(a, origin);
        const p: ?Value = rt.programOf(a, o) catch null;
        if (p != null and hasWasm(p.?)) {
            const input = Value.cidOf(o.get("input")).?;
            try rt.step(a, origin, .{ .cid = input, .e = try rt.getOrNotFound(a, input) }, null, null);
        } else try rt.runShellThread(a, origin, null);
    }

    fn resume_(rt: *Runtime, a: std.mem.Allocator, origin: []const u8) !void {
        const o = try rt.getOrNotFound(a, origin);
        const tip = try rt.tipOf(a, origin);
        if (tip != null and !stateIs(tip, "running") and !stateIs(tip, "waiting")) return;
        const p: ?Value = rt.programOf(a, o) catch null;
        if (p != null and hasWasm(p.?)) {
            if (tip == null) {
                rt.say("{s} {s}: stepping (interrupted before its first step ended)", .{ short(a, origin), Value.str(p.?.get("name")).? });
                try rt.run(a, origin);
            } else {
                if (stateIs(tip, "waiting")) if (Value.intOf(tip.?.get("until"))) |u| try rt.addSleeper(origin, @intCast(u));
                try rt.maybeStep(a, origin, tip.?);
            }
            return;
        }
        if (rt.live.contains(origin)) return;
        rt.say("{s} re-executing from its origin", .{short(a, origin)});
        try rt.runShellThread(a, origin, null);
    }

    /// A program thread waiting on launched threads: when all are at rest, step it with their resolution.
    fn maybeStep(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, tip: Value) anyerror!void {
        if (!stateIs(tip, "waiting")) return;
        const w = tip.get("waitingOn") orelse return;
        if (w != .array or w.array.len == 0) return;
        var resolved = std.array_list.Managed(Value).init(a);
        var driver: ?Ctx = null;
        var driver_n: i128 = -1;
        for (w.array) |x| {
            const wc = Value.cidOf(x) orelse return;
            const u = try rt.tipOf(a, wc);
            if (u == null or !(stateIs(u, "finished") or stateIs(u, "errored"))) return;
            var m = cbor.MapBuilder.init(a);
            try m.put("thread", cbor.cidv(wc));
            try m.put("state", u.?.get("state"));
            try m.put("result", u.?.get("result"));
            try m.put("error", u.?.get("error"));
            try resolved.append(m.value());
            const ic = Value.cidOf(u.?.get("input")) orelse return error.NotFound;
            const e = try rt.getOrNotFound(a, ic);
            const en = Value.intOf(e.get("n")) orelse 0;
            if (driver == null or en > driver_n) {
                driver = .{ .cid = ic, .e = e };
                driver_n = en;
            }
        }
        try rt.step(a, origin, driver.?, resolved.items, null);
    }

    /// A thread came to rest for good: step the program that launched it, if it now can.
    fn rested(rt: *Runtime, a: std.mem.Allocator, child: []const u8) anyerror!void {
        const o = try rt.getOrNotFound(a, child);
        const parent = Value.cidOf(o.get("launchedBy")) orelse return;
        const p = rt.store.getOpt(a, parent) orelse return;
        const kind = Value.str(p.get("kind")) orelse return;
        if (!std.mem.eql(u8, kind, "thread")) return;
        const tip = try rt.tipOf(a, parent);
        if (tip != null and stateIs(tip, "waiting") and cidIn(tip.?.get("waitingOn"), child)) try rt.maybeStep(a, parent, tip.?);
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
        awaits: std.array_list.Managed([]const u8),
        moves: std.array_list.Managed([2][]const u8),
        rules: std.array_list.Managed(subs.Rule),
        children: std.array_list.Managed(Value),
        /// The step's deadline (ms), if it set one (#29): a waiting step rests until it at most.
        until: ?i64 = null,
        /// For in-VM calls (#40): the step's host and services, and how deep the calls nest.
        host: ?*const program.Host = null,
        svc: ?*wasi.Services = null,
        depth: u8 = 0,
    };

    fn stepOf(imp: *program.Imports) *StepState {
        return @ptrCast(@alignCast(imp.host.ctx));
    }

    fn step(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, ctx: Ctx, resolved: ?[]const Value, reply: ?Value) anyerror!void {
        if (rt.stepping.contains(origin) or rt.stopped) {
            rt.step_extra = null;
            return;
        }
        rt.dropSleeper(origin); // a step supersedes the deadline it rested on
        const key = try rt.gpa.dupe(u8, origin);
        try rt.stepping.put(key, {});
        var after_launched: []const []const u8 = &.{};
        var after_rested = false;
        // The step's fuel: one budget for the whole step, read from the genesis at its start.
        var meter = engine.Meter.init(fuelPerStep(rt.genesis));
        // The attested calls the step made, kept even when it fails: an
        // errored update lists them, so a replay has their answers.
        var calls = std.array_list.Managed([]const u8).init(a);
        blk: {
            defer {
                _ = rt.stepping.remove(key);
                rt.gpa.free(key);
            }
            const r = rt.stepBody(a, origin, ctx, resolved, reply, &meter, &calls) catch |err| {
                const exhausted = err == error.FuelExhausted;
                const msg = if (exhausted) runner.FUEL_EXHAUSTED else if (err == error.Failed or err == error.Fatal) last_error else @errorName(err);
                const label = if (err == error.Diverged) "DIVERGED" else if (err == error.NoWitness) "cannot run" else "failed";
                rt.say("{s} step {s}: {s}", .{ short(a, origin), label, msg });
                if (err == error.Diverged or err == error.NoWitness) return;
                var m = cbor.MapBuilder.init(a);
                try m.put("state", cbor.string("errored"));
                try m.put("input", cbor.cidv(ctx.cid));
                try m.put("at", cbor.int(logm.stampOf(ctx.e.get("time")).?.ms()));
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
            after_rested = r.rested;
        }
        for (after_launched) |c| try rt.run(a, c);
        if (after_rested) try rt.rested(a, origin);
    }

    const After = struct { launched: []const []const u8, rested: bool };

    fn stepBody(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, ctx: Ctx, resolved: ?[]const Value, reply: ?Value, meter: *engine.Meter, calls: *std.array_list.Managed([]const u8)) anyerror!After {
        const o = try rt.getOrNotFound(a, origin);
        const prog = try rt.programOf(a, o);
        if (!hasWasm(prog)) return rt.failf(a, "not a wasm program", .{});
        const n: i64 = @intCast(1 + if (try rt.store.chainUpdates(a, origin)) |us| us.len else 0);
        const tip_cid = (try rt.store.chainTip(a, origin)).?;
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
        try input.put("owner", g.get("owner"));
        try input.put("args", o.get("args"));
        try input.put("programs", g.get("programs"));
        if (resolved) |rs| try input.put("resolved", .{ .array = rs });
        if (!std.mem.eql(u8, tip_cid, origin)) try input.put("tip", cbor.cidv(tip_cid));
        try input.put("reply", reply);
        try input.put("peers", g.get("peers"));
        try input.put("defaults", g.get("defaults"));
        try input.put("names", g.get("names"));
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
            .random = syscalls.Entropy.init(ctx.cid, origin),
            .calls = calls,
            .launched = .init(a),
            .kept = .init(a),
            .awaits = .init(a),
            .moves = .init(a),
            .rules = .init(a),
            .children = .init(a),
        };
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
            .awaitReply = hAwait,
            .head = hHead,
            .advance = hAdvance,
            .subscribe = hSubscribe,
            .wallet = hWallet,
            .http = hHttp,
            .libp2p = hLibp2p,
            .deadline = hDeadline,
            .call = hCall,
            .edges = hEdges,
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
        const state: []const u8 = if (out.exit_code != 0) "errored" else if (st.launched.items.len > 0 or st.awaits.items.len > 0 or st.until != null) "waiting" else "finished";
        const errored = std.mem.eql(u8, state, "errored");
        for (st.children.items) |c| _ = try rt.store.chainOpen(a, c);
        var head_updates = std.array_list.Managed([]const u8).init(a);
        var sub_updates = std.array_list.Managed([]const u8).init(a);
        if (!errored) for (st.moves.items) |m| try head_updates.append(try heads.advanceHead(a, rt.store, m[0], m[1], .{ .thread = origin, .input = ctx.cid, .at = at }));
        if (!errored) for (st.rules.items) |r| if (try subs.subscribe(a, rt.store, r, .{ .thread = origin, .input = ctx.cid, .at = at })) |c| try sub_updates.append(c);
        const waiting = std.mem.eql(u8, state, "waiting");

        var u = cbor.MapBuilder.init(a);
        try u.put("state", cbor.string(state));
        try u.put("step", cbor.int(n));
        try u.put("input", cbor.cidv(ctx.cid));
        try u.put("at", cbor.int(at));
        try u.put("fuel", cbor.int(meter.used()));
        if (waiting) try u.put("waitingOn", try cbor.cidArray(a, st.launched.items));
        if (waiting) try u.put("awaits", try cbor.cidArray(a, st.awaits.items));
        if (waiting) if (st.until) |t| try u.put("until", cbor.int(t));
        try u.put("calls", try cbor.cidArray(a, st.calls.items));
        try u.put("launched", try cbor.cidArray(a, st.launched.items));
        try u.put("kept", try cbor.cidArray(a, st.kept.items));
        try u.put("heads", try cbor.cidArray(a, head_updates.items));
        try u.put("subscriptions", try cbor.cidArray(a, sub_updates.items));
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
        _ = try rt.store.chainAppend(a, origin, u.value());
        if (waiting) if (st.until) |t| try rt.addSleeper(origin, t);

        // The log line.
        var line = std.array_list.Managed(u8).init(a);
        const w = &line;
        try w.print("{s} {s} step {d} → {s}", .{ short(a, origin), name, n, state });
        if (st.calls.items.len > 0) try w.print(" · {d} attested", .{st.calls.items.len});
        if (st.kept.items.len > 0) try w.print(" · {d} kept", .{st.kept.items.len});
        if (st.launched.items.len > 0) {
            try w.appendSlice(" · launched ");
            for (st.launched.items, 0..) |c, i| try w.print("{s}{s}", .{ if (i > 0) "," else "", short(a, c) });
        }
        if (head_updates.items.len > 0) {
            try w.appendSlice(" · moved ");
            for (st.moves.items, 0..) |m, i| try w.print("{s}{s}→{s}", .{ if (i > 0) "," else "", m[0], short(a, m[1]) });
        }
        if (sub_updates.items.len > 0) try w.print(" · {d} subscription change{s}", .{ sub_updates.items.len, if (sub_updates.items.len == 1) "" else "s" });
        if (st.awaits.items.len > 0) {
            try w.appendSlice(" · awaits ");
            for (st.awaits.items, 0..) |c, i| try w.print("{s}{s}", .{ if (i > 0) "," else "", short(a, c) });
        }
        // What the program wrote on stderr: the error, or a note of a step that
        // went on (e.g. the loop's undeliverable answer, #40) — once, here.
        if (errored) try w.print(" · {s}", .{stderr_text}) else if (stderr_text.len > 0) try w.print(" · stderr: {s}", .{stderr_text});
        rt.say("{s}", .{line.items});

        return .{ .launched = st.launched.items, .rested = !waiting };
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
    fn hLaunch(imp: *program.Imports, prog: []const u8, args: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const a = st.a;
        if (st.awaits.items.len > 0) return imp.failWith("launch: this step already awaits a reply; a step waits on threads or on replies, not both");
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
    fn hAwait(imp: *program.Imports, c: []const u8) program.Err!void {
        const st = stepOf(imp);
        if (!(st.rt.store.has(c) catch false)) return imp.failWith("await: not a record in the store (a message this step sent, or an event's subject)");
        if (st.launched.items.len > 0) return imp.failWith("await: this step launched threads; a step waits on threads or on replies, not both");
        for (st.awaits.items) |x| if (std.mem.eql(u8, x, c)) return;
        try st.awaits.append(c);
    }
    fn hHead(imp: *program.Imports, name: []const u8) program.Err!?[]const u8 {
        const st = stepOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("head: bad name {s}", .{try json.quoted(st.a, name)});
        // A step sees its own moves (#40: an in-VM call may advance a head its caller then reads).
        var i = st.moves.items.len;
        while (i > 0) : (i -= 1) if (std.mem.eql(u8, st.moves.items[i - 1][0], name)) return st.moves.items[i - 1][1];
        return heads.headTree(st.a, st.rt.store, name) catch imp.failWith("store error");
    }
    fn hAdvance(imp: *program.Imports, name: []const u8, t: []const u8) program.Err!void {
        const st = stepOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("advance: bad head name {s}", .{try json.quoted(st.a, name)});
        if (!(st.rt.store.has(t) catch false)) return imp.failFmt("advance: tree {s} is not in the store", .{fmtCid(st.a, t)});
        try st.moves.append(.{ name, t });
    }
    fn hSubscribe(imp: *program.Imports, op: []const u8, sender: ?[]const u8, box: []const u8, handler: []const u8) program.Err!void {
        const st = stepOf(imp);
        const a = st.a;
        if (try subs.ruleProblem(a, op, sender, box)) |bad| return imp.failFmt("subscribe: {s}", .{bad});
        const p = st.rt.store.getOpt(a, handler);
        if (!programs.isProgram(p)) return imp.failFmt("subscribe: handler {s} is not a program record in the store", .{fmtCid(a, handler)});
        if (programs.wasmOf(p.?)) |w| if (!(st.rt.store.has(w) catch false)) return imp.failFmt("subscribe: {s}'s module {s} is not in the store", .{ Value.str(p.?.get("name")).?, fmtCid(a, w) });
        try st.rules.append(.{ .op = op, .sender = sender, .box = box, .handler = handler });
    }
    fn hWallet(imp: *program.Imports, frame: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        var allowed = false;
        if (frame.len > 0) for (wallet_calls) |w| if (w == frame[0]) {
            allowed = true;
        };
        if (!allowed) return imp.failFmt("wallet: call {s} is not allowed to programs", .{if (frame.len > 0) try std.fmt.allocPrint(st.a, "{d}", .{frame[0]}) else "undefined"});
        return attest(st, imp, "wallet", .{ .bytes = frame }, .{ .wallet = frame });
    }

    fn hHttp(imp: *program.Imports, request: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const r = cbor.decode(st.a, request) catch return imp.failWith("http: the request is not dag-cbor");
        if (r != .map or Value.str(r.get("method")) == null or Value.str(r.get("url")) == null) return imp.failWith("http: want {method, url, headers?, body?}");
        return attest(st, imp, "http", .{ .bytes = request }, .{ .http = request });
    }
    /// The `libp2p` import (#51): recorded like `http` (request + result on the
    /// update; replay serves the recorded result, a differing request is a
    /// divergence). A result {error} is recorded too, and is the call's failure.
    fn hLibp2p(imp: *program.Imports, request: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        try checkLibp2p(imp, st.a, request);
        return libp2pAnswer(imp, st.a, try attest(st, imp, "libp2p", .{ .bytes = request }, .{ .libp2p = request }));
    }
    /// The edges into a record (#42): the index, plus the links of the bitcoin blocks this step kept so far.
    fn hEdges(imp: *program.Imports, to: []const u8, rel: ?[]const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        return program.edgesRead(st.a, st.rt.store, to, rel, st.kept.items) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("edges: {s}", .{@errorName(err)}),
        };
    }
    fn hDeadline(imp: *program.Imports, until: i64) program.Err!void {
        const st = stepOf(imp);
        if (until <= st.at) return imp.failWith("deadline: not after the step's time");
        st.until = if (st.until) |t| @min(t, until) else until;
    }

    /// A program thread resting until `until` (ms) is a sleeper: the tick's wake entry steps it.
    fn addSleeper(rt: *Runtime, origin: []const u8, until: i64) !void {
        for (rt.sleepers.items) |s| if (std.mem.eql(u8, s.origin, origin)) return;
        try rt.sleepers.append(.{ .origin = try rt.gpa.dupe(u8, origin), .deadline = @as(i128, until) * 1_000_000 });
        if (rt.peers.on_sleep) |f| f(rt.peers.ctx, origin, until);
    }
    fn dropSleeper(rt: *Runtime, origin: []const u8) void {
        for (rt.sleepers.items, 0..) |s, i| if (std.mem.eql(u8, s.origin, origin)) {
            rt.gpa.free(s.origin);
            _ = rt.sleepers.orderedRemove(i);
            return;
        };
    }

    const Perform = union(enum) { wallet: []const u8, http: []const u8, libp2p: []const u8 };

    const libp2p_ops = [_][]const u8{ "publish", "dial", "send", "receive", "close" };

    /// A libp2p request's shape: dag-cbor {op, …} with a known op.
    fn checkLibp2p(imp: *program.Imports, a: std.mem.Allocator, request: []const u8) program.Err!void {
        const r = cbor.decode(a, request) catch return imp.failWith("libp2p: the request is not dag-cbor");
        const op = (if (r == .map) Value.str(r.get("op")) else null) orelse return imp.failWith("libp2p: want {op: publish | dial | send | receive | close, …}");
        for (libp2p_ops) |o| if (std.mem.eql(u8, o, op)) return;
        return imp.failFmt("libp2p: unknown op {s}", .{try json.quoted(a, op)});
    }

    /// A libp2p result as the program gets it: {error} is the call's failure.
    fn libp2pAnswer(imp: *program.Imports, a: std.mem.Allocator, result: []const u8) program.Err![]const u8 {
        const v = cbor.decode(a, result) catch return imp.failWith("libp2p: the host's answer is not dag-cbor");
        if (v == .map) if (Value.str(v.get("error"))) |e| return imp.failFmt("libp2p: {s}", .{e});
        return result;
    }

    /// An attested call's answer, recorded: the witness's (replay), else the peer's.
    fn attest(st: *StepState, imp: *program.Imports, op: []const u8, request: Value, perform: Perform) program.Err![]const u8 {
        const rt = st.rt;
        const a = st.a;
        const i = st.calls.items.len;
        var result: []const u8 = undefined;
        const w: ?Value = if (rt.witness) |wi| (wi.find(a, st.origin, st.n, i) catch null) else null;
        if (w) |x| {
            const rop = Value.str(x.get("op")) orelse "";
            const rreq = cbor.encode(a, x.get("request") orelse .null) catch return error.OutOfMemory;
            const mine = cbor.encode(a, request) catch return error.OutOfMemory;
            if (!std.mem.eql(u8, rop, op) or !std.mem.eql(u8, rreq, mine)) {
                return imp.fatalWith(.diverged, try std.fmt.allocPrint(a, "{s} step {d} call {d}: the request differs from the recorded one", .{ short(a, st.origin), st.n, i }));
            }
            result = Value.bytesOf(x.get("result")).?;
        } else if (rt.has_wallet) {
            switch (perform) {
                // The router gone mid-call is the environment failing, not the step: nothing is
                // recorded, and the thread runs again at the next hydration (#33).
                .wallet => |f| result = rt.peers.wallet.?(rt.peers.ctx, a, f) catch |err| return if (err == error.PeerGone)
                    imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (wallet): the router is gone", .{ short(a, st.origin), st.n, i }))
                else
                    imp.failFmt("{s}", .{@errorName(err)}),
                .http => |q| {
                    const f = rt.peers.http orelse return imp.failWith("http: this host answers no http");
                    result = f(rt.peers.ctx, a, q) catch |err| return imp.failFmt("http: {s}", .{@errorName(err)});
                },
                .libp2p => |q| {
                    if (rt.peers.libp2p_refusal) |m| return imp.failWith(m);
                    const f = rt.peers.libp2p orelse return imp.failWith("libp2p: this host answers no libp2p");
                    result = f(rt.peers.ctx, a, q, st.origin) catch |err| return if (err == error.PeerGone)
                        imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (libp2p): the router is gone", .{ short(a, st.origin), st.n, i }))
                    else
                        imp.failFmt("libp2p: {s}", .{@errorName(err)});
                },
            }
        } else {
            return imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} ({s}): no wallet and no recorded answer", .{ short(a, st.origin), st.n, i, op }));
        }
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("attested"));
        try rec.put("thread", cbor.cidv(st.origin));
        try rec.put("step", cbor.int(st.n));
        try rec.put("i", cbor.int(i));
        try rec.put("op", cbor.string(op));
        try rec.put("request", request);
        try rec.put("result", .{ .bytes = result });
        try st.calls.append(rt.store.put(a, rec.value()) catch return imp.failWith("store error"));
        return result;
    }

    // ------------------------------------------------------------ calls (#40)

    /// An in-VM call from a step: the callee runs as part of the step — its
    /// recorded calls, kept records, launches and head moves are the step's,
    /// on the step's fuel and clock — with its own input.
    fn hCall(imp: *program.Imports, prog: []const u8, func: []const u8, arg: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const a = st.a;
        if (st.depth >= MAX_CALL_DEPTH) return imp.failWith("call: nested too deep");
        const loaded = try loadCallee(st.rt, imp, a, prog);
        var ctx = st.rt.callContext(a, func, arg, st.origin, st.at) catch |err| return imp.failFmt("call: {s}", .{@errorName(err)});
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

    const Callee = struct { mod: *runner.Compiled, name: []const u8 };

    fn loadCallee(rt: *Runtime, imp: *program.Imports, a: std.mem.Allocator, prog: []const u8) program.Err!Callee {
        const p = rt.store.getOpt(a, prog);
        if (!programs.isProgram(p) or !hasWasm(p.?)) return imp.failFmt("call: {s} is not a wasm program record in the store", .{fmtCid(a, prog)});
        var msg: []const u8 = "";
        const mod = rt.runner.load(rt.store, a, programs.wasmOf(p.?).?, &msg) catch |err| return switch (err) {
            error.NotInStore, error.BadHash, error.Compile => imp.failFmt("call: {s}", .{msg}),
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("call: {s}", .{@errorName(err)}),
        };
        return .{ .mod = mod, .name = Value.str(p.?.get("name")).? };
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

    /// The input a called program reads (`kind: "call"`): what it is asked,
    /// by whom, and the instance it runs in — the genesis's facts and the
    /// subscriptions as they stand.
    fn callContext(rt: *Runtime, a: std.mem.Allocator, func: []const u8, arg: []const u8, caller: ?[]const u8, now: i64) !cbor.MapBuilder {
        const g = rt.genesis orelse return error.NoGenesis;
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
        try m.put("owner", g.get("owner"));
        try m.put("programs", g.get("programs"));
        try m.put("peers", g.get("peers"));
        try m.put("defaults", g.get("defaults"));
        try m.put("names", g.get("names"));
        try m.put("routes", g.get("routes"));
        try m.put("reads", g.get("reads"));
        var rules = std.array_list.Managed(Value).init(a);
        for ((try subs.current(a, rt.store)) orelse &.{}) |r| {
            var x = cbor.MapBuilder.init(a);
            if (r.sender) |sd| try x.put("sender", .{ .bytes = sd });
            if (r.box) |b| try x.put("box", cbor.string(b));
            try x.put("handler", cbor.cidv(r.handler));
            try rules.append(x.value());
        }
        try m.put("subscriptions", .{ .array = rules.items });
        return m;
    }

    pub const CallResult = struct { ok: bool, result: []const u8 = "", err: []const u8 = "", fuel: u64 };

    /// The kernel's `call` (#40): run `prog`'s entry as a function over the
    /// current state and return what it wrote to stdout. No entry, no writes:
    /// `put` keeps records in memory for the call only; heads, the store and
    /// the log are read as they stand (plus the entries admitted and not yet
    /// processed, `pending`, and the committed state record, `state`). The
    /// oracle (`wallet`) and `http` are answered by the host and not recorded,
    /// so a call is not deterministic and nothing replays it. Fuel is limited
    /// by `callFuelLimit` and reported.
    pub fn call(rt: *Runtime, a: std.mem.Allocator, prog: []const u8, func: []const u8, arg: []const u8, caller: ?[]const u8, now: i64) !CallResult {
        try rt.loadGenesis();
        if (rt.genesis == null) return .{ .ok = false, .err = "call: no genesis", .fuel = 0 };
        var meter = engine.Meter.init(callFuelLimit(rt.genesis));
        var cs = CallState{ .rt = rt, .a = a, .overlay = std.StringHashMap([]const u8).init(a), .meter = &meter, .random = undefined };
        var seed: [32]u8 = undefined;
        realRandom(rt.peers.io, &seed, now);
        cs.random = syscalls.Entropy.init(&seed, prog);
        cs.clock.drive(@as(i128, now) * 1_000_000);
        cs.clock.meter = &meter;
        var ctx = try rt.callContext(a, func, arg, caller, now);
        var pend = std.array_list.Managed(Value).init(a);
        for (try rt.store.logFrom(a, rt.cursor)) |c| try pend.append(cbor.cidv(c));
        try ctx.put("pending", .{ .array = pend.items });
        try ctx.put("state", cbor.optCid(try rt.store.state(a)));
        cs.input = try cbor.encode(a, ctx.value());
        var host = callHost;
        host.ctx = &cs;
        var rs = wasi.RunState{ .meter = &meter };
        var svc = wasi.Services{ .ctx = &cs, .state = &rs, .clock = csClock, .random = csRandom };
        cs.svc = &svc;
        cs.host = &host;
        var imp = program.Imports{ .host = &host, .alloc = a };
        const loaded = loadCallee(rt, &imp, a, prog) catch |err| switch (err) {
            error.Failed => return .{ .ok = false, .err = imp.last_error, .fuel = 0 },
            else => return err,
        };
        const out = program.runProgramLimit(a, rt.runner, loaded.mod, loaded.name, &host, &svc, CALL_OUTPUT_LIMIT) catch |err| switch (err) {
            error.Fatal => {
                const f = rs.fatal orelse wasi.Fatal{ .message = "fatal" };
                return .{ .ok = false, .err = if (f.kind == .fuel) runner.FUEL_EXHAUSTED else f.message, .fuel = meter.used() };
            },
            error.OutOfMemory => return error.OutOfMemory,
        };
        if (out.exit_code != 0) return .{ .ok = false, .err = lastLine(a, out.stderr, out.exit_code), .fuel = meter.used() };
        return .{ .ok = true, .result = out.stdout, .fuel = meter.used() };
    }

    /// A call's world: the records it put (in memory only), its clock, its random, its fuel.
    const CallState = struct {
        rt: *Runtime,
        a: std.mem.Allocator,
        overlay: std.StringHashMap([]const u8),
        meter: *engine.Meter,
        clock: syscalls.ThreadClock = .{},
        random: syscalls.Entropy,
        input: []const u8 = "",
        svc: ?*wasi.Services = null,
        host: ?*const program.Host = null,
        depth: u8 = 0,
    };

    const callHost = program.Host{
        .ctx = undefined,
        .input = cInput,
        .get = cGet,
        .put = cPut,
        .putBlock = cPutBlock,
        .keep = cKeep,
        .launch = cLaunch,
        .awaitReply = cAwait,
        .head = cHead,
        .advance = cAdvance,
        .subscribe = cSubscribe,
        .wallet = cWallet,
        .http = cHttp,
        .libp2p = cLibp2p,
        .deadline = cDeadline,
        .call = cCall,
        .edges = cEdges,
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
        return (cs.rt.store.bytes(cs.a, c) catch return imp.failWith("store error")) orelse notFound(imp, c);
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
    fn cSubscribe(imp: *program.Imports, _: []const u8, _: ?[]const u8, _: []const u8, _: []const u8) program.Err!void {
        return readOnly(imp, "subscribe");
    }
    fn cDeadline(imp: *program.Imports, _: i64) program.Err!void {
        return readOnly(imp, "deadline");
    }
    /// The edges into a record (#42), as the index holds them (a call keeps nothing).
    fn cEdges(imp: *program.Imports, to: []const u8, rel: ?[]const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        return program.edgesRead(cs.a, cs.rt.store, to, rel, &.{}) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            else => imp.failFmt("edges: {s}", .{@errorName(err)}),
        };
    }
    fn cHead(imp: *program.Imports, name: []const u8) program.Err!?[]const u8 {
        const cs = callOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("head: bad name {s}", .{try json.quoted(cs.a, name)});
        return heads.headTree(cs.a, cs.rt.store, name) catch imp.failWith("store error");
    }
    /// The oracle, answered by the host and not recorded (a call is never replayed).
    fn cWallet(imp: *program.Imports, frame: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        var allowed = false;
        if (frame.len > 0) for (wallet_calls) |w| if (w == frame[0]) {
            allowed = true;
        };
        if (!allowed) return imp.failFmt("wallet: call {s} is not allowed to programs", .{if (frame.len > 0) try std.fmt.allocPrint(cs.a, "{d}", .{frame[0]}) else "undefined"});
        const f = cs.rt.peers.wallet orelse return imp.failWith("wallet: this host has no oracle");
        return f(cs.rt.peers.ctx, cs.a, frame) catch |err| imp.failFmt("wallet: {s}", .{@errorName(err)});
    }
    /// HTTP, answered by the host and not recorded.
    fn cHttp(imp: *program.Imports, request: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        const r = cbor.decode(cs.a, request) catch return imp.failWith("http: the request is not dag-cbor");
        if (r != .map or Value.str(r.get("method")) == null or Value.str(r.get("url")) == null) return imp.failWith("http: want {method, url, headers?, body?}");
        const f = cs.rt.peers.http orelse return imp.failWith("http: this host answers no http");
        return f(cs.rt.peers.ctx, cs.a, request) catch |err| imp.failFmt("http: {s}", .{@errorName(err)});
    }
    /// libp2p (#51) is a step's: a kernel call sends nothing (a stream a thread
    /// dials, a message it publishes, is recorded on its update).
    fn cLibp2p(imp: *program.Imports, _: []const u8) program.Err![]const u8 {
        return imp.failWith("libp2p: a kernel call sends nothing (publish, dial, send from a step)");
    }
    /// A call within a call: the same world (records put, fuel, clock), its own fn and arg.
    fn cCall(imp: *program.Imports, prog: []const u8, func: []const u8, arg: []const u8) program.Err![]const u8 {
        const cs = callOf(imp);
        const a = cs.a;
        if (cs.depth >= MAX_CALL_DEPTH) return imp.failWith("call: nested too deep");
        const loaded = try loadCallee(cs.rt, imp, a, prog);
        const outer = cbor.decode(a, cs.input) catch return imp.failWith("call: bad input");
        var m = cbor.MapBuilder.init(a);
        for (outer.map) |e| {
            if (std.mem.eql(u8, e.key, "fn") or std.mem.eql(u8, e.key, "arg")) continue;
            try m.put(e.key, e.value);
        }
        try m.put("fn", cbor.string(func));
        try m.put("arg", .{ .bytes = arg });
        const saved = cs.input;
        cs.input = cbor.encode(a, m.value()) catch return error.OutOfMemory;
        cs.depth += 1;
        defer {
            cs.input = saved;
            cs.depth -= 1;
        }
        return runCallee(imp, a, cs.rt, loaded, func, cs.host.?, cs.svc.?);
    }

    // ------------------------------------------------------------ the shell

    const ShellRun = struct {
        rt: *Runtime,
        a: std.mem.Allocator,
        origin: []const u8,
        o: Value,
        history: []const []const u8,
        pos: usize = 0,
        ctx_input: []const u8 = "",
        ctx_at: i64 = 0,
        state: []const u8 = "new",
        clock: syscalls.ThreadClock = .{},
        random: syscalls.Entropy = undefined,
        /// Re-executing because of this wake entry: the sleep it reaches is woken by it.
        wake: ?Ctx = null,
        diverged: ?[]const u8 = null,
        /// The fuel of the whole run (every instance of the shell and its
        /// children); a segment per step: from a `running` update to the
        /// `waiting`/`finished`/`errored` that ends it (issue #5).
        meter: engine.Meter,

        fn drive(t: *ShellRun, c: Ctx) void {
            const s = logm.stampOf(c.e.get("time")).?;
            t.ctx_input = c.cid;
            t.ctx_at = s.ms();
            t.clock.drive(s.ns());
            t.random = syscalls.Entropy.init(c.cid, t.origin);
        }
    };

    /// Start (or re-execute) a shell thread and run it until it rests or ends.
    fn runShellThread(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, wake: ?Ctx) anyerror!void {
        if (wake == null and rt.live.contains(origin)) return;
        const o = try rt.getOrNotFound(a, origin);
        const history = (try rt.store.chainUpdates(a, origin)) orelse &.{};
        const ic = Value.cidOf(o.get("input")) orelse return error.NotFound;
        const launch = try rt.getOrNotFound(a, ic);
        if (!logm.isLogEntry(launch)) return rt.failf(a, "thread {s}: input is not a log entry", .{short(a, origin)});
        var t = ShellRun{ .rt = rt, .a = a, .origin = origin, .o = o, .history = history, .wake = wake, .meter = engine.Meter.init(fuelPerStep(rt.genesis)) };
        t.clock.meter = &t.meter; // one clock for the shell and its children, on their fuel (issue #38)
        t.drive(.{ .cid = ic, .e = launch });
        if (!rt.live.contains(origin)) try rt.live.put(try rt.gpa.dupe(u8, origin), {});
        try rt.shellBody(&t);
    }

    fn wakeSleeper(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, c: Ctx) !void {
        const p: ?Value = rt.programOf(a, try rt.getOrNotFound(a, origin)) catch null;
        if (p != null and hasWasm(p.?)) {
            rt.step_extra = .{ .key = "woke", .value = .{ .bool = true } };
            return rt.step(a, origin, c, null, null);
        }
        try rt.runShellThread(a, origin, c);
    }

    fn shellBody(rt: *Runtime, t: *ShellRun) anyerror!void {
        const a = t.a;
        var ended = false;
        var parked = false;
        body: {
            rt.appendShell(t, "running", null) catch |err| {
                if (err == error.Diverged) {
                    rt.say("{s} DIVERGED: {s}", .{ short(a, t.origin), t.diverged.? });
                    break :body;
                }
                return err;
            };
            const args = t.o.get("args");
            if (!isShellArgs(args)) {
                var em = cbor.MapBuilder.init(a);
                try em.put("kind", cbor.string("cant-do"));
                try em.put("message", cbor.string("shell wants {cmd, tree, cwd?, env?}"));
                try rt.appendShellError(t, em.value(), &ended);
                break :body;
            }
            var msg: []const u8 = "";
            const mods = shell.loadModules(rt.runner, rt.store, rt.life.allocator(), &msg) catch |err| {
                try rt.shellErrored(t, if (msg.len > 0) msg else @errorName(err), &ended);
                break :body;
            };
            var env = std.array_list.Managed([2][]const u8).init(a);
            if (args.?.get("env")) |e| for (e.map) |kv| try env.append(.{ kv.key, kv.value.string });
            var st = wasi.RunState{ .meter = &t.meter };
            var cwd_msg: []const u8 = "";
            const r = shell.runShell(a, rt.runner, rt.store, mods, .{
                .tree = Value.cidOf(args.?.get("tree")).?,
                .cmd = Value.str(args.?.get("cmd")).?,
                .cwd = Value.str(args.?.get("cwd")),
                .env = env.items,
                .thread = .{ .ctx = t, .clock = shClock, .random = shRandom, .sleep = shSleep },
            }, &st, &cwd_msg) catch |err| switch (err) {
                error.Park => {
                    parked = true;
                    break :body;
                },
                error.CwdNotDir => {
                    try rt.shellErrored(t, cwd_msg, &ended);
                    break :body;
                },
                error.Fatal => {
                    if (t.diverged) |d| {
                        rt.say("{s} DIVERGED: {s}", .{ short(a, t.origin), d });
                        break :body;
                    }
                    if (st.fatal) |f| if (f.kind == .fuel) {
                        var em = cbor.MapBuilder.init(a);
                        try em.put("kind", cbor.string("cant-do"));
                        try em.put("message", cbor.string(runner.FUEL_EXHAUSTED));
                        try rt.appendShellError(t, em.value(), &ended);
                        break :body;
                    };
                    try rt.shellErrored(t, if (st.fatal) |f| f.message else "fatal", &ended);
                    break :body;
                },
                else => return err,
            };
            var res = cbor.MapBuilder.init(a);
            try res.put("exitCode", cbor.int(r.exit_code));
            try res.put("stdout", .{ .bytes = r.stdout });
            try res.put("stderr", .{ .bytes = r.stderr });
            try res.put("tree", cbor.cidv(r.tree));
            rt.appendShell(t, "finished", res.value()) catch |err| {
                if (err == error.Diverged) {
                    rt.say("{s} DIVERGED: {s}", .{ short(a, t.origin), t.diverged.? });
                    break :body;
                }
                return err;
            };
            ended = true;
        }
        if (parked) return; // resting on a deadline: stays live, a sleeper
        if (rt.live.fetchRemove(t.origin)) |kv| rt.gpa.free(kv.key);
        if (ended and !rt.stopped) rt.rested(a, t.origin) catch |err| rt.say("{s}: {s}", .{ short(a, t.origin), @errorName(err) });
    }

    fn shellErrored(rt: *Runtime, t: *ShellRun, message: []const u8, ended: *bool) !void {
        var em = cbor.MapBuilder.init(t.a);
        try em.put("kind", cbor.string("blew-up"));
        try em.put("message", cbor.string(message));
        try rt.appendShellError(t, em.value(), ended);
    }

    fn appendShellError(rt: *Runtime, t: *ShellRun, err_value: Value, ended: *bool) !void {
        rt.appendShellFull(t, "errored", null, err_value, null) catch |err| {
            if (err == error.Diverged) {
                rt.say("{s}: {s}", .{ short(t.a, t.origin), t.diverged.? });
                return;
            }
            return err;
        };
        ended.* = true;
    }

    fn appendShell(rt: *Runtime, t: *ShellRun, state: []const u8, result: ?Value) !void {
        return rt.appendShellFull(t, state, result, null, null);
    }

    /// Append the thread's next update, or verify it against the chain when re-executing.
    fn appendShellFull(rt: *Runtime, t: *ShellRun, state: []const u8, result: ?Value, err_value: ?Value, until: ?i64) !void {
        const a = t.a;
        var m = cbor.MapBuilder.init(a);
        try m.put("state", cbor.string(state));
        // A step ends at waiting/finished/errored: its fuel; `running` starts the next one.
        if (std.mem.eql(u8, state, "running")) t.meter.segment() else try m.put("fuel", cbor.int(t.meter.used()));
        if (until) |u| try m.put("until", cbor.int(u));
        try m.put("result", result);
        try m.put("error", err_value);
        try m.put("input", cbor.cidv(t.ctx_input));
        try m.put("at", cbor.int(t.ctx_at));
        const from = t.state;
        t.state = state;
        if (t.pos < t.history.len) {
            const existing = t.history[t.pos];
            const prev = if (t.pos == 0) t.origin else t.history[t.pos - 1];
            var full = cbor.MapBuilder.init(a);
            for (m.list.items) |e| try full.put(e.key, e.value);
            try full.put("origin", cbor.cidv(t.origin));
            try full.put("prev", cbor.cidv(prev));
            try full.put("seq", cbor.int(t.pos + 1));
            const want = try cbor.cidOfValue(a, full.value());
            if (!std.mem.eql(u8, want, existing)) {
                t.diverged = try std.fmt.allocPrint(a, "update {d} of {s} recomputes to {s}, chain has {s}", .{ t.pos + 1, short(a, t.origin), short(a, want), short(a, existing) });
                return error.Diverged;
            }
            t.pos += 1;
            return;
        }
        const c = try rt.store.chainAppend(a, t.origin, m.value());
        const hist = try a.alloc([]const u8, t.history.len + 1);
        @memcpy(hist[0..t.history.len], t.history);
        hist[t.history.len] = c;
        t.history = hist;
        t.pos += 1;
        var line = std.array_list.Managed(u8).init(a);
        const w = &line;
        try w.print("{s} shell {s} → {s}", .{ short(a, t.origin), from, state });
        var bits = std.array_list.Managed([]const u8).init(a);
        if (until) |u| try bits.append(try std.fmt.allocPrint(a, "until {d}", .{u}));
        if (result) |r| try bits.append(try std.fmt.allocPrint(a, "exit {d}", .{Value.intOf(r.get("exitCode")) orelse 0}));
        if (err_value) |e| try bits.append(try std.fmt.allocPrint(a, "{s}: {s}", .{ Value.str(e.get("kind")).?, Value.str(e.get("message")).? }));
        if (bits.items.len > 0) {
            try w.appendSlice(" (");
            for (bits.items, 0..) |b, i| try w.print("{s}{s}", .{ if (i > 0) ", " else "", b });
            try w.appendSlice(")");
        }
        rt.say("{s}", .{line.items});
    }

    fn shClock(ctx: *anyopaque, _: u32) u64 {
        const t: *ShellRun = @ptrCast(@alignCast(ctx));
        return @intCast(t.clock.read());
    }
    fn shRandom(ctx: *anyopaque, out: []u8) void {
        const t: *ShellRun = @ptrCast(@alignCast(ctx));
        t.random.fill(out);
    }

    /// A sleep: at once if not after "now"; else rest `waiting` until it (scheduler.ts sleep).
    fn shSleep(ctx: *anyopaque, clocks: []const wasi.Clock) wasi.Stop!void {
        const t: *ShellRun = @ptrCast(@alignCast(ctx));
        const rt = t.rt;
        const now = t.clock.peek();
        var deadline: ?i128 = null;
        for (clocks) |c| {
            const d: i128 = if (c.absolute) c.timeout else now + c.timeout;
            if (deadline == null or d < deadline.?) deadline = d;
        }
        if (deadline == null or deadline.? <= now) return;
        const until: i64 = @intCast(@divFloor(deadline.? + 999_999, 1_000_000));
        rt.appendShellFull(t, "waiting", null, null, until) catch |err| return shStop(t, err);
        // Re-executing: the chain may already record the wake.
        if (t.pos < t.history.len) {
            const u = (rt.store.get(t.a, t.history[t.pos]) catch null) orelse return shStop(t, error.NotFound);
            const ic = Value.cidOf(u.get("input")).?;
            const e = (rt.store.get(t.a, ic) catch null) orelse return shStop(t, error.NotFound);
            t.drive(.{ .cid = ic, .e = e });
            rt.appendShell(t, "running", null) catch |err| return shStop(t, err);
            return;
        }
        if (t.wake) |w| {
            // This run is the wake entry's: carry on past the sleep under it.
            t.wake = null;
            t.drive(w);
            rt.appendShell(t, "running", null) catch |err| return shStop(t, err);
            return;
        }
        rt.sleepers.append(.{ .origin = rt.gpa.dupe(u8, t.origin) catch return error.OutOfMemory, .deadline = deadline.? }) catch return error.OutOfMemory;
        if (rt.peers.on_sleep) |f| f(rt.peers.ctx, t.origin, until);
        return error.Park;
    }

    fn shStop(t: *ShellRun, err: anyerror) wasi.Stop {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        if (err == error.Diverged) return error.Fatal; // t.diverged holds the message
        t.diverged = null;
        return error.Fatal;
    }
};

fn isShellArgs(x: ?Value) bool {
    const a = x orelse return false;
    if (a != .map) return false;
    if (Value.str(a.get("cmd")) == null or Value.cidOf(a.get("tree")) == null) return false;
    if (a.get("cwd")) |c| if (c != .string) return false;
    if (a.get("env")) |e| {
        if (e != .map) return false;
        for (e.map) |kv| if (kv.value != .string) return false;
    }
    return true;
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

/// Real randomness for a call's stream: a call needs no determinism, and a
/// nonce it makes (a front door's session nonce) must not be guessable.
fn realRandom(io: ?std.Io, out: []u8, now: i64) void {
    if (engine.web) {
        // The browser build runs no front door; the call's time and a counter will do there.
        const S = struct {
            var n: u32 = 0;
        };
        S.n +%= 1;
        var sm = syscalls.SplitMix{ .s = @as(u32, @truncate(@as(u64, @bitCast(now)))) ^ (S.n *% 0x9e3779b9) };
        sm.fill(out);
    } else (io orelse @panic("realRandom: no Io")).random(out);
}
