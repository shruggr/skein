// Components (issue #34): one C program (test/components/probe.c) as a
// preview1 module, as that module through the preview1 adapter, and as a
// native WASI 0.2 component (wasi-sdk wasm32-wasip2) — run by runner.runModule
// over the same empty tree, stdin, args, env, clock and random: the same
// stdout, stderr, exit status and tree. Fuel: a component's run burns the
// same fuel every time, draws on the step's meter, and runs out at the limit.
const std = @import("std");
const engine = @import("engine.zig");
const runner = @import("runner.zig");
const component = @import("component.zig");
const wasi = @import("wasi.zig");
const vfsm = @import("vfs.zig");
const tree = @import("tree.zig");
const syscalls = @import("syscalls.zig");

const builds = [_][]const u8{ "test/components/probe.p1.wasm", "test/components/probe.adapted.wasm", "test/components/probe.p2.wasm" };

const Fixed = struct {
    mix: syscalls.SplitMix = .{ .s = 7 },
    fn clock(_: *anyopaque, _: u32) u64 {
        return 1_700_000_000_123_456_789;
    }
    fn random(ctx: *anyopaque, out: []u8) void {
        const f: *Fixed = @ptrCast(@alignCast(ctx));
        f.mix.fill(out);
    }
};

const Out = struct { code: i32, stdout: []const u8, stderr: []const u8, tree: []const u8, fuel: u64, fatal: ?wasi.Fatal };

fn run(a: std.mem.Allocator, r: *runner.Runner, c: *runner.Compiled, args: []const []const u8, limit: ?u64) !Out {
    const empty = (try tree.hashTree(a, &.{})).cid;
    const v = try vfsm.Vfs.init(a, null, empty);
    const stdin = try wasi.Pipe.init(a, 1 << 20, "from stdin");
    const stdout = try wasi.Pipe.init(a, 1 << 20, "");
    const stderr = try wasi.Pipe.init(a, 1 << 20, "");
    const stdio = [3]*wasi.Desc{ try wasi.pipeDesc(a, v, stdin, false), try wasi.pipeDesc(a, v, stdout, true), try wasi.pipeDesc(a, v, stderr, true) };
    var fixed = Fixed{};
    var meter = engine.Meter.init(limit orelse engine.UNMETERED);
    var st = wasi.RunState{ .meter = if (limit != null) &meter else null };
    var svc = wasi.Services{ .ctx = &fixed, .state = &st, .clock = Fixed.clock, .random = Fixed.random };
    const code = r.runModule(a, c, v, args, &.{"PROBE=1"}, stdio, &svc, null) catch |err| switch (err) {
        error.Fatal => -1,
        else => return err,
    };
    return .{ .code = code, .stdout = try stdout.drain(a), .stderr = try stderr.drain(a), .tree = try v.commit(), .fuel = if (limit != null) meter.used() else 0, .fatal = st.fatal };
}

fn load(a: std.mem.Allocator, r: *runner.Runner, path: []const u8) !*runner.Compiled {
    const bytes = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, path, a, .limited(1 << 24));
    var em: []const u8 = "";
    return r.compile(bytes, &em) catch |err| {
        std.debug.print("{s}: {s}\n", .{ path, em });
        return err;
    };
}

test "components: a preview1 module, it through the adapter, and a native 0.2 component behave the same" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try runner.Runner.init(std.heap.page_allocator);
    var outs: [builds.len]Out = undefined;
    for (builds, 0..) |b, i| {
        const bytes = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, b, a, .limited(1 << 24));
        try std.testing.expectEqual(i != 0, component.isComponent(bytes));
        outs[i] = try run(a, r, try load(a, r, b), &.{ "probe", "fs" }, null);
    }
    const p1 = outs[0];
    try std.testing.expectEqual(@as(i32, 0), p1.code);
    try std.testing.expect(std.mem.indexOf(u8, p1.stdout, "read: 11 \"hello\nmore\n\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, p1.stdout, "open missing: -1 No such file or directory") != null);
    try std.testing.expect(std.mem.indexOf(u8, p1.stdout, "stdin: 10 \"from stdin\"") != null);
    for (outs[1..]) |o| {
        try std.testing.expectEqualStrings(p1.stdout, o.stdout);
        try std.testing.expectEqualStrings(p1.stderr, o.stderr);
        try std.testing.expectEqual(p1.code, o.code);
        try std.testing.expectEqualSlices(u8, p1.tree, o.tree);
    }
}

test "components: exit statuses (the adapter, and wasi-libc on 0.2, carry 0 and 1: wasi:cli/exit is ok/err)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try runner.Runner.init(std.heap.page_allocator);
    const want = [_][3]i32{ .{ 0, 0, 0 }, .{ 1, 1, 1 }, .{ 7, 1, 1 } };
    for (want, 0..) |w, k| {
        const arg = try std.fmt.allocPrint(a, "{d}", .{w[0]});
        for (builds, 0..) |b, i| {
            const o = try run(a, r, try load(a, r, b), &.{ "probe", "exit", arg }, null);
            std.testing.expectEqual(w[i], o.code) catch |e| {
                std.debug.print("case {d}, {s}\n", .{ k, b });
                return e;
            };
        }
    }
}

test "components: fuel is metered per store, the same every run, and runs out at the limit" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try runner.Runner.init(std.heap.page_allocator);
    for (builds[1..]) |b| {
        const c = try load(a, r, b);
        const x = try run(a, r, c, &.{ "probe", "spin", "10000" }, 1 << 40);
        const y = try run(a, r, c, &.{ "probe", "spin", "10000" }, 1 << 40);
        const z = try run(a, r, c, &.{ "probe", "spin", "20000" }, 1 << 40);
        try std.testing.expectEqual(@as(i32, 0), x.code);
        try std.testing.expect(x.fuel > 10000);
        try std.testing.expectEqual(x.fuel, y.fuel);
        try std.testing.expectEqualStrings(x.stdout, y.stdout);
        try std.testing.expect(z.fuel > x.fuel);
        // The extra 10000 iterations cost the same on every ABI: only the loop differs.
        const p1 = try load(a, r, builds[0]);
        const px = try run(a, r, p1, &.{ "probe", "spin", "10000" }, 1 << 40);
        const pz = try run(a, r, p1, &.{ "probe", "spin", "20000" }, 1 << 40);
        try std.testing.expectEqual(pz.fuel - px.fuel, z.fuel - x.fuel);
        try std.testing.expectEqualStrings(px.stdout, x.stdout);

        const limit: u64 = 5_000_000;
        const f1 = try run(a, r, c, &.{ "probe", "forever" }, limit);
        const f2 = try run(a, r, c, &.{ "probe", "forever" }, limit);
        try std.testing.expectEqual(@as(i32, -1), f1.code);
        try std.testing.expect(f1.fatal != null and f1.fatal.?.kind == .fuel);
        try std.testing.expectEqual(limit, f1.fuel);
        try std.testing.expectEqual(f1.fuel, f2.fuel);
    }
}

/// A run whose clock is the step's (issue #38): the entry's stamp plus the step's fuel, 1 ns each.
const OnFuel = struct {
    clock: syscalls.ThreadClock,
    mix: syscalls.SplitMix = .{ .s = 7 },
    fn read(ctx: *anyopaque, _: u32) u64 {
        const f: *OnFuel = @ptrCast(@alignCast(ctx));
        return @intCast(f.clock.read());
    }
    fn random(ctx: *anyopaque, out: []u8) void {
        const f: *OnFuel = @ptrCast(@alignCast(ctx));
        f.mix.fill(out);
    }
};

fn clockRun(a: std.mem.Allocator, r: *runner.Runner, c: *runner.Compiled, n: []const u8) !i64 {
    const empty = (try tree.hashTree(a, &.{})).cid;
    const v = try vfsm.Vfs.init(a, null, empty);
    const stdout = try wasi.Pipe.init(a, 1 << 20, "");
    const stdio = [3]*wasi.Desc{ try wasi.nullDesc(a, v), try wasi.pipeDesc(a, v, stdout, true), try wasi.nullDesc(a, v) };
    var meter = engine.Meter.init(1 << 40);
    var on = OnFuel{ .clock = .{ .base = 1_700_000_000_000_000_000, .meter = &meter } };
    var st = wasi.RunState{ .meter = &meter };
    var svc = wasi.Services{ .ctx = &on, .state = &st, .clock = OnFuel.read, .random = OnFuel.random };
    _ = try r.runModule(a, c, v, &.{ "probe", "clock", n }, &.{}, stdio, &svc, null);
    return std.fmt.parseInt(i64, std.mem.trim(u8, try stdout.drain(a), "\n"), 10);
}

test "components: the in-step clock runs on the component's fuel as on a module's (issue #38)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const r = try runner.Runner.init(std.heap.page_allocator);
    var growth: [builds.len]i64 = undefined;
    for (builds, 0..) |b, i| {
        const c = try load(a, r, b);
        const d1 = try clockRun(a, r, c, "10000");
        const d2 = try clockRun(a, r, c, "20000");
        try std.testing.expect(d1 > 10000); // the loop's fuel, in ns
        try std.testing.expectEqual(d1, try clockRun(a, r, c, "10000")); // deterministic
        growth[i] = d2 - d1;
    }
    // The extra 10000 iterations advance the clock by the same fuel on every ABI.
    for (growth[1..]) |g| try std.testing.expectEqual(growth[0], g);
}
