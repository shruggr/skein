//! fetch (issue #15, #70): GET a URL and write the body to stdout — a WASI
//! 0.2 component, a test fixture for a component's `emit`
//! (skein:kernel/skein, through wit-bindgen's C bindings). There is no
//! network import (#67): the request is a message to the address book's
//! `fetch` provider (the host's HTTP proxy) — {method: "GET", url} in box
//! "fetch" — and the step ends awaiting it; the provider's answer, a signed
//! message {replyTo, status, headers, body} (or {replyTo, error}), is the
//! entry that steps the thread again, and that step writes the body.
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

/// The key of the address book's `fetch` provider (the entry with role "fetch" under the head `peers`).
fn fetchProvider(a: std.mem.Allocator) ![]const u8 {
    var name: c.program_string_t = .{ .ptr = @constCast("peers".ptr), .len = 5 };
    var root: c.skein_kernel_skein_option_cid_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_head(&name, &root, &err)) return failed(err);
    if (!root.is_some) return error.NoFetchProvider;
    const book = try get(a, root.val.ptr[0..root.val.len]);
    for ((book.get("peers") orelse return error.NoFetchProvider).array) |e| {
        const p = try get(a, Value.cidOf(e.get("peer")) orelse continue);
        if (std.mem.eql(u8, Value.str(p.get("role")) orelse "", "fetch")) return Value.bytesOf(p.get("key")) orelse error.NoFetchProvider;
    }
    return error.NoFetchProvider;
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

    // The first step: emit the GET to the fetch provider and await its answer.
    const args = in.get("args") orelse return error.NoUrl;
    const body = try get(a, Value.cidOf(args.get("body")) orelse return error.NoUrl);
    const url = Value.str(body.get("url")) orelse return error.NoUrl;
    var req = cbor.MapBuilder.init(a);
    try req.put("method", cbor.string("GET"));
    try req.put("url", cbor.string(url));
    var msg = cbor.MapBuilder.init(a);
    try msg.put("to", .{ .bytes = try fetchProvider(a) });
    try msg.put("box", cbor.string("fetch"));
    try msg.put("body", .{ .bytes = try cbor.encode(a, req.value()) });
    const bytes = try cbor.encode(a, msg.value());
    var m: c.program_list_u8_t = .{ .ptr = @constCast(bytes.ptr), .len = bytes.len };
    var id: c.skein_kernel_skein_cid_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_emit(&m, &id, &err)) return failed(err);
    if (!c.skein_kernel_skein_await(&id, &err)) return failed(err);
}
