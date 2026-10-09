//! amm-p2p: the AMM overlay's marketplace relay and the app's pages, as one
//! skein program (Zig, wasm32-wasi).
//! The standard overlay gossip — submissions on `<topic>`, STEAKs on
//! `<topic>-admit`, proofs on `<topic>-proof` — is skein's overlay engine's
//! (skein#74), not this program's.
//!
//! The bodies and plans are in proofs.zig and schedule.zig (pure, tested
//! natively); the libp2p shapes are libp2p.zig. This file wires them to the VM.
//!
//! **Market and validator** (0.6.0, shruggr/skein#120, David 2026-10-06 evening) are the overlay
//! engine's, not this program's: "a skein runs as a market and/or a validator by two settings in
//! the engine's configuration (`config.overlay.market: {window}`, `config.overlay.validator:
//! {every}`), and registering a token's topic is the one act that drives both" — the engine emits
//! `liveness` / `beacon` on `tm_mandala_<txid>_0-live` at `register` (skein-overlay 0.9.0). The page reads
//! `GET /<app>/.live/<topic>` and names the validator (its identity key and peer ID) in the swap;
//! the relay dials the peer it is given. This program keeps no validated set, no beacons, no
//! liveness, and takes no start or stop.
//!
//! **Called** (input kind "call"; `fn`):
//!
//!   proofsByBlock   a /amm/proofs/1.0.0 frame → {verdict: accept, body: {bump} | {missing: true}}
//!                   (a utility: no row routes it since 0.2.0; sync is shruggr/skein#112's `want`)
//!   serve           the read route `/` (prefix; the filter `page`, shruggr/skein#143: anyone, signed
//!                   or not, nothing logged; called as a filter it answers `{answer: <the page>}`):
//!                   the app's pages, `www/` of the app's own tree (skein-sdk `files.serve`,
//!                   shruggr/skein#125); it reads only
//!   call            route /amm/call (APPS.md §4; kernel.brc104: the caller is the signed request's key,
//!                   who may call is the kernel's gate, 0.7.0): {fn, args} → {fn, result} | {fn, error}; `amm.swap.submit`,
//!                   `amm.pool.submit` answer {wait: true} and, called again with
//!                   `resolved`, the record
//!   requests        the read route `/requests` (filter `requests`, 0.9.0): the holders' listing requests (reads.zig)
//!   spends          the read route `/spends?outpoint=<txid>.<vout>` (filter `spends`, 0.9.0): the chain
//!                   state of an outpoint, a pool followed to its current output (reads.zig)
//!   amm.swap.submit, amm.swap.status, amm.swap.terms   an in-VM call of the interface amm.swap/1 (relay.zig)
//!   amm.pool.submit, amm.pool.status, amm.pool.terms   an in-VM call of the interface amm.pool/1 (relay.zig: the
//!                   pool deploy, delivered; the validator's terms, 0.9.0)
//!
//! **Stepped** (the `mailbox` route on the box `amm/amm-p2p`; since 0.7.0, shruggr/skein#143, the
//! app's box `amm` is the overlay engine's alone):
//!
//!   message {fn, args} in box `amm/amm-p2p`            this program's box (APPS.md §4): amm.swap.submit | status | terms,
//!                                                     amm.pool.submit | status | terms,
//!                                                     answered to the sender in that box (a submit: when the relay settles)
//!   message {fn: "request", args: {tokenId}} in box `amm/requests`   a holder's listing request (0.9.0): recorded
//!                                                     under the head `amm/requests` (reads.zig)
//!   thread  {kind: "amm-swap-relay" | "amm-pool-relay", id}   the relay (launched by a submit): a thread resting on
//!                                                     the libp2p provider's answers to its dial of the validator
//!                                                     the caller named, or (that validator is this node) on
//!                                                     what its own validator program awaited, called in-VM
//!   message {kind: "amm-p2p-tick", job: "catchup", name, due}   from the cron provider (skein#69): a catch-up
//!                                                     pass (a thread resting on the libp2p provider's answers
//!                                                     to its direct calls). A utility: nothing schedules it
//!                                                     (0.6.0: the start that did is gone)
//!
//! State under the head `amm/p2p` (`relay.p2p_head`): {kind: "amm-p2p-state", maps: {cursor}} (the
//! catch-up cursor; a record 0.5.0 or earlier wrote also held `beacons`, `subscriptions`,
//! `validated`, `liveness`, which are not read and dropped at the next write).
//! The app's state under the head `amm/app` (relay.zig `Book`; skein #77:
//! `app.headOf`): the installed app record's `state`, or (an instance wired
//! by its genesis, no app record) the head's root itself: {kind:
//! "amm-app-state", swaps, pools}.
//!
//! Config: the installed app record's `config.amm` (`ammP2p`: the catch-up's `topics`, `peers`,
//! `window`, `batch`, `replyTimeoutMs`, all optional; `commission`), else genesis
//! `defaults.ammP2p` and `defaults.ammCommission`, JSON objects in strings; the topics
//! (`ammP2p.topics`, else every `tm_mandala_<txid>_0` the overlay serves, declared or registered with the
//! engine, as the engine reads its configuration: skein-overlay `engine_vm.configured`); the
//! functions' declarations: the app record's `provides`, else genesis `defaults.ammProvides`
//! (JSON) (README.md).
const std = @import("std");
const w = @import("chain");
const ov = @import("skein_overlay");
const vm = @import("overlay_sk");
const wire = @import("wallet").wire;
const names = @import("names.zig");
const libp2p = @import("libp2p.zig");
const schedule = @import("schedule.zig");
const proofs = @import("proofs.zig");
const views = @import("views.zig");
const relay = @import("relay.zig");
const reads = @import("reads.zig");
const app = @import("app");
const sk = @import("sk");
const files = @import("files");
const scbor = @import("sdk_cbor");
const dagjson = @import("dagjson");

const cbor = w.cbor;
const Value = cbor.Value;
const Map = w.store.Map;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

/// The imports skein-overlay's `sk` module does not declare: the signer.
const ext = struct {
    extern "skein" fn wallet(frame: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
};

pub fn main() u8 {
    return vm.main("amm-p2p", run);
}

/// The input as the overlay engine reads its configuration (skein-overlay `engine_vm.configured`:
/// the app this program was installed in, its served topics with the registered ones in (the
/// engine's head `<app>/topics`), its roles), for the topics this program works on (`config`).
var overlay_in: ?Value = null;

fn run(a: Allocator) anyerror!void {
    const in = try vm.input(a);
    const is_call = eql(u8, in.getText("kind") orelse "", "call");
    overlay_in = ov.engine_vm.configured(a, in, if (is_call) vm.callArg(a, in) catch null else null) catch null;
    if (is_call) return call(a, in);
    return step(a, in);
}

// ---------------------------------------------------------------- config

const Config = struct {
    topics: []const []const u8,
    window: u32 = 12,
    batch: u32 = 6,
    /// Catch-up peers: base58 peer IDs or multiaddrs with /p2p/<id>, as `dial` takes them.
    peers: []const []const u8 = &.{},
    /// How long catch-up waits on a direct call's answer (ms).
    reply_timeout_ms: u64 = 30_000,
};

/// A configuration section: the installed app record's `config.amm.<key>`
/// (as JSON text), else the genesis default `<genesis>` (JSON text).
fn configText(a: Allocator, in: Value, key: []const u8, genesis: []const u8) !?[]const u8 {
    if (try appRecord(a)) |rec| if (rec.get("config")) |c| if (c.get(relay.app_name)) |amm| if (amm.get(key)) |v| return try jsonOf(a, v);
    const d = in.get("defaults") orelse return null;
    return d.getText(genesis);
}

/// A configuration value (maps, lists, text, numbers, booleans) as JSON text.
fn jsonOf(a: Allocator, v: Value) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try writeJson(&jw, v);
    return out.written();
}

fn writeJson(jw: *std.json.Stringify, v: Value) !void {
    switch (v) {
        .map => |es| {
            try jw.beginObject();
            for (es) |e| {
                try jw.objectField(e.key);
                try writeJson(jw, e.value);
            }
            try jw.endObject();
        },
        .array => |xs| {
            try jw.beginArray();
            for (xs) |x| try writeJson(jw, x);
            try jw.endArray();
        },
        .text => |t| try jw.write(t),
        .boolean => |b| try jw.write(b),
        .uint => |n| try jw.write(n),
        .nint => |n| try jw.write(-1 - @as(i128, n)),
        .null => try jw.write(null),
        else => return error.BadConfig,
    }
}

/// The relay's commission: `{pkh?: <40 hex> | null}`.
fn commissionConfig(a: Allocator, in: Value) !relay.Commission {
    var c: relay.Commission = .{};
    const text = (try configText(a, in, "commission", "ammCommission")) orelse return c;
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{}) catch return error.BadConfig;
    if (j != .object) return error.BadConfig;
    if (j.object.get("pkh")) |v| switch (v) {
        .null => {},
        .string => |h| {
            var pkh: [20]u8 = undefined;
            if (h.len != 40) return error.BadConfig;
            _ = std.fmt.hexToBytes(&pkh, h) catch return error.BadConfig;
            c.pkh = pkh;
        },
        else => return error.BadConfig,
    };
    return c;
}

fn config(a: Allocator, in: Value) !Config {
    var cfg: Config = .{ .topics = &.{} };
    if (try configText(a, in, "ammP2p", "ammP2p")) |text| {
        const j = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{}) catch return error.BadConfig;
        if (j != .object) return error.BadConfig;
        const o = j.object;
        inline for (.{ .{ "window", "window" }, .{ "batch", "batch" }, .{ "replyTimeoutMs", "reply_timeout_ms" } }) |f| {
            if (o.get(f[0])) |v| @field(cfg, f[1]) = if (v == .integer and v.integer > 0) @intCast(v.integer) else return error.BadConfig;
        }
        if (o.get("topics")) |v| cfg.topics = try strings(a, v);
        if (o.get("peers")) |v| cfg.peers = try strings(a, v);
    }
    if (cfg.topics.len == 0) {
        // Every token topic `tm_mandala_<txid>_0` the overlay serves now: the ones registered with the
        // engine (its head `<app>/topics`) and any `config.overlay.topics` names.
        const cin = overlay_in orelse in;
        var out: std.ArrayList([]const u8) = .empty;
        for (ov.calls.servedTopics(a, cin) catch return cfg) |t| if (names.parse(t)) |n| if (n.kind == .overlay) try out.append(a, t);
        cfg.topics = out.items;
    }
    return cfg;
}

fn strings(a: Allocator, v: std.json.Value) ![]const []const u8 {
    if (v != .array) return error.BadConfig;
    const out = try a.alloc([]const u8, v.array.items.len);
    for (v.array.items, out) |x, *o| o.* = if (x == .string) x.string else return error.BadConfig;
    return out;
}

// ---------------------------------------------------------------- this program's state

const state_head = relay.p2p_head;

const State = struct {
    s: w.store.Store,
    /// The catch-up cursor: served topic `tm_mandala_<txid>_0` → the last block height settled.
    cursor: Map,

    fn load(a: Allocator, s: w.store.Store) !State {
        const maps = try w.store.Maps.create(a, s);
        var st: State = .{ .s = s, .cursor = maps.map(null) };
        const c = (try vm.head(a, state_head)) orelse return st;
        const rec = try s.getValue(a, c);
        if (!eql(u8, rec.getText("kind") orelse "", "amm-p2p-state")) return error.BadState;
        const m = rec.get("maps") orelse return error.BadState;
        st.cursor = maps.map(m.getCid("cursor"));
        return st;
    }

    /// Save and advance the head when anything changed: → the state record's CID, or null.
    fn commit(self: *State, a: Allocator) !?[]const u8 {
        if (!self.cursor.dirty) return null;
        try self.cursor.flush();
        const c = try self.s.putValue(a, .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "amm-p2p-state" } },
            .{ .key = "maps", .value = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "cursor", .value = if (self.cursor.root) |r| .{ .cid = r } else .null },
            }) } },
        }) });
        try vm.advance(state_head, c);
        return c;
    }
};

fn intOf(v: ?w.store.MValue) u32 {
    const x = v orelse return 0;
    return if (x == .int and x.int >= 0 and x.int <= std.math.maxInt(u32)) @intCast(x.int) else 0;
}

/// The app's overlay state (`<app>/state`) over the chain app's (`chain/state`, read only), as the
/// step or call sees them (skein-overlay `engine_vm.load`).
fn loadState(a: Allocator, in: Value) !*ov.state.State {
    const st = try a.create(ov.state.State);
    st.* = (try ov.engine_vm.load(a, overlay_in orelse in)).st;
    st.now = @intCast(in.getUint("now") orelse in.getUint("at") orelse 0);
    return st;
}

// ---------------------------------------------------------------- calls

fn call(a: Allocator, in: Value) !void {
    const func = in.getText("fn") orelse return error.BadInput;
    const arg = try vm.callArg(a, in);
    if (eql(u8, func, "call") and arg.get("match") != null) return vm.answer(a, try appRoute(a, in, arg));
    // The read route `/` (shruggr/skein#143): its filter `page`, answering `{answer: <the page>}`.
    if (eql(u8, func, "serve")) {
        const page = try servePages(a, arg);
        return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, page) else page);
    }
    // The reads (0.9.0): the holders' listing requests, and the chain state of an outpoint.
    if (eql(u8, func, "requests")) {
        const ans = try requestsRead(a, in);
        return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, ans) else ans);
    }
    if (eql(u8, func, "spends")) {
        const ans = try spendsRead(a, in, arg);
        return vm.answer(a, if (isFilter(in)) try asFilterAnswer(a, ans) else ans);
    }
    if (isAppFn(func)) return vm.answer(a, try appCall(a, in, func, arg));
    if (eql(u8, func, "proofsByBlock")) return vm.answer(a, try proofsByBlock(a, in, arg));
    return error.UnknownFunction;
}

fn headRecord(a: Allocator, name: []const u8) !?Value {
    const c = (try vm.head(a, name)) orelse return null;
    return try vm.store().getValue(a, c);
}

/// The engine's registered topics (`<app>/topics`).
fn registeredTopics(a: Allocator, in: Value) ![]const []const u8 {
    const rec = (try headRecord(a, try ov.topics.headName(a, ov.calls.appOf(overlay_in orelse in)))) orelse return &.{};
    const entries = try ov.topics.entriesOf(a, rec);
    const out = try a.alloc([]const u8, entries.len);
    for (entries, out) |e, *o| o.* = e.topic;
    return out;
}

/// The read `/requests` (filter `requests`): the holders' listing requests, newest first, less the
/// tokens registered already (reads.zig).
fn requestsRead(a: Allocator, in: Value) !Value {
    const rs = try reads.list(a, vm.store(), try headRecord(a, reads.requests_head), try registeredTopics(a, in));
    return reads.httpJson(a, 200, try reads.requestsJson(a, rs));
}

/// The read `/spends?outpoint=<txid>.<vout>` (filter `spends`): the chain state of an outpoint
/// (reads.zig `spendOf`).
fn spendsRead(a: Allocator, in: Value, arg: Value) !Value {
    const op = reads.queryOutpoint(arg.getText("query") orelse "") orelse return reads.httpJson(a, 400, "{\"error\":\"want ?outpoint=<txid>.<vout>\"}");
    const st = try loadState(a, in);
    return reads.httpJson(a, 200, try reads.spendJson(a, try reads.spendOf(a, st.ch, op)));
}

/// A holder's listing request, a message `{fn: "request", args: {tokenId}}` in the box
/// `amm/requests` (0.9.0): recorded under the head `amm/requests`; nothing else runs.
fn listingRequest(a: Allocator, in: Value, args: Value) !void {
    const s = vm.store();
    const body = try s.getValue(a, args.getCid("body") orelse return error.BadInput);
    if (!eql(u8, body.getText("fn") orelse "", "request")) return error.BadMessage;
    const token = (body.get("args") orelse return error.BadMessage).getText("tokenId") orelse return error.BadMessage;
    const sender = args.getBytes("sender") orelse return error.BadInput;
    const at: u64 = in.getUint("at") orelse in.getUint("now") orelse 0;
    const rec = try reads.record(a, s, try headRecord(a, reads.requests_head), token, sender, at);
    try vm.advance(reads.requests_head, try s.putValue(a, rec));
    _ = try vm.finish(a, s, try resultRecord(a, "request", &.{.{ .key = "tokenId", .value = .{ .text = try reads.tokenIdText(a, token) } }}));
}

/// The serving side of the direct call: one request frame, one reply frame. A utility since 0.2.0:
/// no row routes `/amm/proofs/1.0.0` (sync is shruggr/skein#112's `want`).
fn proofsByBlock(a: Allocator, in: Value, arg: Value) !Value {
    const msg = try libp2p.inbound(arg);
    return libp2p.directAnswer(a, try proofs.serve(a, views.held(try loadState(a, in)), msg.body));
}

// ---------------------------------------------------------------- outbound: emit to a provider

/// The key of this host's provider `name` (`libp2p`, `cron`): the address book's entry at (`local`,
/// `name`) (skein-sdk 0.7 `sk.peerAt`; the book has no roles, shruggr/skein#126).
fn providerKey(a: Allocator, name: []const u8) ![]const u8 {
    const k = (try sk.peerAt(a, "local", name)) orelse return error.NoProvider;
    return if (k.len == 33) k else error.NoProvider;
}

/// Emit `body` to `to` in `box` (docs/MESSAGES.md "emit"): → the message's CID. It goes out when the step ends without error.
fn emit(a: Allocator, to: []const u8, box: []const u8, body: Value) ![]const u8 {
    const msg = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "to", .value = .{ .bytes = to } },
        .{ .key = "box", .value = .{ .text = box } },
        .{ .key = "body", .value = .{ .bytes = try cbor.encode(a, body) } },
    }) });
    return vm.result(a, vm.sk.emit, .{ msg.ptr, @as(u32, @intCast(msg.len)) });
}

fn toLibp2p(a: Allocator, r: libp2p.Request) ![]const u8 {
    return emit(a, try providerKey(a, "libp2p"), r.box, r.body);
}

fn walletCall(a: Allocator, frame: []const u8) ![]const u8 {
    return vm.result(a, ext.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
}

/// This instance's libp2p peer ID (David, 2026-10-05): the signer's public key for protocol
/// `[2, "skein instance"]` (skein src/host/signer.ts `INSTANCE_PROTOCOL`), key ID
/// `libp2p:<handle>`, counterparty self, as an identity multihash (libp2p.zig `peerIdOf`).
/// The host derives its node's key the same way, from the instance's root (skein 387e057,
/// src/host/signer.ts `peerKey`: `[2, "skein instance"]` / `libp2p:<handle>` / self), so this
/// is the peer ID the node runs.
fn selfPeerId(a: Allocator, in: Value) ![]const u8 {
    const me = in.get("self") orelse return error.NoSelf;
    const handle = me.getText("handle") orelse return error.NoHandle;
    const key_id = try std.fmt.allocPrint(a, "libp2p:{s}", .{handle});
    const pk = try wire.publicKeyResult(try walletCall(a, try wire.getPublicKeyFrameFor(a, libp2p.instance_protocol.level, libp2p.instance_protocol.name, key_id, .self, null)));
    return libp2p.peerIdOf(a, pk);
}

// ---------------------------------------------------------------- steps

fn step(a: Allocator, in: Value) !void {
    const s = vm.store();
    const args = in.get("args") orelse return error.BadInput;
    // The relay thread (launched by amm.swap.submit or amm.pool.submit).
    if (relay.Kind.ofRelay(args.getText("kind") orelse "")) |kind| return relayStep(a, in, args, kind);
    // A holder's listing request in the box `amm/requests` (0.9.0).
    if (eql(u8, args.getText("box") orelse "", reads.requests_box)) return listingRequest(a, in, args);
    // A message in this program's box `amm/amm-p2p`: a call {fn, args} (APPS.md §4). (Before
    // 0.7.0 the app's box `amm`, shared with the overlay engine by sender; since shruggr/skein#143 a
    // box has one route, and `amm` is the engine's: its own watch, resume and wait.)
    if (eql(u8, args.getText("box") orelse "", names.own_box)) {
        // Stepped again when the relay thread it launched comes to rest: the relay answered the sender.
        if (in.get("resolved") != null) {
            _ = try vm.finish(a, s, try resultRecord(a, "relayed", &.{}));
            return;
        }
        if (args.getCid("body")) |bc| {
            const body = try s.getValue(a, bc);
            if (body.get("fn") != null) return appMessage(a, in, args, body);
        }
    }
    const at: u64 = in.getUint("at") orelse return error.BadInput;
    var st = try State.load(a, s);
    var fields: std.ArrayList(cbor.Entry) = .empty;
    var op: []const u8 = undefined;

    const reply = in.get("reply");
    const resumed = (reply != null and reply.? == .map) or (in.getBool("woke") orelse false);
    if (resumed) {
        // A catch-up pass's thread, stepped by the libp2p provider's answer or its deadline.
        op = "catchup";
        try catchup(a, in, &st, at, &fields);
    } else if (args.getCid("event") != null) {
        // No event is this program's since 0.4.0 (0.3.x's accepted heartbeats, `amm-live`, are gone).
        return error.BadEvent;
    } else if (args.getCid("body")) |bc| {
        const body = try s.getValue(a, bc);
        const sender = args.getBytes("sender") orelse return error.BadInput;
        // 0.6.0: no `validate` / `unvalidate` (the engine's `register` drives the validator role) and
        // no start or stop (the engine's `register` drives the beacons and the market's liveness).
        op = body.getText("kind") orelse return error.BadMessage;
        if (!eql(u8, op, schedule.tick_kind)) return error.BadMessage;
        if (!eql(u8, sender, try providerKey(a, "cron"))) return error.NotTheCronProvider;
        const job = try schedule.jobOf(body);
        try fields.append(a, .{ .key = "job", .value = .{ .text = @tagName(job) } });
        switch (job) {
            .catchup => try catchup(a, in, &st, at, &fields),
        }
    } else return error.BadInput;

    if (try st.commit(a)) |c| try fields.append(a, .{ .key = "state", .value = .{ .cid = c } });
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-p2p-result" } },
        .{ .key = "op", .value = .{ .text = op } },
    });
    try es.appendSlice(a, fields.items);
    _ = try vm.finish(a, s, .{ .map = es.items });
}

/// Whether this call is a filter's: the input's `filter: true` (skein docs/APPS.md §2 "Filters").
fn isFilter(in: Value) bool {
    const f = in.get("filter") orelse return false;
    return f == .boolean and f.boolean;
}

/// An http answer `{status, type?, headers?, body}` as a filter's `{answer: …}`.
fn asFilterAnswer(a: Allocator, http: Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "answer", .value = http }}) };
}

/// The read `/` (`{address: "/", prefix: true, program: "amm-p2p", fn: "serve", root: "www", index:
/// "index.html"}` in the manifest's `reads[]`, shruggr/skein#135; the read is the request's `match`):
/// the app's pages from its own tree, the installed app record's `tree` (skein-sdk `files.serve`,
/// shruggr/skein#125). It reads only: the head `amm/app` and the tree's blobs.
fn servePages(a: Allocator, arg: Value) !Value {
    const req = try toSdk(a, arg);
    const m = try app.manifestOf(a, relay.app_name);
    return fromSdk(a, try files.serve(a, req, scbor.Value.cidOf(m.get("tree")), files.rowOptions(req)));
}

// ---------------------------------------------------------------- catch-up (the pull half, placeholder)

/// The peers to ask, as `dial` takes them: the configured ones (`ammP2p.peers`). Since 0.4.0 no
/// validator map adds the ones heard from (liveness is the runtime's, #138).
fn catchupPeers(cfg: Config) []const []const u8 {
    return cfg.peers;
}

/// Where a catch-up pass is: the topic (index into the configured topics),
/// the block being asked for and the last of the pass's batch, the peers and
/// which one is being asked, the dial message whose answers the thread
/// awaits (the libp2p provider answers a dial with `{stream}`, then each
/// frame read, all naming the dial), the direct call once open, and the
/// deadline. Carried from step to step in the thread's result record
/// (`catchup`).
const Pass = struct {
    topic: u32,
    height: u32,
    to: u32,
    peers: []const []const u8,
    peer: u32 = 0,
    dial: ?[]const u8 = null,
    stream: ?u64 = null,
    until: u64 = 0,

    fn value(p: Pass, a: Allocator) !Value {
        const ps = try a.alloc(Value, p.peers.len);
        for (p.peers, ps) |x, *o| o.* = .{ .text = x };
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "topic", .value = .{ .uint = p.topic } },
            .{ .key = "height", .value = .{ .uint = p.height } },
            .{ .key = "to", .value = .{ .uint = p.to } },
            .{ .key = "peers", .value = .{ .array = ps } },
            .{ .key = "peer", .value = .{ .uint = p.peer } },
            .{ .key = "dial", .value = if (p.dial) |c| .{ .cid = c } else .null },
            .{ .key = "stream", .value = if (p.stream) |x| .{ .uint = x } else .null },
            .{ .key = "until", .value = .{ .uint = p.until } },
        }) };
    }

    fn of(a: Allocator, v: Value) !Pass {
        const pv = v.getArray("peers") orelse return error.BadPass;
        const ps = try a.alloc([]const u8, pv.len);
        for (pv, ps) |x, *o| o.* = if (x == .text) x.text else return error.BadPass;
        return .{
            .topic = @intCast(v.getUint("topic") orelse return error.BadPass),
            .height = @intCast(v.getUint("height") orelse return error.BadPass),
            .to = @intCast(v.getUint("to") orelse return error.BadPass),
            .peers = ps,
            .peer = @intCast(v.getUint("peer") orelse 0),
            .dial = v.getCid("dial"),
            .stream = v.getUint("stream"),
            .until = v.getUint("until") orelse 0,
        };
    }

    fn nextPeer(p: *Pass) void {
        p.peer += 1;
        p.dial = null;
        p.stream = null;
    }

    fn nextBlock(p: *Pass) void {
        p.height += 1;
        p.peer = 0;
        p.dial = null;
        p.stream = null;
    }
};

/// The pass the thread's last step left, from its result record (the
/// update's stdout is the record's CID in hex, vm.finish).
fn resumedPass(a: Allocator, in: Value) !?Pass {
    const s = vm.store();
    const tip = in.getCid("tip") orelse return null;
    const u = try s.getValue(a, tip);
    const res = u.get("result") orelse return null;
    const out = std.mem.trim(u8, res.getBytes("stdout") orelse return null, " \n");
    if (out.len == 0 or out.len % 2 != 0) return null;
    const cid = try a.alloc(u8, out.len / 2);
    _ = std.fmt.hexToBytes(cid, out) catch return null;
    const rec = s.getValue(a, cid) catch return null;
    return Pass.of(a, rec.get("catchup") orelse return null) catch null;
}

/// Rest the thread on the dial's answers until the pass's deadline.
fn rest(a: Allocator, p: Pass, fields: *std.ArrayList(cbor.Entry)) !void {
    try vm.awaitRecord(p.dial.?);
    try vm.deadline(@intCast(p.until));
    try fields.append(a, .{ .key = "catchup", .value = try p.value(a) });
}

/// One catch-up step. Started by a tick (no pass yet), or stepped again by
/// the libp2p provider's answer to the pass's dial (`{stream}`, a frame,
/// its end, an error) or by the deadline: take what came, then ask on, one
/// block and one peer at a time, while the topics have unsettled
/// transactions; rest on the next dial, or end the pass.
fn catchup(a: Allocator, in: Value, st: *State, at: u64, fields: *std.ArrayList(cbor.Entry)) !void {
    const cfg = try config(a, in);
    const st0 = try loadState(a, in);
    st0.now = @intCast(at);
    const ch = st0.ch;
    var proven: u64 = 0;
    var settled: u64 = 0;
    defer fields.append(a, .{ .key = "proven", .value = .{ .uint = settled + proven } }) catch {};
    var cur: ?Pass = try resumedPass(a, in);
    var next_topic: u32 = if (cur) |p| p.topic + 1 else 0;

    const reply: ?Value = if (in.get("reply")) |r| (if (r == .map) r else null) else null;
    if (cur) |*p| if (p.dial) |dial| {
        if (reply) |r| {
            const reply_to = r.getCid("replyTo") orelse "";
            const box = r.getText("box") orelse "";
            const body = try vm.store().getValue(a, r.getCid("body") orelse return error.BadInput);
            if (!eql(u8, reply_to, dial)) {
                // Not this dial's answer (a late one): rest again.
                if (at < p.until) return rest(a, p.*, fields);
                p.nextPeer();
            } else switch (libp2p.dialAnswer(box, body) catch libp2p.DialAnswer{ .closed = "BadAnswer" }) {
                .opened => |sid| {
                    // The direct call is open: send the request, rest on its reply frame.
                    p.stream = sid;
                    if (p.topic >= cfg.topics.len) return error.TopicsChanged;
                    const hdr = (try ch.chain().at(p.height)) orelse return error.NoHeader;
                    _ = try toLibp2p(a, try libp2p.send(a, sid, try proofs.encodeRequest(a, .{ .block_hash = hdr.hash, .topic = cfg.topics[p.topic] })));
                    if (at < p.until) return rest(a, p.*, fields);
                    _ = try toLibp2p(a, try libp2p.close(a, sid));
                    p.nextPeer();
                },
                .frame => |frame| {
                    if (p.stream) |sid| _ = try toLibp2p(a, try libp2p.close(a, sid));
                    if (try takeReply(a, st0, p.height, frame)) |k| {
                        proven += k;
                        p.nextBlock();
                    } else p.nextPeer();
                },
                .closed => p.nextPeer(),
            }
        } else {
            // The deadline: no answer in time.
            if (p.stream) |sid| _ = try toLibp2p(a, try libp2p.close(a, sid));
            p.nextPeer();
        }
    };

    const tip = (try ch.chain().tip()) orelse return finishCatchup(proven);
    while (true) {
        if (cur == null) {
            // The next topic with a plan; a topic with nothing unsettled has its cursor follow the tip.
            while (next_topic < cfg.topics.len) : (next_topic += 1) {
                const topic = cfg.topics[next_topic];
                const ck = try w.store.nameKey(a, topic, &.{});
                const cursor: ?u32 = if (try st.cursor.get(ck)) |v| intOf(v) else null;
                const plan = proofs.catchupPlan(cursor, tip, cfg.window, cfg.batch, try unsettled(st0, topic)) orelse continue;
                if (plan.from > plan.to) {
                    try st.cursor.put(ck, .{ .int = plan.cursor });
                    continue;
                }
                cur = .{ .topic = next_topic, .height = plan.from, .to = plan.to, .peers = catchupPeers(cfg) };
                next_topic += 1;
                break;
            }
            if (cur == null) break;
        }
        const p = &cur.?;
        if (p.topic >= cfg.topics.len) {
            cur = null;
            continue;
        }
        if (p.height > p.to) {
            try st.cursor.put(try w.store.nameKey(a, cfg.topics[p.topic], &.{}), .{ .int = p.to });
            cur = null;
            continue;
        }
        if (p.peer >= @min(p.peers.len, 3)) {
            p.nextBlock();
            continue;
        }
        if ((try ch.chain().at(p.height)) == null) {
            p.nextBlock();
            continue;
        }
        // Dial the peer on the proofs protocol and rest on the provider's answers.
        try finishCatchup(proven);
        settled += proven;
        proven = 0;
        p.dial = try toLibp2p(a, try libp2p.dial(a, p.peers[p.peer], names.proofs_protocol));
        p.stream = null;
        p.until = at + cfg.reply_timeout_ms;
        return rest(a, p.*, fields);
    }
    return finishCatchup(proven);
}

/// Settle what the pass proved. STOP (shruggr/skein#120, skein-amm docs/AMM.md "Not built"): in
/// amm-poc the pass applied each proof to the chain core under the head `wallet` (the transitional
/// `wallet` grant), called the `rejected` hooks and advanced that head here. Since skein #79 the
/// chain state is the chain app's alone (`chain/state`); a program of this app writes only `amm/…`
/// and has no way to record a proof it fetched. Nothing is recorded; `takeReply` stops first.
fn finishCatchup(proven: u64) !void {
    if (proven == 0) return;
    return error.CatchupCannotRecordProofs;
}

/// Whether the topic has transactions not yet proven (the chain state's `unproven` index joined to
/// the topic's `applied`, the overlay's).
fn unsettled(st: *ov.state.State, topic: []const u8) !bool {
    for (try st.ch.map("unproven").prefixed("")) |kv| {
        if (kv.key.len == 32 and try st.isApplied(topic, kv.key[0..32].*)) return true;
    }
    return false;
}

/// A proofs-by-block reply for the block at `height`: checked against the
/// header → how many held unproven transactions it proves, or null when the
/// reply is missing or does not check (ask the next peer). STOP: recording
/// them is not possible here (`finishCatchup`): a reply that proves any is
/// an error of the pass, `CatchupCannotRecordProofs`.
fn takeReply(a: Allocator, st: *ov.state.State, height: u32, reply: []const u8) !?u64 {
    const bump = (proofs.decodeReply(a, reply) catch return null) orelse return null;
    const root = switch (try proofs.rootOf(a, bump)) {
        .root => |r| r,
        .bad => return null,
    };
    const hdr = (try st.ch.chain().at(height)) orelse return null;
    if (!eql(u8, &root, &(try w.header.Header.parse(&hdr.raw)).merkle_root)) return null;
    const p = w.merkle.MerklePath.parse(a, bump) catch return null;
    if (p.block_height != height) return null;
    var n: u64 = 0;
    for (try proofs.leaves(a, p)) |t| {
        if ((try views.status(st, t)) != .unproven) continue;
        n += 1;
    }
    if (n > 0) return error.CatchupCannotRecordProofs;
    return n;
}

// ---------------------------------------------------------------- the app: amm.swap/1 (the marketplace relay)

/// The SDK's dag-cbor and the wallet library's are the same encoding; values cross by bytes.
fn toSdk(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}

fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}

/// The installed app record (the head `amm/app`'s root, `kind: "app"`), or null.
fn appRecord(a: Allocator) !?Value {
    const c = (try vm.head(a, relay.app_head)) orelse return null;
    const v = try vm.store().getValue(a, c);
    return if (eql(u8, v.getText("kind") orelse "", "app")) v else null;
}

/// The app's head as this program keeps it: the installed app record and its
/// `state`, or (no app record: an instance wired by its genesis) the root as
/// the state record itself.
const AppHead = struct {
    record: ?Value,
    state: ?Value,

    fn load(a: Allocator) !AppHead {
        const c = (try vm.head(a, relay.app_head)) orelse return .{ .record = null, .state = null };
        const s = vm.store();
        const v = try s.getValue(a, c);
        if (eql(u8, v.getText("kind") orelse "", "app")) {
            const st = if (v.getCid("state")) |sc| try s.getValue(a, sc) else null;
            return .{ .record = v, .state = st };
        }
        if (eql(u8, v.getText("kind") orelse "", relay.state_kind)) return .{ .record = null, .state = v };
        return error.NotTheAppsHead;
    }

    /// Keep the book's state under the head: the app record with `state` replaced (APPS.md §1), or the state as the root.
    fn save(h: *AppHead, a: Allocator, book: *relay.Book) !void {
        const s = vm.store();
        const st = try book.state(a);
        const sc = try s.putValue(a, st);
        if (h.record) |rec| {
            var es: std.ArrayList(cbor.Entry) = .empty;
            for (rec.map) |e| if (!eql(u8, e.key, "state")) try es.append(a, e);
            try es.append(a, .{ .key = "state", .value = .{ .cid = sc } });
            const root: Value = .{ .map = es.items };
            try vm.advance(relay.app_head, try s.putValue(a, root));
            h.record = root;
        } else try vm.advance(relay.app_head, sc);
        h.state = st;
    }
};

/// The manifest the dispatch reads `provides` from: the installed app record,
/// else (wired by the genesis) `{kind: "app", name: "amm", provides}` with
/// `provides` from genesis `defaults.ammProvides` (the manifest's, as JSON).
fn manifest(a: Allocator, in: Value) !scbor.Value {
    if (try appRecord(a)) |rec| return toSdk(a, rec);
    const d = in.get("defaults") orelse return sk.report("no app record (head amm/app) and no defaults.ammProvides");
    const text = d.getText("ammProvides") orelse return sk.report("no app record (head amm/app) and no defaults.ammProvides");
    const provides = dagjson.decode(a, text) catch return sk.report("defaults.ammProvides is not JSON");
    var m = scbor.MapBuilder.init(a);
    try m.put("kind", scbor.string("app"));
    try m.put("name", scbor.string(relay.app_name));
    try m.put("provides", provides);
    return m.value();
}

/// How the function was reached, and what it did that the caller's answer depends on.
const Ctx = struct {
    in: Value,
    mode: enum { route, message, call },
    /// A message's request (answered by the relay thread when the record settles).
    request: ?relay.Request = null,
    /// A route call's own program record (launching the relay thread).
    arg: ?Value = null,
    /// The answer waits on a thread (the route answers {wait: true}).
    waiting: bool = false,
    /// The relay thread was launched for this call: a message's answer comes from it.
    launched: bool = false,
};
var ctx: Ctx = undefined;

const fns = [_]app.Function{
    .{ .name = relay.fn_submit, .run = submitFn },
    .{ .name = relay.fn_status, .run = statusFn },
    .{ .name = relay.fn_terms, .run = termsFn },
    .{ .name = relay.fn_pool_submit, .run = poolSubmitFn },
    .{ .name = relay.fn_pool_status, .run = poolStatusFn },
    .{ .name = relay.fn_pool_terms, .run = poolTermsFn },
};

fn isAppFn(name: []const u8) bool {
    for (fns) |f| if (eql(u8, f.name, name)) return true;
    return false;
}

/// A function's failure with the VM import's message when it has one.
fn failure(a: Allocator, e: anyerror) anyerror {
    if (e == error.Reported or e == error.OutOfMemory) return e;
    return sk.report(std.fmt.allocPrint(a, "{s}{s}{s}", .{ @errorName(e), if (vm.lastError().len > 0) ": " else "", vm.lastError() }) catch "failed");
}

fn submitFn(c: *app.Call) anyerror!scbor.Value {
    return submit(c, .swap) catch |e| failure(c.a, e);
}

fn statusFn(c: *app.Call) anyerror!scbor.Value {
    return recordStatus(c, .swap) catch |e| failure(c.a, e);
}

fn poolSubmitFn(c: *app.Call) anyerror!scbor.Value {
    return submit(c, .pool) catch |e| failure(c.a, e);
}

fn poolStatusFn(c: *app.Call) anyerror!scbor.Value {
    return recordStatus(c, .pool) catch |e| failure(c.a, e);
}

/// The validator's terms (0.9.0, David Case 2026-10-09: "Fees are the validator's"): this
/// instance's `config.amm.ammValidator` `{lpFeeBps, validatorFeeBps, commissionBps}` (amm-validator
/// reads the same; the defaults 30, 5, 0), with this instance's identity and peer ID (the
/// validator a deploy here names: its `amm.pool.submit` is relayed in-VM).
const ValidatorTerms = struct { lpFeeBps: i64 = 30, validatorFeeBps: i64 = 5, commissionBps: i64 = 0 };

fn validatorTerms(a: Allocator, in: Value) !ValidatorTerms {
    const text = (try configText(a, in, "ammValidator", "ammValidator")) orelse return .{};
    return std.json.parseFromSliceLeaky(ValidatorTerms, a, text, .{ .ignore_unknown_fields = true }) catch error.BadConfig;
}

/// amm.pool.terms {} → {validator: <identity, bytes 33>, peerId?: text, lpFeeBps, validatorFeeBps, commissionBps}.
fn poolTermsFn(c: *app.Call) anyerror!scbor.Value {
    const a = c.a;
    const t = validatorTerms(a, ctx.in) catch |e| return failure(a, e);
    var m = scbor.MapBuilder.init(a);
    if (ctx.in.get("self")) |me| if (me.getBytes("identity")) |k| try m.put("validator", .{ .bytes = k });
    if (selfPeerText(a, ctx.in)) |p| try m.put("peerId", scbor.string(p));
    try m.put("lpFeeBps", scbor.int(t.lpFeeBps));
    try m.put("validatorFeeBps", scbor.int(t.validatorFeeBps));
    try m.put("commissionBps", scbor.int(t.commissionBps));
    return m.value();
}

/// amm.swap.terms {} → {commissionPkh: bytes(20) | null}: what the page names
/// as Swap's commissionPkh before it builds the swap.
fn termsFn(c: *app.Call) anyerror!scbor.Value {
    return toSdk(c.a, relay.terms(c.a, commissionConfig(c.a, ctx.in) catch |e| return failure(c.a, e)) catch |e| return failure(c.a, e));
}

/// amm.swap.status / amm.pool.status {id} → the record (or the error `not_found`).
fn recordStatus(c: *app.Call, kind: relay.Kind) !scbor.Value {
    const a = c.a;
    const h = try AppHead.load(a);
    var book = try relay.Book.load(a, vm.store(), h.state);
    return switch (try relay.statusOf(a, &book, kind, try fromSdk(a, c.args))) {
        .found => |r| toSdk(a, try r.answer(a)),
        .not_found => sk.report("not_found"),
        .bad_id => sk.report("bad_id: 64 hex characters"),
    };
}

/// This program's own record, to launch the relay thread as: a route call's
/// matched entry (an installed route), a step's thread's program, else the
/// genesis's `programs["amm-p2p"]`.
fn selfProgram(a: Allocator, in: Value) ![]const u8 {
    if (ctx.arg) |arg| if (arg.get("match")) |m| if (m.getCid("program")) |p| return p;
    if (in.getCid("thread")) |t| if ((try vm.store().getValue(a, t)).getCid("program")) |p| return p;
    if (in.get("programs")) |ps| if (ps.getCid("amm-p2p")) |p| return p;
    return error.NoProgramRecord;
}

var env_call: *app.Call = undefined;

/// This node's own peer ID (base58), or null when it cannot be had (no handle): a caller naming it
/// names this instance's own validator (relay.zig `isSelf`).
fn selfPeerText(a: Allocator, in: Value) ?[]const u8 {
    const id = selfPeerId(a, in) catch return null;
    return libp2p.peerIdText(a, id) catch null;
}

/// The relay thread: this program on {kind: "amm-swap-relay" | "amm-pool-relay", id}.
fn envLaunch(_: *anyopaque, a: Allocator, kind: relay.Kind, id: [32]u8) anyerror![]const u8 {
    const targs = try vm.store().putValue(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = kind.relayKind() } },
        .{ .key = "id", .value = .{ .bytes = try a.dupe(u8, &id) } },
    }) });
    return env_call.launch(try selfProgram(a, ctx.in), targs);
}

/// amm.swap.submit {funding, swap, pool, validator, peerId, expires} (relay.zig
/// `submit`) and amm.pool.submit {funding, deploy, validator, peerId, expires}
/// (relay.zig `submitDeploy`): check, record `pending` under the app's head,
/// launch the relay thread → the record. The same request again answers its
/// record (a `/call` waits on its relay while it is pending); one that timed
/// out or failed in transport is relayed again.
fn submit(c: *app.Call, kind: relay.Kind) !scbor.Value {
    const a = c.a;
    const in = ctx.in;
    var h = try AppHead.load(a);
    var book = try relay.Book.load(a, vm.store(), h.state);
    env_call = c;
    const env: relay.Env = .{
        .book = &book,
        .now = in.getUint("now") orelse in.getUint("at") orelse 0,
        .commission = try commissionConfig(a, in),
        .request = ctx.request,
        .ctx = &signer_dummy,
        .self_peer = selfPeerText(a, in),
        .launchFn = envLaunch,
    };
    const args = try fromSdk(a, c.args);
    const submitted = switch (kind) {
        .swap => try relay.submit(a, env, args),
        .pool => try relay.submitDeploy(a, env, args),
    };
    switch (submitted) {
        .refused => |r| return sk.report(try relay.refusalText(a, r)),
        .settled => |rec| return toSdk(a, try rec.answer(a)),
        .pending => |rec| {
            // The relay is under way: a route waits on its thread (at rest already: answered from the record).
            if (ctx.mode == .route) if (rec.thread) |t| {
                if (c.awaitRecord(t)) {
                    ctx.waiting = true;
                } else |_| {}
            };
            return toSdk(a, try rec.answer(a));
        },
        .launched => |rec| {
            try h.save(a, &book);
            ctx.launched = true;
            ctx.waiting = true;
            return toSdk(a, try rec.answer(a));
        },
    }
}

fn dispatch(a: Allocator, in: Value, name: []const u8, args: ?scbor.Value, sender: ?[]const u8) !app.Outcome {
    return app.run(a, try toSdk(a, in), relay.app_name, try manifest(a, in), &fns, name, args, sender);
}

/// An in-VM call of amm.swap.*: the result, or the call's error.
fn appCall(a: Allocator, in: Value, func: []const u8, arg: Value) !Value {
    ctx = .{ .in = in, .mode = .call };
    return switch (try dispatch(a, in, func, try toSdk(a, arg), null)) {
        .ok => |v| fromSdk(a, v),
        .err => |f| {
            std.Io.File.stderr().writeStreamingAll(sk.io(), try std.fmt.allocPrint(a, "{s}: {s}: {s}\n", .{ func, @tagName(f.code), f.message })) catch {};
            return error.CallFailed;
        },
    };
}

fn routeAnswer(a: Allocator, status_code: u16, body: scbor.Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status_code } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = try dagjson.encode(a, body) } },
    }) };
}

fn failureValue(a: Allocator, f: app.Failure) !scbor.Value {
    var e = scbor.MapBuilder.init(a);
    try e.put("code", scbor.string(@tagName(f.code)));
    try e.put("message", scbor.string(f.message));
    return e.value();
}

/// The `/call` route (APPS.md §4; the SDK's `app` route, with one addition:
/// `amm.swap.submit` and `amm.pool.submit` wait on the relay thread). The body is `{fn, args}`
/// (JSON / dag-json, or dag-cbor as application/cbor); the answer `{fn,
/// result}` (200) or `{fn, error}` (400, 403, 404, 409, 500). A submit that
/// launched (or found) its relay answers `{wait: true}`; called again with
/// `resolved` when the relay thread comes to rest, it answers the record.
fn appRoute(a: Allocator, in: Value, arg: Value) !Value {
    ctx = .{ .in = in, .mode = .route, .arg = arg };
    const caller = arg.getBytes("caller");
    var name: []const u8 = "";
    var call_args: ?scbor.Value = null;
    const outcome: app.Outcome = blk: {
        if (!eql(u8, arg.getText("method") orelse "", "POST")) break :blk .{ .err = .{ .code = .@"bad-request", .message = "POST {fn, args}" } };
        const raw = arg.getBytes("body") orelse "";
        const ct = arg.getText("contentType") orelse "";
        const body = (if (eql(u8, ct, "application/cbor")) scbor.decode(a, raw) else dagjson.decode(a, raw)) catch
            break :blk .{ .err = .{ .code = .@"bad-request", .message = "the body is not {fn, args} (JSON, or dag-cbor as application/cbor)" } };
        if (body != .map) break :blk .{ .err = .{ .code = .@"bad-request", .message = "the body is not {fn, args}" } };
        name = scbor.Value.str(body.get("fn")) orelse break :blk .{ .err = .{ .code = .@"bad-request", .message = "fn is not text" } };
        call_args = body.get("args");
        if (arg.get("resolved") != null and relay.Kind.ofSubmit(name) != null) {
            const kind = relay.Kind.ofSubmit(name).?;
            // Called again: the relay thread this request waited on has come to rest. The record, as it stands.
            const sargs = try fromSdk(a, call_args orelse .null);
            const id = switch (kind) {
                .swap => relay.idOf(sargs.getBytes("swap") orelse ""),
                .pool => relay.deployId(a, sargs.getBytes("deploy") orelse "") orelse break :blk .{ .err = .{ .code = .failed, .message = "not_found" } },
            };
            const h = try AppHead.load(a);
            var book = try relay.Book.load(a, vm.store(), h.state);
            const rec = (try book.getKind(a, kind, id)) orelse break :blk .{ .err = .{ .code = .failed, .message = "not_found" } };
            break :blk .{ .ok = try toSdk(a, try rec.answer(a)) };
        }
        break :blk try dispatch(a, in, name, call_args, caller);
    };
    if (outcome == .ok and ctx.waiting and arg.get("resolved") == null)
        return .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "wait", .value = .{ .boolean = true } }}) };
    var ans = scbor.MapBuilder.init(a);
    try ans.put("fn", scbor.string(name));
    var code: u16 = 200;
    switch (outcome) {
        .ok => |v| try ans.put("result", v),
        .err => |f| {
            code = f.code.status();
            try ans.put("error", try failureValue(a, f));
        },
    }
    return routeAnswer(a, code, ans.value());
}

/// Whether the address book reaches `key` (an answer goes out only then).
fn reachable(a: Allocator, key: []const u8) !bool {
    const s = vm.store();
    const root = (try vm.head(a, "peers")) orelse return false;
    const book = try s.getValue(a, root);
    for (book.getArray("peers") orelse return false) |e| {
        const p = try s.getValue(a, e.getCid("peer") orelse continue);
        if (p.getBytes("key")) |k| if (eql(u8, k, key)) return true;
    }
    return false;
}

fn resultRecord(a: Allocator, op: []const u8, fields: []const cbor.Entry) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-p2p-result" } },
        .{ .key = "op", .value = .{ .text = op } },
    });
    try es.appendSlice(a, fields);
    return .{ .map = es.items };
}

/// Answer a message's sender in the app's box, when the address book reaches it (APPS.md §4).
fn answerSender(a: Allocator, sender: ?[]const u8, answer: Value) !bool {
    const s = sender orelse return false;
    if (!try reachable(a, s)) return false;
    _ = try emit(a, s, names.own_box, answer);
    return true;
}

/// A message `{fn, args}` in box `amm/amm-p2p`: the call, answered to the sender (in that box) now
/// — or, for a submit that launched the relay, by the relay thread when the
/// record settles.
fn appMessage(a: Allocator, in: Value, args: Value, body: Value) !void {
    const message = args.getCid("message") orelse return error.BadInput;
    const sender = args.getBytes("sender");
    ctx = .{ .in = in, .mode = .message, .request = if (sender) |sd| .{ .message = message, .sender = sd } else null };
    const sbody = try toSdk(a, body);
    const name = scbor.Value.str(sbody.get("fn"));
    const outcome: app.Outcome = if (name) |n|
        try dispatch(a, in, n, sbody.get("args"), sender)
    else
        .{ .err = .{ .code = .@"bad-request", .message = "fn is not text" } };
    const func = name orelse "";
    if (outcome == .ok and ctx.launched) {
        _ = try vm.finish(a, vm.store(), try resultRecord(a, func, &.{.{ .key = "relaying", .value = .{ .boolean = true } }}));
        return;
    }
    const answer = switch (outcome) {
        .ok => |v| try relay.answerMessage(a, func, message, try fromSdk(a, v)),
        .err => |f| try relay.errorMessage(a, func, message, @tagName(f.code), f.message),
    };
    const sent = try answerSender(a, sender, answer);
    _ = try vm.finish(a, vm.store(), try resultRecord(a, func, &.{
        .{ .key = "answer", .value = answer },
        .{ .key = "sent", .value = .{ .boolean = sent } },
    }));
}

// ---------------------------------------------------------------- the relay thread

var signer_dummy: u8 = 0;

fn signerIdentity(_: *anyopaque, a: Allocator) anyerror![33]u8 {
    return wire.publicKeyResult(try walletCall(a, try wire.identityKeyFrame(a)));
}

fn signerSign(_: *anyopaque, a: Allocator, hash: [32]u8) anyerror![]const u8 {
    return wire.signatureResult(try walletCall(a, try wire.createSignatureFrame(a, 2, relay.envelope_protocol, relay.envelope_key_id, .anyone, hash)));
}

/// This instance's identity, signing the package through the `wallet` import (BRC-169's message signature).
fn signer() relay.Signer {
    return .{ .ctx = &signer_dummy, .identityFn = signerIdentity, .signFn = signerSign };
}

/// One step of the relay thread {kind: "amm-swap-relay" | "amm-pool-relay",
/// id}: launched, or stepped again by the libp2p provider's answer to its
/// dial or by the deadline at `expires` (relay.zig `advance`).
fn relayStep(a: Allocator, in: Value, args: Value, kind: relay.Kind) !void {
    const s = vm.store();
    const idb = args.getBytes("id") orelse return error.BadInput;
    if (idb.len != 32) return error.BadInput;
    const id = idb[0..32].*;
    const now: u64 = in.getUint("at") orelse in.getUint("now") orelse return error.BadInput;
    var h = try AppHead.load(a);
    var book = try relay.Book.load(a, s, h.state);
    var rec = (try book.getKind(a, kind, id)) orelse {
        _ = try vm.finish(a, s, try resultRecord(a, "relay", &.{.{ .key = "missing", .value = .{ .boolean = true } }}));
        return;
    };
    if (rec.local) return localRelayStep(a, in, kind, id, now, &h, &book, &rec);

    var input: relay.Input = .start;
    var pkg: ?[]const u8 = null;
    if (in.get("reply")) |r| if (r == .map) {
        const reply_to = r.getCid("replyTo") orelse "";
        if (rec.dial == null or !eql(u8, reply_to, rec.dial.?)) {
            // Not this dial's answer (a late one): rest again.
            if (rec.dial) |d| try vm.awaitRecord(d);
            try vm.deadline(@intCast(rec.expires));
            _ = try vm.finish(a, s, try resultRecord(a, "relay", &.{.{ .key = "late", .value = .{ .boolean = true } }}));
            return;
        }
        const body = try s.getValue(a, r.getCid("body") orelse return error.BadInput);
        input = .{ .answer = libp2p.dialAnswer(r.getText("box") orelse "", body) catch .{ .closed = "BadAnswer" } };
        if (input.answer == .opened and rec.status == .pending) pkg = try relay.packageFor(a, signer(), rec);
    };
    if (input == .start and (in.getBool("woke") orelse false)) input = .woke;

    const fx = try relay.advance(a, &rec, input, now, pkg);
    const lp = try providerKey(a, "libp2p");
    for (fx.emits, 0..) |req, i| {
        const m = try emit(a, lp, req.box, req.body);
        if (fx.dial) |di| if (di == i) {
            rec.dial = m;
        };
    }
    try book.put(a, rec);
    try h.save(a, &book);
    if (fx.rest) {
        try vm.awaitRecord(rec.dial orelse return error.NoDial);
        try vm.deadline(@intCast(rec.expires));
    }
    var sent = false;
    if (fx.done) if (rec.request) |q| {
        sent = try answerSender(a, q.sender, try relay.answerMessage(a, kind.submitFn(), q.message, try rec.answer(a)));
    };
    _ = try vm.finish(a, s, try resultRecord(a, "relay", &.{
        .{ .key = "relay", .value = .{ .text = kind.relayKind() } },
        .{ .key = "id", .value = .{ .text = try a.dupe(u8, &relay.idText(id)) } },
        .{ .key = "status", .value = .{ .text = @tagName(rec.status) } },
        .{ .key = "answered", .value = .{ .boolean = sent } },
    }));
}

/// The relay to this instance's own validator (`rec.local`: the peer named is this node; 0.4.0,
/// David 2026-10-06). A node does not dial itself: the relay does what the front door does with a
/// frame on `/amm-validator/1/<call>` (skein programs/frontdoor libp2p.zig `stepped`) — it calls the
/// route's handler, amm-validator's fn, in-VM from this step with the same package as the frame's
/// body (`callValidator`). The handler's `{wait: true}` means it awaited its submission in this
/// step, so this thread rests on that (and the deadline at `expires`); stepped again by the
/// engine's answer (`reply`) or the awaited thread at rest (`resolved`), it calls the handler again
/// with it. `{verdict, body}` is the reply frame: the record settles (relay.zig `localAnswer`).
fn localRelayStep(a: Allocator, in: Value, kind: relay.Kind, id: [32]u8, now: u64, h: *AppHead, book: *relay.Book, rec: *relay.Record) !void {
    const s = vm.store();
    const reply: ?Value = if (in.get("reply")) |r| (if (r == .map) r else null) else null;
    const resolved = in.get("resolved");
    const input: relay.LocalInput = if (reply != null or resolved != null) .again else if (in.getBool("woke") orelse false) .woke else .start;
    var fx = relay.advanceLocal(rec, input, now);
    if (fx.call) {
        const pkg = try relay.packageFor(a, signer(), rec.*);
        var why: []const u8 = "";
        const ans: ?Value = callValidator(a, in, kind, pkg, reply, resolved) catch |e| blk: {
            why = std.fmt.allocPrint(a, "{s}{s}{s}", .{ @errorName(e), if (vm.lastError().len > 0) ": " else "", vm.lastError() }) catch @errorName(e);
            break :blk null;
        };
        fx = relay.localAnswer(a, rec, ans, why);
    }
    try book.put(a, rec.*);
    try h.save(a, book);
    if (fx.rest) try vm.deadline(@intCast(rec.expires));
    var sent = false;
    if (fx.done) if (rec.request) |q| {
        sent = try answerSender(a, q.sender, try relay.answerMessage(a, kind.submitFn(), q.message, try rec.answer(a)));
    };
    _ = try vm.finish(a, s, try resultRecord(a, "relay", &.{
        .{ .key = "relay", .value = .{ .text = kind.relayKind() } },
        .{ .key = "id", .value = .{ .text = try a.dupe(u8, &relay.idText(id)) } },
        .{ .key = "local", .value = .{ .boolean = true } },
        .{ .key = "status", .value = .{ .text = @tagName(rec.status) } },
        .{ .key = "answered", .value = .{ .boolean = sent } },
    }));
}

/// The validator program's record: the installed app record's `programs["amm-validator"]`, else
/// the genesis's `programs["amm-validator"]`.
fn validatorProgram(a: Allocator, in: Value) ![]const u8 {
    if (try appRecord(a)) |rec| if (rec.get("programs")) |ps| if (ps.getCid("amm-validator")) |p| return p;
    if (in.get("programs")) |ps| if (ps.getCid("amm-validator")) |p| return p;
    return error.NoValidatorProgram;
}

/// amm-validator's fn for `kind` (`swap`, `deploy`: its route's `fn`, the package's
/// box), called in-VM with the argument the front door gives a frame's handler: `{transport:
/// "local", protocol, body: <the package>, match: {program, fn, app}, reply?, resolved?}`
/// (`transport` "local": no stream, no remote peer; the package carries who sent it).
fn callValidator(a: Allocator, in: Value, kind: relay.Kind, pkg: []const u8, reply: ?Value, resolved: ?Value) !Value {
    const prog = try validatorProgram(a, in);
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "transport", .value = .{ .text = "local" } },
        .{ .key = "protocol", .value = .{ .text = kind.protocol() } },
        .{ .key = "body", .value = .{ .bytes = pkg } },
        .{ .key = "match", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "program", .value = .{ .cid = prog } },
            .{ .key = "fn", .value = .{ .text = kind.box() } },
            .{ .key = "app", .value = .{ .text = relay.app_name } },
        }) } },
    });
    if (reply) |r| try es.append(a, .{ .key = "reply", .value = r });
    if (resolved) |r| try es.append(a, .{ .key = "resolved", .value = r });
    return vm.call(a, prog, kind.box(), .{ .map = es.items });
}
