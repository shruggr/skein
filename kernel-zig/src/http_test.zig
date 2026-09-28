// wasi:http for components (issue #15): the `fetch` component
// (programs/fetch, committed as test/components/fetch.wasm by build.sh) run
// with a program host whose `http` is a stand-in for the host: the request
// the kernel hands it is the recorded-call shape (http.zig), the answer comes
// back as the incoming-response and its body stream. Its end-to-end twin —
// through the router, recorded on the update, replayed without the network —
// is kernel-zig/equiv/fetch.ts.
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
    var answer: ?[]const u8 = null;
    var mix: syscalls.SplitMix = .{ .s = 7 };

    fn clock(_: *anyopaque, _: u32) u64 {
        return 1_700_000_000_000_000_000;
    }
    fn random(_: *anyopaque, out: []u8) void {
        mix.fill(out);
    }
    fn http(imp: *program.Imports, req: []const u8) program.Err![]const u8 {
        try requests.append(try imp.alloc.dupe(u8, req));
        return answer orelse imp.failWith("connection refused (the test's host)");
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
        .http = http,
        .deadline = deadline,
        .call = call,
    };
};

const Out = struct { code: i32, stdout: []const u8, stderr: []const u8 };

fn fetch(a: std.mem.Allocator, r: *runner.Runner, c: *runner.Compiled, url: []const u8) !Out {
    const empty = (try tree.hashTree(a, &.{})).cid;
    const v = try vfsm.Vfs.init(a, null, empty);
    const stdout = try wasi.Pipe.init(a, 1 << 20, "");
    const stderr = try wasi.Pipe.init(a, 1 << 20, "");
    const stdio = [3]*wasi.Desc{ try wasi.nullDesc(a, v), try wasi.pipeDesc(a, v, stdout, true), try wasi.pipeDesc(a, v, stderr, true) };
    var st = wasi.RunState{};
    var dummy: u8 = 0;
    var svc = wasi.Services{ .ctx = &dummy, .state = &st, .clock = Fake.clock, .random = Fake.random };
    var imp = program.Imports{ .host = &Fake.host, .alloc = a };
    const code = try r.runModule(a, c, v, &.{ "fetch", url }, &.{}, stdio, &svc, &imp);
    return .{ .code = code, .stdout = try stdout.drain(a), .stderr = try stderr.drain(a) };
}

fn response(a: std.mem.Allocator, status: i64, body: []const u8) ![]const u8 {
    var h = cbor.MapBuilder.init(a);
    try h.put("content-type", cbor.string("text/plain"));
    var m = cbor.MapBuilder.init(a);
    try m.put("status", cbor.int(status));
    try m.put("headers", h.value());
    try m.put("body", .{ .bytes = body });
    return cbor.encode(a, m.value());
}

test "wasi:http: a component's GET is the recorded-call request; the answer is its incoming-response" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    Fake.requests = std.array_list.Managed([]const u8).init(a);
    const r = try runner.Runner.init(std.heap.page_allocator);
    const bytes = try std.fs.cwd().readFileAlloc(a, "test/components/fetch.wasm", 1 << 24);
    var em: []const u8 = "";
    const c = r.compile(bytes, &em) catch |e| {
        std.debug.print("fetch.wasm: {s}\n", .{em});
        return e;
    };

    // A body larger than one stream read (64 KiB), so the stream is read in chunks.
    const big = try a.alloc(u8, 200_000);
    for (big, 0..) |*b, i| b.* = @intCast('a' + i % 26);
    Fake.answer = try response(a, 200, big);
    const ok = try fetch(a, r, c, "https://example.test/hello?x=1");
    try std.testing.expectEqual(@as(i32, 0), ok.code);
    try std.testing.expectEqualSlices(u8, big, ok.stdout);
    try std.testing.expectEqual(@as(usize, 1), Fake.requests.items.len);
    var want = cbor.MapBuilder.init(a);
    try want.put("method", cbor.string("GET"));
    try want.put("url", cbor.string("https://example.test/hello?x=1"));
    try std.testing.expectEqualSlices(u8, try cbor.encode(a, want.value()), Fake.requests.items[0]);

    // A 404: the body still comes back; fetch reports the status.
    Fake.answer = try response(a, 404, "no such thing");
    const nf = try fetch(a, r, c, "http://example.test:8080");
    try std.testing.expectEqual(@as(i32, 1), nf.code);
    try std.testing.expectEqualStrings("no such thing", nf.stdout);
    try std.testing.expect(std.mem.indexOf(u8, nf.stderr, "HTTP 404") != null);
    const q = try cbor.decode(a, Fake.requests.items[1]);
    try std.testing.expectEqualStrings("http://example.test:8080/", Value.str(q.get("url")).?);

    // The host fails: the program gets error-code internal-error with the host's message.
    Fake.answer = null;
    const down = try fetch(a, r, c, "https://example.test/");
    try std.testing.expectEqual(@as(i32, 1), down.code);
    try std.testing.expect(std.mem.indexOf(u8, down.stderr, "internal-error: connection refused (the test's host)") != null);

    // A malformed answer is the program's error too, not the kernel's.
    Fake.answer = "\xa0";
    const bad = try fetch(a, r, c, "https://example.test/");
    try std.testing.expectEqual(@as(i32, 1), bad.code);
    try std.testing.expect(std.mem.indexOf(u8, bad.stderr, "not {status, headers, body}") != null);
}
