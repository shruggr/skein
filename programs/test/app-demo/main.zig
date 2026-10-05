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
//!                  provider for a tick every hour into `app-demo/tick`, named
//!                  "beat"; rests on its answer; finishes "scheduled beat next <ms>"
//!   app-demo       {kind: "app-demo-stop"}    (the uninstall's stop) stops "beat";
//!                  finishes "stopped beat <true|false>"
//!   app-demo       {kind: "app-demo-peers", key, url} (#87) emits the kernel's
//!                  `peers` operation as the instance itself — refused: no row
//!                  admits a program to a kernel table; finishes "sent peers"
//!   app-demo/tick  a tick from the cron provider (admitted from `$cron` only):
//!                  ticks += 1; finishes "tick <ticks>"
//!   app-demo       {kind: "app-demo-forge", how, head, app?, name?} (K1): the
//!                  forgery the kernel refuses. With how "call" or "launch" it
//!                  puts a program record of its own (this module, `app` and
//!                  `name` as asked: say app "chain") and calls it (fn
//!                  `forge.advance`) or launches it (args {forge: <head>}); that
//!                  record is not installed, so its `advance` of `head` is
//!                  refused. With how "installed" it calls its own record — the
//!                  one the install wrote, a dispatch row's program — which
//!                  writes heads under app-demo/. A call's outcome is on stderr
//!                  ("forge call moved <head>" | "forge call refused: …"); a
//!                  launched thread errors with the kernel's refusal.
//!   app-demo       {kind: "app-demo-event", event, …fields} or {kind:
//!                  "app-demo-event", emit: {event, …fields}} (#119; the second for
//!                  a subscribe, whose `fn` would make the first a call): emits the
//!                  event {event, …fields} (kernel `emit`: any name; the record
//!                  names this app when its record is installed) — `subscribe` /
//!                  `unsubscribe` {topic} for the host's libp2p node, or a name
//!                  nobody wires; finishes "emitted <event>"
//!
//! A libp2p message delivered to fn `topic` (a libp2p row's, or a subscription
//! {topic, program, fn: "topic"}: equiv/emit-events.ts installs this module
//! under other app names) moves the head `<app>/seen` (the app the match
//! names) to {kind: "app-demo-seen", app, topic, request} and is answered
//! {verdict: "accept"}: which app's fn ran is in the store.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const app = @import("app");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const NAME = "app-demo";
const TICK_BOX = "app-demo/tick"; // the manifest writes "tick" (#128: a box is relative to the app)

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
    const kind = Value.str(in.get("kind")) orelse "";
    // K1: the forged record's work (called, or launched), and the forge's thread woken by its child.
    // #119: a gossiped message on a topic a libp2p row of the app takes.
    if (eql(u8, kind, "call") and eql(u8, Value.str(in.get("fn")) orelse "", "topic")) return topic(a, in);
    if (eql(u8, kind, "call") and eql(u8, Value.str(in.get("fn")) orelse "", "forge.advance")) {
        const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("forge.advance wants {head}");
        return forgeAdvance(a, Value.str(arg.get("head")) orelse return sk.report("forge.advance wants {head}"));
    }
    if (eql(u8, kind, "step")) if (in.get("args")) |args| if (Value.str(args.get("forge"))) |h| return forgeAdvance(a, h);
    if (eql(u8, kind, "step") and in.get("resolved") != null) return out(a, "forge: the launched thread came to rest", .{});
    if (eql(u8, kind, "step")) {
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

/// A message without `fn`: the start or the stop — or (#87) a program
/// reaching for the address book.
fn other(a: Allocator, in: Value, body: Value) !void {
    const kind = Value.str(body.get("kind")) orelse "";
    if (eql(u8, kind, "app-demo-peers")) return peers(a, in, body);
    if (eql(u8, kind, "app-demo-forge")) return forge(a, in, body);
    if (eql(u8, kind, "app-demo-event")) return event(a, body);
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

/// {kind: "app-demo-peers", key, url}: the kernel's `peers` operation asked
/// as the instance itself — what any program can emit (#87). No row admits
/// the instance's own key to an admin box, so the kernel records the message
/// and runs nothing; this thread does not wait for an answer that never comes.
fn peers(a: Allocator, in: Value, body: Value) !void {
    const self: Value = in.get("self") orelse .null;
    const me = Value.bytesOf(self.get("identity")) orelse return sk.report("the step names no instance identity");
    var q = cbor.MapBuilder.init(a);
    try q.put("op", cbor.string("add"));
    try q.put("key", body.get("key") orelse return sk.report("app-demo-peers wants {key, url}"));
    try q.put("url", body.get("url") orelse return sk.report("app-demo-peers wants {key, url}"));
    _ = try sk.emit(a, me, "peers", q.value(), null);
    return out(a, "sent peers", .{});
}

/// {kind: "app-demo-event", event, …fields} (#119): the event {event, …fields} emitted. Or
/// {kind: "app-demo-event", emit: {event, …fields}}: the same, for an event with a field a
/// call's message has at the top (a subscription's `fn`).
fn event(a: Allocator, body: Value) !void {
    const src: Value = if (body.get("emit")) |x| (if (x == .map) x else body) else body;
    const name = Value.str(src.get("event")) orelse return sk.report("app-demo-event wants {event, …fields} or {emit: {event, …fields}}");
    var m = cbor.MapBuilder.init(a);
    for (src.map) |e| if (!eql(u8, e.key, "kind")) try m.put(e.key, e.value);
    const bytes = try cbor.encode(a, m.value());
    _ = sk.result(a, sk.raw.emit, .{ bytes.ptr, @as(u32, @intCast(bytes.len)) }) catch return sk.report(sk.lastError());
    return out(a, "emitted {s}", .{name});
}

fn tick(a: Allocator) !void {
    const m = try app.manifestOf(a, NAME);
    const now = counts(try app.stateOf(a, m));
    _ = try app.putState(a, NAME, m, try stateValue(a, now.count, now.ticks + 1));
    return out(a, "tick {d}", .{now.ticks + 1});
}

/// {kind: "app-demo-forge", how: "call" | "launch" | "installed", head, app?, name?} (K1).
fn forge(a: Allocator, in: Value, body: Value) !void {
    const how = Value.str(body.get("how")) orelse "";
    const head = Value.str(body.get("head")) orelse return sk.report("app-demo-forge wants {how, head, app?, name?}");
    const origin = try sk.get(a, Value.cidOf(in.get("thread")) orelse return sk.report("the step names no thread"));
    const mine = Value.cidOf(origin.get("program")) orelse return sk.report("the thread names no program");
    var prog: []const u8 = mine;
    if (!eql(u8, how, "installed")) {
        // A program record of this step's own making: this module, under the app and name asked for.
        const rec = try sk.get(a, mine);
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("program"));
        try m.put("name", cbor.string(Value.str(body.get("name")) orelse "forged"));
        if (Value.str(body.get("app"))) |x| try m.put("app", cbor.string(x));
        try m.put("code", rec.get("code"));
        try m.put("inputs", rec.get("inputs"));
        try m.put("services", rec.get("services"));
        try m.put("description", cbor.string("a program record a step put (app-demo's forge, K1)"));
        prog = try sk.put(a, m.value());
    }
    if (eql(u8, how, "launch")) {
        var args = cbor.MapBuilder.init(a);
        try args.put("forge", cbor.string(head));
        _ = try sk.launch(a, prog, try sk.put(a, args.value()));
        return out(a, "forge launched", .{});
    }
    var arg = cbor.MapBuilder.init(a);
    try arg.put("head", cbor.string(head));
    const msg = if (sk.call(a, prog, "forge.advance", try cbor.encode(a, arg.value()))) |_|
        try std.fmt.allocPrint(a, "forge call moved {s}\n", .{head})
    else |_|
        try std.fmt.allocPrint(a, "forge call refused: {s}\n", .{sk.lastError()});
    try std.Io.File.stderr().writeStreamingAll(sk.io(), msg);
    return out(a, "forge called", .{});
}

/// A libp2p message delivered to fn `topic` (#119): `<app>/seen` moved to what it was, then accepted.
fn topic(a: Allocator, in: Value) !void {
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("topic wants the front door's package");
    const match: Value = arg.get("match") orelse .null;
    const who = Value.str(match.get("app")) orelse NAME;
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("app-demo-seen"));
    try m.put("app", cbor.string(who));
    try m.put("topic", arg.get("topic") orelse .null);
    try m.put("request", arg.get("request") orelse .null);
    const c = try sk.put(a, m.value());
    sk.advance(try std.fmt.allocPrint(a, "{s}/seen", .{who}), c) catch return sk.report(sk.lastError());
    var v = cbor.MapBuilder.init(a);
    try v.put("verdict", cbor.string("accept"));
    return sk.answer(a, v.value());
}

/// Advance `head` to a record of the forge's: allowed only in the running record's write scope.
fn forgeAdvance(a: Allocator, head: []const u8) !void {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("app-demo-forged"));
    try m.put("head", cbor.string(head));
    const c = try sk.put(a, m.value());
    sk.advance(head, c) catch return sk.report(sk.lastError());
    return out(a, "moved {s}", .{head});
}
