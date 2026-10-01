//! Delivery (#70, #67): the outbound middleware of the `mailbox` transport.
//! A message a step emits to a recipient whose address book entry is
//! `{transport: "mailbox", address: <messagebox URL>}` is delivered by the
//! instance itself, as a BRC-103/104 client of that messagebox: the kernel
//! launches this program as the message's **delivery thread** (args
//! {message: <the signed mail record>, transport: "mailbox"}), and the
//! thread talks HTTP through the `fetch` provider — each request built and
//! signed here, emitted to the provider (box "fetch"), and its answer the
//! entry that steps the thread again. External communication is a thread:
//! nothing waits mid-step.
//!
//!   step 1   no session with the recipient's messagebox: the BRC-103
//!            initialRequest, POST <url>/.well-known/auth → await
//!   step 2   the initialResponse: its signature over both nonces checked, the
//!            session kept (head `outbound`); the BRC-104-signed POST
//!            <url>/sendMessage (BRC-231 CBOR: {message: {recipient,
//!            messageBox, body, signature, subject?}} — the signed message
//!            itself) → await
//!   step 3   the answer: its signature checked against the session; 200 and
//!            the recipient keeps the message under the same CID →
//!            finished {delivered: <cid>, url}. A 401 (the recipient forgot
//!            the session): shake hands again, once.
//!
//! Failure: `transient: …` (no answer, 5xx, 408, 425, 429) is tried again
//! at `defaults.sendRetryMs` (default 30 000) — a deadline, the waker's wake
//! — up to `defaults.sendAttempts` attempts in all (default 3); anything else,
//! or the last attempt, ends the thread errored, and the kernel steps the
//! thread awaiting the message with `undelivered: {message, error}` (no
//! answer can come). Sending never tells the peer who we are beyond the
//! session (no claim, no registration: application wiring, #40).
//!
//! The session is the instance's own, one per peer (head `outbound`:
//! {kind: "outbound", sessions: [{key, session: <cid>}]}, each {kind:
//! "outbound-session", peer, url, ours, theirs, server, created}). `server`
//! is the identity that answered the handshake — the recipient's own, or a
//! mailbox instance's for a mailbox kept for someone.
const std = @import("std");
const cbor = @import("cbor");
const cid = cbor.cidm;
const sk = @import("sk");
const brc = @import("brc104");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const OUTBOUND = "outbound";
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 30_000;

pub const Peer = struct { key: []const u8, url: []const u8 };

/// A session with a messagebox: our nonce, its nonce, and its identity.
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
    return std.mem.trimEnd(u8, s, "/");
}

fn transientStatus(status: i128) bool {
    return status >= 500 or status == 408 or status == 425 or status == 429;
}

fn describe(a: Allocator, body: []const u8) []const u8 {
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

/// Emit one HTTP request to the `fetch` provider and await its answer.
fn fetch(a: Allocator, method: []const u8, url: []const u8, headers: []const brc.Header, body: []const u8) ![]const u8 {
    var h = cbor.MapBuilder.init(a);
    for (headers) |x| try h.put(x.name, cbor.string(x.value));
    return sk.fetch(a, method, url, h.value(), if (body.len > 0) body else null);
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
    peer: Peer,
    me: []const u8,
    at: i128,
    attempt: i64,

    /// This attempt from the start: the signed request if a session is held, else the handshake.
    fn begin(c: *Ctx, again: bool) !void {
        const a = c.a;
        if (try outboundOf(a, c.peer.key, c.peer.url)) |s| return c.sendRequest(s, again);
        // BRC-103: our nonce; the answer is the next step's.
        const ours = try brc.createNonce(a);
        const url = try std.fmt.allocPrint(a, "{s}{s}", .{ trimSlash(c.peer.url), brc.WELL_KNOWN });
        const body = try std.fmt.allocPrint(a, "{{\"version\":\"{s}\",\"messageType\":\"initialRequest\",\"identityKey\":\"{s}\",\"initialNonce\":\"{s}\",\"requestedCertificates\":{{\"certifiers\":[],\"types\":{{}}}}}}", .{ brc.VERSION, try sk.hex(a, c.me), ours });
        _ = try fetch(a, "POST", url, &.{.{ .name = "content-type", .value = "application/json" }}, body);
        try c.state(&.{
            .{ .key = "stage", .value = cbor.string("handshake") },
            .{ .key = "ours", .value = cbor.string(ours) },
            .{ .key = "again", .value = .{ .bool = again } },
        });
    }

    /// The initialResponse: our nonce answered, their signature over both nonces checked; the session kept.
    fn handshaken(c: *Ctx, ours: []const u8, raw: []const u8) !Session {
        const a = c.a;
        const j = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch return sk.report("handshake: the answer is not JSON");
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
        const data = try std.mem.concat(a, u8, &.{ brc.decode64(a, ours) orelse return sk.report("handshake: our nonce is not base64"), brc.decode64(a, theirs) orelse return sk.report("handshake: initialNonce is not base64") });
        const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ ours, theirs });
        if (!try brc.verifySignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = server }, data, sig)) return sk.report("handshake: the messagebox's signature does not verify");
        var s = cbor.MapBuilder.init(a);
        try s.put("kind", cbor.string("outbound-session"));
        try s.put("peer", .{ .bytes = c.peer.key });
        try s.put("url", cbor.string(c.peer.url));
        try s.put("ours", cbor.string(ours));
        try s.put("theirs", cbor.string(theirs));
        try s.put("server", .{ .bytes = server });
        try s.put("created", cbor.int(c.at));
        try saveOutbound(a, c.peer.key, s.value());
        return .{ .ours = ours, .theirs = theirs, .server = server };
    }

    /// The BRC-104-signed POST of the signed message to the recipient's /sendMessage (BRC-231 CBOR).
    fn sendRequest(c: *Ctx, s: Session, again: bool) !void {
        const a = c.a;
        var m = cbor.MapBuilder.init(a);
        try m.put("recipient", .{ .bytes = c.peer.key });
        try m.put("messageBox", cbor.string(Value.str(c.msg.get("box")) orelse ""));
        try m.put("body", .{ .bytes = c.body });
        try m.put("signature", c.msg.get("signature"));
        try m.put("subject", c.msg.get("subject"));
        try m.put("nonce", c.msg.get("nonce"));
        var outer = cbor.MapBuilder.init(a);
        try outer.put("message", m.value());
        const body = try cbor.encode(a, outer.value());
        var rid: [32]u8 = undefined;
        sk.io().randomSecure(&rid) catch return error.Random;
        const rid64 = try brc.encode64(a, &rid);
        const nonce = try brc.random64(a);
        const path = try std.fmt.allocPrint(a, "{s}/sendMessage", .{trimSlash(pathOf(c.peer.url))});
        const ct = [_]brc.Header{.{ .name = "content-type", .value = "application/cbor" }};
        const payload = try brc.requestPayload(a, &rid, "POST", path, "", &ct, body);
        const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.theirs });
        const sig = try brc.createSignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = s.server }, payload);
        const headers = [_]brc.Header{
            ct[0],
            .{ .name = "x-bsv-auth-version", .value = brc.VERSION },
            .{ .name = "x-bsv-auth-identity-key", .value = try sk.hex(a, c.me) },
            .{ .name = "x-bsv-auth-nonce", .value = nonce },
            .{ .name = "x-bsv-auth-your-nonce", .value = s.theirs },
            .{ .name = "x-bsv-auth-signature", .value = try sk.hex(a, sig) },
            .{ .name = "x-bsv-auth-request-id", .value = rid64 },
        };
        _ = try fetch(a, "POST", try std.fmt.allocPrint(a, "{s}/sendMessage", .{trimSlash(c.peer.url)}), &headers, body);
        try c.state(&.{
            .{ .key = "stage", .value = cbor.string("send") },
            .{ .key = "rid", .value = cbor.string(rid64) },
            .{ .key = "again", .value = .{ .bool = again } },
        });
    }

    /// A signed answer, checked against the session (a 4xx/5xx from a proxy in front may not be signed; a 200 must be).
    fn checkAnswer(c: *Ctx, s: Session, rid64: []const u8, status: i128, rh: ?Value, rbody: []const u8) !void {
        const a = c.a;
        const sh = brc.headerOf(rh, "x-bsv-auth-signature") orelse {
            if (status == 200) return sk.report("the recipient's answer is not signed");
            return;
        };
        const rid = brc.decode64(a, rid64) orelse return sk.report("delivery: the request id is not base64");
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
        const rp = try brc.responsePayload(a, rid, @intCast(status), signed.items, rbody);
        const rn = brc.headerOf(rh, "x-bsv-auth-nonce") orelse "";
        const rk = try std.fmt.allocPrint(a, "{s} {s}", .{ rn, s.ours });
        const rsig = sk.unhex(a, sh) orelse return sk.report("the answer's signature is not hex");
        if (!eql(u8, sk.unhex(a, brc.headerOf(rh, "x-bsv-auth-identity-key") orelse "") orelse "", s.server)) return sk.report("the answer is from another identity than the session's");
        if (!try brc.verifySignature(a, brc.AUTH_PROTOCOL, rk, .{ .other = s.server }, rp, rsig)) return sk.report("the messagebox's answer does not verify");
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
        try c.state(&.{
            .{ .key = "stage", .value = cbor.string("retry") },
            .{ .key = "error", .value = cbor.string(why) },
        });
    }

    /// The step's stdout: what the next step goes on from (with the attempt).
    fn state(c: *Ctx, fields: []const cbor.Entry) !void {
        var m = cbor.MapBuilder.init(c.a);
        for (fields) |f| try m.put(f.key, f.value);
        try m.put("attempt", cbor.int(c.attempt));
        try sk.answer(c.a, m.value());
    }
};

fn boolOf(v: ?Value) ?bool {
    const x = v orelse return null;
    return if (x == .bool) x.bool else null;
}

/// A step of a message's delivery thread (#70).
pub fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const mc = Value.cidOf(args.get("message")) orelse return sk.report("delivery: no message");
    const msg = try sk.get(a, mc);
    const to = Value.bytesOf(msg.get("recipient")) orelse return sk.report("delivery: not a message record");
    const body = try sk.getBytes(a, Value.cidOf(msg.get("body")) orelse return sk.report("delivery: the message has no body"));
    const p = (try sk.peerOf(a, to)) orelse return sk.report(try std.fmt.allocPrint(a, "no route to {s}: not in the address book", .{try sk.hex(a, to)}));
    if (!eql(u8, Value.str(p.get("transport")) orelse "", "mailbox")) return sk.report("delivery: the recipient is not reached by mailbox any more");
    const url = Value.str(p.get("address")) orelse return sk.report("delivery: the address book names no URL");
    const me = if (in.get("self")) |s| Value.bytesOf(s.get("identity")) orelse try brc.identityKey(a) else try brc.identityKey(a);
    const st = try saved(a, in);
    var c = Ctx{
        .a = a,
        .in = in,
        .mc = mc,
        .msg = msg,
        .body = body,
        .peer = .{ .key = to, .url = url },
        .me = me,
        .at = Value.intOf(in.get("at")) orelse 0,
        .attempt = if (st) |s| @intCast(Value.intOf(s.get("attempt")) orelse 1) else 1,
    };
    const state = st orelse return c.begin(false);
    const stage = Value.str(state.get("stage")) orelse "";
    if (in.get("woke")) |w| if (w == .bool and w.bool) {
        // The retry's deadline: the next attempt.
        c.attempt += 1;
        return c.begin(false);
    };
    const r = (try sk.replyOf(a, in)) orelse return sk.report("delivery: stepped with no answer to go on with");
    if (Value.str(r.body.get("error"))) |e| return c.failed(try std.fmt.allocPrint(a, "transient: {s}: {s}", .{ url, e }));
    const status = Value.intOf(r.body.get("status")) orelse 0;
    const rbody = Value.bytesOf(r.body.get("body")) orelse "";
    if (eql(u8, stage, "handshake")) {
        if (status != 200) {
            const why = try std.fmt.allocPrint(a, "{s}handshake with {s}: HTTP {d} {s}", .{ if (transientStatus(status)) "transient: " else "", url, status, describe(a, rbody) });
            return c.failed(why);
        }
        const s = try c.handshaken(Value.str(state.get("ours")) orelse "", rbody);
        return c.sendRequest(s, boolOf(state.get("again")) orelse false);
    }
    if (!eql(u8, stage, "send")) return sk.report("delivery: an answer in no stage");
    const s = (try outboundOf(a, to, url)) orelse return c.begin(true);
    if (status == 401) {
        // The recipient forgot the session (expired, restarted): shake hands again, once.
        try saveOutbound(a, to, null);
        if (boolOf(state.get("again")) orelse false) return c.failed(try std.fmt.allocPrint(a, "Message Box send failed with HTTP 401: {s}", .{describe(a, rbody)}));
        return c.begin(true);
    }
    try c.checkAnswer(s, Value.str(state.get("rid")) orelse "", status, r.body.get("headers"), rbody);
    if (status != 200) return c.failed(try std.fmt.allocPrint(a, "{s}Message Box send failed with HTTP {d}: {s}", .{ if (transientStatus(status)) "transient: " else "", status, describe(a, rbody) }));
    if (cbor.decode(a, rbody)) |ans| {
        if (Value.str(ans.get("id")) orelse Value.str(ans.get("messageId"))) |theirs| {
            const tc = cid.parse(a, theirs) catch null;
            if (tc) |x| if (!eql(u8, x, mc)) return sk.report(try std.fmt.allocPrint(a, "the recipient keeps the message as {s}, not {s}", .{ theirs, try cid.format(a, mc) }));
        }
    } else |_| {}
    var out = cbor.MapBuilder.init(a);
    try out.put("delivered", cbor.cidv(mc));
    try out.put("url", cbor.string(url));
    try out.put("attempt", cbor.int(c.attempt));
    try sk.answer(a, out.value());
}

