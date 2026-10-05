//! The front door (#40, #68): the instance's middleware for HTTP and libp2p.
//! The host appends every package a transport carries in as a `request`
//! entry, as received, and verifies nothing; the kernel steps this program
//! on it, as the request's own thread (#66: the thread a synchronous client
//! waits on). The kernel has matched the package to a dispatch row (#115:
//! the table matches every transport, dispatch.zig) on who it claims to be
//! from; this program's first step verifies that claim — BRC-103/104 for
//! HTTP, the GossipSub signature for libp2p (libp2p.zig) — and runs the
//! row's handler, an in-VM call, part of this step. It never sees the
//! table. A failed verification is a recorded refusal: the step answers it
//! and nothing else changes.
//!
//! Stepped: input {kind: "step", args: {request: <record>, transport}, match? | refused?, seen?, tip?, …}
//!   the request record (kernel-zig/src/log.zig):
//!     http    {kind: "http", method, path, route, query, headers: {name: value}, body: bytes}
//!     local   {kind: "message", message: <a signed mail record>, body: bytes}   (#70: a
//!             provider's answer, or any signed message the host hands in: the
//!             signature checked, and admitted — signedMessage)
//!   Its stdout is its answer (the kernel routes `admit`; the host reads the
//!   rest off the thread's last update once it has come to rest):
//!     {status, headers: {name: value}, body: bytes, admit?: [entry]}     answered (signed on the session)
//!     {read: {caller?, peer?, theirs?, requestId?, match}}               answered by a read after it ends (below)
//!     {wait: {caller?, session?, peer?, theirs?, requestId?}, admit?}    waiting: the handler launched or awaits a thread
//!   an entry is {mail: <record>, body: bytes} or {event: <record>, box}:
//!   routed by the kernel after the step as the entries they once were.
//!
//! The row (input `match`, #115) is the one the kernel's dispatch table
//! matched (docs/MESSAGES.md "The dispatch table"): for http
//!   {transport: "http", address: <path>, prefix?: true, sender: "*" | "session" | "owner" | <key>, program, fn, …}
//!   exact paths first, then the longest prefix, the first whose sender
//!   takes the identity the request claims (`x-bsv-auth-identity-key`).
//!   `sender` "*" is an open route: no session is checked and the handler
//!   gets no caller (an overlay's submit and lookup); any other needs the
//!   BRC-103/104 session and signature verified here, for the identity the
//!   kernel matched on. With no row the kernel says why (`refused`):
//!   "path" 404; "session" 401 (the stock client shakes hands); "sender"
//!   403, signed on the session once verified. The row is the handler's
//!   `match`.
//!
//! The route handler contract (docs/MESSAGES.md, "Route handlers"): called
//! with {caller?, method, path, route, query, headers, body, contentType,
//! session?, match, request} (and, called again, resolved? | event? | reply?
//! | woke?), it answers {status, type?, body, headers?, admit?} — or {wait:
//! true, admit?} once it has launched (or awaits) the thread its answer
//! depends on: this thread then waits, and when that thread comes to rest
//! the handler is called again with the same request and `resolved` — or
//! {read: true}: its answer is a read of live state (the explorer), made by
//! the host once this thread has ended (fn "read"). Its `headers` go out
//! with the answer but for content-type (its `type`) and the x-bsv-* ones
//! (the front door's). A handler never sees the session table; a message it
//! admits carries the sender key, the 104 signature and both nonces, so its
//! authorship verifies from the log alone.
//!
//! Called (a kernel call, #40 — reads only, nothing written):
//!   fn "read"     {request: <cid>, read: {caller?, peer?, theirs?, requestId?, match}} → {status, headers, body}
//!                 a route whose answer is a read of live state (the explorer: the
//!                 log as it stands is not a function of the request's place in it,
//!                 so no step may answer it): the host calls this once the request's
//!                 thread has verified it and ended; the handler runs as a call and
//!                 the answer is signed on the session here (not recorded).
//!   fn "explore"  the explorer's route handler (explore.zig).
//!
//! Sessions are state (#68, sessions.zig): the head `frontdoor/sessions` (#77:
//! the front door's own, under its name). A request's
//! session is looked up by its `yourNonce`. Expiry: `defaults.sessionTtlMs`
//! (a day) from `created` (the handshake entry's time); an unknown or
//! expired session is a plain 401 and the stock client shakes hands again.
//! A handshake drops the expired sessions, and the oldest past
//! MAX_SESSIONS. Replay: a replayed initialRequest (the peer and initial
//! nonce of a session held) is refused; a replayed signed request verifies
//! (its nonce is not remembered: a replayed read reads again), and a
//! replayed write is the same message record, which the kernel admits once.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const brc = @import("brc104");
const explore = @import("explore.zig");
const p2p = @import("libp2p.zig");
const sessions = @import("sessions.zig");
const message = @import("message");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const DEFAULT_TTL_MS: i128 = 24 * 60 * 60 * 1000;
/// The session table's bound: a handshake past it drops the oldest session.
const MAX_SESSIONS = 1024;

pub fn main() u8 {
    return sk.main("frontdoor", run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "step")) return sk.answer(a, try stepped(a, in));
    if (!eql(u8, kind, "call")) return sk.report("the front door is stepped on a request, or called (fn \"read\", \"explore\")");
    const func = Value.str(in.get("fn")) orelse "";
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("the argument is not dag-cbor");
    if (eql(u8, func, "read")) return sk.answer(a, try read(a, in, arg));
    if (eql(u8, func, "explore")) {
        // In a step (the request's thread) the log's live state is no answer: the host reads it after (fn "read").
        if (in.get("step") != null) {
            var m = cbor.MapBuilder.init(a);
            try m.put("read", .{ .bool = true });
            return sk.answer(a, m.value());
        }
        const r = try explore.explore(a, in, arg);
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(r.status));
        try m.put("type", cbor.string("application/json"));
        try m.put("body", .{ .bytes = r.body });
        return sk.answer(a, m.value());
    }
    return sk.report("unknown fn (the front door is called for \"read\", and as the route handler \"explore\")");
}

/// A step of a request's thread: the first verifies and routes; a later one
/// (the handler waited on a thread) calls the handler again.
fn stepped(a: Allocator, in: Value) !Value {
    const args = in.get("args") orelse return sk.report("no args");
    const rc = Value.cidOf(args.get("request")) orelse return sk.report("no request");
    const transport = Value.str(args.get("transport")) orelse "";
    const req = try sk.get(a, rc);
    if (eql(u8, transport, "libp2p")) return p2p.stepped(a, in, rc, req);
    if (eql(u8, transport, "local")) return signedMessage(a, in, req.get("message") orelse .null, Value.bytesOf(req.get("body")) orelse "");
    if (!eql(u8, transport, "http")) return sk.report("the front door takes http, libp2p and local");
    if (Value.cidOf(in.get("tip"))) |tip| return resumed(a, in, rc, req, tip);
    return http(a, in, rc, req);
}

/// A signed message carried in whole (#70): a provider's (transport
/// `local`: {kind: "message", message, body}) or one over libp2p (a frame on
/// /skein/message/1.0.0, a topic message nothing else routes). Its signature,
/// its body and its recipient (this instance) checked here, it is admitted as
/// the message it is — routed by the kernel after the step by its `replyTo`,
/// else by subscription on (sender, box), once (the `unique` map). The answer:
/// {verdict: "accept", admit: [{mail, body}]} | {verdict: "reject" | "ignore", reason}.
pub fn signedMessage(a: Allocator, in: Value, m: Value, body: []const u8) !Value {
    const V = struct {
        fn no(al: Allocator, v: []const u8, reason: []const u8) !Value {
            var r = cbor.MapBuilder.init(al);
            try r.put("verdict", cbor.string(v));
            try r.put("reason", cbor.string(reason));
            return r.value();
        }
    };
    if (try message.problem(a, m, body)) |bad| return V.no(a, "reject", bad);
    const me = selfIdentity(in) orelse return V.no(a, "ignore", "no identity");
    if (!eql(u8, Value.bytesOf(m.get("recipient")).?, me)) return V.no(a, "ignore", "the message is for another identity");
    var entry = cbor.MapBuilder.init(a);
    try entry.put("mail", m);
    try entry.put("body", .{ .bytes = body });
    var r = cbor.MapBuilder.init(a);
    try r.put("verdict", cbor.string("accept"));
    try r.put("admit", .{ .array = try a.dupe(Value, &.{entry.value()}) });
    return r.value();
}

/// What this thread's last step saved (`wait`), from its tip's stdout.
pub fn saved(a: Allocator, tip: []const u8) !Value {
    const u = try sk.get(a, tip);
    const res = u.get("result") orelse return sk.report("the tip has no result");
    const out = cbor.decode(a, Value.bytesOf(res.get("stdout")) orelse "") catch return sk.report("the last step's answer is not dag-cbor");
    return out.get("wait") orelse sk.report("the last step saved nothing to go on with");
}

// ---------------------------------------------------------------- responses

const Resp = struct {
    status: u64,
    type: []const u8 = "application/json",
    body: []const u8,
    headers: std.ArrayList(brc.Header) = .empty,
    admit: ?Value = null,

    fn value(r: *Resp, a: Allocator) !Value {
        var h = cbor.MapBuilder.init(a);
        try h.put("content-type", cbor.string(r.type));
        for (r.headers.items) |x| try h.put(x.name, cbor.string(x.value));
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(r.status));
        try m.put("headers", h.value());
        try m.put("body", .{ .bytes = r.body });
        try m.put("admit", r.admit);
        return m.value();
    }
};

fn jsonError(a: Allocator, status: u64, code: []const u8, description: []const u8) !Resp {
    var out: std.Io.Writer.Allocating = .init(a);
    try std.json.Stringify.value(.{ .status = "error", .code = code, .description = description }, .{}, &out.writer);
    return .{ .status = status, .body = out.written() };
}

/// Who a request was verified as: what signing its answer on the session takes, and the handler's `caller`/`session`.
const Verified = struct { peer: []const u8, theirs: []const u8, request_id: []const u8, proof: ?Value = null };

fn verifiedValue(a: Allocator, v: ?Verified) !Value {
    var m = cbor.MapBuilder.init(a);
    if (v) |x| {
        try m.put("caller", .{ .bytes = x.peer });
        try m.put("peer", .{ .bytes = x.peer });
        try m.put("theirs", cbor.string(x.theirs));
        try m.put("requestId", cbor.string(x.request_id));
        try m.put("session", x.proof);
    }
    return m.value();
}

fn verifiedOf(s: Value) ?Verified {
    return .{
        .peer = Value.bytesOf(s.get("peer")) orelse return null,
        .theirs = Value.str(s.get("theirs")) orelse return null,
        .request_id = Value.str(s.get("requestId")) orelse return null,
        .proof = s.get("session"),
    };
}

// ---------------------------------------------------------------- the request

fn http(a: Allocator, in: Value, rc: []const u8, req: Value) !Value {
    const route = Value.str(req.get("route")) orelse "/";
    const method = Value.str(req.get("method")) orelse "GET";
    var resp: Resp = undefined;
    if (eql(u8, route, brc.WELL_KNOWN)) {
        resp = if (eql(u8, method, "POST")) try handshake(a, in, req) else try jsonError(a, 405, "ERR_METHOD", "POST the BRC-103 handshake here");
        return resp.value(a);
    }
    // #115: the kernel matched the row on the identity the request claims; this verifies the claim.
    const r = in.get("match");
    const refused = Value.str(in.get("refused")) orelse "path";
    if (r == null and !eql(u8, refused, "sender")) {
        resp = if (eql(u8, refused, "session")) mutualAuthFailed() else try jsonError(a, 404, "ERR_NOT_FOUND", "no route for this path");
        return resp.value(a);
    }
    if (r) |row| if (isOpen(row)) return routed(a, in, row, rc, req, null);
    // BRC-104: a general message.
    const headers = req.get("headers");
    const request_id = brc.headerOf(headers, "x-bsv-auth-request-id") orelse {
        resp = mutualAuthFailed();
        return resp.value(a);
    };
    const v = verify(a, in, req, request_id) catch |err| {
        resp = switch (err) {
            error.Malformed => try jsonError(a, 400, "ERR_AUTH_MALFORMED", "The authentication request is malformed."),
            // A plain 401 (no auth headers): the stock client takes it as a stale session and shakes hands again.
            error.Unauthorized => try jsonError(a, 401, "ERR_AUTH_FAILED", why),
            else => return err,
        };
        return resp.value(a);
    };
    // The session's identity is the one the kernel matched on (verify checks the claimed key is the
    // session's): no row there takes it (#77: a row for one identity takes that identity's session only).
    const row = r orelse {
        resp = try jsonError(a, 403, "ERR_FORBIDDEN", "no route here takes this identity");
        try sign(a, in, &resp, v);
        return resp.value(a);
    };
    return routed(a, in, row, rc, req, v);
}

fn mutualAuthFailed() Resp {
    return .{ .status = 401, .body = "{\"status\":\"error\",\"code\":\"UNAUTHORIZED\",\"message\":\"Mutual-authentication failed!\"}" };
}

/// An open row (#77: sender "*"): no session is checked and the handler gets no caller.
fn isOpen(r: Value) bool {
    return eql(u8, Value.str(r.get("sender")) orelse "", "*");
}

/// A later step (#66): the thread the handler waited on has come to rest
/// (or what else it awaited arrived): the handler is called again with the
/// same request and what woke this thread.
fn resumed(a: Allocator, in: Value, rc: []const u8, req: Value, tip: []const u8) !Value {
    const s = try saved(a, tip);
    const r = in.get("match") orelse return sk.report("the route is gone");
    return routed(a, in, r, rc, req, verifiedOf(s));
}

/// The handler's answer, as this step's: answered (signed), a read after, or waiting.
fn routed(a: Allocator, in: Value, r: Value, rc: []const u8, req: Value, v: ?Verified) !Value {
    const out = invoke(a, in, r, rc, req, v) catch |err| {
        var resp = switch (err) {
            error.ImportFailed => try jsonError(a, 500, "ERR_INTERNAL", sk.lastError()),
            error.NoProgram => try jsonError(a, 500, "ERR_ROUTE", "the route names no program or fn"),
            else => return err,
        };
        if (v) |x| try sign(a, in, &resp, x);
        return resp.value(a);
    };
    if (out.get("wait")) |w| if (w == .bool and w.bool) {
        var m = cbor.MapBuilder.init(a);
        try m.put("wait", try verifiedValue(a, v));
        try m.put("admit", out.get("admit"));
        return m.value();
    };
    if (out.get("read")) |x| if (x == .bool and x.bool) {
        // The read after the thread (fn "read") runs this row's handler: the kernel's match, kept with the session.
        var rd = try verifiedValue(a, v);
        rd = .{ .map = try std.mem.concat(a, cbor.Entry, &.{ rd.map, &.{.{ .key = "match", .value = r }} }) };
        var m = cbor.MapBuilder.init(a);
        try m.put("read", rd);
        return m.value();
    };
    var resp = try respOf(a, out);
    if (v) |x| try sign(a, in, &resp, x);
    return resp.value(a);
}

/// A handler's {status, type?, body, headers?, admit?} as the front door answers it.
fn respOf(a: Allocator, out: Value) !Resp {
    var resp = Resp{
        .status = @intCast(Value.intOf(out.get("status")) orelse return jsonError(a, 500, "ERR_INTERNAL", "the handler answered no status")),
        .type = Value.str(out.get("type")) orelse "application/json",
        .body = Value.bytesOf(out.get("body")) orelse "",
        .admit = out.get("admit"),
    };
    // #52: the handler's own headers (ETag, Location, Allow, …), but for the
    // content type (its `type`) and the BRC-104 headers (the front door's).
    if (out.get("headers")) |hs| if (hs == .map) for (hs.map) |x| {
        const val = Value.str(x.value) orelse continue;
        if (std.ascii.eqlIgnoreCase(x.key, "content-type") or std.ascii.startsWithIgnoreCase(x.key, "x-bsv-")) continue;
        try resp.headers.append(a, .{ .name = try std.ascii.allocLowerString(a, x.key), .value = val });
    };
    return resp;
}

fn selfIdentity(in: Value) ?[]const u8 {
    const s = in.get("self") orelse return null;
    return Value.bytesOf(s.get("identity"));
}

/// The time the front door judges by: the step's entry (`at`), or a call's `now`.
fn nowOf(in: Value) i128 {
    return Value.intOf(in.get("at")) orelse Value.intOf(in.get("now")) orelse 0;
}

var why: []const u8 = "";

fn unauthorized(msg: []const u8) error{Unauthorized} {
    why = msg;
    return error.Unauthorized;
}

/// The route's handler, an in-VM call: the verified request, and — called
/// again on a later step — what woke this thread (`resolved`, `event`,
/// `reply`, `woke`). Its launches and awaits are this step's.
fn invoke(a: Allocator, in: Value, r: Value, rc: []const u8, req: Value, v: ?Verified) !Value {
    const prog = Value.cidOf(r.get("program")) orelse return error.NoProgram;
    const func = Value.str(r.get("fn")) orelse return error.NoProgram;
    var h = cbor.MapBuilder.init(a);
    if (v) |x| try h.put("caller", .{ .bytes = x.peer });
    for ([_][]const u8{ "method", "path", "query", "headers", "body" }) |k| try h.put(k, req.get(k));
    try h.put("route", cbor.string(Value.str(req.get("route")) orelse Value.str(req.get("path")) orelse "/"));
    const ct = brc.headerOf(req.get("headers"), "content-type") orelse "";
    try h.put("contentType", cbor.string(std.mem.trim(u8, ct[0 .. std.mem.indexOfScalar(u8, ct, ';') orelse ct.len], " ")));
    if (v) |x| try h.put("session", x.proof);
    // #52: the dispatch row that matched (a handler's own settings: static's root, index; the install's app).
    try h.put("match", r);
    try h.put("request", cbor.cidv(rc));
    for ([_][]const u8{ "resolved", "event", "reply", "woke" }) |k| try h.put(k, in.get(k));
    return sk.callValue(a, prog, func, h.value());
}

// ---------------------------------------------------------------- a read after the thread (fn "read")

/// The answer of a route whose handler answered {read: true} (the
/// explorer): its request's thread verified it (and the read rule) and
/// ended; this call runs the handler over the state as it stands and signs
/// the answer on the session. Nothing is written.
fn read(a: Allocator, in: Value, arg: Value) !Value {
    const rc = Value.cidOf(arg.get("request")) orelse return sk.report("read: no request");
    const s = arg.get("read") orelse return sk.report("read: no read");
    const req = try sk.get(a, rc);
    const r = s.get("match") orelse return sk.report("read: no route (the request's step keeps its matched row)");
    const v = verifiedOf(s);
    const out = invoke(a, in, r, rc, req, v) catch |err| {
        var resp = switch (err) {
            error.ImportFailed => try jsonError(a, 500, "ERR_INTERNAL", sk.lastError()),
            error.NoProgram => try jsonError(a, 500, "ERR_ROUTE", "the route names no program or fn"),
            else => return err,
        };
        if (v) |x| try sign(a, in, &resp, x);
        return resp.value(a);
    };
    var resp = try respOf(a, out);
    resp.admit = null; // a read writes nothing
    if (v) |x| try sign(a, in, &resp, x);
    return resp.value(a);
}

// ---------------------------------------------------------------- sessions

fn ttlOf(in: Value) i128 {
    const d = in.get("defaults") orelse return DEFAULT_TTL_MS;
    const t = Value.str(d.get("sessionTtlMs")) orelse return DEFAULT_TTL_MS;
    return std.fmt.parseInt(i128, t, 10) catch DEFAULT_TTL_MS;
}

fn verify(a: Allocator, in: Value, req: Value, request_id: []const u8) !Verified {
    const headers = req.get("headers");
    const h = struct {
        fn need(hs: ?Value, name: []const u8) ![]const u8 {
            const v = brc.headerOf(hs, name) orelse return error.Malformed;
            if (v.len == 0) return error.Malformed;
            return v;
        }
    };
    const key_hex = try h.need(headers, "x-bsv-auth-identity-key");
    const nonce = try h.need(headers, "x-bsv-auth-nonce");
    const your = try h.need(headers, "x-bsv-auth-your-nonce");
    const sig_hex = try h.need(headers, "x-bsv-auth-signature");
    _ = try h.need(headers, "x-bsv-auth-version");
    const peer = sk.unhex(a, key_hex) orelse return error.Malformed;
    if (!sk.isKey(peer)) return error.Malformed;
    const sig = sk.unhex(a, sig_hex) orelse return error.Malformed;
    const rid = brc.decode64(a, request_id) orelse return error.Malformed;
    var table = try sessions.Table.load(a);
    const s = (try table.find(your)) orelse return unauthorized("Session not found for nonce (expired or unknown)");
    if (s.created + ttlOf(in) < nowOf(in)) return unauthorized("Session expired");
    if (!eql(u8, s.peer, peer)) return unauthorized("general identity does not match the authenticated session.");
    const body = Value.bytesOf(req.get("body")) orelse "";
    const payload = try brc.requestPayload(a, rid, Value.str(req.get("method")) orelse "GET", Value.str(req.get("path")) orelse "/", Value.str(req.get("query")) orelse "", try brc.headerList(a, headers), body);
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.ours });
    if (!try brc.verifySignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = peer }, payload, sig)) return unauthorized("Invalid signature in generalMessage");
    var p = cbor.MapBuilder.init(a);
    try p.put("payload", .{ .bytes = payload });
    try p.put("signature", .{ .bytes = sig });
    try p.put("nonce", cbor.string(nonce));
    try p.put("yourNonce", cbor.string(your));
    return .{ .peer = peer, .theirs = s.theirs, .request_id = request_id, .proof = p.value() };
}

/// Sign the response on the session (in a step: a recorded wallet call; in a call: not recorded).
fn sign(a: Allocator, in: Value, r: *Resp, v: Verified) !void {
    const rid = brc.decode64(a, v.request_id) orelse return error.Malformed;
    const payload = try brc.responsePayload(a, rid, r.status, &.{}, r.body);
    const nonce = try brc.random64(a);
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, v.theirs });
    const sig = try brc.createSignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = v.peer }, payload);
    const me = selfIdentity(in) orelse try brc.identityKey(a);
    try r.headers.append(a, .{ .name = "x-bsv-auth-version", .value = brc.VERSION });
    try r.headers.append(a, .{ .name = "x-bsv-auth-identity-key", .value = try sk.hex(a, me) });
    try r.headers.append(a, .{ .name = "x-bsv-auth-nonce", .value = nonce });
    try r.headers.append(a, .{ .name = "x-bsv-auth-your-nonce", .value = v.theirs });
    try r.headers.append(a, .{ .name = "x-bsv-auth-signature", .value = try sk.hex(a, sig) });
    try r.headers.append(a, .{ .name = "x-bsv-auth-request-id", .value = v.request_id });
}

/// BRC-103 initialRequest → initialResponse: our nonce, our signature over
/// both nonces, and the new session written to the table (with the expired
/// sessions dropped, and the oldest past MAX_SESSIONS).
fn handshake(a: Allocator, in: Value, req: Value) !Resp {
    const raw = Value.bytesOf(req.get("body")) orelse "";
    const parsed = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch return jsonError(a, 400, "ERR_AUTH_MALFORMED", "The BRC-104 handshake message is malformed.");
    if (parsed != .object) return jsonError(a, 400, "ERR_AUTH_MALFORMED", "The BRC-104 handshake message is malformed.");
    const o = parsed.object;
    const mt = o.get("messageType") orelse return jsonError(a, 400, "ERR_AUTH_MALFORMED", "no messageType");
    if (mt != .string or !eql(u8, mt.string, "initialRequest")) return jsonError(a, 401, "ERR_AUTH_FAILED", "only initialRequest is answered (no certificates are requested or held)");
    const ik = o.get("identityKey") orelse return jsonError(a, 400, "ERR_AUTH_MALFORMED", "no identityKey");
    if (ik != .string) return jsonError(a, 400, "ERR_AUTH_MALFORMED", "bad identityKey");
    const peer = sk.unhex(a, ik.string) orelse return jsonError(a, 400, "ERR_AUTH_MALFORMED", "bad identityKey");
    if (!sk.isKey(peer)) return jsonError(a, 400, "ERR_AUTH_MALFORMED", "bad identityKey");
    const inj = o.get("initialNonce") orelse return jsonError(a, 400, "ERR_AUTH_MALFORMED", "no initialNonce");
    if (inj != .string or inj.string.len == 0 or inj.string.len > 256) return jsonError(a, 400, "ERR_AUTH_MALFORMED", "bad initialNonce");
    const theirs = inj.string;
    const their_raw = brc.decode64(a, theirs) orelse return jsonError(a, 400, "ERR_AUTH_MALFORMED", "initialNonce is not base64");
    var table = try sessions.Table.load(a);
    const held = try table.all();
    for (held) |s| if (eql(u8, s.peer, peer) and eql(u8, s.theirs, theirs)) return jsonError(a, 401, "ERR_AUTH_FAILED", "Replayed initialRequest nonce.");

    const ours = try brc.createNonce(a);
    const ours_raw = brc.decode64(a, ours).?;
    const data = try std.mem.concat(a, u8, &.{ their_raw, ours_raw });
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ theirs, ours });
    const sig = try brc.createSignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = peer }, data);
    const me = selfIdentity(in) orelse try brc.identityKey(a);
    const me_hex = try sk.hex(a, me);

    var out: std.Io.Writer.Allocating = .init(a);
    const w = &out.writer;
    try w.print("{{\"version\":\"{s}\",\"messageType\":\"initialResponse\",\"identityKey\":\"{s}\",\"initialNonce\":\"{s}\",\"yourNonce\":", .{ brc.VERSION, me_hex, ours });
    try std.json.Stringify.value(theirs, .{}, w);
    try w.writeAll(",\"requestedCertificates\":{\"certifiers\":[],\"types\":{}},\"signature\":[");
    for (sig, 0..) |b, i| try w.print("{s}{d}", .{ if (i > 0) "," else "", b });
    try w.writeAll("]}");

    var r = Resp{ .status = 200, .body = out.written() };
    try r.headers.append(a, .{ .name = "x-bsv-auth-version", .value = brc.VERSION });
    try r.headers.append(a, .{ .name = "x-bsv-auth-message-type", .value = "initialResponse" });
    try r.headers.append(a, .{ .name = "x-bsv-auth-identity-key", .value = me_hex });
    try r.headers.append(a, .{ .name = "x-bsv-auth-nonce", .value = ours });
    try r.headers.append(a, .{ .name = "x-bsv-auth-your-nonce", .value = theirs });
    try r.headers.append(a, .{ .name = "x-bsv-auth-signature", .value = try sk.hex(a, sig) });

    const now = nowOf(in);
    const ttl = ttlOf(in);
    var live: std.ArrayList(sessions.Session) = .empty;
    for (held) |x| {
        if (x.created + ttl < now) try table.remove(x.ours) else try live.append(a, x);
    }
    if (live.items.len >= MAX_SESSIONS) {
        std.mem.sort(sessions.Session, live.items, {}, struct {
            fn lt(_: void, x: sessions.Session, y: sessions.Session) bool {
                return x.created < y.created;
            }
        }.lt);
        for (live.items[0 .. live.items.len - MAX_SESSIONS + 1]) |x| try table.remove(x.ours);
    }
    try table.add(.{ .peer = peer, .ours = ours, .theirs = theirs, .created = now });
    try table.save();
    return r;
}
