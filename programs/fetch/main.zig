//! fetch: GET a URL over standard `wasi:http` and write the body to stdout
//! (issue #15) — a WASI 0.2 component that knows nothing of skein's HTTP:
//! the kernel answers wasi:http/outgoing-handler through the host and records
//! request and response on the step's update, so a replay of the step reads
//! the recorded answer and never touches the network.
//!
//! The URL is argv[1]; without one (a handler step: argv is the program's
//! name alone) it is the `url` of the step's message body (dag-cbor
//! {url}, input.args.body), read through skein:kernel/skein.
//!
//! Exit 0 for a 2xx answer, else 1 with the status (or the error) on stderr.
const std = @import("std");
const cbor = @import("cbor");
const wasi_http = @import("wasi_http");
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
        const msg = std.fmt.allocPrint(a, "fetch: {s}{s}{s}\n", .{ @errorName(e), if (wasi_http.last_error.len > 0) ": " else "", wasi_http.last_error }) catch "fetch: error\n";
        std.Io.File.stderr().writeStreamingAll(io(), msg) catch {};
        return 1;
    };
    return 0;
}

fn run(a: std.mem.Allocator, argv: std.process.Args) !void {
    const args = try argv.toSlice(a);
    const url = if (args.len > 1) args[1] else try urlFromInput(a);
    const r = try wasi_http.request(a, "GET", url, &.{}, null);
    try std.Io.File.stdout().writeStreamingAll(io(), r.body);
    if (r.status < 200 or r.status >= 300) {
        const msg = try std.fmt.allocPrint(a, "fetch: {s}: HTTP {d}\n", .{ url, r.status });
        try std.Io.File.stderr().writeStreamingAll(io(), msg);
        return error.HttpStatus;
    }
}

/// input.args.body → the body record's `url`.
fn urlFromInput(a: std.mem.Allocator) ![]const u8 {
    var in: c.program_list_u8_t = undefined;
    c.skein_kernel_skein_input(&in);
    const step = try cbor.decode(a, in.ptr[0..in.len]);
    const body_cid = cbor.Value.cidOf((step.get("args") orelse return error.NoUrl).get("body")) orelse return error.NoUrl;
    var k: c.skein_kernel_skein_cid_t = .{ .ptr = @constCast(body_cid.ptr), .len = body_cid.len };
    var got: c.program_list_u8_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_get(&k, &got, &err)) return error.NoBody;
    const body = try cbor.decode(a, got.ptr[0..got.len]);
    return cbor.Value.str(body.get("url")) orelse error.NoUrl;
}
