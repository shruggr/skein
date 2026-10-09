//! The validator's protocol: the direct call's package and the dag-cbor
//! request and reply bodies (README.md, "Protocol"), and what the handler
//! does next — answer now, submit to the overlay by message and wait on its
//! answer, or wait on the submission already under way — and the answer:
//! from the engine's answer to the submission (`answerFromSubmit`), or read
//! from the state once the thread the call waited on has come to rest.
const std = @import("std");
const w = @import("chain");
const message = @import("message");
const scbor = @import("sdk_cbor");
const validator = @import("validator.zig");
const submit = @import("submit.zig");
const ov = @import("skein_overlay");
const View = @import("view.zig").View;

const cbor = w.cbor;
const Value = cbor.Value;
const Outpoint = validator.Outpoint;
const Reply = validator.Reply;

fn refuse(reason: validator.Reason, detail: ?[]const u8) Reply {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

// ---------------------------------------------------------------- the package

/// A direct call's frame, opened: the caller's identity (the signed
/// message's sender) and the request body.
pub const Opened = union(enum) {
    ok: struct { sender: [33]u8, body: Value },
    refused: Reply,
};

/// The frame of a direct call is a signed-message package, the shape skein
/// reads on `/skein/message/1.0.0` (docs/MESSAGES.md, "Signed messages
/// (#70)"): dag-cbor `{message: <signed mail record>, body: <the body
/// record's canonical dag-cbor>}`. The record must verify (skein-sdk
/// `message.problem`: BRC-169's signature by the sender's anyone-child for
/// [2, "metanet handles envelope"], key ID "send", over the record without
/// `signature`, and `body` the record the message names), name this
/// validator as `recipient` and this call as `box`. The taker (or LP) is
/// authenticated by its own identity key: the role BRC-103 played.
pub fn open(a: std.mem.Allocator, frame: []const u8, identity: [33]u8, op: validator.Op) !Opened {
    const pkg = scbor.decode(a, frame) catch return .{ .refused = refuse(.unauthenticated, "the frame is not dag-cbor") };
    const m = pkg.get("message") orelse return .{ .refused = refuse(.unauthenticated, "want {message, body}: a signed-message package") };
    const body = scbor.Value.bytesOf(pkg.get("body")) orelse return .{ .refused = refuse(.unauthenticated, "want {message, body}: a signed-message package") };
    if (try message.problem(a, m, body)) |why| return .{ .refused = refuse(.unauthenticated, why) };
    const recipient = scbor.Value.bytesOf(m.get("recipient")).?;
    if (!std.mem.eql(u8, recipient, &identity)) return .{ .refused = refuse(.unauthenticated, "the message is not for this validator") };
    if (!std.mem.eql(u8, scbor.Value.str(m.get("box")).?, op.name())) return .{ .refused = refuse(.unauthenticated, "the message's box is not this call") };
    const req = cbor.decode(a, body) catch return .{ .refused = refuse(.bad_request, "the body is not dag-cbor") };
    return .{ .ok = .{ .sender = scbor.Value.bytesOf(m.get("sender")).?[0..33].*, .body = req } };
}

// ---------------------------------------------------------------- bodies

pub fn parseSpend(v: Value) ?validator.SpendRequest {
    if (v != .map) return null;
    return .{
        .tx = v.getBytes("tx") orelse return null,
        .pool = Outpoint.parse(v.getText("pool") orelse return null) orelse return null,
    };
}

pub fn parseDeploy(v: Value) ?validator.DeployRequest {
    if (v != .map) return null;
    const vout = v.getUint("pool") orelse return null;
    if (vout > std.math.maxInt(u32)) return null;
    return .{ .tx = v.getBytes("tx") orelse return null, .pool = @intCast(vout) };
}

fn entries(a: std.mem.Allocator, es: []const cbor.Entry) !Value {
    return .{ .map = try a.dupe(cbor.Entry, es) };
}

fn text(a: std.mem.Allocator, s: []const u8) !Value {
    return .{ .text = try a.dupe(u8, s) };
}

fn int(n: i64) Value {
    return if (n >= 0) .{ .uint = @intCast(n) } else .{ .nint = @intCast(-(n + 1)) };
}

/// A pool's state for a reply: `{outpoint, bsvReserve, tokenReserve,
/// lpFeeBps, validatorFeeBps, commissionBps, tokenId, lpPubKey, validatorPubKey,
/// validatorIdentity}`, or `{closed: true, outpoint: <the last pool>, closedBy: <txid>}`.
pub fn poolValue(a: std.mem.Allocator, n: validator.Newest) !Value {
    switch (n) {
        .live => |s| return entries(a, &.{
            .{ .key = "outpoint", .value = .{ .text = try s.outpoint.format(a) } },
            .{ .key = "bsvReserve", .value = .{ .uint = s.satoshis } },
            .{ .key = "tokenReserve", .value = .{ .uint = s.pool.token_reserve } },
            .{ .key = "lpFeeBps", .value = int(s.pool.lp_fee_bps) },
            .{ .key = "validatorFeeBps", .value = int(s.pool.validator_fee_bps) },
            .{ .key = "commissionBps", .value = int(s.pool.commission_bps) },
            .{ .key = "tokenId", .value = try text(a, &w.header.toHex(s.pool.asset_id)) },
            .{ .key = "lpPubKey", .value = .{ .bytes = try a.dupe(u8, &s.pool.lp) } },
            .{ .key = "validatorPubKey", .value = .{ .bytes = try a.dupe(u8, &s.pool.validator) } },
            .{ .key = "validatorIdentity", .value = .{ .bytes = try a.dupe(u8, &s.pool.identity) } },
        }),
        .closed => |c| return entries(a, &.{
            .{ .key = "closed", .value = .{ .boolean = true } },
            .{ .key = "outpoint", .value = .{ .text = try c.last.format(a) } },
            .{ .key = "closedBy", .value = try text(a, &w.header.toHex(c.by)) },
        }),
    }
}

/// A reply body: `{ok: true, tx, txid}` (a spend; a deploy, its claim appended),
/// or `{ok: false, reason, detail?, txid?, pool?}`.
pub fn replyValue(a: std.mem.Allocator, r: Reply) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    switch (r) {
        .ok => |ok| {
            try es.append(a, .{ .key = "ok", .value = .{ .boolean = true } });
            if (ok.tx) |t| try es.append(a, .{ .key = "tx", .value = .{ .bytes = t } });
            if (ok.txid) |t| try es.append(a, .{ .key = "txid", .value = try text(a, &w.header.toHex(t)) });
        },
        .refused => |f| {
            try es.append(a, .{ .key = "ok", .value = .{ .boolean = false } });
            try es.append(a, .{ .key = "reason", .value = .{ .text = @tagName(f.reason) } });
            if (f.detail) |d| try es.append(a, .{ .key = "detail", .value = .{ .text = d } });
            if (f.txid) |t| try es.append(a, .{ .key = "txid", .value = try text(a, &w.header.toHex(t)) });
            if (f.newest) |n| try es.append(a, .{ .key = "pool", .value = try poolValue(a, n) });
        },
    }
    return .{ .map = es.items };
}

// ---------------------------------------------------------------- serving a call

pub const Deps = struct {
    config: validator.Config,
    view: View,
    oracle: @import("oracle.zig").Oracle,
    /// The app's overlay state as the step sees it (a submission under way, judged before, rejected).
    st: *ov.state.State,
};

/// What the handler does after the checks (main.zig):
pub const Next = union(enum) {
    /// `reply` is the answer, now (a refusal).
    answer,
    /// Submit by message (submit.zig): `{fn: "submit", args: {beef, topics: [topic]}}` from this
    /// instance to itself, box `<app>`; await it and answer `{wait: true}`. The engine's answer
    /// to it calls the handler again (`answerFromSubmit`).
    submit: struct { beef: []const u8, topic: []const u8 },
    /// A resubmission while the first submission awaits the network: await
    /// that thread (the overlay's `pending` record names it) and answer `{wait: true}`.
    wait_on: [32]u8,
    /// Judged before, or rejected before: the answer is the state's, now (`answerFromState`).
    from_state,
};

pub const Served = struct {
    reply: Reply,
    next: Next = .answer,
    /// With a deploy's `submit` (0.9.0): the claim to file in the validator's wallet (main.zig
    /// launches the wallet's `internalize`, filing.zig).
    file: ?Filing = null,
    /// With `submit` only: the unproven parents its BEEF carries, parents first, which the chain
    /// app registers and broadcasts when the engine ingests the submission
    /// (shruggr/skein-chain docs/CHAIN.md "Ingest a BEEF"). Nothing on a refusal.
    broadcast: []const validator.Parent = &.{},
};

/// After `validator.spend` signs (or `validator.deploy` consents: the LP's
/// deploy as it came, nobody else signs it): what the state says of the
/// transaction already — admitted under the topic, or rejected (answered from
/// the state), or with the chain app in a submission of its own (wait on that
/// thread: the engine answers a resubmission while the first is pending with
/// nothing) — else the signed BEEF submitted by message for the topic the
/// checks judged it for. A refusal by the engine comes back as its answer
/// (`answerFromSubmit`).
fn finishSpend(a: std.mem.Allocator, reply: Reply, d: Deps) !Served {
    if (reply != .ok) return .{ .reply = reply };
    const sub = reply.ok.submission orelse return .{ .reply = reply };
    const raw = reply.ok.tx orelse return .{ .reply = reply };
    const txid = reply.ok.txid orelse return .{ .reply = reply };
    if (try d.st.isApplied(sub.topic, txid)) return .{ .reply = reply, .next = .from_state };
    if ((try settlementOf(d.st, txid)) != null) return .{ .reply = reply, .next = .from_state };
    if (try d.st.isPending(txid)) if (!(try d.st.isPaused(txid))) return .{ .reply = reply, .next = .{ .wait_on = txid } };
    const beef = try submit.submissionBeef(a, raw, sub.ancestry);
    const file: ?Filing = if (sub.claim) |c| .{ .atomic = try submit.atomicBeef(a, raw, sub.ancestry), .vout = c.vout, .key_id = c.key_id, .txid = txid } else null;
    return .{ .reply = reply, .next = .{ .submit = .{ .beef = beef, .topic = sub.topic } }, .broadcast = sub.parents, .file = file };
}

/// A claim to file (0.9.0): the claimed deploy as Atomic BEEF, the claim's output index, its key ID.
pub const Filing = struct { atomic: []const u8, vout: u32, key_id: []const u8, txid: [32]u8 };

/// A direct call's request body → the reply, and what the handler does next.
pub fn respond(a: std.mem.Allocator, op: validator.Op, body: Value, d: Deps) !Served {
    switch (op) {
        .swap => {
            const req = parseSpend(body) orelse return .{ .reply = refuse(.bad_request, "want {tx: bytes, pool: \"<txid>_<vout>\"}") };
            return finishSpend(a, try validator.spend(a, op, req, d.config, d.view, d.oracle), d);
        },
        .deploy => {
            const req = parseDeploy(body) orelse return .{ .reply = refuse(.bad_request, "want {tx: bytes, pool: <vout>}") };
            return finishSpend(a, try validator.deploy(a, req, d.config, d.view, d.oracle), d);
        },
    }
}

// ---------------------------------------------------------------- the answer after the step

/// The chain app's settlement record of a rejected transaction (its reason), or null.
fn settlementOf(st: *ov.state.State, txid: [32]u8) !?Value {
    const c = (try st.ch.settlementCid(txid)) orelse return null;
    return try st.record(c);
}

/// A deploy's answer, read from the state once its submission's thread has
/// come to rest: the claimed deploy, found among the held spenders of the
/// request's input 0 (validator.zig `claimedHeld`: the same inputs, the
/// delivered outputs and the claim after them).
///   admitted (the topic's `applied` record) → `{ok: true, tx, txid}`;
///   rejected → `{ok: false, reason: "rejected", detail, txid}`;
///   still pending → `{ok: false, reason: "pending", txid}`;
///   not held, or none of these → `{ok: false, reason: "submit_failed"}`.
fn deployFromState(a: std.mem.Allocator, st: *ov.state.State, v: View, body: Value) !Reply {
    const req = parseDeploy(body) orelse return refuse(.bad_request, "want {tx: bytes, pool: <vout>}");
    const sub = validator.subjectOf(a, req.tx) orelse return refuse(.bad_transaction, null);
    if (sub.tx.outputs.len == 0) return refuse(.not_a_pool, null);
    const id = validator.poolTokenId(sub.tx.outputs[0].locking_script.bytes) orelse return refuse(.not_a_pool, null);
    const topic = try validator.topicOf(a, id);
    const held = (try validator.claimedHeld(a, v, sub)) orelse return refuse(.submit_failed, "the deploy is not held: its submission did not reach the overlay");
    const txid = held.txid;
    if (try st.isPending(txid)) return .{ .refused = .{
        .reason = .pending,
        .detail = "not yet accepted by the network: nothing is admitted until it is; send the same request again",
        .txid = txid,
    } };
    if (try settlementOf(st, txid)) |rec| return .{ .refused = .{ .reason = .rejected, .detail = rec.getText("reason") orelse "rejected", .txid = txid } };
    if (try st.isApplied(topic, txid)) return .{ .ok = .{ .tx = held.raw, .txid = txid } };
    return .{ .refused = .{ .reason = .submit_failed, .detail = "not admitted, pending or rejected: the submission came to nothing", .txid = txid } };
}

/// The answer to a spend's direct call, read from the state: when the
/// thread the call waited on (the submission's) has come to rest, the
/// handler is called again with the same request plus `resolved`
/// (docs/MESSAGES.md, "Route handlers", "Waiting"), and answers from the
/// state as it stands. The signed transaction is found again among the
/// held spenders of the pool (whatever their settlement): the one that is
/// this request with our signature in its slot (validator.zig `signedSpend`).
///   admitted (the topic's `applied` record) → `{ok: true, tx, txid}`;
///   rejected (a settlement record) → `{ok: false, reason: "rejected",
///     detail, txid, pool?}`, `pool` the pool's newest state if another
///     transaction spent it meanwhile;
///   still pending (the thread errored before the gate decided) →
///     `{ok: false, reason: "pending", txid}`: send the same request again;
///   not held, or none of these → `{ok: false, reason: "submit_failed"}`.
pub fn answerFromState(a: std.mem.Allocator, st: *ov.state.State, v: View, op: validator.Op, body: Value) !Reply {
    const method = op.method() orelse return deployFromState(a, st, v, body);
    const req = parseSpend(body) orelse return refuse(.bad_request, "want {tx: bytes, pool: \"<txid>_<vout>\"}");
    const sub = validator.subjectOf(a, req.tx) orelse return refuse(.bad_transaction, null);
    const pi = for (sub.tx.inputs, 0..) |in, i| {
        if (in.previous_outpoint.index == req.pool.vout and std.mem.eql(u8, &in.previous_outpoint.txid.bytes, &req.pool.txid)) break i;
    } else return refuse(.pool_not_an_input, null);
    const src = (try v.output(a, req.pool)) orelse return refuse(.unknown_pool, null);
    const id = validator.poolTokenId(src.script) orelse return refuse(.not_a_pool, null);
    const topic = try validator.topicOf(a, id);

    const signed: struct { txid: [32]u8, raw: []const u8 } = for (try v.spenders(a, req.pool)) |sp| {
        if (try validator.signedSpend(a, v, sp, sub, pi, method)) |raw| break .{ .txid = sp, .raw = raw };
    } else return refuse(.submit_failed, "the signed transaction is not held: its submission did not reach the overlay");
    const txid = signed.txid;

    if (try st.isPending(txid)) return .{ .refused = .{
        .reason = .pending,
        .detail = "not yet accepted by the network: nothing is admitted until it is; send the same request again",
        .txid = txid,
    } };
    if (try settlementOf(st, txid)) |rec| {
        const spent = (try v.spender(a, topic, req.pool)) != null;
        return .{ .refused = .{
            .reason = .rejected,
            .detail = rec.getText("reason") orelse "rejected",
            .txid = txid,
            .newest = if (spent) try validator.newest(a, v, topic, req.pool) else null,
        } };
    }
    if (try st.isApplied(topic, txid)) return .{ .ok = .{ .tx = signed.raw, .txid = txid } };
    return .{ .refused = .{ .reason = .submit_failed, .detail = "not admitted, pending or rejected: the submission came to nothing", .txid = txid } };
}

/// The direct call's answer on the engine's answer to its submission (the handler called again
/// with `reply`; skein-overlay docs/OVERLAY.md "Submitting", "The answers"): `{fn: "submit",
/// request, replyTo, result | error}`.
///   `admitted` or `proven` → the answer from the state (`{ok: true, tx, txid}`; a deploy's `{ok: true, txid}`);
///   `rejected` → from the state when the chain app holds it (its settlement: `rejected`, with the
///     pool's newest state if another transaction spent it); else by the engine's reason —
///     `NotAdmitted…` → `topic_refused`, `TransactionRejected` → `rejected`, any other (the BEEF
///     did not decode or verify) → `submit_refused`;
///   `error` → `submit_refused`, its message.
pub fn answerFromSubmit(a: std.mem.Allocator, st: *ov.state.State, v: View, op: validator.Op, body: Value, ans: Value) !Reply {
    if (ans.get("error")) |e| return refuse(.submit_refused, e.getText("message") orelse e.getText("code") orelse "error");
    const r = ans.get("result") orelse return refuse(.submit_failed, "the overlay's answer has no result");
    const state = r.getText("state") orelse "";
    const txid: ?[32]u8 = if (r.getText("txid")) |h| (w.header.fromHex(h) catch null) else null;
    if (std.mem.eql(u8, state, "rejected")) {
        const why = r.getText("reason") orelse "rejected";
        const held = try answerFromState(a, st, v, op, body);
        if (held == .refused and held.refused.reason == .rejected) return held;
        const reason: validator.Reason = if (std.mem.startsWith(u8, why, "NotAdmitted"))
            .topic_refused
        else if (std.mem.eql(u8, why, "TransactionRejected"))
            .rejected
        else
            .submit_refused;
        return .{ .refused = .{ .reason = reason, .detail = why, .txid = txid } };
    }
    return answerFromState(a, st, v, op, body);
}
