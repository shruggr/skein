//! p2p-component (#51): the `skein:kernel/libp2p` interface from a WASI 0.2
//! component — the typed twin of preview1's `skein.libp2p`. A test fixture
//! (kernel-zig/src/libp2p_test.zig runs it; kernel-zig/test/components/build.sh
//! commits it as p2p.wasm). By argv:
//!
//!   publish <topic> <body>        → "seqno <n>"
//!   dial <peer> <protocol>        → "stream <n>"
//!   send <stream> <body>          → "sent"
//!   receive <stream>              → "frame <body>" | "pending" | "closed"
//!   close <stream>                → "closed"
//!
//! A call's error goes to stderr and exits 1.
const std = @import("std");
const c = @cImport(@cInclude("program.h"));

comptime {
    _ = @import("cabi");
}

/// The program's Io: one single-threaded WASI process, no concurrency.
fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

pub fn main(init: std.process.Init.Minimal) u8 {
    var arena_state = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    run(a, init.args) catch |e| {
        const msg = std.fmt.allocPrint(a, "p2p: {s}{s}\n", .{ @errorName(e), last }) catch "p2p: error\n";
        std.Io.File.stderr().writeStreamingAll(io(), msg) catch {};
        return 1;
    };
    return 0;
}

var last: []const u8 = "";

fn failed(err: c.program_string_t) error{CallFailed} {
    last = std.fmt.allocPrint(std.heap.wasm_allocator, ": {s}", .{err.ptr[0..err.len]}) catch "";
    return error.CallFailed;
}

fn s(x: []const u8) c.program_string_t {
    return .{ .ptr = @constCast(x.ptr), .len = x.len };
}

fn l(x: []const u8) c.program_list_u8_t {
    return .{ .ptr = @constCast(x.ptr), .len = x.len };
}

fn say(a: std.mem.Allocator, comptime f: []const u8, args: anytype) !void {
    try std.Io.File.stdout().writeStreamingAll(io(), try std.fmt.allocPrint(a, f, args));
}

fn run(a: std.mem.Allocator, argv: std.process.Args) !void {
    const args = try argv.toSlice(a);
    if (args.len < 3) return error.Usage;
    const op = args[1];
    var err: c.program_string_t = undefined;
    const eql = std.mem.eql;
    if (eql(u8, op, "publish") and args.len == 4) {
        var t = s(args[2]);
        var b = l(args[3]);
        var seq: u64 = 0;
        if (!c.skein_kernel_libp2p_publish(&t, &b, &seq, &err)) return failed(err);
        return say(a, "seqno {d}", .{seq});
    }
    if (eql(u8, op, "dial") and args.len == 4) {
        var p = s(args[2]);
        var q = s(args[3]);
        var id: u64 = 0;
        if (!c.skein_kernel_libp2p_dial(&p, &q, &id, &err)) return failed(err);
        return say(a, "stream {d}", .{id});
    }
    const id = try std.fmt.parseInt(u64, args[2], 10);
    if (eql(u8, op, "send") and args.len == 4) {
        var b = l(args[3]);
        if (!c.skein_kernel_libp2p_send(id, &b, &err)) return failed(err);
        return say(a, "sent", .{});
    }
    if (eql(u8, op, "receive")) {
        var r: c.skein_kernel_libp2p_received_t = undefined;
        if (!c.skein_kernel_libp2p_receive(id, &r, &err)) return failed(err);
        return switch (r.tag) {
            c.SKEIN_KERNEL_LIBP2P_RECEIVED_FRAME => say(a, "frame {s}", .{r.val.frame.ptr[0..r.val.frame.len]}),
            c.SKEIN_KERNEL_LIBP2P_RECEIVED_PENDING => say(a, "pending", .{}),
            else => say(a, "closed", .{}),
        };
    }
    if (eql(u8, op, "close")) {
        if (!c.skein_kernel_libp2p_close(id, &err)) return failed(err);
        return say(a, "closed", .{});
    }
    return error.Usage;
}
