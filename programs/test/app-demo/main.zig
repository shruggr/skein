//! app-demo (#72, #76): a test app for the install client and the SDK's
//! dispatch helper (skein-sdk `app`). This directory is the app's tree:
//! etc/app.json (the manifest), bin/app-demo.wasm (this program, built by
//! build.sh, committed). kernel-zig/equiv/install.ts installs it with
//! `skein-host install` and drives it.
//!
//! It provides `demo.counter/1` over its head's state ({kind:
//! "app-demo-state", count, ticks}, the root record's `state`):
//!
//!   demo.counter.get   writes: false          → {count}
//!   demo.counter.add   writes: true  {by, note?} → {count}   count += by
//!   demo.counter.peek  writes: false          tries to `put`: refused (read-only)
//!
//! reached three ways (APPS.md §4): a message {fn, args} in box `app-demo`
//! (from anyone; answered to the sender), the route /app-demo/call, an in-VM
//! call. Other messages, by box and body:
//!
//!   app-demo       {kind: "app-demo-start"}   (the install's start) asks the cron
//!                  provider for a tick every hour into `app-demo-tick`, named
//!                  "beat"; rests on its answer; finishes "scheduled beat next <ms>"
//!   app-demo       {kind: "app-demo-stop"}    (the uninstall's stop) stops "beat";
//!                  finishes "stopped beat <true|false>"
//!   app-demo-tick  a tick from the cron provider (admitted from `$cron` only):
//!                  ticks += 1; finishes "tick <ticks>"
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const app = @import("app");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const NAME = "app-demo";
const TICK_BOX = "app-demo-tick";

const fns = [_]app.Function{
    .{ .name = "demo.counter.get", .run = get },
    .{ .name = "demo.counter.add", .run = add },
    .{ .name = "demo.counter.peek", .run = peek },
};

pub fn main() u8 {
    return sk.main(NAME, run);
}

fn out(a: Allocator, comptime f: []const u8, args: anytype) !void {
    try std.Io.File.stdout().writeStreamingAll(sk.io(), try std.fmt.allocPrint(a, f ++ "\n", args));
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    if (eql(u8, Value.str(in.get("kind")) orelse "", "step")) {
        // The cron provider's answer to a start or a stop: the thread's next step.
        if (try sk.replyOf(a, in)) |r| {
            if (Value.str(r.body.get("error"))) |e| return sk.report(try std.fmt.allocPrint(a, "the cron provider: {s}", .{e}));
            const name = Value.str(r.body.get("name")) orelse "-";
            if (r.body.get("stopped")) |s| return out(a, "stopped {s} {}", .{ name, s == .bool and s.bool });
            return out(a, "scheduled {s} next {d}", .{ name, Value.intOf(r.body.get("next")) orelse -1 });
        }
        const args = in.get("args") orelse return sk.report("no args");
        if (eql(u8, Value.str(args.get("box")) orelse "", TICK_BOX)) return tick(a);
    }
    return app.serve(a, in, NAME, &fns, other);
}

/// The state as it stands (none yet: zero).
fn counts(s: ?Value) struct { count: i128, ticks: i128 } {
    const v = s orelse return .{ .count = 0, .ticks = 0 };
    return .{ .count = Value.intOf(v.get("count")) orelse 0, .ticks = Value.intOf(v.get("ticks")) orelse 0 };
}

fn stateValue(a: Allocator, count: i128, ticks: i128) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("app-demo-state"));
    try m.put("count", cbor.int(count));
    try m.put("ticks", cbor.int(ticks));
    return m.value();
}

fn countAnswer(a: Allocator, count: i128) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("count", cbor.int(count));
    return m.value();
}

fn get(c: *app.Call) !Value {
    return countAnswer(c.a, counts(try c.state()).count);
}

fn add(c: *app.Call) !Value {
    const now = counts(try c.state());
    const by = Value.intOf(c.args.get("by")).?;
    if (by == 0) return sk.report("by: not zero");
    _ = try c.setState(try stateValue(c.a, now.count + by, now.ticks));
    return countAnswer(c.a, now.count + by);
}

/// Declared `writes: false`, and it writes: the helper refuses the put.
fn peek(c: *app.Call) !Value {
    const now = counts(try c.state());
    _ = try c.put(try countAnswer(c.a, now.count));
    return countAnswer(c.a, now.count);
}

/// A message without `fn`: the start or the stop.
fn other(a: Allocator, in: Value, body: Value) !void {
    _ = in;
    const kind = Value.str(body.get("kind")) orelse "";
    var q = cbor.MapBuilder.init(a);
    try q.put("name", cbor.string("beat"));
    if (eql(u8, kind, "app-demo-start")) {
        try q.put("fn", cbor.string("tick"));
        try q.put("every", cbor.int(3_600_000));
        try q.put("box", cbor.string(TICK_BOX));
    } else if (eql(u8, kind, "app-demo-stop")) {
        try q.put("fn", cbor.string("stop"));
    } else return sk.report("not a call, a start or a stop");
    const id = try sk.emit(a, try sk.provider(a, "cron"), "cron", q.value(), null);
    try sk.awaitRecord(id);
}

fn tick(a: Allocator) !void {
    const m = try app.manifestOf(a, NAME);
    const now = counts(try app.stateOf(a, m));
    _ = try app.putState(a, NAME, m, try stateValue(a, now.count, now.ticks + 1));
    return out(a, "tick {d}", .{now.ticks + 1});
}
