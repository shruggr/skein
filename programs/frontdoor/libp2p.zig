//! The front door's libp2p side (#51): fn "libp2p", the call the router makes
//! for each GossipSub message on a subscribed topic and each frame read from
//! an inbound stream on a served protocol — the same front door, the same
//! routes table, another transport.
//!
//! Called: fn "libp2p", arg (dag-cbor)
//!   {transport: "libp2p", topic | protocol, from: bytes (the peer ID's multihash),
//!    seqno?: bytes(8), signature?: bytes, body: bytes}
//! → {verdict: "accept" | "reject" | "ignore", reason?, admit?: [entry], body?: bytes, close?: bool}
//!
//! Routing: the route whose `path` is `libp2p:<topic>` (or `libp2p:<protocol>`).
//! None: ignore (this instance cannot judge it; GossipSub does not penalise).
//!
//! A topic message is verified here, before any handler sees it, from the
//! call alone: `from` must be a secp256k1 peer ID (identity multihash of the
//! key's protobuf), and `signature` its ECDSA signature (DER, over sha2-256)
//! of "libp2p-pubsub:" ‖ protobuf {1: from, 2: body, 3: seqno, 4: topic} —
//! GossipSub's StrictSign. A bad one is `reject` (the delivering peer is
//! penalised). The handler then judges it from state and answers
//! {verdict}; **accept** makes the one entry this call returns:
//!
//!   {event: {kind: "p2p", topic, from, seqno, signature, body}, box: "libp2p:<topic>"}
//!
//! — everything a reader of the log needs to verify the publisher with no
//! router (the key is in `from`). Reject and ignore return nothing to admit.
//! A handler that fails is `ignore` (cannot evaluate: no penalty).
//!
//! A stream frame is not signed (the stream is authenticated by Noise: `from`
//! is the remote peer); the handler answers {verdict?, body?, admit?, close?}:
//! `body` is written back on the stream, `admit` (entries, as an HTTP route
//! handler returns them) admitted, `close` (or reject) ends the stream.
//!
//! The handler gets the call's input plus `key`: the 33-byte key from `from`.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;
const Ecdsa = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;

const SIGN_PREFIX = "libp2p-pubsub:";

pub fn libp2p(a: Allocator, in: Value, call: Value) !Value {
    const topic = Value.str(call.get("topic"));
    const protocol = Value.str(call.get("protocol"));
    const name = topic orelse protocol orelse return verdict(a, "reject", "neither a topic nor a protocol");
    const source = try std.fmt.allocPrint(a, "libp2p:{s}", .{name});
    const from = Value.bytesOf(call.get("from")) orelse return verdict(a, "reject", "no from");
    const body = Value.bytesOf(call.get("body")) orelse "";
    const route = findRoute(in, source) orelse return verdict(a, "ignore", try std.fmt.allocPrint(a, "no route for {s}", .{source}));
    const key = keyOfPeerId(from) orelse return verdict(a, "reject", "from is not a secp256k1 peer ID");

    var seqno: []const u8 = "";
    var signature: []const u8 = "";
    if (topic) |t| {
        seqno = Value.bytesOf(call.get("seqno")) orelse return verdict(a, "reject", "no seqno");
        signature = Value.bytesOf(call.get("signature")) orelse return verdict(a, "reject", "no signature");
        if (seqno.len != 8) return verdict(a, "reject", "the seqno is not 8 bytes");
        if (!try verifyMessage(a, from, body, seqno, t, signature, key)) return verdict(a, "reject", "the signature does not verify");
    }

    const prog = Value.cidOf(route.get("program")) orelse return verdict(a, "ignore", "the route names no program");
    const func = Value.str(route.get("fn")) orelse return verdict(a, "ignore", "the route names no fn");
    var h = cbor.MapBuilder.init(a);
    try h.put("transport", cbor.string("libp2p"));
    if (topic) |t| try h.put("topic", cbor.string(t));
    if (protocol) |p| try h.put("protocol", cbor.string(p));
    try h.put("from", .{ .bytes = from });
    try h.put("key", .{ .bytes = key });
    if (topic != null) {
        try h.put("seqno", .{ .bytes = seqno });
        try h.put("signature", .{ .bytes = signature });
    }
    try h.put("body", .{ .bytes = body });
    const out = sk.callValue(a, prog, func, h.value()) catch |err| {
        if (err == error.ImportFailed) return verdict(a, "ignore", try std.fmt.allocPrint(a, "the handler failed: {s}", .{sk.lastError()}));
        return err;
    };
    const said = Value.str(out.get("verdict"));
    const reason = Value.str(out.get("reason"));

    if (topic) |t| {
        const v = said orelse "ignore";
        if (!eql(u8, v, "accept")) return verdict(a, if (eql(u8, v, "reject")) "reject" else "ignore", reason);
        var ev = cbor.MapBuilder.init(a);
        try ev.put("kind", cbor.string("p2p"));
        try ev.put("topic", cbor.string(t));
        try ev.put("from", .{ .bytes = from });
        try ev.put("seqno", .{ .bytes = seqno });
        try ev.put("signature", .{ .bytes = signature });
        try ev.put("body", .{ .bytes = body });
        var entry = cbor.MapBuilder.init(a);
        try entry.put("event", ev.value());
        try entry.put("box", cbor.string(source));
        const admit = try a.alloc(Value, 1);
        admit[0] = entry.value();
        var m = cbor.MapBuilder.init(a);
        try m.put("verdict", cbor.string("accept"));
        try m.put("admit", .{ .array = admit });
        return m.value();
    }

    // A stream frame: the handler's answer, passed on.
    const v = said orelse "accept";
    var m = cbor.MapBuilder.init(a);
    try m.put("verdict", cbor.string(if (eql(u8, v, "reject")) "reject" else if (eql(u8, v, "ignore")) "ignore" else "accept"));
    if (reason) |r| try m.put("reason", cbor.string(r));
    if (Value.bytesOf(out.get("body"))) |b| try m.put("body", .{ .bytes = b });
    if (out.get("admit")) |ad| if (ad == .array) try m.put("admit", ad);
    if (out.get("close")) |c| if (c == .bool and c.bool) try m.put("close", .{ .bool = true });
    return m.value();
}

fn verdict(a: Allocator, v: []const u8, reason: ?[]const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("verdict", cbor.string(v));
    if (reason) |r| try m.put("reason", cbor.string(r));
    return m.value();
}

fn findRoute(in: Value, source: []const u8) ?Value {
    const rs = in.get("routes") orelse return null;
    if (rs != .array) return null;
    for (rs.array) |r| if (Value.str(r.get("path"))) |p| if (eql(u8, p, source)) return r;
    return null;
}

/// The compressed secp256k1 key a peer ID carries: identity multihash (0x00,
/// 0x25) over the protobuf {1: KeyType = 2 (secp256k1), 2: 33 bytes}.
pub fn keyOfPeerId(id: []const u8) ?[]const u8 {
    if (id.len != 39) return null;
    if (!eql(u8, id[0..6], &[_]u8{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 })) return null;
    const k = id[6..];
    if (k[0] != 2 and k[0] != 3) return null;
    return k;
}

fn varint(w: *std.ArrayList(u8), a: Allocator, n: usize) !void {
    var x = n;
    while (x >= 0x80) : (x >>= 7) try w.append(a, @as(u8, @intCast(x & 0x7f)) | 0x80);
    try w.append(a, @intCast(x));
}

fn field(w: *std.ArrayList(u8), a: Allocator, tag: u8, b: []const u8) !void {
    try w.append(a, tag);
    try varint(w, a, b.len);
    try w.appendSlice(a, b);
}

/// What a GossipSub publisher signs (StrictSign): the prefix and the message's protobuf without signature and key.
pub fn signedBytes(a: Allocator, from: []const u8, data: []const u8, seqno: []const u8, topic: []const u8) ![]u8 {
    var w: std.ArrayList(u8) = .empty;
    try w.appendSlice(a, SIGN_PREFIX);
    try field(&w, a, 0x0a, from);
    try field(&w, a, 0x12, data);
    try field(&w, a, 0x1a, seqno);
    try field(&w, a, 0x22, topic);
    return w.items;
}

/// The publisher's signature over the message, checked against the key in `from`.
pub fn verifyMessage(a: Allocator, from: []const u8, data: []const u8, seqno: []const u8, topic: []const u8, signature: []const u8, key: []const u8) !bool {
    const msg = try signedBytes(a, from, data, seqno, topic);
    const sig = Ecdsa.Signature.fromDer(signature) catch return false;
    const pk = Ecdsa.PublicKey.fromSec1(key) catch return false;
    sig.verify(msg, pk) catch return false;
    return true;
}
