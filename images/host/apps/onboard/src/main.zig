//! onboard (shruggr/skein#90, #113): the onboarding app, installed in the host
//! skein — the operator's own instance on a host. It gives a stranger a place
//! on this host, records it under its own name, and is the host's BRC-169
//! server: every handle the host certifies is registered here, its
//! certificate issued through the host's certifier and recorded here, and
//! resolved and searched from those records.
//!
//! Rows and reads (installed under /onboard/; the router maps the host's own
//! origin onto them: docs/MESSAGES.md in skein, "BRC-169 is discovery"). A
//! row is a message route: a signed request, an entry. A read
//! (shruggr/skein#135) is served by a call over the current state: anyone,
//! signed or not, nothing logged.
//!
//!   POST /onboard/call           row, sender session   {fn: "onboard.create", args: {handle, image?, claim}} → {handle, identity, url}
//!   POST /onboard/register       row, sender session   {username, identityKey, signature} → a mailbox instance and its certificate
//!                                                       (identityKey the session's: shruggr/skein#135, a write is signed)
//!   POST /onboard/profile        row, sender *         {handle, record, signature} → the holder's signed profile kept (a write: signed)
//!   GET  /onboard/resolve        read                  ?handle=<handle>[@<domain>] → BRC-169 §5.2
//!   GET  /onboard/search         read                  ?q=&limit= → BRC-169 §5.6
//!   GET  /onboard/manifest.json  read                  BRC-169 §5.1: the trust anchor (the certifier's key), the endpoints
//!   GET  /onboard/bsvalias/id/…  read (prefix)         the paymail PKI
//!
//! The configuration (`config.onboard` of the installed manifest; skein-host
//! install --config writes it): `domain` — the one domain this host's handles
//! are at, `<handle>@<domain>` (default `localhost`); `origin` — where the
//! host's own origin is, published in the manifest (default
//! `https://<domain>`); `name`, `note`, `icon` — the host's presentation in
//! `metanet.trust`; `ordfs` — the ORDFS content route an avatar's URL is
//! derived under (default https://api.1sat.app/content; empty: none).
//!
//! The heads (all under `onboard/`, the app's write scope):
//!
//!   onboard/instances/<handle>   → the instance manager's answer record (create and register alike)
//!   onboard/handles/<handle>     → the handle's current certificate record; its `prev` the one before:
//!                                  the trail of every issue, for revocation later
//!   onboard/profiles/<handle>    → the holder's signed profile record
//!   onboard/index                → {kind: "onboard-index", handles: {<handle>: <certificate record>},
//!                                   keys: {<subject, hex>: <handle>}}: one key holds one handle
//!
//! A certificate is issued in three records. The issuance record
//! `{kind: "handle-issuance", handle, domain, subject, messagebox, issuedAt,
//! request, prev?}` is put first; the certificate's serial number is
//! base64 of its hash (the SHA-256 digest its CID names), so every issue —
//! a re-registration too — has a serial of its own. The thread asks the
//! host's certifier (the address book's role `certifier`, the host skein's
//! alone) to sign: `issue {handle, domain, subject, serialNumber, issuance}`;
//! the key stays with the host, the request and its answer are entries here.
//! The answer `{certificate, holder: {certificate, keyringForSubject},
//! issuance}` — the plaintext certificate a resolver checks and the holder's
//! copy with encrypted fields — becomes the certificate record
//! `{kind: "handle-certificate", handle, domain, subject, messagebox,
//! issuedAt, serialNumber, issuance, prev?, certificate, holder}`, the head
//! `onboard/handles/<handle>` moves to it, and the index follows.
//!
//! Error codes of /onboard/call (the SDK's, `app.Code`, and one more):
//! bad-request 400, bad-args 400, not-admitted 403, unknown-fn 404, refused
//! 409 (the instance manager said no), failed 500 (the thread errored: no
//! manager here, …). The open routes answer `{error}` (register, profile) or
//! §5.3's `{metanetHandles, error: {code, message}}` (resolve).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const app = @import("app");
const dagjson = @import("dagjson");
const secp = @import("secp");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;
const b64 = std.base64.standard;

pub const NAME = "onboard";
/// The one `{fn, args}` function: `<interface>.<function>` (skein-sdk `app`'s naming).
pub const CREATE = "onboard.create";
/// The operator's: an existing mailbox instance (a host.db row made before #113) recorded and certified.
pub const ADOPT = "onboard.adopt";
/// Where a created instance is recorded: `onboard/instances/<handle>` → the manager's answer.
pub const INSTANCES = "onboard/instances/";
/// A handle's current certificate record.
pub const HANDLES = "onboard/handles/";
/// A handle holder's signed profile.
pub const PROFILES = "onboard/profiles/";
/// Every handle here and which key holds it.
pub const INDEX = "onboard/index";

/// The registration signature: [2, "skein register"], key ID the username, counterparty anyone,
/// over `register <username>@<domain>`.
pub const REGISTER_PROTOCOL = "skein register";
/// The profile signature (skein #104): [1, "metanet handles profile"], key ID "1", counterparty anyone.
pub const PROFILE_PROTOCOL = "metanet handles profile";
pub const PROFILE_KEY_ID = "1";
pub const HANDLES_VERSION = "1.0";
/// §5.4: how long a resolution may be cached (s). No revocation outpoint: the ttl is the bound.
pub const RESOLUTION_TTL = 300;
pub const RESOLVE_PATH = "/.well-known/metanet-handles/resolve";
pub const SEARCH_PATH = "/.well-known/metanet-handles/search";
pub const SEARCH_MAX = 100;
pub const SEARCH_DEFAULT = 20;
pub const ORDFS_CONTENT = "https://api.1sat.app/content";
/// Labels a registration may not take: the router's own name in production and the host skein's.
pub const RESERVED = [_][]const u8{ "id", "host" };

pub fn main() u8 {
    return sk.main(NAME, run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "call")) {
        const func = Value.str(in.get("fn")) orelse "";
        const req = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("the argument is not dag-cbor");
        if (eql(u8, func, "call")) return sk.answer(a, try route(a, in, req));
        if (eql(u8, func, "register")) return sk.answer(a, try register(a, in, req));
        if (eql(u8, func, "profile")) return sk.answer(a, try profile(a, in, req));
        if (eql(u8, func, "resolve")) return sk.answer(a, try resolve(a, req));
        if (eql(u8, func, "search")) return sk.answer(a, try search(a, req));
        if (eql(u8, func, "manifest")) return sk.answer(a, try manifestRoute(a));
        if (eql(u8, func, "paymail")) return sk.answer(a, try paymail(a, req));
        return sk.report("onboard answers the fns call, register, profile, resolve, search, manifest and paymail (its routes)");
    }
    if (eql(u8, kind, "step")) return work(a, in);
    return sk.report("onboard is called (its routes) or stepped (its threads)");
}

// ---------------------------------------------------------------- configuration

pub const Config = struct {
    domain: []const u8 = "localhost",
    origin: []const u8 = "",
    name: ?[]const u8 = null,
    note: ?[]const u8 = null,
    icon: ?[]const u8 = null,
    ordfs: []const u8 = ORDFS_CONTENT,
};

/// `config.onboard` of an app record (the manifest as installed).
pub fn configFrom(a: Allocator, manifest: Value) !Config {
    const all: Value = manifest.get("config") orelse .null;
    const c: Value = all.get(NAME) orelse .null;
    var out: Config = .{};
    if (Value.str(c.get("domain"))) |d| if (d.len > 0) {
        out.domain = try std.ascii.allocLowerString(a, d);
    };
    out.origin = std.mem.trimEnd(u8, Value.str(c.get("origin")) orelse "", "/");
    if (out.origin.len == 0) out.origin = try std.fmt.allocPrint(a, "https://{s}", .{out.domain});
    out.name = nonEmpty(Value.str(c.get("name")));
    out.note = nonEmpty(Value.str(c.get("note")));
    out.icon = nonEmpty(Value.str(c.get("icon")));
    if (Value.str(c.get("ordfs"))) |o| out.ordfs = std.mem.trimEnd(u8, o, "/");
    return out;
}

fn nonEmpty(s: ?[]const u8) ?[]const u8 {
    const x = s orelse return null;
    return if (x.len == 0) null else x;
}

fn config(a: Allocator) !Config {
    return configFrom(a, try app.manifestOf(a, NAME));
}

// ---------------------------------------------------------------- answers

/// A failure as the route answers it.
pub const Fail = struct { status: u16, code: []const u8, message: []const u8 };

fn json(a: Allocator, status: u16, v: Value) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("status", cbor.int(status));
    try m.put("type", cbor.string("application/json"));
    try m.put("body", .{ .bytes = try dagjson.encode(a, v) });
    return m.value();
}

/// `{error}` with a status: register's and profile's refusals.
fn plainError(a: Allocator, status: u16, message: []const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("error", cbor.string(message));
    return json(a, status, m.value());
}

/// §5.3: an error answer's body.
fn resolutionError(a: Allocator, status: u16, code: []const u8, message: []const u8) !Value {
    var e = cbor.MapBuilder.init(a);
    try e.put("code", cbor.string(code));
    try e.put("message", cbor.string(message));
    var m = cbor.MapBuilder.init(a);
    try m.put("metanetHandles", cbor.string(HANDLES_VERSION));
    try m.put("error", e.value());
    return json(a, status, m.value());
}

fn wait(a: Allocator) !Value {
    var w = cbor.MapBuilder.init(a);
    try w.put("wait", .{ .bool = true });
    return w.value();
}

// ---------------------------------------------------------------- small parts

/// A handle as an instance's hostname label: a-z, 0-9 and "-", 1 to 63, no "-" at either end.
pub fn isLabel(s: []const u8) bool {
    if (s.len == 0 or s.len > 63 or s[0] == '-' or s[s.len - 1] == '-') return false;
    for (s) |c| if (!(std.ascii.isLower(c) or std.ascii.isDigit(c) or c == '-')) return false;
    return true;
}

pub fn isReserved(s: []const u8) bool {
    for (RESERVED) |r| if (eql(u8, r, s)) return true;
    return false;
}

fn isHex(s: []const u8) bool {
    if (s.len == 0 or s.len % 2 != 0) return false;
    for (s) |c| if (!std.ascii.isHex(c)) return false;
    return true;
}

/// The serial number of a certificate: base64 of the SHA-256 digest its issuance record's CID names.
pub fn serialOf(a: Allocator, issuance: []const u8) ![]u8 {
    const p = try cbor.cidm.parts(issuance);
    const out = try a.alloc(u8, b64.Encoder.calcSize(p.digest.len));
    return @constCast(b64.Encoder.encode(out, p.digest));
}

pub fn base64(a: Allocator, b: []const u8) ![]u8 {
    const out = try a.alloc(u8, b64.Encoder.calcSize(b.len));
    return @constCast(b64.Encoder.encode(out, b));
}

pub fn unbase64(a: Allocator, s: []const u8) ?[]u8 {
    const n = b64.Decoder.calcSizeForSlice(s) catch return null;
    const out = a.alloc(u8, n) catch return null;
    b64.Decoder.decode(out, s) catch return null;
    return out;
}

/// One query parameter, percent-decoded as URLSearchParams decodes it ("+" a space), or null.
pub fn queryParam(a: Allocator, query: []const u8, key: []const u8) !?[]u8 {
    const q = if (query.len > 0 and query[0] == '?') query[1..] else query;
    var it = std.mem.splitScalar(u8, q, '&');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=');
        const k = try unescape(a, pair[0 .. eq orelse pair.len]);
        if (!eql(u8, k, key)) continue;
        return try unescape(a, if (eq) |i| pair[i + 1 ..] else "");
    }
    return null;
}

fn unescape(a: Allocator, s: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(a);
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (c == '+') {
            try out.append(' ');
        } else if (c == '%' and i + 2 < s.len and std.ascii.isHex(s[i + 1]) and std.ascii.isHex(s[i + 2])) {
            try out.append(std.fmt.parseInt(u8, s[i + 1 .. i + 3], 16) catch unreachable);
            i += 2;
        } else {
            try out.append(c);
        }
    }
    return out.items;
}

/// A 36-byte outpoint (txid in internal order, vout little-endian) as `<txid>_<vout>` (@1sat/templates outpointFromBytes).
pub fn outpointText(a: Allocator, b: []const u8) !?[]u8 {
    if (b.len != 36) return null;
    var txid: [32]u8 = undefined;
    for (0..32) |i| txid[i] = b[31 - i];
    const vout = std.mem.readInt(u32, b[32..36], .little);
    return try std.fmt.allocPrint(a, "{s}_{d}", .{ try sk.hex(a, &txid), vout });
}

fn concat(a: Allocator, x: []const u8, y: []const u8) ![]u8 {
    return std.mem.concat(a, u8, &.{ x, y });
}

/// The head a created instance is recorded under.
pub fn instanceHead(a: Allocator, handle: []const u8) ![]u8 {
    return concat(a, INSTANCES, handle);
}

/// A handle's current certificate record, or null.
fn certificateRecord(a: Allocator, handle: []const u8) !?Value {
    const c = (try sk.head(a, try concat(a, HANDLES, handle))) orelse return null;
    return try sk.get(a, c);
}

/// The index, or an empty one.
fn indexOf(a: Allocator) !Value {
    const c = (try sk.head(a, INDEX)) orelse return .{ .map = &.{} };
    return try sk.get(a, c);
}

/// The handle `key` (33 bytes) holds here, if any.
fn handleOfKey(a: Allocator, idx: Value, key: []const u8) !?[]const u8 {
    const keys: Value = idx.get("keys") orelse return null;
    return Value.str(keys.get(try sk.hex(a, key)));
}

// ---------------------------------------------------------------- the /call route: onboard.create, onboard.adopt

/// What a call's body asks: {fn, args} checked down to its own args. `owner`: adopt's (hex).
/// `claim`: create's — the caller's own signed claim {message, body} (shruggr/skein#127):
/// a message in box `claim`, signed by the caller's wallet and naming no recipient (the
/// instance does not exist yet), passed to the instance manager, which forwards it into
/// the new instance as its first entry; the kernel takes the owner from its signer. This
/// app does not sign it, read it or change it.
pub const Ask = struct { func: []const u8, handle: []const u8, image: ?[]const u8 = null, owner: ?[]const u8 = null, claim: ?Value = null };

/// The body {fn: "onboard.create" | "onboard.adopt", args} → the args,
/// checked against the declared shape (`decl`: the manifest's declaration of
/// that fn, looked up by `declOf`), or why not.
pub fn parseAsk(a: Allocator, body: Value, declOf: anytype) !union(enum) { ok: Ask, fail: Fail } {
    if (body != .map) return .{ .fail = .{ .status = 400, .code = "bad-request", .message = "the body is not {fn, args}" } };
    const name = Value.str(body.get("fn")) orelse return .{ .fail = .{ .status = 400, .code = "bad-request", .message = "fn is not text" } };
    if (!eql(u8, name, CREATE) and !eql(u8, name, ADOPT)) return .{ .fail = .{ .status = 404, .code = "unknown-fn", .message = try std.fmt.allocPrint(a, "{s}: not provided by onboard (it provides {s}, {s})", .{ name, CREATE, ADOPT }) } };
    const args: Value = switch (body.get("args") orelse Value.null) {
        .null => .{ .map = &.{} },
        else => |v| v,
    };
    if (try declOf.get(a, name)) |d| if (try app.check(a, d.get("args") orelse Value{ .map = &.{} }, args, "args")) |why|
        return .{ .fail = .{ .status = 400, .code = "bad-args", .message = why } };
    const handle = Value.str(args.get("handle")) orelse return .{ .fail = .{ .status = 400, .code = "bad-args", .message = "args.handle: missing" } };
    if (eql(u8, name, ADOPT)) {
        const owner = Value.str(args.get("owner")) orelse "";
        if (!secp.isIdentity(owner)) return .{ .fail = .{ .status = 400, .code = "bad-args", .message = "args.owner: an identity key (hex)" } };
        return .{ .ok = .{ .func = ADOPT, .handle = handle, .owner = owner } };
    }
    return .{ .ok = .{ .func = CREATE, .handle = handle, .image = Value.str(args.get("image")), .claim = args.get("claim") } };
}

/// The manifest's declarations, by full function name.
const Decls = struct {
    manifest: ?Value,
    fn get(d: Decls, a: Allocator, name: []const u8) !?Value {
        const m = d.manifest orelse return null;
        return app.declOf(a, m, name);
    }
};

/// The policy (shruggr/skein#90): who may have a skein, on what terms. Free
/// and ungated for now: every session may create one, but not under a
/// reserved name. Null: allowed.
pub fn policy(owner: []const u8, ask: Ask) ?Fail {
    _ = owner;
    if (isReserved(ask.handle)) return .{ .status = 409, .code = "refused", .message = "the handle is reserved" };
    return null;
}

/// The checks a registration (and an adoption) passes before its thread: the
/// name not reserved, not another key's; the key holding no other handle here.
fn registrationRefusal(a: Allocator, username: []const u8, key: []const u8) !?[]const u8 {
    if (isReserved(username)) return try std.fmt.allocPrint(a, "username {s} is reserved", .{username});
    // One key, one handle; a handle is its key's.
    if (try handleOfKey(a, try indexOf(a), key)) |other| if (!eql(u8, other, username))
        return try std.fmt.allocPrint(a, "already registered as {s}", .{other});
    if (try certificateRecord(a, username)) |rec| if (!eql(u8, Value.bytesOf(rec.get("subject")) orelse "", key))
        return try std.fmt.allocPrint(a, "username {s} is taken", .{username});
    return null;
}

/// The register thread's arguments: the request, recorded.
fn registrationRecord(a: Allocator, in: Value, req: Value, username: []const u8, domain: []const u8, key: []const u8, signature: ?[]const u8) ![]u8 {
    const existing = if (try certificateRecord(a, username)) |rec| eql(u8, Value.bytesOf(rec.get("subject")) orelse "", key) else false;
    var r = cbor.MapBuilder.init(a);
    try r.put("kind", cbor.string("onboard-register"));
    try r.put("handle", cbor.string(username));
    try r.put("domain", cbor.string(domain));
    try r.put("subject", .{ .bytes = key });
    if (signature) |s| try r.put("signature", .{ .bytes = s }) else try r.put("adopted", .{ .bool = true });
    try r.put("existing", .{ .bool = existing });
    try r.put("issuedAt", in.get("now"));
    try r.put("request", cbor.optCid(Value.cidOf(req.get("request"))));
    return sk.put(a, r.value());
}

fn route(a: Allocator, in: Value, req: Value) !Value {
    if (!eql(u8, Value.str(req.get("method")) orelse "", "POST")) return failure(a, "", .{ .status = 400, .code = "bad-request", .message = "POST {fn: \"onboard.create\", args: {handle, image?}}" });
    const caller = Value.bytesOf(req.get("caller")) orelse return failure(a, "", .{ .status = 403, .code = "not-admitted", .message = "no session: create needs a BRC-104 session (its key owns the new skein)" });
    const raw = Value.bytesOf(req.get("body")) orelse "";
    const ct = Value.str(req.get("contentType")) orelse "";
    const body = (if (eql(u8, ct, "application/cbor")) cbor.decode(a, raw) else dagjson.decode(a, raw)) catch
        return failure(a, "", .{ .status = 400, .code = "bad-request", .message = "the body is not {fn, args} (JSON, or dag-cbor as application/cbor)" });
    const manifest = try app.manifestOf(a, NAME);
    const ask = switch (try parseAsk(a, body, Decls{ .manifest = manifest })) {
        .ok => |x| x,
        .fail => |f| return failure(a, Value.str(body.get("fn")) orelse "", f),
    };
    if (req.get("resolved")) |r| return finish(a, r, ask.func);
    if (eql(u8, ask.func, ADOPT)) {
        // The operator's: an existing mailbox instance (host.db) recorded and certified, as a registration without the holder's signature.
        if (!eql(u8, Value.bytesOf(in.get("owner")) orelse "", caller)) return failure(a, ADOPT, .{ .status = 403, .code = "not-admitted", .message = "adopt is the host skein owner's" });
        const key = sk.unhex(a, ask.owner.?).?;
        if (!isLabel(ask.handle)) return failure(a, ADOPT, .{ .status = 400, .code = "bad-args", .message = "args.handle: a host name label" });
        if (try registrationRefusal(a, ask.handle, key)) |why| return failure(a, ADOPT, .{ .status = 409, .code = "refused", .message = why });
        _ = try sk.launch(a, try selfProgram(req), try registrationRecord(a, in, req, ask.handle, (try configFrom(a, manifest)).domain, key, null));
        return wait(a);
    }
    if (policy(caller, ask)) |f| return failure(a, CREATE, f);
    // The request, recorded: the create thread's arguments.
    var r = cbor.MapBuilder.init(a);
    try r.put("kind", cbor.string("onboard-request"));
    try r.put("handle", cbor.string(ask.handle));
    try r.put("owner", .{ .bytes = caller });
    try r.put("image", cbor.optStr(ask.image));
    try r.put("claim", ask.claim orelse .null);
    try r.put("issuedAt", in.get("now"));
    try r.put("request", cbor.optCid(Value.cidOf(req.get("request"))));
    _ = try sk.launch(a, try selfProgram(req), try sk.put(a, r.value()));
    return wait(a);
}

fn selfProgram(req: Value) ![]const u8 {
    const match: Value = req.get("match") orelse .null;
    return Value.cidOf(match.get("program")) orelse sk.report("the route's row names no program");
}

/// Called again: the thread came to rest. Its answer, on the connection.
fn finish(a: Allocator, resolved: Value, func: []const u8) !Value {
    const out = switch (try threadAnswer(a, resolved)) {
        .ok => |v| v,
        .failed => |m| return failure(a, func, .{ .status = 500, .code = "failed", .message = m }),
    };
    if (eql(u8, func, ADOPT)) {
        if (Value.str(out.get("error"))) |e| return failure(a, ADOPT, .{ .status = 409, .code = "refused", .message = e });
        var res = cbor.MapBuilder.init(a);
        for ([_][]const u8{ "handle", "domain", "identityKey", "messagebox" }) |k| try res.put(k, out.get(k));
        const c: Value = out.get("certificate") orelse .null;
        try res.put("serialNumber", c.get("serialNumber"));
        var m = cbor.MapBuilder.init(a);
        try m.put("fn", cbor.string(ADOPT));
        try m.put("result", res.value());
        return json(a, 200, m.value());
    }
    return answerOf(a, out);
}

/// The thread a route waited on, come to rest: its answer, or why it failed.
fn threadAnswer(a: Allocator, resolved: Value) !union(enum) { ok: Value, failed: []const u8 } {
    if (resolved != .array or resolved.array.len == 0) return sk.report("resolved: nothing");
    const r = resolved.array[0];
    if (!eql(u8, Value.str(r.get("state")) orelse "", "finished")) {
        const e: Value = r.get("error") orelse .null;
        return .{ .failed = Value.str(e.get("message")) orelse "the thread failed" };
    }
    const res: Value = r.get("result") orelse .null;
    return .{ .ok = cbor.decode(a, Value.bytesOf(res.get("stdout")) orelse "") catch return sk.report("the thread's answer is not dag-cbor") };
}

/// The create thread's answer ({handle, identity, url} | {error}) as the route's.
pub fn answerOf(a: Allocator, out: Value) !Value {
    if (Value.str(out.get("error"))) |e| return failure(a, CREATE, .{ .status = 409, .code = "refused", .message = e });
    var res = cbor.MapBuilder.init(a);
    try res.put("handle", out.get("handle"));
    try res.put("identity", cbor.string(try sk.hex(a, Value.bytesOf(out.get("identity")) orelse "")));
    try res.put("url", out.get("url"));
    var m = cbor.MapBuilder.init(a);
    try m.put("fn", cbor.string(CREATE));
    try m.put("result", res.value());
    return json(a, 200, m.value());
}

fn failure(a: Allocator, name: []const u8, f: Fail) !Value {
    var e = cbor.MapBuilder.init(a);
    try e.put("code", cbor.string(f.code));
    try e.put("message", cbor.string(f.message));
    var m = cbor.MapBuilder.init(a);
    try m.put("fn", cbor.string(name));
    try m.put("error", e.value());
    return json(a, f.status, m.value());
}

// ---------------------------------------------------------------- register (an open route)

/// What a registration's body says, checked.
pub const Registration = struct { username: []const u8, key: []const u8, signature: []const u8 };

/// The body {username, identityKey, signature} → its parts (the key and the
/// signature as bytes, the username trimmed and lower-cased), or why not.
pub fn parseRegistration(a: Allocator, raw: []const u8) !union(enum) { ok: Registration, fail: Fail } {
    const b = dagjson.decode(a, raw) catch return .{ .fail = .{ .status = 400, .code = "", .message = "the body is not JSON" } };
    const want: Fail = .{ .status = 400, .code = "", .message = "want {username, identityKey, signature (hex)}" };
    const username = try std.ascii.allocLowerString(a, std.mem.trim(u8, Value.str(b.get("username")) orelse "", " \t\r\n"));
    const key = Value.str(b.get("identityKey")) orelse return .{ .fail = want };
    const sig = Value.str(b.get("signature")) orelse return .{ .fail = want };
    if (!secp.isIdentity(key) or !isHex(sig)) return .{ .fail = want };
    if (!isLabel(username)) return .{ .fail = .{ .status = 400, .code = "", .message = "the username is a host name label: a-z, 0-9 and -, at most 63" } };
    return .{ .ok = .{ .username = username, .key = sk.unhex(a, key).?, .signature = sk.unhex(a, sig).? } };
}

/// What the registrant signs: `register <username>@<domain>`.
pub fn registerText(a: Allocator, username: []const u8, domain: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "register {s}@{s}", .{ username, domain });
}

/// Whether `signature` is the key's over `register <username>@<domain>` ([2, "skein register"], key ID the username, counterparty anyone).
pub fn registrationSigned(a: Allocator, r: Registration, domain: []const u8) !bool {
    return secp.verifyAnyoneKey(r.key, 2, REGISTER_PROTOCOL, r.username, try registerText(a, r.username, domain), r.signature);
}

fn register(a: Allocator, in: Value, req: Value) !Value {
    if (req.get("resolved")) |r| return finishRegister(a, r);
    if (!eql(u8, Value.str(req.get("method")) orelse "", "POST")) return plainError(a, 405, "POST {username, identityKey, signature}");
    // shruggr/skein#135: a registration is a write, so a signed request: the registrant is the session's identity.
    const caller = Value.bytesOf(req.get("caller")) orelse return plainError(a, 401, "registration needs a BRC-104 session: the registrant is its identity");
    const reg = switch (try parseRegistration(a, Value.bytesOf(req.get("body")) orelse "")) {
        .ok => |x| x,
        .fail => |f| return plainError(a, f.status, f.message),
    };
    if (!eql(u8, reg.key, caller)) return plainError(a, 403, "identityKey is not the session's identity");
    const cfg = try config(a);
    if (!try registrationSigned(a, reg, cfg.domain))
        return plainError(a, 401, try std.fmt.allocPrint(a, "the signature does not verify for that identity (it signs \"{s}\")", .{try registerText(a, reg.username, cfg.domain)}));
    if (try registrationRefusal(a, reg.username, reg.key)) |why| return plainError(a, 409, why);
    _ = try sk.launch(a, try selfProgram(req), try registrationRecord(a, in, req, reg.username, cfg.domain, reg.key, reg.signature));
    return wait(a);
}

/// Called again: the register thread came to rest.
fn finishRegister(a: Allocator, resolved: Value) !Value {
    const out = switch (try threadAnswer(a, resolved)) {
        .ok => |v| v,
        .failed => |m| return plainError(a, 500, m),
    };
    if (Value.str(out.get("error"))) |e| {
        const status: u16 = if (Value.intOf(out.get("status"))) |s| @intCast(s) else 409;
        return plainError(a, status, e);
    }
    return json(a, 200, out);
}

// ---------------------------------------------------------------- the paymail PKI (an open route)

/// GET /onboard/bsvalias/id/<handle>[@<domain>] (the router's /bsvalias/id/…): {bsvalias, handle, pubkey} from the records.
fn paymail(a: Allocator, req: Value) !Value {
    const cfg = try config(a);
    const r = Value.str(req.get("route")) orelse "";
    const at = std.mem.indexOf(u8, r, "/bsvalias/id/") orelse return plainError(a, 404, "not found");
    const p = try parseHandle(a, try unescape(a, r[at + "/bsvalias/id/".len ..]), cfg.domain);
    const notFound = struct {
        fn f(x: Allocator) !Value {
            var m = cbor.MapBuilder.init(x);
            try m.put("error", cbor.string("not found"));
            return json(x, 404, m.value());
        }
    }.f;
    if (p.handle.len == 0 or !eql(u8, p.domain, cfg.domain)) return notFound(a);
    const rec = (try certificateRecord(a, p.handle)) orelse return notFound(a);
    var m = cbor.MapBuilder.init(a);
    try m.put("bsvalias", cbor.string("1.0"));
    try m.put("handle", cbor.string(try std.fmt.allocPrint(a, "{s}@{s}", .{ p.handle, p.domain })));
    try m.put("pubkey", cbor.string(try sk.hex(a, Value.bytesOf(rec.get("subject")) orelse "")));
    return json(a, 200, m.value());
}

// ---------------------------------------------------------------- the threads

fn work(a: Allocator, in: Value) !void {
    const args: Value = in.get("args") orelse return sk.report("no args");
    const kind = Value.str(args.get("kind")) orelse "";
    if (eql(u8, kind, "onboard-request")) return createThread(a, in, args);
    if (eql(u8, kind, "onboard-register")) return registerThread(a, in, args);
    return sk.report("onboard is stepped only on its own threads (an onboard-request, an onboard-register)");
}

fn errorAnswer(a: Allocator, message: []const u8, status: ?u16) !void {
    var m = cbor.MapBuilder.init(a);
    try m.put("error", cbor.string(message));
    if (status) |s| try m.put("status", cbor.int(s));
    return sk.answer(a, m.value());
}

/// Ask the instance manager for the instance: create {handle, owner, image?, domain, claim?}
/// (`claim`: the owner's signed claim, as the page sent it; shruggr/skein#127).
fn askManager(a: Allocator, handle: []const u8, owner: []const u8, image: ?Value, domain: []const u8, claim: ?Value) !void {
    const manager = (try sk.peerAt(a, "local", "manager")) orelse return sk.report("no instance manager in this skein's address book: the onboarding app runs in the host skein");
    var q = cbor.MapBuilder.init(a);
    try q.put("handle", cbor.string(handle));
    try q.put("owner", .{ .bytes = owner });
    try q.put("image", image);
    try q.put("domain", cbor.string(domain));
    if (claim) |c| if (c != .null) try q.put("claim", c);
    try sk.awaitRecord(try sk.emit(a, manager, "create", q.value(), null));
}

/// The manager's answer recorded by reference under onboard/instances/<handle>; its body.
fn recordInstance(a: Allocator, in: Value, r: sk.Reply, handle: []const u8) !Value {
    const rep: Value = in.get("reply") orelse .null;
    const body_cid = Value.cidOf(rep.get("body")) orelse return sk.report("reply: no body");
    if (!eql(u8, Value.str(r.body.get("handle")) orelse "", handle)) return sk.report("the instance manager answered for another handle");
    try sk.advance(try instanceHead(a, handle), body_cid);
    return r.body;
}

/// Issue a certificate for handle@domain → subject: the issuance record put,
/// its hash the serial number, and the certifier asked to sign.
fn issue(a: Allocator, args: Value, handle: []const u8, domain: []const u8, subject: []const u8, messagebox: []const u8) !void {
    const certifier = (try sk.peerAt(a, "local", "certifier")) orelse return sk.report("no certifier in this skein's address book: the onboarding app runs in the host skein");
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("handle-issuance"));
    try m.put("handle", cbor.string(handle));
    try m.put("domain", cbor.string(domain));
    try m.put("subject", .{ .bytes = subject });
    try m.put("messagebox", cbor.string(messagebox));
    try m.put("issuedAt", args.get("issuedAt"));
    try m.put("request", cbor.optCid(Value.cidOf(args.get("request"))));
    try m.put("prev", cbor.optCid(try sk.head(a, try concat(a, HANDLES, handle))));
    const issuance = try sk.put(a, m.value());
    var q = cbor.MapBuilder.init(a);
    try q.put("handle", cbor.string(handle));
    try q.put("domain", cbor.string(domain));
    try q.put("subject", .{ .bytes = subject });
    try q.put("serialNumber", cbor.string(try serialOf(a, issuance)));
    try q.put("issuance", cbor.cidv(issuance));
    try sk.awaitRecord(try sk.emit(a, certifier, "issue", q.value(), null));
}

/// The certifier's answer: the certificate record written, the handle's head
/// and the index moved. The record, or the certifier's error.
fn certified(a: Allocator, r: sk.Reply, handle: []const u8) !union(enum) { ok: Value, err: []const u8 } {
    if (Value.str(r.body.get("error"))) |e| return .{ .err = e };
    const ic = Value.cidOf(r.body.get("issuance")) orelse return sk.report("the certifier's answer names no issuance");
    const iss = try sk.get(a, ic);
    if (!eql(u8, Value.str(iss.get("handle")) orelse "", handle)) return sk.report("the certifier answered for another handle");
    const cert: Value = r.body.get("certificate") orelse return sk.report("the certifier's answer has no certificate");
    if (!eql(u8, Value.str(cert.get("serialNumber")) orelse "", try serialOf(a, ic))) return sk.report("the certifier signed another serial number");
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("handle-certificate"));
    for ([_][]const u8{ "handle", "domain", "subject", "messagebox", "issuedAt", "prev" }) |k| try m.put(k, iss.get(k));
    try m.put("serialNumber", cert.get("serialNumber"));
    try m.put("issuance", cbor.cidv(ic));
    try m.put("certificate", cert);
    try m.put("holder", r.body.get("holder"));
    const rec = m.value();
    const rc = try sk.put(a, rec);
    try sk.advance(try concat(a, HANDLES, handle), rc);
    // The index: this handle's record, and the key that holds it.
    const idx = try indexOf(a);
    var hs = cbor.MapBuilder.init(a);
    if (idx.get("handles")) |x| if (x == .map) for (x.map) |e| try hs.put(e.key, e.value);
    try hs.put(handle, cbor.cidv(rc));
    var ks = cbor.MapBuilder.init(a);
    if (idx.get("keys")) |x| if (x == .map) for (x.map) |e| try ks.put(e.key, e.value);
    try ks.put(try sk.hex(a, Value.bytesOf(iss.get("subject")) orelse ""), cbor.string(handle));
    var n = cbor.MapBuilder.init(a);
    try n.put("kind", cbor.string("onboard-index"));
    try n.put("handles", hs.value());
    try n.put("keys", ks.value());
    try sk.advance(INDEX, try sk.put(a, n.value()));
    return .{ .ok = rec };
}

/// onboard.create: the manager's create; its answer recorded; the new
/// instance's handle certified for its own identity; {handle, identity, url}.
fn createThread(a: Allocator, in: Value, args: Value) !void {
    const handle = Value.str(args.get("handle")) orelse return sk.report("the request names no handle");
    const cfg = try config(a);
    if (try sk.replyOf(a, in)) |r| {
        if (eql(u8, r.box, "create")) {
            if (Value.str(r.body.get("error"))) |e| return errorAnswer(a, e, null);
            const ans = try recordInstance(a, in, r, handle);
            const identity = Value.bytesOf(ans.get("identity")) orelse return sk.report("the instance manager's answer has no identity");
            return issue(a, args, handle, cfg.domain, identity, Value.str(ans.get("url")) orelse "");
        }
        if (eql(u8, r.box, "issue")) {
            switch (try certified(a, r, handle)) {
                .err => |e| return errorAnswer(a, try std.fmt.allocPrint(a, "{s} was created, but its certificate was not issued: {s}", .{ handle, e }), null),
                .ok => {},
            }
            const ans = try sk.get(a, (try sk.head(a, try instanceHead(a, handle))) orelse return sk.report("no instance record"));
            var m = cbor.MapBuilder.init(a);
            try m.put("handle", cbor.string(handle));
            try m.put("identity", ans.get("identity"));
            try m.put("url", ans.get("url"));
            return sk.answer(a, m.value());
        }
        return sk.report("an answer in an unexpected box");
    }
    const owner = Value.bytesOf(args.get("owner")) orelse return sk.report("the request names no owner");
    return askManager(a, handle, owner, args.get("image"), cfg.domain, args.get("claim"));
}

/// register: a mailbox instance for the key (the manager's create, image
/// `mailbox`) unless it has one here, then its certificate; the holder's copy answered.
fn registerThread(a: Allocator, in: Value, args: Value) !void {
    const handle = Value.str(args.get("handle")) orelse return sk.report("the registration names no handle");
    const domain = Value.str(args.get("domain")) orelse return sk.report("the registration names no domain");
    const subject = Value.bytesOf(args.get("subject")) orelse return sk.report("the registration names no key");
    if (try sk.replyOf(a, in)) |r| {
        if (eql(u8, r.box, "create")) {
            if (Value.str(r.body.get("error"))) |e| return errorAnswer(a, e, 409);
            const ans = try recordInstance(a, in, r, handle);
            return issue(a, args, handle, domain, subject, Value.str(ans.get("url")) orelse "");
        }
        if (eql(u8, r.box, "issue")) {
            const rec = switch (try certified(a, r, handle)) {
                .err => |e| return errorAnswer(a, try std.fmt.allocPrint(a, "the certificate was not issued: {s}", .{e}), 500),
                .ok => |x| x,
            };
            const holder: Value = rec.get("holder") orelse .null;
            var m = cbor.MapBuilder.init(a);
            try m.put("handle", cbor.string(handle));
            try m.put("domain", cbor.string(domain));
            try m.put("identityKey", cbor.string(try sk.hex(a, subject)));
            try m.put("messagebox", rec.get("messagebox"));
            try m.put("certificate", holder.get("certificate"));
            try m.put("keyringForSubject", holder.get("keyringForSubject"));
            return sk.answer(a, m.value());
        }
        return sk.report("an answer in an unexpected box");
    }
    const existing = if (args.get("existing")) |e| e == .bool and e.bool else false;
    if (existing) {
        // The key holds this handle already: its mailbox stands; a new certificate (a new serial).
        const prev = (try certificateRecord(a, handle)) orelse return sk.report("the registration's record is gone");
        if (!eql(u8, Value.bytesOf(prev.get("subject")) orelse "", subject)) return errorAnswer(a, try std.fmt.allocPrint(a, "username {s} is taken", .{handle}), 409);
        return issue(a, args, handle, domain, subject, Value.str(prev.get("messagebox")) orelse "");
    }
    return askManager(a, handle, subject, cbor.string("mailbox"), domain, null);
}

// ---------------------------------------------------------------- the profile (an open route)

/// A signed profile record checked: the holder's signature over the DAG-CBOR
/// bytes, a map whose `domain` is ours, `name` text, `avatar` 36 bytes.
pub fn checkProfile(a: Allocator, subject: []const u8, bytes: []const u8, signature: []const u8, domain: []const u8) !?[]const u8 {
    if (!secp.verifyAnyoneKey(subject, 1, PROFILE_PROTOCOL, PROFILE_KEY_ID, bytes, signature)) return "the signature does not verify for the handle's key";
    const p = cbor.decode(a, bytes) catch return "the record is not DAG-CBOR";
    if (p != .map) return "the record is not a map";
    if (!eql(u8, Value.str(p.get("domain")) orelse "", domain)) return try std.fmt.allocPrint(a, "the record's domain is not {s}", .{domain});
    if (p.get("name")) |n| if (n != .string) return "name: not text";
    if (p.get("avatar")) |v| if (v != .bytes or v.bytes.len != 36) return "avatar: not a 36-byte outpoint";
    return null;
}

fn profile(a: Allocator, in: Value, req: Value) !Value {
    _ = in;
    if (!eql(u8, Value.str(req.get("method")) orelse "", "POST")) return plainError(a, 405, "POST {handle, record, signature}");
    const b = dagjson.decode(a, Value.bytesOf(req.get("body")) orelse "") catch return plainError(a, 400, "the body is not JSON");
    const handle = try std.ascii.allocLowerString(a, Value.str(b.get("handle")) orelse "");
    const bytes = unbase64(a, Value.str(b.get("record")) orelse "") orelse return plainError(a, 400, "want {handle, record (base64), signature (hex)}");
    const sig = Value.str(b.get("signature")) orelse "";
    if (!isHex(sig) or bytes.len == 0) return plainError(a, 400, "want {handle, record (base64), signature (hex)}");
    const cfg = try config(a);
    const rec = (try certificateRecord(a, handle)) orelse return plainError(a, 404, try std.fmt.allocPrint(a, "no handle {s}@{s} here", .{ handle, cfg.domain }));
    const subject = Value.bytesOf(rec.get("subject")) orelse "";
    const der = sk.unhex(a, sig).?;
    if (try checkProfile(a, subject, bytes, der, cfg.domain)) |why| return plainError(a, if (std.mem.startsWith(u8, why, "the signature")) 401 else 400, why);
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("handle-profile"));
    try m.put("handle", cbor.string(handle));
    try m.put("subject", .{ .bytes = subject });
    try m.put("profile", .{ .bytes = bytes });
    try m.put("signature", .{ .bytes = der });
    try sk.advance(try concat(a, PROFILES, handle), try sk.put(a, m.value()));
    var out = cbor.MapBuilder.init(a);
    try out.put("handle", cbor.string(handle));
    try putProfileFields(a, &out, m.value(), subject, cfg);
    return json(a, 200, out.value());
}

/// The fields a resolution and a search result carry for the handle's profile
/// (skein #104): the signed record as served, and §5.6's hints derived from it.
fn putProfileFields(a: Allocator, m: *cbor.MapBuilder, p: Value, subject: []const u8, cfg: Config) !void {
    if (!eql(u8, Value.bytesOf(p.get("subject")) orelse "", subject)) return;
    const bytes = Value.bytesOf(p.get("profile")) orelse return;
    const v = cbor.decode(a, bytes) catch return;
    var s = cbor.MapBuilder.init(a);
    try s.put("record", cbor.string(try base64(a, bytes)));
    try s.put("signature", cbor.string(try sk.hex(a, Value.bytesOf(p.get("signature")) orelse "")));
    const pid = try a.alloc(Value, 2);
    pid[0] = cbor.int(1);
    pid[1] = cbor.string(PROFILE_PROTOCOL);
    try s.put("protocolID", .{ .array = pid });
    try s.put("keyID", cbor.string(PROFILE_KEY_ID));
    try m.put("profile", s.value());
    if (Value.str(v.get("name"))) |n| if (n.len > 0) try m.put("displayName", cbor.string(n));
    if (Value.bytesOf(v.get("avatar"))) |av| if (cfg.ordfs.len > 0) if (try outpointText(a, av)) |o|
        try m.put("avatarURL", cbor.string(try std.fmt.allocPrint(a, "{s}/{s}", .{ cfg.ordfs, o })));
}

fn profileOf(a: Allocator, handle: []const u8) !?Value {
    const c = (try sk.head(a, try concat(a, PROFILES, handle))) orelse return null;
    return try sk.get(a, c);
}

// ---------------------------------------------------------------- resolve, search, the manifest (open routes)

/// A `handle` query as §5.2 has it: `[@]handle[+tag][@domain]`, any case → (handle, domain).
pub fn parseHandle(a: Allocator, q: []const u8, own: []const u8) !struct { handle: []const u8, domain: []const u8 } {
    const s = if (q.len > 0 and q[0] == '@') q[1..] else q;
    const at = std.mem.indexOfScalar(u8, s, '@');
    const h0 = s[0 .. at orelse s.len];
    const d = if (at) |i| s[i + 1 ..] else own;
    const h = h0[0 .. std.mem.indexOfScalar(u8, h0, '+') orelse h0.len];
    return .{ .handle = try std.ascii.allocLowerString(a, h), .domain = try std.ascii.allocLowerString(a, d) };
}

fn resolve(a: Allocator, req: Value) !Value {
    const cfg = try config(a);
    const q = (try queryParam(a, Value.str(req.get("query")) orelse "", "handle")) orelse "";
    const p = try parseHandle(a, q, cfg.domain);
    if (p.handle.len == 0) return resolutionError(a, 400, "malformed-handle", "want ?handle=<handle>");
    const missing = try std.fmt.allocPrint(a, "no handle {s}@{s} here", .{ p.handle, p.domain });
    if (!eql(u8, p.domain, cfg.domain)) return resolutionError(a, 404, "handle-not-found", missing);
    const rec = (try certificateRecord(a, p.handle)) orelse return resolutionError(a, 404, "handle-not-found", missing);
    const subject = Value.bytesOf(rec.get("subject")) orelse "";
    var m = cbor.MapBuilder.init(a);
    try m.put("metanetHandles", cbor.string(HANDLES_VERSION));
    try m.put("handle", cbor.string(p.handle));
    try m.put("domain", cbor.string(p.domain));
    try m.put("identityKey", cbor.string(try sk.hex(a, subject)));
    try m.put("certificate", rec.get("certificate"));
    try m.put("messagebox", rec.get("messagebox"));
    try m.put("ttl", cbor.int(RESOLUTION_TTL));
    try m.put("revoked", .{ .bool = false });
    if (try profileOf(a, p.handle)) |pr| try putProfileFields(a, &m, pr, subject, cfg);
    return json(a, 200, m.value());
}

fn lessThan(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

fn search(a: Allocator, req: Value) !Value {
    const cfg = try config(a);
    const query = Value.str(req.get("query")) orelse "";
    const want = try std.ascii.allocLowerString(a, std.mem.trim(u8, (try queryParam(a, query, "q")) orelse "", " \t"));
    const lim = std.fmt.parseInt(i64, (try queryParam(a, query, "limit")) orelse "", 10) catch SEARCH_DEFAULT;
    const n: usize = @intCast(@min(SEARCH_MAX, if (lim >= 1) lim else SEARCH_DEFAULT));
    const idx = try indexOf(a);
    const hs: Value = idx.get("handles") orelse .{ .map = &.{} };
    var names = std.array_list.Managed([]const u8).init(a);
    if (hs == .map) for (hs.map) |e| try names.append(e.key);
    std.mem.sort([]const u8, names.items, {}, lessThan);
    var results = std.array_list.Managed(Value).init(a);
    var truncated = false;
    for (names.items) |h| {
        const rec = try sk.get(a, Value.cidOf(hs.get(h)) orelse continue);
        if (!eql(u8, Value.str(rec.get("domain")) orelse "", cfg.domain)) continue;
        const subject = Value.bytesOf(rec.get("subject")) orelse continue;
        var m = cbor.MapBuilder.init(a);
        try m.put("handle", cbor.string(h));
        try m.put("identityKey", cbor.string(try sk.hex(a, subject)));
        if (try profileOf(a, h)) |pr| try putProfileFields(a, &m, pr, subject, cfg);
        const r = m.value();
        const name = try std.ascii.allocLowerString(a, Value.str(r.get("displayName")) orelse "");
        if (want.len > 0 and std.mem.indexOf(u8, h, want) == null and std.mem.indexOf(u8, name, want) == null) continue;
        if (results.items.len == n) {
            truncated = true;
            break;
        }
        try results.append(r);
    }
    var out = cbor.MapBuilder.init(a);
    try out.put("metanetHandles", cbor.string(HANDLES_VERSION));
    try out.put("results", .{ .array = results.items });
    try out.put("truncated", .{ .bool = truncated });
    return json(a, 200, out.value());
}

fn manifestRoute(a: Allocator) !Value {
    const cfg = try config(a);
    const certifier = (try sk.peerAt(a, "local", "certifier")) orelse return plainError(a, 503, "no certifier in this skein's address book: the onboarding app runs in the host skein");
    var t = cbor.MapBuilder.init(a);
    try t.put("name", cbor.optStr(cfg.name));
    try t.put("note", cbor.optStr(cfg.note));
    try t.put("icon", cbor.optStr(cfg.icon));
    try t.put("publicKey", cbor.string(try sk.hex(a, certifier)));
    var h = cbor.MapBuilder.init(a);
    try h.put("version", cbor.string(HANDLES_VERSION));
    try h.put("resolve", cbor.string(try concat(a, cfg.origin, RESOLVE_PATH)));
    try h.put("search", cbor.string(try concat(a, cfg.origin, SEARCH_PATH)));
    var mt = cbor.MapBuilder.init(a);
    try mt.put("trust", t.value());
    try mt.put("handles", h.value());
    var m = cbor.MapBuilder.init(a);
    try m.put("metanet", mt.value());
    return json(a, 200, m.value());
}

// ---------------------------------------------------------------- tests

const decl_json =
    \\{"writes":true,"args":{"handle":"string","image?":"string","claim":{"message":"map","body":"bytes"}},"answer":{"handle":"string","identity":"string","url":"string"}}
;
/// A claim as a page sends it (dag-json; its shape only: the manager forwards it, the instance's front door checks it).
const claim_json =
    \\"claim":{"message":{"kind":"mail","op":"put","box":"claim"},"body":{"/":{"bytes":"oA"}}}
;
const adopt_json =
    \\{"writes":true,"args":{"handle":"string","owner":"string"},"answer":{"handle":"string","domain":"string","identityKey":"string","messagebox":"string","serialNumber":"string"}}
;
const TestDecls = struct {
    create: Value,
    adopt: Value,
    fn get(d: TestDecls, a: Allocator, name: []const u8) !?Value {
        _ = a;
        return if (eql(u8, name, CREATE)) d.create else d.adopt;
    }
};

test "a create's body" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const decl = TestDecls{ .create = try dagjson.decode(a, decl_json), .adopt = try dagjson.decode(a, adopt_json) };
    const ok = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.create\",\"args\":{\"handle\":\"alice\"," ++ claim_json ++ "}}"), decl);
    try std.testing.expectEqualStrings("alice", ok.ok.handle);
    try std.testing.expect(ok.ok.image == null);
    try std.testing.expectEqualStrings("claim", Value.str(ok.ok.claim.?.get("message").?.get("box")).?);
    const noclaim = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.create\",\"args\":{\"handle\":\"alice\"}}"), decl);
    try std.testing.expectEqualStrings("args.claim: missing", noclaim.fail.message);
    const img = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.create\",\"args\":{\"handle\":\"bob\",\"image\":\"default\"," ++ claim_json ++ "}}"), decl);
    try std.testing.expectEqualStrings("default", img.ok.image.?);
    const unk = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"create\",\"args\":{\"handle\":\"x\"}}"), decl);
    try std.testing.expectEqual(@as(u16, 404), unk.fail.status);
    const bad = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.create\",\"args\":{\"handle\":7}}"), decl);
    try std.testing.expectEqualStrings("bad-args", bad.fail.code);
    const extra = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.create\",\"args\":{\"handle\":\"x\",\"owner\":\"y\"," ++ claim_json ++ "}}"), decl);
    try std.testing.expectEqualStrings("args.owner: not in the shape", extra.fail.message);
    const none = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.create\"}"), decl);
    const adopt = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.adopt\",\"args\":{\"handle\":\"dave\",\"owner\":\"" ++ vector_key ++ "\"}}"), decl);
    try std.testing.expectEqualStrings(vector_key, adopt.ok.owner.?);
    const badkey = try parseAsk(a, try dagjson.decode(a, "{\"fn\":\"onboard.adopt\",\"args\":{\"handle\":\"dave\",\"owner\":\"02\"}}"), decl);
    try std.testing.expectEqualStrings("args.owner: an identity key (hex)", badkey.fail.message);
    try std.testing.expectEqualStrings("args.handle: missing", none.fail.message);
    const notmap = try parseAsk(a, try dagjson.decode(a, "[1]"), decl);
    try std.testing.expectEqualStrings("bad-request", notmap.fail.code);
}

test "the policy is free, but not for a reserved name" {
    try std.testing.expect(policy("k", .{ .func = CREATE, .handle = "alice" }) == null);
    try std.testing.expectEqual(@as(u16, 409), policy("k", .{ .func = CREATE, .handle = "id" }).?.status);
}

test "the answers" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ok = cbor.MapBuilder.init(a);
    try ok.put("handle", cbor.string("alice"));
    try ok.put("identity", .{ .bytes = &[_]u8{ 2, 0xab } });
    try ok.put("url", cbor.string("http://alice.localhost:8100"));
    const r = try answerOf(a, ok.value());
    try std.testing.expectEqual(@as(i128, 200), Value.intOf(r.get("status")).?);
    try std.testing.expectEqualStrings("{\"fn\":\"onboard.create\",\"result\":{\"handle\":\"alice\",\"identity\":\"02ab\",\"url\":\"http://alice.localhost:8100\"}}", Value.bytesOf(r.get("body")).?);
    var no = cbor.MapBuilder.init(a);
    try no.put("error", cbor.string("handle alice is taken"));
    const n = try answerOf(a, no.value());
    try std.testing.expectEqual(@as(i128, 409), Value.intOf(n.get("status")).?);
    try std.testing.expectEqualStrings("{\"fn\":\"onboard.create\",\"error\":{\"code\":\"refused\",\"message\":\"handle alice is taken\"}}", Value.bytesOf(n.get("body")).?);
    try std.testing.expectEqualStrings("onboard/instances/alice", try instanceHead(a, "alice"));
}

// A registration signed by @bsv/sdk's ProtoWallet (key 0x11…11): createSignature
// {protocolID: [2, "skein register"], keyID: "dave", counterparty: "anyone"} over "register dave@skein.nexus".
const vector_key = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const vector_sig = "304402200a82728a4f38ed26e2cf8bda5503ad0b4ca90bbae6dce612031f8929f7fc905402202ed3ba1742934ed23cb232ff907e667040ea77b171f0b8e0fe3eb814bf0622a5";

test "a registration: its body, and the signature over register <name>@<domain>" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const body = try std.fmt.allocPrint(a, "{{\"username\":\" Dave \",\"identityKey\":\"{s}\",\"signature\":\"{s}\"}}", .{ vector_key, vector_sig });
    const r = (try parseRegistration(a, body)).ok;
    try std.testing.expectEqualStrings("dave", r.username);
    try std.testing.expect(try registrationSigned(a, r, "skein.nexus"));
    try std.testing.expect(!try registrationSigned(a, r, "id.skein.nexus"));
    try std.testing.expect(!try registrationSigned(a, .{ .username = "dave2", .key = r.key, .signature = r.signature }, "skein.nexus"));
    try std.testing.expectEqualStrings("the body is not JSON", (try parseRegistration(a, "{")).fail.message);
    try std.testing.expectEqualStrings("want {username, identityKey, signature (hex)}", (try parseRegistration(a, "{\"username\":\"dave\",\"identityKey\":\"02\",\"signature\":\"00\"}")).fail.message);
    const dotted = try std.fmt.allocPrint(a, "{{\"username\":\"e.ve\",\"identityKey\":\"{s}\",\"signature\":\"00\"}}", .{vector_key});
    try std.testing.expectEqual(@as(u16, 400), (try parseRegistration(a, dotted)).fail.status);
}

test "labels, reserved names, handle queries" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expect(isLabel("dave"));
    try std.testing.expect(isLabel("a-1"));
    try std.testing.expect(!isLabel("-a"));
    try std.testing.expect(!isLabel("e.ve"));
    try std.testing.expect(!isLabel("Dave"));
    try std.testing.expect(!isLabel(""));
    try std.testing.expect(isReserved("id") and isReserved("host") and !isReserved("dave"));
    const p = try parseHandle(a, (try queryParam(a, "?handle=%40David%2Btag%40Skein.Nexus", "handle")).?, "skein.nexus");
    try std.testing.expectEqualStrings("david", p.handle);
    try std.testing.expectEqualStrings("skein.nexus", p.domain);
    const bare = try parseHandle(a, (try queryParam(a, "handle=dave&x=1", "handle")).?, "localhost");
    try std.testing.expectEqualStrings("localhost", bare.domain);
    try std.testing.expect((try queryParam(a, "?q=x", "handle")) == null);
    try std.testing.expectEqualStrings("dave d", (try queryParam(a, "?q=dave+d", "q")).?);
}

test "the profile: its signature and shape, an avatar's URL" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // {domain: "skein.nexus"} by @1sat/utils encodeProfile, signed by the vector key under [1, "metanet handles profile"], key ID "1".
    const rec = sk.unhex(a, "a166646f6d61696e6b736b65696e2e6e65787573").?;
    const sig = sk.unhex(a, "30450221008dd027bec5e5ff5756cc3395ea7a5056fe989642c3c9654e265d9621574bcc7502205ef65a0022777ce36a881d4309d29bd367526db5d6e30057fb26d1b3038474c2").?;
    const key = sk.unhex(a, vector_key).?;
    try std.testing.expect(try checkProfile(a, key, rec, sig, "skein.nexus") == null);
    try std.testing.expectEqualStrings("the record's domain is not localhost", (try checkProfile(a, key, rec, sig, "localhost")).?);
    var other = key[0..33].*;
    other[0] ^= 1;
    try std.testing.expectEqualStrings("the signature does not verify for the handle's key", (try checkProfile(a, &other, rec, sig, "skein.nexus")).?);
    var op: [36]u8 = undefined;
    for (0..32) |i| op[i] = 0xab;
    op[0] = 0x01;
    std.mem.writeInt(u32, op[32..36], 7, .little);
    try std.testing.expectEqualStrings("ababababababababababababababababababababababababababababababab01_7", (try outpointText(a, &op)).?);
    try std.testing.expectEqualStrings("YWJj", try base64(a, "abc"));
    try std.testing.expectEqualStrings("abc", unbase64(a, "YWJj").?);
}

test "the configuration: the domain and origin, defaults" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const none = try configFrom(a, try dagjson.decode(a, "{\"kind\":\"app\"}"));
    try std.testing.expectEqualStrings("localhost", none.domain);
    try std.testing.expectEqualStrings("https://localhost", none.origin);
    try std.testing.expectEqualStrings(ORDFS_CONTENT, none.ordfs);
    const set = try configFrom(a, try dagjson.decode(a, "{\"config\":{\"onboard\":{\"domain\":\"Skein.Nexus\",\"origin\":\"http://127.0.0.1:8100/\",\"name\":\"\",\"ordfs\":\"\"}}}"));
    try std.testing.expectEqualStrings("skein.nexus", set.domain);
    try std.testing.expectEqualStrings("http://127.0.0.1:8100", set.origin);
    try std.testing.expect(set.name == null);
    try std.testing.expectEqualStrings("", set.ordfs);
}
