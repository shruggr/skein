//! The validator's decisions, independent of how a request arrives (a
//! direct call, skein#51: what libp2p calls a stream): `spend` for the
//! `swap` and `addLiquidity` calls, `deploy` for the `deploy` call.
//!
//! A spend is signed only if, in order:
//!   1. the transaction parses and spends the named pool outpoint;
//!   2. the pool is an output this instance's overlay holds, and it is a
//!      pool (the compiled Pool code) whose ValidatorIdentity is ours,
//!      and its token topic is one this instance validates (`Config.validated`,
//!      the engine's registered set with `config.overlay.validator` set;
//!      else `not_validating`, 0.6.0);
//!   3. it is still live in the topic; if a transaction we hold spent it,
//!      the refusal carries the pool's newest state (continuations are
//!      always output 0: followed from spender to spender) — unless that
//!      spender is this very request, signed (a retry after a 503: the
//!      signed transaction is answered again, from the state);
//!   4. the pool input calls the direct call's method (Swap / AddLiquidity), as
//!      Rúnar lays a call out (unlock.zig), with our signature's slot empty
//!      (`OP_0`) and its code push the pool's own code;
//!   5. the next validator key (the call's argument, and the continuation's
//!      state) is the child of the spent pool outpoint;
//!   6. our topic would admit the transaction (Mandala's `token.judge`,
//!      the BSV-21 rules alone, with the pool and the taker's token inputs
//!      as previous coins, and the inputs' sources where the topic's own
//!      call reads them: held, else the request's BEEF — the same judgement
//!      `submit.route` asks the topic for, after signing); the pool checks
//!      pass (`pool.check`: the topic `tm_mandala_<txid>_0` no longer runs
//!      them, decided 2026-10-01, so a malformed continuation would be a
//!      valid token output — the validator refuses to sign it, `bad_pool`;
//!      `pool.check` does not look at the ValidatorPubKey, which is ours to
//!      check, steps 5 and 10); and the pool is its first token input; for
//!      a Swap, the output set is the contract's (`swapOutputs`: the
//!      continuation's reserves, the payout, the LP fee, the validator fee
//!      and the commission to the call's commissionPkh, each in its asset
//!      and only when nonzero, then at most Rúnar's change output, nothing
//!      else; for an AddLiquidity, `addLiquidityOutputs`: the continuation
//!      with the reserves increased by addBsv/addTokens and LpPubKey the
//!      call's nextLpPubKey, then at most Rúnar's change; reason `bad_outputs`);
//!   7. the preimage the call pushes is the one we compute (BIP-143,
//!      ALL|FORKID, the pool's scriptCode);
//!   8. every other input carries a signature, verified when it spends a
//!      P2PKH output (token or plain) whose source we have; for
//!      AddLiquidity the LP's signature in the call verifies against the
//!      pool's LpPubKey; and every unproven parent the request's BEEF
//!      carries that we do not hold (the taker's nosend funding
//!      transaction, docs/notes.md 2026-10-02 "Swap funding and signing")
//!      is complete: each of its inputs signed, verified likewise;
//!  10. we can name our current key: the key ID is the outpoint of the last
//!      input we signed (the first token input of the transaction that
//!      created the pool, walked back through LP-only RemoveLiquidity spends,
//!      which carry the key over), checked against the pool's ValidatorPubKey.
//! Then the oracle signs the digest, the signature goes into its slot, and
//! the signed transaction is returned with what its submission needs
//! (`Submission`: the topic, the request's ancestry) — not submitted here:
//! messages.zig `finishSpend` hands the signed BEEF to skein's own
//! `submit.route` (submit.zig), and main.zig launches the overlay engine's
//! submission thread on the record it makes.
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");
const unlock = @import("unlock.zig");
const view_mod = @import("view.zig");
const Oracle = @import("oracle.zig").Oracle;

const bsvz = w.bsvz;
const beef = w.beef;
const brc162 = mandala.brc162;
const bsv21 = mandala.bsv21;
const pool = @import("pool");
const token = mandala.token;
const Transaction = bsvz.transaction.Transaction;
const View = view_mod.View;
pub const Outpoint = view_mod.Outpoint;

/// Which direct call: the route's fn (`libp2p:/amm-validator/1/<name>`).
pub const Op = enum {
    swap,
    add_liquidity,
    deploy,

    pub fn name(self: Op) []const u8 {
        return switch (self) {
            .swap => "swap",
            .add_liquidity => "addLiquidity",
            .deploy => "deploy",
        };
    }
    pub fn parse(s: []const u8) ?Op {
        inline for (.{ Op.swap, Op.add_liquidity, Op.deploy }) |b| if (std.mem.eql(u8, s, b.name())) return b;
        return null;
    }
    pub fn method(self: Op) ?pool.Method {
        return switch (self) {
            .swap => .swap,
            .add_liquidity => .add_liquidity,
            .deploy => null,
        };
    }
};

pub const Config = struct {
    /// This instance's root identity key: pools naming it are ours.
    identity: [33]u8,
    /// Deploy terms: the least validator fee we host for, the most LP fee,
    /// and the most commission (null: any, 0..10000).
    min_validator_fee_bps: i64 = 0,
    max_lp_fee_bps: i64 = 10_000,
    max_commission_bps: ?i64 = null,
    now_ms: i64 = 0,
    /// The topics this instance validates (0.6.0): with the engine's `config.overlay.validator`
    /// set, the engine's registered set (the head `<app>/topics`); without it, none (main.zig
    /// `validatedSet`). A swap, an addLiquidity or a deploy for a token whose topic is not in it is
    /// refused `not_validating`, before anything is checked or signed. Empty: nothing is signed.
    validated: []const []const u8 = &.{},
};

/// Whether `topic` is one this instance validates (`Config.validated`).
pub fn validating(cfg: Config, topic: []const u8) bool {
    for (cfg.validated) |t| if (std.mem.eql(u8, t, topic)) return true;
    return false;
}

fn notValidating(a: std.mem.Allocator, topic: []const u8) !Reply {
    return refuse(.not_validating, try std.fmt.allocPrint(a, "this validator does not validate {s}", .{topic}));
}

pub const Reason = enum {
    bad_request,
    bad_transaction,
    pool_not_an_input,
    unknown_pool,
    pool_spent,
    not_a_pool,
    not_our_pool,
    wrong_method,
    bad_call,
    signature_slot_not_empty,
    wrong_next_key,
    topic_refused,
    /// The pool checks (`pool.check`) fail: detail the violation.
    bad_pool,
    pool_not_first_token_input,
    preimage_mismatch,
    missing_signature,
    bad_signature,
    current_key_unknown,
    oracle_failed,
    /// The direct call's frame is not a signed-message package for this
    /// validator (MESSAGES.md "Signed messages (#70)"): detail why.
    unauthenticated,
    /// The answer after the step found no outcome: the signed transaction is
    /// not held, or it is held and neither pending, admitted nor rejected.
    submit_failed,
    /// skein's `submit.route` refused the signed BEEF (it does not decode or
    /// verify: an input neither held nor in the request's BEEF, say).
    submit_refused,
    /// The answer after the step: the submission's thread came to rest with
    /// nothing admitted or rejected (it errored): send the same request again.
    pending,
    /// The answer after the step: the network rejected it (a status
    /// provider's rejection, a competing proof, abandonment); or a
    /// resubmission of a transaction already rejected.
    rejected,
    pool_not_at_output_0,
    fees_unacceptable,
    wrong_validator_key,
    /// A Swap's or an AddLiquidity's outputs are not the contract's: detail which.
    bad_outputs,
    /// The pool's token topic is not one this instance validates (`Config.validated`; 0.6.0: registered, with `config.overlay.validator` set): detail the topic.
    not_validating,
};

/// A pool's state, as the rejection of a stale request carries it.
pub const PoolState = struct {
    outpoint: Outpoint,
    /// The pool output's satoshis: its BSV reserve.
    satoshis: u64,
    pool: pool.Pool,
};

pub const Newest = union(enum) {
    live: PoolState,
    /// A spend with no pool continuation (RemoveLiquidity closing the pool).
    closed: struct { last: Outpoint, by: [32]u8 },
};

/// An unproven parent the request's BEEF carries and the instance does not
/// hold (the taker's nosend funding transaction). It must be complete (check
/// 8); it travels in the submission's BEEF, and the chain app registers and
/// broadcasts it, parents first, when the engine ingests the submission
/// (shruggr/skein-chain docs/CHAIN.md "Ingest a BEEF"; amm-poc broadcast it
/// from the validator, before #79 made the chain app the one broadcaster).
/// `beef` is its Atomic BEEF (its ancestry in the request).
pub const Parent = struct {
    txid: [32]u8,
    raw: []const u8,
    beef: []const u8,
};

/// What a signed spend's submission needs besides the transaction: the
/// topic it was judged for, the pool it spends, the request's ancestry
/// (the signed BEEF is the request's with its subject replaced, submit.zig
/// `submissionBeef`), and the unproven parents it carries.
pub const Submission = struct {
    topic: []const u8,
    pool: Outpoint,
    ancestry: ?beef.Beef = null,
    parents: []const Parent = &.{},
};

pub const Reply = union(enum) {
    /// A spend: the transaction with our signature, and what its submission
    /// needs (null only for a deploy, whose `tx` is also null: consent,
    /// nothing signed). From `spend`, `tx`/`txid` mean "signed"; the direct
    /// call's answer (messages.zig `answerFromState`) is read after the
    /// submission's thread came to rest, and there `ok` means admitted.
    ok: struct { tx: ?[]const u8 = null, txid: ?[32]u8 = null, submission: ?Submission = null },
    /// `txid`: the signed transaction's, when the refusal is about it (after signing).
    refused: struct { reason: Reason, detail: ?[]const u8 = null, newest: ?Newest = null, txid: ?[32]u8 = null },
};

fn refuse(reason: Reason, detail: ?[]const u8) Reply {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

/// A pool's token: always a BRC-162 (native) token, deployed at output 0
/// (a pool's AssetId is the 32-byte deploy txid).
pub fn tokenId(id: [32]u8) bsv21.TokenId {
    return .{ .txid = id };
}

/// The token's topic, `tm_mandala_<txid>_0` (skein-mandala name.zig: `tm_mandala_<assetId>`, BRC-207, 0.9.0).
pub fn topicOf(a: std.mem.Allocator, id: [32]u8) ![]u8 {
    const buf = try a.create([mandala.name.max_topic_len]u8);
    return a.dupe(u8, mandala.name.topicName(buf, .{ .txid = id }));
}

/// The request's transaction: raw bytes, or a BEEF (V1, V2, Atomic) whose
/// subject it is, which brings the parents of inputs we do not hold.
pub const Subject = struct {
    raw: []const u8,
    tx: Transaction,
    ancestry: ?beef.Beef = null,
};

pub fn subjectOf(a: std.mem.Allocator, bytes: []const u8) ?Subject {
    if (bytes.len >= 4) {
        const magic = std.mem.readInt(u32, bytes[0..4], .little);
        if (magic == beef.V1 or magic == beef.V2 or magic == beef.ATOMIC) {
            const b = beef.parse(a, bytes) catch return null;
            const s = b.subject() orelse return null;
            const e = b.find(s) orelse return null;
            const raw = e.raw orelse return null;
            return .{ .raw = raw, .tx = Transaction.parse(a, raw) catch return null, .ancestry = b };
        }
    }
    const tx = Transaction.parse(a, bytes) catch return null;
    // Exactly one transaction, nothing after it.
    if (tx.serializedLen() != bytes.len) return null;
    return .{ .raw = bytes, .tx = tx };
}

/// The output an input spends: from what the overlay holds, else from the
/// request's BEEF (signature checks, and the topic's judgement: previous
/// coins always come from the overlay).
fn sourceOf(a: std.mem.Allocator, v: View, sub: Subject, in: bsvz.transaction.Input) !?bsv21.Output {
    const op: Outpoint = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index };
    if (try v.output(a, op)) |o| return o;
    const b = sub.ancestry orelse return null;
    const e = b.find(op.txid) orelse return null;
    const t = e.tx orelse (Transaction.parse(a, e.raw orelse return null) catch return null);
    if (op.vout >= t.outputs.len) return null;
    return .{ .script = t.outputs[op.vout].locking_script.bytes, .satoshis = @intCast(t.outputs[op.vout].satoshis) };
}

/// Which entries of a BEEF are `subject`'s ancestry (itself included): an
/// entry with its BUMP (or txid-only) ends a branch.
fn ancestryOf(a: std.mem.Allocator, b: beef.Beef, subject: [32]u8) ![]bool {
    const keep = try a.alloc(bool, b.entries.len);
    @memset(keep, false);
    const start = b.indexOf(subject) orelse return keep;
    keep[start] = true;
    var i = start + 1;
    while (i > 0) {
        i -= 1;
        if (!keep[i]) continue;
        const e = b.entries[i];
        if (e.format != .raw) continue;
        const t = e.tx orelse (Transaction.parse(a, e.raw orelse continue) catch continue);
        for (t.inputs) |in| if (b.indexOf(in.previous_outpoint.txid.bytes)) |k| {
            if (k < i) keep[k] = true;
        };
    }
    return keep;
}

/// The unproven parents of the request (raw entries of its BEEF, the
/// subject's ancestry, that the instance does not hold), parents first, each
/// with its Atomic BEEF.
pub fn unprovenParents(a: std.mem.Allocator, v: View, sub: Subject) ![]const Parent {
    const b = sub.ancestry orelse return &.{};
    const subject = b.subject() orelse return &.{};
    const ours = try ancestryOf(a, b, subject);
    var out: std.ArrayList(Parent) = .empty;
    for (b.entries, ours) |e, k| {
        if (!k or e.format != .raw or std.mem.eql(u8, &e.txid, &subject)) continue;
        if ((try v.rawTx(a, e.txid)) != null) continue;
        const keep = try ancestryOf(a, b, e.txid);
        var es: std.ArrayList(beef.Entry) = .empty;
        for (b.entries, keep) |x, kk| if (kk) try es.append(a, x);
        try out.append(a, .{ .txid = e.txid, .raw = e.raw orelse continue, .beef = try beef.serialize(a, .{
            .version = beef.V2,
            .atomic = e.txid,
            .bumps = b.bumps,
            .entries = es.items,
        }) });
    }
    return out.items;
}

/// The transaction as the topic's rules see it: each input's source where
/// the topic's own call reads it (the topic program's `txOf`, skein-mandala mandala_topic.zig: the records
/// `submit.route` decoded — what the overlay holds, and the BEEF).
fn rulesTx(a: std.mem.Allocator, v: View, sub: Subject, txid: [32]u8) !bsv21.Tx {
    const ins = try a.alloc(bsv21.Input, sub.tx.inputs.len);
    for (sub.tx.inputs, ins) |in, *x| {
        x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
        x.source = try sourceOf(a, v, sub, in);
    }
    const outs = try a.alloc(bsv21.Output, sub.tx.outputs.len);
    for (sub.tx.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    return .{ .txid = txid, .inputs = ins, .outputs = outs };
}

/// The topic's judgement (`token.judge`) and the pool checks (`pool.check`)
/// of the transaction: a refusal, or the token's judgement (its inputs and
/// admitted outputs).
const Judged = union(enum) { refused: Reply, ok: struct { verdict: token.Verdict, j: bsv21.Judgement } };

fn judge(a: std.mem.Allocator, id: [32]u8, rtx: bsv21.Tx, previous: []const u32) !Judged {
    const verdict = token.judge(a, tokenId(id), rtx, previous) catch |e| return .{ .refused = refuse(.topic_refused, @errorName(e)) };
    if (verdict.rejected) |r| return .{ .refused = refuse(.topic_refused, @tagName(r)) };
    const j = try bsv21.judge(a, tokenId(id), rtx, previous);
    if (pool.check(j)) |v| return .{ .refused = refuse(.bad_pool, @tagName(v)) };
    return .{ .ok = .{ .verdict = verdict, .j = j } };
}

/// A pool at an output script: the token and the pool, or null.
fn poolAt(script: []const u8) ?struct { token: brc162.Token, pool: pool.Pool } {
    const tok = brc162.decode(script) orelse return null;
    if (tok.role != .value) return null;
    const p = (pool.parse(tok.lock) catch return null) orelse return null;
    return .{ .token = tok, .pool = p };
}

/// The token id of the pool at an output script, or null.
pub fn poolTokenId(script: []const u8) ?[32]u8 {
    return (poolAt(script) orelse return null).pool.asset_id;
}

/// Follow a spent pool to its newest state: each spend's continuation is its
/// output 0 (the topic admits a pool nowhere else).
pub fn newest(a: std.mem.Allocator, v: View, topic: []const u8, from: Outpoint) !?Newest {
    var cur = from;
    var steps: usize = 0;
    while (steps < 100_000) : (steps += 1) {
        const sp = (try v.spender(a, topic, cur)) orelse break;
        const t = (try v.tx(a, sp)) orelse return null;
        if (t.outputs.len == 0) return .{ .closed = .{ .last = cur, .by = sp } };
        _ = poolAt(t.outputs[0].locking_script.bytes) orelse return .{ .closed = .{ .last = cur, .by = sp } };
        cur = .{ .txid = sp, .vout = 0 };
    }
    const o = (try v.output(a, cur)) orelse return null;
    const p = poolAt(o.script) orelse return null;
    return .{ .live = .{ .outpoint = cur, .satoshis = o.satoshis, .pool = p.pool } };
}

/// The key ID of the pool's current validator key: the outpoint of the last
/// input the validator signed. That is the first token input of the
/// transaction that created the pool, unless that transaction was an LP-only
/// RemoveLiquidity, which carried the key over: then the same question for
/// the pool it spent. The answer is checked against `want` (public BRC-42
/// derivation from the identity), so a wrong walk signs nothing.
pub fn currentKeyId(a: std.mem.Allocator, v: View, id: [32]u8, identity: [33]u8, pool_op: Outpoint, want: [33]u8) !?Outpoint {
    var op = pool_op;
    var steps: usize = 0;
    while (steps < 100_000) : (steps += 1) {
        const t = (try v.tx(a, op.txid)) orelse return null;
        var first: ?struct { index: usize, op: Outpoint, token: bsv21.Token } = null;
        for (t.inputs, 0..) |in, i| {
            const src: Outpoint = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index };
            const o = (try v.output(a, src)) orelse continue;
            if (try bsv21.tokenOf(a, tokenId(id), src.txid, src.vout, o.script)) |tok| {
                first = .{ .index = i, .op = src, .token = tok };
                break;
            }
        }
        const f = first orelse return null;
        const b = f.token.binary;
        const spent_pool = b != null and b.?.role == .value and (pool.parse(b.?.lock) catch null) != null;
        if (spent_pool and pool.methodOf(t.inputs[f.index].unlocking_script.bytes) == .remove_liquidity) {
            op = f.op;
            continue;
        }
        const k = try pool.validatorKey(a, identity, f.op.txid, f.op.vout);
        return if (std.mem.eql(u8, &k, &want)) f.op else null;
    }
    return null;
}

fn keyIdOf(a: std.mem.Allocator, op: Outpoint) ![]const u8 {
    const buf = try a.create([64 + 1 + 10]u8);
    return pool.keyId(buf, op.txid, op.vout);
}

pub const SpendRequest = struct {
    tx: []const u8,
    pool: Outpoint,
};

/// A swap or addLiquidity request: check and sign. Never submits — see
/// messages.zig `finishSpend`, which routes the signed BEEF through skein's
/// `submit.route`.
pub fn spend(a: std.mem.Allocator, op: Op, req: SpendRequest, cfg: Config, v: View, oracle: Oracle) !Reply {
    const method = op.method() orelse return refuse(.bad_request, "deploy is not a spend");
    // 1. The transaction, and the pool input.
    const sub = subjectOf(a, req.tx) orelse return refuse(.bad_transaction, null);
    const tx = sub.tx;
    const pi = for (tx.inputs, 0..) |in, i| {
        if (in.previous_outpoint.index == req.pool.vout and std.mem.eql(u8, &in.previous_outpoint.txid.bytes, &req.pool.txid)) break i;
    } else return refuse(.pool_not_an_input, null);

    // 2. The pool, as we hold it; ours.
    const src = (try v.output(a, req.pool)) orelse return refuse(.unknown_pool, null);
    const cur = poolAt(src.script) orelse return refuse(.not_a_pool, null);
    if (!std.mem.eql(u8, &cur.pool.identity, &cfg.identity)) return refuse(.not_our_pool, null);
    const id = cur.pool.asset_id;
    const topic = try topicOf(a, id);
    if (!validating(cfg, topic)) return notValidating(a, topic);

    // 3. Still live in the topic.
    const previous = try v.previousCoins(a, topic, tx);
    if (std.mem.indexOfScalar(u32, previous, @intCast(pi)) == null) {
        if (try v.spender(a, topic, req.pool)) |sp| {
            // This very request, signed already (held: awaiting the
            // broadcaster, or admitted): a retry. Answered again, not signed
            // again; its submission is routed again and the answer comes
            // from the state (503 while pending, then the transaction).
            if (try signedSpend(a, v, sp, sub, pi, method)) |raw| return .{ .ok = .{ .tx = raw, .txid = sp, .submission = .{
                .topic = topic,
                .pool = req.pool,
                .ancestry = sub.ancestry,
            } } };
            return .{ .refused = .{ .reason = .pool_spent, .newest = try newest(a, v, topic, req.pool) } };
        }
        return refuse(.unknown_pool, "not admitted in the topic");
    }

    // 4. The call's method, laid out as Rúnar calls it, our slot empty.
    const unlocking = tx.inputs[pi].unlocking_script.bytes;
    const m = pool.methodOf(unlocking) orelse return refuse(.bad_call, "no method index");
    if (m != method) return refuse(.wrong_method, @tagName(m));
    const call = (try unlock.parseCall(a, unlocking, m)) orelse return refuse(.bad_call, "not a Rúnar call of this method");
    if (!std.mem.eql(u8, call.code(), unlock.poolCode(cur.token.lock) orelse return refuse(.not_a_pool, null))) return refuse(.bad_call, "the code push is not the pool's code");
    const slot = call.arg(call.layout.validator_sig);
    if (slot.op != brc162.OP_0) return refuse(.signature_slot_not_empty, null);

    // 5. The next validator key: the child of the spent pool outpoint, in
    // the call and in the continuation.
    const next_key = try pool.validatorKey(a, cfg.identity, req.pool.txid, req.pool.vout);
    if (!std.mem.eql(u8, call.arg(call.layout.next_validator).data, &next_key)) return refuse(.wrong_next_key, "the call's nextValidatorPubKey");
    const cont = if (tx.outputs.len > 0) poolAt(tx.outputs[0].locking_script.bytes) else null;
    const next = cont orelse return refuse(.wrong_next_key, "no pool continuation at output 0");
    if (!std.mem.eql(u8, &next.pool.validator, &next_key)) return refuse(.wrong_next_key, "the continuation's ValidatorPubKey");

    // 6. Our topic would admit it, the pool checks pass, the pool first
    // among its token inputs.
    const txid = (try tx.txid(a)).bytes;
    const rtx = try rulesTx(a, v, sub, txid);
    const j = switch (try judge(a, id, rtx, previous)) {
        .refused => |r| return r,
        .ok => |x| x.j,
    };
    if (j.inputs.len == 0 or j.inputs[0].index != pi) return refuse(.pool_not_first_token_input, null);
    // The output set is the contract's.
    if (m == .swap) if (try swapOutputs(a, cur.pool, src.satoshis, call, tx.outputs)) |why| return refuse(.bad_outputs, why);
    if (m == .add_liquidity) if (try addLiquidityOutputs(cur.pool, cur.token.lock, src.satoshis, call, tx.outputs)) |why| return refuse(.bad_outputs, why);

    // 7. The preimage the call carries is this input's.
    const script_code = unlock.poolScriptCode(cur.token.lock) orelse return refuse(.not_a_pool, null);
    const pre = try unlock.preimage(a, &tx, pi, script_code, src.satoshis, unlock.sighash_all_forkid);
    if (!std.mem.eql(u8, pre, call.preimage())) return refuse(.preimage_mismatch, null);
    const digest = unlock.sha256d(pre);

    // 8. Everyone else's signatures, and the unproven parents we do not hold (the taker's funding): complete.
    if (try inputsSigned(a, v, sub, tx, pi)) |r| return r;
    const parents = switch (try completeParents(a, v, sub)) {
        .refused => |r| return r,
        .ok => |ps| ps,
    };
    if (call.layout.lp_sig) |ls| {
        const lp_sig = call.arg(ls).data;
        if (lp_sig.len == 0) return refuse(.missing_signature, "the LP's, in the pool call");
        if (!unlock.verify(lp_sig, &cur.pool.lp, digest, unlock.sighash_all_forkid)) return refuse(.bad_signature, "the LP's, in the pool call");
    }


    // 10. Our current key, then the signature.
    const key_op = (try currentKeyId(a, v, id, cfg.identity, req.pool, cur.pool.validator)) orelse return refuse(.current_key_unknown, null);
    const key_id = try keyIdOf(a, key_op);
    const der = oracle.sign(a, key_id, digest) catch |e| return refuse(.oracle_failed, @errorName(e));
    const checksig = try std.mem.concat(a, u8, &.{ der, &.{@as(u8, unlock.sighash_all_forkid)} });
    if (!unlock.verify(checksig, &cur.pool.validator, digest, unlock.sighash_all_forkid)) return refuse(.oracle_failed, "the signature is not the pool's validator key's");

    const inputs = try a.dupe(bsvz.transaction.Input, tx.inputs);
    inputs[pi].unlocking_script = bsvz.script.Script.init(try unlock.withArg(a, call, call.layout.validator_sig, checksig));
    var signed = tx;
    signed.inputs = inputs;
    const raw = try signed.serialize(a);
    return .{ .ok = .{ .tx = raw, .txid = beef.txidOf(raw), .submission = .{
        .topic = topic,
        .pool = req.pool,
        .ancestry = sub.ancestry,
        .parents = parents,
    } } };
}

/// Every input of `tx` but `skip` carries a signature, verified in full where
/// it spends a P2PKH output (plain or under a token prefix) whose source we
/// have (held, or in the request's BEEF): null, or the refusal naming the input.
fn inputsSigned(a: std.mem.Allocator, v: View, sub: Subject, tx: Transaction, skip: ?usize) !?Reply {
    for (tx.inputs, 0..) |in, i| {
        if (skip) |k| if (i == k) continue;
        const s = try sourceOf(a, v, sub, in);
        switch (try unlock.checkInput(a, &tx, i, if (s) |o| o.script else null, if (s) |o| o.satoshis else 0)) {
            .verified, .present => {},
            .missing => return refuse(.missing_signature, try std.fmt.allocPrint(a, "input {d}", .{i})),
            .bad => return refuse(.bad_signature, try std.fmt.allocPrint(a, "input {d}", .{i})),
        }
    }
    return null;
}

/// The request's unproven parents we do not hold (`unprovenParents`: the
/// taker's or the LP's nosend funding transaction), each complete: every
/// input signed, verified likewise. The parents, or the refusal.
fn completeParents(a: std.mem.Allocator, v: View, sub: Subject) !union(enum) { ok: []const Parent, refused: Reply } {
    const parents = try unprovenParents(a, v, sub);
    for (parents) |par| {
        const pt = Transaction.parse(a, par.raw) catch return .{ .refused = refuse(.bad_transaction, "an unproven parent") };
        for (pt.inputs, 0..) |in, i| {
            const s = try sourceOf(a, v, sub, in);
            switch (try unlock.checkInput(a, &pt, i, if (s) |o| o.script else null, if (s) |o| o.satoshis else 0)) {
                .verified, .present => {},
                .missing => return .{ .refused = refuse(.missing_signature, try std.fmt.allocPrint(a, "parent {s} input {d}", .{ &w.header.toHex(par.txid), i })) },
                .bad => return .{ .refused = refuse(.bad_signature, try std.fmt.allocPrint(a, "parent {s} input {d}", .{ &w.header.toHex(par.txid), i })) },
            }
        }
    }
    return .{ .ok = parents };
}

/// A Swap call's args (pool/Pool.runar.go `Swap`): amountIn, bsvIn,
/// userPkh, commissionPkh, as Rúnar pushes them (minimal numbers, 20-byte
/// addresses).
pub const SwapArgs = struct {
    amount_in: u64,
    bsv_in: bool,
    user_pkh: [20]u8,
    commission_pkh: [20]u8,
    change_pkh: []const u8,
    change: u64,
};

fn pkhArg(p: brc162.Push) ?[20]u8 {
    if (p.op != 20 or p.data.len != 20) return null;
    return p.data[0..20].*;
}

pub fn swapArgs(call: unlock.Call) ?SwapArgs {
    const amount = pool.canonicalNum(call.arg(2)) orelse return null;
    const bsv_in = pool.canonicalNum(call.arg(3)) orelse return null;
    const change = pool.canonicalNum(call.changeAmount()) orelse return null;
    if (amount <= 0 or change < 0 or (bsv_in != 0 and bsv_in != 1)) return null;
    return .{
        .amount_in = @intCast(amount),
        .bsv_in = bsv_in == 1,
        .user_pkh = pkhArg(call.arg(4)) orelse return null,
        .commission_pkh = pkhArg(call.arg(5)) orelse return null,
        .change_pkh = call.changePkh(),
        .change = @intCast(change),
    };
}

/// A Swap's output set against the contract's (the pool spent holding
/// `satoshis`): 0 the continuation holding the new reserves, 1 the payout to
/// userPkh in the other asset, then the LP fee (to the LpPubKey's hash), the
/// validator fee (to the spent ValidatorPubKey's hash) and the commission
/// (to commissionPkh), each in the input asset and only when nonzero, then
/// Rúnar's change output (P2PKH to `_changePKH`) when `_changeAmount > 0`,
/// and nothing else. The contract commits to the same set (hashOutputs);
/// this refuses before signing, with the reason. Null when it matches.
pub fn swapOutputs(a: std.mem.Allocator, spent: pool.Pool, satoshis: u64, call: unlock.Call, outs: []const bsvz.transaction.Output) !?[]const u8 {
    const args = swapArgs(call) orelse return "the Swap args (amountIn, bsvIn, userPkh, commissionPkh, change)";
    const q = pool.quoteSwap(spent, satoshis, args.amount_in, args.bsv_in) orelse return "the contract refuses this amountIn (fees, payout or reserves)";
    if (outs.len == 0) return "no continuation";
    const next = poolAt(outs[0].locking_script.bytes) orelse return "output 0 is not a pool";
    if (outs[0].satoshis != q.bsv_reserve) return "the continuation's BSV reserve";
    if (next.pool.token_reserve != q.token_reserve) return "the continuation's TokenReserve";
    const Want = struct { name: []const u8, amount: u64, pkh: [20]u8, is_bsv: bool };
    const lp_pkh = bsvz.crypto.hash.hash160(&spent.lp).bytes;
    const val_pkh = bsvz.crypto.hash.hash160(&spent.validator).bytes;
    var wants: std.ArrayList(Want) = .empty;
    try wants.append(a, .{ .name = "the payout", .amount = q.out, .pkh = args.user_pkh, .is_bsv = !args.bsv_in });
    if (q.lp_fee > 0) try wants.append(a, .{ .name = "the LP fee", .amount = q.lp_fee, .pkh = lp_pkh, .is_bsv = args.bsv_in });
    if (q.validator_fee > 0) try wants.append(a, .{ .name = "the validator fee", .amount = q.validator_fee, .pkh = val_pkh, .is_bsv = args.bsv_in });
    if (q.commission > 0) try wants.append(a, .{ .name = "the commission", .amount = q.commission, .pkh = args.commission_pkh, .is_bsv = args.bsv_in });
    for (wants.items, 1..) |x, i| {
        if (i >= outs.len) return try std.fmt.allocPrint(a, "{s}: no output {d}", .{ x.name, i });
        const script = try pool.payoutScript(a, spent.asset_id, x.amount, x.pkh, x.is_bsv);
        if (outs[i].satoshis != pool.payoutSats(x.amount, x.is_bsv) or !std.mem.eql(u8, outs[i].locking_script.bytes, script))
            return try std.fmt.allocPrint(a, "{s}: output {d} is not the contract's", .{ x.name, i });
    }
    var at = 1 + wants.items.len;
    if (args.change > 0) {
        if (at >= outs.len) return "no change output";
        const pkh = unlock.p2pkhHash(outs[at].locking_script.bytes) orelse return "the change output is not P2PKH";
        if (args.change_pkh.len != 20 or !std.mem.eql(u8, &pkh, args.change_pkh) or outs[at].satoshis != args.change) return "the change output is not the call's";
        at += 1;
    }
    if (outs.len != at) return "outputs past the contract's";
    return null;
}

/// An AddLiquidity call's args (pool/Pool.runar.go `AddLiquidity`):
/// nextLpPubKey, addBsv, addTokens, as Rúnar pushes them, and Rúnar's change.
pub const AddArgs = struct {
    next_lp: [33]u8,
    add_bsv: u64,
    add_tokens: u64,
    change_pkh: []const u8,
    change: u64,
};

pub fn addArgs(call: unlock.Call) ?AddArgs {
    const lp = call.arg(2);
    if (lp.op != 33 or lp.data.len != 33 or (lp.data[0] != 2 and lp.data[0] != 3)) return null;
    const bsv = pool.canonicalNum(call.arg(4)) orelse return null;
    const tokens = pool.canonicalNum(call.arg(5)) orelse return null;
    const change = pool.canonicalNum(call.changeAmount()) orelse return null;
    if (bsv < 0 or tokens < 0 or bsv + tokens <= 0 or change < 0) return null;
    return .{ .next_lp = lp.data[0..33].*, .add_bsv = @intCast(bsv), .add_tokens = @intCast(tokens), .change_pkh = call.changePkh(), .change = @intCast(change) };
}

/// An AddLiquidity's output set against the contract's (the pool spent,
/// `lock` its script after the token prefix, holding `satoshis`): 0 the
/// continuation, the same code, the reserves increased by addBsv (its
/// satoshis) and addTokens (TokenReserve), LpPubKey the call's nextLpPubKey,
/// the readonly fields and the identity unchanged (the ValidatorPubKey is
/// step 5's); then Rúnar's change output (P2PKH to `_changePKH`) only when
/// `_changeAmount > 0`, and nothing else. No fee, no commission: the
/// contract has none on AddLiquidity. Null when it matches.
pub fn addLiquidityOutputs(spent: pool.Pool, lock: []const u8, satoshis: u64, call: unlock.Call, outs: []const bsvz.transaction.Output) !?[]const u8 {
    const args = addArgs(call) orelse return "the AddLiquidity args (nextLpPubKey, addBsv, addTokens, change)";
    if (outs.len == 0) return "no continuation";
    const next = poolAt(outs[0].locking_script.bytes) orelse return "output 0 is not a pool";
    if (!std.mem.eql(u8, unlock.poolCode(next.token.lock) orelse "", unlock.poolCode(lock) orelse "-")) return "the continuation's code is not the pool's";
    if (outs[0].satoshis != satoshis + args.add_bsv) return "the continuation's BSV reserve";
    if (next.pool.token_reserve != spent.token_reserve + args.add_tokens) return "the continuation's TokenReserve";
    if (!std.mem.eql(u8, &next.pool.lp, &args.next_lp)) return "the continuation's LpPubKey";
    if (!std.mem.eql(u8, &next.pool.asset_id, &spent.asset_id) or !std.mem.eql(u8, &next.pool.identity, &spent.identity) or
        next.pool.lp_fee_bps != spent.lp_fee_bps or next.pool.validator_fee_bps != spent.validator_fee_bps or next.pool.commission_bps != spent.commission_bps)
        return "the continuation's readonly fields";
    var at: usize = 1;
    if (args.change > 0) {
        if (at >= outs.len) return "no change output";
        const pkh = unlock.p2pkhHash(outs[at].locking_script.bytes) orelse return "the change output is not P2PKH";
        if (args.change_pkh.len != 20 or !std.mem.eql(u8, &pkh, args.change_pkh) or outs[at].satoshis != args.change) return "the change output is not the call's";
        at += 1;
    }
    if (outs.len != at) return "outputs past the contract's";
    return null;
}

/// Whether the held transaction `sp` (a spender of the pool) is this request
/// with our signature in its slot: its pool call, the slot emptied again,
/// gives back the request byte for byte. → its bytes, or null.
pub fn signedSpend(a: std.mem.Allocator, v: View, sp: [32]u8, sub: Subject, pi: usize, method: pool.Method) !?[]const u8 {
    const raw = (try v.rawTx(a, sp)) orelse return null;
    const t = Transaction.parse(a, raw) catch return null;
    if (t.inputs.len != sub.tx.inputs.len) return null;
    const u = t.inputs[pi].unlocking_script.bytes;
    if (pool.methodOf(u) != method) return null;
    const call = (try unlock.parseCall(a, u, method)) orelse return null;
    const inputs = try a.dupe(bsvz.transaction.Input, t.inputs);
    inputs[pi].unlocking_script = bsvz.script.Script.init(try unlock.withArg(a, call, call.layout.validator_sig, &.{}));
    var bare = t;
    bare.inputs = inputs;
    return if (std.mem.eql(u8, try bare.serialize(a), sub.raw)) raw else null;
}

pub const DeployRequest = struct {
    tx: []const u8,
    /// The pool's output index: always 0 (one pool per deploy, at output 0).
    pool: u32,
};

/// A deploy request (the LP's complete deploy, every input signed by the LP,
/// usually a BEEF carrying its funding transaction unproven and the token
/// inputs' sources: the marketplace relay's, amm-p2p `amm.pool.submit`):
/// consent to host the position, or not. Nothing is signed here (the pool's
/// first spend is what we sign): on consent the deploy is returned with what
/// its submission needs (`Submission`: the topic, the request's ancestry, the
/// unproven parents to broadcast), and messages.zig routes it through skein's
/// `submit.route` as it does a signed spend. A deploy this instance already
/// holds (a retry) skips the checks below the pool's identity and is routed
/// again (pending, or judged before: answered from the state).
pub fn deploy(a: std.mem.Allocator, req: DeployRequest, cfg: Config, v: View, oracle: Oracle) !Reply {
    const sub = subjectOf(a, req.tx) orelse return refuse(.bad_transaction, null);
    const tx = sub.tx;
    if (req.pool != 0) return refuse(.pool_not_at_output_0, null);
    if (tx.outputs.len == 0) return refuse(.not_a_pool, null);
    const p = poolAt(tx.outputs[0].locking_script.bytes) orelse return refuse(.not_a_pool, null);
    if (!std.mem.eql(u8, &p.pool.identity, &cfg.identity)) return refuse(.not_our_pool, null);
    if (!validating(cfg, try topicOf(a, p.pool.asset_id))) return notValidating(a, try topicOf(a, p.pool.asset_id));
    const deploy_txid = beef.txidOf(sub.raw);
    const deploy_op: Outpoint = .{ .txid = deploy_txid, .vout = 0 };
    if ((try v.rawTx(a, deploy_txid)) != null) return .{ .ok = .{ .tx = sub.raw, .txid = deploy_txid, .submission = .{
        .topic = try topicOf(a, p.pool.asset_id),
        .pool = deploy_op,
        .ancestry = sub.ancestry,
    } } };

    // Our terms.
    if (p.pool.validator_fee_bps < cfg.min_validator_fee_bps or p.pool.validator_fee_bps > 10_000) return refuse(.fees_unacceptable, "validatorFeeBps");
    if (p.pool.lp_fee_bps < 0 or p.pool.lp_fee_bps > cfg.max_lp_fee_bps) return refuse(.fees_unacceptable, "lpFeeBps");
    if (p.pool.commission_bps < 0 or p.pool.commission_bps > (cfg.max_commission_bps orelse 10_000)) return refuse(.fees_unacceptable, "commissionBps");

    // Our topic would admit it, the pool with it, and the pool checks pass.
    const id = p.pool.asset_id;
    const topic = try topicOf(a, id);
    const previous = try v.previousCoins(a, topic, tx);
    const rtx = try rulesTx(a, v, sub, (try tx.txid(a)).bytes);
    const judged = switch (try judge(a, id, rtx, previous)) {
        .refused => |r| return r,
        .ok => |x| x,
    };
    if (judged.verdict.outputs_to_admit.len == 0 or judged.verdict.outputs_to_admit[0] != 0) return refuse(.topic_refused, "the pool is not admitted");

    // The signing key in state is our child of the LP's first token input,
    // and the oracle agrees it is a key we hold.
    const j = judged.j;
    if (j.inputs.len == 0) return refuse(.topic_refused, "no token input");
    const first = rtx.inputs[j.inputs[0].index];
    const key_op: Outpoint = .{ .txid = first.txid, .vout = first.vout };
    if (!std.mem.eql(u8, &try pool.validatorKey(a, cfg.identity, key_op.txid, key_op.vout), &p.pool.validator)) return refuse(.wrong_validator_key, null);
    const ours = oracle.publicKey(a, try keyIdOf(a, key_op)) catch |e| return refuse(.oracle_failed, @errorName(e));
    if (!std.mem.eql(u8, &ours, &p.pool.validator)) return refuse(.wrong_validator_key, "the oracle's key differs");


    // Complete: the LP's signatures on every input, and the unproven parents we do not hold (the LP's funding).
    if (try inputsSigned(a, v, sub, tx, null)) |r| return r;
    const parents = switch (try completeParents(a, v, sub)) {
        .refused => |r| return r,
        .ok => |ps| ps,
    };
    return .{ .ok = .{ .tx = sub.raw, .txid = deploy_txid, .submission = .{
        .topic = topic,
        .pool = deploy_op,
        .ancestry = sub.ancestry,
        .parents = parents,
    } } };
}
