//! BRC-103/104 sessions inside the instance (issue #33, "sessions belong to
//! the instance"): the router forwards each authentication message it gets
//! for this instance's identity as a plain `event` entry in the reserved box
//! `:auth` (a sender-less subscription routes it here), and reads the answer
//! back from the head `auth`. Every signature and nonce is the instance's own,
//! made through the `wallet` import (the oracle; recorded calls), and the
//! session state is records in the instance — so the proof of every session
//! message is in the log.
//!
//! The event records (`args.event` names one):
//!
//!   {kind: "auth", op: "handshake", message: bytes}
//!       a BRC-103 initialRequest, the JSON as it came over HTTP
//!   {kind: "auth", op: "request", identityKey: bytes(33), nonce, yourNonce, signature: bytes, payload: bytes}
//!       a BRC-104 general message (the request's signed payload as the transport frames it)
//!   {kind: "auth", op: "respond", yourNonce, payload: bytes}
//!       sign the response to a request on the session `yourNonce` names
//!   {kind: "auth", op: "seal", emit: cid, id: cid}
//!       the instance's emit (`id`: its envelope's CID, what a reply names),
//!       compact on a session with its recipient that negotiated it
//!       (`x-bsv-skein-compact` on a signed request), if there is one:
//!       {type: "reply" | "message", replyTo?, id, body} signed on the session
//!       (the payload is its dag-cbor), kept as that map plus
//!       session: {payload, signature, nonce, yourNonce}
//!
//! State: the head `sessions` names {kind: "sessions", sessions: [{nonce, session: cid}]}
//! (sorted by nonce), each {kind: "session", peer: bytes(33), sessionNonce,
//! peerNonce, created, lastSeen, authenticated, compact, seen: [nonce]}.
//! Expiry is the genesis's `defaults.sessionTtlMs`, judged by entry stamps:
//! a session whose lastSeen is older than that at this entry's stamp is gone.
//! The answer: the head `auth` names {kind: "auth-answer", event, ok, error?, …}.
const std = @import("std");
const cbor = @import("cbor");
const main = @import("main.zig");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;

pub const AUTH_PROTOCOL = "auth message signature";
pub const NONCE_PROTOCOL = "server hmac";
pub const COMPACT_HEADER = "x-bsv-skein-compact";
const DEFAULT_TTL_MS: i128 = 24 * 60 * 60 * 1000;
/// How many message nonces a session remembers for replay protection (the oldest go first).
const SEEN_CAP = 4096;

const b64 = std.base64.standard;

// ---------------------------------------------------------------- BRC-100 wire frames (the oracle)

const Counterparty = union(enum) { self, other: []const u8 };

fn varint(a: Allocator, out: *std.ArrayList(u8), v: u64) !void {
    if (v < 0xfd) {
        try out.append(a, @intCast(v));
    } else if (v <= 0xffff) {
        try out.append(a, 0xfd);
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, @intCast(v), .little);
        try out.appendSlice(a, &b);
    } else if (v <= 0xffff_ffff) {
        try out.append(a, 0xfe);
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @intCast(v), .little);
        try out.appendSlice(a, &b);
    } else {
        try out.append(a, 0xff);
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, v, .little);
        try out.appendSlice(a, &b);
    }
}

fn keyParams(a: Allocator, out: *std.ArrayList(u8), call: u8, protocol: []const u8, key_id: []const u8, cp: Counterparty) !void {
    try out.appendSlice(a, &.{ call, 0 }); // the call, an empty originator
    try out.append(a, 2); // security level 2
    try varint(a, out, protocol.len);
    try out.appendSlice(a, protocol);
    try varint(a, out, key_id.len);
    try out.appendSlice(a, key_id);
    switch (cp) {
        .self => try out.append(a, 11),
        .other => |k| try out.appendSlice(a, k),
    }
    try out.append(a, 0); // privileged: false
    try out.append(a, 0xff); // privilegedReason: none
}

fn oracle(a: Allocator, frame: []const u8) ![]const u8 {
    return main.result(a, main.sk.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
}

/// The payload of a successful result frame, or null for a wallet error.
fn ok(frame: []const u8) ?[]const u8 {
    if (frame.len == 0 or frame[0] != 0) return null;
    return frame[1..];
}

fn identityKey(a: Allocator) ![]const u8 {
    const res = try oracle(a, &.{ 8, 0, 1, 0, 0xff, 0 });
    const p = ok(res) orelse return error.OracleIdentity;
    if (p.len != 33) return error.OracleIdentity;
    return p;
}

fn createHmac(a: Allocator, key_id: []const u8, data: []const u8) ![]const u8 {
    var f: std.ArrayList(u8) = .empty;
    try keyParams(a, &f, 13, NONCE_PROTOCOL, key_id, .self);
    try varint(a, &f, data.len);
    try f.appendSlice(a, data);
    try f.append(a, 0); // seekPermission: false
    const p = ok(try oracle(a, f.items)) orelse return error.OracleHmac;
    if (p.len != 32) return error.OracleHmac;
    return p;
}

fn verifyHmac(a: Allocator, key_id: []const u8, data: []const u8, hmac: []const u8) !bool {
    var f: std.ArrayList(u8) = .empty;
    try keyParams(a, &f, 14, NONCE_PROTOCOL, key_id, .self);
    try f.appendSlice(a, hmac);
    try varint(a, &f, data.len);
    try f.appendSlice(a, data);
    try f.append(a, 0);
    return ok(try oracle(a, f.items)) != null;
}

fn createSignature(a: Allocator, key_id: []const u8, peer: []const u8, data: []const u8) ![]const u8 {
    var f: std.ArrayList(u8) = .empty;
    try keyParams(a, &f, 15, AUTH_PROTOCOL, key_id, .{ .other = peer });
    try f.append(a, 1); // data follows
    try varint(a, &f, data.len);
    try f.appendSlice(a, data);
    try f.append(a, 0);
    const p = ok(try oracle(a, f.items)) orelse return error.OracleSignature;
    if (p.len < 8 or p[0] != 0x30) return error.OracleSignature;
    return p;
}

fn verifySignature(a: Allocator, key_id: []const u8, peer: []const u8, data: []const u8, sig: []const u8) !bool {
    var f: std.ArrayList(u8) = .empty;
    try keyParams(a, &f, 16, AUTH_PROTOCOL, key_id, .{ .other = peer });
    try f.append(a, 0xff); // forSelf: none
    try varint(a, &f, sig.len);
    try f.appendSlice(a, sig);
    try f.append(a, 1);
    try varint(a, &f, data.len);
    try f.appendSlice(a, data);
    try f.append(a, 0);
    return ok(try oracle(a, f.items)) != null;
}

// ---------------------------------------------------------------- nonces (BRC-104: createNonce / verifyNonce)

/// 16 random bytes (printable ASCII, so the SDK's keyID — the bytes read as
/// UTF-8 — is the same string on every side) and their HMAC under
/// [2, "server hmac"], counterparty self: base64 of the 48 bytes. The SDK's
/// verifyNonce accepts it against this instance's key.
fn createNonce(a: Allocator) ![]const u8 {
    var first: [16]u8 = undefined;
    std.posix.getrandom(&first) catch return error.Random;
    for (&first) |*b| b.* = 33 + b.* % 94;
    const mac = try createHmac(a, &first, &first);
    var raw: [48]u8 = undefined;
    @memcpy(raw[0..16], &first);
    @memcpy(raw[16..], mac);
    const out = try a.alloc(u8, b64.Encoder.calcSize(48));
    return b64.Encoder.encode(out, &raw);
}

fn verifyNonce(a: Allocator, nonce: []const u8) !bool {
    const raw = decode64(a, nonce) orelse return false;
    if (raw.len != 48) return false;
    for (raw[0..16]) |b| if (b < 33 or b > 126) return false; // not one of ours
    return verifyHmac(a, raw[0..16], raw[0..16], raw[16..]);
}

fn decode64(a: Allocator, s: []const u8) ?[]u8 {
    const n = b64.Decoder.calcSizeForSlice(s) catch return null;
    const out = a.alloc(u8, n) catch return null;
    b64.Decoder.decode(out, s) catch return null;
    return out;
}

fn random64(a: Allocator) ![]const u8 {
    var raw: [32]u8 = undefined;
    std.posix.getrandom(&raw) catch return error.Random;
    const out = try a.alloc(u8, b64.Encoder.calcSize(32));
    return b64.Encoder.encode(out, &raw);
}

// ---------------------------------------------------------------- sessions

const Session = struct {
    peer: []const u8,
    session_nonce: []const u8,
    peer_nonce: []const u8,
    created: i128,
    last_seen: i128,
    authenticated: bool,
    compact: bool,
    seen: std.ArrayList(Value),
    changed: bool = false,
    /// The record as stored (unchanged sessions keep it).
    cid: ?[]const u8 = null,

    fn load(a: Allocator, c: []const u8) !Session {
        const v = try main.getValue(a, c);
        var seen: std.ArrayList(Value) = .empty;
        if (v.get("seen")) |s| if (s == .array) try seen.appendSlice(a, s.array);
        return .{
            .peer = Value.bytesOf(v.get("peer")) orelse return error.BadSession,
            .session_nonce = Value.str(v.get("sessionNonce")) orelse return error.BadSession,
            .peer_nonce = Value.str(v.get("peerNonce")) orelse return error.BadSession,
            .created = Value.intOf(v.get("created")) orelse 0,
            .last_seen = Value.intOf(v.get("lastSeen")) orelse 0,
            .authenticated = if (v.get("authenticated")) |b| b == .bool and b.bool else false,
            .compact = if (v.get("compact")) |b| b == .bool and b.bool else false,
            .seen = seen,
            .cid = c,
        };
    }

    fn save(s: *Session, a: Allocator) ![]const u8 {
        if (!s.changed) if (s.cid) |c| return c;
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("session"));
        try m.put("peer", .{ .bytes = s.peer });
        try m.put("sessionNonce", cbor.string(s.session_nonce));
        try m.put("peerNonce", cbor.string(s.peer_nonce));
        try m.put("created", cbor.int(s.created));
        try m.put("lastSeen", cbor.int(s.last_seen));
        try m.put("authenticated", .{ .bool = s.authenticated });
        try m.put("compact", .{ .bool = s.compact });
        try m.put("seen", .{ .array = s.seen.items });
        return main.putValue(a, m.value());
    }
};

const State = struct {
    list: std.ArrayList(Session) = .empty,
    changed: bool = false,

    fn find(st: *State, nonce: []const u8) ?*Session {
        for (st.list.items) |*s| if (std.mem.eql(u8, s.session_nonce, nonce)) return s;
        return null;
    }
};

fn loadState(a: Allocator, at: i128, ttl: i128) !State {
    var st = State{};
    const root = try main.result(a, main.sk.head, .{ sessions_head.ptr, @as(u32, sessions_head.len) });
    if (root.len == 0) return st;
    const r = try main.getValue(a, root);
    if (r.get("sessions")) |ss| if (ss == .array) for (ss.array) |x| {
        const c = Value.cidOf(x.get("session")) orelse continue;
        const s = try Session.load(a, c);
        if (s.last_seen + ttl < at) {
            st.changed = true; // expired: dropped
            continue;
        }
        try st.list.append(a, s);
    };
    return st;
}

fn saveState(a: Allocator, st: *State) !void {
    var any = st.changed;
    for (st.list.items) |s| any = any or s.changed;
    if (!any) return;
    std.mem.sort(Session, st.list.items, {}, struct {
        fn lt(_: void, x: Session, y: Session) bool {
            return std.mem.order(u8, x.session_nonce, y.session_nonce) == .lt;
        }
    }.lt);
    const arr = try a.alloc(Value, st.list.items.len);
    for (st.list.items, 0..) |*s, i| {
        var e = cbor.MapBuilder.init(a);
        try e.put("nonce", cbor.string(s.session_nonce));
        try e.put("session", cbor.cidv(try s.save(a)));
        arr[i] = e.value();
    }
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("sessions"));
    try root.put("sessions", .{ .array = arr });
    const rc = try main.putValue(a, root.value());
    if (main.sk.advance(sessions_head.ptr, sessions_head.len, rc.ptr, @intCast(rc.len)) < 0) return main.failed();
}

const sessions_head = "sessions";
const answer_head = "auth";

fn isKey(k: []const u8) bool {
    return k.len == 33 and (k[0] == 2 or k[0] == 3);
}

fn ttlOf(step: Value) i128 {
    const d = step.get("defaults") orelse return DEFAULT_TTL_MS;
    const t = Value.str(d.get("sessionTtlMs")) orelse return DEFAULT_TTL_MS;
    return std.fmt.parseInt(i128, t, 10) catch DEFAULT_TTL_MS;
}

// ---------------------------------------------------------------- the step

const Answer = struct {
    m: cbor.MapBuilder,
    fn fail(self: *Answer, why: []const u8) !void {
        try self.m.put("ok", .{ .bool = false });
        try self.m.put("error", cbor.string(why));
    }
};

pub fn run(a: Allocator, step: Value, args: Value) !void {
    const ev_cid = Value.cidOf(args.get("event")) orelse return error.BadEvent;
    const ev = try main.getValue(a, ev_cid);
    const op = Value.str(ev.get("op")) orelse return error.BadOp;
    const at = Value.intOf(step.get("at")) orelse 0;
    var st = try loadState(a, at, ttlOf(step));

    var ans = Answer{ .m = cbor.MapBuilder.init(a) };
    try ans.m.put("kind", cbor.string("auth-answer"));
    try ans.m.put("event", cbor.cidv(ev_cid));
    try ans.m.put("op", cbor.string(op));
    if (std.mem.eql(u8, op, "handshake")) {
        try handshake(a, &st, ev, at, &ans);
    } else if (std.mem.eql(u8, op, "request")) {
        try request(a, &st, ev, at, &ans);
    } else if (std.mem.eql(u8, op, "respond")) {
        try respond(a, &st, ev, at, &ans);
    } else if (std.mem.eql(u8, op, "seal")) {
        try seal(a, &st, ev, at, &ans);
    } else try ans.fail("unknown op");

    try saveState(a, &st);
    const ac = try main.putValue(a, ans.m.value());
    if (main.sk.advance(answer_head.ptr, answer_head.len, ac.ptr, @intCast(ac.len)) < 0) return main.failed();
}

/// BRC-103 initialRequest → initialResponse: a new session, our nonce, our signature over both nonces.
fn handshake(a: Allocator, st: *State, ev: Value, at: i128, ans: *Answer) !void {
    const raw = Value.bytesOf(ev.get("message")) orelse return ans.fail("no message");
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch return ans.fail("the handshake message is not JSON");
    if (parsed != .object) return ans.fail("the handshake message is not an object");
    const o = parsed.object;
    const mt = o.get("messageType") orelse return ans.fail("no messageType");
    if (mt != .string or !std.mem.eql(u8, mt.string, "initialRequest")) return ans.fail("only initialRequest is answered (no certificates are requested or held)");
    const ik = o.get("identityKey") orelse return ans.fail("no identityKey");
    if (ik != .string or ik.string.len != 66) return ans.fail("bad identityKey");
    var peer_buf: [33]u8 = undefined;
    const peer = std.fmt.hexToBytes(&peer_buf, ik.string) catch return ans.fail("bad identityKey");
    if (!isKey(peer)) return ans.fail("bad identityKey");
    const inj = o.get("initialNonce") orelse return ans.fail("no initialNonce");
    if (inj != .string or inj.string.len == 0 or inj.string.len > 256) return ans.fail("bad initialNonce");
    const their = inj.string;
    const their_raw = decode64(a, their) orelse return ans.fail("initialNonce is not base64");
    for (st.list.items) |s| if (std.mem.eql(u8, s.peer, peer) and std.mem.eql(u8, s.peer_nonce, their)) return ans.fail("Replayed initialRequest nonce.");

    const ours = try createNonce(a);
    const ours_raw = decode64(a, ours).?;
    const data = try std.mem.concat(a, u8, &.{ their_raw, ours_raw });
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ their, ours });
    const peer_owned = try a.dupe(u8, peer);
    const sig = try createSignature(a, key_id, peer_owned, data);
    try st.list.append(a, .{
        .peer = peer_owned,
        .session_nonce = ours,
        .peer_nonce = try a.dupe(u8, their),
        .created = at,
        .last_seen = at,
        .authenticated = false,
        .compact = false,
        .seen = .empty,
        .changed = true,
    });
    try ans.m.put("ok", .{ .bool = true });
    try ans.m.put("identityKey", .{ .bytes = try identityKey(a) });
    try ans.m.put("peer", .{ .bytes = peer_owned });
    try ans.m.put("initialNonce", cbor.string(ours));
    try ans.m.put("yourNonce", cbor.string(their));
    try ans.m.put("signature", .{ .bytes = sig });
}

/// A BRC-104 general message: our nonce, the session, the peer, its signature, a nonce not seen before on it.
fn request(a: Allocator, st: *State, ev: Value, at: i128, ans: *Answer) !void {
    const peer = Value.bytesOf(ev.get("identityKey")) orelse return ans.fail("no identityKey");
    const nonce = Value.str(ev.get("nonce")) orelse return ans.fail("no nonce");
    const your = Value.str(ev.get("yourNonce")) orelse return ans.fail("no yourNonce");
    const sig = Value.bytesOf(ev.get("signature")) orelse return ans.fail("no signature");
    const payload = Value.bytesOf(ev.get("payload")) orelse return ans.fail("no payload");
    if (nonce.len == 0) return ans.fail("General message nonce is required.");
    if (!try verifyNonce(a, your)) return ans.fail("Unable to verify nonce for general message");
    const s = st.find(your) orelse return ans.fail("Session not found for nonce (expired or unknown)");
    if (!std.mem.eql(u8, s.peer, peer)) return ans.fail("general identity does not match the authenticated session.");
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.session_nonce });
    if (!try verifySignature(a, key_id, s.peer, payload, sig)) return ans.fail("Invalid signature in generalMessage");
    for (s.seen.items) |x| if (std.mem.eql(u8, Value.str(x) orelse "", nonce)) return ans.fail("Replayed general message nonce.");
    if (s.seen.items.len >= SEEN_CAP) _ = s.seen.orderedRemove(0);
    try s.seen.append(a, cbor.string(nonce));
    s.authenticated = true;
    s.last_seen = at;
    if (hasHeader(payload, COMPACT_HEADER)) s.compact = true;
    s.changed = true;
    try ans.m.put("ok", .{ .bool = true });
    try ans.m.put("peer", .{ .bytes = s.peer });
    try ans.m.put("session", cbor.string(s.session_nonce));
    try ans.m.put("compact", .{ .bool = s.compact });
}

/// Sign the response to a request on the session: a fresh nonce, the peer's session nonce.
fn respond(a: Allocator, st: *State, ev: Value, at: i128, ans: *Answer) !void {
    const your = Value.str(ev.get("yourNonce")) orelse return ans.fail("no yourNonce");
    const payload = Value.bytesOf(ev.get("payload")) orelse return ans.fail("no payload");
    const s = st.find(your) orelse return ans.fail("Session not found for nonce (expired or unknown)");
    const nonce = try random64(a);
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.peer_nonce });
    const sig = try createSignature(a, key_id, s.peer, payload);
    s.last_seen = at;
    s.changed = true;
    try ans.m.put("ok", .{ .bool = true });
    try ans.m.put("identityKey", .{ .bytes = try identityKey(a) });
    try ans.m.put("nonce", cbor.string(nonce));
    try ans.m.put("yourNonce", cbor.string(s.peer_nonce));
    try ans.m.put("signature", .{ .bytes = sig });
}

/// An emit, compact on the newest authenticated session with its recipient that negotiated it.
fn seal(a: Allocator, st: *State, ev: Value, at: i128, ans: *Answer) !void {
    const emit_cid = Value.cidOf(ev.get("emit")) orelse return ans.fail("no emit");
    const emit = try main.getValue(a, emit_cid);
    const to = Value.bytesOf(emit.get("to")) orelse return ans.fail("not an emit");
    const body_cid = Value.cidOf(emit.get("body")) orelse return ans.fail("not an emit");
    var best: ?*Session = null;
    for (st.list.items) |*s| {
        if (!s.compact or !s.authenticated or !std.mem.eql(u8, s.peer, to)) continue;
        if (best == null or s.last_seen > best.?.last_seen) best = s;
    }
    const s = best orelse return ans.fail("no session with the recipient that takes compact messages");
    const body = try main.result(a, main.sk.get, .{ body_cid.ptr, @as(u32, @intCast(body_cid.len)) });
    var reply_to: ?[]const u8 = null;
    if (cbor.decode(a, body)) |bv| {
        reply_to = Value.cidOf(bv.get("replyTo"));
    } else |_| {}
    var m = cbor.MapBuilder.init(a);
    try m.put("type", cbor.string(if (reply_to != null) "reply" else "message"));
    try m.put("replyTo", cbor.optCid(reply_to));
    // What a reply to it names (the emitted envelope's id, which the emitting thread awaits).
    try m.put("id", cbor.optCid(Value.cidOf(ev.get("id"))));
    try m.put("body", .{ .bytes = body });
    const payload = try cbor.encode(a, m.value());
    const nonce = try random64(a);
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.peer_nonce });
    const sig = try createSignature(a, key_id, s.peer, payload);
    s.last_seen = at;
    s.changed = true;
    var sess = cbor.MapBuilder.init(a);
    try sess.put("payload", .{ .bytes = payload });
    try sess.put("signature", .{ .bytes = sig });
    try sess.put("nonce", cbor.string(nonce));
    try sess.put("yourNonce", cbor.string(s.peer_nonce));
    try m.put("session", sess.value());
    try ans.m.put("ok", .{ .bool = true });
    try ans.m.put("compact", m.value());
}

// ---------------------------------------------------------------- the request payload (BRC-104 over HTTP)

const Reader = struct {
    b: []const u8,
    i: usize = 0,
    fn take(r: *Reader, n: usize) ?[]const u8 {
        if (n > r.b.len - r.i) return null;
        defer r.i += n;
        return r.b[r.i..][0..n];
    }
    fn varint(r: *Reader) ?u64 {
        const f = (r.take(1) orelse return null)[0];
        return switch (f) {
            0xfd => std.mem.readInt(u16, (r.take(2) orelse return null)[0..2], .little),
            0xfe => std.mem.readInt(u32, (r.take(4) orelse return null)[0..4], .little),
            0xff => std.mem.readInt(u64, (r.take(8) orelse return null)[0..8], .little),
            else => f,
        };
    }
    /// A length-prefixed field; the SDK writes an absent one as -1 (all ones).
    fn field(r: *Reader) ?[]const u8 {
        const n = r.varint() orelse return null;
        if (n == std.math.maxInt(u64)) return "";
        return r.take(@intCast(n));
    }
};

/// Whether the signed request carries header `name` (requestId, method, path, query, headers…).
pub fn hasHeader(payload: []const u8, name: []const u8) bool {
    var r = Reader{ .b = payload };
    _ = r.take(32) orelse return false;
    _ = r.field() orelse return false; // method
    _ = r.field() orelse return false; // path
    _ = r.field() orelse return false; // query
    const n = r.varint() orelse return false;
    var i: u64 = 0;
    while (i < n) : (i += 1) {
        const k = r.field() orelse return false;
        const v = r.field() orelse return false;
        if (std.ascii.eqlIgnoreCase(k, name) and v.len > 0 and !std.mem.eql(u8, v, "0")) return true;
    }
    return false;
}
