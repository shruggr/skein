// The subscriptions a step makes (skein 0.5.2): the in-step kernel calls
//
//   on(name, fn)    the calling app subscribes `fn` (a function of one of its own programs:
//                   "<role>.<fn>", or "<fn>" for an app with one program) to the facts named
//                   `name` exactly
//   off(name)       the calling app's subscriptions to `name` end
//
// No manifest entry, no permission, no filters, no prefix, no history: a subscription hears the
// facts that land after it exists. Kernel state, replayable: one chain, origin {kind: "on"}, whose
// updates are the calls as the steps made them —
//
//   {op: "on", name, app, role, fn, thread, input, at}
//   {op: "off", name, app, thread, input, at}
//
// — and the index's `on` map (index.zig: name ‖ 0 ‖ the update's seq → the update) is that chain
// applied in order: an `on` puts its update at its key, an `off` deletes every key under the name
// whose update names the app. So the subscriptions to a name, in key order, are in the order they
// were made. A fact (log.zig indexedName) steps each, the scheduler's `deliverFact`.
const std = @import("std");
const cbor = @import("cbor");
const storem = @import("store.zig");
const Value = cbor.Value;
const Store = storem.Store;

pub const KIND = "on";

pub const Op = enum { on, off };

/// One subscription as the `on` map holds it (the update its key names).
pub const Sub = struct { name: []const u8, app: []const u8, role: []const u8, func: []const u8, seq: i64 };

fn originValue(a: std.mem.Allocator) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string(KIND));
    return m.value();
}

pub fn origin(a: std.mem.Allocator) ![]u8 {
    return cbor.cidOfValue(a, try originValue(a));
}

/// A subscription from its update ({op: "on", name, app, role, fn}), or null.
pub fn subOf(u: Value, seq: i64) ?Sub {
    if (!std.mem.eql(u8, Value.str(u.get("op")) orelse "", "on")) return null;
    return .{
        .name = Value.str(u.get("name")) orelse return null,
        .app = Value.str(u.get("app")) orelse return null,
        .role = Value.str(u.get("role")) orelse return null,
        .func = Value.str(u.get("fn")) orelse return null,
        .seq = seq,
    };
}

pub const By = struct { thread: ?[]const u8, input: []const u8, at: i64 };

/// Apply one call; the update written, or null when it changes nothing (an `on` the app already
/// has — same name, role and fn — or an `off` of a name the app has no subscription to).
pub fn apply(a: std.mem.Allocator, s: Store, op: Op, name: []const u8, app: []const u8, role: []const u8, func: []const u8, by: By) !?[]u8 {
    const now = try s.subscribers(a, name);
    switch (op) {
        .on => for (now) |x| if (std.mem.eql(u8, x.app, app) and std.mem.eql(u8, x.role, role) and std.mem.eql(u8, x.func, func)) return null,
        .off => {
            var any = false;
            for (now) |x| any = any or std.mem.eql(u8, x.app, app);
            if (!any) return null;
        },
    }
    const o = try s.chainOpen(a, try originValue(a));
    var m = cbor.MapBuilder.init(a);
    try m.put("op", cbor.string(@tagName(op)));
    try m.put("name", cbor.string(name));
    try m.put("app", cbor.string(app));
    if (op == .on) {
        try m.put("role", cbor.string(role));
        try m.put("fn", cbor.string(func));
    }
    try m.put("thread", cbor.optCid(by.thread));
    try m.put("input", cbor.cidv(by.input));
    try m.put("at", cbor.int(by.at));
    return try s.chainAppend(a, o, m.value());
}

/// The handler a call names — "<role>.<fn>", or "<fn>" when the app's record names one program —
/// as (role, fn), or why it is not one. `programs` is the app record's `programs` map.
pub fn handlerOf(a: std.mem.Allocator, h: []const u8, app: []const u8, programs: ?Value) !union(enum) { ok: struct { role: []const u8, func: []const u8 }, bad: []u8 } {
    const ps = programs orelse return .{ .bad = try std.fmt.allocPrint(a, "on: app {s} has no record at {s}/app, so no program of it is named", .{ app, app }) };
    if (ps != .map) return .{ .bad = try std.fmt.allocPrint(a, "on: app {s}'s record names no programs", .{app}) };
    var role: []const u8 = undefined;
    var func: []const u8 = undefined;
    if (std.mem.indexOfScalar(u8, h, '.')) |dot| {
        role = h[0..dot];
        func = h[dot + 1 ..];
    } else {
        if (ps.map.len != 1) return .{ .bad = try std.fmt.allocPrint(a, "on: fn \"{s}\": name its program, \"<role>.<fn>\" (app {s} has {d} programs)", .{ h, app, ps.map.len }) };
        role = ps.map[0].key;
        func = h;
    }
    if (func.len == 0 or role.len == 0) return .{ .bad = try std.fmt.allocPrint(a, "on: fn \"{s}\": want \"<role>.<fn>\", or \"<fn>\" for an app with one program", .{h}) };
    if (Value.cidOf(ps.get(role)) == null) return .{ .bad = try std.fmt.allocPrint(a, "on: \"{s}\" is not a program of app {s} (its record at {s}/app)", .{ role, app, app }) };
    return .{ .ok = .{ .role = role, .func = func } };
}
