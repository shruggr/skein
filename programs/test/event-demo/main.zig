//! (0.5.4: a thread resting on an event name, equiv/rest-on.ts.)
//! event-demo (skein 0.5.0, 0.5.2, 0.5.3): a test program for the kernel's event index and its
//! subscriptions. kernel-zig/equiv/event-index.ts installs this module as two apps (`evx`, `evy`),
//! kernel-zig/equiv/on-off.ts as three (`evx`, `evy`, `evz`). Its steps, by what drives them:
//!
//!   a message {kind: "event-demo-emit", names: [<name>…], value, spin?} in the app's box, or a
//!                  host's event of that shape in a box an event route of the app takes: emits
//!                  the fact {event: <name>, value, spin?} for each name (the kernel refuses a name
//!                  not under the app's own); finishes "emitted <n>"
//!   a message {kind: "event-demo-read", query: {name | prefix, after?, limit?, latest?}}: reads
//!                  the event index in the step (`sk.events`) and moves `<app>/read` to
//!                  {kind: "event-demo-read", answer: <the read's dag-cbor bytes>}
//!   a message {kind: "event-demo-on", name, fn}: subscribes (`sk.on`, skein 0.5.2) — the step
//!                  errors with the kernel's refusal; finishes "on <name>"
//!   a message {kind: "event-demo-off", name, fn}: ends the app's one subscription of `fn` to
//!                  `name` (`sk.off`, skein 0.5.3); finishes "off <name>"
//!   a host's event {kind: "event-demo-rest", name, tag, spin?} in a box an event route of the app
//!                  takes (the thread is this program's own): the thread rests on `name`
//!                  (`sk.on(name, null)`, skein 0.5.4); its step ends resting ("resting <name>")
//!   that thread woken by a fact under its name (input `event` {event, box, place}, its args still
//!                  the rest event's): moves `<app>/woke` to {kind: "event-demo-woke", box, event,
//!                  place, tag: <the rest event's>, thread, step: <the thread's step>, prev}; it
//!                  calls nothing (the kernel keeps it resting on the name). With `spin`, first it
//!                  hashes `spin` times (equiv/rest-on.ts stops the kernel in it)
//!   a subscription's delivery (args {event, box, fn, place}): moves `<app>/heard` to
//!                  {kind: "event-demo-heard", box, fn, event, place, prev} — every fact heard,
//!                  newest first, chained by `prev`. With fn "slow", first it hashes the fact's
//!                  `spin` times (a step that takes a while: equiv/on-off.ts stops the kernel in it)
//!
//! `<app>` is the app of the thread's program record (the install names it). The imports are
//! skein-sdk 0.17.2's (`sk.events`, `sk.on`, `sk.off`).
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
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "step")) return sk.report("event-demo takes steps only");
    const args = in.get("args") orelse return sk.report("no args");
    const app = try appOf(a, in);
    if (args.get("place") != null) return heard(a, app, args);
    if (in.get("event")) |ev| if (ev.get("place") != null) return woke(a, app, in, ev);
    // A host's event in the app's box (an event route, the host's wiring): its record is the message.
    if (args.get("body") == null) if (Value.cidOf(args.get("event"))) |ec| {
        const rec = try sk.get(a, ec);
        if (eql(u8, Value.str(rec.get("kind")) orelse "", "event-demo-emit")) return emitAll(a, rec);
        if (eql(u8, Value.str(rec.get("kind")) orelse "", "event-demo-rest")) {
            const name = Value.str(rec.get("name")) orelse return sk.report("event-demo-rest wants {name, tag}");
            sk.on(name, null) catch return sk.report(sk.lastError());
            return out(a, "resting {s}", .{name});
        }
        return sk.report("event-demo: an event wants {kind: \"event-demo-emit\", names, value} or {kind: \"event-demo-rest\", name, tag}");
    };
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("not a message (no body)"));
    const kind = Value.str(body.get("kind")) orelse "";
    if (eql(u8, kind, "event-demo-emit")) return emitAll(a, body);
    if (eql(u8, kind, "event-demo-read")) return read(a, app, body);
    if (eql(u8, kind, "event-demo-on")) {
        const name = Value.str(body.get("name")) orelse return sk.report("event-demo-on wants {name, fn}");
        sk.on(name, Value.str(body.get("fn")) orelse return sk.report("event-demo-on wants {name, fn}")) catch return sk.report(sk.lastError());
        return out(a, "on {s}", .{name});
    }
    if (eql(u8, kind, "event-demo-off")) {
        const name = Value.str(body.get("name")) orelse return sk.report("event-demo-off wants {name, fn}");
        sk.off(name, Value.str(body.get("fn")) orelse return sk.report("event-demo-off wants {name, fn}")) catch return sk.report(sk.lastError());
        return out(a, "off {s}", .{name});
    }
    return sk.report("event-demo: want event-demo-emit, -read, -on or -off");
}

fn emitAll(a: Allocator, body: Value) !void {
    const names = body.get("names") orelse return sk.report("event-demo-emit wants {names, value}");
    if (names != .array) return sk.report("event-demo-emit wants {names, value}");
    for (names.array) |n| {
        var m = cbor.MapBuilder.init(a);
        try m.put("event", n);
        try m.put("value", body.get("value") orelse .null);
        if (body.get("spin")) |s| try m.put("spin", s);
        const bytes = try cbor.encode(a, m.value());
        _ = sk.result(a, sk.raw.emit, .{ bytes.ptr, @as(u32, @intCast(bytes.len)) }) catch return sk.report(sk.lastError());
    }
    return out(a, "emitted {d}", .{names.array.len});
}

fn read(a: Allocator, app: []const u8, body: Value) !void {
    const answer = sk.events(a, body.get("query") orelse return sk.report("event-demo-read wants {query}")) catch return sk.report(sk.lastError());
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event-demo-read"));
    try m.put("answer", .{ .bytes = try cbor.encode(a, answer) });
    try sk.advance(try std.fmt.allocPrint(a, "{s}/read", .{app}), try sk.put(a, m.value()));
    return out(a, "read", .{});
}

fn heard(a: Allocator, app: []const u8, args: Value) !void {
    if (eql(u8, Value.str(args.get("fn")) orelse "", "slow")) {
        const ev = try sk.get(a, Value.cidOf(args.get("event")) orelse return sk.report("a delivery names no event"));
        var h: [32]u8 = @splat(0);
        var i: i128 = Value.intOf(ev.get("spin")) orelse 0;
        while (i > 0) : (i -= 1) std.crypto.hash.sha2.Sha256.hash(&h, &h, .{});
    }
    const head = try std.fmt.allocPrint(a, "{s}/heard", .{app});
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event-demo-heard"));
    try m.put("box", args.get("box") orelse .null);
    try m.put("fn", args.get("fn") orelse .null);
    try m.put("event", args.get("event") orelse .null);
    try m.put("place", args.get("place") orelse .null);
    try m.put("prev", if (try sk.head(a, head)) |p| cbor.cidv(p) else .null);
    try sk.advance(head, try sk.put(a, m.value()));
    return out(a, "heard {s}", .{Value.str(args.get("box")) orelse "?"});
}

fn woke(a: Allocator, app: []const u8, in: Value, ev: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    const body = try sk.get(a, Value.cidOf(args.get("event")) orelse return sk.report("a woken thread names no rest event"));
    var h: [32]u8 = @splat(0);
    var i: i128 = Value.intOf(body.get("spin")) orelse 0;
    while (i > 0) : (i -= 1) std.crypto.hash.sha2.Sha256.hash(&h, &h, .{});
    const head = try std.fmt.allocPrint(a, "{s}/woke", .{app});
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event-demo-woke"));
    try m.put("box", ev.get("box") orelse .null);
    try m.put("event", ev.get("event") orelse .null);
    try m.put("place", ev.get("place") orelse .null);
    try m.put("tag", body.get("tag") orelse .null);
    try m.put("thread", in.get("thread") orelse .null);
    try m.put("step", in.get("step") orelse .null);
    try m.put("prev", if (try sk.head(a, head)) |p| cbor.cidv(p) else .null);
    try sk.advance(head, try sk.put(a, m.value()));
    return out(a, "woke {s}", .{Value.str(ev.get("box")) orelse "?"});
}
