// The input log and the record shapes the scheduler checks, in format 9
// (#143: routes, filters, roles; #77: the kernel's four tables; format 7, #65, #69; format 6, #70, #67; format 5, #68; format 3, #40; format 2, #33: entries
// unsigned, identity keys as 33-byte byte strings in every record). Skein is
// a state process: every package a transport carries in is an entry,
// appended as received, and the instance's middleware (the front door) is
// stepped on it; a message the host admits directly and an event from the
// host's wiring (a header feed, a proof) are the others. There is no wake
// entry (format 7, #69): a deadline and a sleep are answered by the waker
// provider's signed message.
//
//   entry    {kind: "log", prev, n, time, genesis | mail | event+box | request+transport (+ door)}
//   door     (#121, #143) a request's admission: what the door established before the entry was
//            written — {principal?: bytes(33) (who the filters, or the transport, say it is from),
//            verified?: {caller, theirs, requestId} (kernel.brc104's: the session the answer is
//            signed on), filters?: [<the route's filters that ran>], beefs?: [<pointer record CID>],
//            blocks?: [<CID a filter stored>], bodies?: [{of, is}]} — the request record then the
//            package as the door handed it back (a filter's rewrite: door.zig, beef.zig). A request
//            a filter rejects or answers, or the gate refuses, writes no entry (#143)
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
//              local   {kind: "message", message: <a mail record>, body: bytes}
//                      a message the host carried in with its body (#70): a provider's
//                      answer or a forwarded claim, signed (the front door checks the
//                      signature), or the host's loopback (#79) — this instance's own
//                      emit to itself, unsigned (the front door finds it in the store)
//   mail     {kind: "mail", op: "put", sender: bytes, recipient: bytes, box, body: <cid>, subject?: <cid>,
//             (#127: a claim, box `claim`, may name no recipient — signed before the instance it
//             claims existed and forwarded into it by the host)
//             json?: true, session?: {payload: bytes, signature: bytes, nonce, yourNonce} | nonce?: bytes, signature?: bytes}
//            a message (#40, #70): its CID is the message's id — what a
//            reply's `replyTo` names. Its sender is proven by the transport
//            that carried it (#126 step 4): `session`, the BRC-104 signed
//            request it came in (a BRC-33 client's); an emitted message
//            (`nonce`: the emit's own, no session) delivered on the sender's
//            BRC-104 session to this instance's front door or over libp2p —
//            the request entry it was admitted from holds the proof, and the
//            record is the one the sender emitted, so both know it by one CID.
//            `signature` (BRC-169's signing — [2, "metanet handles envelope"],
//            key "send", counterparty anyone; the SDK's message.zig) is on the
//            records no session of this instance's carries: a claim (#127), a
//            host provider's answer and the instance's request an intention's
//            answer carries (#126); and on every emitted message in a log
//            written before #126 step 4, read (replay serves that signing from
//            the witness: scheduler.zig oldEnvelope), never written. Routed to
//            the thread awaiting the message its body's `replyTo` names, else
//            by subscription on (sender, box). Since #68 a message arrives
//            inside a request and the middleware's step routes it; a host may
//            still admit one as an entry of its own (the browser's).
//   event    a record from the host's wiring, self-validating (#29, #65: a
//            header from a feed; a proof — a transaction's merkle path — from
//            the broadcaster's Arcade session), routed by its `subject` or by box
//   genesis  {kind: "genesis", identity: bytes, root?: [bytes], handle, domain, programs,
//             dispatch: [<route>], roles?: {<role>: ["<program>.<fn>"]},
//             scopes?: {<program name>: [<head name | prefix/>]}, peers?: {role: bytes},
//             defaults?, names?: [{identityKey: bytes, handle, domain}], collect?, tree?,
//             addressBook?: [{key: bytes, transport, address, handle?, domain?}]}
//            `dispatch` (#77; #143, format 9): the seed of the route table (dispatch.zig: the routes
//            — boxes, events, HTTP paths, libp2p topics and protocols — and the admin routes
//            whose program is the kernel), written as the chain's first updates when the
//            genesis is processed. `root` (#143): the initial root holders, written into the
//            head `grants` when the genesis is processed (grants.zig); none: an image, claimed
//            by its first claim. `roles` (#143): what gates the genesis's own programs'
//            functions (the explorer: {root: ["frontdoor.explore"]}). No `owner` (#143: the
//            owner is root), no `reads` (#143: a read is a route). `scopes`: the heads a genesis-wired program (one with no
//            app record) may advance, by the program's name — an exact head name, or a prefix
//            ending in `/` (an app's program writes `<app>/…` by its record's `app`). A genesis
//            naming `subscriptions` or `routes` (format 7) is refused.
//            `tree` (issue #4): the system tree the instance booted from (a git
//            tree, its objects pre-filled by the loader); processing the genesis
//            sets the head `main` to it.
//            `heads` (#141): {<head name>: <record CID>} — an image's installed apps (`<app>/app`,
//            the app record); processing the genesis advances each, after
//            the dispatch rows (the records pre-filled by the loader, as the tree's objects are).
//            `addressBook` (#70): the address book's seed (the host's providers,
//            the owner's mailbox), written into the head `peers` when the
//            genesis is processed.
//            No `root` (#89, #143): an image. The default image is one genesis
//            for everyone; its routes carry a `claim` route to the kernel,
//            and root comes with the claim (scheduler.zig claim: root granted
//            to the claimant; the head `claim` keeps what was claimed).
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

/// A `deadline` event (#126): a thread's intention to rest until `at` (ms) at
/// most, recorded by the kernel when a step ends waiting with a deadline (or a
/// shell sleeps) — {kind: "event", event: "deadline", at, thread: <origin>,
/// step: <n>, app?}. `thread` and `step` make it that wait's own record; the
/// runtime answers it at `at` with a signed message naming it (`replyTo`) and
/// carrying the instance's signed request for it (the scheduler's
/// intentionAnswer), which steps the thread with `woke`.
pub fn deadlineRecord(a: std.mem.Allocator, at: i64, thread: []const u8, step: i64, app: ?[]const u8) error{OutOfMemory}!Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("at", cbor.int(at));
    try m.put("thread", cbor.cidv(thread));
    try m.put("step", cbor.int(step));
    return eventRecord(a, m.value(), "deadline", app) catch |err| switch (err) {
        error.Reserved => unreachable,
        error.OutOfMemory => error.OutOfMemory,
    };
}

test "deadlineRecord (#126): an event the wait owns — at, thread, step, the app when installed" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const t1 = try cbor.cidOfValue(a, cbor.string("thread one"));
    const t2 = try cbor.cidOfValue(a, cbor.string("thread two"));
    const r = try deadlineRecord(a, 1_700_000_000_000, t1, 3, "demo");
    try std.testing.expect(isEvent(r));
    try std.testing.expectEqualStrings("deadline", Value.str(r.get("event")).?);
    try std.testing.expectEqual(@as(i128, 1_700_000_000_000), Value.intOf(r.get("at")).?);
    try std.testing.expectEqualSlices(u8, t1, Value.cidOf(r.get("thread")).?);
    try std.testing.expectEqual(@as(i128, 3), Value.intOf(r.get("step")).?);
    try std.testing.expectEqualStrings("demo", Value.str(r.get("app")).?);
    // Two threads resting until the same time rest on two records; the same wait is the same record (replay).
    const c1 = try cbor.cidOfValue(a, r);
    try std.testing.expect(!std.mem.eql(u8, c1, try cbor.cidOfValue(a, try deadlineRecord(a, 1_700_000_000_000, t2, 3, "demo"))));
    try std.testing.expect(!std.mem.eql(u8, c1, try cbor.cidOfValue(a, try deadlineRecord(a, 1_700_000_000_000, t1, 4, "demo"))));
    try std.testing.expectEqualSlices(u8, c1, try cbor.cidOfValue(a, try deadlineRecord(a, 1_700_000_000_000, t1, 3, "demo")));
    try std.testing.expect((try deadlineRecord(a, 5, t1, 1, null)).get("app") == null);
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
    // A transport goes with a request, and only with it (#68); so does the door's outcome (#121).
    // #143: no `refused` — a request the door turns away writes no entry.
    if (e.get("refused") != null) return false;
    if (e.get("request")) |r| {
        if (r != .cid) return false;
        const t = Value.str(e.get("transport")) orelse return false;
        if (t.len == 0) return false;
        if (e.get("door")) |d| if (d != .map) return false;
    } else if (e.get("transport") != null or e.get("door") != null) return false;
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
        // #70: a signed message and its body, as a provider carried it in — or (#79, #126 step 4)
        // the loopback, the instance's own unsigned emit to itself (the front door checks it is).
        if (!std.mem.eql(u8, kind, "message")) return false;
        const m = r.get("message") orelse return false;
        if (!isMail(m)) return false;
        if (Value.bytesOf(m.get("signature")) == null and !std.mem.eql(u8, Value.bytesOf(m.get("sender")).?, Value.bytesOf(m.get("recipient")) orelse "")) return false;
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
/// it (#70): {key, transport, address, handle?, domain?} (the peer record adds
/// kind, since, source). No role (#126); an older genesis's `role` (text) is
/// read and not kept.
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
    const box = Value.str(m.get("box")) orelse return false;
    if (box.len == 0 or box[0] == ':') return false;
    // #127: a claim may name no recipient (signed before the instance it claims existed, forwarded into it).
    if (m.get("recipient")) |r| {
        if (!secp.isKey(Value.bytesOf(r) orelse return false)) return false;
    } else if (!std.mem.eql(u8, box, CLAIM_BOX)) return false;
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
/// checks it): a claim, a provider's answer, an emit in a log before #126 step 4.
pub fn signedPart(a: std.mem.Allocator, m: Value) ![]u8 {
    return cbor.encode(a, try cbor.without(a, m, "signature"));
}

/// The BRC-43 protocol and key a signed message is signed under (#70: BRC-169 §7.2's) — a claim, a
/// provider's answer, an intention's request; an emit before #126 step 4 (read on replay, never written).
pub const MESSAGE_PROTOCOL = "metanet handles envelope";
pub const MESSAGE_KEY_ID = "send";
/// The one box a message may name no recipient in (#127: a claim, forwarded; the SDK's message.CLAIM_BOX).
pub const CLAIM_BOX = "claim";

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
    // #143 (format 9): no owner — root holders, keys; an image names none (the claim brings root).
    if (g.get("owner") != null) return false;
    if (g.get("root")) |r| {
        if (r != .array) return false;
        for (r.array) |k| if (!secp.isKey(Value.bytesOf(k) orelse return false)) return false;
    }
    // #143: what gates the genesis's own programs' functions: {<role>: ["<program>.<fn>"]}.
    if (g.get("roles")) |rs| {
        if (rs != .map) return false;
        for (rs.map) |e| {
            if (e.value != .array) return false;
            for (e.value.array) |f| if (Value.str(f) == null) return false;
        }
    }
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
    // An image's installed apps (#141): {<head name>: <record CID>}, each head advanced when the genesis is
    // processed. Not `main` (the tree's), `claim` (the claim's) or `billing` (the kernel's own, #130).
    if (g.get("heads")) |hs| {
        if (!isCidMap(hs)) return false;
        for (hs.map) |e| {
            if (e.key.len == 0 or std.mem.indexOfAny(u8, e.key, " \t\n\r\x0b\x0c\x00") != null) return false;
            for ([_][]const u8{ "main", "claim", "billing", "grants" }) |k| if (std.mem.eql(u8, e.key, k)) return false;
        }
    }
    // #143: no reads table (a read is a route: filters only).
    if (g.get("reads") != null) return false;
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

/// An `authfetch` a step made (#126, the scheduler's hAuthfetch): {kind:
/// "authfetch", thread, step, i, request: bytes, answer?: bytes, error?: text,
/// calls: [{request, result}]}. Recorded at (thread, step, i) as a signer
/// call is, and served by replay from the witness the same way.
pub fn isAuthfetchCall(x: ?Value) bool {
    const a = x orelse return false;
    if (a != .map) return false;
    if (!std.mem.eql(u8, Value.str(a.get("kind")) orelse return false, "authfetch")) return false;
    if (Value.cidOf(a.get("thread")) == null) return false;
    if (!Value.isNumber(a.get("step")) or !Value.isNumber(a.get("i"))) return false;
    if (Value.bytesOf(a.get("request")) == null) return false;
    return Value.bytesOf(a.get("answer")) != null or Value.str(a.get("error")) != null;
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
