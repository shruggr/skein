//! The validator, natively: the direct call's package, the protocol's
//! bodies, the refusals, the signing path against the Go fixtures, and the
//! submission through the overlay engine's own submit (the route, the
//! submission thread, the chain app's answers) with the answer read from the
//! state after it. The swaps and the deploy are gen/vectors' (src/fixtures);
//! each pool spend was run through the go-sdk interpreter with the validator's
//! signature in place. A request is that transaction with the validator's
//! slot emptied (`OP_0`), as a taker sends it (a deploy: the LP's delivered
//! deploy, before the claim); the validator, signing through a mock oracle
//! holding the fixtures' identity key, must give back the fixture byte for
//! byte (RFC 6979 signatures on both sides). Then the claim's filing and the
//! rescind (0.9.0), with a mocked wallet.
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
const filing = @import("src/filing.zig");
const rescind = @import("src/rescind.zig");

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

    /// Record the validator's claim signature in a claimed deploy (its output `vout`): the
    /// payload, over the pool's script and the first token input.
    fn recordClaim(self: *KeyOracle, a: std.mem.Allocator, claimed: []const u8, vout: usize) !void {
        const tx = try Transaction.parse(a, claimed);
        const first = tx.inputs[0].previous_outpoint;
        const id = brc162.decode(tx.outputs[0].locking_script.bytes).?.id.?.txid;
        const cl = pool.claimOf(tx.outputs[vout].locking_script.bytes, id).?;
        self.recorded = .{ .hash = pool.claimDigest(tx.outputs[0].locking_script.bytes, first.txid.bytes, first.index), .der = cl.sig };
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
        inline for (.{ "fund", "token_deploy", "pool_deploy", "pool_deploy_delivered", "pool_deploy_forged", "pool_deploy_wrong_key", "swap_bsv_in", "swap_tokens_in", "close", "close_fee", "rescind" }) |n| {
            if (std.mem.eql(u8, n, name)) return unhex(self.a, @field(vec, n));
        }
        @panic("no fixture");
    }

    /// The overlay after holding `names`, in order.
    fn init(a: std.mem.Allocator, names: []const []const u8) !*Fx {
        const f = try a.create(Fx);
        const id = w.beef.txidOf(unhex(a, vec.token_deploy));
        // Validating the fixture token's topic (registered: 0.8.1, every skein validates every registered token).
        const validated = try a.dupe([]const u8, &.{try validator.topicOf(a, id)});
        f.* = .{ .a = a, .id = id, .mem = MemView.init(a, id), .cfg = .{
            .identity = key33(vec.identity),
            .terms = .{ .lp_fee_bps = vec.lp_fee_bps, .validator_fee_bps = vec.validator_fee_bps, .commission_bps = vec.commission_bps },
            .validated = validated,
        } };
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

/// A swap request body: `{tx, pool}`.
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

test "sign: the current key is the child of the first token input of the transaction that created the pool (0.9.0: no LP-only spend carries it over)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in" });
    for ([_]struct { name: []const u8, key: []const u8, by: Outpoint }{
        .{ .name = "pool_deploy", .key = vec.pool0.validator, .by = .{ .txid = f.id, .vout = 0 } },
        .{ .name = "swap_bsv_in", .key = vec.pool1.validator, .by = .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 } },
    }) |c| {
        const op: Outpoint = .{ .txid = txidOf(f.raw(c.name)), .vout = 0 };
        const kid = (try validator.currentKeyId(a, f.mem.view(), f.id, f.cfg.identity, op, key33(c.key))).?;
        try testing.expect(kid.eql(c.by));
        try testing.expect((try validator.currentKeyId(a, f.mem.view(), f.id, f.cfg.identity, op, key33(vec.identity))) == null);
    }
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
    // A Close in the swap box (the LP's alone: no validator call).
    {
        const h = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in" });
        const r = try h.spend(.swap, h.raw("close_fee"), .{ .txid = txidOf(h.raw("swap_tokens_in")), .vout = 0 });
        try expectRefused(r, .wrong_method);
        try testing.expectEqualStrings("close", r.refused.detail.?);
        try expectRefused(try h.spend(.deploy, req, op), .bad_request);
    }
    // Already signed (the slot is not OP_0).
    try expectRefused(try f.spend(.swap, f.raw("swap_bsv_in"), op), .signature_slot_not_empty);
    // Not a transaction.
    try expectRefused(try f.spend(.swap, "nonsense", op), .bad_transaction);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);
}

test "the validated topics (0.3.2; 0.8.1: the registered set, always): in it, a swap and a deploy are signed as before; not in it, each is refused not_validating, nothing signed" {
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
    }
    try testing.expectEqual(calls, f.oracle.calls);

    // A deploy: consent in the set; refused out of it (the token not yet held, and held already).
    const g = try Fx.init(a, &.{ "fund", "token_deploy" });
    const d = g.raw("pool_deploy_delivered");
    try g.oracle.recordClaim(a, g.raw("pool_deploy"), vec.claim_vout);
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

    // Past the Close: the pool is closed, by it.
    _ = try f.mem.hold(f.raw("close"));
    const r2 = try f.spend(.swap, stale, .{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 });
    const closed = r2.refused.newest.?.closed;
    try testing.expect(closed.last.eql(.{ .txid = txidOf(f.raw("swap_tokens_in")), .vout = 0 }));
    try testing.expectEqualSlices(u8, &txidOf(f.raw("close")), &closed.by);
}

// --- deploy consent ---

/// `raw` with every input re-signed by `priv` under `scope` (each P2PKH source held in `f`).
fn resigned(a: std.mem.Allocator, f: *Fx, raw: []const u8, scope: u32) ![]const u8 {
    var tx = try Transaction.parse(a, raw);
    for (tx.inputs, 0..) |in, i| {
        const src = try Transaction.parse(a, f.mem.txs.get(in.previous_outpoint.txid.bytes).?);
        const o = src.outputs[in.previous_outpoint.index];
        try signP2pkhScope(a, &tx, i, o.locking_script.bytes, @intCast(o.satoshis), lp_priv, scope);
    }
    return tx.serialize(a);
}

test "deploy (0.9.0): the LP's delivered deploy — every input SIGHASH_SINGLE, paired with its output, one unit unassigned — comes back with the claim appended, the Go fixture byte for byte; the claim's submission and filing" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy" });
    const d = f.raw("pool_deploy_delivered");
    try f.oracle.recordClaim(a, f.raw("pool_deploy"), vec.claim_vout);

    const ok = try f.deploy(d, 0);
    try testing.expect(ok == .ok);
    try testing.expectEqualSlices(u8, f.raw("pool_deploy"), ok.ok.tx.?);
    try testing.expectEqualSlices(u8, &txidOf(f.raw("pool_deploy")), &ok.ok.txid.?);
    const sub = ok.ok.submission.?;
    try testing.expectEqualStrings(try validator.topicOf(a, f.id), sub.topic);
    try testing.expect(sub.pool.eql(.{ .txid = txidOf(f.raw("pool_deploy")), .vout = 0 }));
    try testing.expectEqual(@as(usize, 0), sub.parents.len); // raw: no parents to broadcast
    // The claim to file: its output and its key ID (the first token input, token_deploy:0).
    try testing.expectEqual(@as(u32, vec.claim_vout), sub.claim.?.vout);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(f.id)}), sub.claim.?.key_id);
    try testing.expectEqual(@as(usize, 2), f.oracle.calls); // the key check (getPublicKey) and the claim (createSignature)
    // The claim verifies against the pool's validator key, and the topic admits it.
    const claimed = try Transaction.parse(a, ok.ok.tx.?);
    const p = (try pool.parse(brc162.decode(claimed.outputs[0].locking_script.bytes).?.lock)).?;
    try testing.expectEqual(@as(?u32, vec.claim_vout), try pool.verifiedClaim(a, claimed.outputs, p, claimed.outputs[0].locking_script.bytes, f.id, 0));
    _ = try f.mem.hold(ok.ok.tx.?);
    try testing.expect(f.mem.admitted.contains(MemView.key(.{ .txid = ok.ok.txid.?, .vout = vec.claim_vout })));

    // Sent again (a retry): the claimed deploy held is answered, nothing signed again.
    f.oracle.calls = 0;
    const again = try f.deploy(d, 0);
    try testing.expectEqualSlices(u8, f.raw("pool_deploy"), again.ok.tx.?);
    try testing.expectEqual(@as(usize, 0), f.oracle.calls);

    // The filing (filing.zig): the wallet's internalize, the claim into `amm-claims` with how to spend it.
    const body = try filing.internalizeBody(a, "atomic", ok.ok.txid.?, vec.claim_vout, sub.claim.?.key_id);
    try testing.expectEqualStrings("internalize", body.getText("op").?);
    const out0 = body.getArray("outputs").?[0];
    try testing.expectEqual(@as(u64, vec.claim_vout), out0.getUint("outputIndex").?);
    try testing.expectEqualStrings("basket insertion", out0.getText("protocol").?);
    const rem = out0.get("insertionRemittance").?;
    try testing.expectEqualStrings(filing.basket, rem.getText("basket").?);
    const ci = try std.json.parseFromSliceLeaky(struct { protocolID: [2]std.json.Value, keyID: []const u8, counterparty: []const u8 }, a, rem.getText("customInstructions").?, .{ .ignore_unknown_fields = true });
    try testing.expectEqualStrings(sub.claim.?.key_id, ci.keyID);
    try testing.expectEqualStrings("anyone", ci.counterparty);
    try testing.expectEqualStrings("amm pool", ci.protocolID[1].string);
    // Launched on {body: <the body record>}, as a message to the wallet's box carries it.
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const args = try ms.store().getValue(a, try filing.launchArgs(a, ms.store(), body));
    try testing.expectEqualStrings("internalize", (try ms.store().getValue(a, args.getCid("body").?)).getText("op").?);
    const in: Value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "programs", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "wallet", .value = .{ .cid = "cid:wallet" } }}) } }}) };
    try testing.expectEqualStrings("cid:wallet", filing.walletProgram(in).?);
}

test "deploy (0.9.0) refused: the terms (the validator's fees, exactly), unpaired outputs, an input not SIGHASH_SINGLE, not one unit unassigned, the claim unfunded, a wrong ValidatorPubKey, unsigned, another validator's pool, no pool" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy" });
    const d = f.raw("pool_deploy_delivered");
    const tx = try Transaction.parse(a, d);

    // Our terms, each fee exactly.
    for ([_]validator.Terms{
        .{ .lp_fee_bps = 31, .validator_fee_bps = vec.validator_fee_bps, .commission_bps = vec.commission_bps },
        .{ .lp_fee_bps = vec.lp_fee_bps, .validator_fee_bps = 4, .commission_bps = vec.commission_bps },
        .{ .lp_fee_bps = vec.lp_fee_bps, .validator_fee_bps = vec.validator_fee_bps, .commission_bps = 0 },
    }, [_][]const u8{ "lpFeeBps: the terms are 31", "validatorFeeBps: the terms are 4", "commissionBps: the terms are 0" }) |t, why| {
        var cfg = f.cfg;
        cfg.terms = t;
        const r = try validator.deploy(a, .{ .tx = d, .pool = 0 }, cfg, f.mem.view(), f.oracle.oracle());
        try expectRefused(r, .fees_unacceptable);
        try testing.expectEqualStrings(why, r.refused.detail.?);
    }
    // One output fewer than the inputs (the sats change dropped).
    {
        var t = tx;
        t.outputs = tx.outputs[0..3];
        try expectRefused(try f.deploy(try t.serialize(a), 0), .not_paired);
    }
    // An input signed ALL|FORKID: the claim would break it.
    {
        const all = try resigned(a, f, d, unlock.sighash_all_forkid);
        const r = try f.deploy(all, 0);
        try expectRefused(r, .bad_sighash);
        try testing.expectEqualStrings("input 0", r.refused.detail.?);
    }
    // Two units unassigned (the LP's token change one lower).
    {
        var buf: [10]u8 = undefined;
        const lock = brc162.decode(tx.outputs[2].locking_script.bytes).?;
        const amount = lock.amount - 1;
        const s2 = try std.mem.concat(a, u8, &.{ &.{0x20}, &f.id, brc162.pushAmount(&buf, amount), &.{0x6d}, lock.lock });
        try expectRefused(try f.deploy(try withOutput(a, d, 2, s2), 0), .unassigned_not_one);
    }
    // The LP's sats change taking every sat: nothing left for the claim's.
    {
        var t = tx;
        const outs = try a.dupe(bsvz.transaction.Output, tx.outputs);
        outs[3].satoshis += vec.deploy_fee + 1;
        t.outputs = outs;
        try expectRefused(try f.deploy(try t.serialize(a), 0), .claim_unfunded);
    }
    // The pool naming a ValidatorPubKey that is not our child of the first token input.
    {
        const wk = try Transaction.parse(a, f.raw("pool_deploy_wrong_key"));
        var t = wk;
        t.outputs = wk.outputs[0..4];
        try expectRefused(try f.deploy(try t.serialize(a), 0), .wrong_validator_key);
    }
    // Unsigned; badly signed (the source of input 1, fund:0, is held).
    try expectRefused(try f.deploy(try withUnlocking(a, d, 0, &.{}), 0), .missing_signature);
    {
        // The DER's last byte flipped, the sighash byte (SINGLE|FORKID) kept.
        const u = try a.dupe(u8, tx.inputs[1].unlocking_script.bytes);
        u[u[0] - 1] ^= 0x01;
        const r = try f.deploy(try withUnlocking(a, d, 1, u), 0);
        try expectRefused(r, .bad_signature);
        try testing.expectEqualStrings("input 1", r.refused.detail.?);
    }
    // Another validator's; not at output 0; not a pool.
    var other = f.cfg;
    other.identity = key33(vec.pool0.validator);
    try expectRefused(try validator.deploy(a, .{ .tx = d, .pool = 0 }, other, f.mem.view(), f.oracle.oracle()), .not_our_pool);
    try expectRefused(try f.deploy(d, 1), .pool_not_at_output_0);
    try expectRefused(try f.deploy(f.raw("token_deploy"), 0), .not_a_pool);
    // Nothing signed: the oracle answered at most the key check (for the badly signed one).
    try testing.expect(f.oracle.calls <= 1);
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
    try expectUnauthenticated(try messages.open(a, frame, me, .deploy));
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
    try expectRefused((try messages.respond(a, .swap, .{ .map = &.{ .{ .key = "tx", .value = .{ .bytes = req } }, .{ .key = "pool", .value = .{ .uint = 0 } } } }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .deploy, .{ .map = &.{ .{ .key = "tx", .value = .{ .bytes = req } }, .{ .key = "pool", .value = .{ .text = op_text } } } }, d)).reply, .bad_request);
    try expectRefused((try messages.respond(a, .swap, .{ .text = "hi" }, d)).reply, .bad_request);

    // A refusal: {ok: false, reason, detail}.
    const refused = try messages.replyValue(a, .{ .refused = .{ .reason = .not_our_pool, .detail = "x" } });
    try testing.expectEqual(@as(usize, 3), refused.map.len);
    try testing.expectEqualStrings("not_our_pool", refused.getText("reason").?);

    try testing.expectEqual(validator.Op.deploy, validator.Op.parse("deploy").?);
    try testing.expect(validator.Op.parse("addLiquidity") == null); // 0.9.0: gone
    try testing.expect(validator.Op.parse("removeLiquidity") == null);
}

test "protocol: a deploy the node already holds claimed is not judged again: routed, and answered from the state ({ok: true, tx, txid})" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const m = try Mined.init(a, &ms);
    // The fixture pool deploy as the LP delivered it; the node took the claimed one through its submit (mined).
    const body = try deployBody(a, m.f.raw("pool_deploy_delivered"));
    const dr = try messages.respond(a, .deploy, body, try m.deps());
    try testing.expect(dr.next == .from_state);
    try testing.expectEqual(@as(usize, 0), dr.broadcast.len);
    const ans = try m.answerDeploy(a, body);
    try testing.expect(ans == .ok);
    const dv = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(@as(usize, 3), dv.map.len);
    try testing.expectEqual(true, dv.getBool("ok").?);
    try testing.expectEqualSlices(u8, m.f.raw("pool_deploy"), dv.getBytes("tx").?);
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
    return signP2pkhScope(a, tx, i, src, sats, priv, unlock.sighash_all_forkid);
}

/// Sign input `i` (P2PKH) under sighash `scope`: `<DER ‖ scope> <pubkey>`.
fn signP2pkhScope(a: std.mem.Allocator, tx: *Transaction, i: usize, src: []const u8, sats: u64, priv: [32]u8, scope: u32) !void {
    const k = try bsvz.primitives.ec.PrivateKey.fromBytes(priv);
    const sig = try k.signDigest(unlock.sha256d(try unlock.preimage(a, tx, i, src, sats, scope)));
    const pubkey = (try k.publicKey()).toCompressedSec1();
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = bsvz.script.Script.init(try std.mem.concat(a, u8, &.{ try unlock.pushData(a, try std.mem.concat(a, u8, &.{ sig.asSlice(), &.{@as(u8, @intCast(scope))} })), try unlock.pushData(a, &pubkey) }));
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

/// The fixtures' LP (gen/main.go `key(10)`): pool_deploy:2 (4,949,999 tokens) and fund:3 (100,000 sats) are its.
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

/// The deploy the relay forwards (web/ui src/lp/poolDeploy.ts; amm-p2p's `amm.pool.submit`), as the
/// LP delivers it (0.9.0), from the fixtures: the LP's funding transaction spends fund:3 and pays one
/// exact output (the pool's 50,000 sats, the token change's sat, the claim's and a 400 sat miner fee)
/// to the LP plus change; the deploy spends pool_deploy:2 (4,949,999 tokens: the first token input)
/// and that output, each SIGHASH_SINGLE|FORKID over its own output — 0 the pool (50,000 sats /
/// 1,000,000 tokens, our identity, ValidatorPubKey our child for pool_deploy:2, the fixture's fees),
/// 1 the LP's token change, 3,949,998 — one unit left for the claim.
fn relayDeploy(a: std.mem.Allocator, f: *Fx, o: DeployOpts) !RelayDeploy {
    const fund = try Transaction.parse(a, f.raw("fund"));
    const pd_raw = f.raw("pool_deploy");
    const pd = try Transaction.parse(a, pd_raw);
    const lp = bsvz.crypto.hash.hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(lp_priv)).publicKey()).toCompressedSec1()).bytes;
    const lp_lock = try p2pkhLock(a, &lp);
    const exact: u64 = 50_000 + 1 + 1 + 400 - 1; // the token input brings 1 sat

    var ft = fund;
    ft.inputs = try a.dupe(bsvz.transaction.Input, &.{.{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f.raw("fund")) }, .index = 3 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff }});
    ft.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = bsvz.script.Script.init(lp_lock) },
        .{ .satoshis = @intCast(100_000 - exact - 300), .locking_script = bsvz.script.Script.init(lp_lock) },
    });
    if (o.sign_funding) try signP2pkh(a, &ft, 0, fund.outputs[3].locking_script.bytes, @intCast(fund.outputs[3].satoshis), lp_priv);
    const f_raw = try ft.serialize(a);

    const held = brc162.decode(pd.outputs[2].locking_script.bytes).?.amount;
    const vkey = try pool.validatorKey(a, f.cfg.identity, txidOf(pd_raw), o.key_vout);
    var d = pd;
    d.inputs = try a.dupe(bsvz.transaction.Input, &.{
        .{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(pd_raw) }, .index = 2 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
        .{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(f_raw) }, .index = 0 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
    });
    d.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = 50_000, .locking_script = bsvz.script.Script.init(try poolScript(a, pd.outputs[0].locking_script.bytes, 1_000_000, vkey)) },
        .{ .satoshis = 1, .locking_script = bsvz.script.Script.init(try pool.payoutScript(a, f.id, held - 1_000_000 - 1, lp, false)) },
    });
    if (o.sign_deploy) {
        try signP2pkhScope(a, &d, 0, pd.outputs[2].locking_script.bytes, 1, lp_priv, validator.sighash_single_forkid);
        try signP2pkhScope(a, &d, 1, lp_lock, exact, lp_priv, validator.sighash_single_forkid);
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

test "relay deploy: the LP's delivered deploy with its funding as an unproven parent, one BEEF — the claim appended (the deploy's only change), submitted through skein's submit, the funding handed back to broadcast, the claim to file; admitted; answered {ok: true, tx, txid}" {
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
    try testing.expectEqual(@as(usize, 2), m.f.oracle.calls); // the key check and the claim's signature
    const claimed = served.reply.ok.tx.?;
    const ct = try Transaction.parse(a, claimed);
    const dt = try Transaction.parse(a, p.deploy);
    try testing.expectEqual(dt.outputs.len + 1, ct.outputs.len);
    for (dt.inputs, ct.inputs) |x, y| try testing.expectEqualSlices(u8, x.unlocking_script.bytes, y.unlocking_script.bytes);
    for (dt.outputs, ct.outputs[0..dt.outputs.len]) |x, y| try testing.expectEqualSlices(u8, x.locking_script.bytes, y.locking_script.bytes);
    const cp = (try pool.parse(brc162.decode(ct.outputs[0].locking_script.bytes).?.lock)).?;
    const first = dt.inputs[0].previous_outpoint;
    try testing.expectEqual(@as(?u32, 2), try pool.verifiedClaim(a, ct.outputs, cp, ct.outputs[0].locking_script.bytes, first.txid.bytes, first.index));
    // The claim to file in the wallet: the claimed deploy as Atomic BEEF, its output 2.
    const file = served.file.?;
    try testing.expectEqual(@as(u32, 2), file.vout);
    const fb = try w.beef.parse(a, file.atomic);
    try testing.expectEqualSlices(u8, &txidOf(claimed), &fb.atomic.?);

    // The parent to broadcast: the funding transaction, with its Atomic BEEF (fund, proven, then itself).
    try testing.expectEqual(@as(usize, 1), served.broadcast.len);
    try testing.expectEqualSlices(u8, p.funding, served.broadcast[0].raw);

    // The claimed deploy's submission: the engine's route verified the BEEF (the LP's SINGLE signatures
    // hold with the claim appended), the topic admits the pool, the token change and the claim.
    const ev = readBack(a, try m.node.launched(served));
    try testing.expectEqualStrings(&w.header.toHex(txidOf(claimed)), ev.getText("txid").?);
    const txs = try txsOf(a, ev);
    try testing.expectEqualSlices(u8, claimed, txs[txs.len - 1]);
    const first_step = try m.node.step(ev);
    try testing.expectEqual(Gated.pending, first_step.gate);
    try testing.expectEqual(@as(usize, 2), m.node.posts);
    const body = try deployBody(a, req);
    try expectRefused(try m.answerDeploy(a, body), .pending);
    const done = try m.node.status(ev, "RECEIVED");
    try testing.expect(done.admitted);
    try testing.expectEqualSlices(u32, &.{ 0, 1, 2 }, done.applied[0].outputs_to_admit); // the pool, the token change, the claim

    const ans = try m.answerDeploy(a, body);
    try testing.expect(ans == .ok);
    const rv = readBack(a, try messages.replyValue(a, ans));
    try testing.expectEqual(true, rv.getBool("ok").?);
    try testing.expectEqualStrings(&w.header.toHex(txidOf(claimed)), rv.getText("txid").?);
    try testing.expectEqualSlices(u8, claimed, rv.getBytes("tx").?);

    // Sent again: held claimed, routed again, answered from the state; nothing broadcast again, no oracle call.
    m.f.oracle.calls = 0;
    const again = try m.respondDeploy(a, req);
    try testing.expect(again.next == .from_state);
    try testing.expectEqual(@as(usize, 0), again.broadcast.len);
    try testing.expectEqual(@as(usize, 0), m.f.oracle.calls);
}

test "relay deploy refused: a wrong ValidatorPubKey, an unsigned funding input, an unsigned deploy input, fees not the terms, another validator's pool — nothing to broadcast or submit; a rejection by the network is answered rejected" {
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
        try testing.expect(r.file == null);
    }
    const p = try relayDeploy(a, m.f, .{});
    const req = try deployBeef(a, m, p);
    {
        var d = try m.deps();
        d.config.terms.commission_bps = 5;
        const r = try messages.respond(a, .deploy, try deployBody(a, req), d);
        try expectRefused(r.reply, .fees_unacceptable);
        try testing.expectEqualStrings("commissionBps: the terms are 5", r.reply.refused.detail.?);
        try testing.expectEqual(@as(usize, 0), r.broadcast.len);
        d = try m.deps();
        d.config.identity = key33(vec.pool0.validator);
        const r2 = try messages.respond(a, .deploy, try deployBody(a, req), d);
        try expectRefused(r2.reply, .not_our_pool);
        try testing.expectEqual(@as(usize, 0), r2.broadcast.len);
    }
    try testing.expectEqual(@as(usize, 0), m.node.posts);

    // Consent, then the network rejects the claimed deploy: answered rejected.
    const ok = try m.respondDeploy(a, req);
    const okev = try m.node.launched(ok);
    _ = try m.node.step(okev);
    _ = try m.node.status(okev, "REJECTED");
    const ans = try m.answerDeploy(a, try deployBody(a, req));
    try expectRefused(ans, .rejected);
    try testing.expectEqualSlices(u8, &txidOf(ok.reply.ok.tx.?), &ans.refused.txid.?);
}

// --- the rescind (0.9.0): the claim spent as the wallet's caller input, with a mocked wallet ---

/// The validator wallet's coin (gen/vectors `validatorWallet`, key(0x77)): fund:6.
const wallet_priv: [32]u8 = .{0x77} ** 32;


/// A mocked wallet (skein's wallet program, #93: createAction with a caller input, signAction with
/// its spends): the draft spends the caller's inputs first, then its own coin fund:6, its outputs the
/// caller's and a change of 300 sats' fee — gen/vectors' `rescind` exactly.
const MockWallet = struct {
    f: *Fx,
    draft: ?Transaction = null,

    fn createAction(self: *MockWallet, a: std.mem.Allocator, body: Value) !Value {
        try testing.expectEqualStrings("createAction", body.getText("op").?);
        const in0 = body.getArray("inputs").?[0];
        try testing.expectEqual(@as(u64, rescind.unlock_len), in0.getUint("unlockingScriptLength").?);
        try testing.expect(in0.get("unlockingScript") == null);
        try testing.expect(body.get("options").?.getBool("noSend").?);
        const op = in0.getText("outpoint").?;
        const ib = try w.beef.parse(a, body.getBytes("inputBEEF").?);
        const src_txid = w.header.fromHex(op[0..64]) catch unreachable;
        try testing.expect(ib.find(src_txid) != null);
        const vout = try std.fmt.parseInt(u32, op[65..], 10);
        const fund = try Transaction.parse(a, self.f.raw("fund"));
        const out0 = body.getArray("outputs").?[0];
        var t = fund;
        t.version = 1;
        t.lock_time = 0;
        t.inputs = try a.dupe(bsvz.transaction.Input, &.{
            .{ .previous_outpoint = .{ .txid = .{ .bytes = src_txid }, .index = vout }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
            .{ .previous_outpoint = .{ .txid = .{ .bytes = txidOf(self.f.raw("fund")) }, .index = 6 }, .unlocking_script = bsvz.script.Script.empty(), .sequence = 0xffffffff },
        });
        const wl = try p2pkhLock(a, &bsvz.crypto.hash.hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(wallet_priv)).publicKey()).toCompressedSec1()).bytes);
        t.outputs = try a.dupe(bsvz.transaction.Output, &.{
            .{ .satoshis = @intCast(out0.getUint("satoshis").?), .locking_script = bsvz.script.Script.init(out0.getBytes("lockingScript").?) },
            .{ .satoshis = 50_000 + 1 - 300, .locking_script = bsvz.script.Script.init(wl) },
        });
        self.draft = t;
        const raw = try t.serialize(a);
        // The draft as Atomic BEEF, its inputBEEF the ancestry.
        var entries: std.ArrayList(w.beef.Entry) = .empty;
        try entries.appendSlice(a, ib.entries);
        if (ib.find(txidOf(self.f.raw("fund"))) == null) try entries.append(a, .{ .txid = txidOf(self.f.raw("fund")), .format = .raw, .raw = self.f.raw("fund") });
        try entries.append(a, .{ .txid = txidOf(raw), .format = .raw, .raw = raw });
        const atomic = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = txidOf(raw), .bumps = ib.bumps, .entries = entries.items });
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "wallet-result" } },
            .{ .key = "op", .value = .{ .text = "createAction" } },
            .{ .key = "txid", .value = .{ .text = &w.header.toHex(txidOf(raw)) } },
            .{ .key = "tx", .value = .{ .bytes = atomic } },
            .{ .key = "reference", .value = .{ .cid = "cid:draft" } },
        }) };
    }

    fn signAction(self: *MockWallet, a: std.mem.Allocator, body: Value) !Value {
        try testing.expectEqualStrings("signAction", body.getText("op").?);
        try testing.expectEqualStrings("cid:draft", body.getCid("reference").?);
        var t = self.draft.?;
        const sp = body.get("spends").?;
        try testing.expectEqual(@as(usize, 1), sp.map.len);
        const i = try std.fmt.parseInt(usize, sp.map[0].key, 10);
        const u = sp.map[0].value.getBytes("unlockingScript").?;
        try testing.expect(u.len <= rescind.unlock_len);
        const ins = try a.dupe(bsvz.transaction.Input, t.inputs);
        ins[i].unlocking_script = bsvz.script.Script.init(u);
        t.inputs = ins;
        // The wallet signs its own input (the fixture's signature: go-sdk's RFC 6979 nonce, which
        // bsvz's signing does not reproduce); it must verify over this very transaction.
        const fixture = try Transaction.parse(a, self.f.raw("rescind"));
        const own = try a.dupe(bsvz.transaction.Input, t.inputs);
        own[1].unlocking_script = fixture.inputs[1].unlocking_script;
        t.inputs = own;
        const fund = try Transaction.parse(a, self.f.raw("fund"));
        try testing.expectEqual(unlock.InputCheck.verified, try unlock.checkInput(a, &t, 1, fund.outputs[6].locking_script.bytes, @intCast(fund.outputs[6].satoshis)));
        const raw = try t.serialize(a);
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "wallet-result" } },
            .{ .key = "op", .value = .{ .text = "signAction" } },
            .{ .key = "txid", .value = .{ .text = &w.header.toHex(txidOf(raw)) } },
            .{ .key = "tx", .value = .{ .bytes = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = txidOf(raw), .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{.{ .txid = txidOf(raw), .format = .raw, .raw = raw }}) }) } },
        }) };
    }
};

test "rescind (0.9.0): the claim, found from the deploy; the wallet's createAction with it as a caller input (its unlock to come, its source's BEEF, a burn, noSend); the draft's claim input signed by the pool's validator key; the wallet's signAction — gen/vectors' rescind byte for byte; a forged claim is not ours to rescind" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy" });
    var wallet: MockWallet = .{ .f = f };

    const deploy_txid = txidOf(f.raw("pool_deploy"));
    const c = switch (try rescind.claimOf(a, f.mem.view(), f.cfg.identity, deploy_txid)) {
        .ok => |c| c,
        .refused => |why| {
            std.debug.print("{s}\n", .{why});
            return error.TestUnexpectedRefusal;
        },
    };
    try testing.expectEqual(@as(u32, vec.claim_vout), c.vout);
    try testing.expectEqualSlices(u8, &key33(vec.pool0.validator), &c.key);
    try testing.expectEqualStrings(try validator.topicOf(a, f.id), try rescind.topicOf(a, c));

    // The input BEEF: the deploy (the claim's source) with its ancestry.
    const input_beef = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = txidOf(f.raw("fund")), .format = .raw, .raw = f.raw("fund") },
        .{ .txid = txidOf(f.raw("token_deploy")), .format = .raw, .raw = f.raw("token_deploy") },
        .{ .txid = deploy_txid, .format = .raw, .raw = f.raw("pool_deploy") },
    }) });
    const draft = try wallet.createAction(a, try rescind.createBody(a, c, input_beef));
    const stage = rescind.stageOf(draft);
    try testing.expect(stage == .draft);
    const l = (try rescind.locate(a, f.cfg.identity, stage.draft.tx)).?;
    try testing.expectEqual(@as(usize, 0), l.index);
    // The oracle reproduces the Go fixture's signature of the claim input.
    const want = try Transaction.parse(a, f.raw("rescind"));
    const sig = brc162.readPush(want.inputs[0].unlocking_script.bytes, 0).?.data;
    f.oracle.recorded = .{ .hash = unlock.sha256d(try unlock.preimage(a, &l.tx, 0, l.script, l.satoshis, unlock.sighash_all_forkid)), .der = sig[0 .. sig.len - 1] };
    const signed = try wallet.signAction(a, try rescind.signBody(a, stage.draft.reference, l, f.oracle.oracle()));
    const fin = rescind.stageOf(signed);
    try testing.expect(fin == .signed);
    const fb = try w.beef.parse(a, fin.signed);
    try testing.expectEqualSlices(u8, f.raw("rescind"), fb.find(fb.atomic.?).?.raw.?);
    // Its claim input verifies (P2PKH to the pool's validator key, ALL|FORKID).
    const rt = try Transaction.parse(a, f.raw("rescind"));
    const ctx = try Transaction.parse(a, f.raw("pool_deploy"));
    try testing.expectEqual(unlock.InputCheck.verified, try unlock.checkInput(a, &rt, 0, ctx.outputs[vec.claim_vout].locking_script.bytes, 1));
    // The topic takes it: the claim a coin consumed, the unit burned.
    _ = try f.mem.hold(f.raw("rescind"));
    try testing.expect(f.mem.spent.contains(MemView.key(.{ .txid = deploy_txid, .vout = vec.claim_vout })));

    // Not ours: a deploy with a forged claim, another validator's pool, a deploy not held.
    const g = try Fx.init(a, &.{ "fund", "token_deploy", "pool_deploy_forged" });
    try testing.expect((try rescind.claimOf(a, g.mem.view(), g.cfg.identity, txidOf(g.raw("pool_deploy_forged")))) == .refused);
    try testing.expect((try rescind.claimOf(a, f.mem.view(), key33(vec.pool0.validator), deploy_txid)) == .refused);
    try testing.expect((try rescind.claimOf(a, f.mem.view(), f.cfg.identity, .{3} ** 32)) == .refused);
    // A wallet answer that is no draft or signed rescind.
    try testing.expect(rescind.stageOf(.{ .map = &.{} }) == .failed);
    // A resolved thread's result: its stdout, the record's CID in hex (a newline after it).
    const res: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "exitCode", .value = .{ .uint = 0 } },
        .{ .key = "stdout", .value = .{ .bytes = "01711220aa\n" } },
    }) };
    try testing.expectEqualSlices(u8, &.{ 0x01, 0x71, 0x12, 0x20, 0xaa }, (try rescind.resultCid(a, res)).?);
    try testing.expect((try rescind.resultCid(a, .null)) == null);
}
