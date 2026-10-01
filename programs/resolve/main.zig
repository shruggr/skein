//! resolve (#40, #70): the instance's address book, written only by its own
//! programs. BRC-169 is discovery: a handle → the identity key and the
//! messagebox URL the handle's domain publishes. The lookup is a thread
//! (#67: external communication is a thread): each GET goes through the
//! `fetch` provider (an emit), and its answer is the entry that steps the
//! thread again. The table is the head `peers`: {kind: "peers", peers:
//! [{key, peer: <cid>}]} (sorted by key), each {kind: "peer", key,
//! transport, address, role?, handle?, domain?, since, source} (#70: a
//! resolved handle is `transport: "mailbox"`, `address` its messagebox URL).
//! A later record for the same key replaces it (a party that moved hosts).
//!
//! Launched (`sk.launchResolve`: args {handle, domain, key?}): the lookup;
//!   it finishes with the peer record as its stdout, having written it, or
//!   errors ("transient: …" when no answer came, or a 5xx). `key`: the
//!   identity the launcher expects — another answer is refused.
//! Stepped on messages a dispatch row sends here (#77: the admin's `peers`
//! box is the kernel's own operation now, not this program's; writing the
//! head `peers` — one of the kernel's tables — from a lookup is a transitional
//! grant in the genesis's `scopes`, STOCK_SCOPES resolve → peers, to review):
//!   box `register`, only where an application wires it (#40: the stock
//!     genesis does not): a claim {handle, domain} — or a BRC-169 envelope,
//!     whose sender's handle and domain are the claim — resolved; the record
//!     is written only if it resolves to the sender.
//!
//!   step: the manifest   GET <origin>/manifest.json (`metanet.handles.resolve`,
//!                        default <origin>/.well-known/metanet-handles/resolve)
//!   step: the resolution GET <resolve>?handle=<handle> → {identityKey, messagebox, …}
//!   step: written        the peer record (source `resolve` or `claim`)
//!
//! Where a domain is looked up: `https://<domain>`, except the instance's own
//! domain when the genesis sets `defaults.resolveOrigin` (a dev host). The
//! BRC-52 certificate is not checked here.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

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
    if (eql(u8, kind, "call")) return sk.report("resolve is a thread (#67): launch it (sk.launchResolve) with {handle, domain, key?}");
    if (!eql(u8, kind, "step")) return sk.report("resolve is stepped");
    return step(a, in);
}

fn originOf(a: Allocator, in: Value, domain: []const u8) ![]const u8 {
    const self: Value = in.get("self") orelse .null;
    if (eql(u8, Value.str(self.get("domain")) orelse "", domain)) {
        if (in.get("defaults")) |d| if (Value.str(d.get("resolveOrigin"))) |o| if (o.len > 0) return std.mem.trimEnd(u8, o, "/");
    }
    return std.fmt.allocPrint(a, "https://{s}", .{domain});
}

fn jsonOf(a: Allocator, body: []const u8) ?std.json.Value {
    return std.json.parseFromSliceLeaky(std.json.Value, a, body, .{}) catch null;
}

/// Write (or replace) the peer record for `key`; null address removes it.
fn writePeer(a: Allocator, key: []const u8, transport: []const u8, address: ?[]const u8, role: ?[]const u8, handle: ?[]const u8, domain: ?[]const u8, at: i128, source: []const u8) !Value {
    var list: std.ArrayList(Value) = .empty;
    if (try sk.head(a, PEERS)) |root| {
        const r = try sk.get(a, root);
        if (r.get("peers")) |ps| if (ps == .array) for (ps.array) |x| {
            if (!eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) try list.append(a, x);
        };
    }
    var rec = cbor.MapBuilder.init(a);
    if (address) |u| {
        try rec.put("kind", cbor.string("peer"));
        try rec.put("key", .{ .bytes = key });
        try rec.put("transport", cbor.string(transport));
        try rec.put("address", cbor.string(u));
        try rec.put("role", cbor.optStr(role));
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

/// The thread's state, as its last step wrote it (stdout), or null on its first step.
fn saved(a: Allocator, in: Value) !?Value {
    const tip = Value.cidOf(in.get("tip")) orelse return null;
    const u = try sk.get(a, tip);
    const res = u.get("result") orelse return null;
    const out = cbor.decode(a, Value.bytesOf(res.get("stdout")) orelse "") catch return null;
    return if (out == .map) out else null;
}

/// A lookup's state, carried from step to step (stdout).
const Lookup = struct {
    handle: []const u8,
    domain: []const u8,
    /// The identity the launcher expects, or (a claim) the sender, whom it must resolve to.
    key: ?[]const u8 = null,
    source: []const u8 = "resolve",
    resolve_url: []const u8 = "",
    default_box: ?[]const u8 = null,

    fn out(l: Lookup, a: Allocator, stage: []const u8) !void {
        var m = cbor.MapBuilder.init(a);
        try m.put("stage", cbor.string(stage));
        try m.put("handle", cbor.string(l.handle));
        try m.put("domain", cbor.string(l.domain));
        if (l.key) |k| try m.put("key", .{ .bytes = k });
        try m.put("source", cbor.string(l.source));
        if (l.resolve_url.len > 0) try m.put("resolveUrl", cbor.string(l.resolve_url));
        try m.put("defaultBox", cbor.optStr(l.default_box));
        try sk.answer(a, m.value());
    }

    fn of(s: Value) Lookup {
        return .{
            .handle = Value.str(s.get("handle")) orelse "",
            .domain = Value.str(s.get("domain")) orelse "",
            .key = Value.bytesOf(s.get("key")),
            .source = Value.str(s.get("source")) orelse "resolve",
            .resolve_url = Value.str(s.get("resolveUrl")) orelse "",
            .default_box = Value.str(s.get("defaultBox")),
        };
    }
};

/// The first GET: the domain's manifest.
fn begin(a: Allocator, in: Value, l0: Lookup) !void {
    var l = l0;
    const origin = try originOf(a, in, l.domain);
    l.resolve_url = try std.fmt.allocPrint(a, "{s}/.well-known/metanet-handles/resolve", .{origin});
    _ = try sk.fetch(a, "GET", try std.fmt.allocPrint(a, "{s}/manifest.json", .{origin}), null, null);
    return l.out(a, "manifest");
}

fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const at = Value.intOf(in.get("at")) orelse 0;
    if (try saved(a, in)) |s| return answered(a, in, Lookup.of(s), Value.str(s.get("stage")) orelse "", at);
    // Launched: a lookup.
    if (Value.str(args.get("handle"))) |handle| {
        const domain = Value.str(args.get("domain")) orelse return sk.report("resolve wants {handle, domain, key?}");
        return begin(a, in, .{ .handle = handle, .domain = domain, .key = Value.bytesOf(args.get("key")) });
    }
    // A message routed here.
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
        return begin(a, in, .{ .handle = handle, .domain = domain, .key = sender, .source = "claim" });
    }
    return sk.report(try std.fmt.allocPrint(a, "resolve takes no messages in box {s} (the admin's `peers` box is the kernel's operation, #77)", .{box}));
}

/// A step on the fetch provider's answer.
fn answered(a: Allocator, in: Value, l0: Lookup, stage: []const u8, at: i128) !void {
    var l = l0;
    const r = (try sk.replyOf(a, in)) orelse return sk.report("resolve: stepped with no answer to go on with");
    if (Value.str(r.body.get("error"))) |e| return sk.report(try std.fmt.allocPrint(a, "transient: @{s}@{s}: {s}", .{ l.handle, l.domain, e }));
    const status = Value.intOf(r.body.get("status")) orelse 0;
    const body = Value.bytesOf(r.body.get("body")) orelse "";
    if (eql(u8, stage, "manifest")) {
        if (status == 200) if (jsonOf(a, body)) |j| {
            if (j == .object) if (j.object.get("metanet")) |mn| if (mn == .object) if (mn.object.get("handles")) |h| if (h == .object) {
                if (h.object.get("resolve")) |x| if (x == .string) {
                    l.resolve_url = x.string;
                };
                if (h.object.get("messagebox")) |b| if (b == .string) {
                    l.default_box = b.string;
                };
            };
        };
        _ = try sk.fetch(a, "GET", try std.fmt.allocPrint(a, "{s}?handle={s}", .{ l.resolve_url, l.handle }), null, null);
        return l.out(a, "resolve");
    }
    if (!eql(u8, stage, "resolve")) return sk.report("resolve: an answer in no stage");
    if (status != 200) return sk.report(try std.fmt.allocPrint(a, "{s}@{s}@{s} does not resolve (HTTP {d})", .{ if (status >= 500) "transient: " else "", l.handle, l.domain, status }));
    const j = jsonOf(a, body) orelse return sk.report("the resolution is not JSON");
    if (j != .object) return sk.report("the resolution is not an object");
    const ik = j.object.get("identityKey") orelse return sk.report("the resolution names no identityKey");
    const key = if (ik == .string) sk.unhex(a, ik.string) orelse return sk.report("the resolution's identityKey is not hex") else return sk.report("the resolution's identityKey is not a string");
    if (!sk.isKey(key)) return sk.report("the resolution's identityKey is not a key");
    var url = l.default_box;
    if (j.object.get("messagebox")) |b| if (b == .string) {
        url = b.string;
    };
    const mailbox = url orelse return sk.report(try std.fmt.allocPrint(a, "@{s}@{s} names no messagebox", .{ l.handle, l.domain }));
    if (l.key) |want| if (!eql(u8, want, key)) {
        if (eql(u8, l.source, "claim")) return sk.report(try std.fmt.allocPrint(a, "the claim @{s}@{s} resolves to another identity: not recorded", .{ l.handle, l.domain }));
        return sk.report(try std.fmt.allocPrint(a, "@{s}@{s} resolves to {s}, not the identity expected", .{ l.handle, l.domain, try sk.hex(a, key) }));
    };
    const rec = try writePeer(a, key, "mailbox", mailbox, null, l.handle, l.domain, at, l.source);
    try sk.answer(a, rec);
}
