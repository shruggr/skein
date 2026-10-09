//! The AMM pool liquidity index (`ls_amm`): unspent pool outputs that pass
//! the pool checks, maintained through skein-overlay's lookup hooks
//! (skein-overlay docs/OVERLAY.md, the `lookup` module), and its queries. One
//! service over every Mandala token topic the overlay serves (`config.overlay`
//! names it with no `topics` list, so it listens to every topic, declared or
//! registered with the engine; shruggr/skein#120: "AMM keeps only its lookup"):
//! the topic (`tm_mandala_<txid>_<vout>`, skein-mandala's topic manager) is the token's and
//! admits any output the BSV-21 rules allow; which of those outputs are pools
//! worth indexing is this service's judgement (decided 2026-10-01): `admitted`
//! runs `pool.check` and indexes only the pools that pass. Every map key
//! starts with the topic (`tp` = len ‖ topic), so the index is per token; a
//! query names its token (`tokenId`). See README.md for the map layout, the
//! query shapes and the assumptions (the liveness join).
//!
//! The listing (skein-amm 0.9.0, David Case 2026-10-09): a pool is listed only while both its
//! contract output and its claim output are unspent, and only if its deploy's claim verifies
//! (pool.zig `verifiedClaim`: the payload is the pool's named validator key's signature over the
//! pool output's script and the LP's first token input, that key is `validatorKey(validator
//! identity, first token input)`, and the claim is locked to it). Every query answers listed
//! pools only. The validator rescinds by spending the claim; the LP leaves by Close.
//!
//! The beat (skein-overlay 0.12.0, David Case 2026-10-09: beats are libp2p service discovery):
//! this service's beat body on `ls_amm-live` carries, per token, this skein's per-validator
//! totals of its listed pools, `{tokens: {<assetId>: {<validator identity hex>: {sats, tokens,
//! pools}}}}` (dag-cbor), re-declared by a hook whenever it changes (`Service.beat`). The page
//! combines the beats it holds, live validators only.
const std = @import("std");
const w = @import("chain");
const lookup = @import("lookup");
const pool = @import("pool");
const mandala = @import("mandala");

const brc162 = pool.brc162;
const bsv21 = pool.bsv21;
const names = mandala.name;
const cbor = w.cbor;
const Value = cbor.Value;
const Entry = cbor.Entry;
const Allocator = std.mem.Allocator;
const Service = lookup.Service;
const Chain = lookup.Chain;

/// The service's name (`config.overlay.lookups`).
pub const service_name = "ls_amm";

/// `pools`: the live (unspent) checked pools whose deploy carried a verified claim, each record
/// naming its claim. `spentPools`: the checked pools a spend consumed, kept so `rejected` can
/// give back exactly what was indexed (and checked) before, without re-judging it. `claims`:
/// the unspent verified claims (`tp ‖ claim outpoint → null`); a pool is listed while its claim
/// is here. `spentClaims`: the claims a spend consumed (the validator's rescind), for `rejected`.
/// `beat`: `body → <the last beat body's record>`, so a hook beats only when the body changes.
pub const maps = [_][]const u8{ "pools", "byValidator", "spentPools", "claims", "spentClaims", "beat" };

fn cat(a: Allocator, parts: []const []const u8) ![]u8 {
    return std.mem.concat(a, u8, parts);
}

/// The topic a query's token id names (skein-mandala's name.zig `tokenIdOfString`: `<txid>`,
/// `<txid>_<vout>` or `<txid>.<vout>`; the topic `tm_mandala_<txid>_<vout>` (BRC-207),
/// `tm_mandala_<txid>_0` for output 0 in any form).
pub fn topicOf(a: Allocator, token_id: []const u8) ![]const u8 {
    const id = names.tokenIdOfString(token_id) orelse return error.BadQuery;
    var buf: [names.max_topic_len]u8 = undefined;
    return a.dupe(u8, names.topicName(&buf, id));
}

/// The token a topic name carries, as the rules take it (skein-mandala's token.zig); null for
/// a topic that is not a token's (`tm_mandala`, `tm_demo`).
pub fn tokenIdOf(topic: []const u8) ?bsv21.TokenId {
    return mandala.token.tokenIdOf(topic);
}

/// The key prefix of a topic's entries: len ‖ topic (the engine's convention, skein-sdk `store.nameKey`).
fn topicPrefix(a: Allocator, topic: []const u8) ![]u8 {
    return w.store.nameKey(a, topic, &.{});
}

// ---------------------------------------------------------------- recognising a pool output

/// A pool output's fields, as pool.zig parses them, plus where it is. Not
/// the ValidatorPubKey: the overlay does not check it (the validator's own
/// convention) and nothing here is found by it.
pub const PoolFields = struct {
    txid: [32]u8,
    vout: u32,
    bsv_reserve: u64,
    token_reserve: u64,
    liquidity_fee_bps: i64,
    validation_fee_bps: i64,
    /// The relay's commission (Pool's CommissionBps): markets filter pools
    /// by the commission they offer.
    commission_bps: i64,
    lp: [33]u8,
    identity: [33]u8,
    /// The deploy's claim (its outpoint): what keeps the pool listed (0.9.0).
    claim: ?[36]u8 = null,
};

/// Whether output `vout`'s script is a pool: a BRC-162 value output whose
/// lock parses as the Pool template. Recognition only: whether it passes
/// the pool checks is `judge`'s.
pub fn poolAt(txid: [32]u8, vout: u32, script: []const u8, satoshis: u64) ?PoolFields {
    const tok = brc162.decode(script) orelse return null;
    if (tok.role != .value) return null;
    const p = (pool.parse(tok.lock) catch return null) orelse return null;
    return .{
        .txid = txid,
        .vout = vout,
        .bsv_reserve = satoshis,
        .token_reserve = p.token_reserve,
        .liquidity_fee_bps = p.lp_fee_bps,
        .validation_fee_bps = p.validator_fee_bps,
        .commission_bps = p.commission_bps,
        .lp = p.lp,
        .identity = p.identity,
    };
}

fn intValue(v: i64) Value {
    return if (v >= 0) .{ .uint = @intCast(v) } else .{ .nint = @intCast(-1 - v) };
}

/// The record stored under `pools`' value (its own CID, linked from the
/// map): every field pool.zig parses but the ValidatorPubKey, plus
/// `admittedAt` (see README —
/// always null: a lookup hook carries no wall-clock or block time).
fn recordValue(a: Allocator, pf: PoolFields) !Value {
    return .{ .map = try a.dupe(Entry, &.{
        .{ .key = "kind", .value = .{ .text = "amm-pool" } },
        .{ .key = "txid", .value = .{ .bytes = try a.dupe(u8, &pf.txid) } },
        .{ .key = "vout", .value = .{ .uint = pf.vout } },
        .{ .key = "bsvReserve", .value = .{ .uint = pf.bsv_reserve } },
        .{ .key = "tokenReserve", .value = .{ .uint = pf.token_reserve } },
        .{ .key = "liquidityFeeBps", .value = intValue(pf.liquidity_fee_bps) },
        .{ .key = "validationFeeBps", .value = intValue(pf.validation_fee_bps) },
        .{ .key = "commissionBps", .value = intValue(pf.commission_bps) },
        .{ .key = "lpPubKey", .value = .{ .bytes = try a.dupe(u8, &pf.lp) } },
        .{ .key = "validatorIdentityKey", .value = .{ .bytes = try a.dupe(u8, &pf.identity) } },
        .{ .key = "claim", .value = if (pf.claim) |c| .{ .bytes = try a.dupe(u8, &c) } else .null },
        .{ .key = "admittedAt", .value = .null },
    }) };
}

// ---------------------------------------------------------------- the pool checks (this service's judgement)

/// The pool checks (`pool.check`) on the hook's arguments:
/// the transaction's admitted outputs of this token (`outputs_to_admit`).
/// The checks read only those outputs, so the token's spent coins are not
/// read. Null when the pools in `tx` pass (or there are none); the
/// violation otherwise.
pub fn judge(a: Allocator, id: bsv21.TokenId, tx: lookup.Tx, outputs_to_admit: []const u32) !?pool.Violation {
    var j_outs: std.ArrayList(bsv21.Indexed) = .empty;
    for (outputs_to_admit) |vout| {
        if (vout >= tx.tx.outputs.len) return error.BadHook;
        const t = (try bsv21.tokenOf(a, id, tx.txid, vout, tx.tx.outputs[vout].locking_script.bytes)) orelse continue;
        try j_outs.append(a, .{ .index = vout, .token = t });
    }
    return pool.check(.{ .ok = true, .inputs = &.{}, .outputs = j_outs.items });
}

// ---------------------------------------------------------------- the maps

fn poolKey(a: Allocator, tp: []const u8, txid: [32]u8, vout: u32) ![]u8 {
    return cat(a, &.{ tp, &w.store.outpointKey(txid, vout) });
}

fn identityKey(a: Allocator, identity: []const u8, tp: []const u8, txid: [32]u8, vout: u32) ![]u8 {
    return cat(a, &.{ identity, tp, &w.store.outpointKey(txid, vout) });
}

fn identityOf(a: Allocator, svc: *Service, cid: []const u8) ![]const u8 {
    const rec = try svc.store.getValue(a, cid);
    const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
    if (identity.len != 33) return error.BadIndex;
    return identity;
}

/// Index a pool record (`cid`) as live at `key`.
fn linkPool(a: Allocator, svc: *Service, tp: []const u8, txid: [32]u8, vout: u32, cid: []const u8) !void {
    // A re-admission of the same outpoint (a dupe hook call): replace, not duplicate.
    _ = try removePool(a, svc, tp, txid, vout);
    try svc.map("pools").putLink(try poolKey(a, tp, txid, vout), cid);
    try svc.map("byValidator").add(try identityKey(a, try identityOf(a, svc, cid), tp, txid, vout));
}

fn putPool(a: Allocator, svc: *Service, tp: []const u8, pf: PoolFields) !void {
    try linkPool(a, svc, tp, pf.txid, pf.vout, try svc.store.putValue(a, try recordValue(a, pf)));
}

/// Drop a live pool; → its record's CID, when it was indexed.
fn removePool(a: Allocator, svc: *Service, tp: []const u8, txid: [32]u8, vout: u32) !?[]const u8 {
    const key = try poolKey(a, tp, txid, vout);
    const cid = (try svc.map("pools").link(key)) orelse return null;
    _ = try svc.map("pools").remove(key);
    _ = try svc.map("byValidator").remove(try identityKey(a, try identityOf(a, svc, cid), tp, txid, vout));
    return cid;
}

// ---------------------------------------------------------------- the claim and the listing (0.9.0)

fn claimKey(a: Allocator, tp: []const u8, claim: []const u8) ![]u8 {
    return cat(a, &.{ tp, claim });
}

/// Whether a pool record is listed: its claim is a live verified claim of this topic.
fn listed(a: Allocator, svc: *Service, tp: []const u8, rec: Value) !bool {
    const claim = rec.getBytes("claim") orelse return false;
    return svc.map("claims").has(try claimKey(a, tp, claim));
}

/// The claim a pool output at `vout` of `tx` carries forward: a continuation's is the pool it
/// spends (an input indexed in `pools`: `spent` runs after `admitted`, so it is still there);
/// a deploy's is its own verified claim (`pool.verifiedClaim`, the first token input the
/// topic's first retained coin, else input 0), recorded in `claims`. Null: not listed, ever.
fn claimFor(a: Allocator, svc: *Service, tp: []const u8, tx: lookup.Tx, vout: u32, outputs_to_admit: []const u32, coins_retained: []const u32) !?[36]u8 {
    for (tx.tx.inputs) |in| {
        const cid = (try svc.map("pools").link(try poolKey(a, tp, in.previous_outpoint.txid.bytes, in.previous_outpoint.index))) orelse continue;
        const c = (try svc.store.getValue(a, cid)).getBytes("claim") orelse return null;
        return if (c.len == 36) c[0..36].* else null;
    }
    if (tx.tx.inputs.len == 0) return null;
    var first: u32 = 0;
    if (coins_retained.len > 0) {
        first = coins_retained[0];
        for (coins_retained) |i| first = @min(first, i);
    }
    if (first >= tx.tx.inputs.len) return null;
    const o = tx.tx.outputs[vout];
    const tok = brc162.decode(o.locking_script.bytes) orelse return null;
    const p = (pool.parse(tok.lock) catch return null) orelse return null;
    const fi = tx.tx.inputs[first].previous_outpoint;
    const cv = (try pool.verifiedClaim(a, tx.tx.outputs, p, o.locking_script.bytes, fi.txid.bytes, fi.index)) orelse return null;
    if (std.mem.indexOfScalar(u32, outputs_to_admit, cv) == null) return null; // the topic did not admit it
    const key = w.store.outpointKey(tx.txid, cv);
    try svc.map("claims").add(try claimKey(a, tp, &key));
    return key;
}

// ---------------------------------------------------------------- hooks (#50)

/// A topic admitted `tx`: when its pools pass the pool checks (`judge`),
/// index every admitted output that is a pool and carries a claim (`claimFor`: a deploy's own,
/// verified; a continuation's from the pool it spends). A pool that fails, or a deploy with no
/// verified claim, is not indexed (and so not searchable); it stays a valid token output in the
/// topic. Then the beat, when the listed totals changed.
pub fn admitted(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx, outputs_to_admit: []const u32, coins_retained: []const u32) anyerror!void {
    const id = tokenIdOf(topic) orelse return; // not a token topic: nothing of ours
    if (outputs_to_admit.len == 0) return;
    if (try judge(a, id, tx, outputs_to_admit) != null) return;
    const tp = try topicPrefix(a, topic);
    for (outputs_to_admit) |vout| {
        if (vout >= tx.tx.outputs.len) continue;
        const o = tx.tx.outputs[vout];
        var pf = poolAt(tx.txid, vout, o.locking_script.bytes, @intCast(o.satoshis)) orelse continue;
        pf.claim = (try claimFor(a, svc, tp, tx, vout, outputs_to_admit, coins_retained)) orelse continue;
        try putPool(a, svc, tp, pf);
    }
    try beatIfChanged(a, svc);
}

/// A previous coin was consumed: if it was a pool we indexed, it leaves
/// `pools` for `spentPools` (where `rejected` finds it). Its continuation
/// (if the spend admits one) arrives through its own `admitted` call —
/// skein does not fold the two (docs/OVERLAY.md, "The lookup contract").
/// If it was a claim (the validator's rescind), it leaves `claims` for `spentClaims`: every
/// pool of that deploy is unlisted from then on.
pub fn spent(a: Allocator, svc: *Service, topic: []const u8, outpoint: lookup.Outpoint, _: lookup.Tx) anyerror!void {
    const tp = try topicPrefix(a, topic);
    if (try removePool(a, svc, tp, outpoint.txid, outpoint.vout)) |cid|
        try svc.map("spentPools").putLink(try poolKey(a, tp, outpoint.txid, outpoint.vout), cid);
    const ck = try poolKey(a, tp, outpoint.txid, outpoint.vout);
    if (try svc.map("claims").remove(ck)) try svc.map("spentClaims").add(ck);
    try beatIfChanged(a, svc);
}

/// A judgement of `topic` was removed by a rejection: `tx`'s own pools are
/// gone (live or spent), and the checked pools `tx` had spent are live
/// again. Skein calls only `rejected(topic, tx)` (docs/OVERLAY.md,
/// "Settlement: `admits` propagates") — it does not re-call `admitted` for
/// the coins a rejection gives back — so they come back from `spentPools`,
/// as indexed (and checked) when first admitted. Likewise its own claims go, and the claims
/// it had spent (a rejected rescind) are live again.
pub fn rejected(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx) anyerror!void {
    const tp = try topicPrefix(a, topic);
    for (0..tx.tx.outputs.len) |vout| {
        _ = try removePool(a, svc, tp, tx.txid, @intCast(vout));
        const key = try poolKey(a, tp, tx.txid, @intCast(vout));
        _ = try svc.map("spentPools").remove(key);
        _ = try svc.map("claims").remove(key);
        _ = try svc.map("spentClaims").remove(key);
    }
    for (tx.tx.inputs) |in| {
        const txid = in.previous_outpoint.txid.bytes;
        const vout = in.previous_outpoint.index;
        const key = try poolKey(a, tp, txid, vout);
        if (try svc.map("spentClaims").remove(key)) try svc.map("claims").add(key);
        const cid = (try svc.map("spentPools").link(key)) orelse continue;
        _ = try svc.map("spentPools").remove(key);
        try linkPool(a, svc, tp, txid, vout, cid);
    }
    try beatIfChanged(a, svc);
}

// ---------------------------------------------------------------- the beat (0.12.0)

/// One validator's listed pools of one token, summed.
pub const Totals = struct { sats: u64 = 0, tokens: u64 = 0, pools: u64 = 0 };

/// The beat body over the listed pools: dag-cbor `{tokens: {<assetId `<txid>_<vout>`>:
/// {<validator identity, hex>: {sats, tokens, pools}}}}`, every listed pool of every token this
/// skein serves, per validator. Its record (`beatRecord`) is what `beat` keeps.
pub fn beatValue(a: Allocator, svc: *Service) !Value {
    var tokens: std.ArrayList(Entry) = .empty;
    var cur_tp: ?[]const u8 = null;
    var vals: std.StringArrayHashMapUnmanaged(Totals) = .empty;
    const flush = struct {
        fn f(al: Allocator, out: *std.ArrayList(Entry), tp: []const u8, vs: *std.StringArrayHashMapUnmanaged(Totals)) !void {
            if (vs.count() == 0) return;
            const topic = tp[1..];
            const id = tokenIdOf(topic) orelse return;
            const es = try al.alloc(Entry, vs.count());
            for (vs.keys(), vs.values(), es) |k, t, *e| e.* = .{ .key = k, .value = .{ .map = try al.dupe(Entry, &.{
                .{ .key = "sats", .value = .{ .uint = t.sats } },
                .{ .key = "tokens", .value = .{ .uint = t.tokens } },
                .{ .key = "pools", .value = .{ .uint = t.pools } },
            }) } };
            try out.append(al, .{ .key = try std.fmt.allocPrint(al, "{s}_{d}", .{ &w.header.toHex(id.txid), id.vout }), .value = .{ .map = es } });
            vs.clearRetainingCapacity();
        }
    }.f;
    for (try svc.map("pools").prefixed(&.{})) |kv| {
        if (kv.key.len < 1 + 36 or kv.value != .cid) continue;
        const tp = kv.key[0 .. 1 + @as(usize, kv.key[0])];
        if (cur_tp == null or !std.mem.eql(u8, cur_tp.?, tp)) {
            if (cur_tp) |c| try flush(a, &tokens, c, &vals);
            cur_tp = tp;
        }
        const rec = try svc.store.getValue(a, kv.value.cid);
        if (!try listed(a, svc, tp, rec)) continue;
        const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
        const gop = try vals.getOrPut(a, try hexOf(a, identity));
        if (!gop.found_existing) gop.value_ptr.* = .{};
        gop.value_ptr.sats += rec.getUint("bsvReserve") orelse 0;
        gop.value_ptr.tokens += rec.getUint("tokenReserve") orelse 0;
        gop.value_ptr.pools += 1;
    }
    if (cur_tp) |c| try flush(a, &tokens, c, &vals);
    return .{ .map = try a.dupe(Entry, &.{.{ .key = "tokens", .value = .{ .map = tokens.items } }}) };
}

/// The beat body's bytes (dag-cbor), for fn "beat" at the beacon's declaration.
pub fn beat(a: Allocator, svc: *Service) anyerror![]const u8 {
    return cbor.encode(a, try beatValue(a, svc));
}

/// After a hook: when the body changed since the last beat, keep it (`beat` map) and hand it to
/// the engine (`Service.beat`, skein-overlay 0.12.0), which re-declares `ls_amm-live`'s beacon.
fn beatIfChanged(a: Allocator, svc: *Service) !void {
    const v = try beatValue(a, svc);
    const rec = try svc.store.putValue(a, v);
    if (try svc.map("beat").link("body")) |prev| if (std.mem.eql(u8, prev, rec)) return;
    try svc.map("beat").putLink("body", rec);
    if (comptime @hasDecl(Service, "beat")) try svc.beat(svc.name, try cbor.encode(a, v));
}

// ---------------------------------------------------------------- the liveness join (best effort; see README)

/// Where the liveness program's `{identityKey → {peerId, at}}` map lives,
/// if this service is wired to one (README, "Liveness join": the head name
/// and shape are an assumption — no liveness program exists yet). Set by
/// this program's own `main` (not by skein) before a `lookup` call; native
/// tests set and clear it directly.
pub const LiveJoin = struct { svc: *Service, map_name: []const u8 = "live" };
threadlocal var live_join: ?LiveJoin = null;

pub fn setLiveJoin(j: ?LiveJoin) void {
    live_join = j;
}

fn liveOf(identity: []const u8) !?u64 {
    const j = live_join orelse return null;
    // A kernel-level MST value (`Map.get`, wallet-zig's `MValue`: kernel-zig
    // src/cbor.zig), not wallet-zig's own richer `cbor.Value`
    // (store.getValue/putValue) — different field names (`.int`, not
    // `.uint`/`.nint`; `.string`, not `.text`) and no helper methods.
    const v = (try j.svc.map(j.map_name).get(identity)) orelse return null;
    if (v != .map) return null;
    const at = v.get("at") orelse return null;
    return if (at == .int and at.int >= 0) @intCast(at.int) else null;
}

// ---------------------------------------------------------------- rendering an answer

fn hexOf(a: Allocator, bytes: []const u8) ![]const u8 {
    const digits = "0123456789abcdef";
    const out = try a.alloc(u8, bytes.len * 2);
    for (bytes, 0..) |byte, i| {
        out[i * 2] = digits[byte >> 4];
        out[i * 2 + 1] = digits[byte & 0xf];
    }
    return out;
}

fn outpointStr(a: Allocator, txid: [32]u8, vout: u32) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}_{d}", .{ &w.header.toHex(txid), vout });
}

const ParsedOutpoint = struct { txid: [32]u8, vout: u32 };

fn parseOutpoint(text: []const u8) !ParsedOutpoint {
    const at = std.mem.indexOfScalar(u8, text, '_') orelse return error.BadQuery;
    return .{
        .txid = w.header.fromHex(text[0..at]) catch return error.BadQuery,
        .vout = std.fmt.parseInt(u32, text[at + 1 ..], 10) catch return error.BadQuery,
    };
}

/// The engine's PoolState shape (amm-poc-engine/web/engine/src/types.ts)
/// plus the outpoint string and the pool's commissionBps, from an indexed
/// record.
fn poolStateValue(a: Allocator, rec: Value, outpoint: []const u8) !Value {
    const identity = rec.getBytes("validatorIdentityKey") orelse return error.BadIndex;
    var es: std.ArrayList(Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "outpoint", .value = .{ .text = outpoint } },
        .{ .key = "bsvReserve", .value = rec.get("bsvReserve") orelse return error.BadIndex },
        .{ .key = "tokenReserve", .value = rec.get("tokenReserve") orelse return error.BadIndex },
        .{ .key = "liquidityFeeBps", .value = rec.get("liquidityFeeBps") orelse return error.BadIndex },
        .{ .key = "validationFeeBps", .value = rec.get("validationFeeBps") orelse return error.BadIndex },
        .{ .key = "commissionBps", .value = rec.get("commissionBps") orelse return error.BadIndex },
        .{ .key = "validatorIdentityKey", .value = .{ .text = try hexOf(a, identity) } },
    });
    if (try liveOf(identity)) |ls| try es.append(a, .{ .key = "lastSeen", .value = .{ .uint = ls } });
    return .{ .map = es.items };
}

fn poolsUnder(a: Allocator, svc: *Service, prefix: []const u8, key_off: usize) ![]Value {
    var out: std.ArrayList(Value) = .empty;
    for (try svc.map("pools").prefixed(prefix)) |kv| {
        if (kv.value != .cid) return error.BadIndex;
        const rec = try svc.store.getValue(a, kv.value.cid);
        if (!try listed(a, svc, prefix, rec)) continue;
        const op = try w.store.outpointOf(kv.key[key_off..]);
        try out.append(a, try poolStateValue(a, rec, try outpointStr(a, op.txid, op.vout)));
    }
    return out.items;
}

fn answerAll(a: Allocator, svc: *Service, tp: []const u8) !lookup.Answer {
    return .{ .freeform = .{ .array = try poolsUnder(a, svc, tp, tp.len) } };
}

/// `byValidator`'s values are membership-only (`.null`): resolve each hit
/// back through `pools` for the record.
fn poolsForValidator(a: Allocator, svc: *Service, tp: []const u8, prefix: []const u8) ![]Value {
    var out: std.ArrayList(Value) = .empty;
    for (try svc.map("byValidator").prefixed(prefix)) |kv| {
        const op = try w.store.outpointOf(kv.key[prefix.len..]);
        const cid = (try svc.map("pools").link(try poolKey(a, tp, op.txid, op.vout))) orelse continue;
        const rec = try svc.store.getValue(a, cid);
        if (!try listed(a, svc, tp, rec)) continue;
        try out.append(a, try poolStateValue(a, rec, try outpointStr(a, op.txid, op.vout)));
    }
    return out.items;
}

fn answerValidator(a: Allocator, svc: *Service, tp: []const u8, hex: []const u8) !lookup.Answer {
    if (hex.len == 0 or hex.len % 2 != 0) return error.BadQuery;
    const identity = try a.alloc(u8, hex.len / 2);
    _ = std.fmt.hexToBytes(identity, hex) catch return error.BadQuery;
    const prefix = try cat(a, &.{ identity, tp });
    return .{ .freeform = .{ .array = try poolsForValidator(a, svc, tp, prefix) } };
}

/// `{outpoint}`: that pool, or its newest continuation, found by following
/// the spends forward from any pool outpoint this service indexed — the
/// continuation is always output 0 of the spend (pool.check: a pool is
/// indexed at output 0). A hop is a checked pool a spend consumed
/// (`spentPools`, this topic's own record of it), and its spender is the
/// chain state's (`spentBy`: the first held spender not rejected).
/// `want_beef`: the `output-list` form (the BEEF a taker builds a spend
/// from), instead of the freeform `{current, hops}`.
fn answerOutpoint(a: Allocator, svc: *Service, ch: *Chain, tp: []const u8, start: ParsedOutpoint, want_beef: bool) !lookup.Answer {
    var txid = start.txid;
    var vout = start.vout;
    var hops: u64 = 0;
    var rec: ?Value = null;
    if (try svc.map("pools").link(try poolKey(a, tp, txid, vout))) |cid| rec = try svc.store.getValue(a, cid);
    // Follow the spends until a pools-map hit (an intermediate hop is spent
    // and was moved from `pools` to `spentPools` — only the tip is live,
    // README, "Index"). An outpoint in neither is not one of this topic's
    // pools; a spent pool whose spender did not recreate one (a pool closed)
    // ends the trail.
    while (rec == null) {
        if (!try svc.map("spentPools").has(try poolKey(a, tp, txid, vout))) return error.UnknownOutpoint;
        const sp = (try ch.spentBy(txid, vout)) orelse return error.UnknownOutpoint;
        txid = sp;
        vout = 0;
        hops += 1;
        if (try svc.map("pools").link(try poolKey(a, tp, txid, vout))) |cid| rec = try svc.store.getValue(a, cid);
    }
    // Listed only (0.9.0): a pool whose claim was spent (rescinded) or never verified is not answered.
    if (!try listed(a, svc, tp, rec.?)) return error.NotListed;
    if (want_beef) return .{ .output_list = try a.dupe(lookup.Output, &.{.{ .txid = txid, .vout = vout }}) };
    const current = try poolStateValue(a, rec.?, try outpointStr(a, txid, vout));
    return .{ .freeform = .{ .map = try a.dupe(Entry, &.{
        .{ .key = "current", .value = current },
        .{ .key = "hops", .value = .{ .uint = hops } },
    }) } };
}

/// `/lookup` (BRC-24, service `ls_amm`), every query naming its token
/// (`tokenId`, `<txid>_<vout>`): `{tokenId}` every live pool of the token;
/// `{tokenId, outpoint, beef?}` that pool (README, "Queries");
/// `{tokenId, validatorIdentityKey}` that validator's pools of the token.
pub fn answer(a: Allocator, svc: *Service, ch: *Chain, query: Value) anyerror!lookup.Answer {
    if (query != .map) return error.BadQuery;
    const topic = try topicOf(a, query.getText("tokenId") orelse return error.BadQuery);
    const tp = try topicPrefix(a, topic);
    if (query.getText("outpoint")) |text| {
        return answerOutpoint(a, svc, ch, tp, try parseOutpoint(text), query.getBool("beef") orelse false);
    }
    if (query.getText("validatorIdentityKey")) |hex| return answerValidator(a, svc, tp, hex);
    return answerAll(a, svc, tp);
}

/// The service: its maps, its index, the queries, the hooks, and (skein-overlay 0.12.0) its beat
/// body at the beacon's declaration — wired only where the engine's lookup module has it.
pub const spec: lookup.Spec = if (@hasField(lookup.Spec, "beat")) .{
    .maps = &maps,
    // Its index, whatever name it is served as (skein-overlay 0.11.0): the head `<app>/ls_amm`, as before.
    .index = service_name,
    .answer = answer,
    .admitted = admitted,
    .spent = spent,
    .rejected = rejected,
    .beat = beat,
} else .{
    .maps = &maps,
    .index = service_name,
    .answer = answer,
    .admitted = admitted,
    .spent = spent,
    .rejected = rejected,
};
