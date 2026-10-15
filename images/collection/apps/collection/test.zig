//! skein-collection's tests (shruggr/skein#151): names and ids, the mint
//! rules, the admitted set of `tm_col_<id>` (rules 1 to 4) and
//! `tm_1sat_collection` over hand-built transactions signed as 1sat-sdk signs
//! (and the on-chain item 34adf92c), through the topic contract; the lookup's
//! hooks and its four reads, driven as the engine drives them; the manifest.
const std = @import("std");
const w = @import("chain");
const topic = @import("topic");
const lookup = @import("lookup");
const onesat = @import("onesat");
const collection = @import("collection");
const tp = @import("src/collection_topic.zig");
const ls = @import("src/collection_lookup.zig");

const bsvz = w.bsvz;
const testing = std.testing;
const Value = w.cbor.Value;
const Transaction = bsvz.transaction.Transaction;
const Allocator = std.mem.Allocator;
const name = collection.name;
const mint = collection.mint;
const rules = collection.rules;
const op = onesat.script;

test {
    _ = collection;
}

// ---------------------------------------------------------------- building transactions

/// A locking script built op by op, pushes minimally encoded.
const Script = struct {
    buf: std.ArrayList(u8) = .empty,
    a: Allocator,

    fn ops(self: *Script, codes: []const u8) *Script {
        self.buf.appendSlice(self.a, codes) catch @panic("OOM");
        return self;
    }

    fn push(self: *Script, data: []const u8) *Script {
        const a = self.a;
        if (data.len < op.OP_PUSHDATA1) {
            self.buf.append(a, @intCast(data.len)) catch @panic("OOM");
        } else if (data.len <= 0xff) {
            self.buf.appendSlice(a, &.{ op.OP_PUSHDATA1, @intCast(data.len) }) catch @panic("OOM");
        } else {
            var n: [2]u8 = undefined;
            std.mem.writeInt(u16, &n, @intCast(data.len), .little);
            self.buf.append(a, op.OP_PUSHDATA2) catch @panic("OOM");
            self.buf.appendSlice(a, &n) catch @panic("OOM");
        }
        self.buf.appendSlice(a, data) catch @panic("OOM");
        return self;
    }
};

fn p2pkhLock(pkh: [20]u8) [25]u8 {
    return [_]u8{ op.OP_DUP, op.OP_HASH160, 20 } ++ pkh ++ [_]u8{ op.OP_EQUALVERIFY, op.OP_CHECKSIG };
}

fn keyOf(n: u8) !bsvz.crypto.PrivateKey {
    var kb = [_]u8{0} ** 32;
    kb[31] = n;
    return bsvz.crypto.PrivateKey.fromBytes(kb);
}

fn pkhOf(key: bsvz.crypto.PrivateKey) ![20]u8 {
    return bsvz.crypto.hash.hash160(&(try key.publicKey()).toCompressedSec1()).bytes;
}

fn addrOf(a: Allocator, key: bsvz.crypto.PrivateKey) ![]const u8 {
    return bsvz.compat.address.encodeP2pkhFromPublicKey(a, .mainnet, try key.publicKey());
}

/// A 1Sat inscription owned by `owner` (1SAT_P2PKH before the envelope), with a MAP `SET` of `pairs`.
fn inscribed(a: Allocator, owner: [20]u8, content: []const u8, pairs: []const [2][]const u8) []const u8 {
    var s: Script = .{ .a = a };
    _ = s.ops(&p2pkhLock(owner)).ops(&.{ op.OP_0, op.OP_IF }).push("ord").ops(&.{op.OP_1}).push("text/plain")
        .ops(&.{op.OP_0}).push(content).ops(&.{ op.OP_ENDIF, op.OP_RETURN }).push(onesat.map.prefix).push("SET");
    for (pairs) |p| _ = s.push(p[0]).push(p[1]);
    return s.buf.items;
}

/// An OrdLock v2 listing: `seller` cancels, `price` satoshis paid to `pay_to`.
fn ordLock(a: Allocator, seller: [20]u8, price: u64, pay_to: [20]u8) []const u8 {
    const t = onesat.ordlock.template;
    var pay: [34]u8 = undefined;
    std.mem.writeInt(u64, pay[0..8], price, .little);
    pay[8] = 25;
    pay[9..34].* = p2pkhLock(pay_to);
    var s: Script = .{ .a = a };
    _ = s.ops(t[0..onesat.ordlock.pay_output_slot]).push(&pay)
        .ops(t[onesat.ordlock.pay_output_slot + 1 .. onesat.ordlock.seller_slot]).push(&seller)
        .ops(t[onesat.ordlock.seller_slot + 1 ..]);
    return s.buf.items;
}

const In = struct { txid: [32]u8, vout: u32, unlock: []const u8 = &.{} };
const Out = struct { sats: i64, lock: []const u8 };

fn build(a: Allocator, ins: []const In, outs: []const Out) !Transaction {
    const inputs = try a.alloc(bsvz.transaction.Input, ins.len);
    for (ins, inputs) |i, *x| x.* = .{ .previous_outpoint = .{ .txid = .{ .bytes = i.txid }, .index = i.vout }, .unlocking_script = .init(i.unlock), .sequence = 0xffffffff };
    const outputs = try a.alloc(bsvz.transaction.Output, outs.len);
    for (outs, outputs) |o, *x| x.* = .{ .satoshis = o.sats, .locking_script = .init(o.lock) };
    return .{ .version = 1, .inputs = inputs, .outputs = outputs, .lock_time = 0 };
}

/// Appends a SIGMA by `key` to output `vout` (vin 0), as 1sat-sdk's `Sigma.sign` does.
fn sign(a: Allocator, tx: *Transaction, vout: usize, key: bsvz.crypto.PrivateKey) !void {
    const outputs = try a.dupe(bsvz.transaction.Output, tx.outputs);
    const lock = outputs[vout].locking_script.bytes;
    var s: Script = .{ .a = a };
    _ = s.ops(lock);
    if (onesat.bitcom.decode(lock) != null) _ = s.push("|") else _ = s.ops(&.{op.OP_RETURN});
    const unsigned: onesat.sigma.Sigma = .{ .algorithm = "BSM", .address = "", .signature = "", .vin = 0, .signed = lock };
    const msg = onesat.sigma.message(unsigned, tx, @intCast(vout));
    const sig = try bsvz.compat.bsm.signMessage(key, &msg, a);
    _ = s.push("SIGMA").push("BSM").push(try addrOf(a, key)).push(&sig).push("0");
    outputs[vout].locking_script = .init(s.buf.items);
    tx.outputs = outputs;
}

/// A transaction as the store holds it.
const Tx = struct { tx: Transaction, raw: []const u8, txid: [32]u8, cid: []const u8 };

fn put(a: Allocator, s: w.store.Store, tx: Transaction) !Tx {
    const raw = try tx.serialize(a);
    return .{ .tx = tx, .raw = raw, .txid = w.beef.txidOf(raw), .cid = try s.putBitcoin(a, .tx, raw) };
}

fn idText(a: Allocator, txid: [32]u8, vout: u32) []const u8 {
    var b: [name.max_id_len]u8 = undefined;
    return a.dupe(u8, name.idText(&b, .{ .txid = txid, .vout = vout })) catch @panic("OOM");
}

fn topicOf(a: Allocator, txid: [32]u8, vout: u32) []const u8 {
    var b: [name.max_topic_len]u8 = undefined;
    return a.dupe(u8, name.topicName(&b, .{ .txid = txid, .vout = vout })) catch @panic("OOM");
}

// ---------------------------------------------------------------- the engine, in miniature

fn uints(a: Allocator, xs: []const u32) ![]Value {
    const out = try a.alloc(Value, xs.len);
    for (xs, out) |x, *o| o.* = .{ .uint = x };
    return out;
}

fn uintsOf(a: Allocator, v: ?Value) ![]const u32 {
    const xs = (v orelse return &.{}).array;
    const out = try a.alloc(u32, xs.len);
    for (xs, out) |x, *o| o.* = @intCast(x.uint);
    return out;
}

/// The engine's part, for one topic: previous coins from its unspent admitted outputs, the topic
/// judged through the contract (`topic.judge`), the lookup's hooks (`admitted`, then `spent` per
/// previous coin) through `lookup.handle`, the index's state record kept.
const Node = struct {
    a: Allocator,
    s: w.store.Store,
    topic: []const u8,
    coins: std.ArrayList([36]u8) = .empty,
    state: ?[]const u8 = null,

    const Verdict = struct { admit: []const u32, retain: []const u32, ancillary: []const []const u8 };

    fn coinKey(txid: [32]u8, vout: u32) [36]u8 {
        var k: [36]u8 = undefined;
        k[0..32].* = txid;
        std.mem.writeInt(u32, k[32..36], vout, .little);
        return k;
    }

    fn previous(self: *Node, tx: Transaction) ![]const u32 {
        var out: std.ArrayList(u32) = .empty;
        for (tx.inputs, 0..) |in, i| {
            const k = coinKey(in.previous_outpoint.txid.bytes, in.previous_outpoint.index);
            for (self.coins.items) |c| {
                if (std.mem.eql(u8, &c, &k)) {
                    try out.append(self.a, @intCast(i));
                    break;
                }
            }
        }
        return out.items;
    }

    fn judge(self: *Node, t: Tx) !Verdict {
        const prev = try self.previous(t.tx);
        const rec = try topic.judge(self.a, self.s, tp.identify, .{ .map = try self.a.dupe(w.cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "topic-call" } },
            .{ .key = "topic", .value = .{ .text = self.topic } },
            .{ .key = "tx", .value = .{ .cid = t.cid } },
            .{ .key = "previousCoins", .value = .{ .array = try uints(self.a, prev) } },
        }) });
        var anc: std.ArrayList([]const u8) = .empty;
        if (rec.get("ancillaryTxids")) |xs| for (xs.array) |x| try anc.append(self.a, x.text);
        return .{ .admit = try uintsOf(self.a, rec.get("outputsToAdmit")), .retain = try uintsOf(self.a, rec.get("coinsToRetain")), .ancillary = anc.items };
    }

    fn hook(self: *Node, func: []const u8, rest: []const w.cbor.Entry) !void {
        const head = [_]w.cbor.Entry{
            .{ .key = "kind", .value = .{ .text = "lookup-hook" } },
            .{ .key = "app", .value = .{ .text = "collection" } },
            .{ .key = "service", .value = .{ .text = ls.service_name } },
            .{ .key = "program", .value = .{ .text = "collection-lookup" } },
            .{ .key = "topic", .value = .{ .text = self.topic } },
        };
        const arg: Value = .{ .map = try std.mem.concat(self.a, w.cbor.Entry, &.{ &head, rest }) };
        const h = try lookup.handle(self.a, ls.spec, self.s, .regtest, self.state, null, func, arg);
        if (h.state) |sc| self.state = sc;
    }

    /// Submit `t` to the topic: judged, then (if taken) admitted, its previous coins spent.
    fn submit(self: *Node, t: Tx) !Verdict {
        const prev = try self.previous(t.tx);
        const v = try self.judge(t);
        if (v.admit.len == 0 and prev.len == 0) return v;
        try self.hook("admitted", &.{
            .{ .key = "tx", .value = .{ .cid = t.cid } },
            .{ .key = "outputsToAdmit", .value = .{ .array = try uints(self.a, v.admit) } },
            .{ .key = "coinsRetained", .value = .{ .array = try uints(self.a, v.retain) } },
        });
        for (prev) |p| {
            const in = t.tx.inputs[p];
            try self.hook("spent", &.{
                .{ .key = "outpoint", .value = .{ .map = try self.a.dupe(w.cbor.Entry, &.{
                    .{ .key = "tx", .value = .{ .cid = try self.a.dupe(u8, &w.store.hashCid(.tx, in.previous_outpoint.txid.bytes)) } },
                    .{ .key = "vout", .value = .{ .uint = in.previous_outpoint.index } },
                }) } },
                .{ .key = "spendingTx", .value = .{ .cid = t.cid } },
            });
            const k = coinKey(in.previous_outpoint.txid.bytes, in.previous_outpoint.index);
            for (self.coins.items, 0..) |c, i| if (std.mem.eql(u8, &c, &k)) {
                _ = self.coins.orderedRemove(i);
                break;
            };
        }
        for (v.admit) |vout| try self.coins.append(self.a, coinKey(t.txid, vout));
        return v;
    }

    fn reject(self: *Node, t: Tx) !void {
        try self.hook("rejected", &.{.{ .key = "tx", .value = .{ .cid = t.cid } }});
    }

    /// A read's rows, as JSON values.
    fn read(self: *Node, q: ls.Query) ![]const std.json.Value {
        var svc = try lookup.Service.loadIndex(self.a, self.s, ls.service_name, ls.index_name, ls.spec.maps, self.state);
        var ch = try lookup.Chain.load(self.a, self.s, null, .regtest);
        const rs = try ls.rows(self.a, &svc, &ch, q);
        const out = try self.a.alloc(std.json.Value, rs.len);
        for (rs, out) |r, *o| o.* = try std.json.parseFromSliceLeaky(std.json.Value, self.a, r.json, .{});
        return out;
    }
};

fn str(v: std.json.Value, k: []const u8) ?[]const u8 {
    const x = v.object.get(k) orelse return null;
    return if (x == .string) x.string else null;
}

fn int(v: std.json.Value, k: []const u8) ?i64 {
    const x = v.object.get(k) orelse return null;
    return if (x == .integer) x.integer else null;
}

// ---------------------------------------------------------------- a collection's life

/// The keys and transactions of one collection's life, every one in the store.
const World = struct {
    a: Allocator,
    s: w.store.Store,
    issuer: bsvz.crypto.PrivateKey,
    alice: [20]u8,
    bob: [20]u8,
    carol: [20]u8,
    /// Funding: outputs 0..5 (1000, 1000, 5000, 2000, 3000, 4000 satoshis), Alice's.
    fund: Tx,
    /// The collection mint at output 0 (signed by the issuer), change at 1.
    coll: Tx,

    fn init(a: Allocator, s: w.store.Store) !World {
        var wd: World = .{
            .a = a,
            .s = s,
            .issuer = try keyOf(1),
            .alice = try pkhOf(try keyOf(2)),
            .bob = try pkhOf(try keyOf(3)),
            .carol = try pkhOf(try keyOf(4)),
            .fund = undefined,
            .coll = undefined,
        };
        const al = p2pkhLock(wd.alice);
        wd.fund = try put(a, s, try build(a, &.{.{ .txid = [_]u8{0xf0} ** 32, .vout = 0 }}, &.{
            .{ .sats = 1000, .lock = try a.dupe(u8, &al) }, .{ .sats = 1000, .lock = try a.dupe(u8, &al) },
            .{ .sats = 5000, .lock = try a.dupe(u8, &al) }, .{ .sats = 2000, .lock = try a.dupe(u8, &al) },
            .{ .sats = 3000, .lock = try a.dupe(u8, &al) }, .{ .sats = 4000, .lock = try a.dupe(u8, &al) },
        }));
        var ct = try build(a, &.{.{ .txid = wd.fund.txid, .vout = 0 }}, &.{
            .{ .sats = 1, .lock = inscribed(a, wd.alice, "roots", &.{ .{ "type", "ord" }, .{ "subType", "collection" }, .{ "name", "Roots" } }) },
            .{ .sats = 900, .lock = try a.dupe(u8, &al) },
        });
        try sign(a, &ct, 0, wd.issuer);
        wd.coll = try put(a, s, ct);
        return wd;
    }

    fn id(self: World) name.Id {
        return .{ .txid = self.coll.txid, .vout = 0 };
    }

    /// An item of `collection_id`: MAP subType=collectionItem with subTypeData, signed by `key`.
    fn item(self: World, collection_id: []const u8, number: u32, key: bsvz.crypto.PrivateKey) []const u8 {
        _ = key;
        const data = std.fmt.allocPrint(self.a, "{{\"collectionId\":\"{s}\",\"mintNumber\":{d},\"rank\":{d}}}", .{ collection_id, number, 10 - number }) catch @panic("OOM");
        const nm = std.fmt.allocPrint(self.a, "Item {d}", .{number}) catch @panic("OOM");
        return inscribed(self.a, self.alice, nm, &.{ .{ "type", "ord" }, .{ "subType", "collectionItem" }, .{ "name", nm }, .{ "subTypeData", data } });
    }
};

/// Item mints from funding output 1: outputs 0 and 1 are items 1 and 2 signed by the issuer, 2 an
/// item signed by another key, 3 an item of another collection, 4 a 2-sat item, 5 change.
fn mintItems(wd: World) !Tx {
    const a = wd.a;
    const cid = idText(a, wd.coll.txid, 0);
    const other = idText(a, [_]u8{0x77} ** 32, 0);
    var t = try build(a, &.{.{ .txid = wd.fund.txid, .vout = 1 }}, &.{
        .{ .sats = 1, .lock = wd.item(cid, 1, wd.issuer) },
        .{ .sats = 1, .lock = wd.item(cid, 2, wd.issuer) },
        .{ .sats = 1, .lock = wd.item(cid, 3, wd.issuer) },
        .{ .sats = 1, .lock = wd.item(other, 4, wd.issuer) },
        .{ .sats = 2, .lock = wd.item(cid, 5, wd.issuer) },
        .{ .sats = 900, .lock = try a.dupe(u8, &p2pkhLock(wd.alice)) },
    });
    for ([_]usize{ 0, 1, 3, 4 }) |v| try sign(a, &t, v, wd.issuer);
    try sign(a, &t, 2, try keyOf(9));
    return put(a, wd.s, t);
}

test "names: tm_col_<txid>_<vout>, tm_1sat_collection, ids canonical, relative ids normalized" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const hex = "ee8c1a403ad4d9396df261b96f53a30209c2ba419d0e9b41f4930a4602e72cde";
    const id = name.idOfText(hex ++ "_0").?;
    try testing.expectEqualStrings(hex ++ "_0", idText(a, id.txid, id.vout));
    try testing.expectEqualStrings("tm_col_" ++ hex ++ "_0", topicOf(a, id.txid, 0));
    try testing.expect(name.idOfTopic("tm_col_" ++ hex ++ "_12").?.vout == 12);
    try testing.expect(rules.Topic.of(name.discovery_topic).? == .discovery);
    for ([_][]const u8{
        "tm_col_" ++ hex, // no vout
        "tm_col_" ++ hex ++ "_01", // a leading zero
        "tm_col_" ++ hex ++ ".0", // the dot form
        "tm_col_EE8C1A403AD4D9396DF261B96F53A30209C2BA419D0E9B41F4930A4602E72CDE_0", // uppercase
        "tm_col_" ++ hex ++ "_4294967296", // past u32
        "tm_" ++ hex ++ "_0",
        "tm_demo",
    }) |t| try testing.expect(rules.Topic.of(t) == null);
    // Relative ids: output n of the item's own transaction (leading zeros taken, as Go's ParseUint).
    const own = [_]u8{0x42} ** 32;
    try testing.expect(name.normalize("_0", own).?.eql(.{ .txid = own, .vout = 0 }));
    try testing.expect(name.normalize("_007", own).?.eql(.{ .txid = own, .vout = 7 }));
    try testing.expect(name.normalize(hex ++ "_0", own).?.eql(id));
    for ([_][]const u8{ "_", "_x", "_-1", "_4294967296", "", hex, hex ++ ".0" }) |r| try testing.expect(name.normalize(r, own) == null);
}

test "mint: MAP fields; subTypeData's collectionId, mintNumber and rank each on its own" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const pk = [_]u8{0x11} ** 20;
    const f = (try mint.fieldsOf(a, inscribed(a, pk, "x", &.{ .{ "type", "ord" }, .{ "subType", "collectionItem" }, .{ "name", "One" }, .{ "subTypeData", "{\"collectionId\":\"_0\",\"mintNumber\":3,\"rank\":-2,\"traits\":[1]}" } }))).?;
    try testing.expectEqualStrings("ord", f.type.?);
    try testing.expectEqualStrings("One", f.name.?);
    try testing.expectEqualStrings("_0", f.collection_id.?);
    try testing.expectEqual(@as(?i64, 3), f.mint_number);
    try testing.expectEqual(@as(?i64, -2), f.rank);
    // Keys matched without regard to case.
    const ci = (try mint.fieldsOf(a, inscribed(a, pk, "x", &.{.{ "subTypeData", "{\"CollectionID\":\"_1\"}" }}))).?;
    try testing.expectEqualStrings("_1", ci.collection_id.?);
    // Each field on its own: a number as an integer or decimal digits (on-chain items write strings);
    // another type absent, the others still read.
    const sn = (try mint.fieldsOf(a, inscribed(a, pk, "x", &.{.{ "subTypeData", "{\"collectionId\":\"_0\",\"mintNumber\":\"42\",\"rank\":1.5}" }}))).?;
    try testing.expectEqualStrings("_0", sn.collection_id.?);
    try testing.expectEqual(@as(?i64, 42), sn.mint_number);
    try testing.expect(sn.rank == null);
    for ([_][]const u8{ "{\"collectionId\":7,\"mintNumber\":\"-1\"}", "[\"_0\"]", "not json" }) |d| {
        const g = (try mint.fieldsOf(a, inscribed(a, pk, "x", &.{.{ "subTypeData", d }}))).?;
        try testing.expect(g.collection_id == null and g.mint_number == null and g.rank == null);
    }
    // No MAP: no fields.
    var s: Script = .{ .a = a };
    _ = s.ops(&p2pkhLock(pk)).ops(&.{ op.OP_0, op.OP_IF }).push("ord").ops(&.{op.OP_0}).push("x").ops(&.{op.OP_ENDIF});
    try testing.expect((try mint.fieldsOf(a, s.buf.items)) == null);
}

test "mint: the on-chain item 34adf92c: an item of ee8c1a40…_0 signed by 12KP5Kz…" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const hex = std.mem.trim(u8, @embedFile("testdata/34adf92c766e11a656d3ff3508df7b1a31405821bf734bc9bef9fb43fcf701f9.hex"), " \n\r\t");
    const tx = try Transaction.parseHex(a, hex);
    const txid = (try tx.txid(a)).bytes;
    const coll = name.idOfText("ee8c1a403ad4d9396df261b96f53a30209c2ba419d0e9b41f4930a4602e72cde_0").?;
    try testing.expect(mint.isMintOutput(tx.outputs[0]));
    try testing.expect((try mint.claimedCollection(a, &tx, txid, 0)).?.eql(coll));
    const f = (try mint.fieldsOf(a, tx.outputs[0].locking_script.bytes)).?;
    try testing.expectEqualStrings("collectionItem", f.sub_type.?);
    try testing.expectEqual(@as(?i64, 42), f.mint_number); // written "42"
    try testing.expect(try mint.isItemOf(a, &tx, txid, 0, coll, "12KP5KzkBwtsc1UrTrsBCJzgqKn8UqaYQq"));
    try testing.expect(!try mint.isItemOf(a, &tx, txid, 0, coll, "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"));
    // An item is no collection mint.
    try testing.expect((try mint.collectionSigner(a, &tx, 0)) == null);

    // Through the topic: the collection's mint is not held, so its signer is unknown and the item is not admitted.
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const t = try put(a, s, tx);
    var n: Node = .{ .a = a, .s = s, .topic = topicOf(a, coll.txid, 0) };
    try testing.expectEqual(@as(usize, 0), (try n.judge(t)).admit.len);
}

test "rule 1: the collection's own mint, in tm_col_<id> and tm_1sat_collection; unsigned, wrong type or not one sat, none" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    try testing.expectEqualStrings(try addrOf(a, wd.issuer), (try mint.collectionSigner(a, &wd.coll.tx, 0)).?);

    var col: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 0) };
    const v = try col.judge(wd.coll);
    try testing.expectEqualSlices(u32, &.{0}, v.admit);
    try testing.expectEqual(@as(usize, 0), v.retain.len + v.ancillary.len);
    // Another collection's topic: not its mint.
    var other: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 1) };
    try testing.expectEqual(@as(usize, 0), (try other.judge(wd.coll)).admit.len);

    // Discovery: every collection mint, here two in one transaction (outputs 0 and 2).
    const al = p2pkhLock(wd.alice);
    var two = try build(a, &.{.{ .txid = wd.fund.txid, .vout = 4 }}, &.{
        .{ .sats = 1, .lock = inscribed(a, wd.alice, "a", &.{ .{ "type", "ord" }, .{ "subType", "collection" } }) },
        .{ .sats = 1, .lock = inscribed(a, wd.alice, "b", &.{ .{ "type", "ord" }, .{ "subType", "collection" } }) }, // unsigned
        .{ .sats = 1, .lock = inscribed(a, wd.alice, "c", &.{ .{ "type", "ord" }, .{ "subType", "collection" } }) },
        .{ .sats = 1, .lock = inscribed(a, wd.alice, "d", &.{ .{ "type", "bsocial" }, .{ "subType", "collection" } }) }, // not type=ord
        .{ .sats = 2, .lock = inscribed(a, wd.alice, "e", &.{ .{ "type", "ord" }, .{ "subType", "collection" } }) }, // two sats
        .{ .sats = 1, .lock = inscribed(a, wd.alice, "f", &.{ .{ "type", "ord" }, .{ "subType", "collectionItem" } }) }, // an item
        .{ .sats = 2000, .lock = try a.dupe(u8, &al) },
    });
    for ([_]usize{ 0, 2, 3, 4, 5 }) |o| try sign(a, &two, o, wd.issuer);
    const tt = try put(a, s, two);
    var disc: Node = .{ .a = a, .s = s, .topic = name.discovery_topic };
    try testing.expectEqualSlices(u32, &.{ 0, 2 }, (try disc.judge(tt)).admit);
    try testing.expectEqualSlices(u32, &.{0}, (try disc.judge(wd.coll)).admit);
    // The discovery topic retains nothing, and takes no item.
    try testing.expectEqual(@as(usize, 0), (try disc.judge(try mintItems(wd))).admit.len);
}

test "rule 2: item mints signed by the collection's signer; relative ids; the collection's mint read from the store" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    var col: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 0) };
    // Items 1 and 2 (the issuer's); not 3 (another key), not 4 (another collection), not 5 (two sats).
    try testing.expectEqualSlices(u32, &.{ 0, 1 }, (try col.judge(try mintItems(wd))).admit);

    // A collection and its items in one transaction, the items naming it `_0`.
    var both = try build(a, &.{.{ .txid = wd.fund.txid, .vout = 5 }}, &.{
        .{ .sats = 1, .lock = inscribed(a, wd.alice, "c", &.{ .{ "type", "ord" }, .{ "subType", "collection" } }) },
        .{ .sats = 1, .lock = wd.item("_0", 1, wd.issuer) },
        .{ .sats = 1, .lock = wd.item("_00", 2, wd.issuer) },
        .{ .sats = 1, .lock = wd.item("_1", 3, wd.issuer) }, // names output 1: no collection
        .{ .sats = 3000, .lock = try a.dupe(u8, &p2pkhLock(wd.alice)) },
    });
    for (0..4) |o| try sign(a, &both, o, wd.issuer);
    const bt = try put(a, s, both);
    var bc: Node = .{ .a = a, .s = s, .topic = topicOf(a, bt.txid, 0) };
    try testing.expectEqualSlices(u32, &.{ 0, 1, 2 }, (try bc.judge(bt)).admit);

    // The collection's mint is not a collection mint (an item's outpoint named as a collection): nothing.
    var nc: Node = .{ .a = a, .s = s, .topic = topicOf(a, bt.txid, 1) };
    try testing.expectEqual(@as(usize, 0), (try nc.judge(bt)).admit.len);

    // The collection's mint not held: no item is admitted.
    var ms2 = w.store.MemStore.init(testing.allocator);
    defer ms2.deinit();
    const s2 = ms2.store();
    const lone = try put(a, s2, (try mintItems(wd)).tx);
    var away: Node = .{ .a = a, .s = s2, .topic = topicOf(a, wd.coll.txid, 0) };
    try testing.expectEqual(@as(usize, 0), (try away.judge(lone)).admit.len);
}

test "rules 3 and 4: an item's satoshi by the ordinal rule into any script, the coin retained, the funding parents ancillary; absorbed, gone" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    var col: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 0) };
    _ = try col.submit(wd.coll);
    const items = try mintItems(wd);
    _ = try col.submit(items);

    // A transfer: funding first (5000), then item 1: offset 5000 lands in output 1 (Bob's).
    const xfer = try put(a, s, try build(a, &.{ .{ .txid = wd.fund.txid, .vout = 2 }, .{ .txid = items.txid, .vout = 0 } }, &.{
        .{ .sats = 5000, .lock = try a.dupe(u8, &p2pkhLock(wd.alice)) },
        .{ .sats = 1, .lock = try a.dupe(u8, &p2pkhLock(wd.bob)) },
    }));
    const v = try col.submit(xfer);
    try testing.expectEqualSlices(u32, &.{1}, v.admit);
    try testing.expectEqualSlices(u32, &.{1}, v.retain);
    try testing.expectEqual(@as(usize, 1), v.ancillary.len);
    try testing.expectEqualStrings(&w.header.toHex(wd.fund.txid), v.ancillary[0]);

    // Into an OrdLock v2 listing (item first: no funding before it, nothing ancillary).
    const listing = try put(a, s, try build(a, &.{ .{ .txid = xfer.txid, .vout = 1 }, .{ .txid = xfer.txid, .vout = 0 } }, &.{
        .{ .sats = 1, .lock = ordLock(a, wd.bob, 1000, wd.bob) },
        .{ .sats = 4900, .lock = try a.dupe(u8, &p2pkhLock(wd.bob)) },
    }));
    const lv = try col.submit(listing);
    try testing.expectEqualSlices(u32, &.{0}, lv.admit);
    try testing.expectEqual(@as(usize, 0), lv.ancillary.len);

    // Absorbed into a multi-sat output: gone, the coin still retained; its funding parent named.
    const absorb = try put(a, s, try build(a, &.{ .{ .txid = wd.fund.txid, .vout = 3 }, .{ .txid = items.txid, .vout = 1 } }, &.{
        .{ .sats = 1950, .lock = try a.dupe(u8, &p2pkhLock(wd.carol)) },
    }));
    const av = try col.judge(absorb);
    try testing.expectEqual(@as(usize, 0), av.admit.len);
    try testing.expectEqualSlices(u32, &.{1}, av.retain);
    try testing.expectEqual(@as(usize, 1), av.ancillary.len);

    // A funding parent the call cannot read: not judgeable (the engine pauses before asking).
    const unread = try put(a, s, try build(a, &.{ .{ .txid = [_]u8{0xee} ** 32, .vout = 0 }, .{ .txid = items.txid, .vout = 1 } }, &.{
        .{ .sats = 1, .lock = try a.dupe(u8, &p2pkhLock(wd.carol)) },
    }));
    try testing.expectError(error.MissingSourceOutput, col.judge(unread));
}

// ---------------------------------------------------------------- the lookup's four reads

fn findQ(a: Allocator, find: []const u8, k: []const u8, id: []const u8, extra: []const w.cbor.Entry) !Value {
    const head = [_]w.cbor.Entry{ .{ .key = "find", .value = .{ .text = find } }, .{ .key = k, .value = .{ .text = id } } };
    return .{ .map = try std.mem.concat(a, w.cbor.Entry, &.{ &head, extra }) };
}

test "lookup: items, history, listings and sales over the hooks; a purchase, a cancel, an absorption; rejected; paging" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    var col: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 0) };
    const cid = idText(a, wd.coll.txid, 0);
    const cq = try ls.parseQuery(try findQ(a, "items", "collection", cid, &.{}));

    _ = try col.submit(wd.coll);
    try testing.expectEqual(@as(usize, 0), (try col.read(cq)).len); // the collection's mint is no item
    const items = try mintItems(wd);
    _ = try col.submit(items);
    const o1 = idText(a, items.txid, 0);
    const o2 = idText(a, items.txid, 1);

    var list = try col.read(cq);
    try testing.expectEqual(@as(usize, 2), list.len);
    const first = if (std.mem.eql(u8, str(list[0], "origin").?, o1)) list[0] else list[1];
    try testing.expectEqualStrings(o1, str(first, "outpoint").?);
    try testing.expectEqualStrings(try bsvz.compat.address.encodeP2pkh(a, .mainnet, .{ .bytes = wd.alice }), str(first, "owner").?);
    try testing.expectEqualStrings("Item 1", str(first, "name").?);
    try testing.expectEqual(@as(?i64, 1), int(first, "mintNumber"));
    try testing.expectEqual(@as(?i64, 9), int(first, "rank"));
    try testing.expectEqualStrings("text/plain", str(first, "contentType").?);
    try testing.expectEqualStrings("collectionItem", str(first.object.get("map").?, "subType").?);
    // Origin order, paged.
    try testing.expect(std.mem.order(u8, str(list[0], "origin").?, str(list[1], "origin").?) == .lt);
    try testing.expectEqual(@as(usize, 1), (try col.read(try ls.parseQuery(try findQ(a, "items", "collection", cid, &.{ .{ .key = "skip", .value = .{ .uint = 1 } } })))).len);
    try testing.expectEqual(@as(usize, 1), (try col.read(try ls.parseQuery(try findQ(a, "items", "collection", cid, &.{ .{ .key = "limit", .value = .{ .uint = 1 } } })))).len);

    // Item 1: transferred to Bob, listed by Bob, bought by Carol.
    const xfer = try put(a, s, try build(a, &.{ .{ .txid = wd.fund.txid, .vout = 2 }, .{ .txid = items.txid, .vout = 0 } }, &.{
        .{ .sats = 5000, .lock = try a.dupe(u8, &p2pkhLock(wd.alice)) },
        .{ .sats = 1, .lock = try a.dupe(u8, &p2pkhLock(wd.bob)) },
    }));
    _ = try col.submit(xfer);
    const listing = try put(a, s, try build(a, &.{ .{ .txid = xfer.txid, .vout = 1 }, .{ .txid = xfer.txid, .vout = 0 } }, &.{
        .{ .sats = 1, .lock = ordLock(a, wd.bob, 1000, wd.bob) },
        .{ .sats = 4900, .lock = try a.dupe(u8, &p2pkhLock(wd.bob)) },
    }));
    _ = try col.submit(listing);
    const lq = try ls.parseQuery(try findQ(a, "listings", "collection", cid, &.{}));
    const open = try col.read(lq);
    try testing.expectEqual(@as(usize, 1), open.len);
    const bob = try bsvz.compat.address.encodeP2pkh(a, .mainnet, .{ .bytes = wd.bob });
    try testing.expectEqualStrings(idText(a, listing.txid, 0), str(open[0], "outpoint").?);
    try testing.expectEqualStrings(o1, str(open[0], "origin").?);
    try testing.expectEqual(@as(?i64, 1000), int(open[0], "price"));
    try testing.expectEqualStrings(bob, str(open[0], "seller").?);
    try testing.expectEqualStrings(bob, str(open[0], "payout").?);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{x}", .{&p2pkhLock(wd.bob)}), str(open[0], "payoutScript").?);
    list = try col.read(cq);
    for (list) |x| if (std.mem.eql(u8, str(x, "origin").?, o1)) try testing.expectEqualStrings("listed", str(x, "owner").?);

    // The purchase: the listing (unlocked by the purchase branch, OP_0 last) first, then the buyer's funding.
    const buy = try put(a, s, try build(a, &.{ .{ .txid = listing.txid, .vout = 0, .unlock = &.{ 0x01, 0xaa, op.OP_0 } }, .{ .txid = wd.fund.txid, .vout = 3 } }, &.{
        .{ .sats = 1, .lock = try a.dupe(u8, &p2pkhLock(wd.carol)) },
        .{ .sats = 1000, .lock = try a.dupe(u8, &p2pkhLock(wd.bob)) },
        .{ .sats = 900, .lock = try a.dupe(u8, &p2pkhLock(wd.carol)) },
    }));
    _ = try col.submit(buy);
    try testing.expectEqual(@as(usize, 0), (try col.read(lq)).len);
    const sq = try ls.parseQuery(try findQ(a, "sales", "collection", cid, &.{}));
    var sales = try col.read(sq);
    try testing.expectEqual(@as(usize, 1), sales.len);
    try testing.expectEqualStrings("purchase", str(sales[0], "type").?);
    try testing.expectEqual(@as(?i64, 1000), int(sales[0], "price"));
    try testing.expectEqualStrings(&w.header.toHex(buy.txid), str(sales[0], "txid").?);
    try testing.expectEqualStrings(idText(a, listing.txid, 0), str(sales[0], "outpoint").?);
    try testing.expect(sales[0].object.get("time").? == .null); // not mined

    // Item 2: listed by Alice, then cancelled (OP_1 last).
    const list2 = try put(a, s, try build(a, &.{ .{ .txid = items.txid, .vout = 1 }, .{ .txid = items.txid, .vout = 5 } }, &.{
        .{ .sats = 1, .lock = ordLock(a, wd.alice, 500, wd.alice) },
        .{ .sats = 800, .lock = try a.dupe(u8, &p2pkhLock(wd.alice)) },
    }));
    _ = try col.submit(list2);
    try testing.expectEqual(@as(usize, 1), (try col.read(lq)).len);
    const cancel = try put(a, s, try build(a, &.{.{ .txid = list2.txid, .vout = 0, .unlock = &.{ 0x01, 0xbb, op.OP_1 } }}, &.{
        .{ .sats = 1, .lock = try a.dupe(u8, &p2pkhLock(wd.alice)) },
    }));
    _ = try col.submit(cancel);
    try testing.expectEqual(@as(usize, 0), (try col.read(lq)).len);
    sales = try col.read(sq);
    try testing.expectEqual(@as(usize, 2), sales.len);
    // Newest first: both unmined, so by spending txid then outpoint, highest first.
    try testing.expect(std.mem.order(u8, str(sales[0], "txid").?, str(sales[1], "txid").?) == .gt);
    var types = [_][]const u8{ str(sales[0], "type").?, str(sales[1], "type").? };
    std.mem.sort([]const u8, &types, {}, struct {
        fn lt(_: void, x: []const u8, y: []const u8) bool {
            return std.mem.order(u8, x, y) == .lt;
        }
    }.lt);
    try testing.expectEqualStrings("cancel", types[0]);
    try testing.expectEqualStrings("purchase", types[1]);

    // Item 1's history: mint, transfer, listing, sale. Item 2's: mint, listing, cancel.
    const h1 = try col.read(try ls.parseQuery(try findQ(a, "history", "origin", o1, &.{})));
    try testing.expectEqual(@as(usize, 4), h1.len);
    for ([_][]const u8{ "mint", "transfer", "listing", "sale" }, h1) |k, x| try testing.expectEqualStrings(k, str(x, "kind").?);
    try testing.expectEqualStrings(o1, str(h1[0], "outpoint").?);
    try testing.expectEqualStrings(idText(a, xfer.txid, 1), str(h1[1], "outpoint").?);
    try testing.expectEqualStrings(idText(a, buy.txid, 0), str(h1[3], "outpoint").?);
    const h2 = try col.read(try ls.parseQuery(try findQ(a, "history", "origin", o2, &.{})));
    for ([_][]const u8{ "mint", "listing", "cancel" }, h2) |k, x| try testing.expectEqualStrings(k, str(x, "kind").?);
    try testing.expectEqual(@as(usize, 2), (try col.read(try ls.parseQuery(try findQ(a, "history", "origin", o1, &.{ .{ .key = "skip", .value = .{ .uint = 2 } } })))).len);

    // Carol owns item 1 now; item 2 is Alice's again.
    list = try col.read(cq);
    const carol = try bsvz.compat.address.encodeP2pkh(a, .mainnet, .{ .bytes = wd.carol });
    for (list) |x| {
        if (std.mem.eql(u8, str(x, "origin").?, o1)) {
            try testing.expectEqualStrings(idText(a, buy.txid, 0), str(x, "outpoint").?);
            try testing.expectEqualStrings(carol, str(x, "owner").?);
        } else try testing.expectEqualStrings(idText(a, cancel.txid, 0), str(x, "outpoint").?);
    }

    // Item 2 absorbed into Carol's 1950 sats: gone (no outpoint, no owner); its history unchanged.
    const absorb = try put(a, s, try build(a, &.{ .{ .txid = wd.fund.txid, .vout = 4 }, .{ .txid = cancel.txid, .vout = 0 } }, &.{
        .{ .sats = 2950, .lock = try a.dupe(u8, &p2pkhLock(wd.carol)) },
    }));
    _ = try col.submit(absorb);
    list = try col.read(cq);
    for (list) |x| if (std.mem.eql(u8, str(x, "origin").?, o2)) {
        try testing.expect(x.object.get("outpoint").? == .null and x.object.get("owner").? == .null);
    };
    try testing.expectEqual(@as(usize, 3), (try col.read(try ls.parseQuery(try findQ(a, "history", "origin", o2, &.{})))).len);

    // The absorption rejected: item 2 back at the cancel's output, Alice's.
    try col.reject(absorb);
    list = try col.read(cq);
    for (list) |x| if (std.mem.eql(u8, str(x, "origin").?, o2)) try testing.expectEqualStrings(idText(a, cancel.txid, 0), str(x, "outpoint").?);

    // The purchase rejected: item 1 listed again, the sale gone, its history back to three steps.
    try col.reject(buy);
    try testing.expectEqual(@as(usize, 1), (try col.read(lq)).len);
    try testing.expectEqual(@as(usize, 1), (try col.read(sq)).len);
    try testing.expectEqual(@as(usize, 3), (try col.read(try ls.parseQuery(try findQ(a, "history", "origin", o1, &.{})))).len);
    list = try col.read(cq);
    for (list) |x| if (std.mem.eql(u8, str(x, "origin").?, o1)) {
        try testing.expectEqualStrings(idText(a, listing.txid, 0), str(x, "outpoint").?);
        try testing.expectEqualStrings("listed", str(x, "owner").?);
    };

    // The item mint rejected: both items gone.
    try col.reject(items);
    try testing.expectEqual(@as(usize, 0), (try col.read(cq)).len);

    // Another topic's hooks do nothing.
    var demo: Node = .{ .a = a, .s = s, .topic = "tm_demo", .state = col.state };
    try demo.hook("admitted", &.{
        .{ .key = "tx", .value = .{ .cid = items.cid } },
        .{ .key = "outputsToAdmit", .value = .{ .array = try uints(a, &.{ 0, 1 }) } },
        .{ .key = "coinsRetained", .value = .{ .array = &.{} } },
    });
    try testing.expectEqual(@as(usize, 0), (try demo.read(cq)).len);
}

test "lookup: BRC-24 answers are output-lists with each row as context; queries out of shape refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    var col: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 0) };
    _ = try col.submit(wd.coll);
    const items = try mintItems(wd);
    _ = try col.submit(items);
    const cid = idText(a, wd.coll.txid, 0);

    var svc = try lookup.Service.loadIndex(a, s, ls.service_name, ls.index_name, ls.spec.maps, col.state);
    var ch = try lookup.Chain.load(a, s, null, .regtest);
    const ans = try ls.answer(a, &svc, &ch, try findQ(a, "items", "collection", cid, &.{}));
    try testing.expectEqual(@as(usize, 2), ans.output_list.len);
    for (ans.output_list) |o| {
        try testing.expectEqualSlices(u8, &items.txid, &o.txid);
        const j = try std.json.parseFromSliceLeaky(std.json.Value, a, o.context.?, .{});
        try testing.expectEqualStrings(idText(a, items.txid, o.vout), str(j, "origin").?);
    }
    // Another service name.
    var other = try lookup.Service.loadIndex(a, s, "ls_demo", ls.index_name, ls.spec.maps, col.state);
    try testing.expectError(error.UnknownService, ls.answer(a, &other, &ch, try findQ(a, "items", "collection", cid, &.{})));

    const bad = [_]Value{
        .{ .map = &.{.{ .key = "collection", .value = .{ .text = cid } }} }, // no find
        try findQ(a, "everything", "collection", cid, &.{}),
        try findQ(a, "items", "origin", cid, &.{}), // items take a collection
        try findQ(a, "history", "collection", cid, &.{}), // history takes an origin
        try findQ(a, "items", "collection", "nope", &.{}),
        try findQ(a, "items", "collection", cid, &.{.{ .key = "limit", .value = .{ .uint = 0 } }}),
        try findQ(a, "items", "collection", cid, &.{.{ .key = "limit", .value = .{ .uint = 101 } }}),
        try findQ(a, "items", "collection", cid, &.{.{ .key = "skip", .value = .{ .uint = 100_001 } }}),
        try findQ(a, "items", "collection", cid, &.{.{ .key = "owner", .value = .{ .text = "x" } }}),
        .{ .text = "items" },
    };
    for (bad) |q| try testing.expectError(error.BadQuery, ls.parseQuery(q));
}

test "read routes: /collection/<find> from the query string or a JSON body; 400 out of shape; the filter's answer" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    var col: Node = .{ .a = a, .s = s, .topic = topicOf(a, wd.coll.txid, 0) };
    _ = try col.submit(wd.coll);
    _ = try col.submit(try mintItems(wd));
    const cid = idText(a, wd.coll.txid, 0);

    const req: Value = .{ .map = &.{ .{ .key = "method", .value = .{ .text = "GET" } }, .{ .key = "query", .value = .{ .text = try std.fmt.allocPrint(a, "collection={s}&limit=1", .{cid}) } } } };
    const r = try ls.route(a, s, .items, col.state, null, req);
    try testing.expectEqual(@as(u64, 200), r.getUint("status").?);
    const body = try std.json.parseFromSliceLeaky(std.json.Value, a, r.getBytes("body").?, .{});
    try testing.expectEqual(@as(usize, 1), body.array.items.len);

    const post: Value = .{ .map = &.{.{ .key = "body", .value = .{ .bytes = try std.fmt.allocPrint(a, "{{\"collection\":\"{s}\",\"skip\":1}}", .{cid}) } }} };
    const rp = try ls.route(a, s, .items, col.state, null, post);
    try testing.expectEqual(@as(usize, 1), (try std.json.parseFromSliceLeaky(std.json.Value, a, rp.getBytes("body").?, .{})).array.items.len);

    const empty = try ls.route(a, s, .listings, col.state, null, req);
    try testing.expectEqualStrings("[]", empty.getBytes("body").?);

    for ([_][]const u8{ "", "collection=x", "origin=" ++ "ab" ** 32 ++ "_0", try std.fmt.allocPrint(a, "collection={s}&limit=500", .{cid}) }) |qs| {
        const bad: Value = .{ .map = &.{.{ .key = "query", .value = .{ .text = qs } }} };
        try testing.expectEqual(@as(u64, 400), (try ls.route(a, s, .items, col.state, null, bad)).getUint("status").?);
    }
    // A route before any index: no rows.
    try testing.expectEqualStrings("[]", (try ls.route(a, s, .items, null, null, req)).getBytes("body").?);

    try testing.expect(ls.isFilter(.{ .map = &.{.{ .key = "filter", .value = .{ .boolean = true } }} }));
    try testing.expect(!ls.isFilter(.{ .map = &.{.{ .key = "fn", .value = .{ .text = "items" } }} }));
}

test "sales: newest first by the chain — unmined first, then the higher block, then the later position" {
    const k = [_][104]u8{ [_]u8{1} ** 104, [_]u8{2} ** 104, [_]u8{3} ** 104, [_]u8{4} ** 104, [_]u8{5} ** 104 };
    var ages = [_]ls.Age{
        .{ .key = &k[0], .height = 100, .offset = 5 },
        .{ .key = &k[1] },
        .{ .key = &k[2], .height = 200 },
        .{ .key = &k[3], .height = 100, .offset = 9 },
        .{ .key = &k[4] },
    };
    std.mem.sort(ls.Age, &ages, {}, ls.newerFirst);
    for ([_]u8{ 5, 2, 3, 4, 1 }, ages) |b, x| try testing.expectEqual(b, x.key[0]);
}

test "the topic program: metadata and documentation; an unknown topic refused" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const hex = "ee8c1a403ad4d9396df261b96f53a30209c2ba419d0e9b41f4930a4602e72cde";
    try testing.expect(std.mem.indexOf(u8, (try tp.metadata(a, "tm_col_" ++ hex ++ "_0")).short_description, hex ++ "_0") != null);
    try testing.expectEqualStrings("1Sat Collection Discovery", (try tp.metadata(a, name.discovery_topic)).name.?);
    try testing.expect(std.mem.startsWith(u8, try tp.documentation(a, name.discovery_topic), "# 1Sat collection discovery"));
    try testing.expect(std.mem.startsWith(u8, try tp.documentation(a, "tm_col_" ++ hex ++ "_0"), "# 1Sat collection topic"));

    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const wd = try World.init(a, s);
    var demo: Node = .{ .a = a, .s = s, .topic = "tm_demo" };
    try testing.expectError(error.UnknownTopic, demo.judge(wd.coll));
}

test "the manifest: the engine and both programs; no topics or lookups declared; root's register; the four read routes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const j = (try std.json.parseFromSliceLeaky(std.json.Value, a, @embedFile("etc/app.json"), .{})).object;
    try testing.expectEqualStrings("collection", j.get("name").?.string);
    const progs = j.get("programs").?.object;
    for ([_][]const u8{ "overlay", "collection-topic", "collection-lookup" }) |p| try testing.expect(progs.get(p) != null);
    const ov = j.get("config").?.object.get("overlay").?.object;
    try testing.expectEqual(@as(usize, 0), ov.count());
    const gated = j.get("roles").?.object.get("root").?.array.items;
    for ([_][]const u8{ "register", "registerLookup", "deregisterLookup" }, gated) |x, g| try testing.expectEqualStrings(x, g.string);
    const filters = j.get("filters").?.object;
    var reads: usize = 0;
    for (j.get("routes").?.array.items) |r| {
        try testing.expect(r.object.get("sender") == null and r.object.get("program") == null);
        const addr = r.object.get("address").?.string;
        if (!std.mem.startsWith(u8, addr, "/collection/")) continue;
        const find = addr["/collection/".len..];
        try testing.expect(std.meta.stringToEnum(ls.Find, find) != null);
        try testing.expect(r.object.get("handler") == null);
        const f = r.object.get("filters").?.array.items[0].string;
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "collection-lookup.{s}", .{find}), filters.get(f).?.string);
        reads += 1;
    }
    try testing.expectEqual(@as(usize, 4), reads);
}
