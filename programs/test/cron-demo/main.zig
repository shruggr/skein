//! cron-demo (#60, #69): a test program for the cron provider. programs/test/cron-demo/build.sh
//! builds it into programs/test/cron-demo/cron-demo.wasm (committed;
//! src/host/cron.test.ts and kernel-zig/equiv/serve.ts run it).
//!
//! Scheduling is a message to a provider: the owner's schedule names the cron
//! service's key (`cron`), else the program takes the one its host serves
//! (the address book's entry at `local` `cron`; #126: no roles) — on this host
//! or a remote one (`mailbox`): the program does not care — and emits to it.
//! Two kinds of message start its threads, by subscription:
//!
//!   box `schedule` (its owner's)  {name, every?: ms, at?: ms, box?: "tick", rest?: ms, stop?: true, cron?: bytes(33)}
//!       emits {fn: "tick", every | at, box, body: {rest}, name} — or {fn: "stop", name} — to
//!       the cron provider, rests on the answer, and finishes with stdout
//!       "scheduled <name> next <ms>" | "stopped <name> <true|false>" (an error answer: the
//!       thread errors with it)
//!   a tick, in its box (from the cron provider)  {kind: "cron", name, due, rest?}
//!       rests on a deadline `rest` ms (default 200) after the step's stamp — stdout
//!       "resting <name> due <due>" — and, woken at it, finishes with stdout
//!       "woke <name> due <due>"
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;

pub fn main() u8 {
    return sk.main("cron-demo", run);
}

fn out(s: []const u8) !void {
    try std.Io.File.stdout().writeStreamingAll(sk.io(), s);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const at = Value.intOf(in.get("at")) orelse return sk.report("no at");
    const args = in.get("args") orelse return sk.report("no args");
    const box = Value.str(args.get("box")) orelse return sk.report("not a message (want a schedule or a tick)");
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("a message with no body"));
    if (std.mem.eql(u8, box, "schedule")) return schedule(a, in, body);
    if (!std.mem.eql(u8, Value.str(body.get("kind")) orelse "", "cron")) return sk.report("not a tick (want {kind: \"cron\", name, due})");
    const name = Value.str(body.get("name")) orelse "-";
    const due = Value.intOf(body.get("due")) orelse return sk.report("a tick with no due");
    // A later step: the deadline came.
    if (Value.cidOf(in.get("tip")) != null) return out(try std.fmt.allocPrint(a, "woke {s} due {d}\n", .{ name, due }));
    const rest = Value.intOf(body.get("rest")) orelse 200;
    try sk.deadline(@intCast(at + rest));
    return out(try std.fmt.allocPrint(a, "resting {s} due {d}\n", .{ name, due }));
}

/// A schedule from the owner: asked of the cron provider; the answer, the next step's.
fn schedule(a: Allocator, in: Value, body: Value) !void {
    if (try sk.replyOf(a, in)) |r| {
        if (Value.str(r.body.get("error"))) |e| return sk.report(try std.fmt.allocPrint(a, "the cron provider: {s}", .{e}));
        const name = Value.str(r.body.get("name")) orelse "-";
        if (r.body.get("stopped")) |s| return out(try std.fmt.allocPrint(a, "stopped {s} {}\n", .{ name, s == .bool and s.bool }));
        return out(try std.fmt.allocPrint(a, "scheduled {s} next {d}\n", .{ name, Value.intOf(r.body.get("next")) orelse -1 }));
    }
    const name = Value.str(body.get("name")) orelse return sk.report("a schedule names itself (name)");
    var q = cbor.MapBuilder.init(a);
    try q.put("name", .{ .string = name });
    if (body.get("stop") != null) {
        try q.put("fn", .{ .string = "stop" });
    } else {
        try q.put("fn", .{ .string = "tick" });
        if (body.get("every")) |e| try q.put("every", e);
        if (body.get("at")) |t| try q.put("at", t);
        try q.put("box", .{ .string = Value.str(body.get("box")) orelse "tick" });
        var tb = cbor.MapBuilder.init(a);
        if (body.get("rest")) |r| try tb.put("rest", r);
        try q.put("body", tb.value());
    }
    const svc = Value.bytesOf(body.get("cron")) orelse (try sk.peerAt(a, "local", "cron")) orelse return sk.report("no cron service: the schedule names none (`cron`) and the host serves none (local cron)");
    const id = try sk.emit(a, svc, "cron", q.value(), null);
    try sk.awaitRecord(id);
}
