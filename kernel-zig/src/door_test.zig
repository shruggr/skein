// The `beef` filter (door.zig) over a store with a chain state: the BEEF
// proven by skein-sdk's verifier against chain/state's headers (#121), the
// blocks it stores (each once),
// the package it hands back (no BEEF bytes: the envelope, linking the pointer
// record, #146),
// a rejection (nothing stored), and the bytes put back (restore).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const mst = @import("mst");
const beef = @import("beef.zig");
const door = @import("door.zig");
const heads = @import("heads.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Store = @import("store.zig").Store;
const Value = cbor.Value;

fn unhex(a: std.mem.Allocator, s: []const u8) ![]u8 {
    const out = try a.alloc(u8, s.len / 2);
    _ = try std.fmt.hexToBytes(out, s);
    return out;
}

const Sink = struct {
    s: Store,
    fn put(ctx: *anyopaque, c: []const u8, b: []const u8) anyerror!void {
        const k: *Sink = @ptrCast(@alignCast(ctx));
        try k.s.putBlock(c, b);
    }
    fn get(ctx: *anyopaque, a: std.mem.Allocator, c: []const u8) anyerror!?[]u8 {
        const k: *Sink = @ptrCast(@alignCast(ctx));
        return k.s.bytes(a, c);
    }
};

/// A chain state holding one header at `height` (the chain app's record shape).
fn chainState(a: std.mem.Allocator, s: Store, height: u32, header: []const u8) !void {
    const hc = try cidm.ofBitcoin(a, cidm.BITCOIN_BLOCK, header);
    try s.putBlock(hc, header);
    var sink = Sink{ .s = s };
    var f = mst.Forest.init(a, .{ .ctx = &sink, .get = Sink.get });
    var key: [4]u8 = undefined;
    std.mem.writeInt(u32, &key, height, .big);
    const root = try f.put(null, &key, cbor.cidv(hc));
    try f.flush(root, .{ .ctx = &sink, .put = Sink.put });
    var maps = cbor.MapBuilder.init(a);
    try maps.put("headers", cbor.optCid(root) orelse .null);
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("chain-state"));
    try m.put("network", cbor.string("main"));
    try m.put("maps", maps.value());
    const state = try s.put(a, m.value());
    _ = try heads.advanceHead(a, s, door.CHAIN_STATE, state, .{ .thread = null, .input = state, .at = 0 });
}

fn wireOf(a: std.mem.Allocator, bump: []const u8, parent: []const u8) ![]u8 {
    var o: std.ArrayList(u8) = .empty;
    try o.appendSlice(a, &.{ 1, 0, 0xbe, 0xef, 1 });
    try o.appendSlice(a, bump);
    try o.appendSlice(a, &.{1});
    try o.appendSlice(a, parent);
    try o.appendSlice(a, &.{ 1, 0 });
    return o.items;
}

fn contains(hay: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, hay, needle) != null;
}

test "door: the beef filter checks every BUMP against chain/state, stores each block once, links the pointer record" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();

    // Block 170: its header, its spend (the transaction), a BUMP proving it beside the coinbase.
    const header = try unhex(a, "0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70");
    const tx = try unhex(a, "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000");
    const txid = beef.txidOf(tx);
    const coinbase = try unhex(a, "82501c1178fa0b222c1f3d474ec726b832013f0a532b44bb620cce8624a5feb1");
    var bump: std.ArrayList(u8) = .empty;
    try bump.appendSlice(a, &.{ 0xaa, 1, 2, 0, 0 });
    try bump.appendSlice(a, coinbase);
    try bump.appendSlice(a, &.{ 1, 2 });
    try bump.appendSlice(a, &txid);
    const wire = try wireOf(a, bump.items, tx);

    var pkg = cbor.MapBuilder.init(a);
    try pkg.put("kind", cbor.string("http"));
    try pkg.put("body", .{ .bytes = wire });
    const v = pkg.value();

    // No chain app: refused, saying so.
    const none = try door.filterBeef(a, s, v);
    try std.testing.expect(none.refused != null);
    try std.testing.expect(contains(none.refused.?, "chain/state"));

    try chainState(a, s, 170, header);
    const got = try door.filterBeef(a, s, v);
    try std.testing.expectEqual(@as(?[]const u8, null), got.refused);
    try std.testing.expectEqual(@as(usize, 1), got.beefs.len);
    // The package holds the envelope where the bytes were, linking the pointer record, not the bytes.
    const body = got.value.get("body").?;
    try std.testing.expectEqualStrings("beef", Value.str(body.get("form")).?);
    try std.testing.expect(body.get("subject") == null);
    try std.testing.expectEqualSlices(u8, got.beefs[0], beef.pointerOf(body).?);
    try std.testing.expect(!contains(try cbor.encode(a, got.value), wire));
    const rec = (try s.get(a, got.beefs[0])).?;
    try std.testing.expect(beef.isRecord(rec));
    // The transaction is its bitcoin-tx block (CID = txid); the BUMP's node is held; the header checked is linked.
    try std.testing.expectEqualSlices(u8, tx, (try s.bytes(a, try beef.txCid(a, txid))).?);
    const b0 = rec.get("bumps").?.array[0];
    try std.testing.expectEqualSlices(u8, try cidm.ofBitcoin(a, cidm.BITCOIN_BLOCK, header), Value.cidOf(b0.get("block")).?);
    try std.testing.expect(try s.has(try beef.txCid(a, header[36..68].*)));
    // The bytes come back exactly.
    const back = try door.restore(a, s, got.value, got.beefs);
    try std.testing.expectEqualSlices(u8, wire, Value.bytesOf(back.get("body")).?);

    // Again: the same pointer record, and no block written (each is stored once).
    const before = (try ss.allCids(a)).len;
    const again = try door.filterBeef(a, s, v);
    try std.testing.expectEqualSlices(u8, got.beefs[0], again.beefs[0]);
    try std.testing.expectEqual(before, (try ss.allCids(a)).len);

    // A BUMP whose sibling is changed: its root is not the header's — RootMismatch (#143: nothing stored, no entry names it).
    const bad_wire = try a.dupe(u8, wire);
    bad_wire[5 + 5] ^= 0xff;
    var bad = cbor.MapBuilder.init(a);
    try bad.put("body", .{ .bytes = bad_wire });
    const held = (try ss.allCids(a)).len;
    const r = try door.filterBeef(a, s, bad.value());
    try std.testing.expect(r.refused != null);
    try std.testing.expect(std.mem.startsWith(u8, r.refused.?, "RootMismatch"));
    try std.testing.expectEqual(@as(usize, 0), r.beefs.len);
    try std.testing.expectEqualSlices(u8, bad_wire, Value.bytesOf(r.value.get("body")).?);
    try std.testing.expectEqual(held, (try ss.allCids(a)).len);

    // A BUMP at a height chain/state has no header for: refused.
    var hi = try a.dupe(u8, wire);
    hi[5] = 0xab;
    var h = cbor.MapBuilder.init(a);
    try h.put("body", .{ .bytes = hi });
    const r2 = try door.filterBeef(a, s, h.value());
    try std.testing.expect(std.mem.startsWith(u8, r2.refused.?, "UnknownHeader"));

    // Bytes that are not a BEEF pass as they are; a byte string deeper in the package is walked too.
    var plain = cbor.MapBuilder.init(a);
    try plain.put("body", .{ .bytes = "{\"not\": \"beef\"}" });
    const inner = try a.alloc(Value, 1);
    inner[0] = .{ .bytes = wire };
    try plain.put("args", .{ .array = inner });
    const p = try door.filterBeef(a, s, plain.value());
    try std.testing.expect(p.refused == null);
    try std.testing.expect(p.value.get("body").? == .bytes);
    try std.testing.expect(beef.pointerOf(p.value.get("args").?.array[0]) != null);
}

test "door: two envelopes over one BEEF in a dag-cbor body — one pointer record, each envelope beside it, the bytes back (#146)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();
    const header = try unhex(a, "0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70");
    const tx = try unhex(a, "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000");
    const txid = beef.txidOf(tx);
    const coinbase = try unhex(a, "82501c1178fa0b222c1f3d474ec726b832013f0a532b44bb620cce8624a5feb1");
    var v2: std.ArrayList(u8) = .empty;
    try v2.appendSlice(a, &.{ 2, 0, 0xbe, 0xef, 1, 0xaa, 1, 2, 0, 0 });
    try v2.appendSlice(a, coinbase);
    try v2.appendSlice(a, &.{ 1, 2 });
    try v2.appendSlice(a, &txid);
    try v2.appendSlice(a, &.{ 1, 1, 0 });
    try v2.appendSlice(a, tx);
    try chainState(a, s, 170, header);
    const atomic = try std.mem.concat(a, u8, &.{ &.{ 1, 1, 1, 1 }, &txid, v2.items });
    const subject = try std.mem.concat(a, u8, &.{ &.{ 0x57, 0x09, 0xbe, 0xef }, &txid, v2.items });

    // A dag-cbor body (a carried message's): the two in fields of it.
    var pkg = cbor.MapBuilder.init(a);
    try pkg.put("atomic", .{ .bytes = atomic });
    try pkg.put("subject", .{ .bytes = subject });
    const got = try door.filterBeef(a, s, pkg.value());
    try std.testing.expectEqual(@as(?[]const u8, null), got.refused);
    try std.testing.expectEqual(@as(usize, 2), got.beefs.len);
    try std.testing.expectEqualSlices(u8, got.beefs[0], got.beefs[1]);
    const ea = got.value.get("atomic").?;
    const es = got.value.get("subject").?;
    try std.testing.expectEqualStrings("atomic", Value.str(ea.get("form")).?);
    try std.testing.expectEqualStrings("subject", Value.str(es.get("form")).?);
    try std.testing.expectEqualSlices(u8, try beef.txCid(a, txid), Value.cidOf(es.get("subject")).?);
    // The log holds the package (through dag-cbor) and the blocks: the bytes come back exactly from those alone.
    const logged = try cbor.decode(a, try cbor.encode(a, got.value));
    const back = try door.restore(a, s, logged, got.beefs);
    try std.testing.expectEqualSlices(u8, atomic, Value.bytesOf(back.get("atomic")).?);
    try std.testing.expectEqualSlices(u8, subject, Value.bytesOf(back.get("subject")).?);
}

test "door: an unsigned request whose filter found nothing to validate is refused; a signed one is not (#135)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();

    // A JSON body, no BEEF: the filter passes it as it is and validates nothing.
    var pkg = cbor.MapBuilder.init(a);
    try pkg.put("kind", cbor.string("http"));
    try pkg.put("body", .{ .bytes = "{\"hello\": \"world\"}" });
    const x = try door.filterBeef(a, s, pkg.value());
    try std.testing.expect(x.refused == null);
    try std.testing.expectEqual(@as(usize, 0), x.beefs.len);
    try std.testing.expectEqualStrings(door.NOTHING_VALIDATED, door.nothingValidated(false, x).?);
    try std.testing.expect(door.nothingValidated(true, x) == null);

    // A filter's own refusal stands as it is (no second reason); a BEEF that decoded validates.
    const refused: door.Filtered = .{ .value = pkg.value(), .beefs = &.{}, .refused = "a BEEF that does not decode" };
    try std.testing.expect(door.nothingValidated(false, refused) == null);
    const one: []const []const u8 = &.{"cid"};
    const validated: door.Filtered = .{ .value = pkg.value(), .beefs = one };
    try std.testing.expect(door.nothingValidated(false, validated) == null);
}

/// A transaction: one input (`prev`:`vout`, unlocking script `unlock`), outputs of 1000 sat each with
/// the locking scripts given, locktime 0.
fn txOf(a: std.mem.Allocator, prev: [32]u8, vout: u8, unlock: []const u8, locks: []const []const u8) ![]u8 {
    var o: std.ArrayList(u8) = .empty;
    try o.appendSlice(a, &.{ 1, 0, 0, 0, 1 });
    try o.appendSlice(a, &prev);
    try o.appendSlice(a, &.{ vout, 0, 0, 0, @intCast(unlock.len) });
    try o.appendSlice(a, unlock);
    try o.appendSlice(a, &.{ 0xff, 0xff, 0xff, 0xff, @intCast(locks.len) });
    for (locks) |l| {
        try o.appendSlice(a, &.{ 0xe8, 3, 0, 0, 0, 0, 0, 0, @intCast(l.len) });
        try o.appendSlice(a, l);
    }
    try o.appendSlice(a, &.{ 0, 0, 0, 0 });
    return o.items;
}

test "door: the BEEF proven, always (#121) — an unproven child of a proven parent passes; no parent, a txid-only parent, a failing script are refused, nothing stored" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();

    // A parent mined at height 200 (beside a sibling in a two-transaction block): output 0 OP_TRUE,
    // output 1 OP_FALSE. Its BUMP, and a header at 200 whose merkle root it gives.
    const parent = try txOf(a, [_]u8{0x11} ** 32, 0, &.{}, &.{ &.{0x51}, &.{0x00} });
    const ptxid = beef.txidOf(parent);
    const sib = [_]u8{0x22} ** 32;
    var bump: std.ArrayList(u8) = .empty;
    try bump.appendSlice(a, &.{ 0xc8, 1, 2, 0, 0 }); // height 200, depth 1, two leaves: offset 0 (a hash)
    try bump.appendSlice(a, &sib);
    try bump.appendSlice(a, &.{ 1, 2 }); // offset 1, a client txid
    try bump.appendSlice(a, &ptxid);
    const header = try a.alloc(u8, 80);
    @memset(header, 0);
    header[0] = 1;
    header[36..68].* = cidm.dblSha256(&(sib ++ ptxid));
    try chainState(a, s, 200, header);

    // The child spends output 0 (OP_TRUE: an empty unlocking script verifies); unmined.
    const child = try txOf(a, ptxid, 0, &.{}, &.{&.{0x51}});
    const v1 = try std.mem.concat(a, u8, &.{ &.{ 1, 0, 0xbe, 0xef, 1 }, bump.items, &.{2}, parent, &.{ 1, 0 }, child, &.{0} });
    var pkg = cbor.MapBuilder.init(a);
    try pkg.put("body", .{ .bytes = v1 });
    const got = try door.filterBeef(a, s, pkg.value());
    try std.testing.expectEqual(@as(?[]const u8, null), got.refused);
    const rec = (try s.get(a, got.beefs[0])).?;
    // marks [0, null]; the BUMP proves the parent only (the verifier's proven: [true, false]).
    const marks = rec.get("marks").?.array;
    try std.testing.expectEqual(@as(?i128, 0), Value.intOf(marks[0]));
    try std.testing.expect(marks[1] == .null);
    const b0 = rec.get("bumps").?.array[0];
    const proves = b0.get("proves").?.array;
    try std.testing.expectEqual(@as(usize, 1), proves.len);
    try std.testing.expectEqual(@as(?i128, 0), Value.intOf(proves[0]));
    try std.testing.expectEqualSlices(u8, try cidm.ofBitcoin(a, cidm.BITCOIN_BLOCK, header), Value.cidOf(b0.get("block")).?);
    try std.testing.expect(try s.has(try beef.txCid(a, beef.txidOf(child))));
    try std.testing.expectEqualSlices(u8, v1, Value.bytesOf((try door.restore(a, s, got.value, got.beefs)).get("body")).?);

    const held = (try ss.allCids(a)).len;
    const refusedWith = struct {
        fn f(al: std.mem.Allocator, st: Store, bytes: []const u8, name: []const u8) !void {
            var m = cbor.MapBuilder.init(al);
            try m.put("body", .{ .bytes = bytes });
            const r = try door.filterBeef(al, st, m.value());
            try std.testing.expect(r.refused != null);
            if (!std.mem.startsWith(u8, r.refused.?, name)) {
                std.debug.print("refused: {s}, expected {s}\n", .{ r.refused.?, name });
                return error.TestUnexpectedResult;
            }
            try std.testing.expectEqual(@as(usize, 0), r.beefs.len);
        }
    }.f;
    // Another child, alone: no BUMP, its parent not in the BEEF (Atomic BEEF) — MissingInput.
    const lone = try txOf(a, ptxid, 0, &.{}, &.{&.{ 0x51, 0x51 }});
    const ltxid = beef.txidOf(lone);
    try refusedWith(a, s, try std.mem.concat(a, u8, &.{ &.{ 1, 1, 1, 1 }, &ltxid, &.{ 1, 0, 0xbe, 0xef, 0, 1 }, lone, &.{0} }), "MissingInput");
    // The parent as a txid-only entry (V2): UnknownTxidOnly (nothing is known beside the BEEF).
    try refusedWith(a, s, try std.mem.concat(a, u8, &.{ &.{ 2, 0, 0xbe, 0xef, 0, 2, 2 }, &ptxid, &.{0}, lone }), "UnknownTxidOnly");
    // A child spending output 1 (OP_FALSE): ScriptFailed.
    const fails = try txOf(a, ptxid, 1, &.{}, &.{&.{0x51}});
    try refusedWith(a, s, try std.mem.concat(a, u8, &.{ &.{ 1, 0, 0xbe, 0xef, 1 }, bump.items, &.{2}, parent, &.{ 1, 0 }, fails, &.{0} }), "ScriptFailed");
    // Nothing of the refused ones was stored.
    try std.testing.expectEqual(held, (try ss.allCids(a)).len);
    try std.testing.expect(!(try s.has(try beef.txCid(a, ltxid))));
}
