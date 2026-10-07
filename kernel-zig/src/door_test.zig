// The `beef` filter (door.zig) over a store with a chain state: the BUMP
// check against chain/state's headers, the blocks it stores (each once),
// the package it hands back (no BEEF bytes, a link to the pointer record),
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
    // The package names the pointer record, not the bytes.
    const body = got.value.get("body").?;
    try std.testing.expect(body == .cid);
    try std.testing.expectEqualSlices(u8, got.beefs[0], body.cid);
    try std.testing.expect(!contains(try cbor.encode(a, got.value), wire));
    const rec = (try s.get(a, body.cid)).?;
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

    // A BUMP whose sibling is changed: its root is not the header's — rejected (#143: nothing stored, no entry names it).
    const bad_wire = try a.dupe(u8, wire);
    bad_wire[5 + 5] ^= 0xff;
    var bad = cbor.MapBuilder.init(a);
    try bad.put("body", .{ .bytes = bad_wire });
    const held = (try ss.allCids(a)).len;
    const r = try door.filterBeef(a, s, bad.value());
    try std.testing.expect(r.refused != null);
    try std.testing.expect(contains(r.refused.?, "merkle root"));
    try std.testing.expect(r.value.get("body").? == .cid);
    try std.testing.expectEqual(held, (try ss.allCids(a)).len);
    try std.testing.expect(!(try s.has(r.beefs[0])));

    // A BUMP at a height chain/state has no header for: refused.
    var hi = try a.dupe(u8, wire);
    hi[5] = 0xab;
    var h = cbor.MapBuilder.init(a);
    try h.put("body", .{ .bytes = hi });
    const r2 = try door.filterBeef(a, s, h.value());
    try std.testing.expect(contains(r2.refused.?, "no header at height 171"));

    // Bytes that are not a BEEF pass as they are; a byte string deeper in the package is walked too.
    var plain = cbor.MapBuilder.init(a);
    try plain.put("body", .{ .bytes = "{\"not\": \"beef\"}" });
    const inner = try a.alloc(Value, 1);
    inner[0] = .{ .bytes = wire };
    try plain.put("args", .{ .array = inner });
    const p = try door.filterBeef(a, s, plain.value());
    try std.testing.expect(p.refused == null);
    try std.testing.expect(p.value.get("body").? == .bytes);
    try std.testing.expect(p.value.get("args").?.array[0] == .cid);
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

// ---------------------------------------------------------------- kernel.brc169 (#144)

// A BRC-169 §7.3 envelope from key 7 to key 9 (@alice+fund@skein.test), signed with @bsv/sdk's
// ProtoWallet ([2, "metanet handles envelope"], "send", anyone), carried in a BRC-231 sendMessage to
// box metanet_inbox; its content a BRC-78 frame over an opaque ciphertext the test signer "opens"
// to the plaintext below (the decryption itself is the signer's).
const SENDER = "025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc";
const RECIPIENT = "03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe";
const REQUEST = "a1676d657373616765a364626f647959019da86673656e646572a16b6964656e746974794b65795821025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc67636f6e74656e74586e42421033025cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc03acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe05050505050505050505050505050505050505050505050505050505050505050102030405060708676372656174656474323032362d31302d30385430303a30303a30305a677061796d656e74f669726563697069656e74a3637461676466756e6466646f6d61696e6a736b65696e2e746573746668616e646c6565616c696365697369676e617475726558473045022100ec20ac45e163009e93d9f5535cfbf7a714cf668f24d64913ba2919c29f98cc2202204ff5fa67c1e72a0aa40668384c895c21bbd4e3328ecedfd85d931f384a84304f6b636f6e74656e7448617368582084f6f4254fce7e279b9eb709c42b749e0eddb8d161511a6fb45ac09a0cb87d706e6d6574616e657448616e646c657363312e3069726563697069656e74582103acd484e2f0c7f65309ad178a9f559abde09796974c57e714c35f110dfc27ccbe6a6d657373616765426f786d6d6574616e65745f696e626f78";
const PLAIN = "Content-Type: text/plain\r\n\r\nhello skein";

/// The test's signer: a decrypt frame (call 12) under [2, "message encryption"], counterparty the
/// sender, over the fixture's ciphertext, answered 0 ‖ `plain`; anything else fails.
const Opener = struct {
    plain: []const u8,
    sender: []const u8,
    asked: usize = 0,
    fn call(ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8 {
        const o: *Opener = @ptrCast(@alignCast(ctx));
        o.asked += 1;
        const key_id = "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=";
        const want = try @import("signer.zig").decryptFrame(a, door.MESSAGE_ENCRYPTION, key_id, .{ .other = o.sender }, &.{ 1, 2, 3, 4, 5, 6, 7, 8 });
        if (!std.mem.eql(u8, frame, want)) return error.UnexpectedFrame;
        return std.mem.concat(a, u8, &.{ &.{0}, o.plain });
    }
};

fn httpRequest(a: std.mem.Allocator, body: []const u8, ct: []const u8) !Value {
    var h = cbor.MapBuilder.init(a);
    try h.put("content-type", cbor.string(ct));
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("http"));
    try m.put("method", cbor.string("POST"));
    try m.put("path", cbor.string("/sendMessage"));
    try m.put("route", cbor.string("/sendMessage"));
    try m.put("query", cbor.string(""));
    try m.put("headers", h.value());
    try m.put("body", .{ .bytes = body });
    return m.value();
}

/// The fixture's request with one member of the envelope replaced (a change the signature covers).
fn tampered(a: std.mem.Allocator, key: []const u8, v: Value) ![]u8 {
    const r = try cbor.decode(a, try unhex(a, REQUEST));
    const m = r.get("message").?;
    const e = try cbor.decode(a, Value.bytesOf(m.get("body")).?);
    var e2 = cbor.MapBuilder.init(a);
    for (e.map) |x| try e2.put(x.key, if (std.mem.eql(u8, x.key, key)) v else x.value);
    var m2 = cbor.MapBuilder.init(a);
    for (m.map) |x| try m2.put(x.key, if (std.mem.eql(u8, x.key, "body")) Value{ .bytes = try cbor.encode(a, e2.value()) } else x.value);
    var r2 = cbor.MapBuilder.init(a);
    try r2.put("message", m2.value());
    return cbor.encode(a, r2.value());
}

test "door: kernel.brc169 opens a BRC-169 envelope to this skein — principal the sender, the plaintext handed on, replays refused" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();
    const sender = try unhex(a, SENDER);
    const me: door.Self = .{ .identity = try unhex(a, RECIPIENT), .handle = "alice", .domain = "skein.test" };
    var op = Opener{ .plain = PLAIN, .sender = sender };
    const sg: door.Signer = .{ .ctx = &op, .call = Opener.call };
    const req = try httpRequest(a, try unhex(a, REQUEST), "application/cbor");

    const got = try door.brc169(a, s, sg, req, me);
    try std.testing.expect(got == .pass);
    const p = got.pass;
    try std.testing.expectEqualSlices(u8, sender, p.principal);
    // The package handed on: the same http request, its message body the plaintext, the signed part linked.
    try std.testing.expectEqualStrings("http", Value.str(p.request.get("kind")).?);
    try std.testing.expectEqualSlices(u8, p.signed_cid, Value.cidOf(p.request.get("envelope")).?);
    const body = try cbor.decode(a, Value.bytesOf(p.request.get("body")).?);
    const msg = body.get("message").?;
    try std.testing.expectEqualStrings(PLAIN, Value.bytesOf(msg.get("body")).?);
    try std.testing.expectEqualStrings("metanet_inbox", Value.str(msg.get("messageBox")).?);
    // The signed part: the envelope without its content (the signature kept).
    const signed = try cbor.decode(a, p.signed_bytes);
    try std.testing.expect(signed.get("content") == null);
    try std.testing.expect(signed.get("signature") != null);
    try std.testing.expectEqualStrings("fund", Value.str(signed.get("recipient").?.get("tag")).?);

    // Held (the door stores it on a pass): the same envelope again is a replay.
    try s.putBlock(p.signed_cid, p.signed_bytes);
    const again = try door.brc169(a, s, sg, req, me);
    try std.testing.expectEqual(@as(i64, 409), again.reject.status);
}

test "door: kernel.brc169 refuses a bad signature, another recipient, a contentHash that does not match; no envelope is BRC-104's" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();
    const sender = try unhex(a, SENDER);
    const me: door.Self = .{ .identity = try unhex(a, RECIPIENT), .handle = "alice", .domain = "skein.test" };
    var op = Opener{ .plain = PLAIN, .sender = sender };
    const sg: door.Signer = .{ .ctx = &op, .call = Opener.call };

    // A member the signature covers, changed: 401.
    const forged = try door.brc169(a, s, sg, try httpRequest(a, try tampered(a, "created", cbor.string("2026-10-09T00:00:00Z")), "application/cbor"), me);
    try std.testing.expectEqual(@as(i64, 401), forged.reject.status);
    try std.testing.expectEqualStrings("ERR_ENVELOPE_SIGNATURE", forged.reject.code.?);
    // Another skein's handle, or another identity: 403, nothing decrypted.
    const asked = op.asked;
    const bob = try door.brc169(a, s, sg, try httpRequest(a, try unhex(a, REQUEST), "application/cbor"), .{ .identity = me.identity, .handle = "bob", .domain = "skein.test" });
    try std.testing.expectEqual(@as(i64, 403), bob.reject.status);
    const other = try door.brc169(a, s, sg, try httpRequest(a, try unhex(a, REQUEST), "application/cbor"), .{ .identity = sender, .handle = "alice", .domain = "skein.test" });
    try std.testing.expectEqual(@as(i64, 403), other.reject.status);
    try std.testing.expectEqual(asked, op.asked);
    // The content opens to something else than what the sender hashed: 400.
    var liar = Opener{ .plain = "Content-Type: text/plain\r\n\r\nsomething else", .sender = sender };
    const mismatched = try door.brc169(a, s, .{ .ctx = &liar, .call = Opener.call }, try httpRequest(a, try unhex(a, REQUEST), "application/cbor"), me);
    try std.testing.expectEqualStrings("ERR_CONTENT_HASH", mismatched.reject.code.?);
    // No contentHash: this skein requires one.
    const unhashed = try door.brc169(a, s, sg, try httpRequest(a, try tampered(a, "contentHash", .null), "application/cbor"), me);
    try std.testing.expectEqualStrings("ERR_CONTENT_HASH", unhashed.reject.code.?);
    // No envelope (JSON, or a dag-cbor body that is none): the BRC-104 check stands.
    try std.testing.expect(try door.brc169(a, s, sg, try httpRequest(a, "{\"message\":{}}", "application/json"), me) == .not_envelope);
    var plain = cbor.MapBuilder.init(a);
    var pm = cbor.MapBuilder.init(a);
    try pm.put("recipient", .{ .bytes = me.identity });
    try pm.put("messageBox", cbor.string("chat"));
    try pm.put("body", .{ .bytes = try cbor.encode(a, cbor.string("hi")) });
    try plain.put("message", pm.value());
    try std.testing.expect(try door.brc169(a, s, sg, try httpRequest(a, try cbor.encode(a, plain.value()), "application/cbor"), me) == .not_envelope);
    // Nothing was stored by any of it.
    const signed = try cbor.block(a, try cbor.without(a, try cbor.decode(a, Value.bytesOf((try cbor.decode(a, try unhex(a, REQUEST))).get("message").?.get("body")).?), "content"));
    try std.testing.expect(!(try s.has(signed.cid)));
}
