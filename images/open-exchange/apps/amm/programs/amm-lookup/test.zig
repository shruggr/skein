//! amm-lookup, natively: the index maintained through the hooks (admitted,
//! spent, rejected) over the real fixtures (src/fixtures/vectors.zig,
//! gen/vectors), the pool checks `admitted` runs (only pools that pass are
//! indexed), the queries, and the answer shape. See README.md.
//!
//! The hooks are called directly (`idx.admitted` / `idx.spent` /
//! `idx.rejected`), as skein's engine would call them (docs/OVERLAY.md, "The
//! lookup contract") but without the submit/step machinery around them —
//! that machinery (parsing a BEEF once, judging topics, persisting only on
//! admission) is skein-overlay's own, already tested there (its test.zig).
//! What is this service's own is the index and the queries, which is what
//! these tests cover.
//!
//! The three-hop follow test holds the hops in a chain state (skein-sdk
//! `chain.state.State`, `putTx`: what the chain app records), whose `spent`
//! the walk reads, and runs the hooks for each hop: a focused unit test of
//! `answerOutpoint`'s walk.
const std = @import("std");
const w = @import("chain");
const lookup = @import("lookup");
const pool = @import("pool");
const vec = @import("vectors");
const idx = @import("src/index.zig");

const bsvz = w.bsvz;
const cbor = w.cbor;
const Value = cbor.Value;
const Entry = cbor.Entry;
const Allocator = std.mem.Allocator;
const testing = std.testing;

fn unhex(a: Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

fn cat(a: Allocator, parts: []const []const u8) ![]u8 {
    return std.mem.concat(a, u8, parts);
}

fn key33(hex: []const u8) [33]u8 {
    var k: [33]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, hex) catch unreachable;
    return k;
}

/// A synthetic (invalid, first-byte-only) compressed key: good enough for
/// pool.parse, which only checks the prefix byte (used for LP keys, which no
/// check derives from).
fn key(tag: u8) [33]u8 {
    var k: [33]u8 = .{0x02} ** 33;
    k[1] = tag;
    return k;
}

const Fixtures = struct {
    txs: std.AutoHashMap([32]u8, bsvz.transaction.Transaction),
    raws: std.StringHashMap([]const u8),
    id: [32]u8,

    fn init(a: Allocator) !Fixtures {
        var f: Fixtures = .{ .txs = .init(a), .raws = .init(a), .id = undefined };
        inline for (.{ "fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in", "remove_liquidity" }) |name| {
            const bytes = unhex(a, @field(vec, name));
            try f.raws.put(name, bytes);
            try f.txs.put(w.beef.txidOf(bytes), try bsvz.transaction.Transaction.parse(a, bytes));
        }
        f.id = w.beef.txidOf(f.raws.get("token_deploy").?);
        return f;
    }
    fn raw(self: Fixtures, name: []const u8) []const u8 {
        return self.raws.get(name).?;
    }
    fn tx(self: Fixtures, name: []const u8) bsvz.transaction.Transaction {
        return self.txs.get(w.beef.txidOf(self.raws.get(name).?)).?;
    }
    fn txid(self: Fixtures, name: []const u8) [32]u8 {
        return w.beef.txidOf(self.raws.get(name).?);
    }
    /// Every fixture transaction held as a bitcoin-tx block, as the overlay
    /// holds a submission and its ancestry: what `admitted` reads the
    /// previous coins' sources from.
    fn hold(self: Fixtures, a: Allocator, s: w.store.Store) !void {
        var it = self.raws.valueIterator();
        while (it.next()) |r| _ = try s.putBitcoin(a, .tx, r.*);
    }
};

/// `lookup.Tx`, as a hook receives it (its CID does not matter to this
/// service — it never calls `Service.tx` itself — but must not be a
/// dangling stack pointer).
fn ltx(a: Allocator, txid: [32]u8, t: bsvz.transaction.Transaction) !lookup.Tx {
    const cid = w.store.hashCid(.tx, txid);
    return .{ .cid = try a.dupe(u8, cid[0..]), .txid = txid, .tx = t };
}

fn serviceAndTopic(a: Allocator, id: [32]u8) !struct { service: []const u8, topic: []const u8, token: []const u8 } {
    const token = try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(id)});
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "tm_mandala_{s}_0", .{&w.header.toHex(id)}), try idx.topicOf(a, token));
    return .{ .service = idx.service_name, .topic = try idx.topicOf(a, token), .token = token };
}

/// A query naming the token `token`, with `rest`.
fn query(a: Allocator, token: []const u8, rest: []const Entry) !Value {
    return .{ .map = try std.mem.concat(a, Entry, &.{ &.{.{ .key = "tokenId", .value = .{ .text = token } }}, rest }) };
}

fn opStr(a: Allocator, txid: [32]u8, vout: u32) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}_{d}", .{ &w.header.toHex(txid), vout });
}

/// `pool_deploy`'s output-0 script, with the state's TokenReserve and keys
/// overwritten and the prefix amount set to the new reserve: a spend's
/// continuation (or an unrelated pool), sharing the real,
/// gen/main.go-compiled Pool template so `pool.parse` still succeeds.
fn withState(a: Allocator, id: [32]u8, script: []const u8, token_reserve: u64, lp: [33]u8, validator: [33]u8, identity: [33]u8) ![]u8 {
    const st = try a.dupe(u8, pool.brc162.decode(script).?.lock);
    const off = st.len - pool.state_len;
    std.mem.writeInt(u64, st[off..][0..8], token_reserve, .little);
    @memcpy(st[off + 8 ..][0..33], &lp);
    @memcpy(st[off + 8 + 33 ..][0..33], &validator);
    @memcpy(st[off + 8 + 66 ..][0..33], &identity);
    var buf: [10]u8 = undefined;
    return cat(a, &.{ &.{0x20}, &id, pool.brc162.pushAmount(&buf, token_reserve), &.{0x6d}, st });
}

/// `script` with the state's ValidatorPubKey replaced.
fn withValidator(a: Allocator, script: []const u8, validator: [33]u8) ![]u8 {
    const c = try a.dupe(u8, script);
    @memcpy(c[c.len - pool.state_len + 8 + 33 ..][0..33], &validator);
    return c;
}

/// `t` with output `i`'s script replaced (same txid: the hooks take it as given).
fn withOutput(a: Allocator, t: bsvz.transaction.Transaction, i: usize, script: []const u8) !bsvz.transaction.Transaction {
    const outs = try a.dupe(bsvz.transaction.Output, t.outputs);
    outs[i].locking_script = bsvz.script.Script.init(script);
    var r = t;
    r.outputs = outs;
    return r;
}

const Built = struct { raw: []const u8, txid: [32]u8, tx: bsvz.transaction.Transaction };

/// A transaction spending `prev`'s output `prev_vout` with `unlocking` (a
/// pool spend's method index is its last push: OP_0 Swap, OP_1
/// AddLiquidity, OP_2 RemoveLiquidity), with one output (`script`, `sats`).
/// Unsigned: nothing here runs the interpreter.
fn buildSpend(a: Allocator, prev: bsvz.transaction.Transaction, prev_vout: u32, unlocking: []const u8, script: []const u8, sats: i64) !Built {
    var b = bsvz.transaction.Builder.init(a);
    try b.addInputFromTx(&prev, prev_vout);
    try b.addOutput(.{ .satoshis = sats, .locking_script = bsvz.script.Script.init(script) });
    var tx = try b.build();
    @constCast(tx.inputs)[0].unlocking_script = bsvz.script.Script.init(unlocking);
    const raw = try tx.serialize(a);
    return .{ .raw = raw, .txid = w.beef.txidOf(raw), .tx = try bsvz.transaction.Transaction.parse(a, raw) };
}

// ---------------------------------------------------------------- tests

const Env = struct {
    ms: w.store.MemStore,
    f: Fixtures,
    service: []const u8,
    topic: []const u8,
    token: []const u8,

    fn init(a: Allocator) !*Env {
        const e = try a.create(Env);
        e.ms = w.store.MemStore.init(testing.allocator);
        e.f = try Fixtures.init(a);
        try e.f.hold(a, e.ms.store());
        const st = try serviceAndTopic(a, e.f.id);
        e.service = st.service;
        e.topic = st.topic;
        e.token = st.token;
        return e;
    }
    fn deinit(self: *Env) void {
        self.ms.deinit();
    }
    fn svc(self: *Env, a: Allocator) !lookup.Service {
        return lookup.Service.load(a, self.ms.store(), self.service, idx.spec.maps, null);
    }
    /// The chain state (empty: what the chain app holds), read by `{outpoint}`'s walk.
    fn chain(self: *Env, a: Allocator) !lookup.Chain {
        return lookup.Chain.load(a, self.ms.store(), null, .regtest);
    }
    fn q(self: *Env, a: Allocator, rest: []const Entry) !Value {
        return query(a, self.token, rest);
    }
    /// `admitted` on fixture `name` (or a variant of it, same txid).
    fn admit(self: *Env, a: Allocator, s: *lookup.Service, name: []const u8, t: ?bsvz.transaction.Transaction, outs: []const u32, coins: []const u32) !void {
        try idx.admitted(a, s, self.topic, try ltx(a, self.f.txid(name), t orelse self.f.tx(name)), outs, coins);
    }
};

test "names: a query's tokenId <txid>, <txid>_0 or <txid>.0 is the topic tm_mandala_<txid>_0, <txid>_<vout> is tm_mandala_<txid>_<vout>; other ids are refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const hex = "0102030405060708091011121314151617181920212223242526272829303132";
    // skein-mandala 0.4.0 token ids: a Mandala-originated token prints the bare <txid>, a
    // BSV-21-originated one <txid>_<vout>; every form names the same token and topic.
    // The topic is `tm_mandala_<assetId>` (BRC-207, skein-mandala 0.9.0, David Case 2026-10-08).
    try testing.expectEqualStrings("tm_mandala_" ++ hex ++ "_0", try idx.topicOf(a, hex));
    try testing.expectEqualStrings("tm_mandala_" ++ hex ++ "_0", try idx.topicOf(a, hex ++ "_0"));
    try testing.expectEqualStrings("tm_mandala_" ++ hex ++ "_0", try idx.topicOf(a, hex ++ ".0"));
    try testing.expectEqualStrings("tm_mandala_" ++ hex ++ "_17", try idx.topicOf(a, hex ++ "_17"));
    try testing.expectEqualStrings("tm_mandala_" ++ hex ++ "_17", try idx.topicOf(a, hex ++ ".17"));
    try testing.expectError(error.BadQuery, idx.topicOf(a, hex ++ "_017"));
    try testing.expectError(error.BadQuery, idx.topicOf(a, "abcd_0"));
    try testing.expectEqual(pool.bsv21.Kind.legacy, idx.tokenIdOf("tm_mandala_" ++ hex ++ "_17").?.kind);
    try testing.expectEqual(pool.bsv21.Kind.native, idx.tokenIdOf("tm_mandala_" ++ hex ++ "_0").?.kind);
    try testing.expect(idx.tokenIdOf("tm_mandala") == null);
    try testing.expect(idx.tokenIdOf("tm_mandala_" ++ hex) == null);
    try testing.expect(idx.tokenIdOf("tm_" ++ hex ++ "_0") == null); // the old name: no alias
    try testing.expect(idx.tokenIdOf("tm_" ++ hex) == null);
    // Its index is `<app>/ls_amm` whatever name it is served as (skein-overlay 0.11.0).
    try testing.expectEqualStrings("ls_amm", idx.spec.index.?);
}

test "queries: one service over every token, each query naming its token; a query without one is refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try testing.expectError(error.BadQuery, idx.answer(a, &svc, &ch, .{ .map = &.{} }));
    // Another token: nothing of it is indexed.
    const other = try query(a, "0102030405060708091011121314151617181920212223242526272829303132_0", &.{});
    try testing.expectEqual(@as(usize, 0), (try idx.answer(a, &svc, &ch, other)).freeform.array.len);
    try testing.expectEqual(@as(usize, 1), (try idx.answer(a, &svc, &ch, try e.q(a, &.{}))).freeform.array.len);
}

test "admitted: a pool deploy that passes the checks is indexed once, and the answer matches the engine's PoolState shape" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_txid = e.f.txid("pool_deploy");
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0});
    try e.admit(a, &svc, "pool_deploy", null, &.{ 0, 1, 2 }, &.{0}); // a dupe hook call
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());

    // {} — every live pool, in the engine's PoolState shape plus `outpoint`.
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(usize, 1), all.freeform.array.len);
    const entry = all.freeform.array[0];
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), entry.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool0.bsv), entry.get("bsvReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.pool0.tokens), entry.get("tokenReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.lp_fee_bps), entry.get("liquidityFeeBps").?.uint);
    try testing.expectEqual(@as(u64, vec.validator_fee_bps), entry.get("validationFeeBps").?.uint);
    try testing.expectEqual(@as(u64, vec.commission_bps), entry.get("commissionBps").?.uint);
    try testing.expectEqualStrings(vec.identity, entry.getText("validatorIdentityKey").?);
    try testing.expect(entry.get("lastSeen") == null); // no liveness program wired: README, "Liveness join"

    // {outpoint}: a direct hit is 0 hops.
    const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }});
    const direct = try idx.answer(a, &svc, &ch, q);
    try testing.expectEqual(@as(u64, 0), direct.freeform.get("hops").?.uint);
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), direct.freeform.get("current").?.getText("outpoint").?);

    // {outpoint, beef: true}: the output-list form for a taker's spend.
    const bq = try e.q(a, &.{ .{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }, .{ .key = "beef", .value = .{ .boolean = true } } });
    const beef_ans = try idx.answer(a, &svc, &ch, bq);
    try testing.expectEqual(@as(usize, 1), beef_ans.output_list.len);
    try testing.expectEqualSlices(u8, &pd_txid, &beef_ans.output_list[0].txid);
    try testing.expectEqual(@as(u32, 0), beef_ans.output_list[0].vout);
}

test "admitted: pools the topic admitted but that fail the pool checks are not indexed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    const f = e.f;
    const pd = f.tx("pool_deploy");
    const pd_script = pd.outputs[0].locking_script.bytes;

    // The judgement agrees with pool.check on each case.
    const S = struct {
        fn expectNot(al: Allocator, en: *Env, sv: *lookup.Service, name: []const u8, t: bsvz.transaction.Transaction, outs: []const u32, coins: []const u32, want: pool.Violation) !void {
            const got = try idx.judge(al, .{ .txid = en.f.id }, try ltx(al, en.f.txid(name), t), outs);
            try testing.expectEqual(want, got.?);
            try en.admit(al, sv, name, t, outs, coins);
            try testing.expectEqual(@as(usize, 0), try sv.map("pools").count());
        }
    };

    // Prefix amount one lower than the state's TokenReserve.
    var buf: [10]u8 = undefined;
    const low = try cat(a, &.{ &.{0x20}, &f.id, pool.brc162.pushAmount(&buf, vec.pool0.tokens - 1), &.{0x6d}, pool.brc162.decode(pd_script).?.lock });
    try S.expectNot(a, e, &svc, "pool_deploy", try withOutput(a, pd, 0, low), &.{ 0, 1, 2 }, &.{0}, .prefix_mismatch);

    // A pool at output 1 (outputs 0 and 1 swapped).
    var swapped = pd;
    const outs = try a.dupe(bsvz.transaction.Output, pd.outputs);
    std.mem.swap(bsvz.transaction.Output, &outs[0], &outs[1]);
    swapped.outputs = outs;
    try S.expectNot(a, e, &svc, "pool_deploy", swapped, &.{ 0, 1, 2 }, &.{0}, .not_at_output_0);

    // The real ones pass.
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, f.txid("swap_tokens_in"), f.tx("swap_tokens_in")), &.{ 0, 2, 3, 4 }) == null);
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, f.txid("remove_liquidity"), f.tx("remove_liquidity")), &.{ 0, 2 }) == null);
}

test "admitted: a pool's CommissionBps is answered as commissionBps (0: a pool with no commission)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    // The deploy with CommissionBps OP_10 rewritten to OP_0. The lock's
    // commission slot (template offset 626) sits one byte later, after
    // lpFeeBps' two-byte push (the pool test of the slot, test.zig).
    const pd = e.f.tx("pool_deploy");
    const script = try a.dupe(u8, pd.outputs[0].locking_script.bytes);
    const at = script.len - pool.brc162.decode(script).?.lock.len + 627;
    try testing.expectEqual(@as(u8, 0x5a), script[at]);
    script[at] = 0x00;
    try e.admit(a, &svc, "pool_deploy", try withOutput(a, pd, 0, script), &.{ 0, 1, 2 }, &.{0});
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(usize, 1), all.freeform.array.len);
    try testing.expectEqual(@as(u64, 0), all.freeform.array[0].get("commissionBps").?.uint);
}

test "admitted: a pool with any validator key is indexed (the key is the validator's convention, not checked)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    const f = e.f;
    const S = struct {
        fn expectIndexed(al: Allocator, en: *Env, name: []const u8, t: bsvz.transaction.Transaction, outs: []const u32, coins: []const u32) !void {
            var sv = try en.svc(al);
            try testing.expect(try idx.judge(al, .{ .txid = en.f.id }, try ltx(al, en.f.txid(name), t), outs) == null);
            try en.admit(al, &sv, name, t, outs, coins);
            try testing.expectEqual(@as(usize, 1), try sv.map("pools").count());
            try idx.rejected(al, &sv, en.topic, try ltx(al, en.f.txid(name), t)); // clear for the next case
        }
    };

    // At deploy, the next pool's key (another key ID).
    const pd = f.tx("pool_deploy");
    try S.expectIndexed(a, e, "pool_deploy", try withOutput(a, pd, 0, try withValidator(a, pd.outputs[0].locking_script.bytes, key33(vec.pool1.validator))), &.{ 0, 1, 2 }, &.{0});

    // No token input among the coins retained.
    try S.expectIndexed(a, e, "pool_deploy", pd, &.{ 0, 1, 2 }, &.{});

    // A swap keeping the pre-swap key.
    const sw = f.tx("swap_bsv_in");
    try S.expectIndexed(a, e, "swap_bsv_in", try withOutput(a, sw, 0, try withValidator(a, sw.outputs[0].locking_script.bytes, key33(vec.pool0.validator))), &.{ 0, 1 }, &.{0});

    // A removeLiquidity rotating the key.
    const rm = f.tx("remove_liquidity");
    try S.expectIndexed(a, e, "remove_liquidity", try withOutput(a, rm, 0, try withValidator(a, rm.outputs[0].locking_script.bytes, key33(vec.pool1.validator))), &.{ 0, 2 }, &.{0});

    // A pool spend whose unlocking script selects no method.
    const hop = try buildSpend(a, pd, 0, &.{}, sw.outputs[0].locking_script.bytes, 900_000);
    _ = try e.ms.store().putBitcoin(a, .tx, hop.raw);
    var svc = try e.svc(a);
    try testing.expect(try idx.judge(a, .{ .txid = f.id }, try ltx(a, hop.txid, hop.tx), &.{0}) == null);
    try idx.admitted(a, &svc, e.topic, try ltx(a, hop.txid, hop.tx), &.{0}, &.{0});
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());

    // The record does not carry the ValidatorPubKey.
    const cid = (try svc.map("pools").prefixed(try w.store.nameKey(a, e.topic, &.{})))[0].value.cid;
    const rec = try svc.store.getValue(a, cid);
    try testing.expect(rec.get("validatorPubKey") == null);
    try testing.expectEqualSlices(u8, &key33(vec.identity), rec.getBytes("validatorIdentityKey").?);
}

test "admitted: another topic's call indexes nothing" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const f = try Fixtures.init(a);
    const st = try serviceAndTopic(a, f.id);
    var svc = try lookup.Service.load(a, ms.store(), st.service, idx.spec.maps, null);
    const pd = try ltx(a, f.txid("pool_deploy"), f.tx("pool_deploy"));

    try idx.admitted(a, &svc, "tm_demo", pd, &.{0}, &.{0});
    try testing.expectEqual(@as(usize, 0), try svc.map("pools").count());
}

test "spent + admitted: a swap's continuation replaces the pool it spent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_txid = e.f.txid("pool_deploy");
    const sw_txid = e.f.txid("swap_bsv_in");
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = pd_txid, .vout = 0 }, try ltx(a, sw_txid, e.f.tx("swap_bsv_in")));

    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(usize, 1), all.freeform.array.len);
    const entry = all.freeform.array[0];
    try testing.expectEqualStrings(try opStr(a, sw_txid, 0), entry.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool1.bsv), entry.get("bsvReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.pool1.tokens), entry.get("tokenReserve").?.uint);
    try testing.expectEqual(@as(u64, vec.commission_bps), entry.get("commissionBps").?.uint);

    // The old outpoint is a spent pool; the chain state (empty here) names no
    // spender for it, so the walk errors rather than silently answering
    // nothing. An outpoint that was never a pool errors the same way.
    const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }});
    try testing.expectError(error.UnknownOutpoint, idx.answer(a, &svc, &ch, q));
    const never = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 1) } }});
    try testing.expectError(error.UnknownOutpoint, idx.answer(a, &svc, &ch, never));
}

test "rejected: drops the rejected transaction's pool and restores the checked one it spent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_txid = e.f.txid("pool_deploy");
    const sw = try ltx(a, e.f.txid("swap_bsv_in"), e.f.tx("swap_bsv_in"));
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});
    try e.admit(a, &svc, "swap_bsv_in", null, &.{ 0, 1 }, &.{0});
    try idx.spent(a, &svc, e.topic, .{ .txid = pd_txid, .vout = 0 }, sw);

    try idx.rejected(a, &svc, e.topic, sw);

    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());
    try testing.expectEqual(@as(usize, 0), try svc.map("spentPools").count());
    const all = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    const entry = all.freeform.array[0];
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), entry.getText("outpoint").?);
    try testing.expectEqual(@as(u64, vec.pool0.tokens), entry.get("tokenReserve").?.uint);

    // A rejection gives back only what was indexed: a pool that failed the
    // checks when admitted stays out.
    var svc2 = try lookup.Service.load(a, e.ms.store(), e.service, idx.spec.maps, null);
    var buf: [10]u8 = undefined;
    const pd = e.f.tx("pool_deploy");
    const low = try cat(a, &.{ &.{0x20}, &e.f.id, pool.brc162.pushAmount(&buf, vec.pool0.tokens - 1), &.{0x6d}, pool.brc162.decode(pd.outputs[0].locking_script.bytes).?.lock });
    try e.admit(a, &svc2, "pool_deploy", try withOutput(a, pd, 0, low), &.{0}, &.{0}); // prefix mismatch: not indexed
    try idx.spent(a, &svc2, e.topic, .{ .txid = pd_txid, .vout = 0 }, sw);
    try idx.rejected(a, &svc2, e.topic, sw);
    try testing.expectEqual(@as(usize, 0), try svc2.map("pools").count());
}

test "answer: {outpoint} follows the spends (the chain state's) to the newest continuation over three hops" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);
    const identity = key33(vec.identity);

    const pd_tx = e.f.tx("pool_deploy");
    const pd_txid = e.f.txid("pool_deploy");
    const pd_script = pd_tx.outputs[0].locking_script.bytes;
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});
    _ = try ch.putTx(pd_txid, e.f.raw("pool_deploy"));

    var prev_tx = pd_tx;
    var prev_txid = pd_txid;
    const reserves = [_]u64{ 4_000_000, 3_000_000, 2_000_000 };
    var tip_txid: [32]u8 = undefined;
    for (reserves, 0..) |r, i| {
        // A Swap (OP_0): the key rotates to the child of the spent pool's outpoint.
        const validator = try pool.validatorKey(a, identity, prev_txid, 0);
        const script = try withState(a, e.f.id, pd_script, r, key(0xa0), validator, identity);
        const hop = try buildSpend(a, prev_tx, 0, &.{0x00}, script, 900_000 - @as(i64, @intCast(i)) * 1000);
        _ = try e.ms.store().putBitcoin(a, .tx, hop.raw);
        try idx.admitted(a, &svc, e.topic, try ltx(a, hop.txid, hop.tx), &.{0}, &.{0});
        try idx.spent(a, &svc, e.topic, .{ .txid = prev_txid, .vout = 0 }, try ltx(a, hop.txid, hop.tx));
        _ = try ch.putTx(hop.txid, hop.raw);
        prev_tx = hop.tx;
        prev_txid = hop.txid;
        tip_txid = hop.txid;
    }

    // Only the tip is indexed.
    try testing.expectEqual(@as(usize, 1), try svc.map("pools").count());

    const q = try e.q(a, &.{.{ .key = "outpoint", .value = .{ .text = try opStr(a, pd_txid, 0) } }});
    const ans = try idx.answer(a, &svc, &ch, q);
    try testing.expectEqual(@as(u64, 3), ans.freeform.get("hops").?.uint);
    const current = ans.freeform.get("current").?;
    try testing.expectEqualStrings(try opStr(a, tip_txid, 0), current.getText("outpoint").?);
    try testing.expectEqual(@as(u64, reserves[2]), current.get("tokenReserve").?.uint);
}

test "answer: {validatorIdentityKey} returns only that validator's pools" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    const pd_tx = e.f.tx("pool_deploy");
    const pd_txid = e.f.txid("pool_deploy");
    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});

    // A second pool under another identity (any valid point will do), a
    // deploy from pool_deploy's token output 1: its key is the child of
    // that deposit's outpoint.
    const other_identity = try pool.validatorKey(a, key33(vec.identity), .{0x77} ** 32, 7);
    const validator_b = try pool.validatorKey(a, other_identity, pd_txid, 1);
    const script_b = try withState(a, e.f.id, pd_tx.outputs[0].locking_script.bytes, 777_000, key(0x10), validator_b, other_identity);
    const pool_b = try buildSpend(a, pd_tx, 1, &.{}, script_b, 50_000);
    try idx.admitted(a, &svc, e.topic, try ltx(a, pool_b.txid, pool_b.tx), &.{0}, &.{0});

    try testing.expectEqual(@as(usize, 2), try svc.map("pools").count());

    const ida = try idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = vec.identity } }}));
    try testing.expectEqual(@as(usize, 1), ida.freeform.array.len);
    try testing.expectEqualStrings(try opStr(a, pd_txid, 0), ida.freeform.array[0].getText("outpoint").?);

    const hex_b = std.fmt.bytesToHex(other_identity, .lower);
    const idb = try idx.answer(a, &svc, &ch, try e.q(a, &.{.{ .key = "validatorIdentityKey", .value = .{ .text = &hex_b } }}));
    try testing.expectEqual(@as(usize, 1), idb.freeform.array.len);
    try testing.expectEqualStrings(try opStr(a, pool_b.txid, 0), idb.freeform.array[0].getText("outpoint").?);
}

test "liveness join: setLiveJoin merges lastSeen when a live map is wired, and leaves it null otherwise" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const e = try Env.init(a);
    defer e.deinit();
    var svc = try e.svc(a);
    var ch = try e.chain(a);

    try e.admit(a, &svc, "pool_deploy", null, &.{0}, &.{0});

    // No liveness program wired: lastSeen stays null.
    const before = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expect(before.freeform.array[0].get("lastSeen") == null);

    // A liveness service's own head, holding `{identityKey → {peerId, at}}`
    // (README, "Liveness join" — an assumed shape: no such program exists
    // yet). `svc.name` here stands in for "amm-live".
    var live_svc = try lookup.Service.load(a, e.ms.store(), "amm-live", &.{"live"}, null);
    const identity = key33(vec.identity);
    // A kernel-level MST value (`Map.put`'s `MValue`, wallet-zig's
    // store.zig), not wallet-zig's own `cbor.Value`: the literal is left
    // untyped so it infers the right (kernel) `Entry`.
    const live_val: w.store.MValue = .{ .map = &.{
        .{ .key = "peerId", .value = .{ .string = "12D3KooW..." } },
        .{ .key = "at", .value = .{ .int = 1_700_000_000_000 } },
    } };
    try live_svc.map("live").put(&identity, live_val);
    idx.setLiveJoin(.{ .svc = &live_svc });
    defer idx.setLiveJoin(null);

    const after = try idx.answer(a, &svc, &ch, try e.q(a, &.{}));
    try testing.expectEqual(@as(u64, 1_700_000_000_000), after.freeform.array[0].get("lastSeen").?.uint);
}
