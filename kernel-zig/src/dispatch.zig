// The route table (#77, #143; skein next, SPEC.md section 3): one of the kernel's tables, the one
// that routes. A row says what an arrival may be, who may send it, what checks it before anything
// is written, and which function handles it. One layer of matching, no transport:
//
//   row {kind: "request" | "event" | "read",
//        path: text,                 request and read rows: matched against a request's payload
//                                    path — the exact path first, then the longest prefix
//        name: text,                 event rows: matched against the event's name exactly
//        prefix?: true,              request and read rows: `path` is a prefix
//        role: text,                 request and read rows (required: nothing is open by omission):
//                                    "anyone" (no proven sender required; a request row naming it
//                                    names at least one check), "user" (any proven sender), "root",
//                                    or "<app>.<role>". An event row names none (an event has no
//                                    principal)
//        checks?: ["<app>.<fn>" …],  request and event rows: run in order before anything is written
//        recheck?: "<app>.<fn>",     request and event rows: run at COMMIT, at the tip
//        handler: "<app>.<fn>" | "kernel.<op>",
//                                    the function the entry's step runs (an app's: "<app>.<role>.<fn>"
//                                    or "<app>.<fn>" for an app with one program, as `on` names one),
//                                    or a kernel operation (request rows only: objects, head, route,
//                                    grant — role "root" — or claim — role "user")
//        …}                          a handler's own settings, carried to it as `row`
//
// A row's key is (`path`, `prefix`) for request and read rows together — one path takes one row —
// and `name` for event rows. The table is one chain per instance: origin {kind: "dispatch"}, one
// update per change {op: "add" | "remove", row, thread?, input, at}; the rows are the updates folded
// in order. `add` replaces the row with that key in place (nothing written when it is the same),
// else appends; `remove` deletes it (nothing written when there is none). The genesis's `routes`
// are written as the chain's first updates (no `thread`); afterwards only the kernel's `route`
// operation changes it (and the claim removes its own row). No program import reaches it.
const std = @import("std");
const cbor = @import("cbor");
const json = @import("json.zig");
const heads = @import("heads.zig");
const grants = @import("grants.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub const Kind = enum { request, event, read };

/// The kernel's operations a request row's handler may name (`kernel.<op>`).
pub const kernel_ops = [_][]const u8{ "objects", "head", "route", "grant", "claim" };

pub const Row = struct {
    kind: Kind,
    /// A request or read row's path, an event row's name.
    key: []const u8,
    prefix: bool,
    /// The role a request or read row names (null: an event row).
    role: ?[]const u8,
    /// The checks, in order, as stored (each a text value; an empty list when it names none).
    checks: []const Value,
    recheck: ?[]const u8,
    /// The handler as written: "<app>.<fn>" or "kernel.<op>".
    handler: []const u8,
    /// The kernel operation, when the handler is `kernel.<op>`.
    op: ?[]const u8,
    /// The app whose function handles it, and that function ("<role>.<fn>" or "<fn>"); null for a kernel row.
    app: ?[]const u8,
    func: ?[]const u8,
    /// The row as stored (every field, the handler's settings included).
    value: Value,

    pub fn isRead(r: Row) bool {
        return r.kind == .read;
    }
};

pub fn isKernelOp(op: []const u8) bool {
    for (kernel_ops) |x| if (std.mem.eql(u8, x, op)) return true;
    return false;
}

/// A function reference "<app>.<fn>": the app's name (no dot) and the rest (one more dot at most:
/// "<role>.<fn>"), or null.
pub const FnRef = struct { app: []const u8, func: []const u8 };

pub fn fnRef(s: []const u8) ?FnRef {
    const dot = std.mem.indexOfScalar(u8, s, '.') orelse return null;
    const app = s[0..dot];
    const rest = s[dot + 1 ..];
    if (!grants.isName(app) or rest.len == 0) return null;
    var it = std.mem.splitScalar(u8, rest, '.');
    var parts: usize = 0;
    while (it.next()) |p| {
        parts += 1;
        if (!isNamePart(p)) return null;
    }
    if (parts > 2) return null;
    return .{ .app = app, .func = rest };
}

fn isNamePart(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_' or c == '-')) return false;
    return true;
}

/// Whether `s` names a role a row may name: anyone, user, root, or <app>.<role>.
pub fn isRowRole(s: []const u8) bool {
    return std.mem.eql(u8, s, grants.ANYONE) or std.mem.eql(u8, s, grants.USER) or grants.isGrantable(s);
}

fn originValue(a: std.mem.Allocator) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("dispatch"));
    return m.value();
}

pub fn origin(a: std.mem.Allocator) ![]u8 {
    return cbor.cidOfValue(a, try originValue(a));
}

pub fn open(a: std.mem.Allocator, s: Store) ![]u8 {
    return s.chainOpen(a, try originValue(a));
}

/// A name or path: not empty, no space or NUL.
pub fn isBox(s: []const u8) bool {
    return s.len > 0 and !heads.hasSpaceOrNul(s);
}

/// Why `v` is not a row (JSON.stringify quoting), or null if it is one.
pub fn problem(a: std.mem.Allocator, v: Value) !?[]u8 {
    if (v != .map) return try a.dupe(u8, "a row is a map {kind, path | name, role, checks?, recheck?, handler, …}");
    const ks = Value.str(v.get("kind")) orelse return try a.dupe(u8, "kind: want request, event or read");
    const kind = std.meta.stringToEnum(Kind, ks) orelse return try std.fmt.allocPrint(a, "kind {s}: want request, event or read", .{try json.quoted(a, ks)});
    for ([_][]const u8{ "transport", "address", "filters", "filter", "program", "fn", "sender", "app" }) |k| if (v.get(k) != null) return try std.fmt.allocPrint(a, "{s}: a row has none (skein next: rows by kind, a handler \"<app>.<fn>\", checks)", .{k});
    if (kind == .event) {
        const name = Value.str(v.get("name")) orelse return try a.dupe(u8, "name: an event row names the event it takes");
        if (!isBox(name)) return try std.fmt.allocPrint(a, "name {s}: empty, or has a space or NUL", .{try json.quoted(a, name)});
        if (v.get("path") != null or v.get("prefix") != null) return try a.dupe(u8, "path, prefix: an event row is matched by its name");
        if (v.get("role") != null) return try a.dupe(u8, "role: an event row names none (an event has no principal)");
    } else {
        const path = Value.str(v.get("path")) orelse return try a.dupe(u8, "path: a request or read row names the path it takes");
        if (!isBox(path)) return try std.fmt.allocPrint(a, "path {s}: empty, or has a space or NUL", .{try json.quoted(a, path)});
        if (v.get("name") != null) return try a.dupe(u8, "name: a request or read row is matched by its path");
        if (v.get("prefix")) |p| if (p != .bool and p != .null) return try a.dupe(u8, "prefix: true or absent");
        const role = Value.str(v.get("role")) orelse return try a.dupe(u8, "role: every request and read row names its role (anyone, user, root or <app>.<role>): nothing is open by omission");
        if (!isRowRole(role)) return try std.fmt.allocPrint(a, "role {s}: anyone, user, root or <app>.<role>", .{try json.quoted(a, role)});
    }
    var n_checks: usize = 0;
    if (v.get("checks")) |cs| if (cs != .null) {
        if (cs != .array) return try a.dupe(u8, "checks: a list of \"<app>.<fn>\"");
        for (cs.array) |c| {
            const name = Value.str(c) orelse return try a.dupe(u8, "checks: each is \"<app>.<fn>\"");
            if (fnRef(name) == null) return try std.fmt.allocPrint(a, "checks: {s} is not \"<app>.<fn>\"", .{try json.quoted(a, name)});
        }
        n_checks = cs.array.len;
    };
    if (v.get("recheck")) |r| if (r != .null) {
        const name = Value.str(r) orelse return try a.dupe(u8, "recheck: \"<app>.<fn>\"");
        if (fnRef(name) == null) return try std.fmt.allocPrint(a, "recheck: {s} is not \"<app>.<fn>\"", .{try json.quoted(a, name)});
    };
    if (kind == .read and (n_checks > 0 or (v.get("recheck") != null and v.get("recheck").? != .null))) return try a.dupe(u8, "checks, recheck: a read row has none (a read writes nothing: its handler answers)");
    const h = Value.str(v.get("handler")) orelse return try a.dupe(u8, "handler: \"<app>.<fn>\" or \"kernel.<op>\"");
    if (std.mem.startsWith(u8, h, "kernel.")) {
        const op = h["kernel.".len..];
        if (!isKernelOp(op)) return try std.fmt.allocPrint(a, "handler {s}: a kernel operation is objects, head, route, grant or claim", .{try json.quoted(a, h)});
        if (kind != .request) return try a.dupe(u8, "handler: a kernel operation is a request row's");
        if (n_checks > 0 or (v.get("recheck") != null and v.get("recheck").? != .null)) return try a.dupe(u8, "checks, recheck: a kernel row has none (its operation checks the request itself)");
        const role = Value.str(v.get("role")).?;
        if (std.mem.eql(u8, op, "claim")) {
            if (!std.mem.eql(u8, role, grants.USER)) return try a.dupe(u8, "role: the claim's row names user (any proven sender)");
        } else if (!std.mem.eql(u8, role, grants.ROOT)) return try std.fmt.allocPrint(a, "role: kernel.{s} is gated by root", .{op});
    } else if (fnRef(h) == null) return try std.fmt.allocPrint(a, "handler {s}: \"<app>.<fn>\" or \"kernel.<op>\"", .{try json.quoted(a, h)});
    if (kind == .request) {
        const role = Value.str(v.get("role")).?;
        if (std.mem.eql(u8, role, grants.ANYONE) and n_checks == 0) return try a.dupe(u8, "checks: a request row whose role is anyone names at least one check (no proven sender: its content is proven)");
    }
    return null;
}

/// The row `v` describes (null if it is not one: `problem`).
pub fn rowOf(v: Value) ?Row {
    if (v != .map) return null;
    const kind = std.meta.stringToEnum(Kind, Value.str(v.get("kind")) orelse return null) orelse return null;
    const key = (if (kind == .event) Value.str(v.get("name")) else Value.str(v.get("path"))) orelse return null;
    const h = Value.str(v.get("handler")) orelse return null;
    var op: ?[]const u8 = null;
    var app: ?[]const u8 = null;
    var func: ?[]const u8 = null;
    if (std.mem.startsWith(u8, h, "kernel.")) {
        op = h["kernel.".len..];
    } else {
        const f = fnRef(h) orelse return null;
        app = f.app;
        func = f.func;
    }
    const p = v.get("prefix");
    const rc = v.get("recheck");
    return .{
        .kind = kind,
        .key = key,
        .prefix = kind != .event and p != null and p.? == .bool and p.?.bool,
        .role = if (kind == .event) null else Value.str(v.get("role")),
        .checks = checksOf(v),
        .recheck = if (rc) |x| Value.str(x) else null,
        .handler = h,
        .op = op,
        .app = app,
        .func = func,
        .value = v,
    };
}

/// The row's checks, as stored (an empty list when it names none, or one that is not all text).
fn checksOf(v: Value) []const Value {
    const cs = v.get("checks") orelse return &.{};
    if (cs != .array) return &.{};
    for (cs.array) |c| if (c != .string) return &.{};
    return cs.array;
}

/// The same key: request and read rows by (path, prefix), event rows by name.
pub fn sameKey(x: Row, y: Row) bool {
    if ((x.kind == .event) != (y.kind == .event)) return false;
    return std.mem.eql(u8, x.key, y.key) and x.prefix == y.prefix;
}

fn sameRow(a: std.mem.Allocator, x: Row, y: Row) bool {
    const bx = cbor.encode(a, x.value) catch return false;
    const by = cbor.encode(a, y.value) catch return false;
    return std.mem.eql(u8, bx, by);
}

/// The rows after `updates` (each {op, row, …}), in table order.
pub fn fold(a: std.mem.Allocator, updates: []const Value) ![]Row {
    var out = std.array_list.Managed(Row).init(a);
    for (updates) |u| {
        const op = Value.str(u.get("op")) orelse continue;
        const r = rowOf(u.get("row") orelse continue) orelse continue;
        var idx: ?usize = null;
        for (out.items, 0..) |x, i| if (sameKey(x, r)) {
            idx = i;
            break;
        };
        if (std.mem.eql(u8, op, "add")) {
            if (idx) |i| out.items[i] = r else try out.append(r);
        } else if (std.mem.eql(u8, op, "remove")) {
            if (idx) |i| _ = out.orderedRemove(i);
        }
    }
    return out.items;
}

/// The rows now; null if the chain was never opened (no genesis processed).
pub fn current(a: std.mem.Allocator, s: Store) !?[]Row {
    const o = try origin(a);
    const ups = (try s.chainUpdates(a, o)) orelse return null;
    const vals = try a.alloc(Value, ups.len);
    for (ups, 0..) |c, i| vals[i] = (try s.get(a, c)) orelse return error.NotFound;
    return try fold(a, vals);
}

/// The rows as a dag-cbor array (a program's input, the host's `routes` frame).
pub fn valueOf(a: std.mem.Allocator, rows: []const Row) !Value {
    const out = try a.alloc(Value, rows.len);
    for (rows, out) |r, *o| o.* = r.value;
    return .{ .array = out };
}

pub const By = struct { thread: ?[]const u8, input: []const u8, at: i64 };

/// Apply a change; the update written, or null when it changes nothing. `v` is the row (for a
/// remove, its key fields suffice: kind, path | name, prefix — the rest must still make a row).
pub fn apply(a: std.mem.Allocator, s: Store, op: []const u8, v: Value, by: By) !?[]u8 {
    const now = (try current(a, s)) orelse &.{};
    const r = rowOf(v) orelse return error.BadRow;
    const add = std.mem.eql(u8, op, "add");
    if (!add and !std.mem.eql(u8, op, "remove")) return error.BadRow;
    var listed: ?Row = null;
    for (now) |x| if (sameKey(x, r)) {
        listed = x;
    };
    if (add) {
        if (listed) |x| if (sameRow(a, x, r)) return null;
    } else if (listed == null) return null;
    const o = try open(a, s);
    var m = cbor.MapBuilder.init(a);
    try m.put("op", cbor.string(op));
    try m.put("row", v);
    try m.put("thread", cbor.optCid(by.thread));
    try m.put("input", cbor.cidv(by.input));
    try m.put("at", cbor.int(by.at));
    return try s.chainAppend(a, o, m.value());
}

// ---------------------------------------------------------------- the match

/// A request's row (request or read): the exact path first, then the longest prefix the path starts with.
pub fn forPath(rows: []const Row, path: []const u8) ?Row {
    for (rows) |r| if (r.kind != .event and !r.prefix and std.mem.eql(u8, r.key, path)) return r;
    var best: ?Row = null;
    for (rows) |r| {
        if (r.kind == .event or !r.prefix or !std.mem.startsWith(u8, path, r.key)) continue;
        if (best == null or r.key.len > best.?.key.len) best = r;
    }
    return best;
}

/// An event's row: the event row at its name exactly.
pub fn forName(rows: []const Row, name: []const u8) ?Row {
    for (rows) |r| if (r.kind == .event and std.mem.eql(u8, r.key, name)) return r;
    return null;
}

// ---------------------------------------------------------------- tests

fn testRow(a: std.mem.Allocator, fields: []const struct { []const u8, Value }) !Value {
    var m = cbor.MapBuilder.init(a);
    for (fields) |f| try m.put(f[0], f[1]);
    return m.value();
}

fn strs(a: std.mem.Allocator, xs: []const []const u8) !Value {
    const out = try a.alloc(Value, xs.len);
    for (xs, out) |x, *o| o.* = cbor.string(x);
    return .{ .array = out };
}

test "rows: kinds, roles on every request and read row, anyone needs a check, kernel rows" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const S = cbor.string;
    const ok = struct {
        fn f(al: std.mem.Allocator, v: Value) !bool {
            return (try problem(al, v)) == null;
        }
    }.f;
    // A signed request row; a content-proven one names its check; anyone with no check is refused.
    try std.testing.expect(try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/amm/admin") }, .{ "role", S("amm.admin") }, .{ "handler", S("amm.token.admin") } })));
    try std.testing.expect(try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/overlay/submit") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{ "chain.beef", "overlay.admits" }) }, .{ "recheck", S("chain.unspent") }, .{ "handler", S("overlay.submit") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/open") }, .{ "role", S("anyone") }, .{ "handler", S("x.y") } })));
    // A row without a role is refused: nothing is open by omission.
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/x") }, .{ "handler", S("x.y") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("read") }, .{ "path", S("/x") }, .{ "handler", S("x.y") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/x") }, .{ "role", S("admin") }, .{ "handler", S("x.y") } })));
    // An open read; a read has no checks.
    try std.testing.expect(try ok(a, try testRow(a, &.{ .{ "kind", S("read") }, .{ "path", S("/lookup") }, .{ "prefix", .{ .bool = true } }, .{ "role", S("anyone") }, .{ "handler", S("overlay.lookup") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("read") }, .{ "path", S("/lookup") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{"a.b"}) }, .{ "handler", S("overlay.lookup") } })));
    // An event row names no role; its checks are allowed.
    try std.testing.expect(try ok(a, try testRow(a, &.{ .{ "kind", S("event") }, .{ "name", S("chain/proof") }, .{ "checks", try strs(a, &.{"chain.proof"}) }, .{ "handler", S("chain.proof") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("event") }, .{ "name", S("chain") }, .{ "role", S("anyone") }, .{ "handler", S("chain.pointer") } })));
    // Kernel rows: request rows, root-gated; the claim user-gated; no checks.
    try std.testing.expect(try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/kernel/route") }, .{ "role", S("root") }, .{ "handler", S("kernel.route") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/kernel/route") }, .{ "role", S("user") }, .{ "handler", S("kernel.route") } })));
    try std.testing.expect(try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/claim") }, .{ "role", S("user") }, .{ "handler", S("kernel.claim") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/claim") }, .{ "role", S("root") }, .{ "handler", S("kernel.claim") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("event") }, .{ "name", S("x") }, .{ "handler", S("kernel.objects") } })));
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/k") }, .{ "role", S("root") }, .{ "handler", S("kernel.peers") } })));
    // The old shape is no row.
    try std.testing.expect(!try ok(a, try testRow(a, &.{ .{ "transport", S("http") }, .{ "address", S("/x") }, .{ "role", S("user") }, .{ "handler", S("x.y") } })));
}

test "rows: fold by key — a path takes one row, request or read; events by name; the match exact first, then the longest prefix" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const S = cbor.string;
    const up = struct {
        fn f(al: std.mem.Allocator, op: []const u8, r: Value) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("op", cbor.string(op));
            try m.put("row", r);
            return m.value();
        }
    }.f;
    const req = try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/site/x") }, .{ "role", S("user") }, .{ "handler", S("site.x") }, .{ "id", S("exact") } });
    const read = try testRow(a, &.{ .{ "kind", S("read") }, .{ "path", S("/site/") }, .{ "prefix", .{ .bool = true } }, .{ "role", S("anyone") }, .{ "handler", S("site.get") }, .{ "id", S("read") } });
    const deeper = try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/site/deep/") }, .{ "prefix", .{ .bool = true } }, .{ "role", S("root") }, .{ "handler", S("site.put") }, .{ "id", S("deeper") } });
    const ev = try testRow(a, &.{ .{ "kind", S("event") }, .{ "name", S("/site/x") }, .{ "handler", S("site.ev") }, .{ "id", S("event") } });
    // A read row at the request row's path replaces it (one path, one row).
    const read_x = try testRow(a, &.{ .{ "kind", S("read") }, .{ "path", S("/site/x") }, .{ "role", S("anyone") }, .{ "handler", S("site.x") }, .{ "id", S("read-x") } });
    const rows = try fold(a, &.{ try up(a, "add", req), try up(a, "add", read), try up(a, "add", deeper), try up(a, "add", ev) });
    try std.testing.expectEqual(@as(usize, 4), rows.len);
    try std.testing.expectEqualStrings("exact", Value.str(forPath(rows, "/site/x").?.value.get("id")).?);
    try std.testing.expectEqualStrings("read", Value.str(forPath(rows, "/site/y").?.value.get("id")).?);
    try std.testing.expectEqualStrings("deeper", Value.str(forPath(rows, "/site/deep/z").?.value.get("id")).?);
    try std.testing.expect(forPath(rows, "/other") == null);
    // An event row is never a request's, a request row never an event's.
    try std.testing.expectEqualStrings("event", Value.str(forName(rows, "/site/x").?.value.get("id")).?);
    try std.testing.expect(forName(rows, "/site/y") == null);
    const rows2 = try fold(a, &.{ try up(a, "add", req), try up(a, "add", read_x), try up(a, "add", ev), try up(a, "remove", read) });
    try std.testing.expectEqual(@as(usize, 2), rows2.len);
    try std.testing.expect(forPath(rows2, "/site/x").?.isRead());
    // The handler split: app and function; a kernel row's operation.
    const r = rowOf(deeper).?;
    try std.testing.expectEqualStrings("site", r.app.?);
    try std.testing.expectEqualStrings("put", r.func.?);
    try std.testing.expectEqualStrings("root", r.role.?);
    const k = rowOf(try testRow(a, &.{ .{ "kind", S("request") }, .{ "path", S("/g") }, .{ "role", S("root") }, .{ "handler", S("kernel.grant") } })).?;
    try std.testing.expectEqualStrings("grant", k.op.?);
    try std.testing.expect(k.app == null);
    try std.testing.expectEqualStrings("validator.check", fnRef("amm.validator.check").?.func);
    try std.testing.expect(fnRef("amm") == null);
    try std.testing.expect(fnRef("amm.a.b.c") == null);
}
