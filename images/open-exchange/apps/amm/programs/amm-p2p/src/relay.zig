//! The marketplace relay (docs/notes.md 2026-10-02, "Marketplace relay"):
//! the taker's own skein takes the pair a page built — the nosend funding
//! transaction and the swap spending its output — checks it, records the
//! swap in flight under the app's head, and carries it to the pool's
//! validator over a libp2p direct call, so the browser never needs libp2p.
//! Pure: no VM imports (main.zig wires it).
//!
//! **The pair** (`checkPair`):
//!
//!   funding  the taker's funding transaction: raw, or a BEEF (V1, V2, Atomic:
//!            BRC-100 createAction's `tx`) whose subject it is and which carries
//!            its ancestry. The validator's overlay verifies every unproven
//!            transaction's inputs against a parent in the BEEF or one it holds
//!            (skein-overlay `verifyDecoded`), so a raw funding transaction
//!            verifies only where the validator holds its parents.
//!   swap     the raw swap: input 0 the pool with its Rúnar call (the
//!            validator's signature slot `OP_0`), another input an output of the
//!            funding transaction, every other input signed; outputs as the Pool
//!            contract's Swap writes them: 0 the continuation, 1 the payout, then
//!            the LP fee, the validator fee and the commission (the pool's
//!            CommissionBps of amountIn, in the input asset, to the call's
//!            commissionPkh), each only when nonzero, then at most one change
//!            output. The commission must pay this relay's pkh (config
//!            `commission.pkh`) when one is set and the pool charges one.
//!
//! **The record** (one per swap, keyed by `id` = sha256 of the swap's bytes,
//! the validator's slot still empty), in the app's state map `swaps`:
//!
//!   {kind: "amm-swap", id: <hex>, status: "pending" | "accepted" | "refused" | "timeout" | "failed",
//!    funding: bytes, swap: bytes, pool: "<txid>_<vout>", validator: bytes(33), expires: ms,
//!    created: ms, updated: ms,
//!    tx?: bytes, txid?: text                          accepted: the validator's signed swap
//!    reason?: text, detail?: text, poolState?: map    refused (the validator's), timeout, failed
//!    peer?, local?, dial?, stream?, thread?, request?} the relay's own: not in the answer
//!
//! **The validator named** (0.4.0, shruggr/skein#120, David 2026-10-06): the
//! caller names the validator, its identity key (`validator`) and its libp2p
//! peer ID (`peerId`, text: what the page read from the runtime's liveness
//! endpoint, the beat's body). The relay looks at no liveness: it dials the
//! peer it was given, or — when `peerId` is this node's own (`Env.self_peer`)
//! — hands the request to its own validator program in-VM (`local`).
//!
//! **The relay** (`advance`): a thread resting on the libp2p provider's
//! answers to one dial (docs/MESSAGES.md "The providers", "Awaiting the
//! answer"), bounded by `expires` (the waker, `deadline`):
//!
//!   start                  emit dial {peer, protocol: /amm-validator/1/swap}; rest
//!   {stream} (box dial)    emit send {stream, body: the package}; rest
//!   {stream, body} (frame) the validator's answer: accepted | refused; emit close; done
//!   closed | error         failed; done
//!   woke at/after expires  timeout (close the stream if open); done
//!
//! **Local** (`advanceLocal`, `localAnswer`): the validator is this instance.
//! A node does not dial itself, so the relay does what the front door does
//! with a frame on `/amm-validator/1/<call>` (skein programs/frontdoor
//! libp2p.zig `stepped`): it calls the route's handler, amm-validator's fn
//! (`swap`, `deploy`, `addLiquidity`), in-VM with the same package as the
//! frame's body, from the relay thread's step. The handler answers `{verdict,
//! body}` (the reply: accepted | refused; done) or `{wait: true}` after
//! awaiting its submission (the thread rests on it); stepped again by the
//! engine's answer (`reply`) or the awaited thread at rest (`resolved`), the
//! relay calls the handler again with it, as the front door does; woke
//! at/after `expires`: timeout.
//!
//! The package is the signed-message package the validator's protocol reads
//! (amm-validator README, "A direct call"): `{message, body}`, the mail record
//! signed BRC-169's way by this instance's identity, recipient the validator,
//! box `swap`, and the body `{tx: <BEEF: the funding transaction's ancestry,
//! the funding transaction, the swap>, pool}`.
//!
//! **The pool deploy** (`amm.pool/1`: `checkDeploy`, `submitDeploy`): the
//! LP's funding transaction and the deploy spending it and the LP's token
//! outputs, the deploy a BEEF carrying their sources. A record of kind
//! `amm-pool` in the state map `pools`, the same lifecycle, relayed on
//! `/amm-validator/1/deploy` (box `deploy`, body `{tx: <the deploy's BEEF,
//! the funding merged in when missing>, pool: 0}`); accepted is the deploy
//! itself (nobody signs it but the LP).
//!
//! **The AddLiquidity** (`amm.liquidity/1`: `checkAdd`, `submitAdd`): the
//! LP's funding transaction and the AddLiquidity spending the pool (input 0),
//! the LP's token outputs and the funding output, the LP's slot in the pool
//! call signed and the validator's empty, given as a BEEF carrying the
//! funding and the token inputs' sources. A record of kind `amm-liquidity` in
//! the state map `liquidity`, the same lifecycle, relayed on
//! `/amm-validator/1/addLiquidity` (box `addLiquidity`, body `{tx: <the
//! add's BEEF, the funding merged in when missing>, pool}`); accepted is the
//! validator's signed transaction (the add with its slot filled, checked).
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");
const scbor = @import("sdk_cbor");
const libp2p = @import("libp2p.zig");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const Transaction = w.bsvz.transaction.Transaction;
const beef = w.beef;
const brc162 = mandala.brc162;
const pool = @import("pool");
const eql = std.mem.eql;

/// The app (its box, and the prefix of its heads) and the interface's functions.
pub const app_name = "amm";
/// The app's root head (skein-sdk 0.3.0 `app.headOf`, shruggr/skein#77: an
/// app's heads are `<app>/…`, its root `<app>/app`), where the relay keeps
/// its state.
pub const app_head = app_name ++ "/app";
/// This program's own state (the catch-up cursor; 0.6.0),
/// under the app's name too: under #77 an installed app advances only heads
/// named `<app>/…`.
pub const p2p_head = app_name ++ "/p2p";
pub const fn_submit = "amm.swap.submit";
pub const fn_status = "amm.swap.status";
pub const fn_terms = "amm.swap.terms";
/// The pool deploy through the relay (interface `amm.pool/1`).
pub const fn_pool_submit = "amm.pool.submit";
pub const fn_pool_status = "amm.pool.status";
/// The AddLiquidity through the relay (interface `amm.liquidity/1`).
pub const fn_liquidity_submit = "amm.liquidity.submit";
pub const fn_liquidity_status = "amm.liquidity.status";
/// The validator's direct calls, and the boxes their packages name.
pub const swap_protocol = "/amm-validator/1/swap";
pub const swap_box = "swap";
pub const deploy_protocol = "/amm-validator/1/deploy";
pub const deploy_box = "deploy";
pub const liquidity_protocol = "/amm-validator/1/addLiquidity";
pub const liquidity_box = "addLiquidity";
/// The launched relay thread's argument record: `{kind, id}`.
pub const relay_kind = "amm-swap-relay";
pub const pool_relay_kind = "amm-pool-relay";
pub const liquidity_relay_kind = "amm-liquidity-relay";
pub const record_kind = "amm-swap";
pub const pool_record_kind = "amm-pool";
pub const liquidity_record_kind = "amm-liquidity";
pub const state_kind = "amm-app-state";

/// What a record relays: a swap (`amm.swap/1`), a pool deploy
/// (`amm.pool/1`) or an AddLiquidity (`amm.liquidity/1`). All kinds share the
/// record's shape, its lifecycle and the app's state; each has its own map
/// there (`swaps`, `pools`, `liquidity`), its own relay thread kind, and its
/// own call on the validator.
pub const Kind = enum {
    swap,
    pool,
    liquidity,

    pub fn recordKind(k: Kind) []const u8 {
        return switch (k) {
            .swap => record_kind,
            .pool => pool_record_kind,
            .liquidity => liquidity_record_kind,
        };
    }
    pub fn relayKind(k: Kind) []const u8 {
        return switch (k) {
            .swap => relay_kind,
            .pool => pool_relay_kind,
            .liquidity => liquidity_relay_kind,
        };
    }
    pub fn protocol(k: Kind) []const u8 {
        return switch (k) {
            .swap => swap_protocol,
            .pool => deploy_protocol,
            .liquidity => liquidity_protocol,
        };
    }
    pub fn box(k: Kind) []const u8 {
        return switch (k) {
            .swap => swap_box,
            .pool => deploy_box,
            .liquidity => liquidity_box,
        };
    }
    /// The submit function whose answer a message caller waits for.
    pub fn submitFn(k: Kind) []const u8 {
        return switch (k) {
            .swap => fn_submit,
            .pool => fn_pool_submit,
            .liquidity => fn_liquidity_submit,
        };
    }
    /// The record's field holding what was relayed: the raw swap, the deploy's BEEF, the add's BEEF.
    pub fn subjectKey(k: Kind) []const u8 {
        return switch (k) {
            .swap => "swap",
            .pool => "deploy",
            .liquidity => "add",
        };
    }
    /// The status function of the kind.
    pub fn statusFn(k: Kind) []const u8 {
        return switch (k) {
            .swap => fn_status,
            .pool => fn_pool_status,
            .liquidity => fn_liquidity_status,
        };
    }
    pub fn ofRelay(s: []const u8) ?Kind {
        inline for (.{ Kind.swap, Kind.pool, Kind.liquidity }) |k| if (eql(u8, s, k.relayKind())) return k;
        return null;
    }
    pub fn ofRecord(s: []const u8) ?Kind {
        inline for (.{ Kind.swap, Kind.pool, Kind.liquidity }) |k| if (eql(u8, s, k.recordKind())) return k;
        return null;
    }
    /// The kind whose submit function is `name`.
    pub fn ofSubmit(name: []const u8) ?Kind {
        inline for (.{ Kind.swap, Kind.pool, Kind.liquidity }) |k| if (eql(u8, name, k.submitFn())) return k;
        return null;
    }
};

/// The relay's commission (config `commission`): when `pkh` is set, a swap
/// is relayed only if its commission output pays it (a pool whose
/// CommissionBps is 0 has none, and passes). The page learns `pkh` from
/// `amm.swap.terms` and names it as Swap's commissionPkh.
pub const Commission = struct {
    pkh: ?[20]u8 = null,
};

/// amm.swap.terms `{}` → `{commissionPkh: bytes(20) | null}`.
pub fn terms(a: Allocator, c: Commission) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "commissionPkh", .value = if (c.pkh) |p| .{ .bytes = try a.dupe(u8, &p) } else .null },
    }) };
}

// ---------------------------------------------------------------- the pair

pub const Refusal = struct { reason: []const u8, detail: ?[]const u8 = null };

/// A swap's call to the pool, as Rúnar lays it out (amm-validator unlock.zig):
/// `_codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
/// commissionPkh, _changePKH, _changeAmount, txPreimage, methodIndex`:
/// pushes only.
pub const SwapCall = struct {
    amount_in: u64,
    bsv_in: bool,
    user_pkh: []const u8,
    commission_pkh: []const u8,
    change: u64,
};

pub const swap_pushes = 1 + 6 + 4;

/// A script number push (minimal or not), non-negative, as a u64.
fn numOf(p: brc162.Push) ?u64 {
    return switch (p.op) {
        brc162.OP_0 => 0,
        brc162.OP_1...brc162.OP_16 => p.op - (brc162.OP_1 - 1),
        0x01...0x09 => blk: {
            // Rúnar writes minimal numbers; read any non-negative encoding.
            const b = p.data;
            if (b[b.len - 1] & 0x80 != 0) break :blk null;
            if (b.len > 8 and b[8] != 0) break :blk null;
            var v: u64 = 0;
            for (b[0..@min(b.len, 8)], 0..) |x, i| v |= @as(u64, x) << @intCast(8 * i);
            break :blk v;
        },
        else => null,
    };
}

fn boolOf(p: brc162.Push) ?bool {
    const n = numOf(p) orelse return null;
    return n != 0;
}

pub fn parseSwapCall(a: Allocator, script: []const u8) !?SwapCall {
    var pushes: std.ArrayList(brc162.Push) = .empty;
    var pos: usize = 0;
    while (pos < script.len) {
        const p = brc162.readPush(script, pos) orelse return null;
        try pushes.append(a, p);
        pos = p.next;
    }
    if (pushes.items.len != swap_pushes) return null;
    const arg = pushes.items[1..];
    return .{
        .amount_in = numOf(arg[2]) orelse return null,
        .bsv_in = boolOf(arg[3]) orelse return null,
        .user_pkh = arg[4].data,
        .commission_pkh = arg[5].data,
        .change = numOf(arg[7]) orelse return null,
    };
}

/// The validator's signature slot (the call's first argument) is `OP_0`.
pub fn slotEmpty(script: []const u8) bool {
    const code = brc162.readPush(script, 0) orelse return false;
    const slot = brc162.readPush(script, code.next) orelse return false;
    return slot.op == brc162.OP_0;
}

/// An outpoint, BRC-162's text form `<txid, display hex>_<vout>`.
pub const Outpoint = struct {
    txid: [32]u8,
    vout: u32,

    pub fn parse(text: []const u8) ?Outpoint {
        if (text.len < 66 or text[64] != '_') return null;
        for (text[0..64]) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return null;
        const txid = w.header.fromHex(text[0..64]) catch return null;
        const digits = text[65..];
        if (digits.len == 0 or digits.len > 10 or (digits.len > 1 and digits[0] == '0')) return null;
        return .{ .txid = txid, .vout = std.fmt.parseInt(u32, digits, 10) catch return null };
    }
};

/// A transaction given as raw bytes or as a BEEF whose subject it is.
pub const Given = struct {
    raw: []const u8,
    tx: Transaction,
    txid: [32]u8,
    beef: ?beef.Beef = null,
};

pub fn given(a: Allocator, bytes: []const u8) ?Given {
    if (bytes.len >= 4) {
        const magic = std.mem.readInt(u32, bytes[0..4], .little);
        if (magic == beef.V1 or magic == beef.V2 or magic == beef.ATOMIC) {
            const b = beef.parse(a, bytes) catch return null;
            const s = b.subject() orelse return null;
            const e = b.find(s) orelse return null;
            const raw = e.raw orelse return null;
            return .{ .raw = raw, .tx = Transaction.parse(a, raw) catch return null, .txid = s, .beef = b };
        }
    }
    const tx = Transaction.parse(a, bytes) catch return null;
    if (tx.serializedLen() != bytes.len) return null;
    return .{ .raw = bytes, .tx = tx, .txid = beef.txidOf(bytes) };
}

pub const Pair = struct {
    funding: Given,
    swap: Given,
    pool: Outpoint,
    call: SwapCall,
    continuation: pool.Pool,
};

pub const Checked = union(enum) { ok: Pair, refused: Refusal };

fn refused(reason: []const u8, detail: ?[]const u8) Checked {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

fn p2pkhHash(lock: []const u8) ?[]const u8 {
    if (lock.len != 25 or lock[0] != 0x76 or lock[1] != 0xa9 or lock[2] != 0x14 or lock[23] != 0x88 or lock[24] != 0xac) return null;
    return lock[3..23];
}

/// Check a pair before anything is written (`amm.swap.submit`'s first step).
/// `now` is the step's clock; `validator` the identity the caller names.
pub fn checkPair(a: Allocator, funding_bytes: []const u8, swap_bytes: []const u8, pool_text: []const u8, validator: []const u8, expires: u64, now: u64, commission: Commission) !Checked {
    if (validator.len != 33 or (validator[0] != 2 and validator[0] != 3)) return refused("bad_validator", "an identity key: 33 bytes, compressed");
    if (expires <= now) return refused("expired", null);
    const funding = given(a, funding_bytes) orelse return refused("bad_funding", "not a transaction, or a BEEF whose subject is one");
    const swap_g = given(a, swap_bytes) orelse return refused("bad_swap", "not a transaction");
    if (swap_g.beef != null) return refused("bad_swap", "the swap is the raw transaction");
    const swap = swap_g.tx;
    const op = Outpoint.parse(pool_text) orelse return refused("bad_pool", "want <txid>_<vout>");

    // The swap spends the pool (input 0) and an output of the funding transaction.
    if (swap.inputs.len < 2) return refused("bad_swap", "a swap has the pool and the funding as inputs");
    const p0 = swap.inputs[0].previous_outpoint;
    if (p0.index != op.vout or !eql(u8, &p0.txid.bytes, &op.txid)) return refused("pool_not_input_0", null);
    const spends_funding = for (swap.inputs[1..]) |in| {
        if (eql(u8, &in.previous_outpoint.txid.bytes, &funding.txid) and in.previous_outpoint.index < funding.tx.outputs.len) break true;
    } else false;
    if (!spends_funding) return refused("funding_not_spent", null);

    // Complete: every funding input and every swap input but the pool's carries its unlocking script.
    for (funding.tx.inputs, 0..) |in, i| if (in.unlocking_script.bytes.len == 0) return refused("funding_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));
    for (swap.inputs[1..], 1..) |in, i| if (in.unlocking_script.bytes.len == 0) return refused("swap_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));

    // The pool call: Swap, laid out as Rúnar calls it, the validator's slot empty.
    const unlocking = swap.inputs[0].unlocking_script.bytes;
    if (pool.methodOf(unlocking) != .swap) return refused("not_a_swap", null);
    const call = (try parseSwapCall(a, unlocking)) orelse return refused("bad_call", "not a Rúnar call of Swap");
    if (!slotEmpty(unlocking)) return refused("signature_slot_not_empty", null);
    if (call.amount_in == 0) return refused("bad_call", "amountIn");
    if (call.user_pkh.len != 20) return refused("bad_call", "userPkh");
    if (call.commission_pkh.len != 20) return refused("bad_call", "commissionPkh");

    // The outputs, as the contract writes them.
    if (swap.outputs.len < 2) return refused("bad_outputs", "no continuation and payout");
    const tok = brc162.decode(swap.outputs[0].locking_script.bytes) orelse return refused("bad_outputs", "output 0 is not a pool");
    if (tok.role != .value) return refused("bad_outputs", "output 0 is not a pool");
    const cont = (pool.parse(tok.lock) catch return refused("bad_outputs", "output 0: a malformed pool")) orelse return refused("bad_outputs", "output 0 is not a pool");
    if (!eql(u8, &cont.identity, validator)) return refused("wrong_validator", "the pool's ValidatorIdentity is another");
    const lp_fee = pool.feeOf(call.amount_in, cont.lp_fee_bps) orelse return refused("bad_outputs", "lpFeeBps");
    const val_fee = pool.feeOf(call.amount_in, cont.validator_fee_bps) orelse return refused("bad_outputs", "validatorFeeBps");
    const com = pool.feeOf(call.amount_in, cont.commission_bps) orelse return refused("bad_outputs", "commissionBps");
    var at: usize = 2 + @as(usize, @intFromBool(lp_fee > 0)) + @intFromBool(val_fee > 0);
    if (at > swap.outputs.len) return refused("bad_outputs", "the fee outputs");
    if (com > 0) {
        // The commission: in the input asset, to the call's commissionPkh.
        if (at >= swap.outputs.len) return refused("bad_outputs", "the commission: no output");
        const o = swap.outputs[at];
        const want = try pool.payoutScript(a, cont.asset_id, com, call.commission_pkh[0..20].*, call.bsv_in);
        if (o.satoshis != pool.payoutSats(com, call.bsv_in) or !eql(u8, o.locking_script.bytes, want)) return refused("bad_outputs", "the commission: not the contract's");
        at += 1;
    }
    if (swap.outputs.len > at + @intFromBool(call.change > 0)) return refused("bad_outputs", "outputs past the contract's");

    // Our commission: the swap pays it to us (none when the pool charges none).
    if (commission.pkh) |ours| if (com > 0 and !eql(u8, call.commission_pkh, &ours))
        return refused("commission_missing", try std.fmt.allocPrint(a, "the commission pays {s}, not {s}", .{ &std.fmt.bytesToHex(call.commission_pkh[0..20].*, .lower), &std.fmt.bytesToHex(ours, .lower) }));
    return .{ .ok = .{ .funding = funding, .swap = swap_g, .pool = op, .call = call, .continuation = cont } };
}

/// The swap's id: sha256 of its bytes (the validator's slot empty), hex.
pub fn idOf(swap: []const u8) [32]u8 {
    var d: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(swap, &d, .{});
    return d;
}

pub fn idText(id: [32]u8) [64]u8 {
    return std.fmt.bytesToHex(id, .lower);
}

pub fn idParse(text: []const u8) ?[32]u8 {
    if (text.len != 64) return null;
    var id: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&id, text) catch return null;
    return id;
}

// ---------------------------------------------------------------- the BEEF and the package

/// The ancestry of `subject` within a BEEF (itself included), parents first, in the BEEF's order.
fn ancestry(a: Allocator, b: beef.Beef, subject: [32]u8) ![]bool {
    const keep = try a.alloc(bool, b.entries.len);
    @memset(keep, false);
    const start = b.indexOf(subject) orelse return keep;
    keep[start] = true;
    var i = start + 1;
    while (i > 0) {
        i -= 1;
        if (!keep[i]) continue;
        const e = b.entries[i];
        if (e.format != .raw) continue; // proven (with its BUMP) or txid-only: no further ancestry needed
        const t = e.tx orelse (Transaction.parse(a, e.raw orelse continue) catch continue);
        for (t.inputs) |in| if (b.indexOf(in.previous_outpoint.txid.bytes)) |k| {
            if (k < i) keep[k] = true;
        };
    }
    return keep;
}

/// The one BEEF the validator gets: the funding transaction's ancestry (its
/// BEEF's, when it came as one), the funding transaction (unproven), then
/// the swap as the subject. V2, parents first.
pub fn requestBeef(a: Allocator, p: Pair) ![]u8 {
    var entries: std.ArrayList(beef.Entry) = .empty;
    var bumps: []w.merkle.MerklePath = &.{};
    if (p.funding.beef) |b| {
        const keep = try ancestry(a, b, p.funding.txid);
        // Keep the BUMPs as they are (indices stay valid); only the entries are filtered.
        bumps = b.bumps;
        for (b.entries, keep) |e, k| if (k) try entries.append(a, e);
    } else {
        try entries.append(a, .{ .txid = p.funding.txid, .format = .raw, .raw = p.funding.raw, .tx = p.funding.tx });
    }
    try entries.append(a, .{ .txid = p.swap.txid, .format = .raw, .raw = p.swap.raw, .tx = p.swap.tx });
    return beef.serialize(a, .{ .version = beef.V2, .bumps = bumps, .entries = entries.items });
}

/// The validator's request body: `{tx: <the BEEF>, pool}` (amm-validator README, "Protocol").
pub fn requestBody(a: Allocator, tx: []const u8, pool_text: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tx", .value = .{ .bytes = tx } },
        .{ .key = "pool", .value = .{ .text = pool_text } },
    }) };
}

/// Who signs the package: this instance's identity and its BRC-42 child for
/// [2, "metanet handles envelope"], key ID "send", counterparty anyone (the
/// `wallet` import in the program; a key in the tests).
pub const Signer = struct {
    ctx: *anyopaque,
    identityFn: *const fn (ctx: *anyopaque, a: Allocator) anyerror![33]u8,
    /// DER signature of `hash` (sha256 of the record without `signature`).
    signFn: *const fn (ctx: *anyopaque, a: Allocator, hash: [32]u8) anyerror![]const u8,
};

pub const envelope_protocol = "metanet handles envelope";
pub const envelope_key_id = "send";

/// The direct call's frame: a signed-message package `{message, body}`
/// (skein docs/MESSAGES.md "Signed messages (#70)"; the shape amm-validator's
/// `messages.open` checks with skein-sdk's `message.problem`). `nonce` makes
/// the record unique to this swap.
pub fn package(a: Allocator, signer: Signer, recipient: []const u8, box: []const u8, body: Value, nonce: [16]u8) ![]u8 {
    const body_bytes = try cbor.encode(a, body);
    const blk = try scbor.block(a, try scbor.decode(a, body_bytes));
    if (!eql(u8, blk.bytes, body_bytes)) return error.NotCanonical;
    const sender = try signer.identityFn(signer.ctx, a);
    var es: std.ArrayList(scbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .string = "mail" } },
        .{ .key = "op", .value = .{ .string = "put" } },
        .{ .key = "sender", .value = .{ .bytes = try a.dupe(u8, &sender) } },
        .{ .key = "recipient", .value = .{ .bytes = recipient } },
        .{ .key = "box", .value = .{ .string = box } },
        .{ .key = "body", .value = .{ .cid = blk.cid } },
        .{ .key = "nonce", .value = .{ .bytes = try a.dupe(u8, &nonce) } },
    });
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(try scbor.encode(a, .{ .map = es.items }), &digest, .{});
    const sig = try signer.signFn(signer.ctx, a, digest);
    try es.append(a, .{ .key = "signature", .value = .{ .bytes = sig } });
    return scbor.encode(a, .{ .map = try a.dupe(scbor.Entry, &.{
        .{ .key = "message", .value = .{ .map = es.items } },
        .{ .key = "body", .value = .{ .bytes = body_bytes } },
    }) });
}

/// The nonce of a swap's package: the first 16 bytes of sha256("amm-swap-relay" ‖ id).
pub fn nonceOf(id: [32]u8) [16]u8 {
    return nonceFor(.swap, id);
}

/// The nonce of a record's package: the first 16 bytes of sha256(<its relay kind> ‖ id)
/// ("amm-swap-relay" for a swap, "amm-pool-relay" for a deploy).
pub fn nonceFor(kind: Kind, id: [32]u8) [16]u8 {
    var d: [32]u8 = undefined;
    var h = std.crypto.hash.sha2.Sha256.init(.{});
    h.update(kind.relayKind());
    h.update(&id);
    h.final(&d);
    return d[0..16].*;
}

/// The package for a record, to the validator: a swap's request BEEF (from
/// the pair the record keeps) and the pool in box `swap`; a deploy's BEEF
/// (`deployBeef`) and `pool: 0` in box `deploy`; an add's BEEF (`deployBeef`
/// over the add) and the pool in box `addLiquidity`.
pub fn packageFor(a: Allocator, signer: Signer, rec: Record) ![]u8 {
    const f = given(a, rec.funding) orelse return error.BadRecord;
    const s = given(a, rec.swap) orelse return error.BadRecord;
    const body = switch (rec.kind) {
        .swap => blk: {
            const pair: Pair = .{ .funding = f, .swap = s, .pool = Outpoint.parse(rec.pool) orelse return error.BadRecord, .call = undefined, .continuation = undefined };
            break :blk try requestBody(a, try requestBeef(a, pair), rec.pool);
        },
        .pool => try deployBody(a, try deployBeef(a, f, s)),
        // One BEEF, as a deploy's: the add's as received, the funding merged in when missing.
        .liquidity => try requestBody(a, try deployBeef(a, f, s), rec.pool),
    };
    return package(a, signer, &rec.validator, rec.kind.box(), body, nonceFor(rec.kind, rec.id));
}

// ---------------------------------------------------------------- the pool deploy (amm.pool/1)

/// A deploy the relay carries (docs/notes.md 2026-10-02, "Swap funding and
/// signing" applied to the deploy; web/ui src/lp/poolDeploy.ts): the LP's
/// funding transaction (one exact output) and the deploy spending it and the
/// LP's token outputs, every input signed by the LP. Nobody else signs a
/// deploy: the validator consents, submits it to its overlay and broadcasts
/// the funding parent.
pub const DeployPair = struct {
    funding: Given,
    /// The deploy as a BEEF (Atomic, V1, V2) whose subject it is.
    deploy: Given,
    continuation: pool.Pool,
    /// The deploy's first token input: the outpoint keying the validator's first key.
    key_input: Outpoint,
};

pub const DeployChecked = union(enum) { ok: DeployPair, refused: Refusal };

fn refusedDeploy(reason: []const u8, detail: ?[]const u8) DeployChecked {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

/// A pool at an output script, as amm-topic's pool checks see one (pool.zig
/// `check`): a BRC-162 value output whose lock parses as the Pool, its prefix
/// id a 32-byte id equal to the AssetId and its amount the TokenReserve.
/// `.none` when the script is no pool at all.
const PoolAt = union(enum) { none, pool: pool.Pool, bad: []const u8 };

fn poolAt(script: []const u8) PoolAt {
    const tok = brc162.decode(script) orelse return .none;
    if (tok.role != .value) return .none;
    const p = (pool.parse(tok.lock) catch return .{ .bad = "a malformed pool" }) orelse return .none;
    const id = tok.id orelse return .{ .bad = "no token id" };
    if (id.vout != 0 or !eql(u8, &id.txid, &p.asset_id)) return .{ .bad = "the prefix id is not the AssetId" };
    if (tok.amount != p.token_reserve) return .{ .bad = "the prefix amount is not the TokenReserve" };
    return .{ .pool = p };
}

/// Check a deploy before anything is written (`amm.pool.submit`'s first
/// step): output 0 a pool naming `validator`, its ValidatorPubKey the
/// identity's anyone-child for the deploy's first token input (the key the
/// validator checks, amm-validator `deploy`), the funding transaction spent,
/// every input of both signed, the token inputs' parents in the deploy's BEEF.
pub fn checkDeploy(a: Allocator, funding_bytes: []const u8, deploy_bytes: []const u8, validator: []const u8, expires: u64, now: u64) !DeployChecked {
    if (validator.len != 33 or (validator[0] != 2 and validator[0] != 3)) return refusedDeploy("bad_validator", "an identity key: 33 bytes, compressed");
    if (expires <= now) return refusedDeploy("expired", null);
    const funding = given(a, funding_bytes) orelse return refusedDeploy("bad_funding", "not a transaction, or a BEEF whose subject is one");
    const d = given(a, deploy_bytes) orelse return refusedDeploy("bad_deploy", "not a BEEF whose subject is a transaction");
    const db = d.beef orelse return refusedDeploy("bad_deploy", "the deploy is a BEEF carrying the funding and the token inputs' source transactions");
    const tx = d.tx;

    // Output 0 the pool, no pool elsewhere; its ValidatorIdentity the one named.
    if (tx.outputs.len == 0) return refusedDeploy("not_a_pool", "no outputs");
    const cont = switch (poolAt(tx.outputs[0].locking_script.bytes)) {
        .none => return refusedDeploy("not_a_pool", "output 0 is not a pool"),
        .bad => |why| return refusedDeploy("not_a_pool", try std.fmt.allocPrint(a, "output 0: {s}", .{why})),
        .pool => |p| p,
    };
    for (tx.outputs[1..], 1..) |o, i| if (poolAt(o.locking_script.bytes) != .none) return refusedDeploy("bad_deploy", try std.fmt.allocPrint(a, "a pool at output {d}", .{i}));
    if (!eql(u8, &cont.identity, validator)) return refusedDeploy("wrong_validator", "the pool's ValidatorIdentity is another");

    // The deploy spends an output of the funding transaction.
    const spends_funding = for (tx.inputs) |in| {
        if (eql(u8, &in.previous_outpoint.txid.bytes, &funding.txid) and in.previous_outpoint.index < funding.tx.outputs.len) break true;
    } else false;
    if (!spends_funding) return refusedDeploy("funding_not_spent", null);

    // Complete: every input of both carries its unlocking script (the validator's overlay verifies them).
    for (funding.tx.inputs, 0..) |in, i| if (in.unlocking_script.bytes.len == 0) return refusedDeploy("funding_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));
    for (tx.inputs, 0..) |in, i| if (in.unlocking_script.bytes.len == 0) return refusedDeploy("deploy_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));

    // The LP's inputs: each parent in the BEEF; the first token input keys the validator's key.
    var first: ?Outpoint = null;
    for (tx.inputs, 0..) |in, i| {
        const op = in.previous_outpoint;
        if (eql(u8, &op.txid.bytes, &funding.txid)) continue;
        const e = db.find(op.txid.bytes) orelse return refusedDeploy("missing_parent", try std.fmt.allocPrint(a, "input {d}: {s} is not in the deploy's BEEF", .{ i, &w.header.toHex(op.txid.bytes) }));
        const raw = e.raw orelse return refusedDeploy("missing_parent", try std.fmt.allocPrint(a, "input {d}: {s} is in the deploy's BEEF by txid only", .{ i, &w.header.toHex(op.txid.bytes) }));
        const pt = e.tx orelse (Transaction.parse(a, raw) catch return refusedDeploy("missing_parent", try std.fmt.allocPrint(a, "input {d}: its source does not parse", .{i})));
        if (op.index >= pt.outputs.len) return refusedDeploy("missing_parent", try std.fmt.allocPrint(a, "input {d}: no output {d} in its source", .{ i, op.index }));
        if (first == null) if (try mandala.bsv21.tokenOf(a, .{ .txid = cont.asset_id }, op.txid.bytes, op.index, pt.outputs[op.index].locking_script.bytes)) |_| {
            first = .{ .txid = op.txid.bytes, .vout = op.index };
        };
    }
    const key_input = first orelse return refusedDeploy("no_token_input", "the deploy spends no output of the pool's token");
    const want = try pool.validatorKey(a, validator[0..33].*, key_input.txid, key_input.vout);
    if (!eql(u8, &want, &cont.validator)) return refusedDeploy("wrong_validator_key", try std.fmt.allocPrint(a, "the ValidatorPubKey is not the identity's child for {s}_{d}", .{ &w.header.toHex(key_input.txid), key_input.vout }));
    return .{ .ok = .{ .funding = funding, .deploy = d, .continuation = cont, .key_input = key_input } };
}

/// The one BEEF the validator gets for a deploy: the deploy's BEEF as
/// received (the funding and the token inputs' source transactions with it),
/// with the funding transaction's own BEEF merged in first when the deploy's
/// does not carry it; V2, parents first, the deploy last (its subject).
pub fn deployBeef(a: Allocator, f: Given, d: Given) ![]u8 {
    const db = d.beef orelse return error.NotABeef;
    var entries: std.ArrayList(beef.Entry) = .empty;
    var bumps: std.ArrayList(w.merkle.MerklePath) = .empty;
    const carried = if (db.find(f.txid)) |e| e.raw != null else false;
    if (!carried) {
        if (f.beef) |fb| {
            const keep = try ancestry(a, fb, f.txid);
            try bumps.appendSlice(a, fb.bumps);
            for (fb.entries, keep) |e, k| if (k) try entries.append(a, e);
        } else try entries.append(a, .{ .txid = f.txid, .format = .raw, .raw = f.raw, .tx = f.tx });
    }
    const off = bumps.items.len;
    try bumps.appendSlice(a, db.bumps);
    var subject: ?beef.Entry = null;
    for (db.entries) |e| {
        if (eql(u8, &e.txid, &d.txid)) {
            subject = e;
            continue;
        }
        const dup = for (entries.items) |x| {
            if (eql(u8, &x.txid, &e.txid)) break true;
        } else false;
        if (dup) continue;
        var x = e;
        if (x.bump) |b| x.bump = b + off;
        try entries.append(a, x);
    }
    try entries.append(a, subject orelse .{ .txid = d.txid, .format = .raw, .raw = d.raw, .tx = d.tx });
    return beef.serialize(a, .{ .version = beef.V2, .bumps = bumps.items, .entries = entries.items });
}

/// The validator's deploy request body: `{tx: <the BEEF>, pool: 0}` (amm-validator README, "Protocol").
pub fn deployBody(a: Allocator, tx: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tx", .value = .{ .bytes = tx } },
        .{ .key = "pool", .value = .{ .uint = 0 } },
    }) };
}

// ---------------------------------------------------------------- the AddLiquidity (amm.liquidity/1)

/// An AddLiquidity's call to the pool, as Rúnar lays it out (amm-validator
/// unlock.zig): `_codePart, lpSig, validatorSig, nextLpPubKey,
/// nextValidatorPubKey, addBsv, addTokens, _changePKH, _changeAmount,
/// txPreimage, methodIndex`: pushes only.
pub const AddCall = struct {
    lp_sig: []const u8,
    validator_sig: brc162.Push,
    next_lp: []const u8,
    next_validator: []const u8,
    add_bsv: u64,
    add_tokens: u64,
    change_pkh: []const u8,
    change: u64,
};

pub const add_pushes = 1 + 6 + 4;

fn pushesOf(a: Allocator, script: []const u8) !?[]brc162.Push {
    var pushes: std.ArrayList(brc162.Push) = .empty;
    var pos: usize = 0;
    while (pos < script.len) {
        const p = brc162.readPush(script, pos) orelse return null;
        try pushes.append(a, p);
        pos = p.next;
    }
    return pushes.items;
}

pub fn parseAddCall(a: Allocator, script: []const u8) !?AddCall {
    const pushes = (try pushesOf(a, script)) orelse return null;
    if (pushes.len != add_pushes) return null;
    const arg = pushes[1..];
    return .{
        .lp_sig = arg[0].data,
        .validator_sig = arg[1],
        .next_lp = arg[2].data,
        .next_validator = arg[3].data,
        .add_bsv = numOf(arg[4]) orelse return null,
        .add_tokens = numOf(arg[5]) orelse return null,
        .change_pkh = arg[6].data,
        .change = numOf(arg[7]) orelse return null,
    };
}

fn isKey(k: []const u8) bool {
    return k.len == 33 and (k[0] == 2 or k[0] == 3);
}

/// An AddLiquidity the relay carries (docs/notes.md 2026-10-02, "Swap funding
/// and signing" applied to AddLiquidity): the LP's funding transaction (one
/// exact output: the sats added + the miner fee) and the add spending the
/// pool, the LP's token outputs and the funding output, the LP's slot and
/// inputs signed, the validator's slot empty. The validator signs last.
pub const AddPair = struct {
    funding: Given,
    /// The add as a BEEF (Atomic, V1, V2) whose subject it is.
    add: Given,
    pool: Outpoint,
    call: AddCall,
    /// The pool spent, holding `spent_sats`; its continuation (output 0).
    spent: pool.Pool,
    spent_sats: u64,
    continuation: pool.Pool,
};

pub const AddChecked = union(enum) { ok: AddPair, refused: Refusal };

fn refusedAdd(reason: []const u8, detail: ?[]const u8) AddChecked {
    return .{ .refused = .{ .reason = reason, .detail = detail } };
}

/// The output a BEEF carries (raw), or null.
fn beefOutput(a: Allocator, b: beef.Beef, txid: [32]u8, vout: u32) ?Transaction {
    const e = b.find(txid) orelse return null;
    const raw = e.raw orelse return null;
    const t = e.tx orelse (Transaction.parse(a, raw) catch return null);
    if (vout >= t.outputs.len) return null;
    return t;
}

/// What `checkAdd` needs of the instance besides the arguments: the held
/// transaction (`Env.heldFn`) for a pool source the add's BEEF does not carry.
pub const Held = struct {
    ctx: *anyopaque,
    fn_: ?*const fn (ctx: *anyopaque, a: Allocator, txid: [32]u8) anyerror!?[]const u8 = null,
};

/// Check an AddLiquidity before anything is written (`amm.liquidity.submit`'s
/// first step), as pool/Pool.runar.go's `AddLiquidity` writes it: input 0
/// spends `pool` with an AddLiquidity call (method index 1) whose LP slot is
/// signed (present) and validator slot `OP_0`; another input spends the
/// funding transaction; every other input of both signed (present); the
/// LP's other inputs' parents in the add's BEEF; the pool spent (from the
/// BEEF, else held) is a pool naming `validator`; output 0 its continuation:
/// the same code and readonly fields, the BSV reserve increased by addBsv,
/// TokenReserve by addTokens, LpPubKey the call's nextLpPubKey,
/// ValidatorPubKey the call's nextValidatorPubKey, which is the identity's
/// anyone-child for the pool outpoint (the validator's convention); then
/// Rúnar's change output only when `_changeAmount > 0`, nothing else. No fee
/// and no commission: the contract has none on AddLiquidity.
pub fn checkAdd(a: Allocator, funding_bytes: []const u8, add_bytes: []const u8, pool_text: []const u8, validator: []const u8, expires: u64, now: u64, held: Held) !AddChecked {
    if (validator.len != 33 or (validator[0] != 2 and validator[0] != 3)) return refusedAdd("bad_validator", "an identity key: 33 bytes, compressed");
    if (expires <= now) return refusedAdd("expired", null);
    const funding = given(a, funding_bytes) orelse return refusedAdd("bad_funding", "not a transaction, or a BEEF whose subject is one");
    const add = given(a, add_bytes) orelse return refusedAdd("bad_add", "not a BEEF whose subject is a transaction");
    const ab = add.beef orelse return refusedAdd("bad_add", "the add is a BEEF carrying the funding and the token inputs' source transactions");
    const tx = add.tx;
    const op = Outpoint.parse(pool_text) orelse return refusedAdd("bad_pool", "want <txid>_<vout>");

    // The add spends the pool (input 0) and an output of the funding transaction.
    if (tx.inputs.len < 2) return refusedAdd("bad_add", "an add has the pool and the funding as inputs");
    const p0 = tx.inputs[0].previous_outpoint;
    if (p0.index != op.vout or !eql(u8, &p0.txid.bytes, &op.txid)) return refusedAdd("pool_not_input_0", null);
    const spends_funding = for (tx.inputs[1..]) |in| {
        if (eql(u8, &in.previous_outpoint.txid.bytes, &funding.txid) and in.previous_outpoint.index < funding.tx.outputs.len) break true;
    } else false;
    if (!spends_funding) return refusedAdd("funding_not_spent", null);

    // Complete: every funding input and every add input but the pool's carries its unlocking script.
    for (funding.tx.inputs, 0..) |in, i| if (in.unlocking_script.bytes.len == 0) return refusedAdd("funding_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));
    for (tx.inputs[1..], 1..) |in, i| if (in.unlocking_script.bytes.len == 0) return refusedAdd("add_unsigned", try std.fmt.allocPrint(a, "input {d}", .{i}));

    // The pool call: AddLiquidity, laid out as Rúnar calls it, the LP's slot signed, the validator's empty.
    const unlocking = tx.inputs[0].unlocking_script.bytes;
    if (pool.methodOf(unlocking) != .add_liquidity) return refusedAdd("not_add_liquidity", null);
    const call = (try parseAddCall(a, unlocking)) orelse return refusedAdd("bad_call", "not a Rúnar call of AddLiquidity");
    if (call.validator_sig.op != brc162.OP_0) return refusedAdd("signature_slot_not_empty", null);
    if (call.lp_sig.len == 0) return refusedAdd("lp_unsigned", "the LP's slot in the pool call is empty");
    if (!isKey(call.next_lp)) return refusedAdd("bad_call", "nextLpPubKey");
    if (!isKey(call.next_validator)) return refusedAdd("bad_call", "nextValidatorPubKey");
    if (call.add_bsv + call.add_tokens == 0) return refusedAdd("bad_call", "addBsv + addTokens is 0");
    if (call.change > 0 and call.change_pkh.len != 20) return refusedAdd("bad_call", "_changePKH");

    // The LP's other inputs: each parent in the add's BEEF (the funding may come on its own).
    for (tx.inputs[1..], 1..) |in, i| {
        const pop = in.previous_outpoint;
        if (eql(u8, &pop.txid.bytes, &funding.txid)) continue;
        const e = ab.find(pop.txid.bytes) orelse return refusedAdd("missing_parent", try std.fmt.allocPrint(a, "input {d}: {s} is not in the add's BEEF", .{ i, &w.header.toHex(pop.txid.bytes) }));
        if (e.raw == null) return refusedAdd("missing_parent", try std.fmt.allocPrint(a, "input {d}: {s} is in the add's BEEF by txid only", .{ i, &w.header.toHex(pop.txid.bytes) }));
        if (beefOutput(a, ab, pop.txid.bytes, pop.index) == null) return refusedAdd("missing_parent", try std.fmt.allocPrint(a, "input {d}: no output {d} in its source", .{ i, pop.index }));
    }

    // The pool spent: its source from the BEEF, else held here.
    const src_tx: Transaction = beefOutput(a, ab, op.txid, op.vout) orelse blk: {
        const f = held.fn_ orelse break :blk null;
        const raw = (try f(held.ctx, a, op.txid)) orelse break :blk null;
        const t = Transaction.parse(a, raw) catch break :blk null;
        break :blk if (op.vout < t.outputs.len) t else null;
    } orelse return refusedAdd("missing_parent", "input 0: the pool's source transaction is neither in the add's BEEF nor held here");
    const spent_out = src_tx.outputs[op.vout];
    const spent = switch (poolAt(spent_out.locking_script.bytes)) {
        .pool => |p| p,
        .none => return refusedAdd("not_a_pool", "input 0 does not spend a pool"),
        .bad => |why| return refusedAdd("not_a_pool", try std.fmt.allocPrint(a, "input 0: {s}", .{why})),
    };
    if (!eql(u8, &spent.identity, validator)) return refusedAdd("wrong_validator", "the pool's ValidatorIdentity is another");
    const spent_sats: u64 = @intCast(spent_out.satoshis);

    // The next validator key: the identity's child for the pool outpoint (checked again by the validator).
    const want = try pool.validatorKey(a, validator[0..33].*, op.txid, op.vout);
    if (!eql(u8, &want, call.next_validator)) return refusedAdd("wrong_validator_key", try std.fmt.allocPrint(a, "nextValidatorPubKey is not the identity's child for {s}", .{pool_text}));

    // The outputs, as the contract writes them.
    if (tx.outputs.len == 0) return refusedAdd("bad_outputs", "no continuation");
    const cont = switch (poolAt(tx.outputs[0].locking_script.bytes)) {
        .pool => |p| p,
        .none => return refusedAdd("bad_outputs", "output 0 is not a pool"),
        .bad => |why| return refusedAdd("bad_outputs", try std.fmt.allocPrint(a, "output 0: {s}", .{why})),
    };
    const code = struct {
        fn of(script: []const u8) []const u8 {
            const tok = brc162.decode(script).?;
            return tok.lock[0 .. tok.lock.len - 1 - pool.state_len];
        }
    }.of;
    if (!eql(u8, code(tx.outputs[0].locking_script.bytes), code(spent_out.locking_script.bytes))) return refusedAdd("bad_outputs", "the continuation's code is not the pool's");
    if (!eql(u8, &cont.asset_id, &spent.asset_id) or !eql(u8, &cont.identity, &spent.identity) or cont.lp_fee_bps != spent.lp_fee_bps or
        cont.validator_fee_bps != spent.validator_fee_bps or cont.commission_bps != spent.commission_bps)
        return refusedAdd("bad_outputs", "the continuation's readonly fields");
    if (tx.outputs[0].satoshis != spent_sats + call.add_bsv) return refusedAdd("bad_outputs", "the continuation's BSV reserve is not the pool's + addBsv");
    if (cont.token_reserve != spent.token_reserve + call.add_tokens) return refusedAdd("bad_outputs", "the continuation's TokenReserve is not the pool's + addTokens");
    if (!eql(u8, &cont.lp, call.next_lp)) return refusedAdd("bad_outputs", "the continuation's LpPubKey is not nextLpPubKey");
    if (!eql(u8, &cont.validator, call.next_validator)) return refusedAdd("bad_outputs", "the continuation's ValidatorPubKey is not nextValidatorPubKey");
    var at: usize = 1;
    if (call.change > 0) {
        if (at >= tx.outputs.len) return refusedAdd("bad_outputs", "no change output");
        const o = tx.outputs[at];
        const pkh = p2pkhHash(o.locking_script.bytes) orelse return refusedAdd("bad_outputs", "the change output is not P2PKH");
        if (!eql(u8, pkh, call.change_pkh) or o.satoshis != call.change) return refusedAdd("bad_outputs", "the change output is not the call's");
        at += 1;
    }
    if (tx.outputs.len != at) return refusedAdd("bad_outputs", "outputs past the contract's");
    return .{ .ok = .{ .funding = funding, .add = add, .pool = op, .call = call, .spent = spent, .spent_sats = spent_sats, .continuation = cont } };
}

/// Whether `signed` is the add `raw` with the validator's signature in its
/// slot: every byte as the LP sent it but the pool call's validatorSig push,
/// which is filled.
pub fn signedAdd(a: Allocator, raw: []const u8, signed: []const u8) !bool {
    const t = Transaction.parse(a, raw) catch return false;
    const s = Transaction.parse(a, signed) catch return false;
    if (s.serializedLen() != signed.len or t.inputs.len != s.inputs.len or t.inputs.len == 0) return false;
    const tp = (try pushesOf(a, t.inputs[0].unlocking_script.bytes)) orelse return false;
    const sp = (try pushesOf(a, s.inputs[0].unlocking_script.bytes)) orelse return false;
    if (tp.len != add_pushes or sp.len != add_pushes or sp[2].data.len == 0) return false;
    for (tp, sp, 0..) |x, y, i| if (i != 2 and !(x.op == y.op and eql(u8, x.data, y.data))) return false;
    // The rest, byte for byte: the transaction with input 0's unlocking script as the add's.
    const ins = try a.dupe(w.bsvz.transaction.Input, s.inputs);
    ins[0].unlocking_script = t.inputs[0].unlocking_script;
    var bare = s;
    bare.inputs = ins;
    return eql(u8, try bare.serialize(a), raw);
}

/// The id of an add record: sha256 of the add's raw bytes (the BEEF's subject, the validator's slot empty), or null when it is no BEEF of one.
pub fn addId(a: Allocator, add: []const u8) ?[32]u8 {
    return deployId(a, add);
}

/// amm.liquidity.submit `{funding, add, pool, validator, peerId, expires}` (the args
/// already checked against the declared shape): the record, or why not. As
/// `submit`: check first, write last; the same add again answers its record;
/// one that timed out or failed in transport is relayed again.
pub fn submitAdd(a: Allocator, env: Env, args: Value) !Submitted {
    const funding = args.getBytes("funding") orelse return .{ .refused = .{ .reason = "bad_funding" } };
    const add = args.getBytes("add") orelse return .{ .refused = .{ .reason = "bad_add" } };
    const pool_text = args.getText("pool") orelse return .{ .refused = .{ .reason = "bad_pool" } };
    const validator = args.getBytes("validator") orelse return .{ .refused = .{ .reason = "bad_validator" } };
    const expires = args.getUint("expires") orelse return .{ .refused = .{ .reason = "expired" } };
    const id = addId(a, add) orelse return .{ .refused = .{ .reason = "bad_add", .detail = "not a BEEF whose subject is a transaction" } };
    if (try env.book.getKind(a, .liquidity, id)) |rec| {
        if (rec.status == .pending) return .{ .pending = rec };
        if (!rec.status.retryable()) return .{ .settled = rec };
    }
    switch (try checkAdd(a, funding, add, pool_text, validator, expires, env.now, .{ .ctx = env.ctx, .fn_ = env.heldFn })) {
        .refused => |r| return .{ .refused = r },
        .ok => {},
    }
    const peer = peerArg(args) orelse return .{ .refused = .{ .reason = "bad_peer", .detail = "peerId: the validator's libp2p peer ID, text" } };
    var rec: Record = .{
        .kind = .liquidity,
        .id = id,
        .funding = funding,
        .swap = add,
        .pool = pool_text,
        .validator = validator[0..33].*,
        .expires = expires,
        .created = env.now,
        .updated = env.now,
        .peer = peer,
        .local = isSelf(env, peer),
        .request = env.request,
    };
    rec.thread = try env.launchFn(env.ctx, a, .liquidity, id);
    try env.book.put(a, rec);
    return .{ .launched = rec };
}

// ---------------------------------------------------------------- the record

pub const Status = enum {
    pending,
    accepted,
    refused,
    timeout,
    failed,

    pub fn parse(s: []const u8) ?Status {
        inline for (.{ Status.pending, Status.accepted, Status.refused, Status.timeout, Status.failed }) |x| if (eql(u8, s, @tagName(x))) return x;
        return null;
    }
    /// A record in this state may be submitted again (the relay never reached the validator's answer).
    pub fn retryable(s: Status) bool {
        return s == .timeout or s == .failed;
    }
};

pub const Request = struct { message: []const u8, sender: []const u8 };

pub const Record = struct {
    kind: Kind = .swap,
    id: [32]u8,
    status: Status = .pending,
    funding: []const u8,
    /// What is relayed: the raw swap, or (a pool record) the deploy's BEEF as received, or (an add) the add's BEEF.
    swap: []const u8,
    /// The pool: the outpoint spent (a swap, an add), or the deploy's `<txid>_0` (a pool record).
    pool: []const u8,
    validator: [33]u8,
    expires: u64,
    created: u64,
    updated: u64,
    /// The validator's peer ID (base58), as the caller named it (`peerId`).
    peer: ?[]const u8 = null,
    /// The peer is this node: the validator is this instance's own program, called in-VM.
    local: bool = false,
    /// The dial message whose answers the relay thread awaits, and the stream once open.
    dial: ?[]const u8 = null,
    stream: ?u64 = null,
    /// The relay thread (its origin), what a waiting `/call` request awaits.
    thread: ?[]const u8 = null,
    /// A message caller: answered by the relay thread when the record settles.
    request: ?Request = null,
    tx: ?[]const u8 = null,
    txid: ?[]const u8 = null,
    reason: ?[]const u8 = null,
    detail: ?[]const u8 = null,
    pool_state: ?Value = null,

    fn put(es: *std.ArrayList(cbor.Entry), a: Allocator, k: []const u8, v: Value) !void {
        try es.append(a, .{ .key = k, .value = v });
    }

    /// What the caller is answered: the record without the relay's own fields.
    pub fn answer(r: Record, a: Allocator) !Value {
        var es: std.ArrayList(cbor.Entry) = .empty;
        try put(&es, a, "id", .{ .text = try a.dupe(u8, &idText(r.id)) });
        try put(&es, a, "status", .{ .text = @tagName(r.status) });
        try put(&es, a, "funding", .{ .bytes = r.funding });
        try put(&es, a, r.kind.subjectKey(), .{ .bytes = r.swap });
        try put(&es, a, "pool", .{ .text = r.pool });
        try put(&es, a, "validator", .{ .bytes = try a.dupe(u8, &r.validator) });
        try put(&es, a, "expires", .{ .uint = r.expires });
        try put(&es, a, "created", .{ .uint = r.created });
        try put(&es, a, "updated", .{ .uint = r.updated });
        if (r.tx) |x| try put(&es, a, "tx", .{ .bytes = x });
        if (r.txid) |x| try put(&es, a, "txid", .{ .text = x });
        if (r.reason) |x| try put(&es, a, "reason", .{ .text = x });
        if (r.detail) |x| try put(&es, a, "detail", .{ .text = x });
        if (r.pool_state) |x| try put(&es, a, "poolState", x);
        return .{ .map = es.items };
    }

    /// The stored record: the answer plus the relay's own fields.
    pub fn value(r: Record, a: Allocator) !Value {
        const ans = try r.answer(a);
        var es: std.ArrayList(cbor.Entry) = .empty;
        try put(&es, a, "kind", .{ .text = r.kind.recordKind() });
        try es.appendSlice(a, ans.map);
        if (r.peer) |x| try put(&es, a, "peer", .{ .text = x });
        if (r.local) try put(&es, a, "local", .{ .boolean = true });
        if (r.dial) |x| try put(&es, a, "dial", .{ .cid = x });
        if (r.stream) |x| try put(&es, a, "stream", .{ .uint = x });
        if (r.thread) |x| try put(&es, a, "thread", .{ .cid = x });
        if (r.request) |q| try put(&es, a, "request", .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "message", .value = .{ .cid = q.message } },
            .{ .key = "sender", .value = .{ .bytes = q.sender } },
        }) });
        return .{ .map = es.items };
    }

    pub fn of(v: Value) !Record {
        const kind = Kind.ofRecord(v.getText("kind") orelse "") orelse return error.BadRecord;
        const val = v.getBytes("validator") orelse return error.BadRecord;
        if (val.len != 33) return error.BadRecord;
        var r: Record = .{
            .kind = kind,
            .id = idParse(v.getText("id") orelse return error.BadRecord) orelse return error.BadRecord,
            .status = Status.parse(v.getText("status") orelse "") orelse return error.BadRecord,
            .funding = v.getBytes("funding") orelse return error.BadRecord,
            .swap = v.getBytes(kind.subjectKey()) orelse return error.BadRecord,
            .pool = v.getText("pool") orelse return error.BadRecord,
            .validator = val[0..33].*,
            .expires = v.getUint("expires") orelse return error.BadRecord,
            .created = v.getUint("created") orelse return error.BadRecord,
            .updated = v.getUint("updated") orelse return error.BadRecord,
            .peer = v.getText("peer"),
            .local = v.getBool("local") orelse false,
            .dial = v.getCid("dial"),
            .stream = v.getUint("stream"),
            .thread = v.getCid("thread"),
            .tx = v.getBytes("tx"),
            .txid = v.getText("txid"),
            .reason = v.getText("reason"),
            .detail = v.getText("detail"),
            .pool_state = v.get("poolState"),
        };
        if (v.get("request")) |q| r.request = .{
            .message = q.getCid("message") orelse return error.BadRecord,
            .sender = q.getBytes("sender") orelse return error.BadRecord,
        };
        return r;
    }
};

/// The app's state: `{kind: "amm-app-state", swaps: <the MST of swap records
/// by id>, pools: <the MST of deploy records by id>, liquidity: <the MST of
/// AddLiquidity records by id>}`.
pub const Book = struct {
    s: w.store.Store,
    swaps: w.store.Map,
    pools: w.store.Map,
    liquidity: w.store.Map,

    pub fn load(a: Allocator, s: w.store.Store, saved: ?Value) !Book {
        const maps = try w.store.Maps.create(a, s);
        var swaps: ?[]const u8 = null;
        var pools: ?[]const u8 = null;
        var liquidity: ?[]const u8 = null;
        if (saved) |st| {
            if (!eql(u8, st.getText("kind") orelse "", state_kind)) return error.BadState;
            swaps = st.getCid("swaps");
            pools = st.getCid("pools");
            liquidity = st.getCid("liquidity");
        }
        return .{ .s = s, .swaps = maps.map(swaps), .pools = maps.map(pools), .liquidity = maps.map(liquidity) };
    }

    fn mapOf(b: *Book, kind: Kind) *w.store.Map {
        return switch (kind) {
            .swap => &b.swaps,
            .pool => &b.pools,
            .liquidity => &b.liquidity,
        };
    }

    /// A swap's record.
    pub fn get(b: *Book, a: Allocator, id: [32]u8) !?Record {
        return b.getKind(a, .swap, id);
    }

    pub fn getKind(b: *Book, a: Allocator, kind: Kind, id: [32]u8) !?Record {
        const c = (try b.mapOf(kind).link(&id)) orelse return null;
        const r = try Record.of(try b.s.getValue(a, c));
        if (r.kind != kind) return error.BadRecord;
        return r;
    }

    pub fn put(b: *Book, a: Allocator, r: Record) !void {
        try b.mapOf(r.kind).putLink(&r.id, try b.s.putValue(a, try r.value(a)));
    }

    /// The state record to keep under the app's head (flushes the maps).
    pub fn state(b: *Book, a: Allocator) !Value {
        try b.swaps.flush();
        try b.pools.flush();
        try b.liquidity.flush();
        return .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = state_kind } },
            .{ .key = "swaps", .value = if (b.swaps.root) |r| .{ .cid = r } else .null },
            .{ .key = "pools", .value = if (b.pools.root) |r| .{ .cid = r } else .null },
            .{ .key = "liquidity", .value = if (b.liquidity.root) |r| .{ .cid = r } else .null },
        }) };
    }
};

// ---------------------------------------------------------------- the relay thread

/// What stepped the relay thread: its launch, an answer to its dial (the
/// libp2p provider's, libp2p.zig `dialAnswer`), or the deadline.
pub const Input = union(enum) {
    start,
    answer: libp2p.DialAnswer,
    woke,
};

pub const Effect = struct {
    /// Requests for the libp2p provider, in order.
    emits: []const libp2p.Request = &.{},
    /// The index in `emits` of a new dial (its message CID becomes `dial`).
    dial: ?usize = null,
    /// Rest again on the dial's answers until `expires` (local: on what the validator awaited).
    rest: bool = false,
    /// Local: call this instance's validator program in-VM now (main.zig `callValidator`).
    call: bool = false,
    /// The record settled: answer the caller.
    done: bool = false,
};

/// The validator's answer frame (amm-validator README, "Protocol"):
/// `{ok: true, tx, txid}` → accepted; `{ok: false, reason, detail?, txid?, pool?}` → refused.
/// A deploy's `{ok: true, txid}` (the deploy admitted in the validator's
/// overlay): accepted, `tx` the deploy itself and `txid` its txid, which the
/// answer's must equal (and its `tx`, if any, the deploy).
pub fn applyReply(a: Allocator, r: *Record, frame: []const u8) void {
    const v = cbor.decode(a, frame) catch return settle(r, .failed, "bad_reply", "the validator's answer is not dag-cbor");
    const ok = v.getBool("ok") orelse return settle(r, .failed, "bad_reply", "the validator's answer has no ok");
    if (ok) {
        r.status = .accepted;
        if (r.kind == .pool) {
            // Nobody signs a deploy but the LP: the transaction accepted is the deploy itself.
            const d = given(a, r.swap) orelse return settle(r, .failed, "bad_record", "the deploy does not parse");
            const txid = a.dupe(u8, &w.header.toHex(d.txid)) catch return settle(r, .failed, "bad_reply", "out of memory");
            if (v.getText("txid")) |t| if (!eql(u8, t, txid)) return settle(r, .failed, "bad_reply", "the validator's txid is not the deploy's");
            if (v.getBytes("tx")) |t| if (!eql(u8, t, d.raw)) return settle(r, .failed, "bad_reply", "the validator's transaction is not the deploy");
            r.tx = d.raw;
            r.txid = txid;
            return;
        }
        r.tx = v.getBytes("tx");
        r.txid = v.getText("txid");
        if (r.tx == null) return settle(r, .failed, "bad_reply", "accepted without the transaction");
        if (r.kind == .liquidity) {
            // The validator signs last: what it answers is the add as the LP sent it, its slot filled.
            const add = given(a, r.swap) orelse return settle(r, .failed, "bad_record", "the add does not parse");
            if (!(signedAdd(a, add.raw, r.tx.?) catch false)) return settle(r, .failed, "bad_reply", "the validator's transaction is not the add with its signature");
            const txid = a.dupe(u8, &w.header.toHex(beef.txidOf(r.tx.?))) catch return settle(r, .failed, "bad_reply", "out of memory");
            if (r.txid) |t| if (!eql(u8, t, txid)) return settle(r, .failed, "bad_reply", "the validator's txid is not its transaction's");
            r.txid = txid;
        }
        return;
    }
    r.status = .refused;
    r.reason = v.getText("reason") orelse "refused";
    r.detail = v.getText("detail");
    r.txid = v.getText("txid");
    r.pool_state = v.get("pool");
}

fn settle(r: *Record, s: Status, reason: []const u8, detail: ?[]const u8) void {
    r.status = s;
    r.reason = reason;
    r.detail = detail;
}

/// One step of the relay thread over the record (the caller saves it, emits
/// `emits` to the libp2p provider, sets `dial` from the dial's message, and
/// rests or answers). `package` is the frame to send once the stream is open.
pub fn advance(a: Allocator, r: *Record, in: Input, now: u64, pkg: ?[]const u8) !Effect {
    if (r.status != .pending) return .{ .done = true };
    r.updated = now;
    var emits: std.ArrayList(libp2p.Request) = .empty;
    switch (in) {
        .start => {
            if (now >= r.expires) {
                settle(r, .timeout, "expired", "before the validator was dialled");
                return .{ .done = true };
            }
            try emits.append(a, try libp2p.dial(a, r.peer orelse return error.NoPeer, r.kind.protocol()));
            r.stream = null;
            return .{ .emits = emits.items, .dial = 0, .rest = true };
        },
        .answer => |ans| switch (ans) {
            .opened => |sid| {
                r.stream = sid;
                if (now >= r.expires) {
                    settle(r, .timeout, "expired", "before the request was sent");
                    try emits.append(a, try libp2p.close(a, sid));
                    return .{ .emits = emits.items, .done = true };
                }
                try emits.append(a, try libp2p.send(a, sid, pkg orelse return error.NoPackage));
                return .{ .emits = emits.items, .rest = true };
            },
            .frame => |body| {
                applyReply(a, r, body);
                if (r.stream) |sid| try emits.append(a, try libp2p.close(a, sid));
                return .{ .emits = emits.items, .done = true };
            },
            .closed => |why| {
                settle(r, .failed, "unreachable", why);
                return .{ .done = true };
            },
        },
        .woke => {
            if (now < r.expires) return .{ .rest = true };
            settle(r, .timeout, "no_answer", "the validator did not answer before expires");
            if (r.stream) |sid| try emits.append(a, try libp2p.close(a, sid));
            return .{ .emits = emits.items, .done = true };
        },
    }
}

/// What stepped a local relay's thread: its launch, the engine's answer or the awaited thread at
/// rest (`again`: the validator called again with it), or the deadline.
pub const LocalInput = enum { start, again, woke };

/// One step of a relay to this instance's own validator (`local`): call it, rest, or time out.
pub fn advanceLocal(r: *Record, in: LocalInput, now: u64) Effect {
    if (r.status != .pending) return .{ .done = true };
    r.updated = now;
    switch (in) {
        .start => if (now >= r.expires) {
            settle(r, .timeout, "expired", "before the validator was called");
            return .{ .done = true };
        },
        .again => {},
        .woke => {
            if (now < r.expires) return .{ .rest = true };
            settle(r, .timeout, "no_answer", "the validator did not answer before expires");
            return .{ .done = true };
        },
    }
    return .{ .call = true };
}

/// The validator handler's answer to the relay's in-VM call (as the front door reads a frame's:
/// `{wait: true}`, or `{verdict, body}` whose `body` is the reply frame), or null when the call
/// failed (`why`).
pub fn localAnswer(a: Allocator, r: *Record, ans: ?Value, why: []const u8) Effect {
    const v = ans orelse {
        settle(r, .failed, "validator_failed", why);
        return .{ .done = true };
    };
    if (v.getBool("wait") orelse false) return .{ .rest = true };
    const body = v.getBytes("body") orelse {
        settle(r, .failed, "bad_reply", "the validator answered no body");
        return .{ .done = true };
    };
    applyReply(a, r, body);
    return .{ .done = true };
}

/// The answer message to a caller who sent `{fn, args}` in the app's box
/// (APPS.md §4): `{fn, request, replyTo, result}`.
pub fn answerMessage(a: Allocator, func: []const u8, message: []const u8, result: Value) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = .{ .cid = message } },
        .{ .key = "replyTo", .value = .{ .cid = message } },
        .{ .key = "result", .value = result },
    }) };
}

/// The same with `error: {code, message}`.
pub fn errorMessage(a: Allocator, func: []const u8, message: []const u8, code: []const u8, text: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = func } },
        .{ .key = "request", .value = .{ .cid = message } },
        .{ .key = "replyTo", .value = .{ .cid = message } },
        .{ .key = "error", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "code", .value = .{ .text = code } },
            .{ .key = "message", .value = .{ .text = text } },
        }) } },
    }) };
}

// ---------------------------------------------------------------- the functions

/// What `submit` needs of the instance (main.zig: the VM; the tests: memory).
pub const Env = struct {
    book: *Book,
    now: u64,
    commission: Commission,
    /// A message caller, answered by the relay thread when the record settles.
    request: ?Request = null,
    ctx: *anyopaque,
    /// This node's own peer ID (base58), or null when it is not known: a `peerId` equal to it is
    /// this instance's own validator (`local`).
    self_peer: ?[]const u8 = null,
    /// Launch the relay thread for the record `id` of `kind` → the thread (its origin's CID).
    launchFn: *const fn (ctx: *anyopaque, a: Allocator, kind: Kind, id: [32]u8) anyerror![]const u8,
    /// A transaction this instance holds (its overlay's), raw, or null: the
    /// spent pool's source when the add's BEEF does not carry it.
    heldFn: ?*const fn (ctx: *anyopaque, a: Allocator, txid: [32]u8) anyerror!?[]const u8 = null,
};

pub const Submitted = union(enum) {
    /// Recorded `pending` and the relay launched (the caller saves the book).
    launched: Record,
    /// Already pending: the relay thread under way (a route waits on it).
    pending: Record,
    /// Already settled: its record, as it stands.
    settled: Record,
    refused: Refusal,
};

/// amm.swap.submit `{funding, swap, pool, validator, peerId, expires}` (the args
/// already checked against the declared shape): the record, or why not.
/// Check first, write last: nothing is written for a refusal.
pub fn submit(a: Allocator, env: Env, args: Value) !Submitted {
    const funding = args.getBytes("funding") orelse return .{ .refused = .{ .reason = "bad_funding" } };
    const swap = args.getBytes("swap") orelse return .{ .refused = .{ .reason = "bad_swap" } };
    const pool_text = args.getText("pool") orelse return .{ .refused = .{ .reason = "bad_pool" } };
    const validator = args.getBytes("validator") orelse return .{ .refused = .{ .reason = "bad_validator" } };
    const expires = args.getUint("expires") orelse return .{ .refused = .{ .reason = "expired" } };
    const id = idOf(swap);
    if (try env.book.get(a, id)) |rec| {
        if (rec.status == .pending) return .{ .pending = rec };
        if (!rec.status.retryable()) return .{ .settled = rec };
    }
    switch (try checkPair(a, funding, swap, pool_text, validator, expires, env.now, env.commission)) {
        .refused => |r| return .{ .refused = r },
        .ok => {},
    }
    const peer = peerArg(args) orelse return .{ .refused = .{ .reason = "bad_peer", .detail = "peerId: the validator's libp2p peer ID, text" } };
    var rec: Record = .{
        .id = id,
        .funding = funding,
        .swap = swap,
        .pool = pool_text,
        .validator = validator[0..33].*,
        .expires = expires,
        .created = env.now,
        .updated = env.now,
        .peer = peer,
        .local = isSelf(env, peer),
        .request = env.request,
    };
    rec.thread = try env.launchFn(env.ctx, a, .swap, id);
    try env.book.put(a, rec);
    return .{ .launched = rec };
}

/// The id of a deploy record: sha256 of the deploy's raw bytes (the BEEF's subject), or null when it is no BEEF of one.
pub fn deployId(a: Allocator, deploy: []const u8) ?[32]u8 {
    const d = given(a, deploy) orelse return null;
    if (d.beef == null) return null;
    return idOf(d.raw);
}

/// amm.pool.submit `{funding, deploy, validator, peerId, expires}` (the args already
/// checked against the declared shape): the record, or why not. As
/// `submit`: check first, write last; the same deploy again answers its
/// record; one that timed out or failed in transport is relayed again.
pub fn submitDeploy(a: Allocator, env: Env, args: Value) !Submitted {
    const funding = args.getBytes("funding") orelse return .{ .refused = .{ .reason = "bad_funding" } };
    const deploy = args.getBytes("deploy") orelse return .{ .refused = .{ .reason = "bad_deploy" } };
    const validator = args.getBytes("validator") orelse return .{ .refused = .{ .reason = "bad_validator" } };
    const expires = args.getUint("expires") orelse return .{ .refused = .{ .reason = "expired" } };
    const id = deployId(a, deploy) orelse return .{ .refused = .{ .reason = "bad_deploy", .detail = "not a BEEF whose subject is a transaction" } };
    if (try env.book.getKind(a, .pool, id)) |rec| {
        if (rec.status == .pending) return .{ .pending = rec };
        if (!rec.status.retryable()) return .{ .settled = rec };
    }
    const pair = switch (try checkDeploy(a, funding, deploy, validator, expires, env.now)) {
        .refused => |r| return .{ .refused = r },
        .ok => |p| p,
    };
    const peer = peerArg(args) orelse return .{ .refused = .{ .reason = "bad_peer", .detail = "peerId: the validator's libp2p peer ID, text" } };
    var rec: Record = .{
        .kind = .pool,
        .id = id,
        .funding = funding,
        .swap = deploy,
        .pool = try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(pair.deploy.txid)}),
        .validator = validator[0..33].*,
        .expires = expires,
        .created = env.now,
        .updated = env.now,
        .peer = peer,
        .local = isSelf(env, peer),
        .request = env.request,
    };
    rec.thread = try env.launchFn(env.ctx, a, .pool, id);
    try env.book.put(a, rec);
    return .{ .launched = rec };
}

/// The validator's peer ID as the caller named it (`peerId`, base58 text), or null.
pub fn peerArg(args: Value) ?[]const u8 {
    const p = args.getText("peerId") orelse return null;
    if (p.len == 0 or p.len > 128) return null;
    for (p) |c| if (c <= ' ' or c == '/') return null;
    return p;
}

/// Whether `peer` is this node (the relay hands the request to its own validator program).
pub fn isSelf(env: Env, peer: []const u8) bool {
    const me = env.self_peer orelse return false;
    return eql(u8, me, peer);
}

pub const Found = union(enum) { found: Record, not_found, bad_id };

/// amm.swap.status `{id}`: the record, or null (`not_found`).
pub fn status(a: Allocator, book: *Book, args: Value) !Found {
    return statusOf(a, book, .swap, args);
}

/// amm.swap.status / amm.pool.status / amm.liquidity.status `{id}`: the record of that kind, or null (`not_found`).
pub fn statusOf(a: Allocator, book: *Book, kind: Kind, args: Value) !Found {
    const id = idParse(args.getText("id") orelse "") orelse return .bad_id;
    return if (try book.getKind(a, kind, id)) |r| .{ .found = r } else .not_found;
}

/// A refusal as the function's error message: `<reason>[: <detail>]`.
pub fn refusalText(a: Allocator, r: Refusal) ![]const u8 {
    return if (r.detail) |d| std.fmt.allocPrint(a, "{s}: {s}", .{ r.reason, d }) else r.reason;
}
