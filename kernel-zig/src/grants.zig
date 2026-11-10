// Roles, grants and the gate (#143). Routing is the route table's
// (dispatch.zig); who may run a function is this file's.
//
// A role is a name. The standard roles: `root` — Unix semantics, it passes
// every check (any function, any route, any grant; several holders) — and
// `user`, any principal at all (a request an identity filter let through).
// An app's roles are declared in its manifest, each listing the functions it
// gates (the app record's `roles: {<role>: [<fn>…]}`, a standard role usable
// there by name) and granted as `<app>.<role>`. A genesis's own programs'
// functions are gated by the genesis's `roles: {<role>: ["<program>.<fn>"…]}`
// (the explorer: `{root: ["frontdoor.explore"]}`). "An individual key is a
// role with one holder": there is no other way to name a key.
//
// The grants are kernel state, replay-derived: the head `grants` (the
// kernel's own — no `head` message and no program's `advance` reaches it),
// its root the record
//
//   {kind: "grants", roles: {<role>: [bytes(33) …]}}      keys in byte order, no empty role
//
// written by the genesis's `root` (the initial root holders), the claim (root
// to the claimant, #89/#127) and the kernel's admin operation `grant` {op:
// "add" | "remove", role, principal} — gated by root, as every admin
// operation is (v1: only root grants).
//
// The gate (the dispatcher's, scheduler.zig): the route matched, its filters
// run, the principal they yielded is checked against the roles that gate the
// handler's function — root passes anything; `user` passes any principal;
// an app role passes its holders; no principal fails closed — and only then
// does the handler run as the logged step. A function no role gates is open
// to whatever the route's filters let through.
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
/// The kernel's admin operation.
pub const OP = "grant";

/// Whether `role` may be granted: `root`, or `<app>.<role>` (`user` is any principal, never granted).
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
// A caller or callee is an installed app's name, or `genesis:<program name>` for a genesis-wired
// program (or a program a dispatch row names with no app). Written by root's `grant` operation
// ({op, calls: {caller, callee, name}} / {op, service: {caller, service}}) and by the genesis's
// `calls` / `services` when it is processed. The kernel compares names byte for byte and never
// reads them.

/// Any name: an approval to call the callee under whatever name the call states.
pub const ANY = "*";
/// How long a call's name may be (bytes).
pub const MAX_NAME = 256;
/// A genesis-wired program's party name: `genesis:<its name>`.
pub const GENESIS_PREFIX = "genesis:";
/// The raw signer import (the `wallet` import), granted as a kernel service.
pub const SIGNER = "signer";
/// The kernel services that may be granted.
pub const services_known = [_][]const u8{SIGNER};

/// Whether `s` names a caller or callee: an app's name, or `genesis:<program name>`.
pub fn isParty(s: []const u8) bool {
    if (std.mem.startsWith(u8, s, GENESIS_PREFIX)) return isName(s[GENESIS_PREFIX.len..]);
    return isName(s);
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
    /// gated, and the filters yielded no principal (fail closed)
    no_principal,
    /// gated, and the principal holds none of the roles
    not_granted,
};

/// The gate: `gating` the roles that gate the function (full names: root, user, <app>.<role>);
/// `principal` what the filters yielded. Root passes anything.
pub fn gate(rec: ?Value, gating: []const []const u8, principal: ?[]const u8) Verdict {
    if (gating.len == 0) return .pass;
    const p = principal orelse return .no_principal;
    if (holds(rec, ROOT, p)) return .pass;
    for (gating) |role| {
        if (std.mem.eql(u8, role, USER)) return .pass;
        if (std.mem.eql(u8, role, ROOT)) continue;
        if (holds(rec, role, p)) return .pass;
    }
    return .not_granted;
}

/// The roles that gate `func` in a role map {<role>: [<fn>…]} (an app record's `roles`, or the
/// genesis's with each fn as `<program>.<fn>`). `app`: an app's own role names are `<app>.<role>`
/// (a standard role is itself); null: the map's names are full already (the genesis's).
pub fn gatingRoles(a: std.mem.Allocator, roles: ?Value, app: ?[]const u8, func: []const u8) ![]const []const u8 {
    const m = roles orelse return &.{};
    if (m != .map) return &.{};
    var out = std.array_list.Managed([]const u8).init(a);
    for (m.map) |e| {
        if (e.value != .array) continue;
        var gates = false;
        for (e.value.array) |f| if (Value.str(f)) |s| if (std.mem.eql(u8, s, func)) {
            gates = true;
        };
        if (!gates) continue;
        const standard = std.mem.eql(u8, e.key, ROOT) or std.mem.eql(u8, e.key, USER);
        try out.append(if (standard or app == null) e.key else try std.fmt.allocPrint(a, "{s}.{s}", .{ app.?, e.key }));
    }
    return out.items;
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

test "the gate: root passes anything, user any principal, an app role its holders; no principal fails closed" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const root = [_]u8{2} ++ [_]u8{1} ** 32;
    const admin = [_]u8{3} ++ [_]u8{2} ** 32;
    const stranger = [_]u8{2} ++ [_]u8{9} ** 32;
    var rec = (try changed(a, null, "add", ROOT, &root)).?;
    rec = (try changed(a, rec, "add", "amm.admin", &admin)).?;
    // Ungated: open to whatever the filters let through, a principal or none.
    try std.testing.expectEqual(Verdict.pass, gate(rec, &.{}, null));
    try std.testing.expectEqual(Verdict.pass, gate(rec, &.{}, &stranger));
    // An app role.
    const by_admin = [_][]const u8{"amm.admin"};
    try std.testing.expectEqual(Verdict.pass, gate(rec, &by_admin, &admin));
    try std.testing.expectEqual(Verdict.not_granted, gate(rec, &by_admin, &stranger));
    try std.testing.expectEqual(Verdict.no_principal, gate(rec, &by_admin, null));
    // Root bypasses every role.
    try std.testing.expectEqual(Verdict.pass, gate(rec, &by_admin, &root));
    const root_only = [_][]const u8{ROOT};
    try std.testing.expectEqual(Verdict.pass, gate(rec, &root_only, &root));
    try std.testing.expectEqual(Verdict.not_granted, gate(rec, &root_only, &admin));
    // user: any principal; none fails closed.
    const users = [_][]const u8{USER};
    try std.testing.expectEqual(Verdict.pass, gate(rec, &users, &stranger));
    try std.testing.expectEqual(Verdict.no_principal, gate(rec, &users, null));
    // No grants at all (an unclaimed image): a gated function runs for no one.
    try std.testing.expectEqual(Verdict.not_granted, gate(null, &root_only, &root));
}

test "gating roles: an app's role names are <app>.<role>; the standard ones are themselves" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var roles = cbor.MapBuilder.init(a);
    try roles.put("admin", .{ .array = try a.dupe(Value, &.{ cbor.string("config"), cbor.string("pause") }) });
    try roles.put("user", .{ .array = try a.dupe(Value, &.{cbor.string("call")}) });
    const config = try gatingRoles(a, roles.value(), "amm", "config");
    try std.testing.expectEqual(@as(usize, 1), config.len);
    try std.testing.expectEqualStrings("amm.admin", config[0]);
    try std.testing.expectEqualStrings("user", (try gatingRoles(a, roles.value(), "amm", "call"))[0]);
    try std.testing.expectEqual(@as(usize, 0), (try gatingRoles(a, roles.value(), "amm", "quote")).len);
    try std.testing.expect(isGrantable("root"));
    try std.testing.expect(isGrantable("amm.admin"));
    try std.testing.expect(!isGrantable("user"));
    try std.testing.expect(!isGrantable("admin"));
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
    rec = (try callsChanged(a, rec, "add", "genesis:frontdoor", "signer", ANY)).?;
    try std.testing.expect(mayCall(rec, "genesis:frontdoor", "signer", "anything at all"));
    // Roles still work beside calls, and survive a calls change.
    try std.testing.expect(hasRoot(rec));
    rec = (try changed(a, rec, "add", "amm.admin", &k1)).?;
    try std.testing.expect(mayCall(rec, "amm", "signer", "1/amm pool"));
    // Removing every name drops the caller; removing every caller drops `calls`.
    rec = (try callsChanged(a, rec, "remove", "amm", "signer", "1/amm pool")).?;
    rec = (try callsChanged(a, rec, "remove", "amm", "signer", "1/amm commission")).?;
    try std.testing.expect(rec.?.get("calls").?.get("amm") == null);
    rec = (try callsChanged(a, rec, "remove", "genesis:frontdoor", "signer", ANY)).?;
    try std.testing.expect(rec.?.get("calls") == null);
    rec = (try changed(a, rec, "remove", "amm.admin", &k1)).?;
    try std.testing.expectEqualSlices(u8, roots_only, try cbor.encode(a, rec.?)); // as it was: roles only
    try std.testing.expect(isParty("amm") and isParty("genesis:frontdoor") and !isParty("genesis:") and !isParty("Amm"));
    try std.testing.expect(isCallName("1/amm pool") and !isCallName("") and !isCallName("a\x00b"));
}

test "kernel services: granted per caller, only known ones" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var rec: ?Value = (try serviceChanged(a, null, "add", "genesis:frontdoor", SIGNER)).?;
    try std.testing.expect(holdsService(rec, "genesis:frontdoor", SIGNER));
    try std.testing.expect(!holdsService(rec, "genesis:wallet", SIGNER));
    try std.testing.expect(!holdsService(null, "genesis:frontdoor", SIGNER));
    try std.testing.expect((try serviceChanged(a, rec, "add", "genesis:frontdoor", SIGNER)) == null);
    try std.testing.expect(rec.?.get("roles") != null); // a grants record always has its roles map
    rec = (try serviceChanged(a, rec, "remove", "genesis:frontdoor", SIGNER)).?;
    try std.testing.expect(!holdsService(rec, "genesis:frontdoor", SIGNER));
    try std.testing.expect(rec.?.get("services") == null);
    try std.testing.expect(isService("signer") and !isService("http"));
}
