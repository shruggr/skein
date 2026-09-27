// BRC-169 §7.2 envelopes: the checks that need no wallet (src/runtime/envelope.ts).
const std = @import("std");
const cbor = @import("cbor.zig");
const json = @import("json.zig");
const secp = @import("secp.zig");
const Value = cbor.Value;

pub fn signedPart(alloc: std.mem.Allocator, env: Value) !Value {
    return cbor.without(alloc, env, "content");
}

/// RFC 8785 of the envelope without `content` and `signature`.
pub fn canonical(alloc: std.mem.Allocator, env: Value) ![]u8 {
    const rest = try cbor.without(alloc, try cbor.without(alloc, env, "content"), "signature");
    var out = std.array_list.Managed(u8).init(alloc);
    try json.jcs(&out, rest);
    return out.toOwnedSlice();
}

pub fn contentHash(buf: *[64]u8, body: []const u8) []const u8 {
    var d: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(body, &d, .{});
    const hex = std.fmt.bytesToHex(d, .lower);
    @memcpy(buf, &hex);
    return buf;
}

fn allHex(s: []const u8, lower_only: bool) bool {
    if (s.len == 0) return false;
    for (s) |c| {
        const ok = (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f') or (!lower_only and c >= 'A' and c <= 'F');
        if (!ok) return false;
    }
    return true;
}

pub fn isSigned(e: Value) bool {
    if (e != .map) return false;
    const mh = Value.str(e.get("metanetHandles")) orelse return false;
    if (!std.mem.eql(u8, mh, "1.0")) return false;
    const r = e.get("recipient") orelse return false;
    if (Value.str(r.get("handle")) == null or Value.str(r.get("domain")) == null) return false;
    if (r.get("tag")) |t| if (t != .string) return false;
    const s = e.get("sender") orelse return false;
    const key = Value.str(s.get("identityKey")) orelse return false;
    if (!secp.isIdentity(key)) return false;
    if (Value.str(e.get("created")) == null) return false;
    const ch = Value.str(e.get("contentHash")) orelse return false;
    if (ch.len != 64 or !allHex(ch, true)) return false;
    const sig = Value.str(e.get("signature")) orelse return false;
    return allHex(sig, false);
}

pub fn isEnvelope(e: Value) bool {
    return isSigned(e) and Value.str(e.get("content")) != null;
}

pub const Brc78 = struct { sender: [66]u8, recipient: [66]u8, key_id: []const u8, ciphertext: []const u8 };

pub const Brc78Error = error{ TooShort, BadVersion };

pub fn brc78Decode(bytes: []const u8) Brc78Error!Brc78 {
    if (bytes.len < 4 + 33 + 33 + 32 + 32) return error.TooShort;
    if (!std.mem.eql(u8, bytes[0..4], &.{ 0x42, 0x42, 0x10, 0x33 })) return error.BadVersion;
    return .{
        .sender = std.fmt.bytesToHex(bytes[4..37].*, .lower),
        .recipient = std.fmt.bytesToHex(bytes[37..70].*, .lower),
        .key_id = bytes[70..102],
        .ciphertext = bytes[102..],
    };
}

/// The BRC-78 error text the TS runtime reports (envelope.ts brc78Decode).
pub fn brc78Message(alloc: std.mem.Allocator, bytes: []const u8, err: Brc78Error) ![]u8 {
    return switch (err) {
        error.TooShort => alloc.dupe(u8, "BRC-78: too short"),
        error.BadVersion => std.fmt.allocPrint(alloc, "BRC-78: version {x}, want 42421033", .{bytes[0..4]}),
    };
}

/// Node's Buffer.from(s, "base64"): standard or URL-safe alphabet, stops at
/// '=', skips anything else.
pub fn base64Decode(alloc: std.mem.Allocator, s: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(alloc);
    var acc: u32 = 0;
    var bits: u5 = 0;
    for (s) |c| {
        const v: u32 = switch (c) {
            'A'...'Z' => c - 'A',
            'a'...'z' => c - 'a' + 26,
            '0'...'9' => c - '0' + 52,
            '+', '-' => 62,
            '/', '_' => 63,
            '=' => break,
            else => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            try out.append(@truncate(acc >> bits));
            acc &= (@as(u32, 1) << bits) - 1;
        }
    }
    return out.toOwnedSlice();
}

/// Node's Buffer.from(hex, "hex"): pairs until the first invalid one.
pub fn hexDecode(alloc: std.mem.Allocator, s: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(alloc);
    var i: usize = 0;
    while (i + 1 < s.len) : (i += 2) {
        const hi = std.fmt.charToDigit(s[i], 16) catch break;
        const lo = std.fmt.charToDigit(s[i + 1], 16) catch break;
        try out.append(hi * 16 + lo);
    }
    return out.toOwnedSlice();
}

/// The signature against sender.identityKey with no wallet (envelope.ts verify).
pub fn verify(alloc: std.mem.Allocator, env: Value) bool {
    if (!isSigned(env)) return false;
    const key = Value.str(env.get("sender").?.get("identityKey")).?;
    if (env.get("content")) |c| {
        if (c != .string) return false;
        const raw = base64Decode(alloc, c.string) catch return false;
        const m = brc78Decode(raw) catch return false;
        if (!std.mem.eql(u8, &m.sender, key)) return false;
    }
    const text = canonical(alloc, env) catch return false;
    const sig = hexDecode(alloc, Value.str(env.get("signature")).?) catch return false;
    return secp.verifyAnyone(key, 2, "metanet handles envelope", "1", text, sig);
}
