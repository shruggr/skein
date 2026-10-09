//! The libp2p wiring as this program sees it (skein docs/MESSAGES.md
//! "libp2p (#51)" and "The providers"). Everything about the transport's
//! shapes is here.
//!
//! **Inbound.** The front door is stepped on each GossipSub message on a
//! subscribed topic (request `{kind: "p2p", …}`) and each frame of an inbound
//! direct call on a served protocol (request `{kind: "p2p-frame", …}`), and
//! calls the `libp2p:<topic>` / `libp2p:<protocol>` route's program and fn
//! (an in-VM call) with the argument
//!
//!   {transport: "libp2p", topic | protocol, from: bytes (the peer ID's multihash),
//!    key: bytes(33) (the key out of `from`), seqno?: bytes(8), signature?: bytes, body: bytes}
//!
//! For a topic message the front door has already checked `from` and the
//! GossipSub signature (StrictSign), so `from` is the publisher.
//!
//! **A handler answers** `{verdict: "accept" | "reject" | "ignore", reason?,
//! admit?: [{event, box}], body?: bytes, close?: bool}`. On a topic's accept
//! the front door admits the message's own `p2p` event (box
//! `libp2p:<topic>`), then the handler's `admit` entries unchanged; reject
//! and ignore admit nothing. On a direct call, `body` is written back as one
//! frame and `close` (or reject) ends it.
//!
//! **Outbound** is the `libp2p` provider (#70): a step emits a body to the
//! provider's key (the address book's role `libp2p`) in one of its boxes and
//! may await the answer, `{replyTo, …}` or `{replyTo, error}`:
//!
//!   box publish  {topic, body}      → {seqno, recipients}
//!   box dial     {peer, protocol}   → {stream}; then each frame read, in box `frame`: {stream, body},
//!                                     and its end {stream, closed: true, error?} — all answering the dial
//!   box send     {stream, body}     → {}
//!   box close    {stream}           → {}
//!
//! The instance's own peer ID: main.zig `selfPeerId` (the signer's key, `peerIdOf`).
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const base58 = w.bsvz.primitives.base58;

/// An inbound topic message or direct-call frame (a handler's call argument).
pub const Inbound = struct {
    topic: ?[]const u8 = null,
    protocol: ?[]const u8 = null,
    /// The sender's peer ID (multihash bytes): the publisher, or the remote peer of a direct call.
    from: []const u8,
    body: []const u8,
};

/// The protocol the instance's keys are derived under (skein src/host/signer.ts `INSTANCE_PROTOCOL`).
pub const instance_protocol = .{ .level = 2, .name = "skein instance" };

/// The peer ID of a compressed secp256k1 key, as js-libp2p makes it: the identity multihash
/// (0x00, length 0x25) of the protobuf PublicKey {1: KeyType = 2 (secp256k1), 2: the 33 bytes}.
pub fn peerIdOf(a: Allocator, key: [33]u8) ![]const u8 {
    return std.mem.concat(a, u8, &.{ &.{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 }, &key });
}

/// A peer ID as bytes: bytes as they are, text as base58btc.
pub fn peerIdBytes(a: Allocator, v: Value) ![]const u8 {
    return switch (v) {
        .bytes => |b| b,
        .text => |t| base58.decode(a, t) catch error.BadPeerId,
        else => error.BadPeerId,
    };
}

/// A peer ID as `dial` takes it: base58btc text.
pub fn peerIdText(a: Allocator, id: []const u8) ![]const u8 {
    return base58.encode(a, id);
}

/// A handler's call argument as an inbound message.
pub fn inbound(arg: Value) !Inbound {
    if (!std.mem.eql(u8, arg.getText("transport") orelse "", "libp2p")) return error.NotLibp2p;
    return .{
        .topic = arg.getText("topic"),
        .protocol = arg.getText("protocol"),
        .from = arg.getBytes("from") orelse return error.BadInbound,
        .body = arg.getBytes("body") orelse return error.BadInbound,
    };
}

/// An entry a handler returns for the front door to admit: `{event, box}`.
pub const Admit = struct { box: []const u8, event: Value };

pub const Verdict = union(enum) {
    /// Valid: forward, and admit the message's `p2p` entry, then these.
    accept: []const Admit,
    /// Invalid under the rules: drop, the delivering peer is penalised.
    reject: []const u8,
    /// Cannot evaluate (or nothing new): drop, no penalty.
    ignore: []const u8,
};

/// A topic handler's answer for a verdict: `{verdict, admit}` or `{verdict, reason}`.
pub fn answer(a: Allocator, v: Verdict) !Value {
    return switch (v) {
        .accept => |ads| blk: {
            const out = try a.alloc(Value, ads.len);
            for (ads, out) |x, *o| o.* = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "event", .value = x.event },
                .{ .key = "box", .value = .{ .text = x.box } },
            }) };
            break :blk .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "verdict", .value = .{ .text = "accept" } },
                .{ .key = "admit", .value = .{ .array = out } },
            }) };
        },
        .reject, .ignore => |why| .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "verdict", .value = .{ .text = @tagName(v) } },
            .{ .key = "reason", .value = .{ .text = why } },
        }) },
    };
}

/// A direct-call handler's answer: `body` written back as one frame.
pub fn directAnswer(a: Allocator, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "verdict", .value = .{ .text = "accept" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}

// ---------------------------------------------------------------- outbound: the provider's bodies

/// A body for the provider: its box and the map emitted there.
pub const Request = struct { box: []const u8, body: Value };

pub fn publish(a: Allocator, topic: []const u8, body: []const u8) !Request {
    return .{ .box = "publish", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "topic", .value = .{ .text = topic } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) } };
}

/// `peer`: a base58 peer ID or a multiaddr with /p2p/<id>.
pub fn dial(a: Allocator, peer: []const u8, protocol: []const u8) !Request {
    return .{ .box = "dial", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "peer", .value = .{ .text = peer } },
        .{ .key = "protocol", .value = .{ .text = protocol } },
    }) } };
}

pub fn send(a: Allocator, stream: u64, body: []const u8) !Request {
    return .{ .box = "send", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "stream", .value = .{ .uint = stream } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) } };
}

pub fn close(a: Allocator, stream: u64) !Request {
    return .{ .box = "close", .body = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "stream", .value = .{ .uint = stream } },
    }) } };
}

/// What the provider answered a dial with (the reply's box and body).
pub const DialAnswer = union(enum) {
    /// The direct call is open (box `dial`).
    opened: u64,
    /// A frame read from it (box `frame`).
    frame: []const u8,
    /// It ended (box `frame`, `closed`), or the dial failed (`error`).
    closed: []const u8,
};

pub fn dialAnswer(box: []const u8, body: Value) !DialAnswer {
    if (body.getText("error")) |e| return .{ .closed = e };
    if (std.mem.eql(u8, box, "frame")) {
        if (body.getBytes("body")) |b| return .{ .frame = b };
        if (body.get("closed") != null) return .{ .closed = "Closed" };
        return error.BadAnswer;
    }
    if (std.mem.eql(u8, box, "dial")) return .{ .opened = body.getUint("stream") orelse return error.BadAnswer };
    return error.BadAnswer;
}
