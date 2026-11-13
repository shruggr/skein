// What the kernel checks before an entry is written (skein next, SPEC.md sections 2 and 4): a
// request's signature, by scheme (`verify`: brc104, signed). The scheduler's CHECK calls it, then
// matches the row, gates it and runs the row's checks (scheduler.zig). The BEEF check is no longer
// the kernel's: it is the chain app's (`chain.beef`, skein-sdk chain/door), a row's check like any
// other; the kernel keeps no BEEF code and names no `chain/state`.
const std = @import("std");
const cbor = @import("cbor");
const authfetch = @import("authfetch.zig");
const signer = @import("signer.zig");
const secp = @import("secp");
const Value = cbor.Value;

// ---------------------------------------------------------------- the signature schemes (SPEC 2)

/// A refusal at the check: the status the host answers with, a code, why. Nothing is written.
pub const Reject = struct { status: i64, code: ?[]const u8 = null, reason: []const u8 };

/// The signer, as the check asks it (not recorded: the entry's `door` is what the log keeps).
pub const Signer = struct {
    ctx: *anyopaque,
    call: *const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8,
};

/// What a request's signature came to: its sender (the principal) under a scheme, or a refusal.
pub const Verified = union(enum) {
    ok: struct { principal: []const u8, scheme: []const u8 },
    refused: Reject,
};

pub const BRC104 = "brc104";
pub const SIGNED = "signed";

fn refused(status: i64, code: []const u8, reason: []const u8) Verified {
    return .{ .refused = .{ .status = status, .code = code, .reason = reason } };
}

/// A request record's signature checked (log.zig isRequest; the record has one): `brc104` — a wallet
/// over HTTP, the host's one handshake — or `signed` — a host service, or the host's root key,
/// handing a request in. `identity` is this instance's key; `w` the instance's signer (brc104 needs
/// it: the server nonce and the signature are this instance's to check).
pub fn verify(a: std.mem.Allocator, w: ?Signer, identity: []const u8, rec: Value) !Verified {
    const sig = rec.get("signature").?;
    const payload = rec.get("payload").?;
    const scheme = Value.str(sig.get("scheme")) orelse return refused(400, "ERR_AUTH_MALFORMED", "signature: no scheme");
    if (std.mem.eql(u8, scheme, BRC104)) return brc104(a, w, sig, payload);
    if (std.mem.eql(u8, scheme, SIGNED)) return signed(a, identity, sig, payload);
    return refused(401, "ERR_AUTH_SCHEME", try std.fmt.allocPrint(a, "signature scheme {s}: want brc104 or signed", .{scheme}));
}

/// `brc104` (SPEC 2, review points 3, 33): the host answered the one BRC-103 handshake with the
/// standard @bsv/sdk self-checking nonce (createNonce: 16 random bytes ‖ HMAC [2, "server hmac"],
/// key ID their UTF-8 reading, counterparty self, base64) and gathered the request's x-bsv-auth-*
/// headers into the signature: {identityKey: bytes(33), nonce, yourNonce, requestId (base64 of 32
/// bytes), signature: bytes, version}. Checked here through the signer, nothing stored: `yourNonce`
/// verifies as this instance's (verifyNonce: verifyHmac), and the signature verifies for
/// `identityKey` under [2, "auth message signature"], key "<nonce> <yourNonce>", over BRC-104's
/// request serialization of the payload. No session table, no expiry (this cut).
fn brc104(a: std.mem.Allocator, w: ?Signer, sig: Value, payload: Value) !Verified {
    const MALFORMED = "ERR_AUTH_MALFORMED";
    const peer = Value.bytesOf(sig.get("identityKey")) orelse return refused(400, MALFORMED, "brc104: identityKey: want 33 bytes");
    if (!secp.isKey(peer)) return refused(400, MALFORMED, "brc104: identityKey is not a key");
    const nonce = Value.str(sig.get("nonce")) orelse return refused(400, MALFORMED, "brc104: no nonce");
    const your = Value.str(sig.get("yourNonce")) orelse return refused(400, MALFORMED, "brc104: no yourNonce");
    const rid_text = Value.str(sig.get("requestId")) orelse return refused(400, MALFORMED, "brc104: no requestId");
    const der = Value.bytesOf(sig.get("signature")) orelse return refused(400, MALFORMED, "brc104: no signature");
    if (nonce.len == 0 or your.len == 0) return refused(400, MALFORMED, "brc104: an empty nonce");
    const b64 = std.base64.standard.Decoder;
    const rid = try a.alloc(u8, b64.calcSizeForSlice(rid_text) catch return refused(400, MALFORMED, "brc104: requestId is not base64"));
    b64.decode(rid, rid_text) catch return refused(400, MALFORMED, "brc104: requestId is not base64");
    const sg = w orelse return refused(401, "ERR_AUTH_FAILED", "brc104: this host has no signer to check the request with");
    // The server nonce: ours, by its HMAC (@bsv/sdk verifyNonce).
    const nb = try a.alloc(u8, b64.calcSizeForSlice(your) catch return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's"));
    b64.decode(nb, your) catch return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's");
    if (nb.len != 48) return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's");
    const key_id = try cbor.utf8Fix(a, nb[0..16]);
    const hm = sg.call(sg.ctx, a, try signer.verifyHmacFrame(a, authfetch.NONCE_PROTOCOL, key_id, .self, nb[0..16], nb[16..48])) catch return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's (expired or unknown: shake hands again)");
    if (hm.len == 0 or hm[0] != 0) return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's (expired or unknown: shake hands again)");
    // The request's signature, the client's.
    const body = Value.bytesOf(payload.get("body")) orelse "";
    const bytes = try authfetch.requestPayload(a, rid, Value.str(payload.get("method")).?, Value.str(payload.get("path")).?, Value.str(payload.get("query")).?, try authfetch.headerList(a, payload.get("headers")), body);
    const sk = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, your });
    const res = sg.call(sg.ctx, a, try signer.verifySignatureFrame(a, authfetch.AUTH_PROTOCOL, sk, .{ .other = peer }, bytes, der)) catch return refused(401, "ERR_AUTH_FAILED", "brc104: the request's signature does not verify");
    if (res.len == 0 or res[0] != 0) return refused(401, "ERR_AUTH_FAILED", "brc104: the request's signature does not verify");
    return .{ .ok = .{ .principal = peer, .scheme = BRC104 } };
}

/// What the `signed` scheme signs: dag-cbor {sender, recipient, nonce, payload} — the request
/// without its signature, the signature's own fields beside the payload.
pub fn signedPreimage(a: std.mem.Allocator, sender: []const u8, recipient: []const u8, nonce: []const u8, payload: Value) ![]u8 {
    var m = cbor.MapBuilder.init(a);
    try m.put("sender", .{ .bytes = sender });
    try m.put("recipient", .{ .bytes = recipient });
    try m.put("nonce", .{ .bytes = nonce });
    try m.put("payload", payload);
    return cbor.encode(a, m.value());
}

/// `signed` (SPEC 2 [P]): BRC-169's message signing — [2, "metanet handles envelope"], key "send",
/// counterparty anyone — by `sender` over signedPreimage; `recipient` is this instance. Anyone can
/// check it; no signer needed.
fn signed(a: std.mem.Allocator, identity: []const u8, sig: Value, payload: Value) !Verified {
    const MALFORMED = "ERR_AUTH_MALFORMED";
    const sender = Value.bytesOf(sig.get("sender")) orelse return refused(400, MALFORMED, "signed: sender: want 33 bytes");
    if (!secp.isKey(sender)) return refused(400, MALFORMED, "signed: sender is not a key");
    const recipient = Value.bytesOf(sig.get("recipient")) orelse return refused(400, MALFORMED, "signed: recipient: want 33 bytes");
    const nonce = Value.bytesOf(sig.get("nonce")) orelse return refused(400, MALFORMED, "signed: nonce: want bytes");
    const der = Value.bytesOf(sig.get("signature")) orelse return refused(400, MALFORMED, "signed: no signature");
    if (!std.mem.eql(u8, recipient, identity)) return refused(401, "ERR_AUTH_FAILED", "signed: the request is addressed to another key");
    const pre = try signedPreimage(a, sender, recipient, nonce, payload);
    if (!secp.verifyAnyoneKey(sender, 2, MESSAGE_PROTOCOL, MESSAGE_KEY_ID, pre, der)) return refused(401, "ERR_AUTH_FAILED", "signed: the signature does not verify");
    return .{ .ok = .{ .principal = sender, .scheme = SIGNED } };
}

pub const MESSAGE_PROTOCOL = "metanet handles envelope";
pub const MESSAGE_KEY_ID = "send";
