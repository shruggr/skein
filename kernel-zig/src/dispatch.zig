// The dispatch table (#77): one of the kernel's four tables, and the one that
// routes. It replaces the subscriptions chain, the genesis's `routes` and the
// front door's `routes` head (format 8): a route, a subscription and a libp2p
// topic or protocol differ only in where the address comes from.
//
//   row   {transport: "mailbox" | "http" | "libp2p" | "local",
//          address: text,          mailbox: a box name ("*": any box — a genesis-only catch-all,
//                                  a mailbox instance's); http: a path; libp2p: a topic, or
//                                  "/<protocol>"; local: a provider's name
//          prefix?: true,          http only: `address` is a prefix (exact paths match first,
//                                  then the longest prefix)
//          sender: "*" | "session" | bytes(33),
//                                  "*": anyone (an open route; an event's box); "session": an HTTP
//                                  route that needs a BRC-103/104 session, any identity; a key:
//                                  that identity — a message's sender, or the session's identity
//          program: <cid> | "kernel",
//                                  the handler (a program record in the store), or the kernel
//                                  itself: an admin operation (`fn`: objects | head | dispatch | peers)
//          fn?: text,              http/libp2p: the handler's function; kernel: the operation
//          …}                      a handler's own settings, carried to it as `match` (static's
//                                  `root`, `index`; a route's `read` op; the install's `app`)
//
// The table is one chain per instance: origin {kind: "dispatch"}, one update
// per change {op: "add" | "remove", row, thread?, input, at}; the rows are the
// updates folded in order. A row's key is (transport, address, prefix,
// sender): `add` replaces the row with that key in place (nothing written when
// it is the same row), else appends; `remove` deletes it (nothing written when
// there is none). First match wins, in table order. The genesis's `dispatch`
// is written as the chain's first updates (no `thread`); afterwards only the
// kernel's `dispatch` operation changes it — on a message in an admin box from
// the owner or a delegate (scheduler.zig kernelOp). No program import reaches
// it.
const std = @import("std");
const cbor = @import("cbor");
const json = @import("json.zig");
const secp = @import("secp");
const heads = @import("heads.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub const transports = [_][]const u8{ "mailbox", "http", "libp2p", "local" };
/// The kernel's admin operations, one per table (#77).
pub const kernel_ops = [_][]const u8{ "objects", "head", "dispatch", "peers" };

pub const Sender = union(enum) { any, session, key: []const u8 };

pub const Row = struct {
    transport: []const u8,
    address: []const u8,
    prefix: bool,
    sender: Sender,
    /// The handler's program record, or null: the kernel itself (`op`).
    program: ?[]const u8,
    /// The kernel operation, when `program` is null.
    op: ?[]const u8,
    func: ?[]const u8,
    /// The row as stored (every field, the handler's settings included).
    value: Value,
};

pub fn isTransport(t: []const u8) bool {
    for (transports) |x| if (std.mem.eql(u8, x, t)) return true;
    return false;
}

pub fn isKernelOp(op: []const u8) bool {
    for (kernel_ops) |x| if (std.mem.eql(u8, x, op)) return true;
    return false;
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

fn senderOf(v: ?Value) ?Sender {
    const x = v orelse return null;
    if (Value.str(x)) |s| {
        if (std.mem.eql(u8, s, "*")) return .any;
        if (std.mem.eql(u8, s, "session")) return .session;
        return null;
    }
    if (Value.bytesOf(x)) |b| if (secp.isKey(b)) return .{ .key = b };
    return null;
}

/// Why `v` is not a dispatch row (JSON.stringify quoting), or null if it is one.
/// The program record's presence in the store is the kernel's check at the
/// operation (a genesis names records the loader put).
pub fn problem(a: std.mem.Allocator, v: Value) !?[]u8 {
    if (v != .map) return try a.dupe(u8, "a row is a map {transport, address, sender, program, fn?, …}");
    const t = Value.str(v.get("transport")) orelse return try a.dupe(u8, "transport: want mailbox, http, libp2p or local");
    if (!isTransport(t)) return try std.fmt.allocPrint(a, "transport {s}: want mailbox, http, libp2p or local", .{try json.quoted(a, t)});
    const addr = Value.str(v.get("address")) orelse return try a.dupe(u8, "address: want text (a box, a path, a topic or /protocol, a provider's name)");
    if (!isBox(addr)) return try std.fmt.allocPrint(a, "address {s}: empty, or has a space or NUL", .{try json.quoted(a, addr)});
    if (v.get("prefix")) |p| {
        if (p != .bool and p != .null) return try a.dupe(u8, "prefix: true or absent");
        if (p == .bool and p.bool and !std.mem.eql(u8, t, "http")) return try a.dupe(u8, "prefix: only an http row has one");
    }
    const sender = senderOf(v.get("sender")) orelse return try a.dupe(u8, "sender: want \"*\", \"session\" (http) or an identity key (33 bytes)");
    if (sender == .session and !std.mem.eql(u8, t, "http")) return try a.dupe(u8, "sender \"session\": only an http row (a BRC-103/104 session)");
    const prog = v.get("program") orelse return try a.dupe(u8, "program: want a program record's CID, or \"kernel\"");
    if (Value.str(prog)) |s| {
        if (!std.mem.eql(u8, s, "kernel")) return try std.fmt.allocPrint(a, "program {s}: want a program record's CID, or \"kernel\"", .{try json.quoted(a, s)});
        const op = Value.str(v.get("fn")) orelse return try a.dupe(u8, "fn: a kernel row names its operation (objects, head, dispatch or peers)");
        if (!isKernelOp(op)) return try std.fmt.allocPrint(a, "fn {s}: a kernel row's operation is objects, head, dispatch or peers", .{try json.quoted(a, op)});
        if (!std.mem.eql(u8, t, "mailbox")) return try a.dupe(u8, "a kernel row is a mailbox row (an admin box)");
    } else if (prog != .cid) return try a.dupe(u8, "program: want a program record's CID, or \"kernel\"");
    if (v.get("fn")) |f| if (f != .string and f != .null) return try a.dupe(u8, "fn: want text");
    return null;
}

/// The row `v` describes (null if it is not one: `problem`).
pub fn rowOf(v: Value) ?Row {
    if (v != .map) return null;
    const t = Value.str(v.get("transport")) orelse return null;
    const addr = Value.str(v.get("address")) orelse return null;
    const sender = senderOf(v.get("sender")) orelse return null;
    const prog = v.get("program") orelse return null;
    const is_kernel = Value.str(prog) != null;
    if (!is_kernel and prog != .cid) return null;
    const p = v.get("prefix");
    return .{
        .transport = t,
        .address = addr,
        .prefix = p != null and p.? == .bool and p.?.bool,
        .sender = sender,
        .program = if (is_kernel) null else prog.cid,
        .op = if (is_kernel) Value.str(v.get("fn")) else null,
        .func = Value.str(v.get("fn")),
        .value = v,
    };
}

fn senderEq(x: Sender, y: Sender) bool {
    return switch (x) {
        .any => y == .any,
        .session => y == .session,
        .key => |k| y == .key and std.mem.eql(u8, k, y.key),
    };
}

/// The same key: (transport, address, prefix, sender).
pub fn sameKey(x: Row, y: Row) bool {
    return std.mem.eql(u8, x.transport, y.transport) and std.mem.eql(u8, x.address, y.address) and x.prefix == y.prefix and senderEq(x.sender, y.sender);
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

/// The rows as a dag-cbor array (a program's input, the serve frame).
pub fn valueOf(a: std.mem.Allocator, rows: []const Row) !Value {
    const out = try a.alloc(Value, rows.len);
    for (rows, out) |r, *o| o.* = r.value;
    return .{ .array = out };
}

pub const By = struct { thread: ?[]const u8, input: []const u8, at: i64 };

/// Apply a change; the update written, or null when it changes nothing. `v`
/// is the row (for a remove, its key fields suffice).
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

/// A message's row: the first `mailbox` row whose address is the box (or any
/// box) and whose sender takes `sender` (anyone, or that key; a `session`
/// sender takes no message).
pub fn forMail(rows: []const Row, sender: []const u8, box: []const u8) ?Row {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.transport, "mailbox")) continue;
        if (!std.mem.eql(u8, r.address, "*") and !std.mem.eql(u8, r.address, box)) continue;
        switch (r.sender) {
            .any => return r,
            .session => continue,
            .key => |k| if (std.mem.eql(u8, k, sender)) return r,
        }
    }
    return null;
}

/// An event's row: the first `mailbox` row from anyone whose address is the box (or any box).
pub fn forEvent(rows: []const Row, box: []const u8) ?Row {
    for (rows) |r| {
        if (!std.mem.eql(u8, r.transport, "mailbox") or r.sender != .any) continue;
        if (std.mem.eql(u8, r.address, "*") or std.mem.eql(u8, r.address, box)) return r;
    }
    return null;
}

test "fold: add replaces by key, remove deletes, first match wins" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const k1 = [_]u8{2} ++ [_]u8{1} ** 32;
    const k2 = [_]u8{3} ++ [_]u8{2} ** 32;
    const cid1 = try @import("cid").parse(a, "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    const row = struct {
        fn f(al: std.mem.Allocator, t: []const u8, addr: []const u8, sender: Value, prog: Value, func: ?[]const u8) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("transport", cbor.string(t));
            try m.put("address", cbor.string(addr));
            try m.put("sender", sender);
            try m.put("program", prog);
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
    const r1 = try row(a, "mailbox", "run", .{ .bytes = &k1 }, cbor.cidv(cid1), null);
    const r2 = try row(a, "mailbox", "run", cbor.string("*"), cbor.string("kernel"), "objects");
    try std.testing.expect((try problem(a, r1)) == null);
    try std.testing.expect((try problem(a, r2)) == null);
    try std.testing.expect((try problem(a, try row(a, "http", "/x", cbor.string("session"), cbor.string("kernel"), "objects"))) != null);
    try std.testing.expect((try problem(a, try row(a, "mailbox", "x", cbor.string("session"), cbor.cidv(cid1), null))) != null);
    const r1b = try row(a, "mailbox", "run", .{ .bytes = &k1 }, cbor.cidv(cid1), "later");
    const rows = try fold(a, &.{ try up(a, "add", r1), try up(a, "add", r2), try up(a, "add", r1b), try up(a, "remove", r2), try up(a, "remove", r2) });
    try std.testing.expectEqual(@as(usize, 1), rows.len);
    try std.testing.expectEqualStrings("later", rows[0].func.?);
    try std.testing.expect(forMail(rows, &k1, "run") != null);
    try std.testing.expect(forMail(rows, &k2, "run") == null);
    try std.testing.expect(forEvent(rows, "run") == null);
    const rows2 = try fold(a, &.{ try up(a, "add", r2), try up(a, "add", r1) });
    try std.testing.expect(forMail(rows2, &k2, "run").?.program == null);
    try std.testing.expectEqualStrings("objects", forEvent(rows2, "run").?.op.?);
}
