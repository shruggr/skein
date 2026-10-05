// authfetch (#126): the kernel's BRC-103/104 client. A program's step asks
// `authfetch` — {url: <a server's base URL>, method?, path?, headers?, body?,
// timeoutMs?} → {status, headers, body} — and the kernel does the rest: the
// session with that server (BRC-103's handshake at <url>/.well-known/auth,
// kept in memory per base URL and made again when the server forgets it), the
// request signed BRC-104's way through the signer, the answer's signature
// checked through the signer. The runtime only moves bytes (Env.http: one
// HTTP exchange). It is the one direct HTTP path a program has: the request
// out is signed by the instance's key and the answer in by the server's, and
// the whole exchange is a recorded call on the step (the scheduler's
// `authfetch` record: the request, the answer or the failure, and every
// signer call it made), which replay serves from the witness.
//
// The framing is @bsv/sdk's SimplifiedFetchTransport's (as the front door's
// server side, skein-sdk's lib/brc104.zig): a stock BRC-104 server takes it.
const std = @import("std");
const cbor = @import("cbor");
const secp = @import("secp");
const signer = @import("signer.zig");
const Value = cbor.Value;

pub const AUTH_PROTOCOL = "auth message signature";
pub const NONCE_PROTOCOL = "server hmac";
pub const WELL_KNOWN = "/.well-known/auth";
pub const VERSION = "0.1";

const b64 = std.base64.standard;

pub const Header = struct { name: []const u8, value: []const u8 };

/// One HTTP exchange, as the runtime carries it.
pub const HttpRequest = struct { method: []const u8, url: []const u8, headers: []const Header, body: []const u8, timeout_ms: ?i64 = null };
pub const HttpAnswer = struct { status: i64, headers: []const Header, body: []const u8 };
/// The runtime's answer: the response, or why there is none (no answer at all).
pub const HttpResult = union(enum) { ok: HttpAnswer, failed: []const u8 };

/// A session with a server: its identity, our nonce, its nonce (base64 text, as on the wire).
pub const Session = struct { server: []const u8, ours: []const u8, theirs: []const u8 };

/// The sessions, per server base URL, in memory: lost with the process, made again when needed.
pub const Sessions = struct {
    gpa: std.mem.Allocator,
    map: std.StringHashMapUnmanaged(Session) = .empty,

    pub fn init(gpa: std.mem.Allocator) Sessions {
        return .{ .gpa = gpa };
    }

    pub fn get(s: *Sessions, base: []const u8) ?Session {
        return s.map.get(base);
    }

    pub fn put(s: *Sessions, base: []const u8, x: Session) !void {
        s.drop(base);
        const k = try s.gpa.dupe(u8, base);
        errdefer s.gpa.free(k);
        try s.map.put(s.gpa, k, .{ .server = try s.gpa.dupe(u8, x.server), .ours = try s.gpa.dupe(u8, x.ours), .theirs = try s.gpa.dupe(u8, x.theirs) });
    }

    pub fn drop(s: *Sessions, base: []const u8) void {
        if (s.map.fetchRemove(base)) |kv| {
            s.gpa.free(kv.key);
            s.gpa.free(kv.value.server);
            s.gpa.free(kv.value.ours);
            s.gpa.free(kv.value.theirs);
        }
    }

    pub fn deinit(s: *Sessions) void {
        var it = s.map.iterator();
        while (it.next()) |kv| {
            s.gpa.free(kv.key_ptr.*);
            s.gpa.free(kv.value_ptr.server);
            s.gpa.free(kv.value_ptr.ours);
            s.gpa.free(kv.value_ptr.theirs);
        }
        s.map.deinit(s.gpa);
    }
};

/// What authfetch needs of the kernel: the instance's identity, the signer (a
/// BRC-100 wire frame → its answer frame), the runtime's HTTP (bytes only),
/// and real randomness (nonces and request ids no one can guess).
pub const Env = struct {
    ctx: *anyopaque,
    identity: []const u8,
    wallet: *const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8,
    http: *const fn (ctx: *anyopaque, a: std.mem.Allocator, req: HttpRequest) anyerror!HttpResult,
    random: *const fn (ctx: *anyopaque, out: []u8) void,
};

/// The import's request: {url, method?, path?, headers?: {name: text}, body?: bytes, timeoutMs?}.
pub const Request = struct { base: []const u8, method: []const u8, path: []const u8, query: []const u8, headers: []const Header, body: []const u8, timeout_ms: ?i64 };

/// The answer the import returns, or why there is none ("transient: …" when no answer came).
pub const Outcome = union(enum) { answer: HttpAnswer, failed: []const u8 };

pub const want = "authfetch: want {url: <the server's base URL>, method?, path?, headers?: {name: text}, body?: bytes, timeoutMs?}";

/// The request as the import takes it, or why it is not one.
pub fn parse(a: std.mem.Allocator, bytes: []const u8) !union(enum) { ok: Request, bad: []const u8 } {
    const v = cbor.decode(a, bytes) catch return .{ .bad = "authfetch: the request is not dag-cbor" };
    if (v != .map) return .{ .bad = want };
    const url = Value.str(v.get("url")) orelse return .{ .bad = want };
    if (originOf(url) == null) return .{ .bad = "authfetch: the url is not http(s)://host[:port][/path]" };
    if (std.mem.indexOfAny(u8, url, "?#") != null) return .{ .bad = "authfetch: the url is a base: no query, no fragment (the query goes in `path`)" };
    const method = Value.str(v.get("method")) orelse "POST";
    if (method.len == 0) return .{ .bad = "authfetch: an empty method" };
    var path = Value.str(v.get("path")) orelse "/";
    if (path.len == 0) path = "/";
    if (path[0] != '/') return .{ .bad = "authfetch: `path` starts with /" };
    var query: []const u8 = "";
    if (std.mem.indexOfScalar(u8, path, '?')) |q| {
        query = path[q..];
        path = path[0..q];
    }
    var hs = std.array_list.Managed(Header).init(a);
    if (v.get("headers")) |h| if (h != .null) {
        if (h != .map) return .{ .bad = "authfetch: headers: want {name: text}" };
        for (h.map) |e| {
            const val = Value.str(e.value) orelse return .{ .bad = "authfetch: headers: want {name: text}" };
            const name = try std.ascii.allocLowerString(a, e.key);
            if (std.mem.startsWith(u8, name, "x-bsv-auth")) return .{ .bad = "authfetch: the x-bsv-auth headers are the kernel's" };
            try hs.append(.{ .name = name, .value = val });
        }
    };
    var body: []const u8 = "";
    if (v.get("body")) |b| if (b != .null) {
        body = Value.bytesOf(b) orelse return .{ .bad = "authfetch: body: want bytes" };
    };
    var timeout: ?i64 = null;
    if (v.get("timeoutMs")) |t| if (t != .null) {
        const n = Value.intOf(t) orelse return .{ .bad = "authfetch: timeoutMs: want an integer" };
        if (n <= 0 or n > 600_000) return .{ .bad = "authfetch: timeoutMs: 1 to 600000" };
        timeout = @intCast(n);
    };
    return .{ .ok = .{ .base = std.mem.trimEnd(u8, url, "/"), .method = method, .path = path, .query = query, .headers = hs.items, .body = body, .timeout_ms = timeout } };
}

/// scheme://host[:port] of a URL, or null if it is not http(s).
pub fn originOf(url: []const u8) ?[]const u8 {
    const rest = if (std.mem.startsWith(u8, url, "https://")) url[8..] else if (std.mem.startsWith(u8, url, "http://")) url[7..] else return null;
    const end = std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len;
    if (end == 0) return null;
    return url[0 .. url.len - rest.len + end];
}

/// The path part of a base URL ("" for none).
fn basePath(base: []const u8) []const u8 {
    const o = originOf(base) orelse return "";
    return base[o.len..];
}

/// One authfetch: the session (made if there is none), the signed request, the checked answer.
pub fn run(a: std.mem.Allocator, env: Env, sessions: *Sessions, req: Request) !Outcome {
    var again = false;
    while (true) {
        const held = sessions.get(req.base);
        const s = held orelse switch (try handshake(a, env, req)) {
            .ok => |x| blk: {
                try sessions.put(req.base, x);
                break :blk x;
            },
            .failed => |why| return .{ .failed = why },
        };
        const r = try send(a, env, s, req);
        switch (r) {
            .failed => return r,
            .answer => |ans| {
                // The server forgot the session (expired, restarted): shake hands again, once.
                if (ans.status == 401 and held != null and !again) {
                    sessions.drop(req.base);
                    again = true;
                    continue;
                }
                return r;
            },
        }
    }
}

fn transient(status: i64) bool {
    return status >= 500 or status == 408 or status == 425 or status == 429;
}

/// The payload of a successful answer frame, or null for a wallet error.
fn ok(frame: []const u8) ?[]const u8 {
    if (frame.len == 0 or frame[0] != 0) return null;
    return frame[1..];
}

/// BRC-103: our nonce to <base>/.well-known/auth; its answer's signature over both nonces checked.
fn handshake(a: std.mem.Allocator, env: Env, req: Request) !union(enum) { ok: Session, failed: []const u8 } {
    const ours = try createNonce(a, env);
    const url = try std.fmt.allocPrint(a, "{s}{s}", .{ req.base, WELL_KNOWN });
    const body = try std.fmt.allocPrint(a, "{{\"version\":\"{s}\",\"messageType\":\"initialRequest\",\"identityKey\":\"{s}\",\"initialNonce\":\"{s}\",\"requestedCertificates\":{{\"certifiers\":[],\"types\":{{}}}}}}", .{ VERSION, std.fmt.bytesToHex(env.identity[0..33].*, .lower), ours });
    const hs = [_]Header{.{ .name = "content-type", .value = "application/json" }};
    const r = switch (try env.http(env.ctx, a, .{ .method = "POST", .url = url, .headers = &hs, .body = body, .timeout_ms = req.timeout_ms })) {
        .ok => |x| x,
        .failed => |why| return .{ .failed = try std.fmt.allocPrint(a, "transient: handshake with {s}: {s}", .{ req.base, why }) },
    };
    if (r.status != 200) return .{ .failed = try std.fmt.allocPrint(a, "{s}handshake with {s}: HTTP {d}", .{ if (transient(r.status)) "transient: " else "", req.base, r.status }) };
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, r.body, .{}) catch return .{ .failed = "authfetch: handshake: the answer is not JSON" };
    if (j != .object) return .{ .failed = "authfetch: handshake: the answer is not an object" };
    const o = j.object;
    const ik = o.get("identityKey") orelse return .{ .failed = "authfetch: handshake: no identityKey" };
    if (ik != .string or ik.string.len != 66) return .{ .failed = "authfetch: handshake: bad identityKey" };
    const server = try a.alloc(u8, 33);
    _ = std.fmt.hexToBytes(server, ik.string) catch return .{ .failed = "authfetch: handshake: bad identityKey" };
    if (!secp.isKey(server)) return .{ .failed = "authfetch: handshake: bad identityKey" };
    const tv = o.get("initialNonce") orelse return .{ .failed = "authfetch: handshake: no initialNonce" };
    if (tv != .string) return .{ .failed = "authfetch: handshake: bad initialNonce" };
    const theirs = tv.string;
    const yours = o.get("yourNonce") orelse return .{ .failed = "authfetch: handshake: no yourNonce" };
    if (yours != .string or !std.mem.eql(u8, yours.string, ours)) return .{ .failed = "authfetch: handshake: the answer is not to our nonce" };
    const sv = o.get("signature") orelse return .{ .failed = "authfetch: handshake: no signature" };
    if (sv != .array) return .{ .failed = "authfetch: handshake: bad signature" };
    const sig = try a.alloc(u8, sv.array.items.len);
    for (sv.array.items, 0..) |x, i| {
        if (x != .integer or x.integer < 0 or x.integer > 255) return .{ .failed = "authfetch: handshake: bad signature" };
        sig[i] = @intCast(x.integer);
    }
    const on = decode64(a, ours) orelse return .{ .failed = "authfetch: handshake: our nonce is not base64" };
    const tn = decode64(a, theirs) orelse return .{ .failed = "authfetch: handshake: initialNonce is not base64" };
    const data = try std.mem.concat(a, u8, &.{ on, tn });
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ ours, theirs });
    if (!try verify(a, env, AUTH_PROTOCOL, key_id, server, data, sig)) return .{ .failed = try std.fmt.allocPrint(a, "authfetch: handshake: {s}'s signature does not verify", .{req.base}) };
    return .{ .ok = .{ .server = server, .ours = ours, .theirs = try a.dupe(u8, theirs) } };
}

/// BRC-104: the request signed on the session; the answer's signature checked.
fn send(a: std.mem.Allocator, env: Env, s: Session, req: Request) !Outcome {
    var rid: [32]u8 = undefined;
    env.random(env.ctx, &rid);
    const rid64 = try encode64(a, &rid);
    var nb: [32]u8 = undefined;
    env.random(env.ctx, &nb);
    const nonce = try encode64(a, &nb);
    const path = try std.fmt.allocPrint(a, "{s}{s}", .{ basePath(req.base), req.path });
    const payload = try requestPayload(a, &rid, req.method, path, req.query, req.headers, req.body);
    const sig = try sign(a, env, AUTH_PROTOCOL, try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, s.theirs }), s.server, payload);
    var hs = std.array_list.Managed(Header).init(a);
    try hs.appendSlice(req.headers);
    try hs.appendSlice(&.{
        .{ .name = "x-bsv-auth-version", .value = VERSION },
        .{ .name = "x-bsv-auth-identity-key", .value = try hexOf(a, env.identity) },
        .{ .name = "x-bsv-auth-nonce", .value = nonce },
        .{ .name = "x-bsv-auth-your-nonce", .value = s.theirs },
        .{ .name = "x-bsv-auth-signature", .value = try hexOf(a, sig) },
        .{ .name = "x-bsv-auth-request-id", .value = rid64 },
    });
    const url = try std.fmt.allocPrint(a, "{s}{s}{s}", .{ originOf(req.base).?, path, req.query });
    const r = switch (try env.http(env.ctx, a, .{ .method = req.method, .url = url, .headers = hs.items, .body = req.body, .timeout_ms = req.timeout_ms })) {
        .ok => |x| x,
        .failed => |why| return .{ .failed = try std.fmt.allocPrint(a, "transient: {s}: {s}", .{ url, why }) },
    };
    // The answer: signed on the session, by the server's key. A failure from something in front
    // of it (a proxy's 4xx/5xx) may come unsigned; a success must be signed.
    const sh = headerOf(r.headers, "x-bsv-auth-signature") orelse {
        if (r.status >= 200 and r.status < 300) return .{ .failed = try std.fmt.allocPrint(a, "authfetch: {s}: the answer is not signed", .{url}) };
        return .{ .answer = r };
    };
    const from = unhex(a, headerOf(r.headers, "x-bsv-auth-identity-key") orelse "") orelse "";
    if (!std.mem.eql(u8, from, s.server)) return .{ .failed = try std.fmt.allocPrint(a, "authfetch: {s}: the answer is from another identity than the session's", .{url}) };
    var signed = std.array_list.Managed(Header).init(a);
    for (r.headers) |h| {
        const k = try std.ascii.allocLowerString(a, h.name);
        if ((std.mem.startsWith(u8, k, "x-bsv-") and !std.mem.startsWith(u8, k, "x-bsv-auth")) or std.mem.eql(u8, k, "authorization")) try signed.append(.{ .name = k, .value = h.value });
    }
    std.mem.sort(Header, signed.items, {}, lessHeader);
    const rp = try responsePayload(a, &rid, @intCast(@max(0, r.status)), signed.items, r.body);
    const rn = headerOf(r.headers, "x-bsv-auth-nonce") orelse "";
    const rsig = unhex(a, sh) orelse return .{ .failed = try std.fmt.allocPrint(a, "authfetch: {s}: the answer's signature is not hex", .{url}) };
    if (!try verify(a, env, AUTH_PROTOCOL, try std.fmt.allocPrint(a, "{s} {s}", .{ rn, s.ours }), s.server, rp, rsig)) return .{ .failed = try std.fmt.allocPrint(a, "authfetch: {s}: the answer's signature does not verify", .{url}) };
    return .{ .answer = r };
}

// ---------------------------------------------------------------- the signer's frames

/// A session nonce (BRC-104 createNonce): 16 random bytes — printable ASCII,
/// so the SDK's keyID (the bytes read as UTF-8) is the same string on every
/// side — and their HMAC under [2, "server hmac"], counterparty self; base64
/// of the 48 bytes.
fn createNonce(a: std.mem.Allocator, env: Env) ![]const u8 {
    var first: [16]u8 = undefined;
    env.random(env.ctx, &first);
    for (&first) |*b| b.* = 33 + b.* % 94;
    const res = try env.wallet(env.ctx, a, try signer.createHmacFrame(a, NONCE_PROTOCOL, &first, .self, &first));
    const mac = ok(res) orelse return error.SignerHmac;
    if (mac.len != 32) return error.SignerHmac;
    var raw: [48]u8 = undefined;
    @memcpy(raw[0..16], &first);
    @memcpy(raw[16..], mac);
    return encode64(a, &raw);
}

fn sign(a: std.mem.Allocator, env: Env, protocol: []const u8, key_id: []const u8, server: []const u8, data: []const u8) ![]const u8 {
    const res = try env.wallet(env.ctx, a, try signer.createSignatureFrame(a, protocol, key_id, .{ .other = server }, data));
    return signer.signatureOf(res) orelse error.SignerSignature;
}

fn verify(a: std.mem.Allocator, env: Env, protocol: []const u8, key_id: []const u8, server: []const u8, data: []const u8, sig: []const u8) !bool {
    const res = try env.wallet(env.ctx, a, try signer.verifySignatureFrame(a, protocol, key_id, .{ .other = server }, data, sig));
    return ok(res) != null;
}

// ---------------------------------------------------------------- the HTTP framing (SimplifiedFetchTransport)

fn varint(w: *std.array_list.Managed(u8), v: u64) !void {
    if (v < 0xfd) {
        try w.append(@intCast(v));
    } else if (v <= 0xffff) {
        try w.append(0xfd);
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, @intCast(v), .little);
        try w.appendSlice(&b);
    } else if (v <= 0xffff_ffff) {
        try w.append(0xfe);
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @intCast(v), .little);
        try w.appendSlice(&b);
    } else {
        try w.append(0xff);
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, v, .little);
        try w.appendSlice(&b);
    }
}

fn writeField(w: *std.array_list.Managed(u8), s: []const u8) !void {
    if (s.len == 0) return varint(w, std.math.maxInt(u64)); // -1: absent
    try varint(w, s.len);
    try w.appendSlice(s);
}

fn lessHeader(_: void, x: Header, y: Header) bool {
    return std.mem.order(u8, x.name, y.name) == .lt;
}

/// The headers a request signs: x-bsv-* (not x-bsv-auth*), content-type (its media type only) and authorization; lower-cased, sorted.
fn signedRequestHeaders(a: std.mem.Allocator, headers: []const Header) ![]Header {
    var out = std.array_list.Managed(Header).init(a);
    for (headers) |h| {
        const k = try std.ascii.allocLowerString(a, h.name);
        var v = h.value;
        if (std.mem.eql(u8, k, "content-type")) v = std.mem.trim(u8, v[0 .. std.mem.indexOfScalar(u8, v, ';') orelse v.len], " ");
        if ((std.mem.startsWith(u8, k, "x-bsv-") or std.mem.eql(u8, k, "content-type") or std.mem.eql(u8, k, "authorization")) and !std.mem.startsWith(u8, k, "x-bsv-auth")) try out.append(.{ .name = k, .value = v });
    }
    std.mem.sort(Header, out.items, {}, lessHeader);
    return out.items;
}

/// The payload a request signs: requestId (32 bytes), method, path, query, the signed headers, the body.
pub fn requestPayload(a: std.mem.Allocator, request_id: []const u8, method: []const u8, path: []const u8, query: []const u8, headers: []const Header, body: []const u8) ![]u8 {
    var w = std.array_list.Managed(u8).init(a);
    try w.appendSlice(request_id);
    try varint(&w, method.len);
    try w.appendSlice(method);
    try writeField(&w, path);
    try writeField(&w, query);
    const signed = try signedRequestHeaders(a, headers);
    try varint(&w, signed.len);
    for (signed) |h| {
        try varint(&w, h.name.len);
        try w.appendSlice(h.name);
        try varint(&w, h.value.len);
        try w.appendSlice(h.value);
    }
    try writeField(&w, body);
    return w.toOwnedSlice();
}

/// The payload a response signs: requestId, status, the signed headers, the body.
pub fn responsePayload(a: std.mem.Allocator, request_id: []const u8, status: u64, headers: []const Header, body: []const u8) ![]u8 {
    var w = std.array_list.Managed(u8).init(a);
    try w.appendSlice(request_id);
    try varint(&w, status);
    try varint(&w, headers.len);
    for (headers) |h| {
        try varint(&w, h.name.len);
        try w.appendSlice(h.name);
        try varint(&w, h.value.len);
        try w.appendSlice(h.value);
    }
    try writeField(&w, body);
    return w.toOwnedSlice();
}

pub fn headerOf(hs: []const Header, name: []const u8) ?[]const u8 {
    for (hs) |h| if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
    return null;
}

fn encode64(a: std.mem.Allocator, b: []const u8) ![]const u8 {
    const out = try a.alloc(u8, b64.Encoder.calcSize(b.len));
    return b64.Encoder.encode(out, b);
}

fn decode64(a: std.mem.Allocator, s: []const u8) ?[]u8 {
    const n = b64.Decoder.calcSizeForSlice(s) catch return null;
    const out = a.alloc(u8, n) catch return null;
    b64.Decoder.decode(out, s) catch return null;
    return out;
}

fn hexOf(a: std.mem.Allocator, b: []const u8) ![]const u8 {
    const out = try a.alloc(u8, b.len * 2);
    const digits = "0123456789abcdef";
    for (b, 0..) |x, i| {
        out[2 * i] = digits[x >> 4];
        out[2 * i + 1] = digits[x & 15];
    }
    return out;
}

fn unhex(a: std.mem.Allocator, s: []const u8) ?[]u8 {
    if (s.len % 2 != 0) return null;
    const out = a.alloc(u8, s.len / 2) catch return null;
    _ = std.fmt.hexToBytes(out, s) catch return null;
    return out;
}

// ---------------------------------------------------------------- the import's answer as dag-cbor

/// {status, headers: {name: value}, body: bytes}.
pub fn answerValue(a: std.mem.Allocator, r: HttpAnswer) !Value {
    var h = cbor.MapBuilder.init(a);
    for (r.headers) |x| try h.put(try std.ascii.allocLowerString(a, x.name), cbor.string(x.value));
    var m = cbor.MapBuilder.init(a);
    try m.put("status", cbor.int(r.status));
    try m.put("headers", h.value());
    try m.put("body", .{ .bytes = r.body });
    return m.value();
}

/// One exchange as the runtime is asked for it (serve's and the page's `http`
/// request): {method, url, headers: {name: value}, body: bytes, timeoutMs?}.
pub fn httpRequestValue(a: std.mem.Allocator, r: HttpRequest) !Value {
    var h = cbor.MapBuilder.init(a);
    for (r.headers) |x| try h.put(x.name, cbor.string(x.value));
    var m = cbor.MapBuilder.init(a);
    try m.put("method", cbor.string(r.method));
    try m.put("url", cbor.string(r.url));
    try m.put("headers", h.value());
    try m.put("body", .{ .bytes = r.body });
    if (r.timeout_ms) |t| try m.put("timeoutMs", cbor.int(t));
    return m.value();
}

/// The runtime's answer to `http`: {status, headers: {name: value}, body: bytes} | {error}.
pub fn httpResultOf(a: std.mem.Allocator, v: Value) !HttpResult {
    if (Value.str(v.get("error"))) |e| return .{ .failed = e };
    const status = Value.intOf(v.get("status")) orelse return .{ .failed = "the runtime's answer has no status" };
    return .{ .ok = .{ .status = @intCast(status), .headers = try headerList(a, v.get("headers")), .body = Value.bytesOf(v.get("body")) orelse "" } };
}

/// A header map ({name: text}) as a list.
pub fn headerList(a: std.mem.Allocator, v: ?Value) ![]Header {
    const m = v orelse return &.{};
    if (m != .map) return &.{};
    var out = std.array_list.Managed(Header).init(a);
    for (m.map) |e| if (Value.str(e.value)) |s| try out.append(.{ .name = e.key, .value = s });
    return out.items;
}

test "authfetch: the request payload is SimplifiedFetchTransport's (lower-cased signed headers, sorted; an absent field is -1)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rid = [_]u8{7} ** 32;
    const p = try requestPayload(a, &rid, "POST", "/a/sendMessage", "", &.{
        .{ .name = "Content-Type", .value = "application/cbor; charset=x" },
        .{ .name = "x-bsv-topic", .value = "t" },
        .{ .name = "x-bsv-auth-nonce", .value = "skipped" },
        .{ .name = "accept", .value = "skipped" },
    }, "hi");
    var want_ = std.array_list.Managed(u8).init(a);
    try want_.appendSlice(&rid);
    try want_.appendSlice(&.{4});
    try want_.appendSlice("POST");
    try want_.appendSlice(&.{14});
    try want_.appendSlice("/a/sendMessage");
    try want_.appendSlice(&.{ 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }); // no query: -1
    try want_.appendSlice(&.{2});
    try want_.appendSlice(&.{12});
    try want_.appendSlice("content-type");
    try want_.appendSlice(&.{16});
    try want_.appendSlice("application/cbor");
    try want_.appendSlice(&.{11});
    try want_.appendSlice("x-bsv-topic");
    try want_.appendSlice(&.{1});
    try want_.appendSlice("t");
    try want_.appendSlice(&.{2});
    try want_.appendSlice("hi");
    try std.testing.expectEqualSlices(u8, want_.items, p);
}

test "authfetch: the import's request — a base URL, a path with its query, headers lower-cased, no x-bsv-auth headers" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var h = cbor.MapBuilder.init(a);
    try h.put("Content-Type", cbor.string("application/cbor"));
    var m = cbor.MapBuilder.init(a);
    try m.put("url", cbor.string("http://h.test:8100/@bob/"));
    try m.put("path", cbor.string("/sendMessage?x=1"));
    try m.put("headers", h.value());
    try m.put("body", .{ .bytes = "b" });
    const r = (try parse(a, try cbor.encode(a, m.value()))).ok;
    try std.testing.expectEqualStrings("http://h.test:8100/@bob", r.base);
    try std.testing.expectEqualStrings("POST", r.method);
    try std.testing.expectEqualStrings("/sendMessage", r.path);
    try std.testing.expectEqualStrings("?x=1", r.query);
    try std.testing.expectEqualStrings("content-type", r.headers[0].name);
    try std.testing.expectEqualStrings("/@bob", basePath(r.base));
    try std.testing.expectEqualStrings("http://h.test:8100", originOf(r.base).?);
    var bad = cbor.MapBuilder.init(a);
    try bad.put("url", cbor.string("ftp://x"));
    try std.testing.expect((try parse(a, try cbor.encode(a, bad.value()))) == .bad);
    var auth = cbor.MapBuilder.init(a);
    var ah = cbor.MapBuilder.init(a);
    try ah.put("X-BSV-Auth-Nonce", cbor.string("n"));
    try auth.put("url", cbor.string("https://x.test"));
    try auth.put("headers", ah.value());
    try std.testing.expect((try parse(a, try cbor.encode(a, auth.value()))) == .bad);
}
