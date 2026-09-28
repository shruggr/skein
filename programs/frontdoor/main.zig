//! The front door (#40): the instance as an HTTP server. The host invokes it
//! through the kernel's `call` with the raw request; it runs BRC-103/104
//! (the handshake, and the verification of every signed request) against the
//! session records in the instance's state, matches the path against the
//! routes table, invokes the route's handler (an in-VM call) and signs the
//! answer. Nothing it does on a request is written — a handler that wants a
//! write returns an entry for the host to admit — except the one auth write:
//! a handshake returns a `session` event for the host to admit, which this
//! program, stepped on the reserved box `:sessions`, keeps.
//!
//! Called: fn "http", arg (dag-cbor)
//!   {method, path, route?, query, headers: {name: value}, body: bytes}
//!   path   the path as the client sent it (what a BRC-104 request signs)
//!   route  the path the routes table sees (the host strips `/@<handle>`); default path
//! → {status, headers: {name: value}, body: bytes, admit?: [entry], then?: {program, fn, arg}}
//!   an entry is {mail: <record>, body: bytes} or {event: <record>, box}: the
//!   host puts the records and admits each entry; `then` is a call the host
//!   makes once they are processed (an overlay submit's answer).
//!
//! The routes table (the genesis's `routes`, from etc/routes.json):
//!   [{path | prefix, program: <cid>, fn, auth?: "none", read?: <op>}]
//!   exact paths first, then the longest prefix. `auth` defaults to BRC-104;
//!   "none" is for open routes (an overlay's submit and lookup). `read`
//!   names an op the reads table must allow the caller.
//! The reads table (the genesis's `reads`, from etc/reads.json):
//!   [{caller?: <key>, op}] — no caller: anyone.
//! A handler gets (dag-cbor) {caller?, method, path, route, query, headers,
//! body, contentType, session?: {payload, signature, nonce, yourNonce}} and
//! answers {status, type?, body: bytes, admit?, then?}.
//!
//! Its other function, "explore", is a route handler (explore.zig): the
//! instance's log, threads, heads and records as JSON, behind a read rule.
//!
//! Sessions: the head `sessions` names {kind: "sessions", sessions: [{nonce,
//! session: <cid>}]} (sorted by nonce), each {kind: "session", peer, sessionNonce
//! (ours), peerNonce, created}. A request's session is looked up by its
//! `yourNonce` among them and the `:sessions` events admitted but not yet
//! processed (the call's `pending`), so a handshake answered a moment ago
//! serves the next request. Expiry: `defaults.sessionTtlMs` (a day) from
//! `created`; an unknown or expired session is a plain 401 and the stock
//! client shakes hands again. Replay: a replayed request verifies (nothing
//! remembers nonces: that would be a write per request); a replayed write is
//! the same message record, which the kernel admits once.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const brc = @import("brc104");
const explore = @import("explore.zig");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const SESSIONS_BOX = ":sessions";
const SESSIONS_HEAD = "sessions";
const DEFAULT_TTL_MS: i128 = 24 * 60 * 60 * 1000;

pub fn main() u8 {
    return sk.main("frontdoor", run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "step")) return step(a, in);
    if (!eql(u8, kind, "call")) return sk.report("the front door is called (fn \"http\") or stepped on `:sessions`");
    const func = Value.str(in.get("fn")) orelse "";
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("the argument is not dag-cbor");
    if (eql(u8, func, "http")) return sk.answer(a, try http(a, in, arg));
    if (eql(u8, func, "explore")) {
        const r = try explore.explore(a, in, arg);
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(r.status));
        try m.put("type", cbor.string("application/json"));
        try m.put("body", .{ .bytes = r.body });
        return sk.answer(a, m.value());
    }
    return sk.report("unknown fn (the front door answers \"http\" and the route handler \"explore\")");
}

// ---------------------------------------------------------------- responses

const Resp = struct {
    status: u64,
    type: []const u8 = "application/json",
    body: []const u8,
    headers: std.ArrayList(brc.Header) = .empty,
    admit: ?Value = null,
    then: ?Value = null,

    fn value(r: *Resp, a: Allocator) !Value {
        var h = cbor.MapBuilder.init(a);
        try h.put("content-type", cbor.string(r.type));
        for (r.headers.items) |x| try h.put(x.name, cbor.string(x.value));
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(r.status));
        try m.put("headers", h.value());
        try m.put("body", .{ .bytes = r.body });
        try m.put("admit", r.admit);
        try m.put("then", r.then);
        return m.value();
    }
};

fn jsonError(a: Allocator, status: u64, code: []const u8, description: []const u8) !Resp {
    var out: std.Io.Writer.Allocating = .init(a);
    try std.json.Stringify.value(.{ .status = "error", .code = code, .description = description }, .{}, &out.writer);
    return .{ .status = status, .body = out.written() };
}

// ---------------------------------------------------------------- the request

fn http(a: Allocator, in: Value, req: Value) !Value {
    const path = Value.str(req.get("path")) orelse "/";
    const route = Value.str(req.get("route")) orelse path;
    const method = Value.str(req.get("method")) orelse "GET";
    var resp: Resp = undefined;
    if (eql(u8, route, brc.WELL_KNOWN)) {
        resp = if (eql(u8, method, "POST")) try handshake(a, in, req) else try jsonError(a, 405, "ERR_METHOD", "POST the BRC-103 handshake here");
        return resp.value(a);
    }
    const r = findRoute(in, route) orelse {
        resp = try jsonError(a, 404, "ERR_NOT_FOUND", "no route for this path");
        return resp.value(a);
    };
    if (eql(u8, Value.str(r.get("auth")) orelse "", "none")) {
        resp = try invoke(a, r, req, null, null);
        return resp.value(a);
    }
    // BRC-104: a general message.
    const headers = req.get("headers");
    const request_id = brc.headerOf(headers, "x-bsv-auth-request-id") orelse {
        resp = .{ .status = 401, .body = "{\"status\":\"error\",\"code\":\"UNAUTHORIZED\",\"message\":\"Mutual-authentication failed!\"}" };
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
    if (Value.str(r.get("read"))) |op| if (!mayRead(in, v.peer, op)) {
        resp = try jsonError(a, 403, "ERR_FORBIDDEN", "this identity may not read here");
        try sign(a, in, &resp, v, request_id);
        return resp.value(a);
    };
    resp = try invoke(a, r, req, v.peer, v.proof);
    try sign(a, in, &resp, v, request_id);
    return resp.value(a);
}

fn selfIdentity(in: Value) ?[]const u8 {
    const s = in.get("self") orelse return null;
    return Value.bytesOf(s.get("identity"));
}

var why: []const u8 = "";

fn unauthorized(msg: []const u8) error{Unauthorized} {
    why = msg;
    return error.Unauthorized;
}

// ---------------------------------------------------------------- routes and reads

fn findRoute(in: Value, route: []const u8) ?Value {
    const rs = in.get("routes") orelse return null;
    if (rs != .array) return null;
    for (rs.array) |r| if (Value.str(r.get("path"))) |p| if (eql(u8, p, route)) return r;
    var best: ?Value = null;
    var best_len: usize = 0;
    for (rs.array) |r| if (Value.str(r.get("prefix"))) |p| {
        if (std.mem.startsWith(u8, route, p) and p.len >= best_len) {
            best = r;
            best_len = p.len;
        }
    };
    return best;
}

fn mayRead(in: Value, caller: []const u8, op: []const u8) bool {
    const rs = in.get("reads") orelse return false;
    if (rs != .array) return false;
    for (rs.array) |r| {
        if (!eql(u8, Value.str(r.get("op")) orelse "", op) and !eql(u8, Value.str(r.get("op")) orelse "", "*")) continue;
        const who = Value.bytesOf(r.get("caller")) orelse return true;
        if (eql(u8, who, caller)) return true;
    }
    return false;
}

/// The route's handler, an in-VM call; its failure is a 500 with its message.
fn invoke(a: Allocator, r: Value, req: Value, caller: ?[]const u8, proof: ?Value) !Resp {
    const prog = Value.cidOf(r.get("program")) orelse return jsonError(a, 500, "ERR_ROUTE", "the route names no program");
    const func = Value.str(r.get("fn")) orelse return jsonError(a, 500, "ERR_ROUTE", "the route names no fn");
    var h = cbor.MapBuilder.init(a);
    if (caller) |c| try h.put("caller", .{ .bytes = c });
    for ([_][]const u8{ "method", "path", "query", "headers", "body" }) |k| try h.put(k, req.get(k));
    try h.put("route", cbor.string(Value.str(req.get("route")) orelse Value.str(req.get("path")) orelse "/"));
    const ct = brc.headerOf(req.get("headers"), "content-type") orelse "";
    try h.put("contentType", cbor.string(std.mem.trim(u8, ct[0 .. std.mem.indexOfScalar(u8, ct, ';') orelse ct.len], " ")));
    try h.put("session", proof);
    const out = sk.callValue(a, prog, func, h.value()) catch |err| {
        if (err == error.ImportFailed) return jsonError(a, 500, "ERR_INTERNAL", sk.lastError());
        return err;
    };
    return .{
        .status = @intCast(Value.intOf(out.get("status")) orelse 200),
        .type = Value.str(out.get("type")) orelse "application/json",
        .body = Value.bytesOf(out.get("body")) orelse "",
        .admit = out.get("admit"),
        .then = out.get("then"),
    };
}

// ---------------------------------------------------------------- sessions

const Session = struct { peer: []const u8, ours: []const u8, theirs: []const u8, created: i128 };

fn ttlOf(in: Value) i128 {
    const d = in.get("defaults") orelse return DEFAULT_TTL_MS;
    const t = Value.str(d.get("sessionTtlMs")) orelse return DEFAULT_TTL_MS;
    return std.fmt.parseInt(i128, t, 10) catch DEFAULT_TTL_MS;
}

fn sessionOf(v: Value) ?Session {
    if (!eql(u8, Value.str(v.get("kind")) orelse "", "session")) return null;
    return .{
        .peer = Value.bytesOf(v.get("peer")) orelse return null,
        .ours = Value.str(v.get("sessionNonce")) orelse return null,
        .theirs = Value.str(v.get("peerNonce")) orelse return null,
        .created = Value.intOf(v.get("created")) orelse 0,
    };
}

/// The sessions in state and those admitted and not yet processed, in no order.
fn sessions(a: Allocator, in: Value) ![]Session {
    var out: std.ArrayList(Session) = .empty;
    if (try sk.head(a, SESSIONS_HEAD)) |root| {
        const r = try sk.get(a, root);
        if (r.get("sessions")) |ss| if (ss == .array) for (ss.array) |x| {
            const c = Value.cidOf(x.get("session")) orelse continue;
            if (sessionOf(try sk.get(a, c))) |s| try out.append(a, s);
        };
    }
    if (in.get("pending")) |p| if (p == .array) for (p.array) |x| {
        const c = Value.cidOf(x) orelse continue;
        const e = try sk.get(a, c);
        if (!eql(u8, Value.str(e.get("box")) orelse "", SESSIONS_BOX)) continue;
        const ev = Value.cidOf(e.get("event")) orelse continue;
        if (sessionOf(try sk.get(a, ev))) |s| try out.append(a, s);
    };
    return out.items;
}

const Verified = struct { peer: []const u8, session: Session, proof: Value };

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
    const now = Value.intOf(in.get("now")) orelse 0;
    const ttl = ttlOf(in);
    var found: ?Session = null;
    for (try sessions(a, in)) |s| if (eql(u8, s.ours, your)) {
        found = s;
    };
    const s = found orelse return unauthorized("Session not found for nonce (expired or unknown)");
    if (s.created + ttl < now) return unauthorized("Session expired");
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
    return .{ .peer = peer, .session = s, .proof = p.value() };
}

/// Sign the response on the session (not recorded: a call).
fn sign(a: Allocator, in: Value, r: *Resp, v: Verified, request_id: []const u8) !void {
    const rid = brc.decode64(a, request_id) orelse return error.Malformed;
    const payload = try brc.responsePayload(a, rid, r.status, &.{}, r.body);
    const nonce = try brc.random64(a);
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, v.session.theirs });
    const sig = try brc.createSignature(a, brc.AUTH_PROTOCOL, key_id, .{ .other = v.peer }, payload);
    const me = selfIdentity(in) orelse try brc.identityKey(a);
    try r.headers.append(a, .{ .name = "x-bsv-auth-version", .value = brc.VERSION });
    try r.headers.append(a, .{ .name = "x-bsv-auth-identity-key", .value = try sk.hex(a, me) });
    try r.headers.append(a, .{ .name = "x-bsv-auth-nonce", .value = nonce });
    try r.headers.append(a, .{ .name = "x-bsv-auth-your-nonce", .value = v.session.theirs });
    try r.headers.append(a, .{ .name = "x-bsv-auth-signature", .value = try sk.hex(a, sig) });
    try r.headers.append(a, .{ .name = "x-bsv-auth-request-id", .value = request_id });
}

/// BRC-103 initialRequest → initialResponse: our nonce, our signature over
/// both nonces, and the session for the host to admit.
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
    for (try sessions(a, in)) |s| if (eql(u8, s.peer, peer) and eql(u8, s.theirs, theirs)) return jsonError(a, 401, "ERR_AUTH_FAILED", "Replayed initialRequest nonce.");

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

    var s = cbor.MapBuilder.init(a);
    try s.put("kind", cbor.string("session"));
    try s.put("peer", .{ .bytes = peer });
    try s.put("sessionNonce", cbor.string(ours));
    try s.put("peerNonce", cbor.string(theirs));
    try s.put("created", cbor.int(Value.intOf(in.get("now")) orelse 0));
    var e = cbor.MapBuilder.init(a);
    try e.put("event", s.value());
    try e.put("box", cbor.string(SESSIONS_BOX));
    const list = try a.alloc(Value, 1);
    list[0] = e.value();
    r.admit = .{ .array = list };
    return r;
}

// ---------------------------------------------------------------- the one write: a session, kept

fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const ev = Value.cidOf(args.get("event")) orelse return sk.report("the front door is stepped only on `:sessions` events");
    const rec = try sk.get(a, ev);
    const new = sessionOf(rec) orelse return sk.report("not a session record");
    const at = Value.intOf(in.get("at")) orelse 0;
    const ttl = ttlOf(in);
    var list: std.ArrayList(Value) = .empty;
    if (try sk.head(a, SESSIONS_HEAD)) |root| {
        const r = try sk.get(a, root);
        if (r.get("sessions")) |ss| if (ss == .array) for (ss.array) |x| {
            const c = Value.cidOf(x.get("session")) orelse continue;
            const s = sessionOf(try sk.get(a, c)) orelse continue;
            if (s.created + ttl < at) continue; // expired: dropped
            if (eql(u8, s.ours, new.ours)) return; // already kept
            try list.append(a, x);
        };
    }
    var e = cbor.MapBuilder.init(a);
    try e.put("nonce", cbor.string(new.ours));
    try e.put("session", cbor.cidv(ev));
    try list.append(a, e.value());
    std.mem.sort(Value, list.items, {}, struct {
        fn lt(_: void, x: Value, y: Value) bool {
            return std.mem.order(u8, Value.str(x.get("nonce")) orelse "", Value.str(y.get("nonce")) orelse "") == .lt;
        }
    }.lt);
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("sessions"));
    try root.put("sessions", .{ .array = list.items });
    try sk.advance(SESSIONS_HEAD, try sk.put(a, root.value()));
}
