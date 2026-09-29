//! p2p-demo (#51): a test program for the `libp2p` import and the front
//! door's libp2p routes. kernel-zig/test/p2p/build.sh builds it into
//! kernel-zig/test/p2p/p2p-demo.wasm (committed; src/host/p2p-router.test.ts
//! runs it).
//!
//! As a step (a box's handler; the message body a dag-cbor record):
//!   {op: "publish", topic, text}          publish → stdout "published <seqno hex>"
//!   {op: "echo", peer, protocol, text}     dial, send, receive: the reply at once, or
//!                                          the step rests (deadline in 30 s) with
//!                                          stdout "stream <id>"; the router wakes it
//!                                          when the frame comes and the next step's
//!                                          receive has it → stdout "reply <text>", close
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

    const at = Value.intOf(in.get("at")) orelse 0;
    // A later step: the stream this thread rests on, from its last update's stdout.
    if (Value.cidOf(in.get("tip"))) |tip| {
        const u = try sk.get(a, tip);
        const res = u.get("result") orelse return sk.report("the tip has no result");
        const prev = Value.bytesOf(res.get("stdout")) orelse "";
        if (!std.mem.startsWith(u8, prev, "stream ")) return sk.report("woken, and not resting on a stream");
        const id = try std.fmt.parseInt(i64, std.mem.trim(u8, prev["stream ".len..], " \n"), 10);
        return receive(a, id, at);
    }

    const args = in.get("args") orelse return sk.report("no args");
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("no body"));
    const op = Value.str(body.get("op")) orelse "";
    const text = Value.str(body.get("text")) orelse "";
    if (eql(u8, op, "publish")) {
        var q = cbor.MapBuilder.init(a);
        try q.put("op", cbor.string("publish"));
        try q.put("topic", cbor.string(Value.str(body.get("topic")) orelse return sk.report("publish: no topic")));
        try q.put("body", .{ .bytes = text });
        const r = try sk.libp2p(a, q.value());
        const seq = Value.bytesOf(r.get("seqno")) orelse return sk.report("publish: no seqno");
        return out(try std.fmt.allocPrint(a, "published {s}\n", .{try sk.hex(a, seq)}));
    }
    if (eql(u8, op, "echo")) {
        var d = cbor.MapBuilder.init(a);
        try d.put("op", cbor.string("dial"));
        try d.put("peer", cbor.string(Value.str(body.get("peer")) orelse return sk.report("echo: no peer")));
        try d.put("protocol", cbor.string(Value.str(body.get("protocol")) orelse return sk.report("echo: no protocol")));
        const id = Value.intOf((try sk.libp2p(a, d.value())).get("stream")) orelse return sk.report("dial: no stream");
        var s = cbor.MapBuilder.init(a);
        try s.put("op", cbor.string("send"));
        try s.put("stream", cbor.int(id));
        try s.put("body", .{ .bytes = text });
        _ = try sk.libp2p(a, s.value());
        return receive(a, @intCast(id), at);
    }
    return sk.report("unknown op (publish, echo)");
}

/// The next frame on the stream: printed and the stream closed; or, none yet, rest on it.
fn receive(a: Allocator, id: i64, at: i128) !void {
    var q = cbor.MapBuilder.init(a);
    try q.put("op", cbor.string("receive"));
    try q.put("stream", cbor.int(id));
    const r = try sk.libp2p(a, q.value());
    if (Value.bytesOf(r.get("body"))) |b| {
        var c = cbor.MapBuilder.init(a);
        try c.put("op", cbor.string("close"));
        try c.put("stream", cbor.int(id));
        _ = try sk.libp2p(a, c.value());
        return out(try std.fmt.allocPrint(a, "reply {s}\n", .{b}));
    }
    if (r.get("closed") != null) return sk.report("the stream closed with no reply");
    // Pending: rest; a frame on the stream wakes this thread before the deadline.
    try sk.deadline(@intCast(at + 30_000));
    return out(try std.fmt.allocPrint(a, "stream {d}\n", .{id}));
}
