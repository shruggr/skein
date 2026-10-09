//! The validator, natively: the direct call's package, the protocol's
//! bodies, the refusals, the signing path against the Go fixtures, and the
//! submission through the overlay engine's own submit (the route, the
//! submission thread, the chain app's answers) with the answer read from the
//! state after it. The swaps are gen/vectors' and the AddLiquidity
//! gen/addliquidity's (src/fixtures);
//! each was run through the go-sdk interpreter with the validator's
//! signature in place. A request is that transaction with the validator's
//! slot emptied (`OP_0`), as a taker sends it; the validator, signing
//! through a mock oracle holding the fixtures' identity key, must give back
//! the fixture byte for byte (RFC 6979 signatures on both sides).
const std = @import("std");
const w = @import("chain");
const wire = @import("wallet").wire;
const mandala = @import("mandala");
const validator = @import("src/validator.zig");
const messages = @import("src/messages.zig");
const unlock = @import("src/unlock.zig");
const view_mod = @import("src/view.zig");
const submit = @import("src/submit.zig");
const submit_mod = submit;
const scbor = @import("sdk_cbor");
const ov = @import("skein_overlay");
const sktopic = @import("topic");
const Oracle = @import("src/oracle.zig").Oracle;
const addliq = @import("add_liquidity");

const bsvz = w.bsvz;
const cbor = w.cbor;
const Value = cbor.Value;
const Transaction = bsvz.transaction.Transaction;
const vec = @import("vectors");
const pool = @import("pool");
const brc162 = mandala.brc162;
const Outpoint = view_mod.Outpoint;
const testing = std.testing;

fn unhex(a: std.mem.Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

fn key20(h: []const u8) [20]u8 {
    var k: [20]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, h) catch unreachable;
    return k;
}

fn key33(h: []const u8) [33]u8 {
    var k: [33]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, h) catch unreachable;
    return k;
}

const identity_priv: [32]u8 = .{0x7f} ** 32;

// --- a mock overlay: what the topic admitted, and who spent what ---

const MemView = struct {
    a: std.mem.Allocator,
    id: [32]u8,
    txs: std.AutoHashMap([32]u8, []const u8),
    admitted: std.AutoHashMap([36]u8, void),
    spent: std.AutoHashMap([36]u8, [32]u8),

    fn init(a: std.mem.Allocator, id: [32]u8) MemView {
        return .{ .a = a, .id = id, .txs = .init(a), .admitted = .init(a), .spent = .init(a) };
    }

    fn key(op: Outpoint) [36]u8 {
        return w.store.outpointKey(op.txid, op.vout);
    }

    /// Hold a transaction as the overlay does after a submit: what the
    /// topic (amm-topic's judge) admits, and the spends of every input. →
    /// its txid.
    fn hold(self: *MemView, raw: []const u8) ![32]u8 {
        const tx = try Transaction.parse(self.a, raw);
        const txid = w.beef.txidOf(raw);
        const prev = try self.coins(tx, txid);
        const ins = try self.a.alloc(mandala.bsv21.Input, tx.inputs.len);
        for (tx.inputs, ins) |in, *x| {
            x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
            if (self.txs.get(x.txid)) |src| {
                const s = try Transaction.parse(self.a, src);
                x.source = .{ .script = s.outputs[x.vout].locking_script.bytes, .satoshis = @intCast(s.outputs[x.vout].satoshis) };
            }
        }
        const outs = try self.a.alloc(mandala.bsv21.Output, tx.outputs.len);
        for (tx.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
        const v = try mandala.token.judge(self.a, validator.tokenId(self.id), .{ .txid = txid, .inputs = ins, .outputs = outs }, prev);
        try testing.expect(v.rejected == null);
        for (v.outputs_to_admit) |o| try self.admitted.put(key(.{ .txid = txid, .vout = o }), {});
        for (tx.inputs) |in| try self.spent.put(key(.{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index }), txid);
        try self.txs.put(txid, raw);
        return txid;
    }

    fn coins(self: *MemView, tx: Transaction, txid: [32]u8) ![]const u32 {
        var out: std.ArrayList(u32) = .empty;
        for (tx.inputs, 0..) |in, i| {
            const k = key(.{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index });
            if (!self.admitted.contains(k)) continue;
            if (self.spent.get(k)) |sp| if (!std.mem.eql(u8, &sp, &txid)) continue;
            try out.append(self.a, @intCast(i));
        }
        return out.items;
    }

    fn rawTxImpl(ptr: *anyopaque, _: std.mem.Allocator, txid: [32]u8) anyerror!?[]const u8 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        return self.txs.get(txid);
    }
    fn previousCoinsImpl(ptr: *anyopaque, a: std.mem.Allocator, _: []const u8, tx: Transaction) anyerror![]const u32 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        return self.coins(tx, (try tx.txid(a)).bytes);
    }
    fn spenderImpl(ptr: *anyopaque, _: std.mem.Allocator, _: []const u8, op: Outpoint) anyerror!?[32]u8 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        if (!self.admitted.contains(key(op))) return null;
        return self.spent.get(key(op));
    }
    fn spendersImpl(ptr: *anyopaque, a: std.mem.Allocator, op: Outpoint) anyerror![]const [32]u8 {
        const self: *MemView = @ptrCast(@alignCast(ptr));
        var out: std.ArrayList([32]u8) = .empty;
        var it = self.txs.iterator();
        while (it.next()) |e| {
            const t = try Transaction.parse(a, e.value_ptr.*);
            for (t.inputs) |in| if (in.previous_outpoint.index == op.vout and std.mem.eql(u8, &in.previous_outpoint.txid.bytes, &op.txid)) try out.append(a, e.key_ptr.*);
        }
        return out.items;
    }
    fn view(self: *MemView) view_mod.View {
        return .{ .ptr = self, .rawTxFn = rawTxImpl, .previousCoinsFn = previousCoinsImpl, .spenderFn = spenderImpl, .spendersFn = spendersImpl };
    }
};

// --- a mock oracle: a root key answering the BRC-100 wire frames ---

const KeyOracle = struct {
    root: [32]u8,
    calls: usize = 0,
    /// A signature recorded from a Go fixture for this digest: answered
    /// instead of signing here, if it verifies under the key the frame names
    /// (so a wrong key ID still fails). bsvz's own signatures are valid but
    /// its nonce is not go-sdk's RFC 6979 one, so only a recorded signature
    /// can reproduce a fixture byte for byte.
    recorded: ?struct { hash: [32]u8, der: []const u8 } = null,

    /// Record the validator's signature in a fixture's pool call.
    fn record(self: *KeyOracle, a: std.mem.Allocator, fixture: []const u8, slot: usize) !void {
        const tx = try Transaction.parse(a, fixture);
        const u = tx.inputs[0].unlocking_script.bytes;
        const c = (try unlock.parseCall(a, u, pool.methodOf(u).?)).?;
        const sig = c.arg(slot).data;
        self.recorded = .{ .hash = unlock.sha256d(c.preimage()), .der = sig[0 .. sig.len - 1] };
    }

    fn varstr(frame: []const u8, pos: *usize) []const u8 {
        const n = frame[pos.*];
        std.debug.assert(n < 0xfd);
        const s = frame[pos.* + 1 ..][0..n];
        pos.* += 1 + n;
        return s;
    }

    fn call(ptr: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8 {
        const self: *KeyOracle = @ptrCast(@alignCast(ptr));
        self.calls += 1;
        const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(self.root));
        var pos: usize = 2 + frame[1]; // call, originator
        const op = frame[0];
        if (op == wire.call_get_public_key) {
            if (frame[pos] == 1) return std.mem.concat(a, u8, &.{ &.{0}, &(try kd.identityKey()).toCompressedSec1() });
            pos += 1;
        }
        const level = frame[pos];
        pos += 1;
        const proto = varstr(frame, &pos);
        const key_id = varstr(frame, &pos);
        if (frame[pos] != 12) return error.NotAnyone; // the validator's keys are anyone-counterparty
        pos += 1 + 2; // counterparty, privileged, privilegedReason (none)
        const p: bsvz.primitives.key_deriver.Protocol = .{ .security_level = level, .name = proto };
        switch (op) {
            wire.call_get_public_key => {
                const k = try kd.derivePublicKey(a, p, key_id, .{ .type_ = .anyone }, frame[pos] == 1);
                return std.mem.concat(a, u8, &.{ &.{0}, &k.toCompressedSec1() });
            },
            wire.call_create_signature => {
                if (frame[pos] != 2) return error.NotAHash;
                const hash = frame[pos + 1 ..][0..32].*;
                const priv = try kd.derivePrivateKey(a, p, key_id, .{ .type_ = .anyone });
                if (self.recorded) |r| if (std.mem.eql(u8, &r.hash, &hash)) {
                    const der = try bsvz.crypto.DerSignature.fromDer(r.der);
                    if (!try (try priv.publicKey()).verifyDigest(hash, der)) return &.{ 1, 0 }; // a wallet error: not this key's
                    return std.mem.concat(a, u8, &.{ &.{0}, r.der });
                };
                const sig = try priv.signDigest(hash);
                return std.mem.concat(a, u8, &.{ &.{0}, sig.asSlice() });
            },
            else => return error.UnknownCall,
        }
    }
    fn oracle(self: *KeyOracle) Oracle {
        return .{ .ptr = self, .callFn = call };
    }
};

// --- the fixture chain ---

const Fx = struct {
    a: std.mem.Allocator,
    id: [32]u8,
    mem: MemView,
    oracle: KeyOracle = .{ .root = identity_priv },
    cfg: validator.Config,

    fn raw(self: *Fx, name: []const u8) []const u8 {
        inline for (.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in", "remove_liquidity" }) |n| {
            if (std.mem.eql(u8, n, name)) return unhex(self.a, @field(vec, n));
        }
        if (std.mem.eql(u8, name, "add_liquidity")) return unhex(self.a, addliq.add_liquidity);
        @panic("no fixture");
    }

    /// The overlay after holding `names`, in order.
    fn init(a: std.mem.Allocator, names: []const []const u8) !*Fx {
        const f = try a.create(Fx);
        const id = w.beef.txidOf(unhex(a, vec.token_deploy));
        // Validating the fixture token's topic (0.6.0: registered, with config.overlay.validator set, gates every signature).
        const validated = try a.dupe([]const u8, &.{try validator.topicOf(a, id)});
        f.* = .{ .a = a, .id = id, .mem = MemView.init(a, id), .cfg = .{ .identity = key33(vec.identity), .validated = validated } };
        for (names) |n| _ = try f.mem.hold(f.raw(n));
        return f;
    }

    fn spend(self: *Fx, which: validator.Op, tx: []const u8, op: Outpoint) !validator.Reply {
        return validator.spend(self.a, which, .{ .tx = tx, .pool = op }, self.cfg, self.mem.view(), self.oracle.oracle());
    }

    fn deploy(self: *Fx, tx: []const u8, vout: u32) !validator.Reply {
        return validator.deploy(self.a, .{ .tx = tx, .pool = vout }, self.cfg, self.mem.view(), self.oracle.oracle());
    }
};

fn txidOf(raw: []const u8) [32]u8 {
    return w.beef.txidOf(raw);
}

/// A transaction with input 0's pool call rewritten: argument `arg` replaced by `data`.
fn withPoolArg(a: std.mem.Allocator, raw: []const u8, arg: usize, data: []const u8) ![]const u8 {
    const tx = try Transaction.parse(a, raw);
    const u = tx.inputs[0].unlocking_script.bytes;
    const call = (try unlock.parseCall(a, u, pool.methodOf(u).?)).?;
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[0].unlocking_script = bsvz.script.Script.init(try unlock.withArg(a, call, arg, data));
    var t = tx;
    t.inputs = ins;
    return t.serialize(a);
}

/// A request: the fixture with the validator's slot emptied.
fn request(a: std.mem.Allocator, raw: []const u8, slot: usize) ![]const u8 {
    return withPoolArg(a, raw, slot, &.{});
}

fn withOutput(a: std.mem.Allocator, raw: []const u8, i: usize, script: []const u8) ![]const u8 {
    const tx = try Transaction.parse(a, raw);
    const outs = try a.dupe(bsvz.transaction.Output, tx.outputs);
    outs[i].locking_script = bsvz.script.Script.init(script);
    var t = tx;
    t.outputs = outs;
    return t.serialize(a);
}

fn withUnlocking(a: std.mem.Allocator, raw: []const u8, i: usize, script: []const u8) ![]const u8 {
    const tx = try Transaction.parse(a, raw);
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = bsvz.script.Script.init(script);
    var t = tx;
    t.inputs = ins;
    return t.serialize(a);
}

/// A deploy request body: `{tx, pool: 0}`.
fn deployBody(a: std.mem.Allocator, tx: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tx", .value = .{ .bytes = tx } },
        .{ .key = "pool", .value = .{ .uint = 0 } },
    }) };
}

/// A swap/addLiquidity request body: `{tx, pool}`.
fn spendBody(a: std.mem.Allocator, tx: []const u8, op: Outpoint) !Value {
    const op_text = try op.format(a);
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tx", .value = .{ .bytes = tx } },
        .{ .key = "pool", .value = .{ .text = op_text } },
    }) };
}

fn expectRefused(r: validator.Reply, reason: validator.Reason) !void {
    switch (r) {
        .ok => {
            std.debug.print("expected refusal {s}, got ok\n", .{@tagName(reason)});
            return error.TestExpectedRefusal;
        },
        .refused => |f| {
            if (f.reason != reason) std.debug.print("expected {s}, got {s} ({s})\n", .{ @tagName(reason), @tagName(f.reason), f.detail orelse "" });
            try testing.expectEqual(reason, f.reason);
        },
    }
}

// --- the overlay engine's own submit, for real: a mined chain, the route, the thread ---

fn readBack(a: std.mem.Allocator, v: Value) Value {
    return cbor.decode(a, cbor.encode(a, v) catch @panic("OOM")) catch @panic("bad cbor");
}

/// The transactions a submit event's BEEF carries (its `beef`: the bytes the route was handed), in order.
fn txsOf(a: std.mem.Allocator, ev: Value) ![]const []const u8 {
    const b = try w.beef.parse(a, ev.getBytes("beef").?);
    const out = try a.alloc([]const u8, b.entries.len);
    for (b.entries, out) |e, *o| o.* = e.raw.?;
    return out;
}

/// Mandala's own `identify` (skein-mandala src/mandala_topic.zig), over the
/// topic contract: the judgement `submit.route` asks the topic's program for
/// (the BSV-21 rules alone, `token.judge`).
fn tokenIdentify(a: std.mem.Allocator, call: sktopic.Call) anyerror!sktopic.Instructions {
    const id = mandala.token.tokenIdOf(call.topic) orelse return error.UnknownTopic;
    const ins = try a.alloc(mandala.bsv21.Input, call.tx.inputs.len);
    for (call.tx.inputs, ins, 0..) |in, *x, i| {
        x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
        if (call.sourceOutput(i)) |o| x.source = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    }
    const outs = try a.alloc(mandala.bsv21.Output, call.tx.outputs.len);
    for (call.tx.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    const v = try mandala.token.judge(a, id, .{ .txid = call.txid, .inputs = ins, .outputs = outs }, call.previous_coins);
    return .{ .outputs_to_admit = v.outputs_to_admit, .coins_to_retain = v.coins_to_retain };
}

const topic_program = "cid:mandala-topic";
/// The submission thread's origin, as the engine's step names it (`Ctx.thread`).
const submission_thread = "cid:submission-thread";

/// Messages to the instance itself (the engine's ingest to the chain app):
/// recorded, each a fresh CID.
const Sent = struct {
    n: usize = 0,
    /// The engine's answers to submitters (shruggr/skein#112), in order: `{to, box, body}`.
    answers: std.ArrayListUnmanaged(struct { to: []const u8, box: []const u8, body: Value }) = .empty,
    fn send(ctx: *anyopaque, a: std.mem.Allocator, _: []const u8, _: Value) anyerror![]const u8 {
        const self: *Sent = @ptrCast(@alignCast(ctx));
        self.n += 1;
        return a.dupe(u8, &cbor.cidOf(try std.fmt.allocPrint(a, "message {d}", .{self.n})));
    }
    fn answer(ctx: *anyopaque, a: std.mem.Allocator, to: []const u8, box: []const u8, body: Value) anyerror!void {
        const self: *Sent = @ptrCast(@alignCast(ctx));
        try self.answers.append(a, .{ .to = to, .box = box, .body = readBack(a, body) });
    }
    /// The last answer's body.
    fn last(self: *Sent) Value {
        return self.answers.items[self.answers.items.len - 1].body;
    }
};

/// This instance's identity, the validator's submission's sender (the fixtures' validator identity is not needed: any key).
const self_key: [33]u8 = .{0x02} ++ .{0x5a} ** 32;

/// Where a submission's thread came to (the chain app's answers to its ingest, as the engine acted on them).
const Gated = enum { pending, mined, accepted, rejected };
const Stepped = struct { gate: Gated, admitted: bool, applied: []const ov.state.Applied };

/// One instance's overlay state (`<app>/state`) over its chain state
/// (`chain/state`), in an in-memory store, with the overlay engine's own
/// submit (skein-overlay 0.6.0 src/submit.zig): the route's half (decode,
/// verify, judge through the topic's program) and the submission thread's
/// steps (`begin`: the BEEF to the chain app; `answered`: admitted on the
/// chain app's first `accepted` or `proven`). The chain app is stood in for
/// by the chain state itself (`ingest`, `applyStatus`): what it records,
/// registers and broadcasts. The validator's view of it is
/// `view.OverlayView`, as in main.zig.
const Node = struct {
    a: std.mem.Allocator,
    ms: *w.store.MemStore,
    chain_root: ?[]const u8 = null,
    ov_root: ?[]const u8 = null,
    in: Value,
    sent: Sent = .{},
    /// Transactions the chain app registered and broadcast (`Ingested.registered`).
    posts: usize = 0,
    threads: std.AutoHashMapUnmanaged([32]u8, struct { ev: Value, ingest: []const u8 }) = .empty,

    fn init(a: std.mem.Allocator, ms: *w.store.MemStore, topic: []const u8) !Node {
        const in: Value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "defaults", .value = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "walletNetwork", .value = .{ .text = "regtest" } },
                .{ .key = "overlayTopics", .value = .{ .text = try std.fmt.allocPrint(a, "{{\"{s}\":\"mandala-topic\"}}", .{topic}) } },
            }) } },
            .{ .key = "programs", .value = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "mandala-topic", .value = .{ .cid = topic_program } },
            }) } },
            .{ .key = "app", .value = .{ .text = "amm" } },
        }) };
        return .{ .a = a, .ms = ms, .in = in };
    }
    fn chain(n: *Node) !*w.state.State {
        const ch = try n.a.create(w.state.State);
        ch.* = try w.state.State.load(n.a, n.ms.store(), n.chain_root, .regtest);
        ch.now = 1000;
        return ch;
    }
    /// The overlay's state over the chain state, as a step or a call loads them.
    fn state(n: *Node) !*ov.state.State {
        const st = try n.a.create(ov.state.State);
        st.* = try ov.state.State.load(n.a, n.ms.store(), n.ov_root, try n.chain());
        st.now = 1000;
        return st;
    }
    fn caller(n: *Node) ov.calls.Caller {
        return .{ .ctx = n, .callFn = callFn };
    }
    fn callFn(ctx: *anyopaque, a: std.mem.Allocator, program: []const u8, func: []const u8, arg: Value) anyerror!Value {
        const n: *Node = @ptrCast(@alignCast(ctx));
        if (std.mem.eql(u8, program, topic_program) and std.mem.eql(u8, func, "identify")) return sktopic.judge(a, n.ms.store(), tokenIdentify, arg);
        return error.UnexpectedCall;
    }
    fn cx(n: *Node, st: *ov.state.State) ov.submit.Ctx {
        return .{ .a = n.a, .caller = n.caller(), .wire = .{ .ctx = &n.sent, .sendFn = Sent.send, .answerFn = Sent.answer }, .st = st, .in = n.in, .thread = submission_thread };
    }
    fn headers(n: *Node, raws: []const []const u8) !void {
        const ch = try n.chain();
        _ = try ch.addHeaders(raws);
        n.chain_root = try ch.save();
    }
    /// The submission thread's first step on the submit event (the thread main.zig launches): the
    /// BEEF to the chain app, which ingests it (registering and broadcasting what is unproven); a
    /// subject that arrives proven is answered `proven` at once and admitted.
    fn step(n: *Node, event: Value) !Stepped {
        const ev = readBack(n.a, event);
        const txid = try ov.submit.txidOf(ev);
        const st = try n.state();
        const m = try ov.submit.begin(n.cx(st), ev);
        n.ov_root = try st.save();
        try n.threads.put(n.a, txid, .{ .ev = ev, .ingest = m.ingests[m.ingests.len - 1] });
        const ch = try n.chain();
        const got = try ch.ingest(ev.getBytes("beef").?);
        n.posts += got.registered.len;
        n.chain_root = try ch.save();
        if (got.status == .proven) return n.answer(txid, .{ .proven = .{} }, .mined);
        return .{ .gate = .pending, .admitted = false, .applied = &.{} };
    }
    fn answer(n: *Node, txid: [32]u8, ans: ov.submit.Answer, gate: Gated) !Stepped {
        const t = n.threads.get(txid).?;
        const st = try n.state();
        const done = try ov.submit.answered(n.cx(st), t.ev, t.ingest, ans);
        n.ov_root = try st.save();
        return .{ .gate = gate, .admitted = done.admitted, .applied = done.applied };
    }
    /// A status provider's message about the transaction reaching the chain app, and the chain
    /// app's answer to the submission's thread.
    fn status(n: *Node, event: Value, tx_status: []const u8) !Stepped {
        const txid = try ov.submit.txidOf(readBack(n.a, event));
        const ch = try n.chain();
        const o = try ch.applyStatus(txid, tx_status, null);
        n.chain_root = try ch.save();
        return switch (o) {
            .accepted => n.answer(txid, .accepted, .accepted),
            .proven => n.answer(txid, .{ .proven = .{} }, .mined),
            .rejected => n.answer(txid, .{ .rejected = tx_status }, .rejected),
            .pending => .{ .gate = .pending, .admitted = false, .applied = &.{} },
        };
    }
    /// The validator's submission message (messages.zig `Next.submit`), as the engine's step on it
    /// takes it (skein-overlay `submit.received`): from this instance, in box `amm`.
    fn received(n: *Node, sub: anytype) !ov.submit.Resumed {
        const msg = try submit_mod.body(n.a, sub.beef, sub.topic);
        const source: Value = .{ .map = try n.a.dupe(cbor.Entry, &.{
            .{ .key = "transport", .value = .{ .text = "mailbox" } },
            .{ .key = "box", .value = .{ .text = "amm" } },
            .{ .key = "sender", .value = .{ .bytes = &self_key } },
            .{ .key = "request", .value = .{ .cid = try n.a.dupe(u8, &cbor.cidOf(try std.fmt.allocPrint(n.a, "submission {d}", .{n.sent.answers.items.len + n.sent.n}))) } },
        }) };
        const st = try n.state();
        const r = try ov.submit.received(n.cx(st), msg.get("args").?, source);
        n.ov_root = try st.save();
        return r;
    }
    /// The submission message routed whole: the submit event the engine launches its thread on.
    fn launched(n: *Node, served: messages.Served) !Value {
        return switch (try n.received(served.next.submit)) {
            .launch => |ev| ev,
            else => error.NotLaunched,
        };
    }
    /// A BEEF through the overlay's submit: the route, then the thread's first step on its event.
    fn submit(n: *Node, topic: []const u8, b: []const u8) !Stepped {
        const routed = try ov.submit.route(n.a, n.caller(), try n.state(), n.in, .{ .bytes = b }, &.{topic}, null, null);
        return n.step(routed.admit.event);
    }
};

fn merkleParent(l: [32]u8, r: [32]u8) [32]u8 {
    return w.store.dblSha256(&(l ++ r));
}

fn mine(prev: [32]u8, root: [32]u8, time: u32) [80]u8 {
    var h = w.header.Header{ .version = 1, .prev_hash = prev, .merkle_root = root, .time = time, .bits = 0x207fffff, .nonce = 0 };
    while (true) : (h.nonce += 1) {
        const raw = h.serialize();
        if (w.header.powOk(&raw)) return raw;
    }
}

const PE = std.meta.Elem(std.meta.Elem(@FieldType(w.merkle.MerklePath, "path")));

/// The BUMP of a four-transaction block (t0..t3) for the leaves `which` (amm-p2p's test).
fn bump4(a: std.mem.Allocator, height: u32, t: [4][32]u8, which: []const usize) ![]const u8 {
    var merged: ?w.merkle.MerklePath = null;
    for (which) |i| {
        const sib = i ^ 1;
        const l0 = try a.alloc(PE, 2);
        const me: PE = .{ .offset = i, .hash = .{ .bytes = t[i] }, .txid = true };
        const other: PE = .{ .offset = sib, .hash = .{ .bytes = t[sib] } };
        l0[0] = if (i < sib) me else other;
        l0[1] = if (i < sib) other else me;
        const up = if (i < 2) merkleParent(t[2], t[3]) else merkleParent(t[0], t[1]);
        const l1 = try a.dupe(PE, &.{.{ .offset = (i >> 1) ^ 1, .hash = .{ .bytes = up } }});
        const levels = try a.dupe([]PE, &.{ l0, l1 });
        const p: w.merkle.MerklePath = .{ .block_height = height, .path = levels };
        if (merged) |*m| try m.combine(&p, a) else merged = p;
    }
    return merged.?.bytes(a);
}

/// The Go fixtures' chain, mined: block 1 holds fund, token_deploy,
/// pool_deploy (and a filler), so each is proven by a BUMP against a real
/// header, and a BEEF of any of them verifies with no further ancestry (the
/// fixtures' own funding inputs are placeholder txids). A node that has
/// taken token_deploy and pool_deploy through the overlay's submit holds the
/// pool, but never saw fund: the taker's funding is known to it only from
/// the request's BEEF.
const Mined = struct {
    f: *Fx,
    node: Node,
    blk: [80]u8,
    leaves: [4][32]u8,
    topic: []const u8,
    pool_op: Outpoint,

    fn init(a: std.mem.Allocator, ms: *w.store.MemStore) !*Mined {
        const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
        const m = try a.create(Mined);
        const leaves: [4][32]u8 = .{ txidOf(f.raw("fund")), txidOf(f.raw("token_deploy")), txidOf(f.raw("pool_deploy")), .{9} ** 32 };
        const root = merkleParent(merkleParent(leaves[0], leaves[1]), merkleParent(leaves[2], leaves[3]));
        const topic = try validator.topicOf(a, f.id);
        m.* = .{
            .f = f,
            .node = try Node.init(a, ms, topic),
            .blk = mine(w.header.hash(&w.chain.Network.regtest.genesis()), root, 1_700_000_000),
            .leaves = leaves,
            .topic = topic,
            .pool_op = .{ .txid = leaves[2], .vout = 0 },
        };
        try m.node.headers(&.{&m.blk});
        const td = try m.node.submit(topic, try m.beef(a, &.{"token_deploy"}, null));
        try testing.expectEqual(Gated.mined, td.gate);
        try testing.expectEqualSlices(u32, &.{0}, td.applied[0].outputs_to_admit);
        const pd = try m.node.submit(topic, try m.beef(a, &.{"pool_deploy"}, null));
        try testing.expectEqual(Gated.mined, pd.gate);
        try testing.expect(pd.applied[0].outputs_to_admit.len > 0);
        try testing.expectEqual(@as(usize, 0), m.node.posts); // mined: nothing broadcast
        return m;
    }

    /// A V2 BEEF of the mined fixtures `proven` (with their BUMP), then `subject` (unproven), if any.
    fn beef(m: *Mined, a: std.mem.Allocator, proven: []const []const u8, subject: ?[]const u8) ![]const u8 {
        const which = try a.alloc(usize, proven.len);
        const entries = try a.alloc(w.beef.Entry, proven.len + @intFromBool(subject != null));
        for (proven, which, entries[0..proven.len]) |name, *i, *e| {
            const raw = m.f.raw(name);
            i.* = for (m.leaves, 0..) |l, k| {
                if (std.mem.eql(u8, &l, &txidOf(raw))) break k;
            } else unreachable;
            e.* = .{ .txid = txidOf(raw), .format = .raw_with_bump, .bump = 0, .raw = raw };
        }
        if (subject) |s| entries[proven.len] = .{ .txid = txidOf(s), .format = .raw, .raw = s };
        const bumps = try a.alloc(w.merkle.MerklePath, 1);
        bumps[0] = try w.merkle.MerklePath.parse(a, try bump4(a, 1, m.leaves, which));
        return w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = bumps, .entries = entries });
    }

    /// The request the taker sends: the sats-in swap with the validator's
    /// slot empty, as a BEEF carrying its funding (fund, proven), and the
    /// oracle primed to reproduce the fixture's signature.
    fn swapRequest(m: *Mined, a: std.mem.Allocator) ![]const u8 {
        try m.f.oracle.record(a, m.f.raw("swap_bsv_in"), 0);
        return m.beef(a, &.{"fund"}, try request(a, m.f.raw("swap_bsv_in"), 0));
    }

    /// What main.zig gives a direct call: the view over the instance's
    /// state, and the same state (the step's).
    fn deps(m: *Mined) !messages.Deps {
        const st = try m.node.state();
        const ovv = try m.node.a.create(view_mod.OverlayView);
        ovv.* = .{ .st = st };
        return .{
            .config = m.f.cfg,
            .view = ovv.view(),
            .oracle = m.f.oracle.oracle(),
            .st = st,
        };
    }

    /// The answer read from the state once the thread a call waited on has come to rest.
    fn fromState(m: *Mined, a: std.mem.Allocator, op: validator.Op, body: Value) !validator.Reply {
        const st = try m.node.state();
        const ovv = try a.create(view_mod.OverlayView);
        ovv.* = .{ .st = st };
        return messages.answerFromState(a, st, ovv.view(), op, body);
    }

    /// The request through `messages.respond` as the direct call's first step makes it (main.zig `directCall`).
    fn respond(m: *Mined, a: std.mem.Allocator, req: []const u8) !messages.Served {
        return messages.respond(a, .swap, try spendBody(a, req, m.pool_op), try m.deps());
    }

    /// An addLiquidity request through `messages.respond`, as the addLiquidity call's first step makes it.
    fn respondAdd(m: *Mined, a: std.mem.Allocator, req: []const u8) !messages.Served {
        return messages.respond(a, .add_liquidity, try spendBody(a, req, m.pool_op), try m.deps());
    }

    /// An addLiquidity call's answer once the submission's thread has come to rest.
    fn answerAdd(m: *Mined, a: std.mem.Allocator, req: []const u8) !validator.Reply {
        return m.fromState(a, .add_liquidity, try spendBody(a, req, m.pool_op));
    }

    /// A deploy request through `messages.respond`, as the deploy call's first step makes it.
    fn respondDeploy(m: *Mined, a: std.mem.Allocator, req: []const u8) !messages.Served {
        return messages.respond(a, .deploy, try deployBody(a, req), try m.deps());
    }

    /// A deploy call's answer once the submission's thread has come to rest.
    fn answerDeploy(m: *Mined, a: std.mem.Allocator, body: Value) !validator.Reply {
        return m.fromState(a, .deploy, body);
    }

    /// The direct call's answer on the engine's answer to its submission (called again with `reply`).
    fn fromSubmit(m: *Mined, a: std.mem.Allocator, op: validator.Op, body: Value, ans: Value) !validator.Reply {
        const st = try m.node.state();
        const ovv = try a.create(view_mod.OverlayView);
        ovv.* = .{ .st = st };
        return messages.answerFromSubmit(a, st, ovv.view(), op, body, ans);
    }

    /// The direct call's answer once the thread it waited on has come to rest (called again with `resolved`).
    fn answer(m: *Mined, a: std.mem.Allocator, req: []const u8) !validator.Reply {
        return m.fromState(a, .swap, try spendBody(a, req, m.pool_op));
    }
};

// --- signing ---

test "sign: a sats-in swap comes back as the Go fixture, byte for byte; submitted by message to the engine, launched as its submission, admitted on the network's word, and the direct call's answer from the engine's answer is the signed transaction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const want = f.raw("swap_bsv_in");
    const req = try request(a, want, 0);
    try testing.expect(!std.mem.eql(u8, req, want));
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // Signed here by bsvz (valid under the pool's key: spend checks that):
    // the same transaction but for the signature's bytes.
    const local = try f.spend(.swap, req, op);
    try testing.expect(local == .ok);
    try testing.expect(!std.mem.eql(u8, want, local.ok.tx.?));
    try testing.expectEqualSlices(u8, req, try request(a, local.ok.tx.?, 0));
    f.oracle.calls = 0;

    try f.oracle.record(a, want, 0);
    const r = try f.spend(.swap, req, op);
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want, r.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(want), &r.ok.txid.?);
    try testing.expectEqual(@as(usize, 1), f.oracle.calls); // one signature, nothing else
    // Not submitted here (spend never routes): what the submission needs.
    try testing.expectEqualStrings(try validator.topicOf(a, f.id), r.ok.submission.?.topic);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_mandala_{s}_0", .{&w.header.toHex(f.id)}), r.ok.submission.?.topic);
    try testing.expect(r.ok.submission.?.pool.eql(op));

    // The same request as the direct call's step makes it, on a real node
    // (the mined chain): checked, signed, and the signed BEEF submitted by
    // message ({fn: "submit", args: {beef, topics}} to the instance itself);
    // the engine's step on it asks the topic's judgement and makes the submit
    // record — to launch its submission thread on.
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const sreq = try m.swapRequest(a);
    const served = try m.respond(a, sreq);
    try testing.expect(served.reply == .ok);
    try testing.expectEqualSlices(u8, want, served.reply.ok.tx.?);
    try testing.expectEqualStrings(m.topic, served.next.submit.topic);
    const ev = readBack(a, try m.node.launched(served));
    try testing.expectEqualStrings("submit", ev.getText("kind").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(want)), ev.getText("txid").?);
    // The BEEF the event carries: fund (with its BUMP), then the signed transaction.
    const txs = try txsOf(a, ev);
    try testing.expectEqual(@as(usize, 2), txs.len);
    try testing.expectEqualSlices(u8, f.raw("fund"), txs[0]);
    try testing.expectEqualSlices(u8, want, txs[1]);
    const eb = try w.beef.parse(a, ev.getBytes("beef").?);
    try testing.expectEqual(@as(usize, 1), eb.bumps.len);
    try testing.expectEqual(w.beef.Format.raw_with_bump, eb.entries[0].format);
    const j = ev.getArray("topics").?[0];
    try testing.expectEqualStrings(m.topic, j.getText("topic").?);
    try testing.expectEqual(@as(usize, 1), j.getArray("previousCoins").?.len); // the pool
    try testing.expectEqual(@as(u64, 0), j.getArray("previousCoins").?[0].uint);

    // The submission thread: the BEEF to the chain app, which registers and
    // broadcasts the swap (fund arrives proven); pending (nothing admitted),
    // then the status provider's RECEIVED (the chain app's `accepted`) admits
    // it — the continuation (0) and the taker's token payout (1).
    const first = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first.gate);
    try testing.expect(!first.admitted);
    try testing.expectEqual(@as(usize, 1), m.node.posts);
    try expectRefused(try m.answer(a, sreq), .pending); // were the thread to rest now (errored)
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expectEqual(Gated.accepted, done.gate);
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, done.applied[0].outputs_to_admit);
    try testing.expectEqualSlices(u32, &.{0}, done.applied[0].coins_to_retain); // the pool coin, carried on

    // The engine answered the sender (this instance, box amm): admitted, pending, with the STEAK.
    try testing.expectEqual(@as(usize, 1), m.node.sent.answers.items.len);
    try testing.expectEqualSlices(u8, &self_key, m.node.sent.answers.items[0].to);
    try testing.expectEqualStrings("amm", m.node.sent.answers.items[0].box);
    const res = m.node.sent.last().get("result").?;
    try testing.expectEqualStrings("admitted", res.getText("state").?);
    try testing.expectEqualStrings("pending", res.getText("status").?);
    try testing.expect(res.get("steak").?.get(m.topic) != null);
    // The direct call's answer on it.
    const via = try m.fromSubmit(a, .swap, try spendBody(a, sreq, m.pool_op), m.node.sent.last());
    try testing.expectEqualSlices(u8, want, via.ok.tx.?);
    // The same, from the state (a resubmission's wait on the thread).
    const ans = try m.answer(a, sreq);
    try testing.expect(ans == .ok);
    try testing.expectEqualSlices(u8, want, ans.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(want), &ans.ok.txid.?);
    const body = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(true, body.getBool("ok").?);
    try testing.expectEqualSlices(u8, want, body.getBytes("tx").?);
}

test "submission: a request BEEF whose funding the node never held, proven in the BEEF, is accepted; as raw bytes, the engine pauses it on the missing parent (skein-overlay 0.7.2: every missing parent pauses)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const fund = txidOf(m.f.raw("fund"));
    try testing.expect((try (try m.node.chain()).txRaw(fund)) == null); // unknown to the node

    // The raw request: every check passes (the funding input's signature is
    // only "present" without its source), it is signed and submitted, and the
    // engine pauses it: an input neither held nor in the BEEF. Nothing is
    // answered yet (the pause is internal); the call waits.
    const raw_req = try request(a, m.f.raw("swap_bsv_in"), 0);
    try m.f.oracle.record(a, m.f.raw("swap_bsv_in"), 0);
    const r = try m.respond(a, raw_req);
    try testing.expect(r.next == .submit);
    const paused = try m.node.received(r.next.submit);
    try testing.expect(paused == .paused);
    try testing.expectEqual(@as(usize, 0), m.node.sent.answers.items.len);

    // The same request as a BEEF carrying fund with its BUMP (on a node that saw no pause): launched, and admitted.
    var ms2 = w.store.MemStore.init(testing.allocator);
    defer ms2.deinit();
    const m2 = try Mined.init(a, &ms2);
    const ok = try m2.respond(a, try m2.swapRequest(a));
    const okev = try m2.node.launched(ok);
    _ = try m2.node.step(okev);
    const done = try m2.node.status(okev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expect((try (try m2.node.chain()).status(fund)) == .proven); // held now, with its proof
}

test "submission: the gate, answered from the state — a rejection admits nothing (rejected, and the same request again is refused at once); a resubmission while pending waits on the first submission's thread, then the answer is the signed transaction" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // The network rejects it: nothing admitted; the answer is `rejected`, the pool live again (no `pool`).
    {
        var ms = w.store.MemStore.init(testing.allocator);
        defer ms.deinit();
        const m = try Mined.init(a, &ms);
        const req = try m.swapRequest(a);
        const r = try m.respond(a, req);
        const ev = try m.node.launched(r);
        _ = try m.node.step(ev);
        const done = try m.node.status(ev, "REJECTED");
        try testing.expectEqual(Gated.rejected, done.gate);
        try testing.expect(!done.admitted);
        // The engine's answer: rejected; the direct call's answer on it.
        try testing.expectEqualStrings("rejected", m.node.sent.last().get("result").?.getText("state").?);
        const ans = try m.fromSubmit(a, .swap, try spendBody(a, req, m.pool_op), m.node.sent.last());
        try expectRefused(ans, .rejected);
        try testing.expectEqualStrings("REJECTED", ans.refused.detail.?);
        try testing.expect(ans.refused.newest == null);
        const body = readBack(a, try messages.replyValue(a, ans));
        try testing.expectEqualStrings("rejected", body.getText("reason").?);
        try testing.expectEqualStrings(&w.header.toHex(r.reply.ok.txid.?), body.getText("txid").?);
        // The same request again: rejected before, answered from the state at once (nothing submitted).
        const again = try m.respond(a, req);
        try testing.expect(again.next == .from_state);
        try expectRefused(try m.answer(a, req), .rejected);
    }
    // Pending: the same request again is recognised (not re-signed) and waits on the first thread.
    {
        var ms = w.store.MemStore.init(testing.allocator);
        defer ms.deinit();
        const m = try Mined.init(a, &ms);
        const req = try m.swapRequest(a);
        const r = try m.respond(a, req);
        const ev = try m.node.launched(r);
        const first = try m.node.step(ev);
        try testing.expectEqual(Gated.pending, first.gate);

        m.f.oracle.calls = 0;
        const again = try m.respond(a, req);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls); // not signed again
        try testing.expectEqualSlices(u8, &r.reply.ok.txid.?, &again.next.wait_on);
        // The thread it waits on: the one the broadcast record names (main.zig awaits it).
        const rec = (try (try m.node.state()).pendingRecord(again.next.wait_on)).?;
        try testing.expectEqualSlices(u8, submission_thread, rec.getCid("thread").?);

        // The network's word admits it; the thread rests; both waiting calls answer the same.
        _ = try m.node.status(ev, "SEEN_ON_NETWORK");
        const ans = try m.answer(a, req);
        try testing.expectEqualSlices(u8, r.reply.ok.tx.?, ans.ok.tx.?);
        // Sent once more, after: judged before, answered from the state at once.
        const last = try m.respond(a, req);
        try testing.expect(last.next == .from_state);
    }
}

test "sign: a tokens-in swap (the key rotated once already)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in" });
    const want = f.raw("swap_tokens_in");
    try f.oracle.record(a, want, 0);
    const r = try f.spend(.swap, try request(a, want, 0), .{ .txid = txidOf(f.raw("swap_bsv_in")), .vout = 0 });
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want, r.ok.tx.?);
}

test "sign: addLiquidity after a removal (the key carried over: the walk back skips the LP-only spend)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in", "remove_liquidity" });
    const want = f.raw("add_liquidity");
    const pool_op: Outpoint = .{ .txid = txidOf(f.raw("remove_liquidity")), .vout = 0 };

    // The current key's ID is swap_bsv_in:0 (the last input the validator
    // signed), not remove_liquidity's pool input.
    const cur = (try pool.parse(brc162.decode((try f.mem.view().output(a, pool_op)).?.script).?.lock)).?;
    const kid = (try validator.currentKeyId(a, f.mem.view(), f.id, f.cfg.identity, pool_op, cur.validator)).?;
    try testing.expect(kid.eql(.{ .txid = txidOf(f.raw("swap_bsv_in")), .vout = 0 }));

    try f.oracle.record(a, want, 1);
    const r = try f.spend(.add_liquidity, try request(a, want, 1), pool_op);
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want, r.ok.tx.?);
    const next = (try pool.parse(brc162.decode((try Transaction.parse(a, r.ok.tx.?)).outputs[0].locking_script.bytes).?.lock)).?;
    try testing.expectEqualSlices(u8, &key33(addliq.pool4.validator), &next.validator);
    try testing.expectEqual(@as(u64, addliq.pool4.tokens), next.token_reserve);
}

test "sign: a request as a BEEF: an unheld parent's source verifies the taker's signature, and the signed BEEF is the request's with its subject signed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // fund not held: the request's own ancestry is the only way to it.
    const want = try Fx.init(a, &.{ "token_deploy", "pool_deploy" });
    const req = try request(a, want.raw("swap_bsv_in"), 0);
    try want.oracle.record(a, want.raw("swap_bsv_in"), 0);
    const parent = want.raw("fund");
    const b = try w.beef.serialize(a, .{ .version = w.beef.V1, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(parent), .format = .raw, .raw = parent },
        .{ .txid = txidOf(req), .format = .raw, .raw = req },
    }) });
    const r = try want.spend(.swap, b, .{ .txid = txidOf(want.raw("pool_deploy")), .vout = 0 });
    try testing.expect(r == .ok);
    try testing.expectEqualSlices(u8, want.raw("swap_bsv_in"), r.ok.tx.?);
    const sub = r.ok.submission.?;
    try testing.expect(sub.ancestry != null);
    // What goes to skein's submit.route: the request's BEEF, parents first,
    // its subject now the signed transaction.
    const sb = try w.beef.parse(a, try submit.submissionBeef(a, r.ok.tx.?, sub.ancestry));
    try testing.expectEqual(@as(usize, 2), sb.entries.len);
    try testing.expectEqualSlices(u8, parent, sb.entries[0].raw.?);
    try testing.expectEqualSlices(u8, want.raw("swap_bsv_in"), sb.entries[1].raw.?);
    try testing.expectEqualSlices(u8, &txidOf(want.raw("swap_bsv_in")), &sb.subject().?);
    // A raw request: a V1 BEEF of the signed transaction alone.
    const rb = try w.beef.parse(a, try submit.submissionBeef(a, r.ok.tx.?, null));
    try testing.expectEqual(@as(usize, 1), rb.entries.len);
    // It goes to the submissions box `<app>/submit` (skein-overlay 0.7.5, shruggr/skein#128).
    try testing.expectEqualStrings("amm/submit", try submit.box(a, "amm"));

    // The taker's funding input's signature is verified in full from the
    // BEEF's parent: a bad one is refused (it is only "present" without it).
    const tx = try Transaction.parse(a, req);
    const u = try a.dupe(u8, tx.inputs[1].unlocking_script.bytes);
    u[u[0] - 1] ^= 0x01;
    const bad = try withUnlocking(a, req, 1, u);
    const bb = try w.beef.serialize(a, .{ .version = w.beef.V1, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(parent), .format = .raw, .raw = parent },
        .{ .txid = txidOf(bad), .format = .raw, .raw = bad },
    }) });
    try expectRefused(try want.spend(.swap, bb, .{ .txid = txidOf(want.raw("pool_deploy")), .vout = 0 }), .bad_signature);
}

// --- refusals ---

test "refused: not our pool, not a pool input, unknown pool, wrong method, slot taken" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // Another validator's instance.
    var other = f.cfg;
    other.identity = key33(vec.pool0.validator);
    try expectRefused(try validator.spend(a, .swap, .{ .tx = req, .pool = op }, other, f.mem.view(), f.oracle.oracle()), .not_our_pool);
    // The named pool is not spent by the transaction.
    try expectRefused(try f.spend(.swap, req, .{ .txid = op.txid, .vout = 1 }), .pool_not_an_input);
    // A pool this overlay does not hold.
    const g = try Fx.init(a, &.{ "fund", "token_deploy" });
    try expectRefused(try g.spend(.swap, req, op), .unknown_pool);
    // A swap in the addLiquidity box.
    try expectRefused(try f.spend(.add_liquidity, req, op), .wrong_method);
    // Already signed (the slot is not OP_0).
    try expectRefused(try f.spend(.swap, f.raw("swap_bsv_in"), op), .signature_slot_not_empty);
    // Not a transaction.
    try expectRefused(try f.spend(.swap, "nonsense", op), .bad_transaction);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "the validated topics (0.3.2; 0.6.0: the registered set when config.overlay.validator is set): in it, a swap, an addLiquidity and a deploy are signed as before; not in it, each is refused not_validating, nothing signed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    const topic = try validator.topicOf(a, f.id);

    // In the set: signed.
    try testing.expect(validator.validating(f.cfg, topic));
    try testing.expect((try f.spend(.swap, req, op)) == .ok);
    const calls = f.oracle.calls;

    // Not in it (nothing validated; another token's topic only): refused, the oracle not asked.
    var none = f.cfg;
    none.validated = &.{};
    var other = f.cfg;
    other.validated = &.{"tm_mandala_" ++ "00" ** 32 ++ "_0"};
    for ([_]validator.Config{ none, other }) |cfg| {
        const r = try validator.spend(a, .swap, .{ .tx = req, .pool = op }, cfg, f.mem.view(), f.oracle.oracle());
        try expectRefused(r, .not_validating);
        try testing.expect(std.mem.indexOf(u8, r.refused.detail.?, topic) != null);
        try expectRefused(try validator.spend(a, .add_liquidity, .{ .tx = req, .pool = op }, cfg, f.mem.view(), f.oracle.oracle()), .not_validating);
    }
    try testing.expectEqual(calls, f.oracle.calls);

    // A deploy: consent in the set; refused out of it (the token not yet held, and held already).
    const g = try Fx.init(a, &.{ "fund", "token_deploy" });
    const d = g.raw("pool_deploy");
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, none, g.mem.view(), g.oracle.oracle()), .not_validating);
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, other, g.mem.view(), g.oracle.oracle()), .not_validating);
    try testing.expect((try g.deploy(d, 0)) == .ok);
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, none, f.mem.view(), f.oracle.oracle()), .not_validating);

    // Through the protocol: the refusal's reply body.
    const body = try messages.replyValue(a, try validator.spend(a, .swap, .{ .tx = req, .pool = op }, none, f.mem.view(), f.oracle.oracle()));
    try testing.expectEqualStrings("not_validating", body.getText("reason").?);
}

test "refused: the topic would not admit it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // The taker's token payout one higher: tokens out exceed tokens in.
    const tx = try Transaction.parse(a, req);
    var buf: [10]u8 = undefined;
    const payout = brc162.decode(tx.outputs[1].locking_script.bytes).?;
    const more = try std.mem.concat(a, u8, &.{ &.{0x20}, &f.id, brc162.pushAmount(&buf, payout.amount + 1), &.{0x6d}, payout.lock });
    const r = try f.spend(.swap, try withOutput(a, req, 1, more), op);
    try expectRefused(r, .topic_refused);
    try testing.expectEqualStrings("inflation", r.refused.detail.?);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: a swap's outputs not the contract's (bad_outputs): the commission elsewhere, missing, short; an LP fee short; an extra output" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    const S = struct {
        fn outs(al: std.mem.Allocator, raw: []const u8, list: []const bsvz.transaction.Output) ![]const u8 {
            var t = try Transaction.parse(al, raw);
            t.outputs = list;
            return t.serialize(al);
        }
        fn expectBad(fx: *Fx, raw: []const u8, o: Outpoint, detail: []const u8) !void {
            const r = try fx.spend(.swap, raw, o);
            try expectRefused(r, .bad_outputs);
            try testing.expect(std.mem.indexOf(u8, r.refused.detail.?, detail) != null);
        }
    };
    const tx = try Transaction.parse(a, req);
    try testing.expectEqual(@as(usize, 6), tx.outputs.len); // pool, payout, LP fee, validator fee, commission, change

    // The call names another commissionPkh than output 4 pays.
    try S.expectBad(f, try withPoolArg(a, req, 5, &(.{0xc0} ** 20)), op, "the commission");
    // Output 4 pays another pkh than the call names.
    try S.expectBad(f, try withOutput(a, req, 4, try p2pkhLock(a, &(.{0xc0} ** 20))), op, "the commission");
    // No commission output (the change moves up to 4).
    try S.expectBad(f, try S.outs(a, req, &.{ tx.outputs[0], tx.outputs[1], tx.outputs[2], tx.outputs[3], tx.outputs[5] }), op, "the commission");
    // The commission one sat short.
    var short = try a.dupe(bsvz.transaction.Output, tx.outputs);
    short[4].satoshis -= 1;
    try S.expectBad(f, try S.outs(a, req, short), op, "the commission");
    // The LP fee one sat short.
    short = try a.dupe(bsvz.transaction.Output, tx.outputs);
    short[2].satoshis -= 1;
    try S.expectBad(f, try S.outs(a, req, short), op, "the LP fee");
    // An output past the change.
    try S.expectBad(f, try S.outs(a, req, try std.mem.concat(a, bsvz.transaction.Output, &.{ tx.outputs, &.{tx.outputs[4]} })), op, "outputs past");
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: the wrong next validator key, in the call or in the continuation" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    const req = try request(a, f.raw("swap_bsv_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };

    // The call carries the current key over instead of rotating it.
    try expectRefused(try f.spend(.swap, try withPoolArg(a, req, 1, &key33(vec.pool0.validator)), op), .wrong_next_key);
    // The continuation's state names another key.
    const tx = try Transaction.parse(a, req);
    const s = try a.dupe(u8, tx.outputs[0].locking_script.bytes);
    @memcpy(s[s.len - pool.state_len + 8 + 33 ..][0..33], &key33(vec.pool2.validator));
    try expectRefused(try f.spend(.swap, try withOutput(a, req, 0, s), op), .wrong_next_key);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: signatures missing or bad; a preimage that is not this input's" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in" });
    const req = try request(a, f.raw("swap_tokens_in"), 0);
    const op: Outpoint = .{ .txid = txidOf(f.raw("swap_bsv_in")), .vout = 0 };

    // The taker's token input unsigned.
    try expectRefused(try f.spend(.swap, try withUnlocking(a, req, 1, &.{}), op), .missing_signature);
    // A signature byte flipped (still DER-shaped: flip the last byte of s).
    const tx = try Transaction.parse(a, req);
    const u = try a.dupe(u8, tx.inputs[1].unlocking_script.bytes);
    u[u[0] - 1] ^= 0x01; // the byte before the sighash flag
    try expectRefused(try f.spend(.swap, try withUnlocking(a, req, 1, u), op), .bad_signature);
    // The call's preimage from another transaction.
    const other = (try unlock.parseCall(a, (try Transaction.parse(a, f.raw("swap_bsv_in"))).inputs[0].unlocking_script.bytes, .swap)).?;
    const call = (try unlock.parseCall(a, tx.inputs[0].unlocking_script.bytes, .swap)).?;
    const pre_at = call.pushes[call.pushes.len - 2];
    const swapped = try std.mem.concat(a, u8, &.{ call.script[0..pre_at.start], try unlock.pushData(a, other.preimage()), call.script[pre_at.p.next..] });
    try expectRefused(try f.spend(.swap, try withUnlocking(a, req, 0, swapped), op), .preimage_mismatch);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "refused: the pool was already spent; the reply carries its newest state (unless the spender is this very request: a retry, answered again)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in" });
    const pool_op: Outpoint = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 };
    // The request whose signed transaction spent the pool, sent again (a
    // retry after a 503): recognised, answered with the held transaction,
    // not signed again.
    const retry = try f.spend(.swap, try request(a, f.raw("swap_bsv_in"), 0), pool_op);
    try testing.expect(retry == .ok);
    try testing.expectEqualSlices(u8, f.raw("swap_bsv_in"), retry.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(f.raw("swap_bsv_in")), &retry.ok.txid.?);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);

    // Two swaps landed: another taker's stale request for the first pool is
    // refused with the pool after both.
    const stale = try withUnlocking(a, try request(a, f.raw("swap_bsv_in"), 0), 1, &.{0x00});
    const r = try f.spend(.swap, stale, pool_op);
    try expectRefused(r, .pool_spent);
    const s = r.refused.newest.?.live;
    try testing.expect(s.outpoint.eql(.{ .txid = txidOf(f.raw("swap_tokens_in")), .vout = 0 }));
    try testing.expectEqual(@as(u64, vec.pool2.bsv), s.satoshis);
    try testing.expectEqual(@as(u64, vec.pool2.tokens), s.pool.token_reserve);
    try testing.expectEqualSlices(u8, &key33(vec.pool2.validator), &s.pool.validator);

    // As the reply body has it.
    const body = try messages.replyValue(a, r);
    const back = try cbor.decode(a, try cbor.encode(a, body));
    try testing.expectEqual(false, back.getBool("ok").?);
    try testing.expectEqualStrings("pool_spent", back.getText("reason").?);
    const p = back.get("pool").?;
    try testing.expectEqualStrings(try s.outpoint.format(a), p.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool2.bsv), p.getUint("bsvReserve").?);
    try testing.expectEqual(@as(u64, vec.pool2.tokens), p.getUint("tokenReserve").?);
    try testing.expectEqual(@as(u64, vec.lp_fee_bps), p.getUint("lpFeeBps").?);
    try testing.expectEqual(@as(u64, vec.commission_bps), p.getUint("commissionBps").?);
    try testing.expectEqualSlices(u8, &key33(vec.identity), p.getBytes("validatorIdentity").?);

    // Past the removal too.
    _ = try f.mem.hold(f.raw("remove_liquidity"));
    const r2 = try f.spend(.swap, stale, .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 });
    try testing.expect(r2.refused.newest.?.live.outpoint.eql(.{ .txid = txidOf(f.raw("remove_liquidity")), .vout = 0 }));
    try testing.expectEqual(@as(u64, vec.pool3.tokens), r2.refused.newest.?.live.pool.token_reserve);
}

// --- deploy consent ---

test "deploy: consent to host, and the refusals" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy" });
    const d = f.raw("pool_deploy");

    // Consent: the deploy itself back (nothing signed), with what its submission needs.
    const ok = try f.deploy(d, 0);
    try testing.expect(ok == .ok);
    try testing.expectEqualSlices(u8, d, ok.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(d), &ok.ok.txid.?);
    try testing.expectEqualStrings(try validator.topicOf(a, f.id), ok.ok.submission.?.topic);
    try testing.expectEqual(@as(usize, 0), ok.ok.submission.?.parents.len); // raw: no parents to broadcast
    try testing.expectEqual(@as(usize, 1), f.oracle.calls); // the key check: getPublicKey
    // Unsigned by the LP: refused (the validator submits the deploy itself, so it must be complete).
    const tx = try Transaction.parse(a, d);
    try expectRefused(try f.deploy(try withUnlocking(a, d, 0, &.{}), 0), .missing_signature);
    // A bad LP signature (its source, token_deploy, is held): refused.
    {
        const u = try a.dupe(u8, tx.inputs[1].unlocking_script.bytes);
        u[u[0] - 1] ^= 0x01;
        const r = try f.deploy(try withUnlocking(a, d, 1, u), 0);
        try expectRefused(r, .bad_signature);
        try testing.expectEqualStrings("input 1", r.refused.detail.?);
    }

    try expectRefused(try f.deploy(d, 1), .pool_not_at_output_0);
    var fees = f.cfg;
    fees.min_validator_fee_bps = 10;
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, fees, f.mem.view(), f.oracle.oracle()), .fees_unacceptable);
    fees = f.cfg;
    fees.max_lp_fee_bps = 20;
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, fees, f.mem.view(), f.oracle.oracle()), .fees_unacceptable);
    // maxCommissionBps: the pool's 10 bps over a cap of 5 is refused; a cap of 10 hosts it.
    fees = f.cfg;
    fees.max_commission_bps = 5;
    const rc = try validator.deploy(a, .{ .tx = d, .pool = 0 }, fees, f.mem.view(), f.oracle.oracle());
    try expectRefused(rc, .fees_unacceptable);
    try testing.expectEqualStrings("commissionBps", rc.refused.detail.?);
    fees.max_commission_bps = vec.commission_bps;
    try testing.expect((try validator.deploy(a, .{ .tx = d, .pool = 0 }, fees, f.mem.view(), f.oracle.oracle())) == .ok);
    var other = f.cfg;
    other.identity = key33(vec.pool0.validator);
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, other, f.mem.view(), f.oracle.oracle()), .not_our_pool);

    // The key in state is not our child of the LP's first token input: the
    // topic admits it and the pool checks pass it (the overlay does not check
    // the key); our own key check refuses it.
    const s = try a.dupe(u8, tx.outputs[0].locking_script.bytes);
    @memcpy(s[s.len - pool.state_len + 8 + 33 ..][0..33], &key33(vec.pool1.validator));
    const r = try f.deploy(try withOutput(a, d, 0, s), 0);
    try expectRefused(r, .wrong_validator_key);
    // A plain transfer is no deploy.
    try expectRefused(try f.deploy(f.raw("token_deploy"), 0), .not_a_pool);
    // The token input not an admitted coin of this overlay (it never took token_deploy), its source in the BEEF: the topic refuses.
    {
        const g = try Fx.init(a, &.{"fund"});
        const b = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
            .{ .txid = txidOf(g.raw("token_deploy")), .format = .raw, .raw = g.raw("token_deploy") },
            .{ .txid = txidOf(d), .format = .raw, .raw = d },
        }) });
        const ru = try g.deploy(b, 0);
        try expectRefused(ru, .topic_refused);
        try testing.expectEqualStrings("inflation", ru.refused.detail.?);
    }
}

// --- the protocol ---

const sender_priv: [32]u8 = .{0x31} ** 32;

/// A direct call's frame: a signed-message package `{message, body}`, the
/// mail record signed BRC-169's way by `priv` (its anyone-child for
/// [2, "metanet handles envelope"], key ID "send", over sha256 of the record
/// without `signature`), as a taker's wallet signs it.
fn package(a: std.mem.Allocator, priv: [32]u8, recipient: [33]u8, box: []const u8, body: Value) ![]const u8 {
    const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(priv));
    const sender = (try kd.identityKey()).toCompressedSec1();
    const body_bytes = try cbor.encode(a, body);
    const blk = try scbor.block(a, try scbor.decode(a, body_bytes));
    try testing.expectEqualSlices(u8, body_bytes, blk.bytes); // the same canonical dag-cbor either side
    var es: std.ArrayList(scbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .string = "mail" } },
        .{ .key = "op", .value = .{ .string = "put" } },
        .{ .key = "sender", .value = .{ .bytes = try a.dupe(u8, &sender) } },
        .{ .key = "recipient", .value = .{ .bytes = try a.dupe(u8, &recipient) } },
        .{ .key = "box", .value = .{ .string = box } },
        .{ .key = "body", .value = .{ .cid = blk.cid } },
        .{ .key = "nonce", .value = .{ .bytes = &(.{7} ** 16) } },
    });
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(try scbor.encode(a, .{ .map = es.items }), &digest, .{});
    const child = try kd.derivePrivateKey(a, .{ .security_level = 2, .name = "metanet handles envelope" }, "send", .{ .type_ = .anyone });
    const sig = try child.signDigest(digest);
    try es.append(a, .{ .key = "signature", .value = .{ .bytes = try a.dupe(u8, sig.asSlice()) } });
    return scbor.encode(a, .{ .map = try a.dupe(scbor.Entry, &.{
        .{ .key = "message", .value = .{ .map = es.items } },
        .{ .key = "body", .value = .{ .bytes = body_bytes } },
    }) });
}

fn expectUnauthenticated(o: messages.Opened) !void {
    switch (o) {
        .ok => return error.TestExpectedRefusal,
        .refused => |r| try expectRefused(r, .unauthenticated),
    }
}

test "direct call: the frame is a signed-message package for this validator and this call; anything else is refused unauthenticated" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const me = key33(vec.identity);
    const body = try spendBody(a, "tx bytes", .{ .txid = .{1} ** 32, .vout = 0 });

    const frame = try package(a, sender_priv, me, "swap", body);
    const opened = try messages.open(a, frame, me, .swap);
    const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(sender_priv));
    try testing.expectEqualSlices(u8, &(try kd.identityKey()).toCompressedSec1(), &opened.ok.sender);
    try testing.expectEqualSlices(u8, "tx bytes", opened.ok.body.getBytes("tx").?);

    // For another validator; for another call; not a package; tampered.
    try expectUnauthenticated(try messages.open(a, frame, key33(vec.pool0.validator), .swap));
    try expectUnauthenticated(try messages.open(a, frame, me, .add_liquidity));
    try expectUnauthenticated(try messages.open(a, try cbor.encode(a, body), me, .swap));
    try expectUnauthenticated(try messages.open(a, "nonsense", me, .swap));
    const other = try package(a, sender_priv, me, "swap", try spendBody(a, "other bytes", .{ .txid = .{1} ** 32, .vout = 0 }));
    const pkg = try scbor.decode(a, frame);
    const swapped = try scbor.encode(a, .{ .map = try a.dupe(scbor.Entry, &.{
        .{ .key = "message", .value = pkg.get("message").? },
        .{ .key = "body", .value = (try scbor.decode(a, other)).get("body").? },
    }) });
    try expectUnauthenticated(try messages.open(a, swapped, me, .swap)); // a body the message does not name
}

test "protocol: request bodies parse; bad ones are refused; replies encode" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const op = m.pool_op;
    const op_text = try op.format(a);
    try testing.expectEqual(@as(usize, 66), op_text.len);
    try testing.expect(Outpoint.parse(op_text).?.eql(op));
    try testing.expect(Outpoint.parse("ab_0") == null);
    try testing.expect(Outpoint.parse(try std.mem.concat(a, u8, &.{ op_text[0..64], "_01" })) == null);
    try testing.expect(Outpoint.parse(try std.mem.concat(a, u8, &.{ op_text[0..64], "_" })) == null);

    // Through the bytes a taker sends, packaged and opened as the handler opens them.
    const req = try m.swapRequest(a);
    const frame = try package(a, sender_priv, m.f.cfg.identity, "swap", try spendBody(a, req, op));
    const body = (try messages.open(a, frame, m.f.cfg.identity, .swap)).ok.body;
    const r = try messages.respond(a, .swap, body, try m.deps());
    try testing.expect(r.reply == .ok and r.next == .submit);
    const reply = try cbor.decode(a, try cbor.encode(a, try messages.replyValue(a, r.reply)));
    try testing.expectEqual(true, reply.getBool("ok").?);
    try testing.expectEqualSlices(u8, m.f.raw("swap_bsv_in"), reply.getBytes("tx").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(m.f.raw("swap_bsv_in"))), reply.getText("txid").?);

    // Missing fields, a numeric pool for a spend, a text pool for a deploy.
    const d = try m.deps();
    try expectRefused((try messages.respond(a, .swap, .{ .map = &.{.{ .key = "tx", .value = .{ .bytes = req } }} }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .add_liquidity, .{ .map = &.{ .{ .key = "tx", .value = .{ .bytes = req } }, .{ .key = "pool", .value = .{ .uint = 0 } } } }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .deploy, .{ .map = &.{ .{ .key = "tx", .value = .{ .bytes = req } }, .{ .key = "pool", .value = .{ .text = op_text } } } }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .swap, .{ .text = "hi" }, d)).reply, .bad_request);

    // A refusal: {ok: false, reason, detail}.
    const refused = try messages.replyValue(a, .{ .refused = .{ .reason = .not_our_pool, .detail = "x" } });
    try testing.expectEqual(@as(usize, 3), refused.map.len);
    try testing.expectEqualStrings("not_our_pool", refused.getText("reason").?);

    try testing.expectEqual(validator.Op.add_liquidity, validator.Op.parse("addLiquidity").?);
    try testing.expect(validator.Op.parse("removeLiquidity") == null);
}

test "protocol: a deploy the node already holds is not judged again: routed, and answered from the state ({ok: true, txid})" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    // The fixture pool deploy, which the node took through its submit (mined).
    const body = try deployBody(a, try m.beef(a, &.{"pool_deploy"}, null));
    const dr = try messages.respond(a, .deploy, body, try m.deps());
    try testing.expect(dr.next == .from_state);
    try testing.expectEqual(@as(usize, 0), dr.broadcast.len);
    const ans = try m.answerDeploy(a, body);
    try testing.expect(ans == .ok);
    const dv = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(@as(usize, 2), dv.map.len);
    try testing.expectEqual(true, dv.getBool("ok").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(m.f.raw("pool_deploy"))), dv.getText("txid").?);
}

// --- the marketplace relay's request: a swap with its funding as an unproven parent ---

/// The fixtures' taker (gen/main.go `key(30)`), who owns fund:1.
const taker_priv: [32]u8 = .{30} ** 32;

fn pushNum(a: std.mem.Allocator, n: u64) ![]u8 {
    if (n == 0) return a.dupe(u8, &.{0});
    if (n <= 16) return a.dupe(u8, &.{@intCast(0x50 + n)});
    var b: [9]u8 = undefined;
    var len: usize = 0;
    var x = n;
    while (x > 0) : (x >>= 8) {
        b[len] = @intCast(x & 0xff);
        len += 1;
    }
    if (b[len - 1] & 0x80 != 0) {
        b[len] = 0;
        len += 1;
    }
    return unlock.pushData(a, b[0..len]);
}

fn p2pkhLock(a: std.mem.Allocator, pkh: []const u8) ![]u8 {
    return std.mem.concat(a, u8, &.{ &.{ 0x76, 0xa9, 0x14 }, pkh, &.{ 0x88, 0xac } });
}

/// Sign input `i` (P2PKH, ALL|FORKID): `<DER ‖ 0x41> <pubkey>`.
fn signP2pkh(a: std.mem.Allocator, tx: *Transaction, i: usize, src: []const u8, sats: u64, priv: [32]u8) !void {
    const k = try bsvz.primitives.ec.PrivateKey.fromBytes(priv);
    const sig = try k.signDigest(unlock.sha256d(try unlock.preimage(a, tx, i, src, sats, unlock.sighash_all_forkid)));
    const pubkey = (try k.publicKey()).toCompressedSec1();
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = bsvz.script.Script.init(try std.mem.concat(a, u8, &.{ try unlock.pushData(a, try std.mem.concat(a, u8, &.{ sig.asSlice(), &.{0x41} })), try unlock.pushData(a, &pubkey) }));
    tx.inputs = ins;
}

/// The pair the relay forwards (docs/notes.md 2026-10-02, "Swap funding and
/// signing"), derived from the fixtures: `funding` spends the taker's fund:1
/// and pays one exact output (the swap's input) plus change; `swap` is
/// `swap_bsv_in` with its other input that output and no change output
/// (`_changeAmount = 0`), its contract outputs as they are (the commission
/// at output 4 to the fixtures' relay, `commission_pkh`), the preimage the
/// pool call pushes recomputed, the validator's slot empty, the funding
/// input signed by the taker. `funding_sig` leaves the funding transaction's
/// own input signed, unsigned, or with a bad signature.
const RelayPair = struct { funding: []const u8, swap: []const u8 };

const FundingSig = enum { signed, unsigned, bad };

fn relayPair(a: std.mem.Allocator, f: *Fx, funding_sig: FundingSig) !RelayPair {
    const fund = try Transaction.parse(a, f.raw("fund"));
    const pd = try Transaction.parse(a, f.raw("pool_deploy"));
    const base = try Transaction.parse(a, f.raw("swap_bsv_in"));
    const taker_pkh = bsvz.crypto.hash.hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(taker_priv)).publicKey()).toCompressedSec1()).bytes;
    const taker_lock = try p2pkhLock(a, &taker_pkh);

    // The contract's outputs: pool, payout, LP fee, validator fee, commission.
    const outs = base.outputs[0..5];
    var out_sum: u64 = 0;
    for (outs) |o| out_sum += @intCast(o.satoshis);
    const pool_sats: u64 = @intCast(pd.outputs[0].satoshis);
    const exact = out_sum - pool_sats + 500;

    var ft = fund;
    ft.inputs = try a.dupe(bsvz.transaction.Input, &.{.{
        .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f.raw("fund")) }, .index = 1 },
        .unlocking_script = bsvz.script.Script.empty(),
        .sequence = 0xffffffff,
    }});
    ft.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = bsvz.script.Script.init(taker_lock) },
        .{ .satoshis = @intCast(500_000 - exact - 300), .locking_script = bsvz.script.Script.init(taker_lock) },
    });
    if (funding_sig != .unsigned) try signP2pkh(a, &ft, 0, fund.outputs[1].locking_script.bytes, @intCast(fund.outputs[1].satoshis), taker_priv);
    if (funding_sig == .bad) {
        const u = try a.dupe(u8, ft.inputs[0].unlocking_script.bytes);
        u[u[0] - 1] ^= 0x01; // the DER signature's last byte
        const fins = try a.dupe(bsvz.transaction.Input, ft.inputs);
        fins[0].unlocking_script = bsvz.script.Script.init(u);
        ft.inputs = fins;
    }
    const f_raw = try ft.serialize(a);

    var s = base;
    const ins = try a.dupe(bsvz.transaction.Input, &.{ base.inputs[0], .{
        .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f_raw) }, .index = 0 },
        .unlocking_script = bsvz.script.Script.empty(),
        .sequence = 0xffffffff,
    } });
    s.inputs = ins;
    s.outputs = outs;
    const lock = brc162.decode(pd.outputs[0].locking_script.bytes).?.lock;
    const pre = try unlock.preimage(a, &s, 0, unlock.poolScriptCode(lock).?, pool_sats, unlock.sighash_all_forkid);
    const call = (try unlock.parseCall(a, base.inputs[0].unlocking_script.bytes, .swap)).?;
    // _codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
    // commissionPkh, _changePKH, _changeAmount, txPreimage, methodIndex.
    try testing.expectEqualSlices(u8, &key20(vec.commission_pkh), call.arg(5).data);
    var script: std.ArrayList(u8) = .empty;
    for (call.pushes, 0..) |p, i| try script.appendSlice(a, switch (i) {
        1 => &.{0}, // validatorSig: the slot, empty
        8 => &.{0}, // _changeAmount = 0: no change output
        9 => try unlock.pushData(a, pre),
        else => call.script[p.start..p.p.next],
    });
    ins[0].unlocking_script = bsvz.script.Script.init(script.items);
    try signP2pkh(a, &s, 1, taker_lock, exact, taker_priv);
    return .{ .funding = f_raw, .swap = try s.serialize(a) };
}

/// The relay's request BEEF: fund (proven in the mined block), the funding transaction (unproven), the swap.
fn relayBeef(a: std.mem.Allocator, m: *Mined, p: RelayPair) ![]const u8 {
    const fund = m.f.raw("fund");
    const bumps = try a.alloc(w.merkle.MerklePath, 1);
    bumps[0] = try w.merkle.MerklePath.parse(a, try bump4(a, 1, m.leaves, &.{0}));
    return w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = bumps, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(fund), .format = .raw_with_bump, .bump = 0, .raw = fund },
        .{ .txid = txidOf(p.funding), .format = .raw, .raw = p.funding },
        .{ .txid = txidOf(p.swap), .format = .raw, .raw = p.swap },
    }) });
}

test "relay request: a swap with its funding transaction as an unproven parent, one BEEF — the funding checked complete, the pool input signed last, both submitted (the parent for the validator to broadcast, the swap through skein's submit), admitted" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const p = try relayPair(a, m.f, .signed);
    const req = try relayBeef(a, m, p);

    const served = try m.respond(a, req);
    try testing.expect(served.reply == .ok);
    try testing.expectEqual(@as(usize, 1), m.f.oracle.calls); // one signature: the pool input's
    const signed = served.reply.ok.tx.?;
    // Signed last: the signed swap is the request with the validator's signature in its slot, every other byte as sent;
    // the taker's signature over it still verifies (SIGHASH_ALL does not cover the pool input's unlocking script).
    try testing.expectEqualSlices(u8, p.swap, try request(a, signed, 0));
    const st = try Transaction.parse(a, signed);
    const ft = try Transaction.parse(a, p.funding);
    try testing.expectEqual(unlock.InputCheck.verified, try unlock.checkInput(a, &st, 1, ft.outputs[0].locking_script.bytes, @intCast(ft.outputs[0].satoshis)));
    const spent = (try pool.parse(brc162.decode((try Transaction.parse(a, m.f.raw("pool_deploy"))).outputs[0].locking_script.bytes).?.lock)).?;
    const sc = (try unlock.parseCall(a, st.inputs[0].unlocking_script.bytes, .swap)).?;
    try testing.expect(unlock.verify(sc.arg(0).data, &spent.validator, unlock.sha256d(sc.preimage()), unlock.sighash_all_forkid));

    // The parent to broadcast: the funding transaction (fund is proven in the BEEF), with its Atomic BEEF.
    try testing.expectEqual(@as(usize, 1), served.broadcast.len);
    try testing.expectEqualSlices(u8, &txidOf(p.funding), &served.broadcast[0].txid);
    try testing.expectEqualSlices(u8, p.funding, served.broadcast[0].raw);
    const ab = try w.beef.parse(a, served.broadcast[0].beef);
    try testing.expectEqualSlices(u8, &txidOf(p.funding), &ab.atomic.?);
    try testing.expectEqual(@as(usize, 2), ab.entries.len); // fund (with its BUMP), the funding transaction
    try testing.expectEqualSlices(u8, &txidOf(m.f.raw("fund")), &ab.entries[0].txid);

    // The swap's submission: the engine's route verified the BEEF (the pool contract and both P2PKH spends
    // run), which carries fund, the funding transaction, the signed swap; the chain app ingests it,
    // registering and broadcasting the funding transaction and the swap, parents first; RECEIVED admits it.
    const ev = readBack(a, try m.node.launched(served));
    const txs = try txsOf(a, ev);
    try testing.expectEqual(@as(usize, 3), txs.len);
    try testing.expectEqualSlices(u8, p.funding, txs[1]);
    try testing.expectEqualSlices(u8, signed, txs[2]);
    const first = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first.gate);
    try testing.expectEqual(@as(usize, 2), m.node.posts); // the funding transaction and the swap, by the chain app
    try testing.expect((try (try m.node.chain()).txRaw(txidOf(p.funding))) != null); // held now
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, done.applied[0].outputs_to_admit);
    const ans = try m.answer(a, req);
    try testing.expect(ans == .ok);
    try testing.expectEqualSlices(u8, signed, ans.ok.tx.?);

    // Sent again (pending → admitted now): answered from the state, nothing broadcast again.
    const again = try m.respond(a, req);
    try testing.expect(again.next == .from_state);
    try testing.expectEqual(@as(usize, 0), again.broadcast.len);
}

test "relay request refused: an unsigned funding input, a bad funding signature, a pool already spent — nothing signed, nothing to broadcast" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);

    // The funding transaction's input unsigned.
    {
        const p = try relayPair(a, m.f, .unsigned);
        const r = try m.respond(a, try relayBeef(a, m, p));
        try expectRefused(r.reply, .missing_signature);
        try testing.expect(std.mem.startsWith(u8, r.reply.refused.detail.?, "parent "));
        try testing.expect(r.next == .answer);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
    // Its signature bad (verified against fund:1, which the BEEF carries).
    {
        const p = try relayPair(a, m.f, .bad);
        const r = try m.respond(a, try relayBeef(a, m, p));
        try expectRefused(r.reply, .bad_signature);
        try testing.expect(std.mem.startsWith(u8, r.reply.refused.detail.?, "parent "));
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
    // The pool already spent (another swap admitted first): refused with its newest state, nothing broadcast.
    {
        const first = try m.respond(a, try m.swapRequest(a));
        const fev = try m.node.launched(first);
        _ = try m.node.step(fev);
        _ = try m.node.status(fev, "RECEIVED");
        m.f.oracle.calls = 0;
        const p = try relayPair(a, m.f, .signed);
        const r = try m.respond(a, try relayBeef(a, m, p));
        try expectRefused(r.reply, .pool_spent);
        try testing.expect(r.reply.refused.newest != null);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
}

// --- the marketplace relay's deploy: the LP's deploy with its funding as an unproven parent ---

/// The fixtures' LP (gen/main.go `key(10)`): pool_deploy:2 (4,950,000 tokens) and fund:3 (100,000 sats) are its.
const lp_priv: [32]u8 = .{10} ** 32;

const DeployOpts = struct {
    sign_funding: bool = true,
    sign_deploy: bool = true,
    /// ValidatorPubKey: the identity's child for pool_deploy:<key_vout> (2: the first token input).
    key_vout: u32 = 2,
};

const RelayDeploy = struct { funding: []const u8, deploy: []const u8 };

/// A pool output: the fixture pool's code and fees, its state's reserve and ValidatorPubKey replaced, the prefix to match.
fn poolScript(a: std.mem.Allocator, fixture: []const u8, reserve: u64, validator_key: [33]u8) ![]u8 {
    const tok = brc162.decode(fixture).?;
    const lock = try a.dupe(u8, tok.lock);
    const st = lock[lock.len - pool.state_len ..];
    std.mem.writeInt(u64, st[0..8], reserve, .little);
    @memcpy(st[8 + 33 ..][0..33], &validator_key);
    var ib: [37]u8 = undefined;
    var ab: [10]u8 = undefined;
    return std.mem.concat(a, u8, &.{ brc162.pushId(&ib, tok.id.?), brc162.pushAmount(&ab, reserve), &.{0x6d}, lock });
}

/// The deploy the relay forwards (web/ui src/lp/poolDeploy.ts; amm-p2p's
/// `amm.pool.submit`), from the fixtures: the LP's funding transaction spends
/// fund:3 and pays one exact output (the pool's 50,000 sats + a 400 sat miner
/// fee) to the LP plus change; the deploy spends pool_deploy:2 (the first
/// token input) and that output, and writes the pool (50,000 sats / 1,000,000
/// tokens, our identity, ValidatorPubKey our child for pool_deploy:2, the
/// fixture's fees) and the 3,950,000 token change to the LP. No sats change.
fn relayDeploy(a: std.mem.Allocator, f: *Fx, o: DeployOpts) !RelayDeploy {
    const fund = try Transaction.parse(a, f.raw("fund"));
    const pd_raw = f.raw("pool_deploy");
    const pd = try Transaction.parse(a, pd_raw);
    const lp = bsvz.crypto.hash.hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(lp_priv)).publicKey()).toCompressedSec1()).bytes;
    const lp_lock = try p2pkhLock(a, &lp);
    const exact: u64 = 50_000 + 400;

    var ft = fund;
    ft.inputs = try a.dupe(bsvz.transaction.Input, &.{.{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f.raw("fund")) }, .index = 3 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff }});
    ft.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = bsvz.script.Script.init(lp_lock) },
        .{ .satoshis = @intCast(100_000 - exact - 300), .locking_script = bsvz.script.Script.init(lp_lock) },
    });
    if (o.sign_funding) try signP2pkh(a, &ft, 0, fund.outputs[3].locking_script.bytes, @intCast(fund.outputs[3].satoshis), lp_priv);
    const f_raw = try ft.serialize(a);

    const vkey = try pool.validatorKey(a, f.cfg.identity, txidOf(pd_raw), o.key_vout);
    var d = pd;
    d.inputs = try a.dupe(bsvz.transaction.Input, &.{
        .{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(pd_raw) }, .index = 2 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
        .{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f_raw) }, .index = 0 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
    });
    d.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = 50_000, .locking_script = bsvz.script.Script.init(try poolScript(a, pd.outputs[0].locking_script.bytes, 1_000_000, vkey)) },
        .{ .satoshis = 1, .locking_script = bsvz.script.Script.init(try pool.payoutScript(a, f.id, 3_950_000, lp, false)) },
    });
    if (o.sign_deploy) {
        try signP2pkh(a, &d, 0, pd.outputs[2].locking_script.bytes, 1, lp_priv);
        try signP2pkh(a, &d, 1, lp_lock, exact, lp_priv);
    }
    return .{ .funding = f_raw, .deploy = try d.serialize(a) };
}

/// The relay's deploy BEEF: fund and pool_deploy (proven in the mined block), the funding transaction (unproven), the deploy.
fn deployBeef(a: std.mem.Allocator, m: *Mined, p: RelayDeploy) ![]const u8 {
    const fund = m.f.raw("fund");
    const pd = m.f.raw("pool_deploy");
    const bumps = try a.alloc(w.merkle.MerklePath, 1);
    bumps[0] = try w.merkle.MerklePath.parse(a, try bump4(a, 1, m.leaves, &.{ 0, 2 }));
    return w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = bumps, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(fund), .format = .raw_with_bump, .bump = 0, .raw = fund },
        .{ .txid = txidOf(pd), .format = .raw_with_bump, .bump = 0, .raw = pd },
        .{ .txid = txidOf(p.funding), .format = .raw, .raw = p.funding },
        .{ .txid = txidOf(p.deploy), .format = .raw, .raw = p.deploy },
    }) });
}

test "relay deploy: the LP's deploy with its funding as an unproven parent, one BEEF — consent, the deploy submitted through skein's submit as it came (nothing signed), the funding handed back to broadcast, admitted; answered {ok: true, txid}" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const p = try relayDeploy(a, m.f, .{});
    const req = try deployBeef(a, m, p);

    const served = try m.respondDeploy(a, req);
    try testing.expect(served.reply == .ok);
    try testing.expectEqual(@as(usize, 1), m.f.oracle.calls); // the key check only: getPublicKey, no signature
    try testing.expectEqualSlices(u8, p.deploy, served.reply.ok.tx.?); // the deploy as it came

    // The parent to broadcast: the funding transaction, with its Atomic BEEF (fund, proven, then itself).
    try testing.expectEqual(@as(usize, 1), served.broadcast.len);
    try testing.expectEqualSlices(u8, p.funding, served.broadcast[0].raw);
    const ab = try w.beef.parse(a, served.broadcast[0].beef);
    try testing.expectEqualSlices(u8, &txidOf(p.funding), &ab.atomic.?);
    try testing.expectEqual(@as(usize, 2), ab.entries.len);

    // The deploy's submission: the engine's route verified the BEEF (both LP spends), the topic admits it;
    // the chain app ingests it, registering and broadcasting the funding transaction and the deploy.
    const ev = readBack(a, try m.node.launched(served));
    try testing.expectEqualStrings(&w.header.toHex(txidOf(p.deploy)), ev.getText("txid").?);
    const txs = try txsOf(a, ev);
    try testing.expectEqualSlices(u8, p.deploy, txs[txs.len - 1]);
    const first = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first.gate);
    try testing.expectEqual(@as(usize, 2), m.node.posts);
    const body = try deployBody(a, req);
    try expectRefused(try m.answerDeploy(a, body), .pending);
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, done.applied[0].outputs_to_admit); // the pool, the token change

    const ans = try m.answerDeploy(a, body);
    try testing.expect(ans == .ok);
    const rv = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(true, rv.getBool("ok").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(p.deploy)), rv.getText("txid").?);
    try testing.expect(rv.get("tx") == null);

    // Sent again: held, routed again, answered from the state; nothing broadcast again, no oracle call.
    m.f.oracle.calls = 0;
    const again = try m.respondDeploy(a, req);
    try testing.expect(again.next == .from_state);
    try testing.expectEqual(@as(usize, 0), again.broadcast.len);
    try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
}

test "relay deploy refused: a wrong ValidatorPubKey, an unsigned funding input, an unsigned deploy input, fees out of terms, another validator's pool — nothing to broadcast or submit; a rejection by the network is answered rejected" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);

    const Case = struct { o: DeployOpts, reason: validator.Reason, detail_prefix: ?[]const u8 = null };
    for ([_]Case{
        .{ .o = .{ .key_vout = 1 }, .reason = .wrong_validator_key },
        .{ .o = .{ .sign_funding = false }, .reason = .missing_signature, .detail_prefix = "parent " },
        .{ .o = .{ .sign_deploy = false }, .reason = .missing_signature, .detail_prefix = "input 0" },
    }) |c| {
        const r = try m.respondDeploy(a, try deployBeef(a, m, try relayDeploy(a, m.f, c.o)));
        try expectRefused(r.reply, c.reason);
        if (c.detail_prefix) |dp| try testing.expect(std.mem.startsWith(u8, r.reply.refused.detail.?, dp));
        try testing.expect(r.next == .answer);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
    }
    const p = try relayDeploy(a, m.f, .{});
    const req = try deployBeef(a, m, p);
    {
        var d = try m.deps();
        d.config.max_commission_bps = 5;
        const r = try messages.respond(a, .deploy, try deployBody(a, req), d);
        try expectRefused(r.reply, .fees_unacceptable);
        try testing.expectEqualStrings("commissionBps", r.reply.refused.detail.?);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        d = try m.deps();
        d.config.identity = key33(vec.pool0.validator);
        const r2 = try messages.respond(a, .deploy, try deployBody(a, req), d);
        try expectRefused(r2.reply, .not_our_pool);
        try testing.expectEqual(@as(usize, 0), r2.broadcast.len);
    }
    try testing.expectEqual(@as(usize, 0), m.node.posts);
    try testing.expect((try (try m.node.chain()).txRaw(txidOf(p.deploy))) == null); // nothing submitted

    // Consent, then the network rejects the deploy: answered rejected.
    const ok = try m.respondDeploy(a, req);
    const okev = try m.node.launched(ok);
    _ = try m.node.step(okev);
    _ = try m.node.status(okev, "REJECTED");
    const ans = try m.answerDeploy(a, try deployBody(a, req));
    try expectRefused(ans, .rejected);
    try testing.expectEqualSlices(u8, &txidOf(p.deploy), &ans.refused.txid.?);
}

// --- the marketplace relay's AddLiquidity: the LP's add with its funding as an unproven parent ---

/// The relay's AddLiquidity BEEF: fund and pool_deploy (proven in the mined
/// block: pool_deploy carries the LP's token input), the funding transaction
/// (unproven), the AddLiquidity — what amm-p2p's `amm.liquidity.submit` sends.
fn addBeef(a: std.mem.Allocator, m: *Mined, funding: []const u8, add: []const u8) ![]const u8 {
    return deployBeef(a, m, .{ .funding = funding, .deploy = add });
}

/// The funded fixture's request: `add_liquidity_funded` with the validator's slot (arg 1) empty.
fn fundedRequest(a: std.mem.Allocator) ![]const u8 {
    return request(a, unhex(a, addliq.add_liquidity_funded), 1);
}

const LpSig = enum { signed, empty, bad };

const AddOpts = struct {
    sign_funding: bool = true,
    lp_sig: LpSig = .signed,
    /// The call's nextLpPubKey replaced (the continuation keeps the fixture's key(12)).
    next_lp: ?[33]u8 = null,
    /// The call's addBsv replaced (the continuation keeps the fixture's reserve).
    add_bsv: ?u64 = null,
    /// An output after the pool (the contract writes none: no change).
    extra_output: bool = false,
};

const RelayAdd = struct { funding: []const u8, add: []const u8 };

/// The funded AddLiquidity, rebuilt here so a test can break one thing: the
/// fixture's funding transaction (its input left unsigned when asked, so its
/// txid moves and the add's funding input follows it); the add's pool call
/// with the preimage recomputed, the LP's slot signed by the pool's LpPubKey
/// (the fixture LP, key(10)) here, empty, or with a bad signature, the
/// validator's slot empty; the LP's token and funding inputs signed again.
fn relayAdd(a: std.mem.Allocator, f: *Fx, o: AddOpts) !RelayAdd {
    var ft = try Transaction.parse(a, unhex(a, addliq.add_funding));
    if (!o.sign_funding) {
        const fins = try a.dupe(bsvz.transaction.Input, ft.inputs);
        fins[0].unlocking_script = bsvz.script.Script.empty();
        ft.inputs = fins;
    }
    const f_raw = try ft.serialize(a);
    const base = try Transaction.parse(a, unhex(a, addliq.add_liquidity_funded));
    const pd = try Transaction.parse(a, f.raw("pool_deploy"));
    var t = base;
    const ins = try a.dupe(bsvz.transaction.Input, base.inputs);
    ins[2].previous_outpoint = .{ .txid = .{ .bytes = txidOf(f_raw) }, .index = 0 };
    t.inputs = ins;
    if (o.extra_output) {
        const outs = try a.alloc(bsvz.transaction.Output, base.outputs.len + 1);
        @memcpy(outs[0..base.outputs.len], base.outputs);
        outs[base.outputs.len] = .{ .satoshis = 1_000, .locking_script = ft.outputs[1].locking_script };
        t.outputs = outs;
    }
    const lock = brc162.decode(pd.outputs[0].locking_script.bytes).?.lock;
    const pre = try unlock.preimage(a, &t, 0, unlock.poolScriptCode(lock).?, @intCast(pd.outputs[0].satoshis), unlock.sighash_all_forkid);
    const k = try bsvz.primitives.ec.PrivateKey.fromBytes(lp_priv);
    const der = (try k.signDigest(unlock.sha256d(pre))).asSlice();
    const lp_sig = try std.mem.concat(a, u8, &.{ der, &.{0x41} });
    if (o.lp_sig == .bad) lp_sig[lp_sig.len - 2] ^= 0x01;
    const call = (try unlock.parseCall(a, base.inputs[0].unlocking_script.bytes, .add_liquidity)).?;
    // _codePart, lpSig, validatorSig, nextLpPubKey, nextValidatorPubKey, addBsv, addTokens,
    // _changePKH, _changeAmount, txPreimage, methodIndex.
    var script: std.ArrayList(u8) = .empty;
    for (call.pushes, 0..) |p, i| try script.appendSlice(a, switch (i) {
        1 => if (o.lp_sig == .empty) &.{0} else try unlock.pushData(a, lp_sig),
        2 => &.{0}, // validatorSig: the slot, empty
        3 => if (o.next_lp) |n| try unlock.pushData(a, &n) else call.script[p.start..p.p.next],
        5 => if (o.add_bsv) |n| try pushNum(a, n) else call.script[p.start..p.p.next],
        9 => try unlock.pushData(a, pre),
        else => call.script[p.start..p.p.next],
    });
    ins[0].unlocking_script = bsvz.script.Script.init(script.items);
    try signP2pkh(a, &t, 1, pd.outputs[2].locking_script.bytes, 1, lp_priv);
    try signP2pkh(a, &t, 2, ft.outputs[0].locking_script.bytes, @intCast(ft.outputs[0].satoshis), lp_priv);
    return .{ .funding = f_raw, .add = try t.serialize(a) };
}

test "relay addLiquidity: the LP's add with its funding as an unproven parent, one BEEF — the LP's signature checked, the pool input signed last (the Go fixture, byte for byte), the funding handed back to broadcast first, the add through skein's submit, admitted; answered {ok: true, tx, txid}" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    const want = unhex(a, addliq.add_liquidity_funded);
    const funding = unhex(a, addliq.add_funding);
    const add = try fundedRequest(a);
    const req = try addBeef(a, m, funding, add);
    try m.f.oracle.record(a, want, 1);

    const served = try m.respondAdd(a, req);
    try testing.expect(served.reply == .ok);
    try testing.expectEqual(@as(usize, 1), m.f.oracle.calls); // one signature: the pool input's
    const signed = served.reply.ok.tx.?;
    try testing.expectEqualSlices(u8, want, signed); // the Go fixture, interpreter-checked, byte for byte
    // Signed last: the request with the validator's signature in its slot, every other byte as the LP sent it;
    // the LP's signatures (its slot in the call, its token and funding inputs) still verify.
    try testing.expectEqualSlices(u8, add, try request(a, signed, 1));
    const st = try Transaction.parse(a, signed);
    const ft = try Transaction.parse(a, funding);
    try testing.expectEqual(unlock.InputCheck.verified, try unlock.checkInput(a, &st, 2, ft.outputs[0].locking_script.bytes, @intCast(ft.outputs[0].satoshis)));
    const spent = (try pool.parse(brc162.decode((try Transaction.parse(a, m.f.raw("pool_deploy"))).outputs[0].locking_script.bytes).?.lock)).?;
    const sc = (try unlock.parseCall(a, st.inputs[0].unlocking_script.bytes, .add_liquidity)).?;
    const digest = unlock.sha256d(sc.preimage());
    try testing.expect(unlock.verify(sc.arg(0).data, &spent.lp, digest, unlock.sighash_all_forkid));
    try testing.expect(unlock.verify(sc.arg(1).data, &spent.validator, digest, unlock.sighash_all_forkid));
    // The continuation: the reserves increased by what was added, the LP key rotated, the validator's the child of the pool.
    const next = (try pool.parse(brc162.decode(st.outputs[0].locking_script.bytes).?.lock)).?;
    try testing.expectEqual(@as(u64, addliq.pool5.bsv), @as(u64, @intCast(st.outputs[0].satoshis)));
    try testing.expectEqual(@as(u64, addliq.pool5.tokens), next.token_reserve);
    try testing.expectEqualSlices(u8, &key33(addliq.pool5.lp), &next.lp);
    try testing.expectEqualSlices(u8, &key33(addliq.pool5.validator), &next.validator);
    try testing.expectEqual(@as(usize, 1), st.outputs.len);

    // The parent to broadcast first: the funding transaction, with its Atomic BEEF (fund, proven, then itself).
    try testing.expectEqual(@as(usize, 1), served.broadcast.len);
    try testing.expectEqualSlices(u8, funding, served.broadcast[0].raw);
    const ab = try w.beef.parse(a, served.broadcast[0].beef);
    try testing.expectEqualSlices(u8, &txidOf(funding), &ab.atomic.?);
    try testing.expectEqual(@as(usize, 2), ab.entries.len);

    // The add's submission: the engine's route verified the BEEF (the pool contract, the LP's P2PKH
    // spends); the chain app ingests it, registering and broadcasting the funding transaction and the add;
    // the RECEIVED status admits the continuation.
    const ev = readBack(a, try m.node.launched(served));
    try testing.expectEqualStrings(&w.header.toHex(txidOf(want)), ev.getText("txid").?);
    const txs = try txsOf(a, ev);
    try testing.expectEqualSlices(u8, want, txs[txs.len - 1]);
    const first = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first.gate);
    try testing.expectEqual(@as(usize, 2), m.node.posts);
    try expectRefused(try m.answerAdd(a, req), .pending);
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{0}, done.applied[0].outputs_to_admit);

    const ans = try m.answerAdd(a, req);
    try testing.expect(ans == .ok);
    const rv = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(true, rv.getBool("ok").?);
    try testing.expectEqualSlices(u8, want, rv.getBytes("tx").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(want)), rv.getText("txid").?);

    // Sent again: answered from the state, not signed again, nothing broadcast again.
    m.f.oracle.calls = 0;
    const again = try m.respondAdd(a, req);
    try testing.expect(again.next == .from_state);
    try testing.expectEqual(@as(usize, 0), again.broadcast.len);
    try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
}

test "relay addLiquidity refused: the funding unsigned, the LP's slot empty or badly signed, the outputs not the contract's (the LP key, the BSV reserve, an extra output), the pool already spent — nothing signed, nothing broadcast or submitted" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);

    // relayAdd as it stands is the fixture but for the LP's signature bytes: accepted (checked below, after the refusals).
    const Case = struct { o: AddOpts, reason: validator.Reason, detail: []const u8 };
    for ([_]Case{
        .{ .o = .{ .sign_funding = false }, .reason = .missing_signature, .detail = "parent " },
        .{ .o = .{ .lp_sig = .empty }, .reason = .missing_signature, .detail = "the LP's" },
        .{ .o = .{ .lp_sig = .bad }, .reason = .bad_signature, .detail = "the LP's" },
        .{ .o = .{ .next_lp = key33(vec.identity) }, .reason = .bad_outputs, .detail = "the continuation's LpPubKey" },
        .{ .o = .{ .add_bsv = addliq.add_funded_bsv + 1 }, .reason = .bad_outputs, .detail = "the continuation's BSV reserve" },
        .{ .o = .{ .extra_output = true }, .reason = .bad_outputs, .detail = "outputs past the contract's" },
    }) |c| {
        const p = try relayAdd(a, m.f, c.o);
        const r = try m.respondAdd(a, try addBeef(a, m, p.funding, p.add));
        try expectRefused(r.reply, c.reason);
        try testing.expect(std.mem.startsWith(u8, r.reply.refused.detail.?, c.detail));
        try testing.expect(r.next == .answer);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    }
    try testing.expectEqual(@as(usize, 0), m.node.posts);

    // Rebuilt here (bsvz's signature in the LP's slot): signed and admitted.
    const p = try relayAdd(a, m.f, .{});
    const ok = try m.respondAdd(a, try addBeef(a, m, p.funding, p.add));
    try testing.expect(ok.reply == .ok);
    try testing.expectEqual(@as(usize, 1), ok.broadcast.len);
    const okev = try m.node.launched(ok);
    _ = try m.node.step(okev);
    _ = try m.node.status(okev, "RECEIVED");

    // The pool already spent (that add admitted): the fixture's add is refused with the newest state, nothing broadcast.
    m.f.oracle.calls = 0;
    const posts = m.node.posts;
    const r = try m.respondAdd(a, try addBeef(a, m, unhex(a, addliq.add_funding), try fundedRequest(a)));
    try expectRefused(r.reply, .pool_spent);
    const n = r.reply.refused.newest.?.live;
    try testing.expectEqualSlices(u8, &txidOf(p.add), &txidOf((try request(a, (try (try m.node.chain()).txRaw(n.outpoint.txid)).?, 1))));
    try testing.expectEqual(@as(u64, addliq.pool5.bsv), n.satoshis);
    try testing.expectEqual(@as(u64, addliq.pool5.tokens), n.pool.token_reserve);
    try testing.expectEqual(@as(usize, 0), r.broadcast.len);
    try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
    try testing.expectEqual(posts, m.node.posts);
}
