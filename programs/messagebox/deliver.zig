//! Delivery (#70, #67, #126): the outbound middleware of the `mailbox`
//! transport. A message a step emits to a recipient whose address book entry
//! is `{transport: "mailbox", address: <messagebox URL>}` — or, for a key the
//! address book does not name, whose record the resolve program kept
//! (`resolve/peers`, #87) — is delivered by the instance itself: the kernel
//! launches this program as the message's **delivery thread** (args
//! {message: <the mail record>, transport: "mailbox"}), and the
//! thread POSTs it to <url>/sendMessage with `authfetch` (#126: the kernel's
//! BRC-103/104 client — the session, the request's signature and the
//! answer's check are the kernel's, through the signer, and the exchange is a
//! recorded call on the step). The body is BRC-231 CBOR: {message:
//! {recipient, messageBox, body, subject?, nonce}} — the BRC-33 message, its
//! sender the session's identity (#126 step 4: the session is the proof; no
//! signature), and the emit's `subject` and `nonce`, so the recipient keeps the
//! record this instance emitted, under the same CID. 200 and that CID →
//! finished {delivered: <cid>, url, attempt}.
//!
//! Failure: `transient: …` (no answer, 5xx, 408, 425, 429) is tried again
//! at `defaults.sendRetryMs` (default 30 000) — a deadline (#126: an
//! intention the runtime answers) — up to `defaults.sendAttempts` attempts in
//! all (default 3); anything else, or the last attempt, ends the thread
//! errored, and the kernel steps the thread awaiting the message with
//! `undelivered: {message, error}` (no answer can come). Sending never tells
//! the peer who we are beyond the session (no claim, no registration:
//! application wiring, #40).
const std = @import("std");
const cbor = @import("cbor");
const cid = cbor.cidm;
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

/// The resolve program's records (#87), read, never written here.
const RESOLUTIONS = "resolve/peers";
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 30_000;

fn trimSlash(s: []const u8) []const u8 {
    return std.mem.trimEnd(u8, s, "/");
}

fn transientStatus(status: i128) bool {
    return status >= 500 or status == 408 or status == 425 or status == 429;
}

fn describe(a: Allocator, body: []const u8) []const u8 {
    if (cbor.decode(a, body)) |v| {
        if (Value.str(v.get("description"))) |d| return d;
    } else |_| {}
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, body, .{}) catch return body[0..@min(body.len, 200)];
    if (j == .object) if (j.object.get("description")) |d| if (d == .string) return d.string;
    return body[0..@min(body.len, 200)];
}

fn setting(in: Value, name: []const u8, def: i64) i64 {
    const d = in.get("defaults") orelse return def;
    const s = Value.str(d.get(name)) orelse return def;
    const v = std.fmt.parseInt(i64, s, 10) catch return def;
    return if (v > 0) v else def;
}

/// The thread's state, as its last step wrote it (stdout), or null on its first step.
fn saved(a: Allocator, in: Value) !?Value {
    const tip = Value.cidOf(in.get("tip")) orelse return null;
    const u = try sk.get(a, tip);
    const res = u.get("result") orelse return null;
    const out = cbor.decode(a, Value.bytesOf(res.get("stdout")) orelse "") catch return null;
    return if (out == .map) out else null;
}

const Ctx = struct {
    a: Allocator,
    in: Value,
    mc: []const u8,
    msg: Value,
    body: []const u8,
    url: []const u8,
    to: []const u8,
    at: i128,
    attempt: i64,

    /// One attempt: the message POSTed to <url>/sendMessage over the kernel's BRC-104 session.
    fn send(c: *Ctx) !void {
        const a = c.a;
        var m = cbor.MapBuilder.init(a);
        try m.put("recipient", .{ .bytes = c.to });
        try m.put("messageBox", cbor.string(Value.str(c.msg.get("box")) orelse ""));
        try m.put("body", .{ .bytes = c.body });
        try m.put("subject", c.msg.get("subject"));
        try m.put("nonce", c.msg.get("nonce"));
        var outer = cbor.MapBuilder.init(a);
        try outer.put("message", m.value());
        var h = cbor.MapBuilder.init(a);
        try h.put("content-type", cbor.string("application/cbor"));
        const ans = sk.authfetch(a, trimSlash(c.url), .{ .path = "/sendMessage", .headers = h.value(), .body = try cbor.encode(a, outer.value()) }) catch |err| {
            if (err == error.ImportFailed) return c.failed(sk.lastError());
            return err;
        };
        const status = Value.intOf(ans.get("status")) orelse 0;
        const rbody = Value.bytesOf(ans.get("body")) orelse "";
        if (status != 200) return c.failed(try std.fmt.allocPrint(a, "{s}Message Box send failed with HTTP {d}: {s}", .{ if (transientStatus(status)) "transient: " else "", status, describe(a, rbody) }));
        if (cbor.decode(a, rbody)) |v| {
            if (Value.str(v.get("id")) orelse Value.str(v.get("messageId"))) |theirs| {
                const tc = cid.parse(a, theirs) catch null;
                if (tc) |x| if (!eql(u8, x, c.mc)) return sk.report(try std.fmt.allocPrint(a, "the recipient keeps the message as {s}, not {s}", .{ theirs, try cid.format(a, c.mc) }));
            }
        } else |_| {}
        var out = cbor.MapBuilder.init(a);
        try out.put("delivered", cbor.cidv(c.mc));
        try out.put("url", cbor.string(c.url));
        try out.put("attempt", cbor.int(c.attempt));
        try sk.answer(a, out.value());
    }

    /// This attempt failed: a transient failure is tried again at the retry's
    /// deadline, up to the attempts allowed; else the thread ends errored
    /// (the kernel tells the thread awaiting the message: `undelivered`).
    fn failed(c: *Ctx, why: []const u8) !void {
        const a = c.a;
        const attempts = setting(c.in, "sendAttempts", SEND_ATTEMPTS);
        if (!sk.transient(why) or c.attempt >= attempts) {
            if (c.attempt > 1) return sk.report(try std.fmt.allocPrint(a, "{s} ({d} attempts)", .{ why, c.attempt }));
            return sk.report(why);
        }
        const wait = setting(c.in, "sendRetryMs", SEND_RETRY_MS);
        try sk.deadline(@intCast(c.at + wait));
        try std.Io.File.stderr().writeStreamingAll(sk.io(), try std.fmt.allocPrint(a, "delivery: attempt {d} failed ({s}); again in {d} ms\n", .{ c.attempt, why, wait }));
        var m = cbor.MapBuilder.init(a);
        try m.put("stage", cbor.string("retry"));
        try m.put("error", cbor.string(why));
        try m.put("attempt", cbor.int(c.attempt));
        try sk.answer(a, m.value());
    }
};

/// The resolve program's record of `key` (#87: head `resolve/peers`, {kind:
/// "resolutions", peers: [{key, peer: <cid>}]}, each {kind: "resolution",
/// key, transport: "mailbox", address, handle, domain, since, source}), or
/// null. Read for a key the address book does not name: the kernel sends
/// such a message here, and the address book (the owner's) wins when both name it.
fn resolutionOf(a: Allocator, key: []const u8) !?Value {
    const root = (try sk.head(a, RESOLUTIONS)) orelse return null;
    const r = try sk.get(a, root);
    const ps = r.get("peers") orelse return null;
    if (ps != .array) return null;
    for (ps.array) |x| if (eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) return try sk.get(a, Value.cidOf(x.get("peer")) orelse return null);
    return null;
}

/// A step of a message's delivery thread (#70): the first attempt, or the next at the retry's deadline.
pub fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const mc = Value.cidOf(args.get("message")) orelse return sk.report("delivery: no message");
    const msg = try sk.get(a, mc);
    const to = Value.bytesOf(msg.get("recipient")) orelse return sk.report("delivery: not a message record");
    const body = try sk.getBytes(a, Value.cidOf(msg.get("body")) orelse return sk.report("delivery: the message has no body"));
    const p = (try sk.peerOf(a, to)) orelse (try resolutionOf(a, to)) orelse return sk.report(try std.fmt.allocPrint(a, "no route to {s}: not in the address book, and not resolved", .{try sk.hex(a, to)}));
    if (!eql(u8, Value.str(p.get("transport")) orelse "", "mailbox")) return sk.report("delivery: the recipient is not reached by mailbox any more");
    const url = Value.str(p.get("address")) orelse return sk.report("delivery: the address book names no URL");
    const st = try saved(a, in);
    var c = Ctx{
        .a = a,
        .in = in,
        .mc = mc,
        .msg = msg,
        .body = body,
        .url = url,
        .to = to,
        .at = Value.intOf(in.get("at")) orelse 0,
        .attempt = if (st) |s| @intCast(Value.intOf(s.get("attempt")) orelse 1) else 1,
    };
    if (st != null) {
        // The retry's deadline: the next attempt.
        const w = in.get("woke") orelse return sk.report("delivery: stepped with nothing to go on with");
        if (w != .bool or !w.bool) return sk.report("delivery: stepped with nothing to go on with");
        c.attempt += 1;
    }
    return c.send();
}
