// Host-signed recorded calls (issue #62). Every `http` and `libp2p` call a
// step makes is answered by the host and recorded on the step's update; the
// host signs each exchange, and the signature is kept in the record:
//
//   attest    {stamp: ms, key: bytes(33), signature: bytes (DER)}
//   preimage  dag-cbor {op, instance, request: sha256(request bytes),
//                       response: sha256(response bytes), stamp}   (canonical)
//
// `stamp` is the host's clock when it answered, `instance` the genesis's
// handle, `key` the host's attest key: a BRC-42 child of its master under
// [2, "skein router"], key ID "attest" (src/host/oracle.ts). The signature is
// ECDSA over sha256(preimage), as @bsv/sdk's PrivateKey.sign makes it. The
// genesis's `attest` names the key, so a reader of the log alone can check
// every recorded call; a genesis without one asks for no attestation.
const std = @import("std");
const cbor = @import("cbor.zig");
const secp = @import("secp.zig");
const Value = cbor.Value;

/// The ops a host attests (the wallet's answers are signatures already).
pub fn attested(op: []const u8) bool {
    return std.mem.eql(u8, op, "http") or std.mem.eql(u8, op, "libp2p");
}

/// The attest key a genesis names, if any (33 bytes).
pub fn keyOf(genesis: ?Value) ?[]const u8 {
    const g = genesis orelse return null;
    return Value.bytesOf(g.get("attest"));
}

/// The bytes the host signs for one exchange.
pub fn preimage(a: std.mem.Allocator, op: []const u8, instance: []const u8, request: []const u8, response: []const u8, stamp: i128) ![]u8 {
    var rq: [32]u8 = undefined;
    var rs: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(request, &rq, .{});
    std.crypto.hash.sha2.Sha256.hash(response, &rs, .{});
    var m = cbor.MapBuilder.init(a);
    try m.put("op", cbor.string(op));
    try m.put("instance", cbor.string(instance));
    try m.put("request", .{ .bytes = &rq });
    try m.put("response", .{ .bytes = &rs });
    try m.put("stamp", cbor.int(stamp));
    return cbor.encode(a, m.value());
}

/// Why a recorded exchange's attestation does not hold against the genesis,
/// or null when it does — or when the genesis names no attest key (nothing is
/// asked of the record then).
pub fn problem(a: std.mem.Allocator, genesis: ?Value, op: []const u8, request: []const u8, response: []const u8, attest: ?Value) !?[]const u8 {
    const want = keyOf(genesis) orelse return null;
    if (!attested(op)) return null;
    const at = attest orelse return "no attestation (the genesis names the host's attest key)";
    if (at != .map) return "the attestation is not a map";
    const stamp = Value.intOf(at.get("stamp")) orelse return "the attestation has no stamp";
    const key = Value.bytesOf(at.get("key")) orelse return "the attestation has no key";
    const sig = Value.bytesOf(at.get("signature")) orelse return "the attestation has no signature";
    if (!std.mem.eql(u8, key, want)) return "the attestation is by another key than the genesis's";
    const instance = Value.str(genesis.?.get("handle")) orelse "";
    const pre = try preimage(a, op, instance, request, response, stamp);
    const pk = std.crypto.ecc.Secp256k1.fromSec1(key) catch return "the attest key is not a point";
    if (!secp.verify(pk, pre, sig)) return "the attestation does not verify";
    return null;
}

test "preimage: canonical key order, digests as bytes" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try preimage(a, "http", "zig", "q", "r", 5);
    const v = try cbor.decode(a, p);
    try std.testing.expectEqual(@as(usize, 5), v.map.len);
    // length-first: op, stamp, request, instance, response
    try std.testing.expectEqualStrings("op", v.map[0].key);
    try std.testing.expectEqualStrings("stamp", v.map[1].key);
    try std.testing.expectEqualStrings("request", v.map[2].key);
    try std.testing.expectEqualStrings("instance", v.map[3].key);
    try std.testing.expectEqualStrings("response", v.map[4].key);
    try std.testing.expectEqual(@as(usize, 32), v.map[2].value.bytes.len);
}
