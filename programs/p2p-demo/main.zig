//! p2p-demo (#51, #70): a test program for libp2p over `emit` and the front
//! door's libp2p routes. kernel-zig/test/p2p/build.sh builds it into
//! kernel-zig/test/p2p/p2p-demo.wasm (committed; src/host/p2p-router.test.ts
//! and kernel-zig/equiv/libp2p.ts run it).
//!
//! Outbound is a thread (#67): each operation is a message to the address
//! book's `libp2p` provider, and its answer — a signed message replying to
//! it — the entry that steps the thread again.
//!
//! As a step (a box's handler; the message body a dag-cbor record):
//!   {op: "publish", topic, text}          emit publish {topic, body} → await; the answer
//!                                          {seqno, recipients} → stdout "published <seqno hex>"
//!   {op: "echo", peer, protocol, text}     emit dial {peer, protocol} → await; its answer
//!                                          {stream} → emit send {stream, body: text}, await the
//!                                          dial again (a frame read from the stream arrives as a
//!                                          reply to the dial, in box `frame`: {stream, body}); the
//!                                          frame → emit close {stream} → stdout "reply <text>"
//!   Between steps the thread's state is its last stdout line:
//!     "dial <dial cid hex> <text>"   waiting on the dial's answer
//!     "stream <id> <dial cid hex>"   waiting on the frame (the send's answer, if it comes first, rests again)
//! Called (a front-door route's handler, kind "call"):
//!   topic    {transport, topic, from, key, seqno, signature, body} → {verdict}: a body
//!            starting "bad" is reject, "skip" ignore, anything else accept
//!   stream   {transport, protocol, from, key, body} → {body: "echo: " ‖ body}; "bye" closes
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("p2p-demo", run);
}

fn out(s: []const u8) !void {
    try std.Io.File.stdout().writeStreamingAll(sk.io(), s);
}

fn map(a: Allocator, es: []const cbor.Entry) !Value {
    return .{ .map = try a.dupe(cbor.Entry, es) };
}

/// A message to the libp2p provider in `box`, awaited: its CID.
fn ask(a: Allocator, box: []const u8, body: Value) ![]const u8 {
    const id = try sk.emit(a, try sk.provider(a, "libp2p"), box, body, null);
    try sk.awaitRecord(id);
    return id;
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "call")) {
        const func = Value.str(in.get("fn")) orelse "";
        const arg = try cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "");
        const body = Value.bytesOf(arg.get("body")) orelse "";
        var m = cbor.MapBuilder.init(a);
        if (eql(u8, func, "topic")) {
            const v = if (std.mem.startsWith(u8, body, "bad")) "reject" else if (std.mem.startsWith(u8, body, "skip")) "ignore" else "accept";
            try m.put("verdict", cbor.string(v));
        } else if (eql(u8, func, "stream")) {
            try m.put("verdict", cbor.string("accept"));
            try m.put("body", .{ .bytes = try std.fmt.allocPrint(a, "echo: {s}", .{body}) });
            if (eql(u8, body, "bye")) try m.put("close", .{ .bool = true });
        } else return sk.report("unknown fn (topic, stream)");
        return sk.answer(a, m.value());
    }

    // A later step: the provider's answer, read with the state the last step left on stdout.
    if (try sk.replyOf(a, in)) |r| {
        const tip = Value.cidOf(in.get("tip")) orelse return sk.report("an answer, and no step before it");
        const u = try sk.get(a, tip);
        const res = u.get("result") orelse return sk.report("the tip has no result");
        const prev = std.mem.trim(u8, Value.bytesOf(res.get("stdout")) orelse "", " \n");
        if (Value.str(r.body.get("error"))) |e| return sk.report(try std.fmt.allocPrint(a, "{s}: {s}", .{ r.box, e }));
        if (eql(u8, r.box, "publish")) {
            const seq = Value.bytesOf(r.body.get("seqno")) orelse return sk.report("publish: no seqno");
            return out(try std.fmt.allocPrint(a, "published {s}\n", .{try sk.hex(a, seq)}));
        }
        if (eql(u8, r.box, "dial")) {
            // "dial <dial cid hex> <text>"
            if (!std.mem.startsWith(u8, prev, "dial ")) return sk.report("a dial's answer, and not dialling");
            var it = std.mem.splitScalar(u8, prev["dial ".len..], ' ');
            const dial_hex = it.next() orelse return sk.report("bad state");
            const text = it.rest();
            const id = Value.intOf(r.body.get("stream")) orelse return sk.report("dial: no stream");
            _ = try ask(a, "send", try map(a, &.{ .{ .key = "stream", .value = cbor.int(id) }, .{ .key = "body", .value = .{ .bytes = text } } }));
            try sk.awaitRecord(sk.unhex(a, dial_hex) orelse return sk.report("bad state"));
            return out(try std.fmt.allocPrint(a, "stream {d} {s}\n", .{ id, dial_hex }));
        }
        if (!std.mem.startsWith(u8, prev, "stream ")) return sk.report("an answer, and not resting on a stream");
        var it = std.mem.splitScalar(u8, prev["stream ".len..], ' ');
        const id = try std.fmt.parseInt(i64, it.next() orelse return sk.report("bad state"), 10);
        const dial = sk.unhex(a, it.next() orelse return sk.report("bad state")) orelse return sk.report("bad state");
        if (eql(u8, r.box, "send")) {
            // The send went out; the frame is still to come.
            try sk.awaitRecord(dial);
            return out(try std.fmt.allocPrint(a, "{s}\n", .{prev}));
        }
        if (!eql(u8, r.box, "frame")) return sk.report(try std.fmt.allocPrint(a, "an answer in box {s}", .{r.box}));
        if (r.body.get("closed") != null) return sk.report("the stream closed with no reply");
        const b = Value.bytesOf(r.body.get("body")) orelse return sk.report("frame: no body");
        // Close it (its answer is not awaited) and finish with the reply.
        _ = try sk.emit(a, try sk.provider(a, "libp2p"), "close", try map(a, &.{.{ .key = "stream", .value = cbor.int(id) }}), null);
        return out(try std.fmt.allocPrint(a, "reply {s}\n", .{b}));
    }

    const args = in.get("args") orelse return sk.report("no args");
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("no body"));
    const op = Value.str(body.get("op")) orelse "";
    const text = Value.str(body.get("text")) orelse "";
    if (eql(u8, op, "publish")) {
        const topic = Value.str(body.get("topic")) orelse return sk.report("publish: no topic");
        _ = try ask(a, "publish", try map(a, &.{ .{ .key = "topic", .value = cbor.string(topic) }, .{ .key = "body", .value = .{ .bytes = text } } }));
        return out("publishing\n");
    }
    if (eql(u8, op, "echo")) {
        const peer = Value.str(body.get("peer")) orelse return sk.report("echo: no peer");
        const protocol = Value.str(body.get("protocol")) orelse return sk.report("echo: no protocol");
        const dial = try ask(a, "dial", try map(a, &.{ .{ .key = "peer", .value = cbor.string(peer) }, .{ .key = "protocol", .value = cbor.string(protocol) } }));
        return out(try std.fmt.allocPrint(a, "dial {s} {s}\n", .{ try sk.hex(a, dial), text }));
    }
    return sk.report("unknown op (publish, echo)");
}
