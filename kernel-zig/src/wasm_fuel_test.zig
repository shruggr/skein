// Fuel by instrumentation (issue #35, wasm_fuel.zig) against wasmtime's own:
// the same module run both ways under wasmtime — metered by wasmtime's fuel,
// and rewritten and metered by its own counter (what the browser build does
// under V8) — must read the same fuel at every host call, end with the same
// fuel, and run out at the same point for any limit. And every program the
// kernel pins instruments to a valid module.
const std = @import("std");
const engine = @import("engine.zig");
const wt = @import("engine_wasmtime.zig");
const wasm_fuel = @import("wasm_fuel.zig");

const Probe = struct {
    meter: *engine.Meter,
    reads: std.array_list.Managed(u64),

    fn call(ctx: *anyopaque, index: usize, args: []const i64, _: []u8) engine.Ret {
        const p: *Probe = @ptrCast(@alignCast(ctx));
        if (index == 0) {
            p.reads.append(p.meter.used()) catch return .abort;
            return .{ .value = 0 };
        }
        return .{ .value = args[0] }; // h.arg: the identity (a value the compiler cannot see)
    }
};

const Trace = struct { out: engine.Outcome, reads: []u64, used: u64 };

fn trace(a: std.mem.Allocator, eng: *engine.Engine, bytes: []const u8, instrumented: bool, entry: []const u8, limit: u64) !Trace {
    var em: []const u8 = "";
    const mod = wt.Module.compileWith(eng, a, bytes, &em, instrumented) catch |err| {
        std.debug.print("compile: {s}\n", .{em});
        return err;
    };
    mod.entry = entry;
    var meter = engine.Meter.init(limit);
    var p = Probe{ .meter = &meter, .reads = .init(a) };
    const out = try mod.run(eng, &p, Probe.call, &em, a, &meter);
    return .{ .out = out, .reads = p.reads.items, .used = meter.used() };
}

fn expectSame(x: Trace, y: Trace) !void {
    try std.testing.expectEqualDeep(x.out, y.out);
    try std.testing.expectEqualSlices(u64, x.reads, y.reads);
    try std.testing.expectEqual(x.used, y.used);
}

test "instrumented fuel: the same reading at every host call and at the end as wasmtime's" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var eng = try engine.Engine.init();
    defer eng.deinit();
    const bytes = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/fuel/probe.wasm", a, .limited(1 << 20));
    for ([_][]const u8{ "f", "trap" }) |entry| {
        const native = try trace(a, &eng, bytes, false, entry, 1 << 40);
        const counted = try trace(a, &eng, bytes, true, entry, 1 << 40);
        try std.testing.expect(native.reads.len >= 1);
        try expectSame(native, counted);
    }
    const t = try trace(a, &eng, bytes, true, "trap", 1 << 40);
    try std.testing.expect(t.out == .trapped and t.out.trapped == .divide_by_zero);
}

test "instrumented fuel: exhaustion at the same point for every limit" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var eng = try engine.Engine.init();
    defer eng.deinit();
    const bytes = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/fuel/probe.wasm", a, .limited(1 << 20));
    const need = (try trace(a, &eng, bytes, false, "f", 1 << 40)).used;
    var limit: u64 = 1;
    var exhausted: usize = 0;
    while (limit <= need + 1) : (limit = if (limit < 64) limit + 1 else limit + limit / 13 + 1) {
        const native = try trace(a, &eng, bytes, false, "f", limit);
        const counted = try trace(a, &eng, bytes, true, "f", limit);
        expectSame(native, counted) catch |err| {
            std.debug.print("limit {d}: native {any} {any} {d}, counted {any} {any} {d}\n", .{ limit, native.out, native.reads, native.used, counted.out, counted.reads, counted.used });
            return err;
        };
        if (native.out == .trapped) exhausted += 1;
    }
    try std.testing.expect(exhausted > 20);
}

test "instrumented fuel: every pinned program instruments to a valid module" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var eng = try engine.Engine.init();
    defer eng.deinit();
    const io = std.testing.io;
    var dir = try std.Io.Dir.cwd().openDir(io, "../wasm", .{ .iterate = true });
    defer dir.close(io);
    var it = dir.iterate();
    var n: usize = 0;
    while (try it.next(io)) |e| {
        if (e.kind != .file or !std.mem.endsWith(u8, e.name, ".wasm")) continue;
        const bytes = try dir.readFileAlloc(io, e.name, a, .limited(1 << 30));
        if (!std.mem.eql(u8, bytes[4..8], "\x01\x00\x00\x00")) continue; // a component
        const ins = try wasm_fuel.instrument(a, bytes);
        var m: ?*engine.c.wasmtime_module_t = null;
        if (engine.c.wasmtime_module_validate(eng.e, ins.bytes.ptr, ins.bytes.len)) |err| {
            var msg: engine.c.wasm_name_t = undefined;
            engine.c.wasmtime_error_message(err, &msg);
            std.debug.print("{s}: {s}\n", .{ e.name, msg.data[0..msg.size] });
            return error.Invalid;
        }
        _ = &m;
        n += 1;
    }
    // wasm/ holds the boundary programs, the wallet and wire-probe (#83: the shell's modules are the shell
    // app's, not pinned here; run.sh's instrumented replay of the corpus instruments the ones it runs).
    try std.testing.expect(n >= 5);
}
