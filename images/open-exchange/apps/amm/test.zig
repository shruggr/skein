//! The pool library (src/pool.zig), natively: the Pool contract as the
//! overlay sees it, on the transactions gen/vectors builds from it
//! (src/fixtures/vectors.zig) and on broken variants of them. The Mandala
//! topic admits a pool that fails a pool check (it is a valid token output);
//! `pool.check`, which amm-lookup and amm-validator run, flags it; a pool
//! with any validator key passes it. Moved from amm-poc
//! programs/amm-topic/test.zig (shruggr/skein#120: the token rules and their
//! tests went to skein-mandala; the pool's stay with the AMM).
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");
const pool = @import("pool");
const vec = @import("vectors");

const brc162 = mandala.brc162;
const bsv21 = mandala.bsv21;
const token = mandala.token;
const bsvz = w.bsvz;
const testing = std.testing;

fn unhex(a: std.mem.Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

fn cat(a: std.mem.Allocator, parts: []const []const u8) []u8 {
    return std.mem.concat(a, u8, parts) catch @panic("OOM");
}

const p2pkh_lock = [_]u8{ 0x76, 0xa9, 0x14 } ++ [_]u8{0x33} ** 20 ++ [_]u8{ 0x88, 0xac };

// --- the pool, on gen/main.go's transactions ---

const Fixtures = struct {
    txs: std.AutoHashMap([32]u8, bsvz.transaction.Transaction),
    raws: std.StringHashMap([]const u8),
    id: [32]u8,

    fn init(a: std.mem.Allocator) !Fixtures {
        var f: Fixtures = .{ .txs = .init(a), .raws = .init(a), .id = undefined };
        inline for (.{
            "fund",         "token_deploy",       "pool_deploy",        "swap_bsv_in",     "swap_tokens_in",  "remove_liquidity",
            "legacy_fund",  "legacy_deploy0",     "legacy_deploy1",     "legacy_transfer", "legacy_migrate0", "legacy_migrate1",
            "legacy_mixed", "legacy_binary_json", "legacy_auth_deploy", "legacy_mint",     "legacy_unfunded",
        }) |name| {
            const raw = unhex(a, @field(vec, name));
            try f.raws.put(name, raw);
            try f.txs.put(w.beef.txidOf(raw), try bsvz.transaction.Transaction.parse(a, raw));
        }
        f.id = w.beef.txidOf(f.raws.get("token_deploy").?);
        return f;
    }

    /// A fixture transaction as the rules see it, sources filled from the others.
    fn tx(self: Fixtures, a: std.mem.Allocator, name: []const u8) !bsv21.Tx {
        const raw = self.raws.get(name).?;
        const t = self.txs.get(w.beef.txidOf(raw)).?;
        const ins = try a.alloc(bsv21.Input, t.inputs.len);
        for (t.inputs, ins) |in, *x| {
            x.* = .{ .txid = in.previous_outpoint.txid.bytes, .vout = in.previous_outpoint.index, .unlocking_script = in.unlocking_script.bytes };
            if (self.txs.get(x.txid)) |src| {
                const o = src.outputs[x.vout];
                x.source = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
            }
        }
        const outs = try a.alloc(bsv21.Output, t.outputs.len);
        for (t.outputs, outs) |o, *x| x.* = .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
        return .{ .txid = w.beef.txidOf(raw), .inputs = ins, .outputs = outs };
    }
};

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

/// `tx` with output i's script replaced.
fn withOutput(a: std.mem.Allocator, tx: bsv21.Tx, i: usize, script: []const u8) !bsv21.Tx {
    const outs = try a.dupe(bsv21.Output, tx.outputs);
    outs[i].script = script;
    var t = tx;
    t.outputs = outs;
    return t;
}

test "pool: the template parses the deployed pool; its validator key is the BRC-42 child" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    const tx = try f.tx(a, "pool_deploy");

    const tok = brc162.decode(tx.outputs[0].script).?;
    const p = (try pool.parse(tok.lock)).?;
    try testing.expectEqualSlices(u8, &f.id, &p.asset_id);
    try testing.expectEqual(@as(u64, vec.pool0.tokens), p.token_reserve);
    try testing.expectEqual(@as(i64, vec.lp_fee_bps), p.lp_fee_bps);
    try testing.expectEqual(@as(i64, vec.validator_fee_bps), p.validator_fee_bps);
    try testing.expectEqual(@as(i64, vec.commission_bps), p.commission_bps);
    try testing.expectEqualSlices(u8, &key33(vec.identity), &p.identity);
    try testing.expectEqualSlices(u8, &key33(vec.pool0.validator), &p.validator);

    // bsvz's public-side derivation agrees with go-sdk's private-side one.
    try testing.expectEqualSlices(u8, &key33(vec.pool0.validator), &try pool.validatorKey(a, p.identity, f.id, 0));

    // Token payouts and P2PKH outputs are not pools.
    try testing.expect((try pool.parse(brc162.decode(tx.outputs[1].script).?.lock)) == null);
    try testing.expect((try pool.parse(&p2pkh_lock)) == null);
}

test "pool: deploy admitted" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    const tx = try f.tx(a, "pool_deploy");

    const v = try token.judge(a, .{ .txid = f.id }, tx, &.{0});
    try testing.expect(v.rejected == null);
    try testing.expectEqualSlices(u32, &.{ 0, 1, 2 }, v.outputs_to_admit); // pool, the taker's 50,000, the LP's change
    try testing.expectEqualSlices(u32, &.{0}, v.coins_to_retain);
}

/// What the topic says about `tx` (it must admit it: no pool check runs in
/// the topic) and what `pool.check`, the library amm-lookup runs, says.
fn admittedButFlagged(a: std.mem.Allocator, txid: [32]u8, tx: bsv21.Tx, coins: []const u32) !pool.Violation {
    const id: bsv21.TokenId = .{ .txid = txid };
    const v = try token.judge(a, id, tx, coins);
    try testing.expect(v.rejected == null);
    try testing.expect(v.outputs_to_admit.len > 0);
    try testing.expectEqualSlices(u32, coins, v.coins_to_retain);
    const j = try bsv21.judge(a, id, tx, coins);
    return pool.check(j) orelse error.TestExpectedViolation;
}

test "pool: prefix disagreeing with state is admitted by the topic; pool.check flags it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    const tx = try f.tx(a, "pool_deploy");
    const lock = brc162.decode(tx.outputs[0].script).?.lock;

    // Prefix amount one lower than TokenReserve (still conserving value).
    var buf: [10]u8 = undefined;
    const low = cat(a, &.{ &.{0x20}, &f.id, brc162.pushAmount(&buf, vec.pool0.tokens - 1), &.{0x6d}, lock });
    const low_tx = try withOutput(a, tx, 0, low);
    try testing.expectEqual(pool.Violation.prefix_mismatch, try admittedButFlagged(a, f.id, low_tx, &.{0}));
    try testing.expectEqualSlices(u32, &.{ 0, 1, 2 }, (try token.judge(a, .{ .txid = f.id }, low_tx, &.{0})).outputs_to_admit);

    // A pool whose code carries another asset id, under this token's prefix.
    const other = try a.dupe(u8, tx.outputs[0].script);
    var n: usize = 0;
    var at: usize = 33;
    while (std.mem.indexOfPos(u8, other, at, &f.id)) |i| : (n += 1) {
        @memset(other[i..][0..32], 0x5a);
        at = i + 32;
    }
    try testing.expectEqual(@as(usize, 8), n); // assetId's eight slots
    try testing.expectEqual(pool.Violation.prefix_mismatch, try admittedButFlagged(a, f.id, try withOutput(a, tx, 0, other), &.{0}));

    // Slots that disagree with each other: malformed.
    const mixed = try a.dupe(u8, tx.outputs[0].script);
    mixed[std.mem.indexOfPos(u8, mixed, 33, &f.id).?] ^= 0xff;
    try testing.expectEqual(pool.Violation.malformed, try admittedButFlagged(a, f.id, try withOutput(a, tx, 0, mixed), &.{0}));
}

test "pool: quoteSwap and payoutScript reproduce the fixtures' swaps (the contract's arithmetic and outputs)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    const pd = try f.tx(a, "pool_deploy");
    const p0 = (try pool.parse(brc162.decode(pd.outputs[0].script).?.lock)).?;
    const relay = key20(vec.commission_pkh);

    // Sats in: 20,000.
    const q1 = pool.quoteSwap(p0, vec.pool0.bsv, 20_000, true).?;
    try testing.expectEqual(@as(u64, vec.pool1.bsv), q1.bsv_reserve);
    try testing.expectEqual(@as(u64, vec.pool1.tokens), q1.token_reserve);
    try testing.expectEqual(@as(u64, vec.swap_bsv_in_tokens_out), q1.out);
    try testing.expectEqual(@as(u64, 20), q1.commission);
    const s1 = try f.tx(a, "swap_bsv_in");
    try testing.expectEqual(q1.commission, s1.outputs[4].satoshis);
    try testing.expectEqualSlices(u8, try pool.payoutScript(a, p0.asset_id, q1.commission, relay, true), s1.outputs[4].script);
    const taker = s1.outputs[5].script[3..23].*; // the change pays the taker
    try testing.expectEqualSlices(u8, try pool.payoutScript(a, p0.asset_id, q1.out, taker, false), s1.outputs[1].script);

    // Tokens in: 50,000, against the continuation.
    const p1 = (try pool.parse(brc162.decode(s1.outputs[0].script).?.lock)).?;
    const q2 = pool.quoteSwap(p1, vec.pool1.bsv, 50_000, false).?;
    try testing.expectEqual(@as(u64, vec.pool2.bsv), q2.bsv_reserve);
    try testing.expectEqual(@as(u64, vec.pool2.tokens), q2.token_reserve);
    const s2 = try f.tx(a, "swap_tokens_in");
    try testing.expectEqual(pool.payoutSats(q2.commission, false), s2.outputs[4].satoshis);
    try testing.expectEqualSlices(u8, try pool.payoutScript(a, p0.asset_id, q2.commission, relay, false), s2.outputs[4].script);
    try testing.expectEqual(q2.out, s2.outputs[1].satoshis);

    // Where the contract asserts: nothing in, or fees taking it all.
    try testing.expect(pool.quoteSwap(p0, vec.pool0.bsv, 0, true) == null);
    try testing.expect(pool.quoteSwap(p0, vec.pool0.bsv, 3, true) == null); // 1 + 1 + 1 in fees
    try testing.expectEqual(@as(?u64, 1), pool.feeOf(1, 10));
    try testing.expectEqual(@as(?u64, 0), pool.feeOf(1_000_000, 0));
    try testing.expect(pool.feeOf(1, -1) == null);
}

test "pool: CommissionBps is read under the canonical-number rule" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    const lock = brc162.decode((try f.tx(a, "pool_deploy")).outputs[0].script).?.lock;
    // Slots 602 (lpFeeBps 30: `01 1e`, one byte longer than the placeholder)
    // and 614 (validatorFeeBps 5: OP_5) come first, so CommissionBps (template
    // offset 626) sits at 627 in the lock, as OP_10.
    const at = 627;
    try testing.expectEqual(@as(u8, 0x5a), lock[at]);

    // OP_0: a pool with no commission.
    const zero = try a.dupe(u8, lock);
    zero[at] = 0x00;
    try testing.expectEqual(@as(i64, 0), (try pool.parse(zero)).?.commission_bps);

    // 250 bps: `02 fa 00`.
    const big = cat(a, &.{ lock[0..at], &.{ 0x02, 0xfa, 0x00 }, lock[at + 1 ..] });
    try testing.expectEqual(@as(i64, 250), (try pool.parse(big)).?.commission_bps);

    // 10 as `01 0a` (not minimal: OP_10 is) and 250 as `03 fa 00 00`.
    try testing.expectError(error.BadPool, pool.parse(cat(a, &.{ lock[0..at], &.{ 0x01, 0x0a }, lock[at + 1 ..] })));
    try testing.expectError(error.BadPool, pool.parse(cat(a, &.{ lock[0..at], &.{ 0x03, 0xfa, 0x00, 0x00 }, lock[at + 1 ..] })));
}

/// The topic admits `tx` and `pool.check` passes it: still a pool to the
/// overlay (amm-lookup indexes it).
fn admittedAndPool(a: std.mem.Allocator, txid: [32]u8, tx: bsv21.Tx, coins: []const u32) !void {
    const id: bsv21.TokenId = .{ .txid = txid };
    const v = try token.judge(a, id, tx, coins);
    try testing.expect(v.rejected == null);
    try testing.expect(v.outputs_to_admit.len > 0);
    try testing.expectEqual(@as(u32, 0), v.outputs_to_admit[0]);
    try testing.expectEqualSlices(u32, coins, v.coins_to_retain);
    try testing.expect(pool.check(try bsv21.judge(a, id, tx, coins)) == null);
}

test "pool: any validator key is still a pool to the overlay (the key is the validator's convention)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);

    // The deploy with the key of the next pool (another key ID): the state's
    // ValidatorPubKey sits after TokenReserve and LpPubKey.
    const tx = try f.tx(a, "pool_deploy");
    const s = try a.dupe(u8, tx.outputs[0].script);
    const off = s.len - pool.state_len + 8 + 33;
    try testing.expectEqualSlices(u8, &key33(vec.pool0.validator), s[off..][0..33]);
    @memcpy(s[off..][0..33], &key33(vec.pool1.validator));
    try admittedAndPool(a, f.id, try withOutput(a, tx, 0, s), &.{0});

    // A swap's continuation with an arbitrary key, and one carrying the
    // pre-swap key over unrotated.
    const swap = try f.tx(a, "swap_bsv_in");
    for ([_][33]u8{ key33(vec.identity), key33(vec.pool0.validator) }) |k| {
        const c = try a.dupe(u8, swap.outputs[0].script);
        @memcpy(c[c.len - pool.state_len + 8 + 33 ..][0..33], &k);
        try admittedAndPool(a, f.id, try withOutput(a, swap, 0, c), &.{0});
    }

    // A removeLiquidity that rotates the key instead of carrying it over.
    const remove = try f.tx(a, "remove_liquidity");
    const cr = try a.dupe(u8, remove.outputs[0].script);
    @memcpy(cr[cr.len - pool.state_len + 8 + 33 ..][0..33], &key33(vec.pool1.validator));
    try admittedAndPool(a, f.id, try withOutput(a, remove, 0, cr), &.{0});
}

test "pool: methodOf reads Rúnar's method index (amm-validator's key convention)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    try testing.expectEqual(pool.Method.swap, pool.methodOf((try f.tx(a, "swap_bsv_in")).inputs[0].unlocking_script).?);
    try testing.expectEqual(pool.Method.swap, pool.methodOf((try f.tx(a, "swap_tokens_in")).inputs[0].unlocking_script).?);
    try testing.expectEqual(pool.Method.remove_liquidity, pool.methodOf((try f.tx(a, "remove_liquidity")).inputs[0].unlocking_script).?);
    try testing.expectEqual(pool.Method.add_liquidity, pool.methodOf(&.{0x51}).?);
    try testing.expect(pool.methodOf(&.{}) == null);
    try testing.expect(pool.methodOf(&.{0x53}) == null);
}

test "pool: a pool anywhere but output 0 is admitted by the topic; pool.check flags it" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);
    const tx = try f.tx(a, "pool_deploy");
    var t = tx;
    const outs = try a.dupe(bsv21.Output, tx.outputs);
    std.mem.swap(bsv21.Output, &outs[0], &outs[1]);
    t.outputs = outs;
    try testing.expectEqual(pool.Violation.not_at_output_0, try admittedButFlagged(a, f.id, t, &.{0}));
    try testing.expectEqualSlices(u32, &.{ 0, 1, 2 }, (try token.judge(a, .{ .txid = f.id }, t, &.{0})).outputs_to_admit);
}

test "pool: swaps and a liquidity removal admitted; pool.check passes them" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try Fixtures.init(a);

    // Sats in: pool continuation (0) and the token payout (1) are admitted;
    // the LP and validator fees and the commission (2, 3, 4) and the change
    // (5) are P2PKH; the commission pays the fixture relay.
    const s1 = try f.tx(a, "swap_bsv_in");
    const v1 = try token.judge(a, .{ .txid = f.id }, s1, &.{0});
    try testing.expect(v1.rejected == null);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, v1.outputs_to_admit);
    try testing.expectEqualSlices(u32, &.{0}, v1.coins_to_retain);
    for (s1.outputs[2..]) |o| try testing.expect(brc162.decode(o.script) == null);
    try testing.expectEqual(@as(usize, 6), s1.outputs.len);
    try testing.expectEqual(@as(u64, (20_000 * vec.commission_bps + 9999) / 10000), s1.outputs[4].satoshis);
    try testing.expectEqualSlices(u8, &key20(vec.commission_pkh), s1.outputs[4].script[3..23]);
    try testing.expectEqual(@as(u64, vec.swap_bsv_in_tokens_out), brc162.decode(s1.outputs[1].script).?.amount);
    const p1 = (try pool.parse(brc162.decode(s1.outputs[0].script).?.lock)).?;
    try testing.expectEqual(@as(u64, vec.pool1.tokens), p1.token_reserve);
    try testing.expectEqualSlices(u8, &key33(vec.pool1.validator), &p1.validator);
    try testing.expectEqual(@as(i64, vec.commission_bps), p1.commission_bps);

    // Tokens in: the pool (0) and the taker's tokens (1) are spent; the pool,
    // and the LP and validator token fees and the commission (2, 3, 4) are
    // admitted; the sats payout (1) and change (5) are P2PKH.
    const s2 = try f.tx(a, "swap_tokens_in");
    const v2 = try token.judge(a, .{ .txid = f.id }, s2, &.{ 0, 1 });
    try testing.expect(v2.rejected == null);
    try testing.expectEqualSlices(u32, &.{ 0, 2, 3, 4 }, v2.outputs_to_admit);
    const c2 = brc162.decode(s2.outputs[4].script).?;
    try testing.expectEqual(@as(u64, (50_000 * vec.commission_bps + 9999) / 10000), c2.amount);
    try testing.expectEqualSlices(u8, &key20(vec.commission_pkh), c2.lock[3..23]);
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, v2.coins_to_retain);

    // Without the taker's token input as a previous coin, the tokens in are
    // unaccounted for: rejected.
    try testing.expect((try token.judge(a, .{ .txid = f.id }, s2, &.{0})).rejected != null);

    // RemoveLiquidity keeps the validator key: continuation (0) and the LP's
    // token withdrawal (2).
    const r = try f.tx(a, "remove_liquidity");
    const v3 = try token.judge(a, .{ .txid = f.id }, r, &.{0});
    try testing.expect(v3.rejected == null);
    try testing.expectEqualSlices(u32, &.{ 0, 2 }, v3.outputs_to_admit);

    // pool.check passes all three (and the deploy): amm-lookup indexes them.
    for ([_][]const u8{ "pool_deploy", "swap_bsv_in", "remove_liquidity" }) |nm| {
        const t = try f.tx(a, nm);
        try testing.expect(pool.check(try bsv21.judge(a, .{ .txid = f.id }, t, &.{0})) == null);
    }
    try testing.expect(pool.check(try bsv21.judge(a, .{ .txid = f.id }, s2, &.{ 0, 1 })) == null);
}

// --- the program: topic names and the topic contract ---
