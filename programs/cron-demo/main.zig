//! cron-demo (#60): a test program for jobs. programs/cron-demo/build.sh
//! builds it into programs/cron-demo/cron-demo.wasm (committed;
//! src/host/cron.test.ts and kernel-zig/equiv/serve.ts run it).
//!
//! A handler of a job's box (a sender-less subscription): the router's plain
//! event {kind: "cron", name?, due, rest?} starts a thread, which rests on a
//! deadline `rest` ms (default 200) after the step's stamp — stdout
//! "resting <name> due <due>" — and, woken by the router's waker, finishes
//! with stdout "woke <name> due <due>". Any other event is refused.
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
    const ev = try sk.get(a, Value.cidOf(args.get("event")) orelse return sk.report("not an event (want a job's cron event)"));
    if (!std.mem.eql(u8, Value.str(ev.get("kind")) orelse "", "cron")) return sk.report("not a cron event");
    const name = Value.str(ev.get("name")) orelse "-";
    const due = Value.intOf(ev.get("due")) orelse return sk.report("a cron event with no due");
    // A later step: the deadline came.
    if (Value.cidOf(in.get("tip")) != null) return out(try std.fmt.allocPrint(a, "woke {s} due {d}\n", .{ name, due }));
    const rest = Value.intOf(ev.get("rest")) orelse 200;
    try sk.deadline(@intCast(at + rest));
    return out(try std.fmt.allocPrint(a, "resting {s} due {d}\n", .{ name, due }));
}
