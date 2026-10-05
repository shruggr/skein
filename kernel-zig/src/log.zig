// The input log and the record shapes the scheduler checks, in format 8
// (#77: the kernel's four tables; format 7, #65, #69; format 6, #70, #67; format 5, #68; format 3, #40; format 2, #33: entries
// unsigned, identity keys as 33-byte byte strings in every record). Skein is
// a state process: every package a transport carries in is an entry,
// appended as received, and the instance's middleware (the front door) is
// stepped on it; a message the host admits directly and an event from the
// host's wiring (a header feed, a proof) are the others. There is no wake
// entry (format 7, #69): a deadline and a sleep are answered by the waker
// provider's signed message.
//
//   entry    {kind: "log", prev, n, time, genesis | mail | event+box | request+transport}
//   request  a package as a transport carried it in (#68), unverified: the
//            host verifies nothing. `transport` names the middleware stepped
//            on it (the genesis's front door for "http", "libp2p" and
//            "local": scheduler.zig middlewareOf). The record:
//              http    {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
//                      `path` as the client sent it (what BRC-104 signs), `route` what the
//                      routes table sees (the host strips `/@<handle>`)
//              libp2p  {kind: "p2p", topic, from: bytes, seqno: bytes(8), signature: bytes, body: bytes}
//                      a GossipSub message, signature and all — the same record an accepted
//                      message is routed as (box `libp2p:<topic>`)
//                      {kind: "p2p-frame", protocol, from: bytes, body: bytes}
//                      one frame of an inbound stream (unsigned: the stream is Noise's)
//              local   {kind: "message", message: <a signed mail record>, body: bytes}
//                      a signed message a host provider (or anyone the host hands one
//                      from) carried in with its body (#70): the front door checks the
//                      signature and routes it
//   mail     {kind: "mail", op: "put", sender: bytes, recipient: bytes, box, body: <cid>, subject?: <cid>,
//             json?: true, session?: {payload: bytes, signature: bytes, nonce, yourNonce} | nonce?: bytes, signature?: bytes}
//            a message (#40, #70): its CID is the message's id — what a
//            reply's `replyTo` names. Its sender is proven one of two ways:
//            `session`, the BRC-104 signed request it came in (a BRC-33
//            client's), or `signature`, the sender's own signature over the
//            record without it (an emitted message, #70: BRC-169's signing —
//            [2, "metanet handles envelope"], key "send", counterparty
//            anyone — so anyone can check it with the sender's key). Routed to
//            the thread awaiting the message its body's `replyTo` names, else
//            by subscription on (sender, box). Since #68 a message arrives
//            inside a request and the middleware's step routes it; a host may
//            still admit one as an entry of its own (the browser's).
//   event    a record from the host's wiring, self-validating (#29, #65: a
//            header from a feed; a proof — a transaction's merkle path — from
//            the broadcaster's Arcade session), routed by its `subject` or by box
//   genesis  {kind: "genesis", identity: bytes, owner?: bytes, handle, domain, programs,
//             dispatch: [<row>], scopes?: {<program name>: [<head name | prefix/>]}, peers?: {role: bytes},
//             defaults?, names?: [{identityKey: bytes, handle, domain}], collect?, tree?,
//             reads?: [{caller?: bytes, op}],
//             addressBook?: [{key: bytes, transport, address, role?, handle?, domain?}]}
//            `dispatch` (#77, format 8): the seed of the dispatch table (dispatch.zig: the rows
//            that route — boxes, HTTP paths, libp2p topics and protocols — and the admin rows
//            whose program is the kernel), written as the chain's first updates when the
//            genesis is processed. `scopes`: the heads a genesis-wired program (one with no
//            app record) may advance, by the program's name — an exact head name, or a prefix
//            ending in `/` (an app's program writes `<app>/…` by its record's `app`). A genesis
//            naming `subscriptions` or `routes` (format 7) is refused.
//            `tree` (issue #4): the system tree the instance booted from (a git
//            tree, its objects pre-filled by the loader); processing the genesis
//            sets the head `main` to it. `reads`: the front door's (#40).
//            `addressBook` (#70): the address book's seed (the host's providers,
//            the owner's mailbox), written into the head `peers` when the
//            genesis is processed.
//            No `owner` (#89): an image. The default image is one genesis
//            for everyone; its dispatch rows carry a `claim` row to the
//            kernel, and the owner comes with the claim (scheduler.zig
//            kernelOp, "claim"; the head `claim` keeps what was claimed).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const secp = @import("secp");
const syscalls = @import("syscalls.zig");
const dispatch = @import("dispatch.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

/// An event a program emits (#119), other than `broadcast`: {event: <name>,
/// …fields} → the record {kind: "event", event: <name>, app?: <app>, …fields}
/// — the emit's other fields as they are; `app` the emitting program's app
/// when its record is installed (the scheduler's installedAs), else none.
/// `kind` and `app` are the kernel's: an emit naming either is refused.
pub fn eventRecord(a: std.mem.Allocator, emit: Value, name: []const u8, app: ?[]const u8) error{ Reserved, OutOfMemory }!Value {
    if (emit.get("kind") != null or emit.get("app") != null) return error.Reserved;
    var rec = cbor.MapBuilder.init(a);
    try rec.put("kind", cbor.string("event"));
    try rec.put("event", cbor.string(name));
    if (app) |x| try rec.put("app", cbor.string(x));
    if (emit == .map) for (emit.map) |e| {
        const k = e.key;
        if (std.mem.eql(u8, k, "event")) continue;
        try rec.put(k, e.value);
    };
    return rec.value();
}

/// Whether a record is an emitted event of #119's kind ({kind: "event", event: <name>, …}).
pub fn isEvent(m: Value) bool {
    if (m != .map) return false;
    if (!std.mem.eql(u8, Value.str(m.get("kind")) orelse "", "event")) return false;
    return Value.str(m.get("event")) != null;
}

test "eventRecord (#119): the name, the app when installed, the emit's fields; kind and app are the kernel's" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var m = cbor.MapBuilder.init(a);
    try m.put("event", cbor.string("subscribe"));
    try m.put("topic", cbor.string("tm_ab"));
    const emit = m.value();
    const rec = try eventRecord(a, emit, "subscribe", "overlay");
    try std.testing.expect(isEvent(rec));
    try std.testing.expectEqualStrings("event", Value.str(rec.get("kind")).?);
    try std.testing.expectEqualStrings("subscribe", Value.str(rec.get("event")).?);
    try std.testing.expectEqualStrings("overlay", Value.str(rec.get("app")).?);
    try std.testing.expectEqualStrings("tm_ab", Value.str(rec.get("topic")).?);
    // An uninstalled record's event: no app.
    const bare = try eventRecord(a, emit, "subscribe", null);
    try std.testing.expect(bare.get("app") == null);
    // Same emit, same app: the same record (replay puts the same CID).
    try std.testing.expectEqualSlices(u8, try cbor.cidOfValue(a, rec), try cbor.cidOfValue(a, try eventRecord(a, emit, "subscribe", "overlay")));
    // A made-up name nobody wires is a record like any other.
    var n = cbor.MapBuilder.init(a);
    try n.put("event", cbor.string("made-up"));
    try std.testing.expect(isEvent(try eventRecord(a, n.value(), "made-up", null)));
    var f = cbor.MapBuilder.init(a);
    try f.put("event", cbor.string("subscribe"));
    try f.put("app", cbor.string("someone-else"));
    try std.testing.expectError(error.Reserved, eventRecord(a, f.value(), "subscribe", "overlay"));
    var k = cbor.MapBuilder.init(a);
    try k.put("event", cbor.string("x"));
    try k.put("kind", cbor.string("mail"));
    try std.testing.expectError(error.Reserved, eventRecord(a, k.value(), "x", null));
    var b = cbor.MapBuilder.init(a);
    try b.put("kind", cbor.string("broadcast"));
    try std.testing.expect(!isEvent(b.value()));
}

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

/// The one entry encoding (format 7, #69): {kind: "log", prev, n, time} and
/// exactly one of genesis | mail | event (+box) | request (+transport).
/// No signature on any of them.
pub fn isLogEntry(e: Value) bool {
    if (e != .map) return false;
    const kind = Value.str(e.get("kind")) orelse return false;
    if (!std.mem.eql(u8, kind, "log")) return false;
    if (!Value.isNumber(e.get("n"))) return false;
    if (e.get("sig") != null) return false; // format 1 (host-signed): refused
    var count: usize = 0;
    if (e.get("wake") != null) return false; // format 6: a wake entry (#69: the waker's message now)
    for ([_][]const u8{ "genesis", "mail", "event", "request" }) |k| {
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
    if (std.mem.eql(u8, transport, "local")) {
        // #70: a signed message and its body, as a provider carried it in.
        if (!std.mem.eql(u8, kind, "message")) return false;
        const m = r.get("message") orelse return false;
        if (!isMail(m) or Value.bytesOf(m.get("signature")) == null) return false;
        return Value.bytesOf(r.get("body")) != null;
    }
    return false;
}

/// The transports an address book entry may name (#70): a messagebox URL over
/// BRC-103/104, a libp2p peer ID or `topic:<name>`, a host provider's name.
pub const transports = [_][]const u8{ "mailbox", "libp2p", "local" };

pub fn isTransport(t: []const u8) bool {
    for (transports) |x| if (std.mem.eql(u8, x, t)) return true;
    return false;
}

/// An address book entry as a genesis seeds it, or as the head `peers` holds
/// it (#70): {key, transport, address, role?, handle?, domain?} (the peer
/// record adds kind, since, source).
pub fn isAddress(x: ?Value) bool {
    const e = x orelse return false;
    if (e != .map) return false;
    if (!secp.isKey(Value.bytesOf(e.get("key")) orelse return false)) return false;
    if (!isTransport(Value.str(e.get("transport")) orelse return false)) return false;
    if ((Value.str(e.get("address")) orelse return false).len == 0) return false;
    for ([_][]const u8{ "role", "handle", "domain" }) |k| if (e.get(k)) |v| if (v != .string and v != .null) return false;
    return true;
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
    if (m.get("subject")) |s| if (s != .cid) return false;
    if (m.get("session")) |s| {
        if (s != .map) return false;
        if (Value.bytesOf(s.get("payload")) == null or Value.bytesOf(s.get("signature")) == null) return false;
        if (Value.str(s.get("nonce")) == null or Value.str(s.get("yourNonce")) == null) return false;
        if (m.get("signature") != null) return false; // proven one way or the other
    }
    if (m.get("signature")) |s| if (s != .bytes) return false;
    if (m.get("nonce")) |s| if (s != .bytes) return false;
    return true;
}

/// A signed message's preimage (#70): the dag-cbor of its mail record without
/// `signature` — what the sender signed, BRC-169's way ([2, "metanet handles
/// envelope"], key "send", counterparty anyone; message.zig in the SDK (lib/)
/// checks it).
pub fn signedPart(a: std.mem.Allocator, m: Value) ![]u8 {
    return cbor.encode(a, try cbor.without(a, m, "signature"));
}

/// The BRC-43 protocol and key an emitted message is signed under (#70): BRC-169 §7.2's.
pub const MESSAGE_PROTOCOL = "metanet handles envelope";
pub const MESSAGE_KEY_ID = "send";

fn isCidMap(v: ?Value) bool {
    const m = v orelse return false;
    if (m != .map) return false;
    for (m.map) |e| if (e.value != .cid) return false;
    return true;
}

/// records.ts isGenesis.
pub fn isGenesis(x: ?Value) bool {
    const g = x orelse return false;
    if (g != .map) return false;
    if (!std.mem.eql(u8, Value.str(g.get("kind")) orelse return false, "genesis")) return false;
    if (!secp.isKey(Value.bytesOf(g.get("identity")) orelse return false)) return false;
    // #89: an image names no owner (the claim brings it); a genesis that names one names a key.
    if (g.get("owner")) |o| if (!secp.isKey(Value.bytesOf(o) orelse return false)) return false;
    if (g.get("host") != null) return false; // format 1
    // #62's attest key went with the recorded http/libp2p calls (#67, format 6).
    if (g.get("attest") != null) return false;
    // #60's jobs went with the host's cron clock (#69, format 7): a schedule is a message to the cron provider.
    if (g.get("jobs") != null) return false;
    // #70: the address book's seed.
    if (g.get("addressBook")) |ab| {
        if (ab != .array) return false;
        for (ab.array) |e| if (!isAddress(e)) return false;
    }
    if (Value.str(g.get("handle")) == null or Value.str(g.get("domain")) == null) return false;
    if (!isCidMap(g.get("programs"))) return false;
    // #77 (format 8): one dispatch table; no subscriptions chain, no routes.
    if (g.get("subscriptions") != null or g.get("routes") != null) return false;
    const rows = g.get("dispatch") orelse return false;
    if (rows != .array) return false;
    var scratch: [4096]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&scratch);
    for (rows.array) |r| {
        fba.reset();
        const bad = dispatch.problem(fba.allocator(), r) catch return false;
        if (bad != null) return false;
    }
    if (g.get("scopes")) |sc| {
        if (sc != .map) return false;
        for (sc.map) |e| {
            if (e.value != .array) return false;
            for (e.value.array) |h| if (h != .string or h.string.len == 0) return false;
        }
    }
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
    // #40: the front door's reads [{caller?, op}].
    if (g.get("reads")) |rs| {
        if (rs != .array) return false;
        for (rs.array) |r| {
            if (r != .map or Value.str(r.get("op")) == null) return false;
            if (r.get("caller")) |c| if (!secp.isKey(Value.bytesOf(c) orelse return false)) return false;
        }
    }
    return true;
}

/// A signer call a step made (#67: the one recorded call left): {kind:
/// "oracle", thread, step, i, request: bytes (the BRC-100 wire frame),
/// result: bytes (its answer)}. Replay serves `result` for the call at (thread,
/// step, i) and never asks a wallet (records.ts isSignerCall). The kind
/// keeps the signer's old name, `oracle`: it is part of the format.
pub fn isSignerCall(x: ?Value) bool {
    const a = x orelse return false;
    if (a != .map) return false;
    if (!std.mem.eql(u8, Value.str(a.get("kind")) orelse return false, "oracle")) return false;
    if (Value.cidOf(a.get("thread")) == null) return false;
    if (!Value.isNumber(a.get("step")) or !Value.isNumber(a.get("i"))) return false;
    if (Value.bytesOf(a.get("request")) == null) return false;
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
