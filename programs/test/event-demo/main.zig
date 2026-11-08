//! event-demo (skein 0.5.0): a test program for the kernel's event index. kernel-zig/equiv/
//! event-index.ts installs this module as two apps (`evx`, `evy`). Its steps, by what drives them:
//!
//!   a message {kind: "event-demo-emit", names: [<name>…], value} in the app's box: emits the
//!                  fact {event: <name>, value} for each name (the kernel refuses a name not under
//!                  the app's own); finishes "emitted <n>"
//!   a message {kind: "event-demo-read", query: {name | prefix, after?, limit?, latest?}}: reads
//!                  the event index in the step (the `events` import) and moves `<app>/read` to
//!                  {kind: "event-demo-read", answer: <the import's dag-cbor bytes>}
//!   an event route's delivery (args {event, box, place, fn?}): moves `<app>/heard` to
//!                  {kind: "event-demo-heard", box, event, place, prev} — every fact heard, newest
//!                  first, chained by `prev`
//!
//! `<app>` is the app of the thread's program record (the install names it).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

/// skein 0.5.0's read of the event index (kernel-zig/src/program.zig `events`).
extern "skein" fn events(q: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;

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
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "step")) return sk.report("event-demo takes steps only");
    const args = in.get("args") orelse return sk.report("no args");
    const app = try appOf(a, in);
    if (args.get("place") != null) return heard(a, app, args);
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("not a message (no body)"));
    const kind = Value.str(body.get("kind")) orelse "";
    if (eql(u8, kind, "event-demo-emit")) return emitAll(a, body);
    if (eql(u8, kind, "event-demo-read")) return read(a, app, body);
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
    const q = try cbor.encode(a, body.get("query") orelse return sk.report("event-demo-read wants {query}"));
    const answer = sk.result(a, events, .{ q.ptr, @as(u32, @intCast(q.len)) }) catch return sk.report(sk.lastError());
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
