// The scheduler: the log consumer (first a line-by-line port of the TypeScript
// scheduler, deleted in #55; docs/VM.md is the design record). Entries come in finished
// and signed through `admit`; the runtime checks them and consumes them in
// order: genesis → the seed of the dispatch table (#77); a request (#68) → the transport's
// middleware launched on it as the request's thread (what its steps admit
// routed as the entries below); a message (`mail`, #40) → a reply
// to the thread awaiting the message it answers, else its dispatch row
// (dispatch.zig forMail): a kernel row is one of the kernel's own admin
// operations (kernelOp: objects, head, dispatch, peers — no program runs),
// any other launches the row's program; event → the thread awaiting its
// subject, else a sender-less row on its box.
//
// The kernel's four tables (#77): objects (the store), heads (with an owner,
// heads.zig), the dispatch table (dispatch.zig) and the address book
// (addressbook.zig). No program import reaches a table: a step advances a
// head only in its write scope (hAdvance — an app's `<app>/…`, a
// genesis-wired program's genesis `scopes`; read from the record only when
// the owner installed it, installedAs), and everything else is an
// admin message from the owner or a delegate, taken by the kernel itself.
//
// Outbound there is one primitive, `emit` (#70, #67): a step signs a message
// to a recipient its address book names (addressbook.zig), the update lists
// it (`emitted`), and when the step has ended without error the message goes
// out by the recipient's transport — a `local` provider or the host's libp2p
// node (handed to the host, Peers.emit, once the state is committed), or a
// `mailbox` over BRC-103/104, which the instance does itself: the mailbox
// transport's middleware (the messagebox program) is launched as the
// message's delivery thread. A key the address book does not name goes to
// that middleware too (#87): it reads the resolve program's record of it. The answer comes back as an entry that steps
// the thread awaiting it; nothing outside is asked mid-step but the signer.
//
// A shell thread that sleeps is not parked mid-instance (there is no JSPI
// here). The run is abandoned at the sleep, having written its `waiting`
// update, and when the wake entry comes the thread is re-executed from its
// origin — verifying every update it recomputes against its chain — and
// carries on past the sleep under the wake entry. Same updates, same CIDs; a
// sleeping shell costs a re-execution per wake.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const json = @import("json.zig");
const secp = @import("secp");
const logm = @import("log.zig");
const addressbook = @import("addressbook.zig");
const signer = @import("signer.zig");
const heads = @import("heads.zig");
const dispatch = @import("dispatch.zig");
const programs = @import("programs.zig");
const syscalls = @import("syscalls.zig");
const shell = @import("shell.zig");
const program = @import("program.zig");
const runner = @import("runner.zig");
const wasi = @import("wasi.zig");
const engine = @import("engine.zig");
const doorm = @import("door.zig");
const subsm = @import("subscriptions.zig");
const authfetch = @import("authfetch.zig");
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

/// Fuel for a kernel `call` (#40), and per step of a request's thread (#68: the front door and its handler), when the genesis's `defaults` do not set
/// `callFuelLimit`: 10^10 wasm instructions (a front door answers in far less).
pub const CALL_FUEL: u64 = 10_000_000_000;

/// The one limit on a call's fuel and on each step of a request's thread: the genesis's `defaults.callFuelLimit`, else CALL_FUEL.
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
                    if (!logm.isSignerCall(av) and !logm.isAuthfetchCall(av)) continue;
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

/// What the host carries out (#70): a message whose recipient's transport is
/// `local` (a provider on the host: `address` its name) or `libp2p` (a peer
/// ID, or `topic:<name>`) — `message` the signed mail record's dag-cbor (its
/// CID is the message's id), `body` its body's — or (#65) an event, transport
/// `event`, `address` its name (`broadcast`, or any other, #119): `message`
/// the event record's dag-cbor, `body` a broadcast's transaction bytes (empty
/// for any other event).
pub const Outgoing = struct { message: []const u8, body: []const u8, transport: []const u8, address: []const u8 };

/// The peers the runtime calls out to (all optional; replay has none but the witness).
pub const Peers = struct {
    ctx: *anyopaque,
    /// A BRC-100 wire frame to the instance wallet → its result frame.
    wallet: ?*const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8 = null,
    /// A message (#70) or an event (#65) for the host to carry out, handed
    /// over once the step that emitted it is committed (and again, at a
    /// start, while the thread that emitted it still awaits it — the message,
    /// or a broadcast's transaction). Nothing comes back here: the answer is
    /// an entry. Absent (replay): nothing goes out.
    emit: ?*const fn (ctx: *anyopaque, out: Outgoing) void = null,
    /// A request's thread (#66: the middleware stepped on a request entry)
    /// came to rest for good — finished or errored — with its answer on its
    /// last update. Called at once, mid-drain, before what its step routed
    /// runs: the host holding the client's connection answers it now.
    on_answer: ?*const fn (ctx: *anyopaque, thread: []const u8, entry: []const u8) void = null,
    say: ?*const fn (ctx: *anyopaque, line: []const u8) void = null,
    /// The host's Io (native): a call's real randomness. The browser build has none.
    io: ?std.Io = null,
    /// One HTTP exchange (#126): what `authfetch` hands the runtime — bytes only; the kernel
    /// signs and verifies. Absent (replay; a host with no HTTP): authfetch is served from the
    /// witness, or fails.
    http: ?*const fn (ctx: *anyopaque, a: std.mem.Allocator, req: authfetch.HttpRequest) anyerror!authfetch.HttpResult = null,
};

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
    stepping: std.StringHashMap(void),
    /// A field for the next program step's input (#29): `event` (a plain
    /// entry's record, to the thread awaiting its subject), `message` (#65: a
    /// subscribed sender's message about the subject the thread awaits) or
    /// `woke` (the thread's deadline came). Set by process(), taken by stepBody.
    step_extra: ?cbor.Entry = null,
    /// Messages for the host to carry out (#70), handed over after the next
    /// commit (gpa-owned copies).
    outbox: std.array_list.Managed(Outgoing),
    /// The apps' libp2p subscriptions (#119, subscriptions.zig): the fold of the log's subscribe /
    /// unsubscribe events, kept in `life` — derived, never written; null until needed, and again
    /// after a step that subscribed or unsubscribed (folded again from the store when next needed).
    subs: ?[]subsm.Sub = null,
    /// authfetch's BRC-103 sessions (#126), per server base URL, in memory only.
    sessions: authfetch.Sessions,

    pub fn init(gpa: std.mem.Allocator, s: Store, r: *runner.Runner, peers: Peers) !*Runtime {
        const rt = try gpa.create(Runtime);
        rt.* = .{
            .gpa = gpa,
            .store = s,
            .runner = r,
            .peers = peers,
            .life = std.heap.ArenaAllocator.init(gpa),
            .live = std.StringHashMap(void).init(gpa),
            .stepping = std.StringHashMap(void).init(gpa),
            .outbox = std.array_list.Managed(Outgoing).init(gpa),
            .sessions = authfetch.Sessions.init(gpa),
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
        if (rt.cursor > 0 and (try rt.store.chainTip(a, try dispatch.origin(a))) == null) return error.PredatesDispatch;
        rt.say("runtime {s} · log {d} processed{s}", .{ shortKey(rt.identity()), rt.cursor, if (rt.has_wallet) "" else " · no wallet (replay)" });
        rt.started = true;
        for (try rt.store.resting(a)) |t| rt.resume_(a, t) catch |err| rt.say("runtime: {s}", .{@errorName(err)});
        // The messages and events a waiting thread still awaits an answer to go out again (#70,
        // #126): the host that had them may be gone (a restart), and the waker's timers with it. A
        // provider that still has one ignores it (hosts dedupe by the CID); an answer is routed once.
        if (rt.peers.emit != null) for (try rt.store.resting(a)) |t| rt.reoffer(a, t) catch |err| rt.say("runtime: {s}", .{@errorName(err)});
        try rt.store.commit();
        rt.flushOutbox();
    }

    /// Hand the host the messages its thread's tip emitted and still awaits (#70).
    fn reoffer(rt: *Runtime, a: std.mem.Allocator, origin: []const u8) !void {
        const tip = (try rt.tipOf(a, origin)) orelse return;
        if (!stateIs(tip, "waiting")) return;
        const emitted = tip.get("emitted") orelse return;
        if (emitted != .array) return;
        for (emitted.array) |x| {
            const c = Value.cidOf(x) orelse continue;
            const m = rt.store.getOpt(a, c) orelse continue;
            if (isBroadcast(m)) {
                // #65: a broadcast whose transaction the thread still awaits goes out again (a host
                // keeps a queue; one that lost it posts it again, and Arcade answers a duplicate).
                if (cidIn(tip.get("awaits"), Value.cidOf(m.get("tx")).?)) try rt.handOverEvent(a, c, m);
                continue;
            }
            // #126: an event the thread awaits (a `deadline`, a `fetch`) goes out again: the host
            // that kept it may be gone (a restart), its timers with it; a host that still has it
            // ignores it (hosts dedupe by the record's CID). #119: any other event is handed over
            // once, after its step's commit; a host that needs it again reads it from the log.
            if (isEvent(m)) {
                if (cidIn(tip.get("awaits"), c)) try rt.handOverEvent(a, c, m);
                continue;
            }
            if (!cidIn(tip.get("awaits"), c)) continue;
            try rt.handOver(a, c, null);
        }
    }

    /// A broadcast event (#65): {kind: "broadcast", tx: <cid>, beef?: bytes}.
    fn isBroadcast(m: Value) bool {
        if (m != .map) return false;
        if (!std.mem.eql(u8, Value.str(m.get("kind")) orelse "", "broadcast")) return false;
        return Value.cidOf(m.get("tx")) != null and m.get("recipient") == null;
    }

    /// Any other event (#119): {kind: "event", event: <name>, app?, …the emit's fields} (log.zig eventRecord).
    const isEvent = logm.isEvent;

    /// Queue an event for the host (#65, #119): transport "event", address its
    /// name (`broadcast`, or the record's `event`); `message` the record's
    /// dag-cbor, `body` a broadcast's transaction bytes (empty for any other).
    fn handOverEvent(rt: *Runtime, a: std.mem.Allocator, c: []const u8, m: Value) !void {
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
        });
    }

    /// How a message to `to` goes out: its address book entry (`root`). A
    /// message to the instance's own identity (#79: one app of the instance
    /// asking another — the wallet or an overlay asking the chain app) goes by
    /// the host's loopback: transport `local`, address `self` — the host
    /// appends it back into this instance as a `local` request, signed by the
    /// instance, routed like any message (a dispatch row from the instance's
    /// own key; none admits it to an admin box, #87). One exception: an answer
    /// (`is_reply`: its body names `replyTo`) to the instance's own key goes
    /// where the address book says that key is reached, when it says so — an
    /// instance that is its own owner (the browser page, #16) names its own
    /// mailbox there, and its answers to its owner are for the person, not a
    /// program. A key the address book does not name goes to the `mailbox`
    /// transport's middleware when the genesis has one (#87: the delivery
    /// thread looks for the resolve program's record of the key, `resolve/…`,
    /// and fails "no route" when there is none); `address` is then empty.
    /// Null: no route.
    fn routeTo(rt: *Runtime, a: std.mem.Allocator, root: ?[]const u8, to: []const u8, is_reply: bool) !?addressbook.Entry {
        if (std.mem.eql(u8, to, rt.identity())) {
            if (is_reply) if (try addressbook.lookup(a, rt.store, root, to)) |e| return e;
            return addressbook.Entry{ .key = to, .transport = "local", .address = addressbook.SELF };
        }
        if (try addressbook.lookup(a, rt.store, root, to)) |e| return e;
        if (rt.genesis) |g| if (deliveryOf(g) != null) return addressbook.Entry{ .key = to, .transport = "mailbox", .address = "" };
        return null;
    }

    /// Whether a message record's body names `replyTo` (an answer).
    fn isReply(rt: *Runtime, a: std.mem.Allocator, m: Value) bool {
        return rt.replyToOf(a, Value.cidOf(m.get("body"))) != .none;
    }

    /// Queue an emitted message for the host by its recipient's transport, the
    /// address book as `peers_root` names it (null: as it stands). A `mailbox`
    /// recipient's is the instance's own to deliver (launchDelivery): not handed over.
    fn handOver(rt: *Runtime, a: std.mem.Allocator, mc: []const u8, peers_root: ?[]const u8) !void {
        if (rt.peers.emit == null) return;
        const m = rt.store.getOpt(a, mc) orelse return;
        const to = Value.bytesOf(m.get("recipient")) orelse return;
        const root = peers_root orelse try rt.store.headTree(a, addressbook.HEAD);
        const e = (try rt.routeTo(a, root, to, rt.isReply(a, m))) orelse {
            rt.say("message {s}: no route to {s} any more; not sent", .{ short(a, mc), shortKey(to) });
            return;
        };
        if (std.mem.eql(u8, e.transport, "mailbox")) return;
        const body = (try rt.store.bytes(a, Value.cidOf(m.get("body")).?)) orelse return;
        const bytes = (try rt.store.bytes(a, mc)) orelse return;
        try rt.outbox.append(.{
            .message = try rt.gpa.dupe(u8, bytes),
            .body = try rt.gpa.dupe(u8, body),
            .transport = try rt.gpa.dupe(u8, e.transport),
            .address = try rt.gpa.dupe(u8, e.address),
        });
    }

    /// What is in the outbox goes to the host (#70): after a commit, so nothing leaves before the step that emitted it is durable.
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
        }
    }

    pub fn stop(rt: *Runtime) void {
        rt.stopped = true;
        rt.live.clearRetainingCapacity();
    }

    /// The boxes the dispatch table's `mailbox` rows route ("*" aside) plus the genesis's `collect`.
    pub fn boxes(rt: *Runtime, a: std.mem.Allocator) ![]const []const u8 {
        try rt.loadGenesis();
        const seeded = (try rt.store.cursorGet()) > 0;
        var out = std.array_list.Managed([]const u8).init(a);
        const add = struct {
            fn f(o: *std.array_list.Managed([]const u8), b: []const u8) !void {
                if (std.mem.eql(u8, b, "*")) return;
                for (o.items) |x| if (std.mem.eql(u8, x, b)) return;
                try o.append(b);
            }
        }.f;
        const current: ?[]dispatch.Row = if (seeded) try dispatch.current(a, rt.store) else null;
        if (current) |rows| {
            for (rows) |r| if (std.mem.eql(u8, r.transport, "mailbox")) try add(&out, r.address);
        } else if (rt.genesis) |g| {
            if (g.get("dispatch")) |rs| for (rs.array) |v| if (dispatch.rowOf(v)) |r| {
                if (std.mem.eql(u8, r.transport, "mailbox")) try add(&out, r.address);
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

    /// Admit a finished entry (Runtime.admit): a request or an event. No mail
    /// entry (K2): a message comes in inside the request that carries it.
    /// A request goes through the door first (#121, `door`): the entry
    /// written is the admission (naming its package as the door hands it
    /// back) or a refusal, and its CID is what this answers. `record` is the
    /// request record itself (the host need not put it: a package's BEEF
    /// bytes are never stored); without it the record the entry names is
    /// read from the store.
    pub fn admit(rt: *Runtime, a: std.mem.Allocator, entry: Value, record: ?Value) !AdmitResult {
        if (try rt.check(a, entry, record)) |r| return r;
        var e = entry;
        if (Value.cidOf(entry.get("request"))) |rc| {
            const rec = record orelse (try rt.store.get(a, rc)).?;
            e = try rt.door(a, entry, rec);
        }
        const res = try rt.store.logAppend(a, e);
        switch (res) {
            .ok => |c| return .{ .ok = c }, // the caller kick()s: the entry is processed after the host hears back
            .rejected => |r| return .{ .rejected = .{ .reason = r.reason, .message = r.message } },
        }
    }

    /// The host's `append` frame (K24): the genesis entry and nothing else, only as the log's
    /// first entry, its record in the store and well formed (log.zig isGenesis). Every other
    /// entry comes in through `admit`.
    pub fn appendGenesis(rt: *Runtime, a: std.mem.Allocator, entry: Value) !AdmitResult {
        if (!logm.isLogEntry(entry) or entry.get("genesis") == null) return .{ .invalid = "append: only the genesis entry is appended (every other entry is admitted: admit)" };
        if ((try rt.store.logTip(a)) != null) return .{ .invalid = "append: the log has its genesis already (every other entry is admitted: admit)" };
        const gc = Value.cidOf(entry.get("genesis")).?;
        if (!logm.isGenesis(rt.store.getOpt(a, gc))) return .{ .invalid = "append: the genesis record is not in the store, or is malformed (put it first)" };
        return switch (try rt.store.logAppend(a, entry)) {
            .ok => |c| .{ .ok = c },
            .rejected => |r| .{ .rejected = .{ .reason = r.reason, .message = r.message } },
        };
    }

    fn check(rt: *Runtime, a: std.mem.Allocator, entry: Value, record: ?Value) !?AdmitResult {
        if (!logm.isLogEntry(entry) or entry.get("genesis") != null) return .{ .invalid = "admit: want a request, mail or event entry (format 7: a wake is the waker's message, #69)" };
        if (entry.get("door") != null or entry.get("refused") != null) return .{ .invalid = "admit: `door` and `refused` are the kernel's to write (#121: the door's outcome)" };
        try rt.loadGenesis();
        if (rt.genesis == null) return .{ .invalid = "admit: no genesis" };
        if (Value.cidOf(entry.get("request"))) |rc| {
            // #68: the package as received; its form only (what it says is the middleware's to judge).
            const transport = Value.str(entry.get("transport")).?;
            if (middlewareOf(rt.genesis.?, transport) == null) return .{ .invalid = "admit: no middleware for this transport (the genesis's front door takes \"http\", \"libp2p\" and \"local\")" };
            if (record) |r| {
                // #121: the record comes with the frame, the entry naming it by its CID.
                if (!std.mem.eql(u8, try cbor.cidOfValue(a, r), rc)) return .{ .invalid = "admit: the request record is not the one the entry names (its CID)" };
                if (!logm.isRequest(transport, r)) return .{ .invalid = try std.fmt.allocPrint(a, "admit: a request record in its transport's shape (docs/VM.md, \"Requests\"): transport {s}, kind {s}", .{ transport, Value.str(r.get("kind")) orelse "?" }) };
                return null;
            }
            if (!logm.isRequest(transport, rt.store.getOpt(a, rc))) return .{ .invalid = "admit: a request entry names its request record, put first or sent with the frame (`request`), in its transport's shape (docs/VM.md, \"Requests\")" };
            return null;
        }
        if (record != null) return .{ .invalid = "admit: a request record comes only with a request entry" };
        if (Value.cidOf(entry.get("event"))) |ev| {
            if (!(try rt.store.has(ev))) return .{ .invalid = "admit: a plain entry's event record must be in the store (put it first)" };
            return null;
        }
        // K2: a message is never the host's word. It comes in as the package that carries it (a
        // `local` request {kind: "message", message: <the signed mail record>, body}, or a client's
        // request), and the front door verifies it; only what a step routes becomes a message
        // (routeAdmits). A `mail` entry in a log written before this is still processed (replay).
        if (entry.get("mail") != null) return .{ .invalid = "admit: a message is not admitted as a mail entry; append the signed package as a `local` request ({kind: \"message\", message, body}): the front door verifies it (docs/VM.md, \"Requests\")" };
        return null;
    }

    // ------------------------------------------------------------ the door (#121)

    /// The door: read-only, before the entry is written. The kernel matches
    /// the package's dispatch row (#115, `matchOf`); the transport's
    /// middleware verifies who the package is from — a kernel call of its fn
    /// `verify` (the front door: BRC-104 for http, GossipSub's signature for
    /// libp2p, the message's signature for local; matching on the claim and
    /// then verifying it is the same as verifying and then matching); the
    /// row's `filter`, if it names one, runs on the package's content
    /// (door.zig). The outcome is the entry, written either way: the
    /// admission — naming the package as the door hands it back, with
    /// `door: {verified?, filter?, beefs?}` — or a refusal, `refused: {stage:
    /// "middleware" | "filter", reason, status, code?}`, which runs nothing
    /// (`processRequest`). A middleware with no fn `verify` (a front door
    /// pinned before #121) gets the package as received, no `door`, no
    /// filter: its step verifies as it always did.
    fn door(rt: *Runtime, a: std.mem.Allocator, entry: Value, record: Value) !Value {
        const g = rt.genesis.?;
        const transport = Value.str(entry.get("transport")).?;
        const mw = middlewareOf(g, transport).?;
        const m = try rt.matchOf(a, transport, record);
        const at = logm.stampOf(entry.get("time")).?.ms();
        var arg = cbor.MapBuilder.init(a);
        try arg.put("request", record);
        try arg.put("transport", cbor.string(transport));
        try arg.put("match", m.row);
        try arg.put("refused", cbor.optStr(m.refused));
        const r = try rt.call(a, mw, "verify", try cbor.encode(a, arg.value()), null, at);
        if (!r.ok) {
            if (std.mem.indexOf(u8, r.err, "unknown fn") != null) return withRequest(a, entry, try rt.store.put(a, record), null, null);
            return refusedEntry(a, entry, try rt.store.put(a, record), "middleware", try std.fmt.allocPrint(a, "the middleware failed: {s}", .{r.err}), 500, null);
        }
        const said = cbor.decode(a, r.result) catch return refusedEntry(a, entry, try rt.store.put(a, record), "middleware", "the middleware's answer is not dag-cbor", 500, null);
        if (said.get("refused")) |x| {
            const reason = Value.str(x.get("reason")) orelse "refused";
            return refusedEntry(a, entry, try rt.store.put(a, record), "middleware", reason, Value.intOf(x.get("status")) orelse 401, Value.str(x.get("code")));
        }
        var d = cbor.MapBuilder.init(a);
        try d.put("verified", said.get("verified"));
        var rec = record;
        // A signed message (`local`): the row is its mailbox row (sender, box), as processMail routes
        // it — none for a reply — and a filter runs on its body's fields (`mailFilter`).
        if (std.mem.eql(u8, transport, "local")) return rt.mailFilter(a, entry, record, &d);
        if (m.row) |row| if (Value.str(row.get("filter"))) |f| {
            if (!doorm.isFilter(f)) return refusedEntry(a, entry, try rt.store.put(a, record), "filter", try std.fmt.allocPrint(a, "the row names a filter this kernel has not: {s}", .{f}), 500, null);
            const x = try doorm.filterBeef(a, rt.store, record);
            rec = x.value;
            try d.put("filter", cbor.string(f));
            if (x.beefs.len > 0) {
                const bs = try a.alloc(Value, x.beefs.len);
                for (x.beefs, bs) |c, *v| v.* = cbor.cidv(c);
                try d.put("beefs", .{ .array = bs });
            }
            if (x.refused) |why| {
                rt.say("door: {s} request refused by its row's filter {s}: {s}", .{ transport, f, why });
                return refusedEntry(a, entry, try rt.store.put(a, rec), "filter", why, 400, null);
            }
        };
        return withRequest(a, entry, try rt.store.put(a, rec), d.value(), null);
    }

    /// The door's filter for a signed message carried in (`local`, #121): the message's own row —
    /// the first `mailbox` row taking (sender, box), for a message to this instance that names no
    /// `replyTo` (a reply goes to the thread awaiting it, through no row) — and, if that row names
    /// a filter, the filter over the fields of the message's body. The mail record is not touched:
    /// its CID is the message's id (what a reply names) and its signature covers its body's CID.
    /// The body as the door hands it back goes in the package and the store, and the entry says
    /// which body stands for which (`door.bodies: [{of: <the body the record names>, is: <the
    /// body put>}]`): the kernel routes the message with that body (`bodyFor`), and the bytes the
    /// record names are the restored body's (door.zig restore), so the signature still verifies.
    fn mailFilter(rt: *Runtime, a: std.mem.Allocator, entry: Value, record: Value, d: *cbor.MapBuilder) !Value {
        // The package as received, when no filter applies (put only then: a filtered one's bytes are never stored).
        const pass = struct {
            fn f(r: *Runtime, al: std.mem.Allocator, en: Value, rec: Value, dv: Value) !Value {
                return withRequest(al, en, try r.store.put(al, rec), dv, null);
            }
        }.f;
        const m = record.get("message") orelse return pass(rt, a, entry, record, d.value());
        const bytes = Value.bytesOf(record.get("body")) orelse return pass(rt, a, entry, record, d.value());
        const recipient = Value.bytesOf(m.get("recipient")) orelse return pass(rt, a, entry, record, d.value());
        if (!std.mem.eql(u8, recipient, rt.identity())) return pass(rt, a, entry, record, d.value());
        const body = cbor.decode(a, bytes) catch return pass(rt, a, entry, record, d.value());
        if (body.get("replyTo") != null) return pass(rt, a, entry, record, d.value());
        const row = dispatch.forMail((try dispatch.current(a, rt.store)) orelse &.{}, Value.bytesOf(m.get("sender")).?, Value.str(m.get("box")) orelse "") orelse return pass(rt, a, entry, record, d.value());
        const f = Value.str(row.value.get("filter")) orelse return pass(rt, a, entry, record, d.value());
        if (!doorm.isFilter(f)) return refusedEntry(a, entry, try rt.store.put(a, record), "filter", try std.fmt.allocPrint(a, "the row names a filter this kernel has not: {s}", .{f}), 500, null);
        const x = try doorm.filterBeef(a, rt.store, body);
        try d.put("filter", cbor.string(f));
        var rec = record;
        if (x.beefs.len > 0) {
            const bs = try a.alloc(Value, x.beefs.len);
            for (x.beefs, bs) |c, *v| v.* = cbor.cidv(c);
            try d.put("beefs", .{ .array = bs });
            const blk = try cbor.block(a, x.value);
            try rt.store.putBlock(blk.cid, blk.bytes);
            var r = cbor.MapBuilder.init(a);
            for (record.map) |e| try r.put(e.key, e.value);
            try r.put("body", .{ .bytes = blk.bytes });
            rec = r.value();
            var pair = cbor.MapBuilder.init(a);
            try pair.put("of", m.get("body"));
            try pair.put("is", cbor.cidv(blk.cid));
            try d.put("bodies", .{ .array = try a.dupe(Value, &.{pair.value()}) });
        }
        if (x.refused) |why| {
            rt.say("door: a message in {s} refused by its row's filter {s}: {s}", .{ Value.str(m.get("box")) orelse "?", f, why });
            return refusedEntry(a, entry, try rt.store.put(a, rec), "filter", why, 400, null);
        }
        return withRequest(a, entry, try rt.store.put(a, rec), d.value(), null);
    }

    /// The body a routed message is handled with (#121): the one the door put for it (its entry's
    /// `door.bodies`), else the one its record names.
    fn bodyFor(ctx: Ctx, body: []const u8) []const u8 {
        const d = ctx.e.get("door") orelse return body;
        const bs = d.get("bodies") orelse return body;
        if (bs != .array) return body;
        for (bs.array) |p| if (Value.cidOf(p.get("of"))) |of| if (std.mem.eql(u8, of, body)) return Value.cidOf(p.get("is")) orelse body;
        return body;
    }

    fn refusedEntry(a: std.mem.Allocator, entry: Value, rc: []const u8, stage: []const u8, reason: []const u8, status: i128, code: ?[]const u8) !Value {
        var x = cbor.MapBuilder.init(a);
        try x.put("stage", cbor.string(stage));
        try x.put("reason", cbor.string(reason));
        try x.put("status", cbor.int(status));
        try x.put("code", cbor.optStr(code));
        return withRequest(a, entry, rc, null, x.value());
    }

    /// The entry naming `rc` as its request, with the door's outcome.
    fn withRequest(a: std.mem.Allocator, entry: Value, rc: []const u8, d: ?Value, refused: ?Value) !Value {
        var m = cbor.MapBuilder.init(a);
        for (entry.map) |e| try m.put(e.key, e.value);
        try m.put("request", cbor.cidv(rc));
        try m.put("door", d);
        try m.put("refused", refused);
        return m.value();
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
        rt.flushOutbox();
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
            // #77: the dispatch table's seed, the chain's first updates (no thread).
            _ = try dispatch.open(a, rt.store);
            const rows = g.get("dispatch").?.array;
            for (rows) |r| _ = try dispatch.apply(a, rt.store, "add", r, .{ .thread = null, .input = entry, .at = at });
            // A system tree (issue #4): the loader pre-filled its objects; `main` starts there.
            if (Value.cidOf(g.get("tree"))) |tree| {
                if (!(try rt.store.has(tree))) {
                    last_error = try std.fmt.allocPrint(rt.life.allocator(), "#{d}: the genesis tree {s} is not in the store", .{ n, fmtCid(a, tree) });
                    return error.NotFound;
                }
                _ = try heads.advanceHead(a, rt.store, "main", tree, .{ .thread = null, .input = entry, .at = at });
                rt.say("#{d} genesis: main → {s} (system tree)", .{ n, short(a, tree) });
            }
            // #70: the address book's seed (the host's providers, the owner's mailbox).
            try addressbook.seed(a, rt.store, g, .{ .thread = null, .input = entry, .at = at });
            if (Value.bytesOf(g.get("owner"))) |o| {
                rt.say("#{d} genesis: {s}@{s}, owner {s}, {d} dispatch rows", .{ n, Value.str(g.get("handle")).?, Value.str(g.get("domain")).?, shortKey(o), rows.len });
            } else rt.say("#{d} genesis: {s}@{s}, no owner (an image: the owner comes with the claim), {d} dispatch rows", .{ n, Value.str(g.get("handle")).?, Value.str(g.get("domain")).?, rows.len });
            return;
        }

        if (Value.cidOf(e.get("event"))) |ev| return rt.processEvent(a, n, .{ .cid = entry, .e = e }, ev, Value.str(e.get("box")).?, at);

        if (Value.cidOf(e.get("mail"))) |mc| return rt.processMail(a, n, .{ .cid = entry, .e = e }, mc, at);

        if (Value.cidOf(e.get("request"))) |rc| return rt.processRequest(a, n, .{ .cid = entry, .e = e }, rc, at);
    }

    // ------------------------------------------------------------ requests (#68, #66)

    /// The middleware a transport's packages are stepped on (#68): the
    /// genesis's `middleware` table ({transport: <program>}) if it names one,
    /// else its front door for "http", "libp2p" and "local" (#70: a
    /// provider's signed message, only its signature to check). No
    /// middleware: the entry is refused at admission.
    pub fn middlewareOf(g: Value, transport: []const u8) ?[]const u8 {
        if (g.get("middleware")) |m| if (m == .map) if (Value.cidOf(m.get(transport))) |c| return c;
        if (!std.mem.eql(u8, transport, "http") and !std.mem.eql(u8, transport, "libp2p") and !std.mem.eql(u8, transport, "local")) return null;
        const progs = g.get("programs") orelse return null;
        return Value.cidOf(progs.get("frontdoor"));
    }

    /// The outbound middleware of the `mailbox` transport (#70): the program
    /// the kernel launches as a message's delivery thread — the genesis's
    /// `middleware.mailbox`, else its messagebox program.
    pub fn deliveryOf(g: Value) ?[]const u8 {
        if (g.get("middleware")) |m| if (m == .map) if (Value.cidOf(m.get("mailbox"))) |c| return c;
        const progs = g.get("programs") orelse return null;
        return Value.cidOf(progs.get("messagebox"));
    }

    /// A message's delivery thread (#70), from the message alone: the mailbox
    /// middleware on {message, transport: "mailbox"}, launched by the message
    /// under the entry whose step emitted it.
    fn deliveryOrigin(rt: *Runtime, a: std.mem.Allocator, mc: []const u8, ctx: Ctx) !?Value {
        const g = rt.genesis orelse return null;
        const mw = deliveryOf(g) orelse return null;
        var args = cbor.MapBuilder.init(a);
        try args.put("message", cbor.cidv(mc));
        try args.put("transport", cbor.string("mailbox"));
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(mw));
        try origin.put("args", args.value());
        try origin.put("launchedBy", cbor.cidv(mc));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(logm.stampOf(ctx.e.get("time")).?.ms()));
        return origin.value();
    }

    /// The messages a step emitted go out (#70), in order, by the address
    /// book as the step left it: a `mailbox` recipient's by a delivery
    /// thread launched now (the instance holds its own BRC-103/104 sessions),
    /// the rest handed to the host after the commit. A function of the
    /// update and the state, so replay launches the same threads (and hands
    /// nothing over: it has no host).
    fn deliver(rt: *Runtime, a: std.mem.Allocator, ctx: Ctx, emitted: []const []const u8) !void {
        const root = try rt.store.headTree(a, addressbook.HEAD);
        for (emitted) |mc| {
            if (rt.stopped) return;
            const m = rt.store.getOpt(a, mc) orelse continue;
            if (isBroadcast(m) or isEvent(m)) {
                // #65, #119: an event, addressed to no one: the host's wiring carries it, or ignores it.
                try rt.handOverEvent(a, mc, m);
                continue;
            }
            const to = Value.bytesOf(m.get("recipient")) orelse continue;
            const e = (try rt.routeTo(a, root, to, rt.isReply(a, m))) orelse {
                rt.say("message {s}: no route to {s}; not sent", .{ short(a, mc), shortKey(to) });
                continue;
            };
            if (!std.mem.eql(u8, e.transport, "mailbox")) {
                try rt.handOver(a, mc, root);
                continue;
            }
            const origin = (try rt.deliveryOrigin(a, mc, ctx)) orelse {
                rt.say("message {s}: no mailbox middleware (a messagebox program) to deliver it; not sent", .{short(a, mc)});
                continue;
            };
            const t = try rt.store.chainOpen(a, origin);
            // A step run again (cut off before it ended, resumed) emits the same message: its delivery is under way.
            if (try rt.store.chainTip(a, t)) |tip| if (!std.mem.eql(u8, tip, t)) continue;
            rt.say("message {s} in {s} to {s} → delivery {s}", .{ short(a, mc), Value.str(m.get("box")) orelse "?", shortKey(to), short(a, t) });
            try rt.run(a, t);
        }
    }

    /// A request thread's origin (#68), from its entry alone: the transport's
    /// middleware, launched by the request record, with {request, transport}
    /// as its arguments. So the host can ask after a request by its entry.
    fn requestOrigin(rt: *Runtime, a: std.mem.Allocator, entry: []const u8, e: Value) !?Value {
        const g = rt.genesis orelse return null;
        const rc = Value.cidOf(e.get("request")) orelse return null;
        const transport = Value.str(e.get("transport")) orelse return null;
        if (e.get("refused") != null) return null; // #121: refused at the door, nothing runs
        const mw = middlewareOf(g, transport) orelse return null;
        var args = cbor.MapBuilder.init(a);
        try args.put("request", cbor.cidv(rc));
        try args.put("transport", cbor.string(transport));
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(mw));
        try origin.put("args", args.value());
        try origin.put("launchedBy", cbor.cidv(rc));
        try origin.put("input", cbor.cidv(entry));
        try origin.put("at", cbor.int(logm.stampOf(e.get("time")).?.ms()));
        return origin.value();
    }

    /// Whether a thread is a message's delivery (its origin is deliveryOrigin's shape, #70).
    fn isDelivery(o: Value) bool {
        const args = o.get("args") orelse return false;
        if (args != .map) return false;
        const mc = Value.cidOf(args.get("message")) orelse return false;
        if (!std.mem.eql(u8, Value.str(args.get("transport")) orelse "", "mailbox")) return false;
        return std.mem.eql(u8, Value.cidOf(o.get("launchedBy")) orelse "", mc);
    }

    /// Whether a thread is a request's (its origin is requestOrigin's shape):
    /// its steps read the routes and reads, and what their answer admits is routed.
    fn isRequestThread(o: Value) bool {
        const args = o.get("args") orelse return false;
        if (args != .map) return false;
        const rc = Value.cidOf(args.get("request")) orelse return false;
        if (Value.str(args.get("transport")) == null) return false;
        const by = Value.cidOf(o.get("launchedBy")) orelse return false;
        return std.mem.eql(u8, rc, by);
    }

    /// The dispatch row a request's step is handed (#115): `match`, the row
    /// (its settings included), or for an http request no row takes,
    /// `refused`: "path" (no row at the path: 404), "session" (a row there
    /// needs a session and the request claims none: 401), "sender" (none
    /// there takes the identity it claims: 403). Who it is from is what it
    /// claims — `x-bsv-auth-identity-key`, a libp2p peer ID's key — and the
    /// middleware verifies that before the handler runs (#121: at the door).
    fn putMatch(rt: *Runtime, a: std.mem.Allocator, input: *cbor.MapBuilder, o: Value) !void {
        const args = o.get("args").?;
        const transport = Value.str(args.get("transport")) orelse return;
        const req = (try rt.store.get(a, Value.cidOf(args.get("request")).?)) orelse return;
        const m = try rt.matchOf(a, transport, req);
        try input.put("match", m.row);
        try input.put("refused", cbor.optStr(m.refused));
    }

    pub const Match = struct { row: ?Value = null, refused: ?[]const u8 = null };

    /// The row a request record matches as the table stands (#115; for http with none, why).
    fn matchOf(rt: *Runtime, a: std.mem.Allocator, transport: []const u8, req: Value) !Match {
        const rows = (try dispatch.current(a, rt.store)) orelse &.{};
        const owner = if (try rt.ownerOf(a)) |v| Value.bytesOf(v) else null;
        if (std.mem.eql(u8, transport, "http")) {
            const who: dispatch.Who = .{ .key = claimedKey(a, req.get("headers")), .owner = owner, .reads = rt.genesis.?.get("reads") };
            return switch (dispatch.forHttp(rows, Value.str(req.get("route")) orelse "/", who)) {
                .row => |r| .{ .row = r.value },
                .refused => |why| .{ .refused = why.text() },
            };
        } else if (std.mem.eql(u8, transport, "libp2p")) {
            const name = Value.str(req.get("topic")) orelse Value.str(req.get("protocol")) orelse return .{};
            const who: dispatch.Who = .{ .key = peerKey(Value.bytesOf(req.get("from")) orelse ""), .owner = owner };
            if (dispatch.forLibp2p(rows, name, who)) |r| return .{ .row = r.value };
            // #119: a topic no row is at is delivered by the app that subscribed it (the first standing subscription).
            const topic = Value.str(req.get("topic")) orelse return .{};
            if (dispatch.libp2pAt(rows, topic)) return .{};
            const sub = subsm.forTopic(try rt.subscriptions(a), topic) orelse return .{};
            return .{ .row = try subsm.rowValue(a, rt.store, sub) };
        }
        return .{};
    }

    /// The subscriptions as the log stands (#119): the kept fold, else folded now from the store.
    pub fn subscriptions(rt: *Runtime, a: std.mem.Allocator) ![]const subsm.Sub {
        if (rt.subs) |x| return x;
        const folded = try subsm.fold(a, rt.store);
        rt.subs = try subsm.dupe(rt.life.allocator(), folded);
        return rt.subs.?;
    }

    /// The identity an HTTP request claims (its BRC-104 `x-bsv-auth-identity-key`), or null.
    fn claimedKey(a: std.mem.Allocator, headers: ?Value) ?[]const u8 {
        const hs = headers orelse return null;
        if (hs != .map) return null;
        for (hs.map) |e| if (std.ascii.eqlIgnoreCase(e.key, "x-bsv-auth-identity-key")) {
            const hex = Value.str(e.value) orelse return null;
            if (hex.len != 66) return null;
            const k = a.alloc(u8, 33) catch return null;
            _ = std.fmt.hexToBytes(k, hex) catch return null;
            return if (secp.isKey(k)) k else null;
        };
        return null;
    }

    /// The compressed secp256k1 key a libp2p peer ID carries (identity multihash over the key's protobuf), or null.
    fn peerKey(id: []const u8) ?[]const u8 {
        if (id.len != 39 or !std.mem.eql(u8, id[0..6], &[_]u8{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 })) return null;
        return if (secp.isKey(id[6..])) id[6..] else null;
    }

    /// A request (#68): the package as a transport carried it in. Its
    /// transport's middleware is launched on it as a thread of its own — the
    /// request's thread, the one a synchronous client waits on (#66) — and its
    /// first step verifies the package and routes it.
    fn processRequest(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, rc: []const u8, at: i64) !void {
        _ = at;
        if (ctx.e.get("refused")) |x| {
            rt.say("#{d} {s} request {s}: refused at the door ({s}: {s}); recorded, nothing runs", .{ n, Value.str(ctx.e.get("transport")).?, short(a, rc), Value.str(x.get("stage")) orelse "?", Value.str(x.get("reason")) orelse "?" });
            return;
        }
        const origin = (try rt.requestOrigin(a, ctx.cid, ctx.e)) orelse {
            rt.say("#{d} request {s}: no middleware for its transport; recorded, nothing runs", .{ n, short(a, rc) });
            return;
        };
        const t = try rt.store.chainOpen(a, origin);
        rt.say("#{d} {s} request {s} → {s} {s}", .{ n, Value.str(ctx.e.get("transport")).?, short(a, rc), try rt.programName(a, Value.cidOf(origin.get("program")).?), short(a, t) });
        try rt.run(a, t);
    }

    /// The thread a request entry launched, if it has been processed (#66: what the host waits on).
    pub fn requestThread(rt: *Runtime, a: std.mem.Allocator, entry: []const u8) !?[]const u8 {
        try rt.loadGenesis();
        const e = (try rt.store.get(a, entry)) orelse return null;
        const origin = (try rt.requestOrigin(a, entry, e)) orelse return null;
        const c = try cbor.cidOfValue(a, origin);
        if ((try rt.store.chainTip(a, c)) == null) return null;
        return c;
    }

    pub const RequestAnswer = struct { state: []const u8, stdout: []const u8 = "", err: []const u8 = "" };

    /// A request thread's state and, at rest for good, its answer (#66): the
    /// last update's stdout (the middleware's answer, dag-cbor) when it
    /// finished, its error's message when it errored.
    pub fn answerOf(rt: *Runtime, a: std.mem.Allocator, thread: []const u8) !RequestAnswer {
        const tip = (try rt.tipOf(a, thread)) orelse return .{ .state = "new" };
        const state = Value.str(tip.get("state")) orelse "?";
        if (std.mem.eql(u8, state, "finished")) {
            const res = tip.get("result") orelse return .{ .state = state };
            return .{ .state = state, .stdout = Value.bytesOf(res.get("stdout")) orelse "" };
        }
        if (std.mem.eql(u8, state, "errored")) {
            const em = tip.get("error");
            return .{ .state = state, .err = if (em) |x| Value.str(x.get("message")) orelse "errored" else "errored" };
        }
        return .{ .state = state };
    }

    /// What a request thread's step answered to admit (#68): `admit`, in its
    /// stdout, routed now as the entries they were before — a message ({mail,
    /// body}) by reply or subscription, admitted once (the `unique` map); an
    /// event ({event, box}) by subject or box, a libp2p `p2p` event once. A
    /// function of the step's update, so replay routes the same.
    fn routeAdmits(rt: *Runtime, a: std.mem.Allocator, ctx: Ctx, stdout: []const u8) !void {
        const out = cbor.decode(a, stdout) catch return;
        if (out != .map) return;
        const list = out.get("admit") orelse return;
        if (list != .array) return;
        const n = Value.intOf(ctx.e.get("n")) orelse 0;
        const at = logm.stampOf(ctx.e.get("time")).?.ms();
        for (list.array) |x| {
            if (rt.stopped) return;
            if (x.get("mail")) |mv| {
                if (!logm.isMail(mv)) {
                    rt.say("#{d}: a routed message is not a mail record; dropped", .{n});
                    continue;
                }
                // #121: the body the door put for the message (its filter rewrote one), else the one it names.
                const bc = bodyFor(ctx, Value.cidOf(mv.get("body")).?);
                if (Value.bytesOf(x.get("body"))) |bb| {
                    const bv = cbor.decode(a, bb) catch {
                        rt.say("#{d}: a routed message's body is not dag-cbor; dropped", .{n});
                        continue;
                    };
                    const blk = try cbor.block(a, bv);
                    if (!std.mem.eql(u8, blk.bytes, bb) or !std.mem.eql(u8, blk.cid, bc)) {
                        rt.say("#{d}: a routed message's body is not the canonical one it names; dropped", .{n});
                        continue;
                    }
                    try rt.store.putBlock(blk.cid, bb);
                } else if (!(try rt.store.has(bc))) {
                    rt.say("#{d}: a routed message has no body; dropped", .{n});
                    continue;
                }
                const mc = try rt.store.put(a, mv);
                if (!(try rt.store.markUnique(mc, ctx.cid))) {
                    rt.say("#{d} message {s}: already admitted; nothing runs", .{ n, short(a, mc) });
                    continue;
                }
                try rt.processMail(a, n, ctx, mc, at);
            } else if (x.get("event")) |ev| {
                const box = Value.str(x.get("box")) orelse "";
                if (ev != .map or box.len == 0) {
                    rt.say("#{d}: a routed event wants {{event: <record>, box}}; dropped", .{n});
                    continue;
                }
                const ec = try rt.store.put(a, ev);
                if (std.mem.eql(u8, Value.str(ev.get("kind")) orelse "", "p2p") and !(try rt.store.markUnique(ec, ctx.cid))) {
                    rt.say("#{d} libp2p message {s}: already admitted; nothing runs", .{ n, short(a, ec) });
                    continue;
                }
                try rt.processEvent(a, n, ctx, ec, box, at);
            } else rt.say("#{d}: a routed entry is neither {{mail, body}} nor {{event, box}}; dropped", .{n});
        }
    }

    /// Whether `c` is a thread that has come to rest for good (finished or errored).
    fn threadAtRest(rt: *Runtime, a: std.mem.Allocator, c: []const u8) bool {
        const o = rt.store.getOpt(a, c) orelse return false;
        if (!std.mem.eql(u8, Value.str(o.get("kind")) orelse "", "thread")) return false;
        const tip = (rt.tipOf(a, c) catch return false) orelse return false;
        return stateIs(tip, "finished") or stateIs(tip, "errored");
    }

    /// When a wake-me message this instance sent the waker asked to be woken
    /// (a log before #126, #70: the `deadline` import's then, or a program's
    /// own emit in box `wake`): the `at` of its body, or null if the record is
    /// not one. Kept so such a log replays as it was written; since #126 a
    /// deadline is an event (deadlineEvent) answered by an entry.
    fn wakeAt(rt: *Runtime, a: std.mem.Allocator, sent: []const u8) ?i128 {
        const m = rt.store.getOpt(a, sent) orelse return null;
        if (!logm.isMail(m) or !std.mem.eql(u8, Value.str(m.get("box")).?, "wake")) return null;
        if (!std.mem.eql(u8, Value.bytesOf(m.get("sender")).?, rt.identity())) return null;
        const b = rt.store.getOpt(a, Value.cidOf(m.get("body")).?) orelse return null;
        return Value.intOf(b.get("at"));
    }

    /// A message (#40): a reply to a message this instance sent — the thread
    /// awaiting that record steps with it; else routed by subscription on
    /// (sender, box), and the handler launched with {message, body, box,
    /// sender}. A message for an identity this instance keeps mail for (its
    /// owner, in a mailbox instance) is never a reply here: it is routed.
    fn processMail(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, mc: []const u8, at: i64) !void {
        const m = rt.store.getOpt(a, mc) orelse return error.NotFound;
        const sender = Value.bytesOf(m.get("sender")).?;
        // #127: a forwarded claim names no recipient — routed by its row, never a reply.
        const recipient = Value.bytesOf(m.get("recipient")) orelse "";
        const box = Value.str(m.get("box")).?;
        // #121: the body the door put for it, when its row's filter rewrote one (bodyFor).
        const body = bodyFor(ctx, Value.cidOf(m.get("body")).?);
        const what = try std.fmt.allocPrint(a, "#{d} message {s} in {s} from {s}", .{ n, short(a, mc), box, shortKey(sender) });
        if (std.mem.eql(u8, recipient, rt.identity())) {
            switch (rt.replyToOf(a, body)) {
                .none => {},
                .not_cid => {
                    rt.say("{s}: replyTo is not a CID; recorded, nothing runs", .{what});
                    return;
                },
                .cid => |reply_to| {
                    if (rt.store.getOpt(a, reply_to)) |rec| if (isIntention(rec)) return rt.intentionAnswer(a, what, ctx, mc, m, body, reply_to, rec, sender, at);
                    const t = try rt.awaiter(a, reply_to, sender);
                    if (t == null) {
                        rt.say("{s}: reply to {s}, which no thread awaits from this sender; recorded, nothing runs", .{ what, short(a, reply_to) });
                        return;
                    }
                    if (rt.wakeAt(a, reply_to)) |due| {
                        // #70, #69: the waker's answer to a wake-me — a step's deadline, or a shell's sleep, came.
                        if (at < due) {
                            rt.say("{s}: a wake for {s} before its time; recorded, nothing runs", .{ what, short(a, t.?) });
                            return;
                        }
                        rt.say("{s}: wake → {s}", .{ what, short(a, t.?) });
                        try rt.wakeThread(a, t.?, ctx);
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
        const row = dispatch.forMail((try dispatch.current(a, rt.store)) orelse &.{}, sender, box) orelse {
            rt.say("{s}: no dispatch row; recorded, nothing runs", .{what});
            return;
        };
        // #77: an admin box — the kernel's own operation, no program (#89: or the claim).
        if (row.program == null) return rt.kernelOp(a, n, ctx, row, m, what, at);
        // #65: a message about something — its `subject`, a transaction's CID — from a sender the
        // instance subscribes to (a status provider's status) steps the thread awaiting that
        // subject, before the subscription's handler: as an event about it would.
        if (std.mem.eql(u8, recipient, rt.identity())) if (Value.cidOf(m.get("subject"))) |subj| {
            for (try rt.store.awaiting(a, subj)) |t| {
                const tip = rt.tipOf(a, t) catch null orelse continue;
                if (!stateIs(tip, "waiting") or !cidIn(tip.get("awaits"), subj)) continue;
                rt.say("{s} → {s} (awaits {s})", .{ what, short(a, t), short(a, subj) });
                var info = cbor.MapBuilder.init(a);
                try info.put("message", cbor.cidv(mc));
                try info.put("body", cbor.cidv(body));
                try info.put("box", cbor.string(box));
                try info.put("sender", .{ .bytes = sender });
                try info.put("subject", cbor.cidv(subj));
                rt.step_extra = .{ .key = "message", .value = info.value() };
                try rt.step(a, t, ctx, null, null);
                return;
            }
        };
        var args = cbor.MapBuilder.init(a);
        try args.put("message", cbor.cidv(mc));
        try args.put("body", cbor.cidv(body));
        try args.put("box", cbor.string(box));
        try args.put("sender", .{ .bytes = sender });
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(row.program.?));
        try origin.put("args", args.value());
        try origin.put("launchedBy", cbor.cidv(mc));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(at));
        const t = try rt.store.chainOpen(a, origin.value());
        rt.say("{s} → {s} {s}", .{ what, try rt.programName(a, row.program.?), short(a, t) });
        try rt.run(a, t);
    }

    // ------------------------------------------------------------ the kernel's admin operations (#77)

    /// A message at an admin row: the kernel itself performs the table write
    /// — validated whole, then written, under the entry (no thread; the chain
    /// updates carry `thread: null`), or refused with a log line and nothing
    /// written. Replay performs it again from the message and comes to the
    /// same records.
    ///   objects   {records: [{cid, bytes}], root?}: each block stored under its CID (hash-checked);
    ///             `root` becomes `main` if the instance has none
    ///   head      {name, tree | root}: the head advanced to the record (in the store); owner = its name's app
    ///   dispatch  {op: "add" | "remove", row}: the table changed (dispatch.zig; a program row's record
    ///             and module must be in the store)
    ///   peers     {op: "add", key, transport?, address? | url?, role?, handle?, domain?} | {op: "remove", key}:
    ///             the address book (addressbook.zig write; source "admin")
    ///   claim     {messagebox?, handle?, domain?} (#89, #127): an image's one claim row. The
    ///             owner is the message's verified sender, never a key in the body (a body's
    ///             `owner` is not read). In one step: the owner's four admin rows (objects,
    ///             head, dispatch, peers from the sender) added, the claim row removed, the
    ///             head `claim` → {owner: the sender, messagebox?, handle?, domain?} (what was
    ///             claimed: the owner of an instance whose genesis names none), and, with a
    ///             `messagebox`, the owner's address-book entry (source "claim"). Refused when
    ///             the sender is not an identity key, the genesis names an owner or the table
    ///             has an admin row already.
    /// Only a sender a row admits reaches here: the owner, or a key the owner
    /// added as a sender (#87: no program reaches a kernel table — a
    /// program's message to an admin box finds no row and runs nothing); the
    /// claim row admits the registrant's key the host wrote into it (#127), or
    /// anyone in a bare image, until it is taken.
    fn kernelOp(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, row: dispatch.Row, m: Value, what: []const u8, at: i64) !void {
        _ = n;
        const op = row.op.?;
        const bc = Value.cidOf(m.get("body")).?;
        const body = rt.store.getOpt(a, bc) orelse {
            rt.say("{s}: kernel {s}: the body is not in the store; nothing done", .{ what, op });
            return;
        };
        const by = heads.By{ .thread = null, .input = ctx.cid, .at = at };
        const done = if (std.mem.eql(u8, op, "claim")) rt.claim(a, row, Value.bytesOf(m.get("sender")).?, body, by) else rt.kernelOpBody(a, op, body, by);
        done catch |err| switch (err) {
            error.Refused => {
                rt.say("{s}: kernel {s} refused: {s}; nothing done", .{ what, op, last_error });
                return;
            },
            else => return err,
        };
    }

    fn refuse(a: std.mem.Allocator, comptime f: []const u8, args: anytype) error{ Refused, OutOfMemory } {
        last_error = try std.fmt.allocPrint(a, f, args);
        return error.Refused;
    }

    fn kernelOpBody(rt: *Runtime, a: std.mem.Allocator, op: []const u8, body: Value, by: heads.By) !void {
        if (body != .map) return refuse(a, "the body is not a map", .{});
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
            if (root) |t| if ((try rt.store.headTree(a, "main")) == null) {
                if (!(try rt.store.has(t))) return refuse(a, "root {s} is not in the store", .{fmtCid(a, t)});
                _ = try heads.advanceHead(a, rt.store, "main", t, by);
                rt.say("kernel objects: main → {s}", .{short(a, t)});
            };
            return;
        }
        if (std.mem.eql(u8, op, "head")) {
            const name = Value.str(body.get("name")) orelse return refuse(a, "want {{name, tree}}", .{});
            const tree = Value.cidOf(body.get("tree")) orelse Value.cidOf(body.get("root")) orelse return refuse(a, "want {{name, tree}}", .{});
            if (!heads.isHeadName(name)) return refuse(a, "bad head name {s}", .{try json.quoted(a, name)});
            if (!(try rt.store.has(tree))) return refuse(a, "tree {s} is not in the store", .{fmtCid(a, tree)});
            _ = try heads.advanceHead(a, rt.store, name, tree, by);
            rt.say("kernel head: {s} → {s} (owner {s})", .{ name, short(a, tree), heads.ownerOf(name) });
            return;
        }
        if (std.mem.eql(u8, op, "dispatch")) {
            const what = Value.str(body.get("op")) orelse return refuse(a, "want {{op: add|remove, row}}", .{});
            if (!std.mem.eql(u8, what, "add") and !std.mem.eql(u8, what, "remove")) return refuse(a, "op {s}: add or remove", .{try json.quoted(a, what)});
            const row = body.get("row") orelse return refuse(a, "want {{op: add|remove, row}}", .{});
            if (try dispatch.problem(a, row)) |bad| return refuse(a, "row: {s}", .{bad});
            const r = dispatch.rowOf(row).?;
            if (std.mem.eql(u8, what, "add")) if (r.program) |pc| {
                const p = rt.store.getOpt(a, pc);
                if (!programs.isProgram(p)) return refuse(a, "row: program {s} is not a program record in the store", .{fmtCid(a, pc)});
                if (programs.wasmOf(p.?)) |w| if (!(try rt.store.has(w))) return refuse(a, "row: {s}'s module {s} is not in the store", .{ Value.str(p.?.get("name")).?, fmtCid(a, w) });
            };
            const c = try dispatch.apply(a, rt.store, what, row, .{ .thread = null, .input = by.input, .at = by.at });
            rt.say("kernel dispatch: {s} {s} {s}{s} {s}", .{ what, r.transport, r.address, if (r.prefix) "*" else "", if (c == null) "(no change)" else if (r.program == null) "→ kernel" else "→ program" });
            return;
        }
        if (std.mem.eql(u8, op, "peers")) {
            const what = Value.str(body.get("op")) orelse return refuse(a, "want {{op: add|remove, key, transport?, address? | url?, role?, handle?, domain?}}", .{});
            const key = keyOf(a, body.get("key")) orelse return refuse(a, "`key` is not an identity key", .{});
            if (std.mem.eql(u8, what, "remove")) {
                try addressbook.write(a, rt.store, key, "", null, null, null, null, "admin", by);
                rt.say("kernel peers: remove {s}", .{shortKey(key)});
                return;
            }
            if (!std.mem.eql(u8, what, "add")) return refuse(a, "op is add or remove", .{});
            const transport = Value.str(body.get("transport")) orelse "mailbox";
            if (!logm.isTransport(transport)) return refuse(a, "transport is mailbox, libp2p or local", .{});
            const address = Value.str(body.get("address")) orelse Value.str(body.get("url")) orelse return refuse(a, "add wants an address (a mailbox's url, a peer ID or topic:<name>, a provider's name)", .{});
            if (address.len == 0) return refuse(a, "add wants an address", .{});
            try addressbook.write(a, rt.store, key, transport, address, Value.str(body.get("role")), Value.str(body.get("handle")), Value.str(body.get("domain")), "admin", by);
            rt.say("kernel peers: add {s} by {s} {s}", .{ shortKey(key), transport, address });
            return;
        }
        return refuse(a, "no such operation", .{});
    }

    /// The head the claim leaves (#89): its root is {owner: the claim's sender, messagebox?, handle?, domain?}.
    pub const CLAIM_HEAD = "claim";

    /// The claim (#89, #127): the owner is the sender; validated whole, then written under the entry.
    fn claim(rt: *Runtime, a: std.mem.Allocator, row: dispatch.Row, sender: []const u8, body: Value, by: heads.By) !void {
        if (body != .map) return refuse(a, "the body is not a map", .{});
        if (!secp.isKey(sender)) return refuse(a, "the sender is not an identity key: the owner is the claim's sender", .{});
        const owner = sender;
        if (rt.genesis.?.get("owner") != null) return refuse(a, "the genesis names its owner: this instance is not an image", .{});
        const now = (try dispatch.current(a, rt.store)) orelse &.{};
        if (dispatch.hasAdminRow(now)) return refuse(a, "the instance has admin rows already: it is owned", .{});
        const mb: ?[]const u8 = if (body.get("messagebox")) |x| switch (x) {
            .null => null,
            else => Value.str(x) orelse return refuse(a, "messagebox: want the owner's messagebox URL", .{}),
        } else null;
        if (mb) |u| if (u.len == 0) return refuse(a, "messagebox: empty", .{});
        const handle = Value.str(body.get("handle"));
        const domain = Value.str(body.get("domain"));
        // What was claimed: the sender as owner, with the body's mailbox entry.
        var claimed = cbor.MapBuilder.init(a);
        try claimed.put("owner", .{ .bytes = owner });
        if (mb) |u| try claimed.put("messagebox", cbor.string(u));
        if (handle) |x| try claimed.put("handle", cbor.string(x));
        if (domain) |x| try claimed.put("domain", cbor.string(x));
        const d = dispatch.By{ .thread = null, .input = by.input, .at = by.at };
        for (dispatch.admin_ops) |o| {
            var r = cbor.MapBuilder.init(a);
            try r.put("transport", cbor.string("mailbox"));
            try r.put("address", cbor.string(o));
            try r.put("sender", .{ .bytes = owner });
            try r.put("program", cbor.string("kernel"));
            try r.put("fn", cbor.string(o));
            _ = try dispatch.apply(a, rt.store, "add", r.value(), d);
        }
        // #121: every sender is a key. Beside the admin rows, the owner's explorer row (the front
        // door's fn `explore`, at /explore and below) — unless the image seeded a row for the
        // `owner` symbol (#115, an image before #121), which keeps reading the claim's key as then.
        var symbolic = false;
        for (now) |x| symbolic = symbolic or x.sender == .owner;
        if (!symbolic) if (rt.genesis.?.get("programs")) |ps| if (Value.cidOf(ps.get("frontdoor"))) |fd| {
            var r = cbor.MapBuilder.init(a);
            try r.put("transport", cbor.string("http"));
            try r.put("address", cbor.string("/explore"));
            try r.put("prefix", .{ .bool = true });
            try r.put("sender", .{ .bytes = owner });
            try r.put("program", cbor.cidv(fd));
            try r.put("fn", cbor.string("explore"));
            _ = try dispatch.apply(a, rt.store, "add", r.value(), d);
        };
        _ = try dispatch.apply(a, rt.store, "remove", row.value, d);
        _ = try heads.advanceHead(a, rt.store, CLAIM_HEAD, try rt.store.put(a, claimed.value()), by);
        if (mb) |u| try addressbook.write(a, rt.store, owner, "mailbox", u, null, handle, domain, "claim", by);
        rt.say("kernel claim: owner {s}: admin rows objects, head, dispatch, peers{s}; the claim row removed{s}", .{ shortKey(owner), if (symbolic) "" else ", the explorer row", if (mb != null) "; the owner's messagebox in the address book" else "" });
    }

    /// The instance's owner (#89): the genesis's, else the claimed key (the head `claim`), else null (an unclaimed image).
    pub fn ownerOf(rt: *Runtime, a: std.mem.Allocator) !?Value {
        const g = rt.genesis orelse return null;
        if (g.get("owner")) |o| return o;
        const root = (try rt.store.headTree(a, CLAIM_HEAD)) orelse return null;
        const b = rt.store.getOpt(a, root) orelse return null;
        const k = keyOf(a, b.get("owner")) orelse return null;
        return .{ .bytes = k };
    }

    /// An identity key given as bytes or hex (a JSON-era client's).
    fn keyOf(a: std.mem.Allocator, v: ?Value) ?[]const u8 {
        const x = v orelse return null;
        if (Value.bytesOf(x)) |b| return if (secp.isKey(b)) b else null;
        const s = Value.str(x) orelse return null;
        if (s.len != 66) return null;
        const out = a.alloc(u8, 33) catch return null;
        _ = std.fmt.hexToBytes(out, s) catch return null;
        return if (secp.isKey(out)) out else null;
    }

    /// A plain entry (#29: a header, a proof, a transaction status the host
    /// admits from a feed): the thread whose tip awaits the event's `subject`
    /// (a CID; a transaction's is its txid) steps with it; else a
    /// subscription with no sender on the entry's box launches its handler.
    fn processEvent(rt: *Runtime, a: std.mem.Allocator, n: i128, ctx: Ctx, ev: []const u8, box: []const u8, at: i64) !void {
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
        const row = dispatch.forEvent((try dispatch.current(a, rt.store)) orelse &.{}, box) orelse {
            rt.say("{s}: no dispatch row; recorded, nothing runs", .{what});
            return;
        };
        const handler = row.program orelse {
            rt.say("{s}: an event cannot drive a kernel row; recorded, nothing runs", .{what});
            return;
        };
        var origin = cbor.MapBuilder.init(a);
        try origin.put("kind", cbor.string("thread"));
        try origin.put("program", cbor.cidv(handler));
        try origin.put("args", info.value());
        try origin.put("launchedBy", cbor.cidv(ev));
        try origin.put("input", cbor.cidv(ctx.cid));
        try origin.put("at", cbor.int(at));
        const t = try rt.store.chainOpen(a, origin.value());
        rt.say("{s} → {s} {s}", .{ what, try rt.programName(a, handler), short(a, t) });
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

    /// An intention a step records and awaits (#126): a `deadline` or a `fetch` event.
    fn isIntention(rec: Value) bool {
        if (!isEvent(rec)) return false;
        const name = Value.str(rec.get("event")).?;
        return std.mem.eql(u8, name, "deadline") or std.mem.eql(u8, name, "fetch");
    }

    /// The answer to an intention (#126): a signed message (the front door checked its signature)
    /// whose body names the intention's event as `replyTo` and carries, as `request`, the
    /// instance's own signed request for it to the answering key — the mail record {kind: "mail",
    /// op: "put", sender: <this instance>, recipient: <the answering key>, box, body: <the
    /// event's CID>, nonce?, signature}, signed BRC-169's way (the runtime's wrapper signs it with
    /// the instance's key and sends it where the host is wired: the waker, the fetch proxy). The
    /// request is the instance's word that it asked that key; the answer is that key's. Both are
    /// in the log (the answer's body holds the request). The thread awaiting the event steps: a
    /// `deadline` at its time with `woke` (a shell carries on past its sleep), a `fetch` with
    /// `reply` ({message, body, box, sender, replyTo}: the answer's body {replyTo, request,
    /// status, headers, body} | {replyTo, request, error}). Anything else is recorded and runs
    /// nothing.
    fn intentionAnswer(rt: *Runtime, a: std.mem.Allocator, what: []const u8, ctx: Ctx, mc: []const u8, m: Value, body: []const u8, ev: []const u8, rec: Value, sender: []const u8, at: i64) !void {
        const bv = rt.store.getOpt(a, body) orelse return;
        if (rt.requestProblem(a, bv.get("request"), ev, sender)) |why| {
            rt.say("{s}: an answer to {s} {s} whose request {s}; recorded, nothing runs", .{ what, Value.str(rec.get("event")).?, short(a, ev), why });
            return;
        }
        var t: ?[]const u8 = null;
        for (try rt.store.awaiting(a, ev)) |x| {
            const tip = rt.tipOf(a, x) catch null orelse continue;
            if (stateIs(tip, "waiting") and cidIn(tip.get("awaits"), ev)) {
                t = x;
                break;
            }
        }
        const th = t orelse {
            rt.say("{s}: an answer to {s} {s}, which no thread awaits; recorded, nothing runs", .{ what, Value.str(rec.get("event")).?, short(a, ev) });
            return;
        };
        if (std.mem.eql(u8, Value.str(rec.get("event")).?, "deadline")) {
            const due = Value.intOf(rec.get("at")) orelse 0;
            if (at < due) {
                rt.say("{s}: a wake for {s} before its time; recorded, nothing runs", .{ what, short(a, th) });
                return;
            }
            rt.say("{s}: wake → {s}", .{ what, short(a, th) });
            return rt.wakeThread(a, th, ctx);
        }
        rt.say("{s}: {s} answered → {s}", .{ what, Value.str(rec.get("event")).?, short(a, th) });
        var r = cbor.MapBuilder.init(a);
        try r.put("message", cbor.cidv(mc));
        try r.put("body", cbor.cidv(body));
        try r.put("box", m.get("box"));
        try r.put("sender", .{ .bytes = sender });
        try r.put("replyTo", cbor.cidv(ev));
        try rt.step(a, th, ctx, null, r.value());
    }

    /// Why an answer's `request` is not this instance's signed request for the event `ev` to
    /// `answerer` (null: it is one).
    fn requestProblem(rt: *Runtime, a: std.mem.Allocator, req: ?Value, ev: []const u8, answerer: []const u8) ?[]const u8 {
        const r = req orelse return "is missing";
        if (!logm.isMail(r)) return "is not a mail record";
        if (!std.mem.eql(u8, Value.bytesOf(r.get("sender")).?, rt.identity())) return "is not this instance's";
        if (!std.mem.eql(u8, Value.bytesOf(r.get("recipient")).?, answerer)) return "went to another key";
        if (!std.mem.eql(u8, Value.cidOf(r.get("body")) orelse "", ev)) return "is for another record";
        const sig = Value.bytesOf(r.get("signature")) orelse return "is not signed";
        const pre = cbor.encode(a, cbor.without(a, r, "signature") catch return "cannot be read") catch return "cannot be read";
        if (!secp.verifyAnyoneKey(rt.identity(), 2, logm.MESSAGE_PROTOCOL, logm.MESSAGE_KEY_ID, pre, sig)) return "has a signature that does not verify";
        return null;
    }

    /// The thread whose tip awaits the message `sent` (a record this instance
    /// holds: what it sent `from`) — the reply is `from` the one it was sent to.
    fn awaiter(rt: *Runtime, a: std.mem.Allocator, sent: []const u8, from: []const u8) !?[]const u8 {
        const rec = rt.store.getOpt(a, sent) orelse return null;
        if (!logm.isMail(rec) or !std.mem.eql(u8, Value.bytesOf(rec.get("recipient")) orelse return null, from)) return null;
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
                // A deadline is the runtime's to keep (#126): its event goes out again (reoffer), not a sleeper here.
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

    /// A thread came to rest for good: step the program that launched it, if
    /// it now can, and every thread that awaits it (#66: a request's thread
    /// waiting on the thread its answer depends on — one it did not launch,
    /// such as a resubmission's on the first submission's).
    fn rested(rt: *Runtime, a: std.mem.Allocator, child: []const u8) anyerror!void {
        const o = try rt.getOrNotFound(a, child);
        if (Value.cidOf(o.get("launchedBy"))) |parent| if (rt.store.getOpt(a, parent)) |p| {
            if (std.mem.eql(u8, Value.str(p.get("kind")) orelse "", "thread")) {
                const tip = try rt.tipOf(a, parent);
                if (tip != null and stateIs(tip, "waiting") and cidIn(tip.?.get("waitingOn"), child)) try rt.maybeStep(a, parent, tip.?);
            } else if (logm.isMail(p) and std.mem.eql(u8, Value.bytesOf(p.get("sender")).?, rt.identity()) and isDelivery(o)) {
                // #70: a message's delivery thread gave up — the thread awaiting that message's answer
                // steps with `undelivered` (no answer can come), under the entry that ended the delivery.
                const ct = (try rt.tipOf(a, child)) orelse return;
                if (stateIs(ct, "errored")) {
                    var u = cbor.MapBuilder.init(a);
                    try u.put("message", cbor.cidv(parent));
                    const em = ct.get("error");
                    try u.put("error", cbor.string(if (em) |x| Value.str(x.get("message")) orelse "undelivered" else "undelivered"));
                    const ic = Value.cidOf(ct.get("input")) orelse return error.NotFound;
                    const driver = Ctx{ .cid = ic, .e = try rt.getOrNotFound(a, ic) };
                    for (try rt.store.awaiting(a, parent)) |t| {
                        const tip = rt.tipOf(a, t) catch null orelse continue;
                        if (!stateIs(tip, "waiting") or !cidIn(tip.get("awaits"), parent)) continue;
                        rt.say("{s}: message {s} undelivered → {s}", .{ short(a, child), short(a, parent), short(a, t) });
                        rt.step_extra = .{ .key = "undelivered", .value = u.value() };
                        try rt.step(a, t, driver, null, null);
                    }
                }
                return;
            }
        };
        const awaiters = try rt.store.awaiting(a, child);
        if (awaiters.len == 0) return;
        const ct = (try rt.tipOf(a, child)) orelse return;
        if (!stateIs(ct, "finished") and !stateIs(ct, "errored")) return;
        var m = cbor.MapBuilder.init(a);
        try m.put("thread", cbor.cidv(child));
        try m.put("state", ct.get("state"));
        try m.put("result", ct.get("result"));
        try m.put("error", ct.get("error"));
        const resolved = try a.dupe(Value, &.{m.value()});
        // The step runs under the entry that brought the awaited thread to rest.
        const ic = Value.cidOf(ct.get("input")) orelse return error.NotFound;
        const driver = Ctx{ .cid = ic, .e = try rt.getOrNotFound(a, ic) };
        for (awaiters) |t| {
            const tip = rt.tipOf(a, t) catch null orelse continue;
            if (!stateIs(tip, "waiting") or !cidIn(tip.get("awaits"), child)) continue;
            rt.say("{s} → {s} (awaits the thread)", .{ short(a, child), short(a, t) });
            try rt.step(a, t, driver, resolved, null);
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
        awaits: std.array_list.Managed([]const u8),
        moves: std.array_list.Managed([2][]const u8),
        children: std.array_list.Managed(Value),
        /// The program running now (#77: the thread's, and under it each in-VM callee): its write scope.
        progs: std.array_list.Managed(Running),
        /// The messages the step emitted (#70), in order: listed on its update, sent when it ends without error.
        emitted: std.array_list.Managed([]const u8),
        /// Whether a subscribe / unsubscribe is among them (#119): the kept subscriptions are folded again.
        subscribed: bool = false,
        /// The step's deadline (ms), if it set one (#29): a waiting step rests until it at most —
        /// a `deadline` event recorded when the step ends (#126), which the step awaits.
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
        const key = try rt.gpa.dupe(u8, origin);
        try rt.stepping.put(key, {});
        var after_launched: []const []const u8 = &.{};
        var after_emitted: []const []const u8 = &.{};
        var after_rested = false;
        var after_stdout: []const u8 = "";
        const request_input: ?[]const u8 = blk: {
            const o = rt.store.getOpt(a, origin) orelse break :blk null;
            break :blk if (isRequestThread(o)) Value.cidOf(o.get("input")) else null;
        };
        // The step's fuel: one budget for the whole step, read from the genesis at its start. A
        // request's thread (#68: the middleware and the handler it calls) keeps the budget the front
        // door had as a call, `callFuelLimit`; every other step `fuelPerStep`.
        var meter = engine.Meter.init(if (request_input != null) callFuelLimit(rt.genesis) else fuelPerStep(rt.genesis));
        // The signer calls the step made, kept even when it fails: an
        // errored update lists them, so a replay has their answers.
        var calls = std.array_list.Managed([]const u8).init(a);
        blk: {
            defer {
                _ = rt.stepping.remove(key);
                rt.gpa.free(key);
            }
            const r = rt.stepBody(a, origin, ctx, resolved, reply, &meter, &calls) catch |err| {
                const exhausted = err == error.FuelExhausted;
                const msg = if (exhausted) runner.FUEL_EXHAUSTED else if (err == error.Failed or err == error.Fatal or err == error.Diverged or err == error.NoWitness) last_error else @errorName(err);
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
            after_emitted = r.emitted;
            after_rested = r.rested;
            after_stdout = r.stdout;
        }
        if (request_input) |entry| {
            // A request's thread at rest (#66): its answer goes out now, before what its step routes runs.
            if (after_rested and !rt.stopped) if (rt.peers.on_answer) |f| f(rt.peers.ctx, origin, entry);
            // What the middleware's answer admits, routed under the entry that drove this step (#68).
            if (after_stdout.len > 0 and !rt.stopped) try rt.routeAdmits(a, ctx, after_stdout);
        }
        // What the step emitted goes out (#70).
        if (after_emitted.len > 0 and !rt.stopped) try rt.deliver(a, ctx, after_emitted);
        for (after_launched) |c| try rt.run(a, c);
        if (after_rested) try rt.rested(a, origin);
    }

    const After = struct { launched: []const []const u8, emitted: []const []const u8 = &.{}, rested: bool, stdout: []const u8 = "" };

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
        try input.put("owner", try rt.ownerOf(a));
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
        if (isRequestThread(o)) {
            // The middleware (#68): the row the kernel matched for the request (#115: the dispatch
            // table matches every transport; the front door verifies who it is from and steps or
            // calls the row's handler), and — on the request's first step — whether the request
            // record was admitted before as what it routes (a redelivered GossipSub message: the
            // `unique` map holds its `p2p` record).
            try rt.putMatch(a, &input, o);
            // #121: what the door established (the middleware verified the sender at admission):
            // the step does not verify again.
            if (Value.cidOf(o.get("input"))) |ec| if (try rt.store.get(a, ec)) |re| try input.put("door", re.get("door"));
            if (g.get("reads") != null) {
                // A genesis written before #115 (it carries the front door's `reads`) pins a front
                // door that matches for itself: it is handed the table and the reads as then.
                try input.put("dispatch", try dispatch.valueOf(a, (try dispatch.current(a, rt.store)) orelse &.{}));
                try input.put("reads", g.get("reads"));
            }
            if (std.mem.eql(u8, tip_cid, origin)) {
                const rc = Value.cidOf(o.get("args").?.get("request")).?;
                if (try rt.store.byUnique(a, rc)) |first| try input.put("seen", cbor.cidv(first));
            }
        }

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
            .children = .init(a),
            .progs = .init(a),
            .emitted = .init(a),
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
            .awaitReply = hAwait,
            .head = hHead,
            .advance = hAdvance,
            .wallet = hWallet,
            .emit = hEmit,
            .deadline = hDeadline,
            .call = hCall,
            .edges = hEdges,
            .authfetch = hAuthfetch,
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
        if (!errored) if (st.until) |until| {
            // #126: the deadline is an intention — the event {kind: "event", event: "deadline", at,
            // thread, step, app?} on the step, which the step awaits. The runtime keeps it as it is
            // wired (the host's waker: a timer) and answers it with an entry at `at`; that answer
            // steps the thread with `woke`.
            const c = try rt.deadlineEvent(a, origin, n, until, st.progs.items[0]);
            var listed = false;
            for (st.emitted.items) |x| listed = listed or std.mem.eql(u8, x, c);
            if (!listed) try st.emitted.append(c);
            try st.awaits.append(c);
        };
        for (st.children.items) |c| _ = try rt.store.chainOpen(a, c);
        var head_updates = std.array_list.Managed([]const u8).init(a);
        if (!errored) for (st.moves.items) |m| try head_updates.append(try heads.advanceHead(a, rt.store, m[0], m[1], .{ .thread = origin, .input = ctx.cid, .at = at }));
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
        if (!errored) try u.put("emitted", try cbor.cidArray(a, st.emitted.items));
        if (!errored and st.subscribed) rt.subs = null;
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
        _ = try rt.store.chainAppend(a, origin, u.value());

        // The log line.
        var line = std.array_list.Managed(u8).init(a);
        const w = &line;
        try w.print("{s} {s} step {d} → {s}", .{ short(a, origin), name, n, state });
        if (st.calls.items.len > 0) try w.print(" · {d} oracle", .{st.calls.items.len});
        if (!errored and st.emitted.items.len > 0) {
            try w.appendSlice(" · emitted ");
            for (st.emitted.items, 0..) |c, i| try w.print("{s}{s}", .{ if (i > 0) "," else "", short(a, c) });
        }
        if (st.kept.items.len > 0) try w.print(" · {d} kept", .{st.kept.items.len});
        if (st.launched.items.len > 0) {
            try w.appendSlice(" · launched ");
            for (st.launched.items, 0..) |c, i| try w.print("{s}{s}", .{ if (i > 0) "," else "", short(a, c) });
        }
        if (head_updates.items.len > 0) {
            try w.appendSlice(" · moved ");
            for (st.moves.items, 0..) |m, i| try w.print("{s}{s}→{s}", .{ if (i > 0) "," else "", m[0], short(a, m[1]) });
        }
        if (st.awaits.items.len > 0) {
            try w.appendSlice(" · awaits ");
            for (st.awaits.items, 0..) |c, i| try w.print("{s}{s}", .{ if (i > 0) "," else "", short(a, c) });
        }
        // What the program wrote on stderr: the error, or a note of a step that
        // went on (e.g. the loop's undeliverable answer, #40) — once, here.
        if (errored) try w.print(" · {s}", .{stderr_text}) else if (stderr_text.len > 0) try w.print(" · stderr: {s}", .{stderr_text});
        rt.say("{s}", .{line.items});

        return .{ .launched = st.launched.items, .emitted = if (errored) &.{} else st.emitted.items, .rested = !waiting, .stdout = if (errored) "" else out.stdout };
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
        // #66: a thread may be awaited until it comes to rest; after that its state is there to read.
        if (st.rt.threadAtRest(st.a, c)) return imp.failFmt("await: thread {s} has come to rest; read its state instead", .{fmtCid(st.a, c)});
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
    /// `advance` (#77): only a head in the running program's write scope. An app's program (its
    /// record's `app`) writes `<app>/…`; a genesis-wired program writes what the genesis's `scopes`
    /// list under its name (an exact name, or a prefix ending in `/`). Nothing else (#79: the
    /// transitional `heads` grants on program records are gone). The scope is read from the record
    /// only when the owner installed it (installedAs): a record a step put and launched or called
    /// runs, and writes no head (K1).
    fn hAdvance(imp: *program.Imports, name: []const u8, t: []const u8) program.Err!void {
        const st = stepOf(imp);
        if (!heads.isHeadName(name)) return imp.failFmt("advance: bad head name {s}", .{try json.quoted(st.a, name)});
        const run_ = &st.progs.items[st.progs.items.len - 1];
        const prog = run_.record;
        const pname = Value.str(prog.get("name")) orelse "?";
        if (run_.install == null) run_.install = st.rt.installedAs(st.a, run_.cid, prog) catch return imp.failWith("store error");
        if (run_.install.? == .none) return imp.failFmt("advance: {s} is outside the write scope of {s}: its program record {s} is not installed (not a dispatch row's program, not in the genesis's programs, not listed in its app's record at <app>/app), so it writes no head", .{ try json.quoted(st.a, name), pname, fmtCid(st.a, run_.cid) });
        if (!mayAdvance(st.rt.genesis, prog, run_.install.?, name)) {
            if (Value.str(prog.get("app"))) |app| return imp.failFmt("advance: {s} is outside the write scope of {s} (app {s} writes only heads under its own name, {s}/…)", .{ try json.quoted(st.a, name), pname, app, app });
            return imp.failFmt("advance: {s} is outside the write scope of {s} (a genesis-wired program writes only the heads its genesis `scopes` name under {s})", .{ try json.quoted(st.a, name), pname, pname });
        }
        if (!(st.rt.store.has(t) catch false)) return imp.failFmt("advance: tree {s} is not in the store", .{fmtCid(st.a, t)});
        try st.moves.append(.{ name, t });
    }

    /// A program running in a step (the thread's, or an in-VM callee): its record, the record's
    /// CID, and how it is installed (looked up at its first `advance`, then kept for the step).
    const Running = struct { record: Value, cid: []const u8, install: ?Install = null };

    /// How a program record is installed (K1), which says what its self-declared `app` and `name`
    /// may claim. `owner`: the owner put it in place — a genesis program (the genesis's `programs`
    /// or `middleware`) or the program of a dispatch row (only the owner's admin messages change the
    /// table) — so its scope is read from the record as written (an app's `<app>/…`, or the genesis
    /// `scopes` under its name). `app`: listed under `programs` in the app record at `<app>/app`
    /// for the `app` its record names, so it writes `<app>/…` and nothing else (that head is the
    /// owner's install, or that app's own writing: an app can only grant its own scope). `none`:
    /// any other record — one a step put — which runs (launch and call take any program record)
    /// but writes no head.
    pub const Install = enum { owner, app, none };

    fn mapHasCid(m: ?Value, c: []const u8) bool {
        const v = m orelse return false;
        if (v != .map) return false;
        for (v.map) |e| if (Value.cidOf(e.value)) |x| if (std.mem.eql(u8, x, c)) return true;
        return false;
    }

    /// The lookup over the tables as they stand (the store's state at this point in the log — the
    /// same on replay): no copy to keep in step with the dispatch table, `<app>/app` and the genesis.
    pub fn installedAs(rt: *Runtime, a: std.mem.Allocator, c: []const u8, record: Value) !Install {
        const g = rt.genesis orelse return .none;
        if (mapHasCid(g.get("programs"), c) or mapHasCid(g.get("middleware"), c)) return .owner;
        if (try dispatch.current(a, rt.store)) |rows| for (rows) |r| if (r.program) |p| if (std.mem.eql(u8, p, c)) return .owner;
        const app = Value.str(record.get("app")) orelse return .none;
        const head = try std.fmt.allocPrint(a, "{s}/app", .{app});
        if (!heads.isHeadName(head)) return .none;
        const root = (try heads.headTree(a, rt.store, head)) orelse return .none;
        const ar = rt.store.getOpt(a, root) orelse return .none;
        if (!std.mem.eql(u8, Value.str(ar.get("kind")) orelse "", "app")) return .none;
        return if (mapHasCid(ar.get("programs"), c)) .app else .none;
    }

    /// Whether a program record installed as `install` may advance `name`.
    pub fn mayAdvance(genesis: ?Value, prog: Value, install: Install, name: []const u8) bool {
        return switch (install) {
            .none => false,
            .app => if (Value.str(prog.get("app"))) |app| appScope(app, name) else false,
            .owner => inScope(genesis, prog, name),
        };
    }

    fn appScope(app: []const u8, name: []const u8) bool {
        return name.len > app.len and std.mem.startsWith(u8, name, app) and name[app.len] == '/';
    }

    fn scopeMatch(entry: []const u8, name: []const u8) bool {
        if (entry.len > 0 and entry[entry.len - 1] == '/') return std.mem.startsWith(u8, name, entry);
        return std.mem.eql(u8, entry, name);
    }

    /// Whether `prog` (a program record) may advance `name` (#77).
    pub fn inScope(genesis: ?Value, prog: Value, name: []const u8) bool {
        if (Value.str(prog.get("app"))) |app| {
            if (appScope(app, name)) return true;
        } else if (genesis) |g| if (g.get("scopes")) |sc| if (sc == .map) if (Value.str(prog.get("name"))) |pname| if (sc.get(pname)) |list| if (list == .array) {
            for (list.array) |e| if (Value.str(e)) |s| if (scopeMatch(s, name)) return true;
        };
        return false;
    }
    fn hWallet(imp: *program.Imports, frame: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        var allowed = false;
        if (frame.len > 0) for (wallet_calls) |w| if (w == frame[0]) {
            allowed = true;
        };
        if (!allowed) return imp.failFmt("wallet: call {s} is not allowed to programs", .{if (frame.len > 0) try std.fmt.allocPrint(st.a, "{d}", .{frame[0]}) else "undefined"});
        return signerCall(st, imp, frame);
    }

    /// The `emit` import (#70): dag-cbor {to: bytes(33), box, body: bytes (a
    /// dag-cbor record, canonical), subject?: <cid>} → the message's CID. The
    /// recipient must have a route (routeTo: the address book as this step
    /// leaves it, else the mailbox transport's delivery thread); the message is signed through the signer (a recorded call), put, and
    /// listed on the update; it goes out when the step ends without error.
    fn hEmit(imp: *program.Imports, msg: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const a = st.a;
        const want = "emit: want {to: <33-byte key>, box, body: <dag-cbor bytes>, subject?: <cid>}, {event: \"broadcast\", tx: <cid>, beef?: bytes} or {event: <name>, …fields}";
        const m = cbor.decode(a, msg) catch return imp.failWith("emit: the message is not dag-cbor");
        if (m != .map) return imp.failWith(want);
        if (m.get("event")) |ev| return emitEvent(st, imp, m, ev);
        const to = Value.bytesOf(m.get("to")) orelse return imp.failWith(want);
        if (!secp.isKey(to)) return imp.failWith("emit: `to` is not an identity key (33 bytes): emit to a key, not a handle (resolve the handle first)");
        const box = Value.str(m.get("box")) orelse return imp.failWith(want);
        if (box.len == 0 or box[0] == ':') return imp.failWith("emit: the box is empty or starts with ':' (reserved)");
        const raw = Value.bytesOf(m.get("body")) orelse return imp.failWith(want);
        const bv = cbor.decode(a, raw) catch return imp.failWith("emit: the body is not dag-cbor");
        const blk = cbor.block(a, bv) catch return imp.failWith("emit: the body is not IPLD");
        if (!std.mem.eql(u8, blk.bytes, raw)) return imp.failWith("emit: the body is not canonical dag-cbor");
        var subject: ?[]const u8 = null;
        if (m.get("subject")) |s| if (s != .null) {
            subject = Value.cidOf(s) orelse return imp.failWith("emit: `subject` is not a CID");
        };
        const e = (try peersLookup(st, imp, to)) orelse return imp.failFmt("emit: no route to {s}: not in the address book, and the genesis has no messagebox program to deliver it", .{try hexOf(a, to)});
        if (std.mem.eql(u8, e.transport, "mailbox") and deliveryOf(st.rt.genesis.?) == null) return imp.failFmt("emit: {s} is reached by mailbox, and the genesis has no messagebox program to deliver it", .{try hexOf(a, to)});
        return emitMessage(st, imp, to, box, blk, subject);
    }

    /// An event out (#65, #119): addressed to no one — the host carries it by
    /// whatever wiring it has for its name, or ignores it. Listed on the
    /// update with the messages (`emitted`) and handed to the host once the
    /// step is committed; no signature, no signer call.
    ///
    /// `broadcast` (#65): {event: "broadcast", tx: <a transaction's CID, held>,
    /// beef?: bytes (its Atomic BEEF: the ancestry a broadcaster needs)} → the
    /// record {kind: "broadcast", tx, beef?} (the transaction proves itself;
    /// handed over again at a start while the thread awaits it).
    ///
    /// Any other name (#119): {event: <name>, …fields} → the record
    /// {kind: "event", event: <name>, app?: <the emitting app>, …fields}: the
    /// emit's other fields as they are, and `app` the record's `app` of the
    /// program emitting (the thread's, or an in-VM callee's) when that record
    /// is installed (installedAs, #114's rule). An uninstalled record's event
    /// names no app (a host scoping by app ignores it). `kind` and `app` are
    /// the kernel's to set. Handed over once; nothing is kept for it but the record.
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
        const run_ = &st.progs.items[st.progs.items.len - 1];
        if (run_.install == null) run_.install = st.rt.installedAs(a, run_.cid, run_.record) catch return imp.failWith("store error");
        const app: ?[]const u8 = if (run_.install.? == .none) null else Value.str(run_.record.get("app"));
        // #119: a subscription is checked as it is emitted (subscriptions.zig problem).
        const kind: ?subsm.Kind = if (std.mem.eql(u8, name, "subscribe")) .subscribe else if (std.mem.eql(u8, name, "unsubscribe")) .unsubscribe else null;
        if (kind) |k| {
            const bad = st.rt.subscriptionProblem(st, k, m, app) catch return imp.failWith("emit: the subscriptions cannot be read (a store error)");
            if (bad) |why| return imp.failWith(why);
            st.subscribed = true;
        }
        var fields = m;
        if (std.mem.eql(u8, name, "fetch")) {
            // #126: an intention — the step awaits it (sk.fetch), and the runtime answers it.
            if (fetchProblem(m)) |why| return imp.failFmt("emit: fetch: {s}", .{why});
            fields = try ownedBy(a, m, st.origin, st.n);
        }
        const rec = logm.eventRecord(a, fields, name, app) catch |err| switch (err) {
            error.Reserved => return imp.failWith("emit: an event's `kind` and `app` are the kernel's to set"),
            error.OutOfMemory => return error.OutOfMemory,
        };
        return listEvent(st, imp, rec);
    }

    /// Why a `fetch` intention (#126) is not one: {event: "fetch", method, url, headers?: {name:
    /// text}, body?: bytes, timeoutMs?, maxBytes?}; `thread` and `step` are the kernel's.
    fn fetchProblem(m: Value) ?[]const u8 {
        const method = Value.str(m.get("method")) orelse return "want {method, url, headers?, body?, timeoutMs?, maxBytes?}";
        if (method.len == 0) return "an empty method";
        const url = Value.str(m.get("url")) orelse return "want {method, url, headers?, body?, timeoutMs?, maxBytes?}";
        if (!std.mem.startsWith(u8, url, "http://") and !std.mem.startsWith(u8, url, "https://")) return "the url is not http(s)";
        if (m.get("headers")) |h| if (h != .null) {
            if (h != .map) return "headers: want {name: text}";
            for (h.map) |e| if (e.value != .string) return "headers: want {name: text}";
        };
        if (m.get("body")) |b| if (b != .null and b != .bytes) return "body: want bytes";
        for ([_][]const u8{ "timeoutMs", "maxBytes" }) |k| if (m.get(k)) |x| if (x != .null and x != .int) return "timeoutMs and maxBytes are integers";
        if (m.get("thread") != null or m.get("step") != null) return "`thread` and `step` are the kernel's to set";
        return null;
    }

    /// An intention's fields with the thread and step that recorded it: its own record (two
    /// threads asking the same are two intentions, two answers).
    fn ownedBy(a: std.mem.Allocator, m: Value, origin: []const u8, n: i64) !Value {
        var b = cbor.MapBuilder.init(a);
        for (m.map) |e| try b.put(e.key, e.value);
        try b.put("thread", cbor.cidv(origin));
        try b.put("step", cbor.int(n));
        return b.value();
    }

    /// Why a subscribe / unsubscribe this step emits is refused, or null: against the subscriptions as
    /// the log stands with this step's own earlier ones applied, and the app's record at `<app>/app`.
    fn subscriptionProblem(rt: *Runtime, st: *StepState, kind: subsm.Kind, m: Value, app: ?[]const u8) !?[]u8 {
        const a = st.a;
        var now = std.array_list.Managed(subsm.Sub).init(a);
        try now.appendSlice(try rt.subscriptions(a));
        for (st.emitted.items) |c| if (rt.store.getOpt(a, c)) |rec| if (subsm.eventOf(rec)) |e| try subsm.apply(&now, e);
        const ps = if (app) |x| try subsm.programsOf(a, rt.store, x) else null;
        return subsm.problem(a, kind, m, app, ps, now.items);
    }

    /// A `deadline` event (#126): {kind: "event", event: "deadline", at: <ms>, thread: <origin>,
    /// step: <n>, app?} — the thread's intention to rest until `at` at most, put. `thread` and
    /// `step` make it this wait's own (two threads resting until the same time rest on two
    /// records); `app` is the program's app when its record is installed (installedAs), as for any
    /// event. The step (or the shell's waiting update) lists it and awaits it.
    fn deadlineEvent(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, step_n: i64, until: i64, run_: Running) ![]const u8 {
        const install = run_.install orelse try rt.installedAs(a, run_.cid, run_.record);
        const app: ?[]const u8 = if (install == .none) null else Value.str(run_.record.get("app"));
        return rt.store.put(a, try logm.deadlineRecord(a, until, origin, step_n, app));
    }

    /// Put an event record and list it on the update (once per step).
    fn listEvent(st: *StepState, imp: *program.Imports, rec: Value) program.Err![]const u8 {
        const c = st.rt.store.put(st.a, rec) catch return imp.failWith("emit: the event is not IPLD, or a store error");
        for (st.emitted.items) |x| if (std.mem.eql(u8, x, c)) return c;
        try st.emitted.append(c);
        return c;
    }

    /// The address book as this step sees it (its own `peers` moves included): `key`'s entry.
    fn peersLookup(st: *StepState, imp: *program.Imports, key: []const u8) program.Err!?addressbook.Entry {
        const root = (try hHead(imp, addressbook.HEAD));
        return st.rt.routeTo(st.a, root, key, false) catch imp.failWith("emit: the address book cannot be read");
    }

    /// Sign, put and list one message from this instance (#70): {kind: "mail",
    /// op: "put", sender, recipient, box, body, subject?, signature}, signed
    /// BRC-169's way over the record without `signature`.
    fn emitMessage(st: *StepState, imp: *program.Imports, to: []const u8, box: []const u8, blk: cbor.Block, subject: ?[]const u8) program.Err![]const u8 {
        const a = st.a;
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("mail"));
        try rec.put("op", cbor.string("put"));
        try rec.put("sender", .{ .bytes = st.rt.identity() });
        try rec.put("recipient", .{ .bytes = to });
        try rec.put("box", cbor.string(box));
        try rec.put("body", cbor.cidv(blk.cid));
        try rec.put("subject", cbor.optCid(subject));
        // What makes this emit one message of its own (two threads asking the same thing are two
        // messages, with two answers): 16 bytes of sha256(thread ‖ step ‖ the emit's place in it).
        var h = std.crypto.hash.sha2.Sha256.init(.{});
        h.update(st.origin);
        var nb: [16]u8 = undefined;
        std.mem.writeInt(i64, nb[0..8], st.n, .big);
        std.mem.writeInt(u64, nb[8..16], st.emitted.items.len, .big);
        h.update(&nb);
        var d: [32]u8 = undefined;
        h.final(&d);
        try rec.put("nonce", .{ .bytes = try a.dupe(u8, d[0..16]) });
        const pre = cbor.encode(a, rec.value()) catch return error.OutOfMemory;
        const frame = signer.createSignatureFrame(a, logm.MESSAGE_PROTOCOL, logm.MESSAGE_KEY_ID, .anyone, pre) catch return error.OutOfMemory;
        const res = try signerCall(st, imp, frame);
        const sig = signer.signatureOf(res) orelse return imp.failWith("emit: the oracle did not sign the message");
        try rec.put("signature", .{ .bytes = sig });
        st.rt.store.putBlock(blk.cid, blk.bytes) catch return imp.failWith("store error");
        const c = st.rt.store.put(a, rec.value()) catch return imp.failWith("store error");
        try st.emitted.append(c);
        return c;
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
        // #126: an intention, recorded when the step ends waiting (stepBody: the `deadline` event).
        st.until = if (st.until) |t| @min(t, until) else until;
    }

    fn hexOf(a: std.mem.Allocator, b: []const u8) ![]const u8 {
        const out = try a.alloc(u8, b.len * 2);
        const digits = "0123456789abcdef";
        for (b, 0..) |x, i| {
            out[2 * i] = digits[x >> 4];
            out[2 * i + 1] = digits[x & 15];
        }
        return out;
    }

    /// `authfetch` (#126, authfetch.zig): a BRC-104 request from this instance, a recorded call.
    /// The record, at (thread, step, i) as a signer call's: {kind: "authfetch", thread, step, i,
    /// request: bytes (the import's dag-cbor), answer?: bytes (dag-cbor {status, headers, body}),
    /// error?: text, calls: [{request, result}] (every signer frame it made: the session's nonce,
    /// the request's signature, the checks of the server's)}. Replay serves the answer (or the
    /// failure) from the witness and asks no one; a differing request is a divergence. A request
    /// that is not one fails here, recording nothing.
    fn hAuthfetch(imp: *program.Imports, req: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const rt = st.rt;
        const a = st.a;
        const parsed = authfetch.parse(a, req) catch return error.OutOfMemory;
        const r = switch (parsed) {
            .ok => |x| x,
            .bad => |why| return imp.failWith(why),
        };
        const i = st.calls.items.len;
        const w: ?Value = if (rt.witness) |wi| (wi.find(a, st.origin, st.n, i) catch null) else null;
        if (w) |x| {
            if (!logm.isAuthfetchCall(x) or !std.mem.eql(u8, Value.bytesOf(x.get("request")) orelse "", req)) {
                return imp.fatalWith(.diverged, try std.fmt.allocPrint(a, "{s} step {d} call {d}: the authfetch request differs from the recorded one", .{ short(a, st.origin), st.n, i }));
            }
            try st.calls.append(rt.store.put(a, x) catch return imp.failWith("store error"));
            if (Value.bytesOf(x.get("answer"))) |ans| return ans;
            return imp.failWith(Value.str(x.get("error")) orelse "authfetch: failed");
        }
        if (!rt.has_wallet or rt.peers.http == null) {
            if (rt.witness != null or !rt.has_wallet) return imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (authfetch): no wallet and no recorded answer", .{ short(a, st.origin), st.n, i }));
            return imp.failWith("authfetch: this host carries no HTTP");
        }
        var ac = AuthCall{ .rt = rt, .calls = std.array_list.Managed(Value).init(a), .at = st.at };
        const env = authfetch.Env{ .ctx = &ac, .identity = rt.identity(), .wallet = AuthCall.wallet, .http = AuthCall.http, .random = AuthCall.random };
        const out = authfetch.run(a, env, &rt.sessions, r) catch |err| {
            if (err == error.PeerGone) return imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (authfetch): the router is gone", .{ short(a, st.origin), st.n, i }));
            if (err == error.OutOfMemory) return error.OutOfMemory;
            return imp.failFmt("authfetch: {s}", .{@errorName(err)});
        };
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("authfetch"));
        try rec.put("thread", cbor.cidv(st.origin));
        try rec.put("step", cbor.int(st.n));
        try rec.put("i", cbor.int(i));
        try rec.put("request", .{ .bytes = req });
        var answer: ?[]const u8 = null;
        switch (out) {
            .answer => |x| {
                answer = cbor.encode(a, try authfetch.answerValue(a, x)) catch return error.OutOfMemory;
                try rec.put("answer", .{ .bytes = answer.? });
            },
            .failed => |why| try rec.put("error", cbor.string(why)),
        }
        try rec.put("calls", .{ .array = ac.calls.items });
        try st.calls.append(rt.store.put(a, rec.value()) catch return imp.failWith("store error"));
        return answer orelse imp.failWith(out.failed);
    }

    /// authfetch's world for one call: the signer (each frame kept for the record), the
    /// runtime's HTTP, real randomness (a nonce no one can guess; replay never asks for it).
    const AuthCall = struct {
        rt: *Runtime,
        calls: std.array_list.Managed(Value),
        at: i64,

        fn of(ctx: *anyopaque) *AuthCall {
            return @ptrCast(@alignCast(ctx));
        }
        fn wallet(ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8 {
            const c = of(ctx);
            const res = try c.rt.peers.wallet.?(c.rt.peers.ctx, a, frame);
            var m = cbor.MapBuilder.init(a);
            try m.put("request", .{ .bytes = frame });
            try m.put("result", .{ .bytes = res });
            try c.calls.append(m.value());
            return res;
        }
        fn http(ctx: *anyopaque, a: std.mem.Allocator, req: authfetch.HttpRequest) anyerror!authfetch.HttpResult {
            const c = of(ctx);
            return c.rt.peers.http.?(c.rt.peers.ctx, a, req);
        }
        fn random(ctx: *anyopaque, out: []u8) void {
            const c = of(ctx);
            realRandom(c.rt.peers.io, out, c.at);
        }
    };

    /// A signer call's answer, recorded (#67: the one call a step makes out
    /// mid-step): the witness's on replay (a differing request is a
    /// divergence), else the wallet's. The record: {kind: "oracle", thread,
    /// step, i, request, result}.
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
                imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (oracle): the router is gone", .{ short(a, st.origin), st.n, i }))
            else
                imp.failFmt("{s}", .{@errorName(err)});
        } else {
            return imp.fatalWith(.no_witness, try std.fmt.allocPrint(a, "{s} step {d} call {d} (oracle): no wallet and no recorded answer", .{ short(a, st.origin), st.n, i }));
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

    // ------------------------------------------------------------ calls (#40)

    /// An in-VM call from a step: the callee runs as part of the step — its
    /// recorded calls, kept records, launches and head moves are the step's,
    /// on the step's fuel and clock — with its own input.
    fn hCall(imp: *program.Imports, prog: []const u8, func: []const u8, arg: []const u8) program.Err![]const u8 {
        const st = stepOf(imp);
        const a = st.a;
        if (st.depth >= MAX_CALL_DEPTH) return imp.failWith("call: nested too deep");
        const loaded = try loadCallee(st.rt, imp, a, prog);
        // #77: the callee's writes are the step's, in the callee's own write scope.
        try st.progs.append(.{ .record = loaded.record, .cid = prog });
        defer _ = st.progs.pop();
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

    const Callee = struct { mod: *runner.Compiled, name: []const u8, record: Value };

    fn loadCallee(rt: *Runtime, imp: *program.Imports, a: std.mem.Allocator, prog: []const u8) program.Err!Callee {
        const p = rt.store.getOpt(a, prog);
        if (!programs.isProgram(p) or !hasWasm(p.?)) return imp.failFmt("call: {s} is not a wasm program record in the store", .{fmtCid(a, prog)});
        var msg: []const u8 = "";
        const mod = rt.runner.load(rt.store, a, programs.wasmOf(p.?).?, &msg) catch |err| return switch (err) {
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

    /// The input a called program reads (`kind: "call"`): what it is asked,
    /// by whom, and the instance it runs in — the genesis's facts and the
    /// dispatch table as it stands (#77).
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
        try m.put("owner", try rt.ownerOf(a));
        try m.put("programs", g.get("programs"));
        try m.put("peers", g.get("peers"));
        try m.put("defaults", g.get("defaults"));
        try m.put("names", g.get("names"));
        try m.put("reads", g.get("reads")); // a genesis before #115 carries them (its front door reads them)
        try m.put("dispatch", try dispatch.valueOf(a, (try dispatch.current(a, rt.store)) orelse &.{}));
        return m;
    }

    pub const CallResult = struct { ok: bool, result: []const u8 = "", err: []const u8 = "", fuel: u64 };

    /// The kernel's `call` (#40): run `prog`'s entry as a function over the
    /// current state and return what it wrote to stdout. No entry, no writes:
    /// `put` keeps records in memory for the call only; heads, the store and
    /// the log are read as they stand (plus the entries admitted and not yet
    /// processed, `pending`, and the committed state record, `state`). The
    /// signer (`wallet`) and `http` are answered by the host and not recorded,
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
        .wallet = cWallet,
        .emit = cEmit,
        .deadline = cDeadline,
        .call = cCall,
        .edges = cEdges,
        .authfetch = cAuthfetch,
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
    /// A kernel call sends nothing (#70): only a step emits.
    fn cEmit(imp: *program.Imports, _: []const u8) program.Err![]const u8 {
        return imp.failWith("emit: a kernel call sends nothing (emit from a step)");
    }
    fn cDeadline(imp: *program.Imports, _: i64) program.Err!void {
        return readOnly(imp, "deadline");
    }
    /// A kernel call talks to no one (#126): authfetch is a step's, recorded.
    fn cAuthfetch(imp: *program.Imports, _: []const u8) program.Err![]const u8 {
        return imp.failWith("authfetch: a kernel call talks to no one (authfetch from a step)");
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
    /// The signer, answered by the host and not recorded (a call is never replayed).
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
        /// Re-executing because of the answer to its sleep (#69, #126): the sleep it reaches is woken by it.
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

    /// The answer to a thread's deadline came (#126; a log before it: the
    /// waker's answer to a wake-me, #69): a program thread steps with `woke`;
    /// a shell is re-executed from its origin and carries on past its sleep
    /// under the answer's entry.
    fn wakeThread(rt: *Runtime, a: std.mem.Allocator, origin: []const u8, c: Ctx) !void {
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
            // #83: the thread's program record names the shell's modules (the shell app's install wrote it).
            const pc = Value.cidOf(t.o.get("program")) orelse return error.NotFound;
            const prog = rt.store.getOpt(a, pc) orelse {
                try rt.shellErrored(t, "shell program: not a record in this store", &ended);
                break :body;
            };
            const mods = shell.loadModules(rt.runner, rt.store, rt.life.allocator(), prog, pc, &msg) catch |err| {
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
        if (parked) return; // resting on its deadline (#69, #126): stays live until it is answered
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
        rt.appendShellFull(t, "errored", null, err_value, null, &.{}) catch |err| {
            if (err == error.Diverged) {
                rt.say("{s}: {s}", .{ short(t.a, t.origin), t.diverged.? });
                return;
            }
            return err;
        };
        ended.* = true;
    }

    fn appendShell(rt: *Runtime, t: *ShellRun, state: []const u8, result: ?Value) !void {
        return rt.appendShellFull(t, state, result, null, null, &.{});
    }

    /// Append the thread's next update, or verify it against the chain when re-executing.
    fn appendShellFull(rt: *Runtime, t: *ShellRun, state: []const u8, result: ?Value, err_value: ?Value, until: ?i64, extra: []const cbor.Entry) !void {
        const a = t.a;
        var m = cbor.MapBuilder.init(a);
        try m.put("state", cbor.string(state));
        // A step ends at waiting/finished/errored: its fuel; `running` starts the next one.
        if (std.mem.eql(u8, state, "running")) t.meter.segment() else try m.put("fuel", cbor.int(t.meter.used()));
        if (until) |u| try m.put("until", cbor.int(u));
        for (extra) |x| try m.put(x.key, x.value);
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

    /// A sleep: at once if not after "now"; else rest `waiting` until it. The
    /// wait is an intention (#126, as a step's `deadline` is): the `deadline`
    /// event, listed on the waiting update (`emitted`) and awaited (`awaits`).
    /// The runtime's answer at `until` re-executes the shell from its origin,
    /// and it carries on past the sleep under that answer's entry.
    /// Re-executing, the waiting update is the one recorded (its event with
    /// it; a log before #126: its signed wake-me to the waker).
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
        var sent: ?[]const u8 = null;
        if (t.pos < t.history.len) {
            // Re-executing: the waiting update is recorded, and its event (or wake-me) with it.
            const u = (rt.store.get(t.a, t.history[t.pos]) catch null) orelse return shStop(t, error.NotFound);
            var kept: [3]cbor.Entry = undefined;
            var k: usize = 0;
            for ([_][]const u8{ "calls", "emitted", "awaits" }) |name| if (u.get(name)) |v| {
                kept[k] = .{ .key = name, .value = v };
                k += 1;
            };
            rt.appendShellFull(t, "waiting", null, null, until, kept[0..k]) catch |err| return shStop(t, err);
        } else {
            // #126: the sleep is an intention, the `deadline` event, listed and awaited.
            const pc = Value.cidOf(t.o.get("program")) orelse return shStop(t, error.NotFound);
            const prog = rt.store.getOpt(t.a, pc) orelse return shStop(t, error.NotFound);
            const ev = rt.deadlineEvent(t.a, t.origin, @intCast(t.pos + 1), until, .{ .record = prog, .cid = pc }) catch |err| return shStop(t, err);
            const extra = [_]cbor.Entry{
                .{ .key = "emitted", .value = (cbor.cidArray(t.a, &.{ev}) catch return error.OutOfMemory).? },
                .{ .key = "awaits", .value = (cbor.cidArray(t.a, &.{ev}) catch return error.OutOfMemory).? },
            };
            rt.appendShellFull(t, "waiting", null, null, until, &extra) catch |err| return shStop(t, err);
            sent = ev;
        }
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
            // This run is the waker's answer's: carry on past the sleep under it.
            t.wake = null;
            t.drive(w);
            rt.appendShell(t, "running", null) catch |err| return shStop(t, err);
            return;
        }
        // Resting on its deadline: the event goes to the host once this is committed (a start hands it over again).
        if (sent) |c| if (rt.store.getOpt(t.a, c)) |m| rt.handOverEvent(t.a, c, m) catch |err| return shStop(t, err);
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
