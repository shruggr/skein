//! order-probe (skein 0.8.0, kernel-zig/equiv/event-order.ts): facts under one name raised in one entry by threads of different step counts.
//!   message {kind: "rest", name: T}             the thread rests on T (on(T), no fn)
//!   message {kind: "on", name: T}               subscribe fn "heard" to T
//!   message {kind: "go", name: T}               emit T
//!   woken (resting thread, its step ≥ 2)        emit {event: <app>/x/<tag>, value: "rested"} then, if its rest message
//!                                               named `then`, emit that
//!   delivery (fresh thread, seq 1)              emit {event: <app>/x/<tag>, value: "heard"}; read latest of it in-step → head <app>/read
//!   message {kind: "read", name}                read latest → head <app>/read
//! A trigger <app>/t/<tag> (or the follow-on <app>/u/<tag>) raises its fact under <app>/x/<tag>.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("order-probe", run);
}

fn appOf(a: Allocator, in: Value) ![]const u8 {
    const origin = try sk.get(a, Value.cidOf(in.get("thread")) orelse return sk.report("no thread"));
    const prog = try sk.get(a, Value.cidOf(origin.get("program")) orelse return sk.report("no program"));
    return Value.str(prog.get("app")) orelse sk.report("no app");
}

fn emitX(a: Allocator, name: []const u8, value: []const u8, step: Value) !void {
    var m = cbor.MapBuilder.init(a);
    try m.put("event", cbor.string(name));
    try m.put("value", cbor.string(value));
    try m.put("step", step);
    const b = try cbor.encode(a, m.value());
    _ = sk.result(a, sk.raw.emit, .{ b.ptr, @as(u32, @intCast(b.len)) }) catch return sk.report(sk.lastError());
}

fn readLatest(a: Allocator, app: []const u8, name: []const u8) !void {
    var q = cbor.MapBuilder.init(a);
    try q.put("name", cbor.string(name));
    try q.put("latest", .{ .bool = true });
    const ans = sk.events(a, q.value()) catch return sk.report(sk.lastError());
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("order-read"));
    try m.put("answer", .{ .bytes = try cbor.encode(a, ans) });
    try sk.advance(try std.fmt.allocPrint(a, "{s}/read", .{app}), try sk.put(a, m.value()));
}

/// <app>/t/<tag> → <app>/x/<tag>; <app>/u/<tag> (the follow-on trigger) → <app>/x/<tag>.
fn xOf(a: Allocator, app: []const u8, trig: []const u8) ![]const u8 {
    const k = std.mem.lastIndexOfScalar(u8, trig, '/') orelse return sk.report("bad trigger");
    return std.fmt.allocPrint(a, "{s}/x/{s}", .{ app, trig[k + 1 ..] });
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "step")) return sk.report("steps only");
    const app = try appOf(a, in);
    const args = in.get("args") orelse return sk.report("no args");
    const step = in.get("step") orelse .null;
    if (args.get("place") != null) {
        // A subscription's delivery: a fresh thread (seq 1).
        const trig = Value.str(args.get("box")) orelse return sk.report("no box");
        const x = try xOf(a, app, trig);
        try emitX(a, x, "heard", step);
        return readLatest(a, app, x);
    }
    if (in.get("event")) |ev| if (ev.get("place") != null) {
        // A resting thread woken (its step ≥ 2): its rest message named `then`.
        const trig = Value.str(ev.get("box")) orelse return sk.report("no box");
        try emitX(a, try xOf(a, app, trig), "rested", step);
        const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("no body"));
        if (Value.str(body.get("then"))) |t| {
            var m = cbor.MapBuilder.init(a);
            try m.put("event", cbor.string(t));
            const b = try cbor.encode(a, m.value());
            _ = sk.result(a, sk.raw.emit, .{ b.ptr, @as(u32, @intCast(b.len)) }) catch return sk.report(sk.lastError());
        }
        return;
    };
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("no body"));
    const kind = Value.str(body.get("kind")) orelse "";
    const name = Value.str(body.get("name")) orelse return sk.report("want name");
    if (eql(u8, kind, "rest")) return sk.on(name, null) catch sk.report(sk.lastError());
    if (eql(u8, kind, "on")) return sk.on(name, "heard") catch sk.report(sk.lastError());
    if (eql(u8, kind, "go")) {
        var m = cbor.MapBuilder.init(a);
        try m.put("event", cbor.string(name));
        const b = try cbor.encode(a, m.value());
        _ = sk.result(a, sk.raw.emit, .{ b.ptr, @as(u32, @intCast(b.len)) }) catch return sk.report(sk.lastError());
        return;
    }
    if (eql(u8, kind, "read")) return readLatest(a, app, name);
    return sk.report("want rest, on, go, read");
}
