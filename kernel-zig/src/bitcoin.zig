// Bitcoin blocks decoded the IPLD way (issue #42): typed nodes with links,
// after IPLD's bitcoin codecs (@ipld/bitcoin), with bitcoind's field names.
// The bytes stay what they are (`putblock` takes them raw and hash-checks
// them: cid.zig); this is how the kernel reads them.
//
//   bitcoin-block (0xb0), an 80-byte header:
//     {version, previousblockhash → link(bitcoin-block) | null (genesis),
//      merkleroot → link(bitcoin-tx), time, bits, nonce}
//   bitcoin-tx (0xb1), a transaction:
//     {version, vin: [{txid → link(bitcoin-tx), vout, script, sequence}
//                     | {coinbase: bytes, sequence}],
//      vout: [{value, script}], locktime}
//   bitcoin-tx (0xb1), exactly 64 bytes: a merkle tree node
//     [left → link(bitcoin-tx), right → link(bitcoin-tx)]
//
// The 64-byte case is IPLD's convention: a node of a block's transaction
// merkle tree is left hash ‖ right hash, its CID (dbl-sha2-256) its merkle
// hash, and it lives under bitcoin-tx because the tree's leaves are
// transactions. A 64-byte transaction would be ambiguous; it is malformed by
// consensus-adjacent convention (Core refuses them since the merkle-tree
// weakness they open, CVE-2017-12842), so 64 bytes is always read as a node.
// IPLD's reference decoder tries a transaction first; we take the length
// alone, which never differs for a well-formed transaction.
//
// Forward links (`links`, what packets and readers follow):
//   a transaction's inputs   → to the spent txid, rel `spends`, locator = vout
//                              (a coinbase input links nothing)
//   a header                 → previous header, rel `prev`; merkle root, rel `merkleroot`
//   a merkle node            → left, right: rel `child`, locator 0 / 1
//
// Edges (`edgesOf`, #42 decided 2026-09-30): only a transaction's inputs go
// into the kernel's edges index (index.zig) when a thread keeps the block,
// from the block itself (its CID, seq 0, ord = the input's position among
// the non-coinbase inputs). Headers and merkle nodes contribute none: nothing
// asks the reverse questions, and a proof reads downward from the root.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const Value = cbor.Value;

pub const Error = error{ Malformed, OutOfMemory };

/// One link out of a bitcoin block: its target (a binary CID), rel, locator.
pub const Link = struct { to: []const u8, rel: []const u8, locator: ?i64 = null };

/// A bitcoin codec (bitcoin-block, bitcoin-tx) with dbl-sha2-256.
pub fn isBitcoin(c: []const u8) bool {
    const p = cidm.parts(c) catch return false;
    return (p.codec == cidm.BITCOIN_BLOCK or p.codec == cidm.BITCOIN_TX) and p.mh == cidm.DBL_SHA2_256;
}

pub const MERKLE_NODE_SIZE = 64;
pub const HEADER_SIZE = 80;

fn hashLink(a: std.mem.Allocator, codec: u64, h: []const u8) ![]u8 {
    return cidm.create(a, codec, cidm.DBL_SHA2_256, h);
}

fn isNull(h: []const u8) bool {
    for (h) |b| if (b != 0) return false;
    return true;
}

// ---------------------------------------------------------------- transactions

const Reader = struct {
    b: []const u8,
    i: usize = 0,

    fn take(r: *Reader, n: usize) Error![]const u8 {
        if (n > r.b.len - r.i) return error.Malformed;
        defer r.i += n;
        return r.b[r.i .. r.i + n];
    }
    fn u32le(r: *Reader) Error!u32 {
        return std.mem.readInt(u32, (try r.take(4))[0..4], .little);
    }
    fn u64le(r: *Reader) Error!u64 {
        return std.mem.readInt(u64, (try r.take(8))[0..8], .little);
    }
    fn varint(r: *Reader) Error!u64 {
        const f = (try r.take(1))[0];
        return switch (f) {
            0xfd => std.mem.readInt(u16, (try r.take(2))[0..2], .little),
            0xfe => try r.u32le(),
            0xff => try r.u64le(),
            else => f,
        };
    }
    fn count(r: *Reader, min_size: usize) Error!usize {
        const n = try r.varint();
        if (n > (r.b.len - r.i) / min_size) return error.Malformed;
        return @intCast(n);
    }
    fn bytes(r: *Reader) Error![]const u8 {
        const n = try r.varint();
        if (n > r.b.len - r.i) return error.Malformed;
        return r.take(@intCast(n));
    }
};

pub const Input = struct { prev: [32]u8, vout: u32, script: []const u8, sequence: u32 };
pub const Output = struct { value: u64, script: []const u8 };
pub const Tx = struct { version: i32, inputs: []Input, outputs: []Output, locktime: u32 };

/// A transaction's standard serialization (no segwit: BSV).
pub fn parseTx(a: std.mem.Allocator, b: []const u8) Error!Tx {
    var r = Reader{ .b = b };
    const version: i32 = @bitCast(try r.u32le());
    const ins = try a.alloc(Input, try r.count(41));
    for (ins) |*in| in.* = .{ .prev = (try r.take(32))[0..32].*, .vout = try r.u32le(), .script = try r.bytes(), .sequence = try r.u32le() };
    const outs = try a.alloc(Output, try r.count(9));
    for (outs) |*o| o.* = .{ .value = try r.u64le(), .script = try r.bytes() };
    const locktime = try r.u32le();
    if (r.i != b.len) return error.Malformed;
    return .{ .version = version, .inputs = ins, .outputs = outs, .locktime = locktime };
}

fn isCoinbase(in: Input) bool {
    return in.vout == 0xffffffff and isNull(&in.prev);
}

// ---------------------------------------------------------------- decode

/// The typed node for a bitcoin block's bytes (see the header).
pub fn decode(a: std.mem.Allocator, codec: u64, b: []const u8) Error!Value {
    if (codec == cidm.BITCOIN_BLOCK) {
        if (b.len != HEADER_SIZE) return error.Malformed;
        var m = cbor.MapBuilder.init(a);
        try m.put("version", cbor.int(@as(i32, @bitCast(std.mem.readInt(u32, b[0..4], .little)))));
        try m.put("previousblockhash", if (isNull(b[4..36])) .null else .{ .cid = try hashLink(a, cidm.BITCOIN_BLOCK, b[4..36]) });
        try m.put("merkleroot", .{ .cid = try hashLink(a, cidm.BITCOIN_TX, b[36..68]) });
        try m.put("time", cbor.int(std.mem.readInt(u32, b[68..72], .little)));
        try m.put("bits", cbor.int(std.mem.readInt(u32, b[72..76], .little)));
        try m.put("nonce", cbor.int(std.mem.readInt(u32, b[76..80], .little)));
        return m.value();
    }
    if (codec != cidm.BITCOIN_TX) return error.Malformed;
    if (b.len == MERKLE_NODE_SIZE) {
        const pair = try a.alloc(Value, 2);
        pair[0] = .{ .cid = try hashLink(a, cidm.BITCOIN_TX, b[0..32]) };
        pair[1] = .{ .cid = try hashLink(a, cidm.BITCOIN_TX, b[32..64]) };
        return .{ .array = pair };
    }
    const tx = try parseTx(a, b);
    const vin = try a.alloc(Value, tx.inputs.len);
    for (tx.inputs, vin) |in, *v| {
        var m = cbor.MapBuilder.init(a);
        if (isCoinbase(in)) {
            try m.put("coinbase", .{ .bytes = in.script });
        } else {
            try m.put("txid", .{ .cid = try hashLink(a, cidm.BITCOIN_TX, &in.prev) });
            try m.put("vout", cbor.int(in.vout));
            try m.put("script", .{ .bytes = in.script });
        }
        try m.put("sequence", cbor.int(in.sequence));
        v.* = m.value();
    }
    const vout = try a.alloc(Value, tx.outputs.len);
    for (tx.outputs, vout) |o, *v| {
        var m = cbor.MapBuilder.init(a);
        try m.put("value", cbor.int(o.value));
        try m.put("script", .{ .bytes = o.script });
        v.* = m.value();
    }
    var m = cbor.MapBuilder.init(a);
    try m.put("version", cbor.int(tx.version));
    try m.put("vin", .{ .array = vin });
    try m.put("vout", .{ .array = vout });
    try m.put("locktime", cbor.int(tx.locktime));
    return m.value();
}

/// The links a bitcoin block holds, in order (the edges it contributes; see the header).
pub fn links(a: std.mem.Allocator, codec: u64, b: []const u8) Error![]Link {
    var out = std.array_list.Managed(Link).init(a);
    if (codec == cidm.BITCOIN_BLOCK) {
        if (b.len != HEADER_SIZE) return error.Malformed;
        if (!isNull(b[4..36])) try out.append(.{ .to = try hashLink(a, cidm.BITCOIN_BLOCK, b[4..36]), .rel = "prev" });
        try out.append(.{ .to = try hashLink(a, cidm.BITCOIN_TX, b[36..68]), .rel = "merkleroot" });
    } else if (codec == cidm.BITCOIN_TX and b.len == MERKLE_NODE_SIZE) {
        try out.append(.{ .to = try hashLink(a, cidm.BITCOIN_TX, b[0..32]), .rel = "child", .locator = 0 });
        try out.append(.{ .to = try hashLink(a, cidm.BITCOIN_TX, b[32..64]), .rel = "child", .locator = 1 });
    } else if (codec == cidm.BITCOIN_TX) {
        const tx = try parseTx(a, b);
        for (tx.inputs) |in| {
            if (isCoinbase(in)) continue;
            try out.append(.{ .to = try hashLink(a, cidm.BITCOIN_TX, &in.prev), .rel = "spends", .locator = in.vout });
        }
    } else return error.Malformed;
    return out.items;
}

/// The links of the block a CID names, given its bytes; none when it is not a
/// bitcoin block or does not decode (a malformed transaction links nothing).
pub fn linksOf(a: std.mem.Allocator, c: []const u8, b: []const u8) ![]Link {
    if (!isBitcoin(c)) return &.{};
    return links(a, cidm.codecOf(c), b) catch |e| switch (e) {
        error.Malformed => &.{},
        error.OutOfMemory => error.OutOfMemory,
    };
}

/// The edges a kept bitcoin block contributes (see the header): a
/// transaction's `spends` links; none for a header, a merkle node, a block
/// that is not bitcoin, or one that does not decode.
pub fn edgesOf(a: std.mem.Allocator, c: []const u8, b: []const u8) ![]Link {
    if (!isBitcoin(c) or cidm.codecOf(c) != cidm.BITCOIN_TX or b.len == MERKLE_NODE_SIZE) return &.{};
    return linksOf(a, c, b);
}

// ---------------------------------------------------------------- tests

fn hex(a: std.mem.Allocator, s: []const u8) ![]u8 {
    const out = try a.alloc(u8, s.len / 2);
    _ = try std.fmt.hexToBytes(out, s);
    return out;
}

fn displayHash(c: []const u8) [64]u8 {
    var d: [32]u8 = (cidm.parts(c) catch unreachable).digest[0..32].*;
    std.mem.reverse(u8, &d);
    return std.fmt.bytesToHex(d, .lower);
}

test "bitcoin-block: mainnet block 170's header, typed, with its links" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const b = try hex(a, "0100000055bd840a78798ad0da853f68974f3d183e2bd1db6a842c1feecf222a00000000ff104ccb05421ab93e63f8c3ce5c2c2e9dbb37de2764b3a3175c8166562cac7d51b96a49ffff001d283e9e70");
    const c = try cidm.ofBitcoin(a, cidm.BITCOIN_BLOCK, b);
    try std.testing.expectEqualStrings("00000000d1145790a8694403d4063f323d499e655c83426834d4ce2f8dd4a2ee", &displayHash(c));
    const v = try decode(a, cidm.BITCOIN_BLOCK, b);
    try std.testing.expectEqual(@as(i128, 1), Value.intOf(v.get("version")).?);
    const prev = Value.cidOf(v.get("previousblockhash")).?;
    try std.testing.expectEqual(cidm.BITCOIN_BLOCK, cidm.codecOf(prev));
    try std.testing.expectEqualStrings("000000002a22cfee1f2c846adbd12b3e183d4f97683f85dad08a79780a84bd55", &displayHash(prev));
    const root = Value.cidOf(v.get("merkleroot")).?;
    try std.testing.expectEqual(cidm.BITCOIN_TX, cidm.codecOf(root));
    try std.testing.expectEqualStrings("7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff", &displayHash(root));
    try std.testing.expectEqual(@as(i128, 1231731025), Value.intOf(v.get("time")).?);
    try std.testing.expectEqual(@as(i128, 0x1d00ffff), Value.intOf(v.get("bits")).?);
    try std.testing.expectEqual(@as(i128, 1889418792), Value.intOf(v.get("nonce")).?);
    const ls = try links(a, cidm.BITCOIN_BLOCK, b);
    try std.testing.expectEqual(@as(usize, 2), ls.len);
    try std.testing.expectEqualStrings("prev", ls[0].rel);
    try std.testing.expectEqualSlices(u8, prev, ls[0].to);
    try std.testing.expectEqualStrings("merkleroot", ls[1].rel);
    try std.testing.expectEqualSlices(u8, root, ls[1].to);
    // The genesis header links no previous block.
    const g = try hex(a, "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c");
    try std.testing.expect((try decode(a, cidm.BITCOIN_BLOCK, g)).get("previousblockhash").? == .null);
    try std.testing.expectEqual(@as(usize, 1), (try links(a, cidm.BITCOIN_BLOCK, g)).len);
    try std.testing.expectError(error.Malformed, decode(a, cidm.BITCOIN_BLOCK, b[0..79]));
    // A header contributes no edges.
    try std.testing.expectEqual(@as(usize, 0), (try edgesOf(a, c, b)).len);
}

test "bitcoin-tx: block 170's spend (inputs link what they spend) and the genesis coinbase (links nothing)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const b = try hex(a, "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000");
    const c = try cidm.ofBitcoin(a, cidm.BITCOIN_TX, b);
    try std.testing.expectEqualStrings("f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16", &displayHash(c));
    const v = try decode(a, cidm.BITCOIN_TX, b);
    try std.testing.expectEqual(@as(i128, 1), Value.intOf(v.get("version")).?);
    try std.testing.expectEqual(@as(i128, 0), Value.intOf(v.get("locktime")).?);
    const vin = v.get("vin").?.array;
    try std.testing.expectEqual(@as(usize, 1), vin.len);
    const spent = Value.cidOf(vin[0].get("txid")).?;
    try std.testing.expectEqual(cidm.BITCOIN_TX, cidm.codecOf(spent));
    try std.testing.expectEqualStrings("0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9", &displayHash(spent));
    try std.testing.expectEqual(@as(i128, 0), Value.intOf(vin[0].get("vout")).?);
    try std.testing.expectEqual(@as(i128, 0xffffffff), Value.intOf(vin[0].get("sequence")).?);
    try std.testing.expectEqual(@as(usize, 72), Value.bytesOf(vin[0].get("script")).?.len);
    const vout = v.get("vout").?.array;
    try std.testing.expectEqual(@as(usize, 2), vout.len);
    try std.testing.expectEqual(@as(i128, 1_000_000_000), Value.intOf(vout[0].get("value")).?);
    try std.testing.expectEqual(@as(i128, 4_000_000_000), Value.intOf(vout[1].get("value")).?);
    try std.testing.expectEqual(@as(usize, 67), Value.bytesOf(vout[1].get("script")).?.len);
    const ls = try links(a, cidm.BITCOIN_TX, b);
    try std.testing.expectEqual(@as(usize, 1), ls.len);
    try std.testing.expectEqualStrings("spends", ls[0].rel);
    try std.testing.expectEqual(@as(?i64, 0), ls[0].locator);
    try std.testing.expectEqualSlices(u8, spent, ls[0].to);
    try std.testing.expectEqual(@as(usize, 1), (try edgesOf(a, c, b)).len);
    // The node encodes as dag-cbor (links as tag 42).
    _ = try cbor.encode(a, v);

    const cb = try hex(a, "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000");
    const cv = try decode(a, cidm.BITCOIN_TX, cb);
    const cin = cv.get("vin").?.array[0];
    try std.testing.expect(cin.get("txid") == null);
    try std.testing.expectEqual(@as(usize, 77), Value.bytesOf(cin.get("coinbase")).?.len);
    try std.testing.expectEqual(@as(usize, 0), (try links(a, cidm.BITCOIN_TX, cb)).len);
    // Truncated or trailing bytes: malformed (no links, for the index).
    try std.testing.expectError(error.Malformed, decode(a, cidm.BITCOIN_TX, b[0 .. b.len - 1]));
    try std.testing.expectEqual(@as(usize, 0), (try linksOf(a, c, b[0 .. b.len - 1])).len);
}

test "bitcoin-tx, 64 bytes: a merkle node [left, right] (block 170's root over its two txids)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const left = try hex(a, "b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082");
    const right = try hex(a, "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16");
    std.mem.reverse(u8, left);
    std.mem.reverse(u8, right);
    const node = try std.mem.concat(a, u8, &.{ left, right });
    const c = try cidm.ofBitcoin(a, cidm.BITCOIN_TX, node);
    try std.testing.expectEqualStrings("7dac2c5666815c17a3b36427de37bb9d2e2c5ccec3f8633eb91a4205cb4c10ff", &displayHash(c));
    try std.testing.expect(cidm.hashMatches(c, node));
    const v = try decode(a, cidm.BITCOIN_TX, node);
    try std.testing.expectEqual(@as(usize, 2), v.array.len);
    try std.testing.expectEqualStrings("b1fea52486ce0c62bb442b530a3f0132b826c74e473d1f2c220bfa78111c5082", &displayHash(v.array[0].cid));
    try std.testing.expectEqualStrings("f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16", &displayHash(v.array[1].cid));
    const ls = try linksOf(a, c, node);
    try std.testing.expectEqual(@as(usize, 2), ls.len);
    try std.testing.expectEqualStrings("child", ls[0].rel);
    try std.testing.expectEqual(@as(?i64, 0), ls[0].locator);
    try std.testing.expectEqual(@as(?i64, 1), ls[1].locator);
    try std.testing.expectEqual(cidm.BITCOIN_TX, cidm.codecOf(ls[1].to));
    // A merkle node contributes no edges.
    try std.testing.expectEqual(@as(usize, 0), (try edgesOf(a, c, node)).len);
}
