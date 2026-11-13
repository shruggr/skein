// Roles, grants and the gate (#143; skein next, SPEC.md section 3). Routing is the route table's
// (dispatch.zig); who may send what a row takes is the row's `role`, checked here.
//
// A role is a name, held by keys. Every request and read row names one:
//
//   anyone          no proven sender required (a content-proven arrival, an open read)
//   user            any proven sender
//   root            the keys holding `root` — just a role: the name written on the rows that change
//                   routes and grants. No bypass: root passes only a row that names root.
//   <app>.<role>    the keys holding it (the app record's `roles` map only declares the names)
//
// An event row names none (an event has no principal). The grants are kernel state, replay-derived:
// the head `grants` (the kernel's own — no `head` request and no program's `advance` reaches it),
// its root the record
//
//   {kind: "grants", roles: {<role>: [bytes(33) …]}, calls?, services?}   keys in byte order, no empty role
//
// written by the genesis's `grants` (the starting grants: whoever builds the image decides), the
// claim (root to the claimant) and the kernel's `grant` operation {op: "add" | "remove", role,
// principal} on a root row.
const std = @import("std");
const cbor = @import("cbor");
const secp = @import("secp");
const heads = @import("heads.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

/// The kernel's head (a bare name, reserved: no app is called `grants`).
pub const HEAD = "grants";
pub const ROOT = "root";
pub const USER = "user";
/// No proven sender required (a row's role only; never granted).
pub const ANYONE = "anyone";
/// The kernel's admin operation.
pub const OP = "grant";

/// Whether `role` may be granted: `root`, or `<app>.<role>` (`user` and `anyone` are never granted).
pub fn isGrantable(role: []const u8) bool {
    if (std.mem.eql(u8, role, ROOT)) return true;
    const dot = std.mem.indexOfScalar(u8, role, '.') orelse return false;
    return isName(role[0..dot]) and isName(role[dot + 1 ..]);
}

/// An app's or a role's name: [a-z0-9][a-z0-9_-]* (the manifest's names; no dot).
pub fn isName(s: []const u8) bool {
    if (s.len == 0) return false;
    if (!std.ascii.isLower(s[0]) and !std.ascii.isDigit(s[0])) return false;
    for (s) |c| if (!(std.ascii.isLower(c) or std.ascii.isDigit(c) or c == '_' or c == '-')) return false;
    return true;
}

/// The grants record as the head names it, or null (no grant ever made).
pub fn load(a: std.mem.Allocator, s: Store) !?Value {
    const root = (try heads.headTree(a, s, HEAD)) orelse return null;
    const v = s.getOpt(a, root) orelse return null;
    if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", "grants")) return null;
    return v;
}

/// The holders of `role` in a grants record (none: an empty list).
pub fn holders(rec: ?Value, role: []const u8) []const Value {
    const r = rec orelse return &.{};
    const roles = r.get("roles") orelse return &.{};
    if (roles != .map) return &.{};
    const list = roles.get(role) orelse return &.{};
    if (list != .array) return &.{};
    return list.array;
}

/// Whether `key` holds `role`.
pub fn holds(rec: ?Value, role: []const u8, key: []const u8) bool {
    for (holders(rec, role)) |h| if (Value.bytesOf(h)) |b| if (std.mem.eql(u8, b, key)) return true;
    return false;
}

/// Whether anyone holds root (an unclaimed image: no one).
pub fn hasRoot(rec: ?Value) bool {
    return holders(rec, ROOT).len > 0;
}

fn lessKey(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

/// The record with `key` added to (or removed from) `role`; null when nothing changes.
pub fn changed(a: std.mem.Allocator, rec: ?Value, op: []const u8, role: []const u8, key: []const u8) !?Value {
    const add = std.mem.eql(u8, op, "add");
    if (add == holds(rec, role, key)) return null;
    // Every role as it stands, `role` changed; keys kept in byte order, an emptied role dropped.
    var names = std.array_list.Managed([]const u8).init(a);
    if (rec) |r| if (r.get("roles")) |rs| if (rs == .map) for (rs.map) |e| try names.append(e.key);
    var found = false;
    for (names.items) |n| found = found or std.mem.eql(u8, n, role);
    if (!found) try names.append(role);
    var roles = cbor.MapBuilder.init(a);
    for (names.items) |n| {
        var keys = std.array_list.Managed([]const u8).init(a);
        for (holders(rec, n)) |h| if (Value.bytesOf(h)) |b| {
            if (std.mem.eql(u8, n, role) and !add and std.mem.eql(u8, b, key)) continue;
            try keys.append(b);
        };
        if (std.mem.eql(u8, n, role) and add) try keys.append(key);
        if (keys.items.len == 0) continue;
        std.mem.sort([]const u8, keys.items, {}, lessKey);
        const vs = try a.alloc(Value, keys.items.len);
        for (keys.items, vs) |k, *v| v.* = .{ .bytes = k };
        try roles.put(n, .{ .array = vs });
    }
    return try rebuilt(a, rec, "roles", roles.value());
}

/// The record `rec` with `field` (roles, calls or services) set to `v` (null: dropped) and the others
/// carried over as they stand. A record with roles only encodes as it did before call permissions.
fn rebuilt(a: std.mem.Allocator, rec: ?Value, field: []const u8, v: ?Value) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("grants"));
    for ([_][]const u8{ "roles", "calls", "services" }) |k| {
        if (std.mem.eql(u8, k, field)) {
            try m.put(k, v);
        } else if (rec) |r| try m.put(k, r.get(k));
    }
    var has_roles = false;
    for (m.list.items) |e| has_roles = has_roles or std.mem.eql(u8, e.key, "roles");
    if (!has_roles) {
        var empty = cbor.MapBuilder.init(a);
        try m.put("roles", empty.value());
    }
    return m.value();
}

/// Grant or revoke under the entry `by`: the head moved to the new record; false when nothing changed.
pub fn apply(a: std.mem.Allocator, s: Store, op: []const u8, role: []const u8, key: []const u8, by: heads.By) !bool {
    const next = (try changed(a, try load(a, s), op, role, key)) orelse return false;
    _ = try heads.advanceHead(a, s, HEAD, try s.put(a, next), by);
    return true;
}

// ---------------------------------------------------------------- call permissions and kernel services
//
// Beside `roles`, the record holds who may call whom under which name, and who holds which
// kernel service:
//
//   calls?:    {<caller>: {<callee>: [<name> …]}}   names sorted, unique; "*" among them: any name
//   services?: {<caller>: [<service> …]}           sorted, unique; the one defined: "signer"
//
// A caller or callee is an installed app's name. Written by root's `grant` operation
// ({op, calls: {caller, callee, name}} / {op, service: {caller, service}}) and by the genesis's
// `calls` / `services` when it is processed. The kernel compares names byte for byte and never
// reads them.

/// Any name: an approval to call the callee under whatever name the call states.
pub const ANY = "*";
/// How long a call's name may be (bytes).
pub const MAX_NAME = 256;
/// The raw signer import (the `wallet` import), granted as a kernel service.
pub const SIGNER = "signer";
/// The kernel services that may be granted.
pub const services_known = [_][]const u8{SIGNER};

/// Whether `s` names a caller or callee: an app's name — the manifest's name grammar
/// (src/host/manifest.ts NAME): [a-z0-9][a-z0-9._-]*. (Roles keep `isName`, with no dot: a role is
/// `<app>.<role>`.) The record keys a party whole; nothing splits it.
pub fn isParty(s: []const u8) bool {
    return isAppName(s);
}

fn isAppName(s: []const u8) bool {
    if (s.len == 0) return false;
    if (!std.ascii.isLower(s[0]) and !std.ascii.isDigit(s[0])) return false;
    for (s) |c| if (!(std.ascii.isLower(c) or std.ascii.isDigit(c) or c == '.' or c == '_' or c == '-')) return false;
    return true;
}

/// Whether `s` may be a call's name: 1 to MAX_NAME bytes of UTF-8, no NUL.
pub fn isCallName(s: []const u8) bool {
    if (s.len == 0 or s.len > MAX_NAME) return false;
    if (std.mem.indexOfScalar(u8, s, 0) != null) return false;
    return std.unicode.utf8ValidateSlice(s);
}

/// Whether `s` is a kernel service that may be granted.
pub fn isService(s: []const u8) bool {
    for (services_known) |x| if (std.mem.eql(u8, x, s)) return true;
    return false;
}

fn listOf(v: ?Value) []const Value {
    const x = v orelse return &.{};
    return if (x == .array) x.array else &.{};
}

fn listHas(l: []const Value, item: []const u8) bool {
    for (l) |x| if (Value.str(x)) |t| if (std.mem.eql(u8, t, item)) return true;
    return false;
}

/// The names `caller` may call `callee` under (the record's list; "*" among them: any).
pub fn callNames(rec: ?Value, caller: []const u8, callee: []const u8) []const Value {
    const r = rec orelse return &.{};
    const calls = r.get("calls") orelse return &.{};
    if (calls != .map) return &.{};
    const by = calls.get(caller) orelse return &.{};
    if (by != .map) return &.{};
    return listOf(by.get(callee));
}

/// Whether `caller` may call `callee` under `name`.
pub fn mayCall(rec: ?Value, caller: []const u8, callee: []const u8, name: []const u8) bool {
    const l = callNames(rec, caller, callee);
    return listHas(l, name) or listHas(l, ANY);
}

/// Whether `caller` holds the kernel service `service`.
pub fn holdsService(rec: ?Value, caller: []const u8, service: []const u8) bool {
    const r = rec orelse return false;
    const sv = r.get("services") orelse return false;
    if (sv != .map) return false;
    return listHas(listOf(sv.get(caller)), service);
}

fn lessText(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

/// `l` with `item` added (or removed), sorted; null when nothing changes.
fn listChanged(a: std.mem.Allocator, l: []const Value, add: bool, item: []const u8) !?[]Value {
    if (add == listHas(l, item)) return null;
    var xs = std.array_list.Managed([]const u8).init(a);
    for (l) |x| if (Value.str(x)) |t| if (add or !std.mem.eql(u8, t, item)) try xs.append(t);
    if (add) try xs.append(item);
    std.mem.sort([]const u8, xs.items, {}, lessText);
    const out = try a.alloc(Value, xs.items.len);
    for (xs.items, out) |t, *o| o.* = cbor.string(t);
    return out;
}

/// The map `m` (text keys) with `key` set to `v` (null or an empty list/map: dropped); null if empty.
fn mapWith(a: std.mem.Allocator, m: ?Value, key: []const u8, v: ?Value) !?Value {
    var b = cbor.MapBuilder.init(a);
    if (m) |x| if (x == .map) for (x.map) |e| if (!std.mem.eql(u8, e.key, key)) try b.put(e.key, e.value);
    if (v) |x| {
        const empty = (x == .array and x.array.len == 0) or (x == .map and x.map.len == 0);
        if (!empty) try b.put(key, x);
    }
    if (b.list.items.len == 0) return null;
    return b.value();
}

/// The record with `name` added to (or removed from) what `caller` may call `callee` under; null
/// when nothing changes.
pub fn callsChanged(a: std.mem.Allocator, rec: ?Value, op: []const u8, caller: []const u8, callee: []const u8, name: []const u8) !?Value {
    const add = std.mem.eql(u8, op, "add");
    const next = (try listChanged(a, callNames(rec, caller, callee), add, name)) orelse return null;
    const calls: ?Value = if (rec) |r| r.get("calls") else null;
    const by: ?Value = if (calls) |c| (if (c == .map) c.get(caller) else null) else null;
    const by2 = try mapWith(a, by, callee, .{ .array = next });
    return try rebuilt(a, rec, "calls", try mapWith(a, calls, caller, by2));
}

/// The record with `service` granted to (or taken from) `caller`; null when nothing changes.
pub fn serviceChanged(a: std.mem.Allocator, rec: ?Value, op: []const u8, caller: []const u8, service: []const u8) !?Value {
    const add = std.mem.eql(u8, op, "add");
    const sv: ?Value = if (rec) |r| r.get("services") else null;
    const cur: []const Value = if (sv) |x| (if (x == .map) listOf(x.get(caller)) else &.{}) else &.{};
    const next = (try listChanged(a, cur, add, service)) orelse return null;
    return try rebuilt(a, rec, "services", try mapWith(a, sv, caller, .{ .array = next }));
}

/// A call approval under the entry `by`; false when nothing changed.
pub fn applyCalls(a: std.mem.Allocator, s: Store, op: []const u8, caller: []const u8, callee: []const u8, name: []const u8, by: heads.By) !bool {
    const next = (try callsChanged(a, try load(a, s), op, caller, callee, name)) orelse return false;
    _ = try heads.advanceHead(a, s, HEAD, try s.put(a, next), by);
    return true;
}

/// A kernel service grant under the entry `by`; false when nothing changed.
pub fn applyService(a: std.mem.Allocator, s: Store, op: []const u8, caller: []const u8, service: []const u8, by: heads.By) !bool {
    const next = (try serviceChanged(a, try load(a, s), op, caller, service)) orelse return false;
    _ = try heads.advanceHead(a, s, HEAD, try s.put(a, next), by);
    return true;
}

// ---------------------------------------------------------------- the gate

pub const Verdict = enum {
    pass,
    /// the role needs a proven sender, and there is none (fail closed)
    no_principal,
    /// the principal does not hold the role
    not_granted,
};

/// The gate: `role` the row's (anyone, user, root, <app>.<role>); `principal` the proven sender,
/// if any. No bypass: a key passes a role only by holding that role.
pub fn gate(rec: ?Value, role: []const u8, principal: ?[]const u8) Verdict {
    if (std.mem.eql(u8, role, ANYONE)) return .pass;
    const p = principal orelse return .no_principal;
    if (std.mem.eql(u8, role, USER)) return .pass;
    return if (holds(rec, role, p)) .pass else .not_granted;
}

/// A key given as bytes or hex (a JSON-era client's), if it is an identity key.
pub fn keyOf(a: std.mem.Allocator, v: ?Value) ?[]const u8 {
    const x = v orelse return null;
    if (Value.bytesOf(x)) |b| return if (secp.isKey(b)) b else null;
    const s = Value.str(x) orelse return null;
    if (s.len != 66) return null;
    const out = a.alloc(u8, 33) catch return null;
    _ = std.fmt.hexToBytes(out, s) catch return null;
    return if (secp.isKey(out)) out else null;
}

test "grants: add and remove keep keys in order and drop an emptied role" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const k1 = [_]u8{2} ++ [_]u8{1} ** 32;
    const k2 = [_]u8{3} ++ [_]u8{2} ** 32;
    var rec: ?Value = null;
    rec = (try changed(a, rec, "add", ROOT, &k2)).?;
    rec = (try changed(a, rec, "add", ROOT, &k1)).?;
    try std.testing.expect((try changed(a, rec, "add", ROOT, &k1)) == null); // granted already: no change
    const rs = holders(rec, ROOT);
    try std.testing.expectEqual(@as(usize, 2), rs.len);
    try std.testing.expectEqualSlices(u8, &k1, Value.bytesOf(rs[0]).?);
    rec = (try changed(a, rec, "add", "amm.admin", &k2)).?;
    try std.testing.expect(holds(rec, "amm.admin", &k2));
    rec = (try changed(a, rec, "remove", "amm.admin", &k2)).?;
    try std.testing.expect(rec.?.get("roles").?.get("amm.admin") == null);
    try std.testing.expect((try changed(a, rec, "remove", "amm.admin", &k2)) == null);
    try std.testing.expect(hasRoot(rec));
    try std.testing.expect(!hasRoot(null));
}

test "the gate: anyone passes, user any principal, root and an app role their holders only — no root bypass" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const root = [_]u8{2} ++ [_]u8{1} ** 32;
    const admin = [_]u8{3} ++ [_]u8{2} ** 32;
    const stranger = [_]u8{2} ++ [_]u8{9} ** 32;
    var rec = (try changed(a, null, "add", ROOT, &root)).?;
    rec = (try changed(a, rec, "add", "amm.admin", &admin)).?;
    // anyone: with or without a principal.
    try std.testing.expectEqual(Verdict.pass, gate(rec, ANYONE, null));
    try std.testing.expectEqual(Verdict.pass, gate(rec, ANYONE, &stranger));
    // An app role: its holders.
    try std.testing.expectEqual(Verdict.pass, gate(rec, "amm.admin", &admin));
    try std.testing.expectEqual(Verdict.not_granted, gate(rec, "amm.admin", &stranger));
    try std.testing.expectEqual(Verdict.no_principal, gate(rec, "amm.admin", null));
    // Root is just a role: it does not pass another role's row.
    try std.testing.expectEqual(Verdict.not_granted, gate(rec, "amm.admin", &root));
    try std.testing.expectEqual(Verdict.pass, gate(rec, ROOT, &root));
    try std.testing.expectEqual(Verdict.not_granted, gate(rec, ROOT, &admin));
    // user: any principal; none fails closed.
    try std.testing.expectEqual(Verdict.pass, gate(rec, USER, &stranger));
    try std.testing.expectEqual(Verdict.no_principal, gate(rec, USER, null));
    // No grants at all (an unclaimed image): a root row runs for no one.
    try std.testing.expectEqual(Verdict.not_granted, gate(null, ROOT, &root));
    try std.testing.expect(isGrantable("root") and isGrantable("amm.admin"));
    try std.testing.expect(!isGrantable("user") and !isGrantable("anyone") and !isGrantable("admin"));
}

test "call permissions: names per (caller, callee), any, removal, and roles kept apart" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const k1 = [_]u8{2} ++ [_]u8{1} ** 32;
    var rec: ?Value = (try changed(a, null, "add", ROOT, &k1)).?;
    const roots_only = try cbor.encode(a, rec.?);
    rec = (try callsChanged(a, rec, "add", "amm", "signer", "1/amm pool")).?;
    rec = (try callsChanged(a, rec, "add", "amm", "signer", "1/amm commission")).?;
    try std.testing.expect((try callsChanged(a, rec, "add", "amm", "signer", "1/amm pool")) == null);
    try std.testing.expect(mayCall(rec, "amm", "signer", "1/amm pool"));
    try std.testing.expect(!mayCall(rec, "amm", "signer", "1/amm poo"));
    try std.testing.expect(!mayCall(rec, "amm", "wallet", "1/amm pool"));
    try std.testing.expect(!mayCall(rec, "swap", "signer", "1/amm pool"));
    const names = callNames(rec, "amm", "signer");
    try std.testing.expectEqualStrings("1/amm commission", Value.str(names[0]).?); // sorted
    rec = (try callsChanged(a, rec, "add", "swap", "signer", ANY)).?;
    try std.testing.expect(mayCall(rec, "swap", "signer", "anything at all"));
    // Roles still work beside calls, and survive a calls change.
    try std.testing.expect(hasRoot(rec));
    rec = (try changed(a, rec, "add", "amm.admin", &k1)).?;
    try std.testing.expect(mayCall(rec, "amm", "signer", "1/amm pool"));
    // Removing every name drops the caller; removing every caller drops `calls`.
    rec = (try callsChanged(a, rec, "remove", "amm", "signer", "1/amm pool")).?;
    rec = (try callsChanged(a, rec, "remove", "amm", "signer", "1/amm commission")).?;
    try std.testing.expect(rec.?.get("calls").?.get("amm") == null);
    rec = (try callsChanged(a, rec, "remove", "swap", "signer", ANY)).?;
    try std.testing.expect(rec.?.get("calls") == null);
    rec = (try changed(a, rec, "remove", "amm.admin", &k1)).?;
    try std.testing.expectEqualSlices(u8, roots_only, try cbor.encode(a, rec.?)); // as it was: roles only
    try std.testing.expect(isParty("amm") and !isParty("genesis:frontdoor") and !isParty("Amm"));
    try std.testing.expect(isParty("foo.bar") and isParty("wire-probe") and !isParty("foo bar") and !isParty(".foo"));
    // Removing "*" leaves the explicit names.
    var r2: ?Value = (try callsChanged(a, null, "add", "amm", "signer", "1/amm pool")).?;
    r2 = (try callsChanged(a, r2, "add", "amm", "signer", ANY)).?;
    r2 = (try callsChanged(a, r2, "remove", "amm", "signer", ANY)).?;
    try std.testing.expect(mayCall(r2, "amm", "signer", "1/amm pool"));
    try std.testing.expect(!mayCall(r2, "amm", "signer", "anything else"));
    try std.testing.expect(isCallName("1/amm pool") and !isCallName("") and !isCallName("a\x00b"));
}

test "kernel services: granted per caller, only known ones" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var rec: ?Value = (try serviceChanged(a, null, "add", "swap", SIGNER)).?;
    try std.testing.expect(holdsService(rec, "swap", SIGNER));
    try std.testing.expect(!holdsService(rec, "wallet", SIGNER));
    try std.testing.expect(!holdsService(null, "swap", SIGNER));
    try std.testing.expect((try serviceChanged(a, rec, "add", "swap", SIGNER)) == null);
    try std.testing.expect(rec.?.get("roles") != null); // a grants record always has its roles map
    rec = (try serviceChanged(a, rec, "remove", "swap", SIGNER)).?;
    try std.testing.expect(!holdsService(rec, "swap", SIGNER));
    try std.testing.expect(rec.?.get("services") == null);
    try std.testing.expect(isService("signer") and !isService("http"));
}
