// The kernel's own BRC-100 wire frames to the signer (#70): what `emit` signs
// a message with, and (#126) what `authfetch` signs, HMACs and verifies with. The same framing as a program's (the SDK's lib/brc104.zig
// keyParams): the call code, an empty originator, security level, protocol,
// key ID, counterparty, privileged false; the answer frame is 0 ‖ payload on
// success. A frame the kernel makes goes through the step's `wallet` path, so
// it is recorded like a program's (an `oracle` record) and replay serves it.
const std = @import("std");

pub const Counterparty = union(enum) { self, anyone, other: []const u8 };

fn varint(a: std.mem.Allocator, out: *std.array_list.Managed(u8), v: u64) !void {
    _ = a;
    if (v < 0xfd) {
        try out.append(@intCast(v));
    } else if (v <= 0xffff) {
        try out.append(0xfd);
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, @intCast(v), .little);
        try out.appendSlice(&b);
    } else if (v <= 0xffff_ffff) {
        try out.append(0xfe);
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @intCast(v), .little);
        try out.appendSlice(&b);
    } else {
        try out.append(0xff);
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, v, .little);
        try out.appendSlice(&b);
    }
}

/// The key parameters every frame here starts with: the call, an empty
/// originator, security level 2, protocol, key ID, counterparty, privileged
/// false, no privileged reason.
fn keyParams(a: std.mem.Allocator, f: *std.array_list.Managed(u8), call: u8, protocol: []const u8, key_id: []const u8, cp: Counterparty) !void {
    try f.appendSlice(&.{ call, 0 }); // the call, an empty originator
    try f.append(2); // security level 2
    try varint(a, f, protocol.len);
    try f.appendSlice(protocol);
    try varint(a, f, key_id.len);
    try f.appendSlice(key_id);
    switch (cp) {
        .self => try f.append(11),
        .anyone => try f.append(12),
        .other => |k| try f.appendSlice(k),
    }
    try f.append(0); // privileged: false
    try f.append(0xff); // privilegedReason: none
}

/// createHmac (call 13) at security level 2 over `data` (#126: authfetch's session nonce).
pub fn createHmacFrame(a: std.mem.Allocator, protocol: []const u8, key_id: []const u8, cp: Counterparty, data: []const u8) ![]u8 {
    var f = std.array_list.Managed(u8).init(a);
    try keyParams(a, &f, 13, protocol, key_id, cp);
    try varint(a, &f, data.len);
    try f.appendSlice(data);
    try f.append(0); // seekPermission: false
    return f.toOwnedSlice();
}

/// verifySignature (call 16) at security level 2 (#126: authfetch checks a server's signature;
/// the answer frame is 0 ‖ … when it verifies).
pub fn verifySignatureFrame(a: std.mem.Allocator, protocol: []const u8, key_id: []const u8, cp: Counterparty, data: []const u8, sig: []const u8) ![]u8 {
    var f = std.array_list.Managed(u8).init(a);
    try keyParams(a, &f, 16, protocol, key_id, cp);
    try f.append(0xff); // forSelf: none
    try varint(a, &f, sig.len);
    try f.appendSlice(sig);
    try f.append(1); // data follows
    try varint(a, &f, data.len);
    try f.appendSlice(data);
    try f.append(0); // seekPermission: false
    return f.toOwnedSlice();
}

/// createSignature (call 15) at security level 2 over `data` (the signer hashes it with sha256).
pub fn createSignatureFrame(a: std.mem.Allocator, protocol: []const u8, key_id: []const u8, cp: Counterparty, data: []const u8) ![]u8 {
    var f = std.array_list.Managed(u8).init(a);
    try keyParams(a, &f, 15, protocol, key_id, cp);
    try f.append(1); // data follows
    try varint(a, &f, data.len);
    try f.appendSlice(data);
    try f.append(0); // seekPermission: false
    return f.toOwnedSlice();
}

/// A createSignature answer's DER signature, or null for a wallet error.
pub fn signatureOf(frame: []const u8) ?[]const u8 {
    if (frame.len < 9 or frame[0] != 0 or frame[1] != 0x30) return null;
    return frame[1..];
}
