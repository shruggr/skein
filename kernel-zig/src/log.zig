// The input log and the record shapes the scheduler checks, in format 12 (skein next, SPEC.md
// sections 2-4: no backward compatibility — a store in format 11 or older is refused, index.zig).
// An instance is a log, a store, a route table with roles, and programs. An arrival earns its log
// entry in one of two ways: its SENDER is proven (a signed request) or its CONTENT is proven (the
// route's checks). The kernel checks it (CHECK), then writes it (COMMIT) — scheduler.zig.
//
//   entry    {kind: "log", prev, n, time, genesis | request: <cid> + door | event: <cid> + name + door}
//            (the cid: the package as the checks handed it back, else as received — door, below)
//            The kernel appends every entry but the genesis (#163): the host hands over the arrival
//            and its stamp (`time`), COMMIT assigns `prev` and `n` from its tip and raises `time` to
//            the tip's when it is behind. The genesis (n = 0, no prev) is the host's (`append`).
//   door     what CHECK established, so a replay never needs the signer or a re-verification:
//            {principal?: bytes(33), scheme?: text, row: <the matched row>, checks: [<names that
//            ran>], blocks?: [<cids the checks stored>], received?: <cid>}. When a check handed the
//            package back rewritten, the entry's `request` (or `event`) names the REWRITTEN record,
//            the only one stored, and `received` is the content hash of the record as received (not
//            stored: a BEEF's raw bytes are not kept beside its blocks); else the entry names the
//            record as received. An arrival CHECK refuses writes nothing.
//   request  {kind: "request", payload: {method, path, query, headers: {name: text}, body: bytes},
//             signature?: {scheme, …}}
//            `path` is what the route table matches. `signature` absent: a content-proven arrival
//            (the row's role is `anyone` and its checks prove it). Schemes (door.zig):
//              brc104  {scheme: "brc104", version: text, identityKey: bytes(33), nonce: text,
//                       yourNonce: text, requestId: text (base64 of 32 bytes), signature: bytes}
//                      — the x-bsv-auth-* headers as the host gathered them; the signed payload is
//                      BRC-104's request serialization of `payload`
//              signed  {scheme: "signed", sender: bytes(33), recipient: bytes(33), nonce: bytes,
//                       signature: bytes} — BRC-169's message signing ([2, "metanet handles
//                       envelope"], key "send", counterparty anyone) over dag-cbor {sender,
//                       recipient, nonce, payload}; `recipient` is this instance
//            A signed request record is admitted once: the `unique` map keys it by its CID as
//            received (index.zig uniqueOf: door.received, else the entry's), so an identical one is
//            refused at CHECK and at COMMIT.
//   event    any map: the host's own fact (the chain pointer {kind: "chain", root, height}, a merkle
//            proof, a deploy BEEF), routed by its `name` to an event row.
//   genesis  {kind: "genesis", identity: bytes(33), handle, domain, routes: [<row>],
//             grants?: {<role>: [bytes(33)]}, calls?, services?, defaults?: {<name>: text},
//             tree?: <git tree>, heads?: {<head name>: <record cid>}}
//            `routes` (dispatch.zig) seed the route table and `grants` the head `grants`
//            (grants.zig), in that order, when the genesis is processed; then `tree` → head `main`,
//            then each of `heads` (an image's installed apps, `<app>/app`). Who builds the image
//            decides what the starting table holds. Gone (refused): owner, root, roles, programs,
//            middleware, scopes, peers, addressBook, names, collect, dispatch, feeds,
//            resolveOrigin, ownerMessagebox (and the older host, attest, jobs, subscriptions, reads).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const secp = @import("secp");
const syscalls = @import("syscalls.zig");
const grants = @import("grants.zig");
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

/// The intentions (#119, #126, #138; skein next: membership only — no fetch, deadline, deliver,
/// want): event names the host wires as declarations of its own — not facts. They are not under the name rule (an app emits them by
/// these names) and not in the event index (index.zig `events`); everything else a program emits
/// as {event: <name>} is a fact, indexed by name.
pub const intentions = [_][]const u8{ "subscribe", "unsubscribe", "beacon", "unbeacon", "liveness", "unliveness" };

pub fn isIntention(name: []const u8) bool {
    for (intentions) |x| if (std.mem.eql(u8, x, name)) return true;
    return false;
}

/// Whether `name` is an event name (0.5.0): a slash path of segments — not empty, no empty segment
/// (no leading, trailing or doubled `/`), no space and no NUL.
pub fn isEventName(name: []const u8) bool {
    if (!dispatch.isBox(name)) return false;
    var it = std.mem.splitScalar(u8, name, '/');
    while (it.next()) |seg| if (seg.len == 0) return false;
    return true;
}

/// Whether `name` is under `app`: its first segment is the app's name (0.5.0's rule: an app emits
/// under its own name, as it writes heads under its own name).
pub fn underApp(name: []const u8, app: []const u8) bool {
    const end = std.mem.indexOfScalar(u8, name, '/') orelse name.len;
    return std.mem.eql(u8, name[0..end], app);
}

/// The name an indexed event record goes under (index.zig `events`), or null: a record {kind:
/// "event", event: <name>, app: <app>} whose name is no intention and lies under its app.
pub fn indexedName(m: Value) ?[]const u8 {
    if (!isEvent(m)) return null;
    const name = Value.str(m.get("event")).?;
    if (isIntention(name)) return null;
    const app = Value.str(m.get("app")) orelse return null;
    if (!isEventName(name) or !underApp(name, app)) return null;
    return name;
}

test "event names (0.5.0): segments, the app's own first segment, intentions apart" {
    try std.testing.expect(isEventName("amm/pool/abc"));
    try std.testing.expect(isEventName("amm"));
    try std.testing.expect(!isEventName(""));
    try std.testing.expect(!isEventName("/amm"));
    try std.testing.expect(!isEventName("amm/"));
    try std.testing.expect(!isEventName("amm//x"));
    try std.testing.expect(!isEventName("amm/a b"));
    try std.testing.expect(underApp("amm/pool/x", "amm"));
    try std.testing.expect(underApp("amm", "amm"));
    try std.testing.expect(!underApp("ammx/pool", "amm"));
    try std.testing.expect(!underApp("pool", "amm"));
    try std.testing.expect(isIntention("subscribe") and !isIntention("fetch") and !isIntention("deadline") and !isIntention("amm/subscribe"));
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

/// The one entry encoding (format 12): {kind: "log", prev, n, time} and exactly one of genesis |
/// request (+ door) | event (+ name, door). No signature on any of them.
pub fn isLogEntry(e: Value) bool {
    if (e != .map) return false;
    if (!std.mem.eql(u8, Value.str(e.get("kind")) orelse "", "log")) return false;
    if (!Value.isNumber(e.get("n"))) return false;
    var count: usize = 0;
    for ([_][]const u8{ "genesis", "event", "request" }) |k| {
        if (e.get(k) != null) count += 1;
    }
    if (count != 1) return false;
    for (e.map) |x| {
        const known = for ([_][]const u8{ "kind", "prev", "n", "time", "genesis", "event", "request", "name", "door" }) |k| {
            if (std.mem.eql(u8, x.key, k)) break true;
        } else false;
        if (!known) return false;
    }
    if (e.get("genesis")) |g| {
        if (g != .cid) return false;
        return e.get("name") == null and e.get("door") == null;
    }
    const d = e.get("door") orelse return false;
    if (d != .map) return false;
    if (e.get("request")) |r| {
        if (r != .cid) return false;
        return e.get("name") == null;
    }
    if (e.get("event").? != .cid) return false;
    const name = Value.str(e.get("name")) orelse return false;
    return dispatch.isBox(name);
}

/// A request record (SPEC 2): {kind: "request", payload: {method, path, query, headers: {name:
/// text}, body: bytes}, signature?: {scheme: text, …}}. Its form only; who it is from is door.zig's.
pub fn isRequest(x: ?Value) bool {
    const r = x orelse return false;
    if (r != .map) return false;
    if (!std.mem.eql(u8, Value.str(r.get("kind")) orelse "", "request")) return false;
    for (r.map) |e| if (!std.mem.eql(u8, e.key, "kind") and !std.mem.eql(u8, e.key, "payload") and !std.mem.eql(u8, e.key, "signature")) return false;
    const p = r.get("payload") orelse return false;
    if (p != .map) return false;
    for ([_][]const u8{ "method", "path", "query" }) |k| if (Value.str(p.get(k)) == null) return false;
    if ((Value.str(p.get("method")).?).len == 0) return false;
    const h = p.get("headers") orelse return false;
    if (h != .map) return false;
    for (h.map) |e| if (e.value != .string) return false;
    if (Value.bytesOf(p.get("body")) == null) return false;
    if (r.get("signature")) |s| {
        if (s != .map) return false;
        if (Value.str(s.get("scheme")) == null) return false;
    }
    return true;
}

/// Whether a request record carries a signature (an arrival of kind (a), SPEC 1).
pub fn isSigned(r: Value) bool {
    return r.get("signature") != null;
}

/// The BRC-43 protocol and key the `signed` scheme signs under (BRC-169 §7.2's message signing).
pub const MESSAGE_PROTOCOL = "metanet handles envelope";
pub const MESSAGE_KEY_ID = "send";

fn isCidMap(v: ?Value) bool {
    const m = v orelse return false;
    if (m != .map) return false;
    for (m.map) |e| if (e.value != .cid) return false;
    return true;
}

/// The genesis fields gone in format 12 (and before): a genesis naming one is refused.
const gone_fields = [_][]const u8{ "owner", "root", "roles", "programs", "middleware", "scopes", "peers", "addressBook", "names", "collect", "dispatch", "feeds", "resolveOrigin", "ownerMessagebox", "host", "attest", "jobs", "subscriptions", "reads" };

/// The genesis record (format 12).
pub fn isGenesis(x: ?Value) bool {
    const g = x orelse return false;
    if (g != .map) return false;
    if (!std.mem.eql(u8, Value.str(g.get("kind")) orelse return false, "genesis")) return false;
    if (!secp.isKey(Value.bytesOf(g.get("identity")) orelse return false)) return false;
    for (gone_fields) |k| if (g.get(k) != null) return false;
    if (Value.str(g.get("handle")) == null or Value.str(g.get("domain")) == null) return false;
    const rows = g.get("routes") orelse return false;
    if (rows != .array) return false;
    var scratch: [4096]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&scratch);
    for (rows.array) |r| {
        fba.reset();
        const bad = dispatch.problem(fba.allocator(), r) catch return false;
        if (bad != null) return false;
    }
    // The starting grants: {<role>: [key …]}, each role grantable (root, <app>.<role>).
    if (g.get("grants")) |gs| {
        if (gs != .map) return false;
        for (gs.map) |e| {
            if (!grants.isGrantable(e.key) or e.value != .array) return false;
            for (e.value.array) |k| if (!secp.isKey(Value.bytesOf(k) orelse return false)) return false;
        }
    }
    // Call permissions (grants.zig): {<caller>: {<callee>: [<name> …] | "*"}} and {<caller>: [<service> …]},
    // written into the grants head when the genesis is processed.
    if (g.get("calls")) |cs| {
        if (cs != .map) return false;
        for (cs.map) |byc| {
            if (!grants.isParty(byc.key) or byc.value != .map) return false;
            for (byc.value.map) |byt| {
                if (!grants.isParty(byt.key)) return false;
                if (Value.str(byt.value)) |any| {
                    if (!std.mem.eql(u8, any, grants.ANY)) return false;
                } else if (byt.value == .array) {
                    for (byt.value.array) |nm| if (!grants.isCallName(Value.str(nm) orelse return false)) return false;
                } else return false;
            }
        }
    }
    if (g.get("services")) |sv| {
        if (sv != .map) return false;
        for (sv.map) |e| {
            if (!grants.isParty(e.key) or e.value != .array) return false;
            for (e.value.array) |svc| if (!grants.isService(Value.str(svc) orelse return false)) return false;
        }
    }
    if (g.get("defaults")) |d| {
        if (d != .map) return false;
        for (d.map) |e| if (e.value != .string) return false;
    }
    if (g.get("tree")) |t| if (Value.cidOf(t) == null or cidm.codecOf(Value.cidOf(t).?) != cidm.GIT_RAW) return false;
    // An image's installed apps (#141): {<head name>: <record CID>}, each head advanced when the genesis is
    // processed. Not `main` (the tree's), `claim` (the claim's) or `grants` (the kernel's own).
    if (g.get("heads")) |hs| {
        if (!isCidMap(hs)) return false;
        for (hs.map) |e| {
            if (e.key.len == 0 or std.mem.indexOfAny(u8, e.key, " \t\n\r\x0b\x0c\x00") != null) return false;
            for ([_][]const u8{ "main", "claim", "grants" }) |k| if (std.mem.eql(u8, e.key, k)) return false;
        }
    }
    return true;
}

/// A signer call a step made (#67: the one recorded call): {kind:
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
