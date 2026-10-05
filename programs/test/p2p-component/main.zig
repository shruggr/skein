//! p2p-component (#51, #70): libp2p from a WASI 0.2 component — a test
//! fixture (kernel-zig/test/components/build.sh commits it as p2p.wasm).
//! There is no libp2p interface any more (#67): a component publishes by a
//! message to the address book's `libp2p` provider, through `emit`
//! (skein:kernel/skein), and the provider's answer steps it again.
//!
//! As a handler step: the message body {topic, text} → emit publish {topic,
//! body: text} to the provider and await it. Called again with the answer
//! (input.reply): {seqno, recipients} → stdout "seqno <hex>"; {error} → exit 1.
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
        const msg = std.fmt.allocPrint(a, "p2p: {s}{s}{s}\n", .{ @errorName(e), if (last.len > 0) ": " else "", last }) catch "p2p: error\n";
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

/// The key of the host's libp2p service: the address book's entry at `local` `libp2p` (#126: no roles).
fn provider(a: std.mem.Allocator) ![]const u8 {
    var name: c.program_string_t = .{ .ptr = @constCast("peers".ptr), .len = 5 };
    var root: c.skein_kernel_skein_option_cid_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_head(&name, &root, &err)) return failed(err);
    if (!root.is_some) return error.NoProvider;
    const book = try get(a, root.val.ptr[0..root.val.len]);
    for ((book.get("peers") orelse return error.NoProvider).array) |e| {
        const p = try get(a, Value.cidOf(e.get("peer")) orelse continue);
        if (std.mem.eql(u8, Value.str(p.get("transport")) orelse "", "local") and std.mem.eql(u8, Value.str(p.get("address")) orelse "", "libp2p")) return Value.bytesOf(p.get("key")) orelse error.NoProvider;
    }
    return error.NoProvider;
}

fn run(a: std.mem.Allocator) !void {
    var in_bytes: c.program_list_u8_t = undefined;
    c.skein_kernel_skein_input(&in_bytes);
    const in = try cbor.decode(a, in_bytes.ptr[0..in_bytes.len]);

    if (in.get("reply")) |r| if (r == .map) {
        const ans = try get(a, Value.cidOf(r.get("body")) orelse return error.NoAnswer);
        if (Value.str(ans.get("error"))) |e| {
            last = e;
            return error.PublishFailed;
        }
        const seq = Value.bytesOf(ans.get("seqno")) orelse return error.NoSeqno;
        const hex = try a.alloc(u8, seq.len * 2);
        for (seq, 0..) |x, i| _ = try std.fmt.bufPrint(hex[2 * i ..][0..2], "{x:0>2}", .{x});
        return std.Io.File.stdout().writeStreamingAll(io(), try std.fmt.allocPrint(a, "seqno {s}\n", .{hex}));
    };

    const args = in.get("args") orelse return error.NoBody;
    const body = try get(a, Value.cidOf(args.get("body")) orelse return error.NoBody);
    var req = cbor.MapBuilder.init(a);
    try req.put("topic", cbor.string(Value.str(body.get("topic")) orelse return error.NoTopic));
    try req.put("body", .{ .bytes = Value.str(body.get("text")) orelse "" });
    var msg = cbor.MapBuilder.init(a);
    try msg.put("to", .{ .bytes = try provider(a) });
    try msg.put("box", cbor.string("publish"));
    try msg.put("body", .{ .bytes = try cbor.encode(a, req.value()) });
    const bytes = try cbor.encode(a, msg.value());
    var m: c.program_list_u8_t = .{ .ptr = @constCast(bytes.ptr), .len = bytes.len };
    var id: c.skein_kernel_skein_cid_t = undefined;
    var err: c.program_string_t = undefined;
    if (!c.skein_kernel_skein_emit(&m, &id, &err)) return failed(err);
    if (!c.skein_kernel_skein_await(&id, &err)) return failed(err);
}
