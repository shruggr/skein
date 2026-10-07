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
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("grants"));
    try m.put("roles", roles.value());
    return m.value();
}

/// Grant or revoke under the entry `by`: the head moved to the new record; false when nothing changed.
pub fn apply(a: std.mem.Allocator, s: Store, op: []const u8, role: []const u8, key: []const u8, by: heads.By) !bool {
    const next = (try changed(a, try load(a, s), op, role, key)) orelse return false;
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
