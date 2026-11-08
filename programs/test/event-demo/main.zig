//! event-demo (skein 0.5.0): a test program for the kernel's event index. kernel-zig/equiv/
//! event-index.ts installs this module as two apps (`evx`, `evy`). Its steps, by what drives them:
//!
//!   a message {kind: "event-demo-emit", names: [<name>…], value} in the app's box: emits the
//!                  fact {event: <name>, value} for each name (the kernel refuses a name not under
//!                  the app's own); finishes "emitted <n>"
//!   a message {kind: "event-demo-read", query: {name | prefix, after?, limit?, latest?}}: reads
//!                  the event index in the step (the `events` import) and moves `<app>/read` to
//!                  {kind: "event-demo-read", answer: <the import's dag-cbor bytes>}
//!   a message {kind: "event-demo-route", transport, address, prefix?}: creates the route (the
//!                  `route` call, skein 0.5.1) — under an allowance of the app's, else the step
//!                  errors with the kernel's refusal; finishes "routed <transport> <address>"
//!   a libp2p message at fn `topic` (a route's, live or created): moves `<app>/seen` to
//!                  {kind: "event-demo-seen", topic, request} and is answered {verdict: "accept"}
//!   an event route's delivery (args {event, box, place, fn?}): moves `<app>/heard` to
//!                  {kind: "event-demo-heard", box, event, place, prev} — every fact heard, newest
//!                  first, chained by `prev`
//!
//! `<app>` is the app of the thread's program record (the install names it). The `events` and `route`
//! imports are skein-sdk 0.16.0's (`sk.events`, `sk.route`).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("event-demo", run);
}

fn out(a: Allocator, comptime f: []const u8, args: anytype) !void {
    try std.Io.File.stdout().writeStreamingAll(sk.io(), try std.fmt.allocPrint(a, f ++ "\n", args));
}

/// The app of the thread's program record.
fn appOf(a: Allocator, in: Value) ![]const u8 {
    const origin = try sk.get(a, Value.cidOf(in.get("thread")) orelse return sk.report("the step names no thread"));
    const prog = try sk.get(a, Value.cidOf(origin.get("program")) orelse return sk.report("the thread names no program"));
    return Value.str(prog.get("app")) orelse sk.report("the program record names no app");
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    if (eql(u8, Value.str(in.get("kind")) orelse "", "call") and eql(u8, Value.str(in.get("fn")) orelse "", "topic")) return topic(a, in);
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "step")) return sk.report("event-demo takes steps, and fn topic");
    const args = in.get("args") orelse return sk.report("no args");
    const app = try appOf(a, in);
    if (args.get("place") != null) return heard(a, app, args);
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("not a message (no body)"));
    const kind = Value.str(body.get("kind")) orelse "";
    if (eql(u8, kind, "event-demo-emit")) return emitAll(a, body);
    if (eql(u8, kind, "event-demo-read")) return read(a, app, body);
    if (eql(u8, kind, "event-demo-route")) return makeRoute(a, body);
    return sk.report("event-demo: want event-demo-emit or event-demo-read");
}

fn emitAll(a: Allocator, body: Value) !void {
    const names = body.get("names") orelse return sk.report("event-demo-emit wants {names, value}");
    if (names != .array) return sk.report("event-demo-emit wants {names, value}");
    for (names.array) |n| {
        var m = cbor.MapBuilder.init(a);
        try m.put("event", n);
        try m.put("value", body.get("value") orelse .null);
        const bytes = try cbor.encode(a, m.value());
        _ = sk.result(a, sk.raw.emit, .{ bytes.ptr, @as(u32, @intCast(bytes.len)) }) catch return sk.report(sk.lastError());
    }
    return out(a, "emitted {d}", .{names.array.len});
}

fn read(a: Allocator, app: []const u8, body: Value) !void {
    const rows = sk.events(a, body.get("query") orelse return sk.report("event-demo-read wants {query}")) catch return sk.report(sk.lastError());
    const answer = try cbor.encode(a, rows);
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event-demo-read"));
    try m.put("answer", .{ .bytes = answer });
    try sk.advance(try std.fmt.allocPrint(a, "{s}/read", .{app}), try sk.put(a, m.value()));
    return out(a, "read", .{});
}

fn heard(a: Allocator, app: []const u8, args: Value) !void {
    const head = try std.fmt.allocPrint(a, "{s}/heard", .{app});
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event-demo-heard"));
    try m.put("box", args.get("box") orelse .null);
    try m.put("event", args.get("event") orelse .null);
    try m.put("place", args.get("place") orelse .null);
    try m.put("prev", if (try sk.head(a, head)) |p| cbor.cidv(p) else .null);
    try sk.advance(head, try sk.put(a, m.value()));
    return out(a, "heard {s}", .{Value.str(args.get("box")) orelse "?"});
}

fn makeRoute(a: Allocator, body: Value) !void {
    const t = Value.str(body.get("transport")) orelse return sk.report("event-demo-route wants {transport, address, prefix?}");
    const addr = Value.str(body.get("address")) orelse return sk.report("event-demo-route wants {transport, address, prefix?}");
    const prefix = if (body.get("prefix")) |p| p == .bool and p.bool else false;
    sk.route(a, t, addr, prefix) catch return sk.report(sk.lastError());
    return out(a, "routed {s} {s}", .{ t, addr });
}

/// A libp2p message at fn `topic`: `<app>/seen` (the app the match names) moved, then accepted.
fn topic(a: Allocator, in: Value) !void {
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("topic wants the front door's package");
    const match: Value = arg.get("match") orelse .null;
    const who = Value.str(match.get("app")) orelse return sk.report("the match names no app");
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event-demo-seen"));
    try m.put("topic", arg.get("topic") orelse .null);
    try m.put("request", arg.get("request") orelse .null);
    sk.advance(try std.fmt.allocPrint(a, "{s}/seen", .{who}), try sk.put(a, m.value())) catch return sk.report(sk.lastError());
    var v = cbor.MapBuilder.init(a);
    try v.put("verdict", cbor.string("accept"));
    return sk.answer(a, v.value());
}
