//! Delivery over http (#40): the messagebox program sends a message itself,
//! as a BRC-103/104 client of the recipient's messagebox — the peer table
//! gives the URL (the head `peers`: records the instance's own programs wrote:
//! a resolve, the admin, a claim; or the owner's from the genesis,
//! `defaults.ownerMessagebox`), a session per peer is kept as a small record
//! (head `outbound`), and the BRC-33 `sendMessage` is a recorded `http` call:
//! request and response on the step's update, so replay never touches the
//! network. Called from a step (the loop's `message` tool, its infer and its
//! answer: an in-VM call), so everything here is part of that step.
//!
//!   send {to: <key>, box, body: <dag-cbor bytes>, handle?, domain?}
//!     → {id: <cid>}: the id of the message — the record the recipient keeps,
//!       {kind: "mail", op: "put", sender, recipient, box, body, session},
//!       put here too, so a reply's `replyTo` names a record this instance
//!       holds (and `await`s)
//!   a failure is the call's error: "transient: …" (no answer, 5xx, 408, 425,
//!   429: the caller may try again later) or a permanent refusal.
const std = @import("std");
const cbor = @import("cbor");
const cid = cbor.cidm;
const sk = @import("sk");
const brc = @import("brc104");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const PEERS = "peers";
const OUTBOUND = "outbound";

pub const Peer = struct { key: []const u8, url: []const u8 };

/// The peer record for `key`: the table's, else the owner's from the genesis; null if unknown.
pub fn peerOf(a: Allocator, in: Value, key: []const u8) !?Peer {
    if (try sk.head(a, PEERS)) |root| {
        const r = try sk.get(a, root);
        if (r.get("peers")) |ps| if (ps == .array) for (ps.array) |x| {
            if (!eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) continue;
            const p = try sk.get(a, Value.cidOf(x.get("peer")) orelse continue);
            return .{ .key = key, .url = Value.str(p.get("url")) orelse continue };
        };
    }
    if (eql(u8, key, Value.bytesOf(in.get("owner")) orelse "")) {
        const d = in.get("defaults") orelse return null;
        if (Value.str(d.get("ownerMessagebox"))) |u| if (u.len > 0) return .{ .key = key, .url = u };
    }
    return null;
}

/// A session with a messagebox: our nonce, its nonce, and its identity — the
/// recipient's own for an agent, the mailbox instance's for a mailbox kept for
/// someone (the URL names whose messagebox it is; the session proves who answers).
const Session = struct { ours: []const u8, theirs: []const u8, server: []const u8 };

fn outboundOf(a: Allocator, key: []const u8, url: []const u8) !?Session {
    const root = (try sk.head(a, OUTBOUND)) orelse return null;
    const r = try sk.get(a, root);
    if (r.get("sessions")) |ss| if (ss == .array) for (ss.array) |x| {
        if (!eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) continue;
        const s = try sk.get(a, Value.cidOf(x.get("session")) orelse continue);
        if (!eql(u8, Value.str(s.get("url")) orelse "", url)) return null;
        return .{ .ours = Value.str(s.get("ours")) orelse return null, .theirs = Value.str(s.get("theirs")) orelse return null, .server = Value.bytesOf(s.get("server")) orelse return null };
    };
    return null;
}

/// Keep (or drop, with null) the session with `key`: one small record per peer.
fn saveOutbound(a: Allocator, key: []const u8, s: ?Value) !void {
    var list: std.ArrayList(Value) = .empty;
    if (try sk.head(a, OUTBOUND)) |root| {
        const r = try sk.get(a, root);
        if (r.get("sessions")) |ss| if (ss == .array) for (ss.array) |x| {
            if (!eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) try list.append(a, x);
        };
    }
    if (s) |rec| {
        var e = cbor.MapBuilder.init(a);
        try e.put("key", .{ .bytes = key });
        try e.put("session", cbor.cidv(try sk.put(a, rec)));
        try list.append(a, e.value());
    }
    std.mem.sort(Value, list.items, {}, struct {
        fn lt(_: void, x: Value, y: Value) bool {
            return std.mem.order(u8, Value.bytesOf(x.get("key")) orelse "", Value.bytesOf(y.get("key")) orelse "") == .lt;
        }
    }.lt);
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("outbound"));
    try root.put("sessions", .{ .array = list.items });
    try sk.advance(OUTBOUND, try sk.put(a, root.value()));
}

/// The path part of a URL ("" for none): what a request to it signs, with the endpoint after it.
fn pathOf(url: []const u8) []const u8 {
    const scheme = std.mem.indexOf(u8, url, "://") orelse return "";
    const rest = url[scheme + 3 ..];
    const slash = std.mem.indexOfScalar(u8, rest, '/') orelse return "";
    return rest[slash..];
}

fn trimSlash(s: []const u8) []const u8 {
    return std.mem.trimRight(u8, s, "/");
}

fn transient(status: i128) bool {
    return status >= 500 or status == 408 or status == 425 or status == 429;
}

fn httpCall(a: Allocator, method: []const u8, url: []const u8, headers: []const brc.Header, body: []const u8) !Value {
    var h = cbor.MapBuilder.init(a);
    for (headers) |x| try h.put(x.name, cbor.string(x.value));
    var req = cbor.MapBuilder.init(a);
    try req.put("method", cbor.string(method));
    try req.put("url", cbor.string(url));
    try req.put("headers", h.value());
    if (body.len > 0) try req.put("body", .{ .bytes = body });
    return sk.http(a, req.value()) catch |err| {
        if (err == error.ImportFailed) return sk.report(try std.fmt.allocPrint(a, "transient: {s}: {s}", .{ url, sk.lastError() }));
        return err;
    };
}

fn describe(a: Allocator, r: Value) []const u8 {
    const b = Value.bytesOf(r.get("body")) orelse return "";
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, b, .{}) catch return b[0..@min(b.len, 200)];
    if (j == .object) if (j.object.get("description")) |d| if (d == .string) return d.string;
    return b[0..@min(b.len, 200)];
}

/// BRC-103: our nonce, their answer, their signature over both nonces checked.
fn handshake(a: Allocator, me: []const u8, peer: Peer, at: i128) !Session {
    const ours = try brc.createNonce(a);
    const url = try std.fmt.allocPrint(a, "{s}{s}", .{ trimSlash(peer.url), brc.WELL_KNOWN });
    const body = try std.fmt.allocPrint(a, "{{\"version\":\"{s}\",\"messageType\":\"initialRequest\",\"identityKey\":\"{s}\",\"initialNonce\":\"{s}\",\"requestedCertificates\":{{\"certifiers\":[],\"types\":{{}}}}}}", .{ brc.VERSION, try sk.hex(a, me), ours });
    const r = try httpCall(a, "POST", url, &.{.{ .name = "content-type", .value = "application/json" }}, body);
    const status = Value.intOf(r.get("status")) orelse 0;
    if (status != 200) return sk.report(try std.fmt.allocPrint(a, "{s}handshake with {s}: HTTP {d} {s}", .{ if (transient(status)) "transient: " else "", peer.url, status, describe(a, r) }));
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, Value.bytesOf(r.get("body")) orelse "", .{}) catch return sk.report("handshake: the answer is not JSON");
    if (j != .object) return sk.report("handshake: the answer is not an object");
    const o = j.object;
    const ik = o.get("identityKey") orelse return sk.report("handshake: no identityKey");
    const server = if (ik == .string) sk.unhex(a, ik.string) orelse return sk.report("handshake: bad identityKey") else return sk.report("handshake: bad identityKey");
    if (!sk.isKey(server)) return sk.report("handshake: bad identityKey");
    const their_v = o.get("initialNonce") orelse return sk.report("handshake: no initialNonce");
    if (their_v != .string) return sk.report("handshake: bad initialNonce");
    const theirs = their_v.string;
    const yours = o.get("yourNonce") orelse return sk.report("handshake: no yourNonce");
    if (yours != .string or !eql(u8, yours.string, ours)) return sk.report("handshake: the answer is not to our nonce");
    const sig_v = o.get("signature") orelse return sk.report("handshake: no signature");
    if (sig_v != .array) return sk.report("handshake: bad signature");
    const sig = try a.alloc(u8, sig_v.array.items.len);
    for (sig_v.array.items, 0..) |x, i| sig[i] = if (x == .integer) @intCast(x.integer) else return sk.report("handshake: bad signature");
    const data = try std.mem.concat(a, u8, &.{ brc.decode64(a, ours).?, brc.decode64(a, theirs) orelse return sk.report("handshake: initialNonce is not base64") });
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ ours, theirs });
    if (!try brc.verifySignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = server }, data, sig)) return sk.report("handshake: the messagebox's signature does not verify");
    var s = cbor.MapBuilder.init(a);
    try s.put("kind", cbor.string("outbound-session"));
    try s.put("peer", .{ .bytes = peer.key });
    try s.put("url", cbor.string(peer.url));
    try s.put("ours", cbor.string(ours));
    try s.put("theirs", cbor.string(theirs));
    try s.put("server", .{ .bytes = server });
    try s.put("created", cbor.int(at));
    try saveOutbound(a, peer.key, s.value());
    return .{ .ours = ours, .theirs = theirs, .server = server };
}

const Sent = struct { r: Value, proof: Value };

/// One signed request on the session; the answer's signature checked.
fn request(a: Allocator, peer: Peer, s: Session, me: []const u8, endpoint: []const u8, body: []const u8) !Sent {
    var rid: [32]u8 = undefined;
    std.posix.getrandom(&rid) catch return error.Random;
    const rid64 = try brc.encode64(a, &rid);
    const nonce = try brc.random64(a);
    const path = try std.fmt.allocPrint(a, "{s}{s}", .{ trimSlash(pathOf(peer.url)), endpoint });
    const ct = [_]brc.Header{.{ .name = "content-type", .value = "application/cbor" }};
    const payload = try brc.requestPayload(a, &rid, "POST", path, "", &ct, body);
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.theirs });
    const sig = try brc.createSignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = s.server }, payload);
    const headers = [_]brc.Header{
        ct[0],
        .{ .name = "x-bsv-auth-version", .value = brc.VERSION },
        .{ .name = "x-bsv-auth-identity-key", .value = try sk.hex(a, me) },
        .{ .name = "x-bsv-auth-nonce", .value = nonce },
        .{ .name = "x-bsv-auth-your-nonce", .value = s.theirs },
        .{ .name = "x-bsv-auth-signature", .value = try sk.hex(a, sig) },
        .{ .name = "x-bsv-auth-request-id", .value = rid64 },
    };
    const r = try httpCall(a, "POST", try std.fmt.allocPrint(a, "{s}{s}", .{ trimSlash(peer.url), endpoint }), &headers, body);
    var p = cbor.MapBuilder.init(a);
    try p.put("payload", .{ .bytes = payload });
    try p.put("signature", .{ .bytes = sig });
    try p.put("nonce", cbor.string(nonce));
    try p.put("yourNonce", cbor.string(s.theirs));
    const status = Value.intOf(r.get("status")) orelse 0;
    if (status == 401) return .{ .r = r, .proof = p.value() };
    // A signed answer: checked against the session (a 4xx/5xx from a proxy in front may not be signed).
    const rh = r.get("headers");
    if (brc.headerOf(rh, "x-bsv-auth-signature")) |sh| {
        var signed: std.ArrayList(brc.Header) = .empty;
        if (rh) |hm| if (hm == .map) for (hm.map) |e| {
            const k = e.key;
            if ((std.mem.startsWith(u8, k, "x-bsv-") and !std.mem.startsWith(u8, k, "x-bsv-auth")) or eql(u8, k, "authorization")) try signed.append(a, .{ .name = k, .value = Value.str(e.value) orelse "" });
        };
        std.mem.sort(brc.Header, signed.items, {}, struct {
            fn lt(_: void, x: brc.Header, y: brc.Header) bool {
                return std.mem.order(u8, x.name, y.name) == .lt;
            }
        }.lt);
        const rp = try brc.responsePayload(a, &rid, @intCast(status), signed.items, Value.bytesOf(r.get("body")) orelse "");
        const rn = brc.headerOf(rh, "x-bsv-auth-nonce") orelse "";
        const rk = try std.fmt.allocPrint(a, "{s} {s}", .{ rn, s.ours });
        const rsig = sk.unhex(a, sh) orelse return sk.report("the answer's signature is not hex");
        if (!eql(u8, sk.unhex(a, brc.headerOf(rh, "x-bsv-auth-identity-key") orelse "") orelse "", s.server)) return sk.report("the answer is from another identity than the session's");
        if (!try brc.verifySignature(a, brc.AUTH_PROTOCOL, rk, .{ .other = s.server }, rp, rsig)) return sk.report("the messagebox's answer does not verify");
    } else if (status == 200) return sk.report("the recipient's answer is not signed");
    return .{ .r = r, .proof = p.value() };
}

/// On a new session, tell the peer who we are: a claim {handle, domain} in its
/// `register` box, which its resolve program checks by resolving it (so it can
/// answer us). A peer that takes no claims (a mailbox instance) refuses it, and
/// that is all.
fn claim(a: Allocator, in: Value, peer: Peer, s: Session, me: []const u8) !void {
    const self = in.get("self") orelse return;
    const handle = Value.str(self.get("handle")) orelse return;
    const domain = Value.str(self.get("domain")) orelse return;
    var c = cbor.MapBuilder.init(a);
    try c.put("handle", cbor.string(handle));
    try c.put("domain", cbor.string(domain));
    var m = cbor.MapBuilder.init(a);
    try m.put("recipient", .{ .bytes = peer.key });
    try m.put("messageBox", cbor.string("register"));
    try m.put("body", .{ .bytes = try cbor.encode(a, c.value()) });
    var outer = cbor.MapBuilder.init(a);
    try outer.put("message", m.value());
    _ = request(a, peer, s, me, "/sendMessage", try cbor.encode(a, outer.value())) catch |err| {
        if (err != error.Reported) return err;
    };
}

pub fn send(a: Allocator, in: Value, arg: Value) !Value {
    const to = Value.bytesOf(arg.get("to")) orelse return sk.report("send wants {to, box, body, handle?, domain?}");
    if (!sk.isKey(to)) return sk.report("send: `to` is not an identity key");
    const box = Value.str(arg.get("box")) orelse return sk.report("send: no box");
    const raw = Value.bytesOf(arg.get("body")) orelse return sk.report("send: no body");
    const blk = try cbor.block(a, cbor.decode(a, raw) catch return sk.report("send: the body is not dag-cbor"));
    const stepv = in.get("step") orelse return sk.report("send is called from a step (its http calls are recorded there)");
    const at = Value.intOf(stepv.get("at")) orelse 0;
    const me = if (in.get("self")) |s| Value.bytesOf(s.get("identity")) orelse try brc.identityKey(a) else try brc.identityKey(a);

    const peer = (try peerOf(a, in, to)) orelse blk: {
        // First contact: a handle to resolve (the resolve program writes the peer record).
        const handle = Value.str(arg.get("handle")) orelse return sk.report(try std.fmt.allocPrint(a, "no peer record for {s}: resolve its handle first", .{try sk.hex(a, to)}));
        const resolver = sk.program(in, "resolve") orelse return sk.report("no peer record, and no resolve program");
        var q = cbor.MapBuilder.init(a);
        try q.put("handle", cbor.string(handle));
        try q.put("domain", arg.get("domain") orelse cbor.string("localhost"));
        try q.put("key", .{ .bytes = to });
        const p = sk.callValue(a, resolver, "resolve", q.value()) catch |err| {
            if (err == error.ImportFailed) return sk.report(sk.lastError());
            return err;
        };
        break :blk Peer{ .key = to, .url = try a.dupe(u8, Value.str(p.get("url")) orelse return sk.report("resolve gave no messagebox URL")) };
    };

    var m = cbor.MapBuilder.init(a);
    try m.put("recipient", .{ .bytes = to });
    try m.put("messageBox", cbor.string(box));
    try m.put("body", .{ .bytes = blk.bytes });
    var outer = cbor.MapBuilder.init(a);
    try outer.put("message", m.value());
    const body = try cbor.encode(a, outer.value());

    var session: Session = undefined;
    if (try outboundOf(a, to, peer.url)) |s| {
        session = s;
    } else {
        session = try handshake(a, me, peer, at);
        try claim(a, in, peer, session, me);
    }
    var sent = try request(a, peer, session, me, "/sendMessage", body);
    if ((Value.intOf(sent.r.get("status")) orelse 0) == 401) {
        // The recipient forgot the session (expired, restarted): shake hands again, once.
        session = try handshake(a, me, peer, at);
        try claim(a, in, peer, session, me);
        sent = try request(a, peer, session, me, "/sendMessage", body);
    }
    const status = Value.intOf(sent.r.get("status")) orelse 0;
    if (status != 200) return sk.report(try std.fmt.allocPrint(a, "{s}Message Box send failed with HTTP {d}: {s}", .{ if (transient(status)) "transient: " else "", status, describe(a, sent.r) }));

    // The record the recipient keeps, and its id.
    var rec = cbor.MapBuilder.init(a);
    try rec.put("kind", cbor.string("mail"));
    try rec.put("op", cbor.string("put"));
    try rec.put("sender", .{ .bytes = me });
    try rec.put("recipient", .{ .bytes = to });
    try rec.put("box", cbor.string(box));
    try rec.put("body", cbor.cidv(blk.cid));
    try rec.put("session", sent.proof);
    const id = try sk.put(a, rec.value());
    try sk.putBlock(blk.cid, blk.bytes);
    if (cbor.decode(a, Value.bytesOf(sent.r.get("body")) orelse "")) |ans| {
        if (Value.str(ans.get("id")) orelse Value.str(ans.get("messageId"))) |theirs| {
            const tc = cid.parse(a, theirs) catch null;
            if (tc) |c| if (!eql(u8, c, id)) return sk.report(try std.fmt.allocPrint(a, "the recipient keeps the message as {s}, not {s}", .{ theirs, try cid.format(a, id) }));
        }
    } else |_| {}
    var out = cbor.MapBuilder.init(a);
    try out.put("id", cbor.cidv(id));
    try out.put("url", cbor.string(peer.url));
    return out.value();
}
