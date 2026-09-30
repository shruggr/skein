// The input log and the record shapes the scheduler checks, in format 5
// (issue #68; format 3, #40; format 2, #33: entries unsigned, identity keys
// as 33-byte byte strings in every record). Skein is a state process: every
// package a transport carries in is an entry, appended as received, and the
// instance's middleware (the front door) is stepped on it; a message the
// host admits directly, a wake and an event from a feed are the others.
//
//   entry    {kind: "log", prev, n, time, genesis | mail | wake | event+box | request+transport}
//   request  a package as a transport carried it in (#68), unverified: the
//            host verifies nothing. `transport` names the middleware stepped
//            on it (the genesis's front door for "http" and "libp2p"; #70
//            adds "local": scheduler.zig middlewareOf). The record:
//              http    {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
//                      `path` as the client sent it (what BRC-104 signs), `route` what the
//                      routes table sees (the host strips `/@<handle>`)
//              libp2p  {kind: "p2p", topic, from: bytes, seqno: bytes(8), signature: bytes, body: bytes}
//                      a GossipSub message, signature and all — the same record an accepted
//                      message is routed as (box `libp2p:<topic>`)
//                      {kind: "p2p-frame", protocol, from: bytes, body: bytes}
//                      one frame of an inbound stream (unsigned: the stream is Noise's)
//   mail     {kind: "mail", op: "put", sender: bytes, recipient: bytes, box, body: <cid>, json?: true,
//             session?: {payload: bytes, signature: bytes, nonce, yourNonce}}
//            a BRC-33 message (#40): the sender is the BRC-104 session's
//            identity, `session` the signed request and its nonces (so the log
//            verifies with the instance's key alone); its CID is the message's
//            id — what a reply's `replyTo` names. Routed to the thread awaiting
//            the message its body's `replyTo` names, else by subscription on
//            (sender, box). Since #68 a message arrives inside a request and
//            the middleware's step routes it; a host may still admit one as an
//            entry of its own (the browser's).
//   event    a record from a feed (#29: a header, a proof, a status), routed
//            by its `subject` or by box
//   genesis  {kind: "genesis", identity: bytes, owner: bytes, handle, domain, programs,
//             subscriptions: [{match: {sender?: bytes, box?}, handler}], peers?: {role: bytes},
//             defaults?, names?: [{identityKey: bytes, handle, domain}], collect?, tree?,
//             routes?: [{path | prefix, program, fn, auth?, read?}], reads?: [{caller?: bytes, op}]}
//            `tree` (issue #4): the system tree the instance booted from (a git
//            tree, its objects pre-filled by the loader); processing the genesis
//            sets the head `main` to it. `routes`/`reads`: the front door's (#40).
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

/// A plain entry (#29): an event the host admits from a feed it holds (a
/// header, a proof, a transaction status), the record `event` names, routed
/// by `box` (or its `subject`). No envelope: it self-validates inside the
/// program that takes it.
pub fn isEventEntry(e: Value) bool {
    return isLogEntry(e) and e.get("event") != null;
}

/// The one entry encoding (format 5, #68): {kind: "log", prev, n, time} and
/// exactly one of genesis | mail | wake | event (+box) | request (+transport).
/// No signature on any of them.
pub fn isLogEntry(e: Value) bool {
    if (e != .map) return false;
    const kind = Value.str(e.get("kind")) orelse return false;
    if (!std.mem.eql(u8, kind, "log")) return false;
    if (!Value.isNumber(e.get("n"))) return false;
    if (e.get("sig") != null) return false; // format 1 (host-signed): refused
    var count: usize = 0;
    for ([_][]const u8{ "genesis", "mail", "wake", "event", "request" }) |k| {
        if (e.get(k) != null) count += 1;
    }
    if (count != 1) return false;
    for ([_][]const u8{ "envelope", "body", "outcome" }) |k| if (e.get(k) != null) return false; // format 2
    // A box goes with an event, and only with it.
    if (e.get("event") != null) {
        if (e.get("event").? != .cid) return false;
        const box = Value.str(e.get("box")) orelse return false;
        if (box.len == 0) return false;
    } else if (e.get("box") != null) return false;
    if (e.get("mail")) |m| if (m != .cid) return false;
    // A transport goes with a request, and only with it (#68).
    if (e.get("request")) |r| {
        if (r != .cid) return false;
        const t = Value.str(e.get("transport")) orelse return false;
        if (t.len == 0) return false;
    } else if (e.get("transport") != null) return false;
    return true;
}

/// A request record (#68): the package a transport carried in, in the shape
/// that transport's middleware reads (the header's table). Checked at
/// admission for its form only; what it says is the middleware's to judge.
pub fn isRequest(transport: []const u8, x: ?Value) bool {
    const r = x orelse return false;
    if (r != .map) return false;
    const kind = Value.str(r.get("kind")) orelse return false;
    if (std.mem.eql(u8, transport, "http")) {
        if (!std.mem.eql(u8, kind, "http")) return false;
        for ([_][]const u8{ "method", "path", "route", "query" }) |k| if (Value.str(r.get(k)) == null) return false;
        const h = r.get("headers") orelse return false;
        if (h != .map) return false;
        for (h.map) |e| if (e.value != .string) return false;
        return Value.bytesOf(r.get("body")) != null;
    }
    if (std.mem.eql(u8, transport, "libp2p")) {
        if (Value.bytesOf(r.get("from")) == null or Value.bytesOf(r.get("body")) == null) return false;
        if (std.mem.eql(u8, kind, "p2p")) {
            if (Value.str(r.get("topic")) == null) return false;
            return Value.bytesOf(r.get("seqno")) != null and Value.bytesOf(r.get("signature")) != null;
        }
        if (std.mem.eql(u8, kind, "p2p-frame")) return Value.str(r.get("protocol")) != null;
        return false;
    }
    return false;
}

/// A message record (#40): a BRC-33 message that arrived, its sender the
/// authenticated one. A box a client names never starts with ':' (reserved
/// for the host's own boxes).
pub fn isMail(x: ?Value) bool {
    const m = x orelse return false;
    if (m != .map) return false;
    if (!std.mem.eql(u8, Value.str(m.get("kind")) orelse return false, "mail")) return false;
    if (!std.mem.eql(u8, Value.str(m.get("op")) orelse return false, "put")) return false;
    if (!secp.isKey(Value.bytesOf(m.get("sender")) orelse return false)) return false;
    if (!secp.isKey(Value.bytesOf(m.get("recipient")) orelse return false)) return false;
    const box = Value.str(m.get("box")) orelse return false;
    if (box.len == 0 or box[0] == ':') return false;
    if (Value.cidOf(m.get("body")) == null) return false;
    if (m.get("json")) |j| if (j != .bool) return false;
    if (m.get("session")) |s| {
        if (s != .map) return false;
        if (Value.bytesOf(s.get("payload")) == null or Value.bytesOf(s.get("signature")) == null) return false;
        if (Value.str(s.get("nonce")) == null or Value.str(s.get("yourNonce")) == null) return false;
    }
    return true;
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
    // #62: the host's attest key, which every recorded http/libp2p call is signed with.
    if (g.get("attest")) |k| if (!secp.isKey(Value.bytesOf(k) orelse return false)) return false;
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
    // #40: the front door's routes [{path | prefix, program, fn, auth?, read?}] and reads [{caller?, op}].
    if (g.get("routes")) |rs| {
        if (rs != .array) return false;
        for (rs.array) |r| {
            if (r != .map or Value.cidOf(r.get("program")) == null or Value.str(r.get("fn")) == null) return false;
            if ((Value.str(r.get("path")) == null) == (Value.str(r.get("prefix")) == null)) return false;
        }
    }
    if (g.get("reads")) |rs| {
        if (rs != .array) return false;
        for (rs.array) |r| {
            if (r != .map or Value.str(r.get("op")) == null) return false;
            if (r.get("caller")) |c| if (!secp.isKey(Value.bytesOf(c) orelse return false)) return false;
        }
    }
    return true;
}

/// records.ts isAttested.
pub fn isAttested(x: ?Value) bool {
    const a = x orelse return false;
    if (a != .map) return false;
    if (!std.mem.eql(u8, Value.str(a.get("kind")) orelse return false, "attested")) return false;
    if (Value.cidOf(a.get("thread")) == null) return false;
    if (!Value.isNumber(a.get("step")) or !Value.isNumber(a.get("i"))) return false;
    const op = Value.str(a.get("op")) orelse return false;
    if (!std.mem.eql(u8, op, "wallet") and !std.mem.eql(u8, op, "http") and !std.mem.eql(u8, op, "libp2p")) return false;
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
