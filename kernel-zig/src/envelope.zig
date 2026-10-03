// BRC-169 envelopes: the checks that need no wallet (src/runtime/envelope.ts).
//
// Two encodings (issue #33, #21), kept in the encoding they were made in —
// a signature is over the encoding it was made in (BRC-169 §7.3), and a
// message's id is the CID of its signed part as kept:
//   json  §7.2: identityKey, contentHash (hex) and signature (hex DER) as text,
//         content base64; signed over RFC 8785 of the envelope without
//         `content` and `signature` (JSON clients: the standard messagebox
//         client, the front end);
//   cbor  §7.3 / BRC-231: identityKey bstr(33), contentHash bstr(32),
//         signature bstr (DER), content bstr (BRC-78); signed over the
//         dag-cbor of the map without `content` and `signature`.
// Both are signed under [2, "metanet handles envelope"], key "send" (BRC-169 §7.2, #17), anyone.
//   session  a reply on a BRC-104 session with the recipient's native
//         messagebox (the router, #33): the compact §7.3 form {type: "reply",
//         replyTo, body} on the wire, kept as {type: "reply", replyTo, sender:
//         {identityKey: bstr(33)}, created, contentHash: bstr(32), messageId:
//         bstr(32), session: {payload, signature, nonce, yourNonce}}. Its
//         authorship is the BRC-104 message signature over `payload` (the
//         signed request, which carries the body) with the session nonces,
//         verified by the router at the session and recorded here so the
//         proof outlives the session; `messageId` is SHA-256 of `payload`.
//         No envelope signature: the kernel checks the shape and that the
//         payload carries the body (scheduler.zig).
const std = @import("std");
const cbor = @import("cbor");
const json = @import("json.zig");
const secp = @import("secp");
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

pub const Form = enum { json, cbor, session };

/// Which encoding the envelope is in: by the type of sender.identityKey.
pub fn formOf(e: Value) ?Form {
    if (e != .map) return null;
    const s = e.get("sender") orelse return null;
    const k = s.get("identityKey") orelse return null;
    if (std.mem.eql(u8, Value.str(e.get("type")) orelse "", "reply") and k == .bytes) return .session;
    return switch (k) {
        .string => .json,
        .bytes => .cbor,
        else => null,
    };
}

/// The sender's identity key as 33 bytes, in either form.
pub fn senderKey(buf: *[33]u8, e: Value) ?[]const u8 {
    const f = formOf(e) orelse return null;
    const k = e.get("sender").?.get("identityKey").?;
    switch (f) {
        .json => {
            if (!secp.isIdentity(k.string)) return null;
            _ = std.fmt.hexToBytes(buf, k.string) catch return null;
            return buf;
        },
        .cbor, .session => {
            if (!secp.isKey(k.bytes)) return null;
            @memcpy(buf, k.bytes[0..33]);
            return buf;
        },
    }
}

pub fn isSigned(e: Value) bool {
    if (e != .map) return false;
    if (formOf(e) == .session) {
        var kb: [33]u8 = undefined;
        if (senderKey(&kb, e) == null or Value.str(e.get("created")) == null) return false;
        return sessionShape(e);
    }
    const mh = Value.str(e.get("metanetHandles")) orelse return false;
    if (!std.mem.eql(u8, mh, "1.0")) return false;
    const r = e.get("recipient") orelse return false;
    if (Value.str(r.get("handle")) == null or Value.str(r.get("domain")) == null) return false;
    if (r.get("tag")) |t| if (t != .string) return false;
    if (Value.str(e.get("created")) == null) return false;
    var kb: [33]u8 = undefined;
    if (senderKey(&kb, e) == null) return false;
    switch (formOf(e).?) {
        .json => {
            const ch = Value.str(e.get("contentHash")) orelse return false;
            if (ch.len != 64 or !allHex(ch, true)) return false;
            const sig = Value.str(e.get("signature")) orelse return false;
            return allHex(sig, false);
        },
        .cbor => {
            const ch = Value.bytesOf(e.get("contentHash")) orelse return false;
            if (ch.len != 32) return false;
            return Value.bytesOf(e.get("signature")) != null;
        },
        .session => unreachable,
    }
}

/// A session-form record's shape. No recipient here: the session is with it.
/// Shape only; the router verified the BRC-104 signature (recorded).
fn sessionShape(e: Value) bool {
    if (e.get("recipient") != null or e.get("signature") != null) return false;
    if (Value.cidOf(e.get("replyTo")) == null) return false;
    if ((Value.bytesOf(e.get("contentHash")) orelse return false).len != 32) return false;
    if ((Value.bytesOf(e.get("messageId")) orelse return false).len != 32) return false;
    const s = e.get("session") orelse return false;
    if (s != .map) return false;
    const payload = Value.bytesOf(s.get("payload")) orelse return false;
    var d: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(payload, &d, .{});
    if (!std.mem.eql(u8, &d, Value.bytesOf(e.get("messageId")).?)) return false;
    return Value.bytesOf(s.get("signature")) != null and Value.str(s.get("nonce")) != null and Value.str(s.get("yourNonce")) != null;
}

/// A session-form record's signed payload (the BRC-104 request it arrived in).
pub fn sessionPayload(e: Value) ?[]const u8 {
    if (formOf(e) != .session) return null;
    return Value.bytesOf((e.get("session") orelse return null).get("payload"));
}

pub fn isEnvelope(e: Value) bool {
    if (!isSigned(e)) return false;
    return switch (formOf(e).?) {
        .json => Value.str(e.get("content")) != null,
        .cbor => Value.bytesOf(e.get("content")) != null,
        .session => true, // nothing on the wire was encrypted: the session is with the recipient
    };
}

/// The BRC-78 bytes of `content` (base64 decoded for the JSON form).
pub fn contentBytes(alloc: std.mem.Allocator, e: Value) ![]const u8 {
    const c = e.get("content") orelse return error.NoContent;
    return switch (c) {
        .string => |t| base64Decode(alloc, t),
        .bytes => |b| b,
        else => error.NoContent,
    };
}

/// Does the envelope's contentHash name `body` (sha256), in its form?
pub fn hashMatches(e: Value, body: []const u8) bool {
    var d: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(body, &d, .{});
    switch (formOf(e) orelse return false) {
        .json => {
            const hex = std.fmt.bytesToHex(d, .lower);
            return std.mem.eql(u8, Value.str(e.get("contentHash")) orelse "", &hex);
        },
        .cbor, .session => return std.mem.eql(u8, Value.bytesOf(e.get("contentHash")) orelse "", &d),
    }
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

/// The BRC-78 error text, as src/runtime/envelope.ts brc78Decode reports it.
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

/// The signature against sender.identityKey with no wallet (envelope.ts verify), in the envelope's form.
pub fn verify(alloc: std.mem.Allocator, env: Value) bool {
    if (!isSigned(env)) return false;
    var kb: [33]u8 = undefined;
    const key = senderKey(&kb, env).?;
    if (formOf(env).? == .session) return true; // the BRC-104 signature: checked by the router, recorded (above)
    if (env.get("content") != null) {
        const raw = contentBytes(alloc, env) catch return false;
        const m = brc78Decode(raw) catch return false;
        const hex = std.fmt.bytesToHex(kb, .lower);
        if (!std.mem.eql(u8, &m.sender, &hex)) return false;
    }
    switch (formOf(env).?) {
        .json => {
            const text = canonical(alloc, env) catch return false;
            const sig = hexDecode(alloc, Value.str(env.get("signature")).?) catch return false;
            return secp.verifyAnyoneKey(key, 2, "metanet handles envelope", "send", text, sig);
        },
        .session => unreachable,
        .cbor => {
            const rest = cbor.without(alloc, cbor.without(alloc, env, "content") catch return false, "signature") catch return false;
            const pre = cbor.encode(alloc, rest) catch return false;
            return secp.verifyAnyoneKey(key, 2, "metanet handles envelope", "send", pre, Value.bytesOf(env.get("signature")).?);
        },
    }
}
