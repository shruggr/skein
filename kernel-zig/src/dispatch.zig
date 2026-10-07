// The route table (#77, #143): one of the kernel's tables, the one that routes.
// Routing only (David Case, 2026-10-08: "permissions and routing might be two
// entirely different things"): a route says where a package goes and which
// filters it passes on the way, never who may send it. Who may run a
// function is the grants' (grants.zig: roles, the gate).
//
//   route {transport: "mailbox" | "event" | "http" | "libp2p" | "local",
//          address: text,          mailbox/event: a box ("*": any box — a genesis-only catch-all,
//                                  a mailbox instance's); http: a path; libp2p: a topic, or
//                                  "/<protocol>"; local: a provider's name (no route fires)
//          prefix?: true,          http only: `address` is a prefix (exact paths match first,
//                                  then the longest prefix); a libp2p route is exact (#119)
//          filters?: [text],       what runs on the package before anything is recorded, in
//                                  order (door.zig): "kernel.brc104", "kernel.beef", "kernel.brc169", or
//                                  "<app>.<filter>" — a function the app's record lists under
//                                  `filters`. http, libp2p and mailbox routes; an event has none
//          program?: <cid> | "kernel",
//                                  the handler (a program record in the store), or the kernel
//                                  itself: an admin operation (`fn`: objects | head | dispatch |
//                                  peers | grant), the claim (#89, #143: grants root), or the
//                                  host's tick (#130: the host row — `host` the host's key, `x`
//                                  and `rates` its settings, billing.zig). Absent: a READ route
//                                  (http only): its filters answer, nothing is logged
//          fn?: text,              the handler's function; kernel: the operation
//          app?: text,             the app that installed it: its write scope, and the roles its
//                                  record declares for `fn` (grants.zig gate)
//          …}                      a handler's own settings, carried to it as `match` (a file
//                                  handler's `root`, `index`)
//
// `event` is a transport (#143): the host's wiring into a box (a feed's header,
// a broadcaster's proof, a route's admit) — never a message; a `mailbox` route
// takes messages only. There is no `sender` (#143): a route admits whatever its
// filters let through, and the gate decides who may run its function.
//
// The table is one chain per instance: origin {kind: "dispatch"}, one update
// per change {op: "add" | "remove", row, thread?, input, at}; the rows are the
// updates folded in order. A route's key is (transport, address, prefix):
// `add` replaces the route with that key in place (nothing written when it is
// the same), else appends; `remove` deletes it (nothing written when there is
// none). The genesis's `dispatch` is written as the chain's first updates (no
// `thread`); afterwards only the kernel's `dispatch` operation changes it — on
// a message from root (scheduler.zig kernelOp). No program import reaches it.
const std = @import("std");
const cbor = @import("cbor");
const json = @import("json.zig");
const heads = @import("heads.zig");
const billing = @import("billing.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub const transports = [_][]const u8{ "mailbox", "event", "http", "libp2p", "local" };
/// The kernel's admin operations (#77, #143: and `grant`), each gated by root.
pub const admin_ops = [_][]const u8{ "objects", "head", "dispatch", "peers", "grant" };
/// What a kernel route may name (#89): the admin operations, the claim — an
/// image's route, taken once: root granted to its sender and the claim route
/// removed (scheduler.zig claim) — and (#130) the host's tick: the host row
/// (billing.zig).
pub const kernel_ops = admin_ops ++ [_][]const u8{ "claim", billing.OP };

/// The kernel's own filters (door.zig): `kernel.<name>`.
pub const kernel_filters = [_][]const u8{ "kernel.brc104", "kernel.beef", "kernel.brc169" };

pub const Row = struct {
    transport: []const u8,
    address: []const u8,
    prefix: bool,
    /// The handler's program record; null for a kernel route (`op`) and for a read route.
    program: ?[]const u8,
    /// The kernel operation, when the route's program is "kernel".
    op: ?[]const u8,
    func: ?[]const u8,
    /// The app that installed it (null: the genesis's, or root's own).
    app: ?[]const u8,
    /// The filters, in order, as stored (each a text value; an empty list when it names none).
    filters: []const Value,
    /// The route as stored (every field, the handler's settings included).
    value: Value,

    /// A read route (#143): filters only, no handler — its last filter answers.
    pub fn isRead(r: Row) bool {
        return r.program == null and r.op == null;
    }
};

pub fn isTransport(t: []const u8) bool {
    for (transports) |x| if (std.mem.eql(u8, x, t)) return true;
    return false;
}

pub fn isKernelOp(op: []const u8) bool {
    for (kernel_ops) |x| if (std.mem.eql(u8, x, op)) return true;
    return false;
}

pub fn isAdminOp(op: []const u8) bool {
    for (admin_ops) |x| if (std.mem.eql(u8, x, op)) return true;
    return false;
}

fn isNamePart(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_' or c == '-')) return false;
    return true;
}

/// Whether `s` names a filter: `kernel.<name>` (one of the kernel's), or `<app>.<filter>`.
pub fn isFilterRef(s: []const u8) bool {
    const dot = std.mem.lastIndexOfScalar(u8, s, '.') orelse return false;
    const app = s[0..dot];
    const name = s[dot + 1 ..];
    if (!isNamePart(name) or app.len == 0 or heads.hasSpaceOrNul(app) or std.mem.indexOfScalar(u8, app, '/') != null) return false;
    if (std.mem.eql(u8, app, "kernel")) {
        for (kernel_filters) |k| if (std.mem.eql(u8, k, s)) return true;
        return false;
    }
    return true;
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

/// A box name: not empty, no space or NUL (a host's own box may start with ':').
pub fn isBox(s: []const u8) bool {
    return s.len > 0 and !heads.hasSpaceOrNul(s);
}

/// Why `v` is not a route (JSON.stringify quoting), or null if it is one.
/// The program record's presence in the store is the kernel's check at the
/// operation (a genesis names records the loader put).
pub fn problem(a: std.mem.Allocator, v: Value) !?[]u8 {
    if (v != .map) return try a.dupe(u8, "a route is a map {transport, address, prefix?, filters?, program?, fn?, …}");
    const t = Value.str(v.get("transport")) orelse return try a.dupe(u8, "transport: want mailbox, event, http, libp2p or local");
    if (!isTransport(t)) return try std.fmt.allocPrint(a, "transport {s}: want mailbox, event, http, libp2p or local", .{try json.quoted(a, t)});
    if (v.get("sender") != null) return try a.dupe(u8, "sender: a route has none (#143: routing only — who may run a function is the grants')");
    const addr = Value.str(v.get("address")) orelse return try a.dupe(u8, "address: want text (a box, a path, a topic or /protocol, a provider's name)");
    if (!isBox(addr)) return try std.fmt.allocPrint(a, "address {s}: empty, or has a space or NUL", .{try json.quoted(a, addr)});
    if (v.get("prefix")) |p| {
        if (p != .bool and p != .null) return try a.dupe(u8, "prefix: true or absent");
        if (p == .bool and p.bool and !std.mem.eql(u8, t, "http")) return try a.dupe(u8, "prefix: only an http route has one");
    }
    var n_filters: usize = 0;
    if (v.get("filters")) |fs| if (fs != .null) {
        if (fs != .array) return try a.dupe(u8, "filters: a list of filter names (\"kernel.brc104\", \"kernel.beef\", \"kernel.brc169\", \"<app>.<filter>\")");
        for (fs.array) |f| {
            const name = Value.str(f) orelse return try a.dupe(u8, "filters: each is a filter's name");
            if (!isFilterRef(name)) return try std.fmt.allocPrint(a, "filters: {s} is not kernel.brc104, kernel.beef, kernel.brc169 or <app>.<filter>", .{try json.quoted(a, name)});
        }
        n_filters = fs.array.len;
        if (n_filters > 0 and (std.mem.eql(u8, t, "event") or std.mem.eql(u8, t, "local"))) return try std.fmt.allocPrint(a, "filters: an {s} route has none (only http, libp2p and mailbox routes filter)", .{t});
    };
    if (v.get("filter") != null) return try a.dupe(u8, "filter: gone (#143): name `filters`, a list (\"kernel.beef\")");
    if (v.get("app")) |x| if (x != .null and Value.str(x) == null) return try a.dupe(u8, "app: want text");
    if (v.get("fn")) |f| if (f != .string and f != .null) return try a.dupe(u8, "fn: want text");
    const prog = v.get("program") orelse {
        // A read route (#143): filters only; its last filter answers.
        if (!std.mem.eql(u8, t, "http")) return try a.dupe(u8, "program: only an http route may have none (a read route: its filters answer)");
        if (n_filters == 0) return try a.dupe(u8, "a read route (no program) names its filters: the last one answers");
        if (v.get("fn") != null) return try a.dupe(u8, "fn: a read route has no handler");
        return null;
    };
    if (Value.str(prog)) |s| {
        if (!std.mem.eql(u8, s, "kernel")) return try std.fmt.allocPrint(a, "program {s}: want a program record's CID, or \"kernel\"", .{try json.quoted(a, s)});
        const op = Value.str(v.get("fn")) orelse return try a.dupe(u8, "fn: a kernel route names its operation (objects, head, dispatch, peers, grant, claim or tick)");
        if (!isKernelOp(op)) return try std.fmt.allocPrint(a, "fn {s}: a kernel route's operation is objects, head, dispatch, peers, grant, claim or tick", .{try json.quoted(a, op)});
        if (!std.mem.eql(u8, t, "mailbox")) return try a.dupe(u8, "a kernel route is a mailbox route (an admin box)");
        if (n_filters > 0) return try a.dupe(u8, "filters: a kernel route has none (its operation checks the message itself)");
        // #130: the host row — `host` the host's key, its settings X and the rates.
        if (std.mem.eql(u8, op, billing.OP)) if (try billing.rowProblem(a, v)) |bad| return bad;
    } else if (prog != .cid) return try a.dupe(u8, "program: want a program record's CID, or \"kernel\"");
    return null;
}

/// The route `v` describes (null if it is not one: `problem`). The filter list is borrowed from `v`
/// when it is a list of text (a malformed one a log holds reads as none).
pub fn rowOf(v: Value) ?Row {
    if (v != .map) return null;
    const t = Value.str(v.get("transport")) orelse return null;
    const addr = Value.str(v.get("address")) orelse return null;
    if (v.get("sender") != null) return null;
    var is_kernel = false;
    var program: ?[]const u8 = null;
    if (v.get("program")) |prog| {
        if (Value.str(prog)) |s| {
            if (!std.mem.eql(u8, s, "kernel")) return null;
            is_kernel = true;
        } else if (prog == .cid) program = prog.cid else return null;
    }
    const p = v.get("prefix");
    return .{
        .transport = t,
        .address = addr,
        .prefix = p != null and p.? == .bool and p.?.bool,
        .program = program,
        .op = if (is_kernel) Value.str(v.get("fn")) else null,
        .func = Value.str(v.get("fn")),
        .app = Value.str(v.get("app")),
        .filters = filtersOf(v),
        .value = v,
    };
}

/// The route's filter names, as stored (an empty list when it names none, or one that is not all text).
fn filtersOf(v: Value) []const Value {
    const fs = v.get("filters") orelse return &.{};
    if (fs != .array) return &.{};
    for (fs.array) |f| if (f != .string) return &.{};
    return fs.array;
}

/// The same key: (transport, address, prefix).
pub fn sameKey(x: Row, y: Row) bool {
    return std.mem.eql(u8, x.transport, y.transport) and std.mem.eql(u8, x.address, y.address) and x.prefix == y.prefix;
}

fn sameRow(a: std.mem.Allocator, x: Row, y: Row) bool {
    const bx = cbor.encode(a, x.value) catch return false;
    const by = cbor.encode(a, y.value) catch return false;
    return std.mem.eql(u8, bx, by);
}

/// The routes after `updates` (each {op, row, …}), in table order.
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

/// The routes now; null if the chain was never opened (no genesis processed).
pub fn current(a: std.mem.Allocator, s: Store) !?[]Row {
    const o = try origin(a);
    const ups = (try s.chainUpdates(a, o)) orelse return null;
    const vals = try a.alloc(Value, ups.len);
    for (ups, 0..) |c, i| vals[i] = (try s.get(a, c)) orelse return error.NotFound;
    return try fold(a, vals);
}

/// The routes as a dag-cbor array (a program's input, the serve frame).
pub fn valueOf(a: std.mem.Allocator, rows: []const Row) !Value {
    const out = try a.alloc(Value, rows.len);
    for (rows, out) |r, *o| o.* = r.value;
    return .{ .array = out };
}

pub const By = struct { thread: ?[]const u8, input: []const u8, at: i64 };

/// Apply a change; the update written, or null when it changes nothing. `v`
/// is the route (for a remove, its key fields suffice).
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
//
// One rule for every transport: the route whose transport and address take
// the package. A box route's address is the box, or `*` (the first in table
// order); an http path's exact route first, then the longest prefix; a libp2p
// topic or `/<protocol>` exactly. No key takes part: who it is from is the
// filters' to establish and the gate's to judge.

/// A message's route: the first `mailbox` route whose address is the box (or any box).
pub fn forMail(rows: []const Row, box: []const u8) ?Row {
    for (rows) |r| if (std.mem.eql(u8, r.transport, "mailbox") and (std.mem.eql(u8, r.address, "*") or std.mem.eql(u8, r.address, box))) return r;
    return null;
}

/// An event's route (#143: events are their own transport): the first `event` route whose address is the box (or any box).
pub fn forEvent(rows: []const Row, box: []const u8) ?Row {
    for (rows) |r| if (std.mem.eql(u8, r.transport, "event") and (std.mem.eql(u8, r.address, "*") or std.mem.eql(u8, r.address, box))) return r;
    return null;
}

/// A request's `http` route: the exact path first, then the longest prefix that the path starts with.
pub fn forHttp(rows: []const Row, path: []const u8) ?Row {
    for (rows) |r| if (std.mem.eql(u8, r.transport, "http") and !r.prefix and std.mem.eql(u8, r.address, path)) return r;
    var best: ?Row = null;
    for (rows) |r| {
        if (!std.mem.eql(u8, r.transport, "http") or !r.prefix or !std.mem.startsWith(u8, path, r.address)) continue;
        if (best == null or r.address.len > best.?.address.len) best = r;
    }
    return best;
}

/// A libp2p package's route: the `libp2p` route at the topic or `/<protocol>` exactly. A topic no
/// route is at may be delivered by an app's subscription instead (#119: subscriptions.zig; the
/// scheduler's matchOf) — a route at the topic wins over a subscription.
pub fn forLibp2p(rows: []const Row, name: []const u8) ?Row {
    for (rows) |r| if (std.mem.eql(u8, r.transport, "libp2p") and !r.prefix and std.mem.eql(u8, r.address, name)) return r;
    return null;
}

test "fold: add replaces by key, remove deletes; a sender is no route's" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cid1 = try @import("cid").parse(a, "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    const route = struct {
        fn f(al: std.mem.Allocator, t: []const u8, addr: []const u8, prog: ?Value, func: ?[]const u8) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("transport", cbor.string(t));
            try m.put("address", cbor.string(addr));
            if (prog) |p| try m.put("program", p);
            if (func) |x| try m.put("fn", cbor.string(x));
            return m.value();
        }
    }.f;
    const up = struct {
        fn f(al: std.mem.Allocator, op: []const u8, r: Value) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("op", cbor.string(op));
            try m.put("row", r);
            return m.value();
        }
    }.f;
    const r1 = try route(a, "mailbox", "run", cbor.cidv(cid1), null);
    const r2 = try route(a, "mailbox", "objects", cbor.string("kernel"), "objects");
    try std.testing.expect((try problem(a, r1)) == null);
    try std.testing.expect((try problem(a, r2)) == null);
    // A sender is no route's (#143).
    var with_sender = cbor.MapBuilder.init(a);
    for (r1.map) |e| try with_sender.put(e.key, e.value);
    try with_sender.put("sender", cbor.string("*"));
    try std.testing.expect((try problem(a, with_sender.value())) != null);
    try std.testing.expect(rowOf(with_sender.value()) == null);
    // A kernel route is a mailbox route.
    try std.testing.expect((try problem(a, try route(a, "http", "/x", cbor.string("kernel"), "objects"))) != null);
    const r1b = try route(a, "mailbox", "run", cbor.cidv(cid1), "later");
    const rows = try fold(a, &.{ try up(a, "add", r1), try up(a, "add", r2), try up(a, "add", r1b), try up(a, "remove", r2), try up(a, "remove", r2) });
    try std.testing.expectEqual(@as(usize, 1), rows.len);
    try std.testing.expectEqualStrings("later", rows[0].func.?);
    try std.testing.expect(forMail(rows, "run") != null);
    try std.testing.expect(forEvent(rows, "run") == null);
    // An event route takes events, never a message (#143: events are a transport).
    const r3 = try route(a, "event", "chain", cbor.cidv(cid1), null);
    try std.testing.expect((try problem(a, r3)) == null);
    const rows3 = try fold(a, &.{try up(a, "add", r3)});
    try std.testing.expect(forEvent(rows3, "chain") != null);
    try std.testing.expect(forMail(rows3, "chain") == null);
}

test "routes: filters, read routes, prefixes; an http path exact first, then the longest prefix" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cid1 = try @import("cid").parse(a, "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    const route = struct {
        fn f(al: std.mem.Allocator, t: []const u8, addr: []const u8, prefix: bool, filters: []const []const u8, prog: ?[]const u8, id: []const u8) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("transport", cbor.string(t));
            try m.put("address", cbor.string(addr));
            if (prefix) try m.put("prefix", .{ .bool = true });
            if (filters.len > 0) {
                const fs = try al.alloc(Value, filters.len);
                for (filters, fs) |x, *o| o.* = cbor.string(x);
                try m.put("filters", .{ .array = fs });
            }
            if (prog) |p| {
                try m.put("program", cbor.cidv(p));
                try m.put("fn", cbor.string("h"));
            }
            try m.put("id", cbor.string(id));
            return m.value();
        }
    }.f;
    const up = struct {
        fn f(al: std.mem.Allocator, r: Value) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("op", cbor.string("add"));
            try m.put("row", r);
            return m.value();
        }
    }.f;
    const read = try route(a, "http", "/site/", true, &.{"site.get"}, null, "read");
    try std.testing.expect((try problem(a, read)) == null);
    try std.testing.expect(rowOf(read).?.isRead());
    // A read route names its filters; only http routes may have no handler.
    try std.testing.expect((try problem(a, try route(a, "http", "/x", false, &.{}, null, "x"))) != null);
    try std.testing.expect((try problem(a, try route(a, "mailbox", "x", false, &.{"site.get"}, null, "x"))) != null);
    // Filters: the kernel's two, or <app>.<filter>; none on an event route.
    try std.testing.expect((try problem(a, try route(a, "http", "/y", false, &.{ "kernel.brc104", "kernel.beef", "amm.quote" }, cid1, "y"))) == null);
    try std.testing.expect((try problem(a, try route(a, "http", "/y", false, &.{"kernel.nope"}, cid1, "y"))) != null);
    try std.testing.expect((try problem(a, try route(a, "http", "/y", false, &.{"nodot"}, cid1, "y"))) != null);
    try std.testing.expect((try problem(a, try route(a, "event", "chain", false, &.{"kernel.beef"}, cid1, "y"))) != null);
    // A prefix is an http route's only.
    try std.testing.expect((try problem(a, try route(a, "libp2p", "tm_", true, &.{}, cid1, "p"))) != null);
    const exact = try route(a, "http", "/site/x", false, &.{"kernel.brc104"}, cid1, "exact");
    const longer = try route(a, "http", "/site/deep/", true, &.{}, cid1, "longer");
    const topic = try route(a, "libp2p", "tm_ab", false, &.{"kernel.beef"}, cid1, "topic");
    const rows = try fold(a, &.{ try up(a, read), try up(a, exact), try up(a, longer), try up(a, topic) });
    try std.testing.expectEqualStrings("exact", Value.str(forHttp(rows, "/site/x").?.value.get("id")).?);
    try std.testing.expectEqualStrings("read", Value.str(forHttp(rows, "/site/y").?.value.get("id")).?);
    try std.testing.expectEqualStrings("longer", Value.str(forHttp(rows, "/site/deep/z").?.value.get("id")).?);
    try std.testing.expect(forHttp(rows, "/other") == null);
    try std.testing.expectEqual(@as(usize, 1), forLibp2p(rows, "tm_ab").?.filters.len);
    try std.testing.expect(forLibp2p(rows, "tm_abc") == null);
    try std.testing.expectEqualStrings("kernel.brc104", forHttp(rows, "/site/x").?.filters[0].string);
}
