//! fetch (issue #15, #70, #126): GET a URL and write the body to stdout — a
//! WASI 0.2 component, a test fixture for a component's `emit`
//! (skein:kernel/skein, through wit-bindgen's C bindings). There is no
//! network import for plain HTTP (#67): the request is an intention — the
//! event {event: "fetch", method: "GET", url} — which the step awaits; the
//! runtime sends it, signed with the instance's key, to its HTTP proxy, whose
//! signed answer {replyTo, request, status, headers, body} (or {replyTo,
//! request, error}) is the entry that steps the thread again, and that step
//! writes the body.
//!
//! As a handler step: the URL is the `url` of the step's message body
//! (dag-cbor {url}, input.args.body). Called again with the answer
//! (input.reply): the body on stdout; exit 0 for a 2xx answer, else 1 with
//! the status (or the error) on stderr.
const std = @import("std");
const cbor = @import("cbor");
const c = @cImport(@cInclude("program.h"));

comptime {
    _ = @import("cabi");
}

const Value = cbor.Value;

/// The program's Io: one single-threaded WASI process, no concurrency.
fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

var last: []const u8 = "";

pub fn main() u8 {
    var arena_state = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    run(a) catch |e| {
        const msg = std.fmt.allocPrint(a, "fetch: {s}{s}{s}\n", .{ @errorName(e), if (last.len > 0) ": " else "", last }) catch "fetch: error\n";
        std.Io.File.stderr().writeStreamingAll(io(), msg) catch {};
        return 1;
    };
    return 0;
}

fn failed(err: c.program_string_t) error{CallFailed} {
    last = std.heap.wasm_allocator.dupe(u8, err.ptr[0..err.len]) catch "";
    return error.CallFailed;
}

fn get(a: std.mem.Allocator, id: []const u8) !Value {
    var k: c.skein_kernel_skein_cid_t = .{ .ptr = @constCast(id.ptr), .len = id.len };
    var got: c.program_list_u8_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_get(&k, &got, &err)) return failed(err);
    return cbor.decode(a, got.ptr[0..got.len]);
}

fn run(a: std.mem.Allocator) !void {
    var in_bytes: c.program_list_u8_t = undefined;
    c.skein_kernel_skein_input(&in_bytes);
    const in = try cbor.decode(a, in_bytes.ptr[0..in_bytes.len]);

    // The provider's answer: the body on stdout.
    if (in.get("reply")) |r| if (r == .map) {
        const ans = try get(a, Value.cidOf(r.get("body")) orelse return error.NoAnswer);
        if (Value.str(ans.get("error"))) |e| {
            last = e;
            return error.NoAnswer;
        }
        const status = Value.intOf(ans.get("status")) orelse return error.NoAnswer;
        try std.Io.File.stdout().writeStreamingAll(io(), Value.bytesOf(ans.get("body")) orelse "");
        if (status < 200 or status >= 300) {
            last = try std.fmt.allocPrint(a, "HTTP {d}", .{status});
            return error.HttpStatus;
        }
        return;
    };

    // The first step: the GET as an intention (the `fetch` event), awaited.
    const args = in.get("args") orelse return error.NoUrl;
    const body = try get(a, Value.cidOf(args.get("body")) orelse return error.NoUrl);
    const url = Value.str(body.get("url")) orelse return error.NoUrl;
    var req = cbor.MapBuilder.init(a);
    try req.put("event", cbor.string("fetch"));
    try req.put("method", cbor.string("GET"));
    try req.put("url", cbor.string(url));
    const bytes = try cbor.encode(a, req.value());
    var m: c.program_list_u8_t = .{ .ptr = @constCast(bytes.ptr), .len = bytes.len };
    var id: c.skein_kernel_skein_cid_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_emit(&m, &id, &err)) return failed(err);
    if (!c.skein_kernel_skein_await(&id, &err)) return failed(err);
}
