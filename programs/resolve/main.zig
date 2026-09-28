//! resolve (#40): the instance's peer table, written only by its own
//! programs. BRC-169 is discovery: a handle → the identity key and the
//! messagebox URL the handle's domain publishes, looked up as recorded `http`
//! calls (replay reads them back). The table is the head `peers`:
//! {kind: "peers", peers: [{key, peer: <cid>}]} (sorted by key), each
//! {kind: "peer", key, url, handle?, domain?, since, source}. A later record
//! for the same key replaces it (a party that moved hosts). Handle and URL are
//! only for delivering; peers are known by key.
//!
//! Called from a step (an in-VM call: the messagebox's `send` on first
//! contact, the loop's `message` tool):
//!   resolve {handle, domain, key?} → the peer record (written with the step);
//!     `key`: the identity the caller expects — another answer is refused.
//! Stepped (messages routed here by subscriptions):
//!   box `peers` (the owner, the admin): {op: "add", key, url, handle?, domain?} | {op: "remove", key}
//!   box `register` (anyone): a claim {handle, domain} — or a BRC-169
//!     envelope, whose sender's handle and domain are the claim. The claim is
//!     resolved; the record is written only if it resolves to the sender (the
//!     session proved the key; only a resolve proves the host).
//!
//! Where a domain is looked up: `https://<domain>`, except the instance's own
//! domain when the genesis sets `defaults.resolveOrigin` (a dev host). The
//! manifest (`/manifest.json`, `metanet.handles.resolve`, default
//! `/.well-known/metanet-handles/resolve`) then `GET <resolve>?handle=<handle>`
//! → {identityKey, messagebox, …}. The BRC-52 certificate is not checked here
//! (recorded in the answer, `unchecked`).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const dagjson = @import("dagjson");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const PEERS = "peers";

pub fn main() u8 {
    return sk.main("resolve", run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "step")) return step(a, in);
    if (!eql(u8, kind, "call")) return sk.report("resolve is called or stepped");
    const func = Value.str(in.get("fn")) orelse "";
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("the argument is not dag-cbor");
    if (!eql(u8, func, "resolve")) return sk.report("unknown fn (resolve answers \"resolve\")");
    const stepv = in.get("step") orelse return sk.report("resolve writes the peer table: call it from a step");
    const at = Value.intOf(stepv.get("at")) orelse 0;
    const handle = Value.str(arg.get("handle")) orelse return sk.report("resolve wants {handle, domain, key?}");
    const domain = Value.str(arg.get("domain")) orelse return sk.report("resolve wants {handle, domain, key?}");
    const p = try lookup(a, in, handle, domain);
    if (Value.bytesOf(arg.get("key"))) |want| if (!eql(u8, want, p.key)) {
        return sk.report(try std.fmt.allocPrint(a, "@{s}@{s} resolves to {s}, not the identity expected", .{ handle, domain, try sk.hex(a, p.key) }));
    };
    const rec = try writePeer(a, p.key, p.url, handle, domain, at, "resolve");
    try sk.answer(a, rec);
}

const Found = struct { key: []const u8, url: []const u8 };

fn originOf(a: Allocator, in: Value, domain: []const u8) ![]const u8 {
    const self: Value = in.get("self") orelse .null;
    if (eql(u8, Value.str(self.get("domain")) orelse "", domain)) {
        if (in.get("defaults")) |d| if (Value.str(d.get("resolveOrigin"))) |o| if (o.len > 0) return std.mem.trimRight(u8, o, "/");
    }
    return std.fmt.allocPrint(a, "https://{s}", .{domain});
}

fn get(a: Allocator, url: []const u8) !Value {
    var req = cbor.MapBuilder.init(a);
    try req.put("method", cbor.string("GET"));
    try req.put("url", cbor.string(url));
    return sk.http(a, req.value()) catch |err| {
        if (err == error.ImportFailed) return sk.report(try std.fmt.allocPrint(a, "transient: {s}: {s}", .{ url, sk.lastError() }));
        return err;
    };
}

fn jsonOf(a: Allocator, r: Value) ?std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, a, Value.bytesOf(r.get("body")) orelse "", .{}) catch null;
}

/// A BRC-169 lookup: the manifest, then the resolution endpoint (both recorded calls in a step).
fn lookup(a: Allocator, in: Value, handle: []const u8, domain: []const u8) !Found {
    const origin = try originOf(a, in, domain);
    var resolve_url: []const u8 = try std.fmt.allocPrint(a, "{s}/.well-known/metanet-handles/resolve", .{origin});
    var default_box: ?[]const u8 = null;
    const m = try get(a, try std.fmt.allocPrint(a, "{s}/manifest.json", .{origin}));
    if ((Value.intOf(m.get("status")) orelse 0) == 200) if (jsonOf(a, m)) |j| {
        if (j == .object) if (j.object.get("metanet")) |mn| if (mn == .object) if (mn.object.get("handles")) |h| if (h == .object) {
            if (h.object.get("resolve")) |r| if (r == .string) {
                resolve_url = r.string;
            };
            if (h.object.get("messagebox")) |b| if (b == .string) {
                default_box = b.string;
            };
        };
    };
    const r = try get(a, try std.fmt.allocPrint(a, "{s}?handle={s}", .{ resolve_url, handle }));
    const status = Value.intOf(r.get("status")) orelse 0;
    if (status != 200) return sk.report(try std.fmt.allocPrint(a, "{s}@{s}@{s} does not resolve (HTTP {d})", .{ if (status >= 500) "transient: " else "", handle, domain, status }));
    const j = jsonOf(a, r) orelse return sk.report("the resolution is not JSON");
    if (j != .object) return sk.report("the resolution is not an object");
    const ik = j.object.get("identityKey") orelse return sk.report("the resolution names no identityKey");
    const key = if (ik == .string) sk.unhex(a, ik.string) orelse return sk.report("the resolution's identityKey is not hex") else return sk.report("the resolution's identityKey is not a string");
    if (!sk.isKey(key)) return sk.report("the resolution's identityKey is not a key");
    var url = default_box;
    if (j.object.get("messagebox")) |b| if (b == .string) {
        url = b.string;
    };
    return .{ .key = key, .url = url orelse return sk.report(try std.fmt.allocPrint(a, "@{s}@{s} names no messagebox", .{ handle, domain })) };
}

/// Write (or replace) the peer record for `key`; null url removes it.
fn writePeer(a: Allocator, key: []const u8, url: ?[]const u8, handle: ?[]const u8, domain: ?[]const u8, at: i128, source: []const u8) !Value {
    var list: std.ArrayList(Value) = .empty;
    if (try sk.head(a, PEERS)) |root| {
        const r = try sk.get(a, root);
        if (r.get("peers")) |ps| if (ps == .array) for (ps.array) |x| {
            if (!eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) try list.append(a, x);
        };
    }
    var rec = cbor.MapBuilder.init(a);
    if (url) |u| {
        try rec.put("kind", cbor.string("peer"));
        try rec.put("key", .{ .bytes = key });
        try rec.put("url", cbor.string(u));
        try rec.put("handle", cbor.optStr(handle));
        try rec.put("domain", cbor.optStr(domain));
        try rec.put("since", cbor.int(at));
        try rec.put("source", cbor.string(source));
        var e = cbor.MapBuilder.init(a);
        try e.put("key", .{ .bytes = key });
        try e.put("peer", cbor.cidv(try sk.put(a, rec.value())));
        try list.append(a, e.value());
    }
    std.mem.sort(Value, list.items, {}, struct {
        fn lt(_: void, x: Value, y: Value) bool {
            return std.mem.order(u8, Value.bytesOf(x.get("key")) orelse "", Value.bytesOf(y.get("key")) orelse "") == .lt;
        }
    }.lt);
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("peers"));
    try root.put("peers", .{ .array = list.items });
    try sk.advance(PEERS, try sk.put(a, root.value()));
    return rec.value();
}

fn keyOf(a: Allocator, v: ?Value) ?[]const u8 {
    const x = v orelse return null;
    if (Value.bytesOf(x)) |b| return if (sk.isKey(b)) b else null;
    if (Value.str(x)) |s| {
        const b = sk.unhex(a, s) orelse return null;
        return if (sk.isKey(b)) b else null;
    }
    return null;
}

fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const at = Value.intOf(in.get("at")) orelse 0;
    const box = Value.str(args.get("box")) orelse "";
    const sender = Value.bytesOf(args.get("sender")) orelse return sk.report("a message has a sender");
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("no body"));
    if (eql(u8, box, "register")) {
        // A claim: {handle, domain}, or a BRC-169 envelope (its sender's handle and domain).
        var claim = body;
        if (body.get("sender")) |s| if (s == .map) {
            claim = s;
        };
        const handle = Value.str(claim.get("handle")) orelse return sk.report("a claim names a handle");
        const domain = Value.str(claim.get("domain")) orelse return sk.report("a claim names a domain");
        const p = try lookup(a, in, handle, domain);
        if (!eql(u8, p.key, sender)) return sk.report(try std.fmt.allocPrint(a, "the claim @{s}@{s} resolves to another identity: not recorded", .{ handle, domain }));
        _ = try writePeer(a, p.key, p.url, handle, domain, at, "claim");
        return;
    }
    // The admin's box.
    const op = Value.str(body.get("op")) orelse return sk.report("peers wants {op: add|remove, key, url?, handle?, domain?}");
    const key = keyOf(a, body.get("key")) orelse return sk.report("peers: `key` is not an identity key");
    if (eql(u8, op, "remove")) {
        _ = try writePeer(a, key, null, null, null, at, "admin");
        return;
    }
    if (!eql(u8, op, "add")) return sk.report("peers: op is add or remove");
    const url = Value.str(body.get("url")) orelse return sk.report("peers add wants a url");
    _ = try writePeer(a, key, url, Value.str(body.get("handle")), Value.str(body.get("domain")), at, "admin");
}
