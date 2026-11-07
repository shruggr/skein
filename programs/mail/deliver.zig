//! Delivery (#70, #67, #126, #157): the outbound middleware of the `mailbox`
//! transport. A message a step emits to a recipient whose address book entry
//! is `{transport: "mailbox", address: <messagebox URL>}` — or, for a key the
//! address book does not name, whose record the resolve program kept
//! (`resolve/peers`, #87) — is delivered by the instance: the kernel launches
//! this program as the message's **delivery thread** (args {message: <the
//! mail record>, transport: "mailbox"}), and its first step emits the
//! `deliver` intention (#157) — {event: "deliver", transport: "mailbox", url:
//! <the messagebox URL>, message: <the mail record's CID>}, the kernel adding
//! its `nonce` — and awaits it. A step never waits on the outside world: the
//! HOST carries it (BRC-103's handshake at <url>/.well-known/auth, then a
//! BRC-104 POST to <url>/sendMessage signed with the instance's key, the body
//! BRC-231 CBOR {message: {recipient, messageBox, body, subject?, nonce}} —
//! the BRC-33 message, and the emit's own subject and nonce, so the recipient
//! keeps the record this instance emitted, under the same CID), and the answer
//! comes back as an entry that stands on its own at the door: the server's
//! BRC-104 signature over it (door.zig deliveryAnswer). That steps this
//! thread: 200 and that CID → finished {delivered: <cid>, url}; any other
//! status → errored with it, and the kernel steps the thread awaiting the
//! message with `undelivered: {message, error}`. No answer at all (the server
//! unreachable): nothing is admitted and the thread rests; the kernel offers
//! the intention again at every start (no deadline, no attempts here).
//! Sending never tells the peer who we are beyond the session (no claim, no
//! registration: application wiring, #40).
const std = @import("std");
const cbor = @import("cbor");
const cid = cbor.cidm;
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

/// The resolve program's records (#87), read, never written here.
const RESOLUTIONS = "resolve/peers";

fn trimSlash(s: []const u8) []const u8 {
    return std.mem.trimEnd(u8, s, "/");
}

fn describe(a: Allocator, body: []const u8) []const u8 {
    if (cbor.decode(a, body)) |v| {
        if (Value.str(v.get("description"))) |d| return d;
    } else |_| {}
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, body, .{}) catch return body[0..@min(body.len, 200)];
    if (j == .object) if (j.object.get("description")) |d| if (d == .string) return d.string;
    return body[0..@min(body.len, 200)];
}

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

/// A step of a message's delivery thread: the first emits the `deliver` intention and awaits it;
/// the next is stepped by its answer (an event about the intention, #157).
pub fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const mc = Value.cidOf(args.get("message")) orelse return sk.report("delivery: no message");
    if (in.get("event")) |ev| return answered(a, mc, ev);
    const msg = try sk.get(a, mc);
    const to = Value.bytesOf(msg.get("recipient")) orelse return sk.report("delivery: not a message record");
    const p = (try sk.peerOf(a, to)) orelse (try resolutionOf(a, to)) orelse return sk.report(try std.fmt.allocPrint(a, "no route to {s}: not in the address book, and not resolved", .{try sk.hex(a, to)}));
    if (!eql(u8, Value.str(p.get("transport")) orelse "", "mailbox")) return sk.report("delivery: the recipient is not reached by mailbox any more");
    const url = Value.str(p.get("address")) orelse return sk.report("delivery: the address book names no URL");
    var q = cbor.MapBuilder.init(a);
    try q.put("event", cbor.string("deliver"));
    try q.put("transport", cbor.string("mailbox"));
    try q.put("url", cbor.string(trimSlash(url)));
    try q.put("message", cbor.cidv(mc));
    const bytes = try cbor.encode(a, q.value());
    const id = try sk.result(a, sk.raw.emit, .{ bytes.ptr, @as(u32, @intCast(bytes.len)) });
    try sk.awaitRecord(id);
    var m = cbor.MapBuilder.init(a);
    try m.put("stage", cbor.string("sent"));
    try m.put("deliver", cbor.cidv(id));
    try m.put("url", cbor.string(url));
    try sk.answer(a, m.value());
}

/// The answer to the intention (door-checked: the server's signature over it): {kind: "delivery",
/// replyTo, peer, nonce, yourNonce, signature, status, headers?, body}.
fn answered(a: Allocator, mc: []const u8, ev: Value) !void {
    const rc = Value.cidOf(ev.get("event")) orelse return sk.report("delivery: stepped with nothing to go on with");
    const r = try sk.get(a, rc);
    if (!eql(u8, Value.str(r.get("kind")) orelse "", "delivery")) return sk.report("delivery: stepped with nothing to go on with");
    const status = Value.intOf(r.get("status")) orelse 0;
    const rbody = Value.bytesOf(r.get("body")) orelse "";
    if (status != 200) return sk.report(try std.fmt.allocPrint(a, "Message Box send failed with HTTP {d}: {s}", .{ status, describe(a, rbody) }));
    if (cbor.decode(a, rbody)) |v| {
        if (Value.str(v.get("id")) orelse Value.str(v.get("messageId"))) |theirs| {
            const tc = cid.parse(a, theirs) catch null;
            if (tc) |x| if (!eql(u8, x, mc)) return sk.report(try std.fmt.allocPrint(a, "the recipient keeps the message as {s}, not {s}", .{ theirs, try cid.format(a, mc) }));
        }
    } else |_| {}
    var out = cbor.MapBuilder.init(a);
    try out.put("delivered", cbor.cidv(mc));
    const d = try sk.get(a, Value.cidOf(r.get("replyTo")) orelse return sk.report("delivery: the answer names no intention"));
    try out.put("url", d.get("url"));
    try sk.answer(a, out.value());
}
