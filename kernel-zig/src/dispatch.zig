// The dispatch table (#77): one of the kernel's four tables, and the one that
// routes. It replaces the subscriptions chain, the genesis's `routes` and the
// front door's `routes` head (format 8): a route, a subscription and a libp2p
// topic or protocol differ only in where the address comes from.
//
//   row   {transport: "mailbox" | "http" | "libp2p" | "local",
//          address: text,          mailbox: a box name ("*": any box — a genesis-only catch-all,
//                                  a mailbox instance's); http: a path; libp2p: a topic, or
//                                  "/<protocol>"; local: a provider's name
//          prefix?: true,          http, and a libp2p topic (#119; not a `/<protocol>`): `address`
//                                  is a prefix (exact addresses match first, then the longest
//                                  prefix) — one `tm_` row takes every `tm_<txid>` topic
//          sender: "*" | "event" | "session" | "owner" | bytes(33),
//                                  "*": anyone (an open route; an event's box too); "event": events
//                                  only (#79: the host's wiring — a feed's header, a broadcaster's
//                                  proof, a route's admit — never a message); "session": an HTTP
//                                  route that needs a BRC-103/104 session, any identity; "owner"
//                                  (#115, http): the instance's owner's session (the genesis's
//                                  owner, else the claim's) — #121: nothing writes it (every sender is a key; the claim writes the owner's explorer row), and a row a log holds with it is still read so; a key: that
//                                  identity — a message's sender, the session's, a libp2p peer's
//          program: <cid> | "kernel",
//                                  the handler (a program record in the store), or the kernel
//                                  itself: an admin operation (`fn`: objects | head | dispatch | peers),
//                                  or the claim (#89: an image's one row, from anyone)
//          fn?: text,              http/libp2p: the handler's function; kernel: the operation
//          filter?: "beef",        #121: what the kernel's door runs on the package before its entry is
//                                  written (scheduler.zig door, door.zig): a setting like any other
//          …}                      a handler's own settings, carried to it as `match` (static's
//                                  `root`, `index`; the install's `app`; a `read` op, a genesis
//                                  before #115's: checked against its `reads` in `takes`)
//
// The table is one chain per instance: origin {kind: "dispatch"}, one update
// per change {op: "add" | "remove", row, thread?, input, at}; the rows are the
// updates folded in order. A row's key is (transport, address, prefix,
// sender): `add` replaces the row with that key in place (nothing written when
// it is the same row), else appends; `remove` deletes it (nothing written when
// there is none). First match wins, in table order, for every transport
// (#115: `match` below — the one walk; the front door is handed the row and
// only verifies who the request is from). The genesis's `dispatch`
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
pub const admin_ops = [_][]const u8{ "objects", "head", "dispatch", "peers" };
/// What a kernel row may name (#89): the admin operations, and the claim —
/// an image's wildcard row, taken once: the claimed owner's admin rows
/// written and the claim row removed (scheduler.zig kernelOp).
pub const kernel_ops = admin_ops ++ [_][]const u8{"claim"};

pub const Sender = union(enum) { any, event, session, owner, key: []const u8 };

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

pub fn isAdminOp(op: []const u8) bool {
    for (admin_ops) |x| if (std.mem.eql(u8, x, op)) return true;
    return false;
}

/// Whether the table has an admin row (a kernel row for objects, head, dispatch or peers): the instance is owned (#89).
pub fn hasAdminRow(rows: []const Row) bool {
    for (rows) |r| if (r.op) |op| if (isAdminOp(op)) return true;
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
        if (std.mem.eql(u8, s, "event")) return .event;
        if (std.mem.eql(u8, s, "session")) return .session;
        if (std.mem.eql(u8, s, "owner")) return .owner;
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
        if (p == .bool and p.bool) {
            const topic = std.mem.eql(u8, t, "libp2p") and addr[0] != '/';
            if (!std.mem.eql(u8, t, "http") and !topic) return try a.dupe(u8, "prefix: only an http row or a libp2p topic row has one (a /protocol is exact)");
        }
    }
    const sender = senderOf(v.get("sender")) orelse return try a.dupe(u8, "sender: want \"*\", \"event\" (mailbox), \"session\" or \"owner\" (http) or an identity key (33 bytes)");
    if (sender == .session and !std.mem.eql(u8, t, "http")) return try a.dupe(u8, "sender \"session\": only an http row (a BRC-103/104 session)");
    if (sender == .owner and !std.mem.eql(u8, t, "http")) return try a.dupe(u8, "sender \"owner\": only an http row (the owner's BRC-103/104 session)");
    if (sender == .event and !std.mem.eql(u8, t, "mailbox")) return try a.dupe(u8, "sender \"event\": only a mailbox row (a box events are admitted into)");
    const prog = v.get("program") orelse return try a.dupe(u8, "program: want a program record's CID, or \"kernel\"");
    if (Value.str(prog)) |s| {
        if (!std.mem.eql(u8, s, "kernel")) return try std.fmt.allocPrint(a, "program {s}: want a program record's CID, or \"kernel\"", .{try json.quoted(a, s)});
        const op = Value.str(v.get("fn")) orelse return try a.dupe(u8, "fn: a kernel row names its operation (objects, head, dispatch, peers or claim)");
        if (!isKernelOp(op)) return try std.fmt.allocPrint(a, "fn {s}: a kernel row's operation is objects, head, dispatch, peers or claim", .{try json.quoted(a, op)});
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
        .event => y == .event,
        .session => y == .session,
        .owner => y == .owner,
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

// ---------------------------------------------------------------- the match (#115)
//
// One walk for every transport: the first row, in table order, whose
// transport and address take the package and whose sender rule takes who it
// is from. What it is from is what the package claims — a message's sender, an
// HTTP request's `x-bsv-auth-identity-key`, a libp2p peer's key — and the
// front door verifies that claim before the row's handler runs (BRC-104's
// session and signature; GossipSub's signature): it is handed the row, never
// the table.

/// Who a package is from, as the match sees it.
pub const Who = struct {
    /// The sender's identity: a message's sender, the identity an HTTP request claims (its session's, verified by
    /// the front door before the handler runs), a libp2p peer's key; null: none (an HTTP request with no session).
    key: ?[]const u8 = null,
    /// An event (the host's wiring): no sender; only a `*` or an `event` row takes it.
    event: bool = false,
    /// The instance's owner (the genesis's, else the claim's), for an `owner` row.
    owner: ?[]const u8 = null,
    /// The genesis's `reads` (a log written before #115): a row with a `read` op takes only a sender they allow.
    reads: ?Value = null,
};

/// Whether `r`'s sender rule takes `w`.
pub fn takes(r: Row, w: Who) bool {
    const ok = switch (r.sender) {
        .any => return true,
        .event => w.event,
        .session => !w.event and w.key != null and std.mem.eql(u8, r.transport, "http"),
        .owner => !w.event and w.key != null and w.owner != null and std.mem.eql(u8, r.transport, "http") and std.mem.eql(u8, w.key.?, w.owner.?),
        .key => |k| !w.event and w.key != null and std.mem.eql(u8, k, w.key.?),
    };
    if (!ok) return false;
    if (std.mem.eql(u8, r.transport, "http")) if (Value.str(r.value.get("read"))) |op| return mayRead(w, op);
    return true;
}

/// A legacy read permission (the genesis's `reads`, before #115: [{caller?, op} | {owner: true, op}]).
fn mayRead(w: Who, op: []const u8) bool {
    const rs = w.reads orelse return false;
    if (rs != .array) return false;
    const caller = w.key orelse return false;
    for (rs.array) |r| {
        const o = Value.str(r.get("op")) orelse "";
        if (!std.mem.eql(u8, o, op) and !std.mem.eql(u8, o, "*")) continue;
        if (r.get("owner")) |x| if (x == .bool and x.bool) {
            if (w.owner) |k| if (std.mem.eql(u8, k, caller)) return true;
            continue;
        };
        const who = Value.bytesOf(r.get("caller")) orelse return true;
        if (std.mem.eql(u8, who, caller)) return true;
    }
    return false;
}

/// Which addresses a walk takes.
const Address = union(enum) {
    /// a mailbox box: the row's address, or a `*` row
    box: []const u8,
    /// exactly this address, no prefix row (an http path, a libp2p topic or protocol)
    exact: []const u8,
    /// a prefix row of this length that `path` starts with
    prefix: struct { path: []const u8, len: usize },
};

fn addressed(r: Row, at: Address) bool {
    return switch (at) {
        .box => |b| std.mem.eql(u8, r.address, "*") or std.mem.eql(u8, r.address, b),
        .exact => |x| !r.prefix and std.mem.eql(u8, r.address, x),
        .prefix => |p| r.prefix and r.address.len == p.len and std.mem.startsWith(u8, p.path, r.address),
    };
}

/// What a walk found: the row, and whether any row of the transport had the address (for an HTTP refusal).
const Walk = struct { row: ?Row = null, addressed: bool = false };

/// The walk: the first row in table order of `transport` at `at` whose sender rule takes `w`.
fn first(rows: []const Row, transport: []const u8, at: Address, w: Who) Walk {
    var out: Walk = .{};
    for (rows) |r| {
        if (!std.mem.eql(u8, r.transport, transport) or !addressed(r, at)) continue;
        out.addressed = true;
        if (takes(r, w)) {
            out.row = r;
            return out;
        }
    }
    return out;
}

/// A message's row: the first `mailbox` row whose address is the box (or any
/// box) and whose sender takes `sender` (anyone, or that key; a `session` or
/// an `event` sender takes no message).
pub fn forMail(rows: []const Row, sender: []const u8, box: []const u8) ?Row {
    return first(rows, "mailbox", .{ .box = box }, .{ .key = sender }).row;
}

/// An event's row: the first `mailbox` row from `event` or anyone whose address is the box (or any box).
pub fn forEvent(rows: []const Row, box: []const u8) ?Row {
    return first(rows, "mailbox", .{ .box = box }, .{ .event = true }).row;
}

/// Why no `http` row takes a request: no row at its path (404), a row there
/// that needs a session and the request has none (401: the client shakes
/// hands), or rows there and none takes its identity (403).
pub const Refusal = enum {
    path,
    session,
    sender,
    pub fn text(r: Refusal) []const u8 {
        return @tagName(r);
    }
};

pub const HttpMatch = union(enum) { row: Row, refused: Refusal };

/// The match for an address that prefix rows may take (http paths, libp2p
/// topics): exact rows first, then prefix rows, longest first; within each,
/// the first in table order whose sender rule takes `w`.
fn exactThenPrefix(rows: []const Row, transport: []const u8, path: []const u8, w: Who) Walk {
    const ex = first(rows, transport, .{ .exact = path }, w);
    if (ex.row != null) return ex;
    var any = ex.addressed;
    // The prefix lengths that take `path`, longest first.
    var below: usize = std.math.maxInt(usize);
    while (true) {
        var len: ?usize = null;
        for (rows) |r| {
            if (!r.prefix or !std.mem.eql(u8, r.transport, transport) or r.address.len >= below) continue;
            if (!std.mem.startsWith(u8, path, r.address)) continue;
            if (len == null or r.address.len > len.?) len = r.address.len;
        }
        const l = len orelse break;
        const p = first(rows, transport, .{ .prefix = .{ .path = path, .len = l } }, w);
        if (p.row != null) return p;
        any = any or p.addressed;
        below = l;
    }
    return .{ .addressed = any };
}

/// A request's `http` row: exact paths first, then prefixes, longest first;
/// within each, first in table order whose sender rule takes `w`.
pub fn forHttp(rows: []const Row, path: []const u8, w: Who) HttpMatch {
    const m = exactThenPrefix(rows, "http", path, w);
    if (m.row) |r| return .{ .row = r };
    if (!m.addressed) return .{ .refused = .path };
    return .{ .refused = if (w.key == null) .session else .sender };
}

/// A libp2p package's row: a topic as an http path is matched (#119: exact
/// rows first, then `prefix` rows, longest first — one `tm_` row takes every
/// `tm_<txid>`); a `/<protocol>` exactly. Within each, the first `libp2p` row
/// in table order whose sender rule takes the peer's key.
pub fn forLibp2p(rows: []const Row, name: []const u8, w: Who) ?Row {
    if (name.len > 0 and name[0] == '/') return first(rows, "libp2p", .{ .exact = name }, w).row;
    return exactThenPrefix(rows, "libp2p", name, w).row;
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
    // #79: an `event` row takes events, never a message.
    const r3 = try row(a, "mailbox", "chain", cbor.string("event"), cbor.cidv(cid1), null);
    try std.testing.expect((try problem(a, r3)) == null);
    try std.testing.expect((try problem(a, try row(a, "http", "/x", cbor.string("event"), cbor.cidv(cid1), null))) != null);
    const rows3 = try fold(a, &.{try up(a, "add", r3)});
    try std.testing.expect(forEvent(rows3, "chain") != null);
    try std.testing.expect(forMail(rows3, &k1, "chain") == null);
    const rows2 = try fold(a, &.{ try up(a, "add", r2), try up(a, "add", r1) });
    try std.testing.expect(forMail(rows2, &k2, "run").?.program == null);
    try std.testing.expectEqualStrings("objects", forEvent(rows2, "run").?.op.?);
}

test "prefix (#119): an http row or a libp2p topic row; a /protocol and a mailbox row are exact" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cid1 = try @import("cid").parse(a, "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    const row = struct {
        fn f(al: std.mem.Allocator, t: []const u8, addr: []const u8, prog: []const u8) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("transport", cbor.string(t));
            try m.put("address", cbor.string(addr));
            try m.put("prefix", .{ .bool = true });
            try m.put("sender", cbor.string("*"));
            try m.put("program", cbor.cidv(prog));
            return m.value();
        }
    }.f;
    try std.testing.expect((try problem(a, try row(a, "http", "/x", cid1))) == null);
    try std.testing.expect((try problem(a, try row(a, "libp2p", "tm_", cid1))) == null);
    try std.testing.expect((try problem(a, try row(a, "libp2p", "/proto", cid1))) != null);
    try std.testing.expect((try problem(a, try row(a, "mailbox", "run", cid1))) != null);
    var up = cbor.MapBuilder.init(a);
    try up.put("op", cbor.string("add"));
    try up.put("row", try row(a, "libp2p", "tm_", cid1));
    const rows = try fold(a, &.{up.value()});
    try std.testing.expect(forLibp2p(rows, "tm_00ff", .{}) != null);
    try std.testing.expect(forLibp2p(rows, "tx_00ff", .{}) == null);
}
