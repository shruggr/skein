// skein:kernel/libp2p for components (#51): the p2p component
// (programs/p2p-component, committed as test/components/p2p.wasm) run with a
// program host whose `libp2p` is a stand-in for the router: each typed call
// arrives as the dag-cbor request preview1's `skein.libp2p` takes (the one
// recorded shape), and each answer is lifted back (seqno u64, stream id, the
// `received` variant, errors as the call's error). Its end-to-end twin — two
// routers, recorded on updates, replayed with no network — is
// src/host/p2p-router.test.ts.
const std = @import("std");
const cbor = @import("cbor.zig");
const runner = @import("runner.zig");
const program = @import("program.zig");
const wasi = @import("wasi.zig");
const vfsm = @import("vfs.zig");
const tree = @import("tree.zig");
const syscalls = @import("syscalls.zig");

const Value = cbor.Value;

const Fake = struct {
    var requests: std.array_list.Managed([]const u8) = undefined;
    var answer: []const u8 = "";
    var mix: syscalls.SplitMix = .{ .s = 9 };

    fn clock(_: *anyopaque, _: u32) u64 {
        return 1_700_000_000_000_000_000;
    }
    fn random(_: *anyopaque, out: []u8) void {
        mix.fill(out);
    }
    fn libp2p(imp: *program.Imports, req: []const u8) program.Err![]const u8 {
        try requests.append(try imp.alloc.dupe(u8, req));
        const v = cbor.decode(imp.alloc, answer) catch return imp.failWith("bad answer");
        if (Value.str(v.get("error"))) |e| return imp.failFmt("libp2p: {s}", .{e});
        return answer;
    }
    fn input(_: *program.Imports) []const u8 {
        return "";
    }
    fn refuse(imp: *program.Imports) program.Err {
        return imp.failWith("not in this test");
    }
    fn get(imp: *program.Imports, _: []const u8) program.Err![]const u8 {
        return refuse(imp);
    }
    fn putBlock(imp: *program.Imports, _: []const u8, _: []const u8) program.Err!void {
        return refuse(imp);
    }
    fn one(imp: *program.Imports, _: []const u8) program.Err!void {
        return refuse(imp);
    }
    fn two(imp: *program.Imports, _: []const u8, _: []const u8) program.Err![]const u8 {
        return refuse(imp);
    }
    fn head(imp: *program.Imports, _: []const u8) program.Err!?[]const u8 {
        return refuse(imp);
    }
    fn advance(imp: *program.Imports, _: []const u8, _: []const u8) program.Err!void {
        return refuse(imp);
    }
    fn subscribe(imp: *program.Imports, _: []const u8, _: ?[]const u8, _: []const u8, _: []const u8) program.Err!void {
        return refuse(imp);
    }
    fn deadline(imp: *program.Imports, _: i64) program.Err!void {
        return refuse(imp);
    }
    fn call(imp: *program.Imports, _: []const u8, _: []const u8, _: []const u8) program.Err![]const u8 {
        return refuse(imp);
    }
    const host = program.Host{
        .ctx = undefined,
        .input = input,
        .get = get,
        .put = get,
        .putBlock = putBlock,
        .keep = one,
        .launch = two,
        .awaitReply = one,
        .head = head,
        .advance = advance,
        .subscribe = subscribe,
        .wallet = get,
        .http = get,
        .libp2p = libp2p,
        .deadline = deadline,
        .call = call,
    };
};

const Out = struct { code: i32, stdout: []const u8, stderr: []const u8 };

fn run(a: std.mem.Allocator, r: *runner.Runner, c: *runner.Compiled, args: []const []const u8) !Out {
    const empty = (try tree.hashTree(a, &.{})).cid;
    const v = try vfsm.Vfs.init(a, null, empty);
    const stdout = try wasi.Pipe.init(a, 1 << 20, "");
    const stderr = try wasi.Pipe.init(a, 1 << 20, "");
    const stdio = [3]*wasi.Desc{ try wasi.nullDesc(a, v), try wasi.pipeDesc(a, v, stdout, true), try wasi.pipeDesc(a, v, stderr, true) };
    var st = wasi.RunState{};
    var dummy: u8 = 0;
    var svc = wasi.Services{ .ctx = &dummy, .state = &st, .clock = Fake.clock, .random = Fake.random };
    var imp = program.Imports{ .host = &Fake.host, .alloc = a };
    const argv = try a.alloc([]const u8, args.len + 1);
    argv[0] = "p2p";
    @memcpy(argv[1..], args);
    const code = try r.runModule(a, c, v, argv, &.{}, stdio, &svc, &imp);
    return .{ .code = code, .stdout = try stdout.drain(a), .stderr = try stderr.drain(a) };
}

fn enc(a: std.mem.Allocator, pairs: []const struct { []const u8, Value }) ![]const u8 {
    var m = cbor.MapBuilder.init(a);
    for (pairs) |p| try m.put(p[0], p[1]);
    return cbor.encode(a, m.value());
}

test "libp2p: a component's typed calls are the recorded dag-cbor requests; the answers lifted back" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    Fake.requests = std.array_list.Managed([]const u8).init(a);
    const r = try runner.Runner.init(std.heap.page_allocator);
    const bytes = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/components/p2p.wasm", a, .limited(1 << 24));
    var em: []const u8 = "";
    const c = r.compile(bytes, &em) catch |e| {
        std.debug.print("p2p.wasm: {s}\n", .{em});
        return e;
    };

    Fake.answer = try enc(a, &.{ .{ "seqno", .{ .bytes = &[_]u8{ 0, 0, 0, 0, 0, 0, 1, 2 } } }, .{ "recipients", cbor.int(1) } });
    const p = try run(a, r, c, &.{ "publish", "demo", "hello" });
    try std.testing.expectEqualStrings("seqno 258", p.stdout);
    try std.testing.expectEqualSlices(u8, try enc(a, &.{ .{ "op", cbor.string("publish") }, .{ "topic", cbor.string("demo") }, .{ "body", .{ .bytes = "hello" } } }), Fake.requests.items[0]);

    Fake.answer = try enc(a, &.{.{ "stream", cbor.int(1790000000000001) }});
    const d = try run(a, r, c, &.{ "dial", "16Uiu2HAm", "/skein/echo/1" });
    try std.testing.expectEqualStrings("stream 1790000000000001", d.stdout);
    try std.testing.expectEqualSlices(u8, try enc(a, &.{ .{ "op", cbor.string("dial") }, .{ "peer", cbor.string("16Uiu2HAm") }, .{ "protocol", cbor.string("/skein/echo/1") } }), Fake.requests.items[1]);

    Fake.answer = try enc(a, &.{});
    try std.testing.expectEqualStrings("sent", (try run(a, r, c, &.{ "send", "7", "ping" })).stdout);
    try std.testing.expectEqualSlices(u8, try enc(a, &.{ .{ "op", cbor.string("send") }, .{ "stream", cbor.int(7) }, .{ "body", .{ .bytes = "ping" } } }), Fake.requests.items[2]);

    Fake.answer = try enc(a, &.{.{ "pending", .{ .bool = true } }});
    try std.testing.expectEqualStrings("pending", (try run(a, r, c, &.{ "receive", "7" })).stdout);
    try std.testing.expectEqualSlices(u8, try enc(a, &.{ .{ "op", cbor.string("receive") }, .{ "stream", cbor.int(7) } }), Fake.requests.items[3]);
    Fake.answer = try enc(a, &.{.{ "body", .{ .bytes = "echo: ping" } }});
    try std.testing.expectEqualStrings("frame echo: ping", (try run(a, r, c, &.{ "receive", "7" })).stdout);
    Fake.answer = try enc(a, &.{.{ "closed", .{ .bool = true } }});
    try std.testing.expectEqualStrings("closed", (try run(a, r, c, &.{ "receive", "7" })).stdout);

    Fake.answer = try enc(a, &.{});
    try std.testing.expectEqualStrings("closed", (try run(a, r, c, &.{ "close", "7" })).stdout);

    // The host's {error} is the call's error, with its message.
    Fake.answer = try enc(a, &.{.{ "error", cbor.string("dial: no route to peer") }});
    const bad = try run(a, r, c, &.{ "dial", "x", "/p" });
    try std.testing.expectEqual(@as(i32, 1), bad.code);
    try std.testing.expect(std.mem.indexOf(u8, bad.stderr, "libp2p: dial: no route to peer") != null);
}
