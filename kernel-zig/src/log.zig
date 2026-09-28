// The input log and the record shapes the scheduler checks, in format 2
// (issue #33): entries are unsigned — `prev` fixes the order, messages are
// signed by their senders, the router's stamp is the environment's word — and
// identity keys are 33-byte byte strings in every record (no hex).
//
//   entry    {kind: "log", prev, n, time, genesis | envelope+box+body | wake | outcome | mail | event+box}
//   event    a record from a feed (#29: a header, a proof, a status), routed by its `subject` or by box
//   mail     {op: "put", recipient: bytes, box, sender: bytes, messageId, body: bytes, json?}
//          | {op: "ack", recipient: bytes, messageIds: [text]}
//            the messagebox's state changes for a hosted identity (issue #33), routed
//            by subscription on the reserved box `:mail` (sender: the mail's sender,
//            or the recipient acknowledging)
//   genesis  {kind: "genesis", identity: bytes, owner: bytes, handle, domain, programs,
//             subscriptions: [{match: {sender?: bytes, box?}, handler}], peers?: {role: bytes},
//             defaults?, names?: [{identityKey: bytes, handle, domain}], collect?, tree?}
//            `tree` (issue #4): the system tree the instance booted from (a git
//            tree, its objects pre-filled by the loader); processing the genesis
//            sets the head `main` to it
//   emit     {kind: "emit", to: bytes, box, body, envelope}   (the envelope in either encoding, envelope.zig)
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const secp = @import("secp.zig");
const syscalls = @import("syscalls.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub fn stampOf(v: ?Value) ?syscalls.Stamp {
    const t = v orelse return null;
    if (t != .array or t.array.len != 2) return null;
    const s = Value.intOf(t.array[0]) orelse return null;
    const n = Value.intOf(t.array[1]) orelse return null;
    return .{ .sec = @intCast(s), .nsec = @intCast(n) };
}

pub fn isOutcome(x: ?Value) bool {
    const o = x orelse return false;
    if (o != .map) return false;
    if (Value.cidOf(o.get("emit")) == null) return false;
    const st = Value.str(o.get("status")) orelse return false;
    if (!std.mem.eql(u8, st, "delivered") and !std.mem.eql(u8, st, "failed")) return false;
    if (o.get("reason")) |r| if (r != .string) return false;
    return true;
}

/// A plain entry (#29): an event the host admits from a feed it holds (a
/// header, a proof, a transaction status), the record `event` names, routed
/// by `box` (or its `subject`). No envelope: it self-validates inside the
/// program that takes it.
pub fn isEventEntry(e: Value) bool {
    return isLogEntry(e) and e.get("event") != null;
}

/// The one entry encoding (format 2, #33): {kind: "log", prev, n, time} and
/// exactly one of genesis | envelope (+box, body) | wake | outcome | mail |
/// event (+box). No signature on any of them.
pub fn isLogEntry(e: Value) bool {
    if (e != .map) return false;
    const kind = Value.str(e.get("kind")) orelse return false;
    if (!std.mem.eql(u8, kind, "log")) return false;
    if (!Value.isNumber(e.get("n"))) return false;
    if (e.get("sig") != null) return false; // format 1 (host-signed): refused
    var count: usize = 0;
    for ([_][]const u8{ "genesis", "envelope", "wake", "outcome", "mail", "event" }) |k| {
        if (e.get(k) != null) count += 1;
    }
    if (count != 1) return false;
    if ((e.get("envelope") == null) != (e.get("body") == null)) return false;
    // A box goes with an envelope or an event, and only with them.
    const boxed = e.get("envelope") != null or e.get("event") != null;
    if (boxed) {
        const box = Value.str(e.get("box")) orelse return false;
        if (box.len == 0) return false;
    } else if (e.get("box") != null) return false;
    if (e.get("event")) |v| if (v != .cid) return false;
    if (e.get("outcome")) |o| if (!isOutcome(o)) return false;
    if (e.get("mail")) |m| if (!isMail(m)) return false;
    return true;
}

/// The box a `mail` entry is routed in (subscriptions.zig): reserved, never a BRC-33 box a client names.
pub const MAIL_BOX = ":mail";

pub fn isMail(x: ?Value) bool {
    const m = x orelse return false;
    if (m != .map) return false;
    if (!secp.isKey(Value.bytesOf(m.get("recipient")) orelse return false)) return false;
    const op = Value.str(m.get("op")) orelse return false;
    if (std.mem.eql(u8, op, "put")) {
        if (!secp.isKey(Value.bytesOf(m.get("sender")) orelse return false)) return false;
        const box = Value.str(m.get("box")) orelse return false;
        if (box.len == 0) return false;
        if ((Value.str(m.get("messageId")) orelse return false).len == 0) return false;
        if (Value.bytesOf(m.get("body")) == null) return false;
        if (m.get("json")) |j| if (j != .bool) return false;
        return true;
    }
    if (std.mem.eql(u8, op, "ack")) {
        const ids = m.get("messageIds") orelse return false;
        if (ids != .array or ids.array.len == 0) return false;
        for (ids.array) |i| if (i != .string) return false;
        return true;
    }
    return false;
}

fn isCidMap(v: ?Value) bool {
    const m = v orelse return false;
    if (m != .map) return false;
    for (m.map) |e| if (e.value != .cid) return false;
    return true;
}

/// records.ts isSubscription.
fn isSubscription(x: Value) bool {
    if (x != .map) return false;
    const m = x.get("match") orelse return false;
    if (m != .map) return false;
    if (m.get("sender")) |s| if (!secp.isKey(Value.bytesOf(s) orelse return false)) return false;
    if (m.get("box")) |b| if (b != .string) return false;
    return Value.cidOf(x.get("handler")) != null;
}

/// records.ts isGenesis.
pub fn isGenesis(x: ?Value) bool {
    const g = x orelse return false;
    if (g != .map) return false;
    if (!std.mem.eql(u8, Value.str(g.get("kind")) orelse return false, "genesis")) return false;
    for ([_][]const u8{ "identity", "owner" }) |k| {
        if (!secp.isKey(Value.bytesOf(g.get(k)) orelse return false)) return false;
    }
    if (g.get("host") != null) return false; // format 1
    if (Value.str(g.get("handle")) == null or Value.str(g.get("domain")) == null) return false;
    if (!isCidMap(g.get("programs"))) return false;
    const subs = g.get("subscriptions") orelse return false;
    if (subs != .array) return false;
    for (subs.array) |s| if (!isSubscription(s)) return false;
    if (g.get("peers")) |p| {
        if (p != .map) return false;
        for (p.map) |e| if (!secp.isKey(Value.bytesOf(e.value) orelse return false)) return false;
    }
    if (g.get("defaults")) |d| {
        if (d != .map) return false;
        for (d.map) |e| if (e.value != .string) return false;
    }
    if (g.get("names")) |n| {
        if (n != .array) return false;
        for (n.array) |e| {
            if (e != .map or !secp.isKey(Value.bytesOf(e.get("identityKey")) orelse return false)) return false;
            if (Value.str(e.get("handle")) == null or Value.str(e.get("domain")) == null) return false;
        }
    }
    if (g.get("collect")) |c| {
        if (c != .array) return false;
        for (c.array) |b| if (b != .string or b.string.len == 0) return false;
    }
    if (g.get("tree")) |t| if (Value.cidOf(t) == null or cidm.codecOf(Value.cidOf(t).?) != cidm.GIT_RAW) return false;
    return true;
}

/// records.ts isEmit.
pub fn isEmit(x: ?Value) bool {
    const e = x orelse return false;
    if (e != .map) return false;
    if (!std.mem.eql(u8, Value.str(e.get("kind")) orelse return false, "emit")) return false;
    if (!secp.isKey(Value.bytesOf(e.get("to")) orelse return false)) return false;
    const box = Value.str(e.get("box")) orelse return false;
    if (box.len == 0) return false;
    if (Value.cidOf(e.get("body")) == null) return false;
    const env = e.get("envelope") orelse return false;
    return env == .map and env.get("content") != null;
}

/// records.ts isAttested.
pub fn isAttested(x: ?Value) bool {
    const a = x orelse return false;
    if (a != .map) return false;
    if (!std.mem.eql(u8, Value.str(a.get("kind")) orelse return false, "attested")) return false;
    if (Value.cidOf(a.get("thread")) == null) return false;
    if (!Value.isNumber(a.get("step")) or !Value.isNumber(a.get("i"))) return false;
    const op = Value.str(a.get("op")) orelse return false;
    if (!std.mem.eql(u8, op, "wallet") and !std.mem.eql(u8, op, "resolve") and !std.mem.eql(u8, op, "http")) return false;
    return Value.bytesOf(a.get("result")) != null;
}

/// The genesis a log starts with (log.ts genesisOf).
pub fn genesisOf(a: std.mem.Allocator, s: Store) !Value {
    const first = try s.logFrom(a, 0);
    if (first.len == 0) return error.EmptyLog;
    const e = (try s.get(a, first[0])) orelse return error.NotFound;
    const gc = Value.cidOf(e.get("genesis")) orelse return error.NoGenesis;
    const g = s.getOpt(a, gc);
    if (!isGenesis(g)) return error.NoGenesis;
    return g.?;
}
