// Subscriptions (src/runtime/subscriptions.ts): the routing table as one chain,
// origin {kind: "subscriptions"}, one update per change {op, sender?, box,
// handler, thread?, input, at}; the rules are the updates folded in order.
const std = @import("std");
const cbor = @import("cbor.zig");
const json = @import("json.zig");
const secp = @import("secp.zig");
const heads = @import("heads.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub const Sub = struct { sender: ?[]const u8, box: ?[]const u8, handler: []const u8 };
pub const Rule = struct { op: []const u8, sender: ?[]const u8, box: []const u8, handler: []const u8 };

fn originValue(a: std.mem.Allocator) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("subscriptions"));
    return m.value();
}

pub fn origin(a: std.mem.Allocator) ![]u8 {
    return cbor.cidOfValue(a, try originValue(a));
}

pub fn isBox(s: []const u8) bool {
    return s.len > 0 and !heads.hasSpaceOrNul(s);
}

fn optEq(x: ?[]const u8, y: ?[]const u8) bool {
    if (x == null or y == null) return x == null and y == null;
    return std.mem.eql(u8, x.?, y.?);
}

fn same(s: Sub, r: Rule) bool {
    return optEq(s.sender, r.sender) and optEq(s.box, r.box) and std.mem.eql(u8, s.handler, r.handler);
}

pub fn matches(s: Sub, sender: []const u8, box: []const u8) bool {
    return (s.sender == null or std.mem.eql(u8, s.sender.?, sender)) and (s.box == null or std.mem.eql(u8, s.box.?, box));
}

/// Why a rule is malformed (ruleProblem), with JSON.stringify quoting; null if fine.
/// `op`, `sender`, `box` are given as the raw strings the program passed.
pub fn ruleProblem(a: std.mem.Allocator, op: []const u8, sender: ?[]const u8, box: []const u8) !?[]u8 {
    if (!std.mem.eql(u8, op, "add") and !std.mem.eql(u8, op, "remove")) return try std.fmt.allocPrint(a, "op {s} is not add or remove", .{try json.quoted(a, op)});
    if (sender) |s| if (!secp.isIdentity(s)) return try std.fmt.allocPrint(a, "sender {s} is not an identity key", .{try json.quoted(a, s)});
    if (!isBox(box)) return try std.fmt.allocPrint(a, "box {s} is not a box name", .{try json.quoted(a, box)});
    return null;
}

pub fn fold(a: std.mem.Allocator, updates: []const Value) ![]Sub {
    var out = std.array_list.Managed(Sub).init(a);
    for (updates) |u| {
        const r = Rule{
            .op = Value.str(u.get("op")) orelse "",
            .sender = Value.str(u.get("sender")),
            .box = Value.str(u.get("box")) orelse "",
            .handler = Value.cidOf(u.get("handler")) orelse "",
        };
        var idx: ?usize = null;
        for (out.items, 0..) |s, i| if (same(s, r)) {
            idx = i;
            break;
        };
        if (std.mem.eql(u8, r.op, "add") and idx == null) try out.append(.{ .sender = r.sender, .box = r.box, .handler = r.handler });
        if (std.mem.eql(u8, r.op, "remove") and idx != null) _ = out.orderedRemove(idx.?);
    }
    return out.items;
}

/// The rules now; null if the chain was never opened.
pub fn current(a: std.mem.Allocator, s: Store) !?[]Sub {
    const o = try origin(a);
    const ups = (try s.chainUpdates(a, o)) orelse return null;
    const vals = try a.alloc(Value, ups.len);
    for (ups, 0..) |c, i| vals[i] = (try s.get(a, c)) orelse return error.NotFound;
    return try fold(a, vals);
}

pub fn open(a: std.mem.Allocator, s: Store) ![]u8 {
    return s.chainOpen(a, try originValue(a));
}

pub const By = struct { thread: ?[]const u8, input: []const u8, at: i64 };

/// Apply a rule; the update written, or null when it changes nothing.
pub fn subscribe(a: std.mem.Allocator, s: Store, r: Rule, by: By) !?[]u8 {
    const now = (try current(a, s)) orelse &.{};
    var listed = false;
    for (now) |x| if (same(x, r)) {
        listed = true;
    };
    const add = std.mem.eql(u8, r.op, "add");
    if (if (add) listed else !listed) return null;
    const o = try open(a, s);
    var m = cbor.MapBuilder.init(a);
    try m.put("op", cbor.string(r.op));
    try m.put("sender", cbor.optStr(r.sender));
    try m.put("box", cbor.string(r.box));
    try m.put("handler", cbor.cidv(r.handler));
    try m.put("thread", cbor.optCid(by.thread));
    try m.put("input", cbor.cidv(by.input));
    try m.put("at", cbor.int(by.at));
    return try s.chainAppend(a, o, m.value());
}
