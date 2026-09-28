// Fuel (issue #5): the accounting in engine.Meter over hand-built modules —
// the same module burns the same fuel, a step's budget is shared by nested
// instances, a spinning module runs out at the limit every time.
const std = @import("std");
const engine = @import("engine.zig");

/// A module exporting f: () -> (), optionally importing h.f: () -> () (index 0)
/// that f calls first. `locals` is the local declaration vector, `body` the code.
fn module(a: std.mem.Allocator, with_import: bool, locals: []const u8, body: []const u8) ![]u8 {
    var m = std.array_list.Managed(u8).init(a);
    try m.appendSlice(&.{ 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 });
    try m.appendSlice(&.{ 1, 4, 1, 0x60, 0, 0 }); // type 0: () -> ()
    if (with_import) try m.appendSlice(&.{ 2, 7, 1, 1, 'h', 1, 'f', 0, 0 });
    try m.appendSlice(&.{ 3, 2, 1, 0 });
    try m.appendSlice(&.{ 7, 5, 1, 1, 'f', 0, if (with_import) 1 else 0 });
    var code = std.array_list.Managed(u8).init(a);
    try code.appendSlice(locals);
    if (with_import) try code.appendSlice(&.{ 0x10, 0 }); // call h.f
    try code.appendSlice(body);
    try code.append(0x0b);
    std.debug.assert(code.items.len + 2 < 128);
    try m.appendSlice(&.{ 10, @intCast(code.items.len + 2), 1, @intCast(code.items.len) });
    try m.appendSlice(code.items);
    return m.items;
}

/// Count a local i32 from 0 to n (n < 2^13, a 2-byte LEB).
fn counter(a: std.mem.Allocator, with_import: bool, n: u16) ![]u8 {
    std.debug.assert(n >= 64 and n < 8192);
    const body = [_]u8{
        0x03, 0x40, // loop
        0x20, 0, 0x41, 1, 0x6a, 0x22, 0, // local.tee 0 (local.get 0 + 1)
        0x41, @as(u8, @intCast(n & 0x7f)) | 0x80, @intCast(n >> 7), // i32.const n
        0x48, 0x0d, 0, // i32.lt_s; br_if 0
        0x0b, // end
    };
    return module(a, with_import, &.{ 1, 1, 0x7f }, &body);
}

const spin_body = [_]u8{ 0x03, 0x40, 0x0c, 0, 0x0b }; // loop br 0 end

const T = struct {
    eng: engine.Engine,
    a: std.mem.Allocator,

    fn compile(t: *T, bytes: []const u8) !*engine.Module {
        var em: []const u8 = "";
        const mod = engine.Module.compile(&t.eng, t.a, bytes, &em) catch |err| {
            std.debug.print("compile: {s}\n", .{em});
            return err;
        };
        mod.entry = "f";
        return mod;
    }
};

fn noop(_: *anyopaque, _: usize, _: []const i64, _: []u8) engine.Ret {
    return .{ .value = 0 };
}

/// The host of a parent module: its import runs `child` under the same meter.
const Nest = struct {
    t: *T,
    child: *engine.Module,
    meter: *engine.Meter,
    child_outcome: ?engine.Outcome = null,

    fn call(ctx: *anyopaque, _: usize, _: []const i64, _: []u8) engine.Ret {
        const n: *Nest = @ptrCast(@alignCast(ctx));
        var em: []const u8 = "";
        var dummy: u8 = 0;
        const out = n.child.run(&n.t.eng, &dummy, noop, &em, n.t.a, n.meter) catch return .abort;
        n.child_outcome = out;
        return if (out == .returned) .{ .value = 0 } else .abort;
    }
};

fn burn(t: *T, mod: *engine.Module, limit: u64) !struct { out: engine.Outcome, used: u64 } {
    var meter = engine.Meter.init(limit);
    var em: []const u8 = "";
    var dummy: u8 = 0;
    const out = try mod.run(&t.eng, &dummy, noop, &em, t.a, &meter);
    return .{ .out = out, .used = meter.used() };
}

test "fuel: the same module and input burn the same fuel, in proportion to the work" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var t = T{ .eng = try engine.Engine.init(), .a = arena.allocator() };
    defer t.eng.deinit();
    const m1 = try t.compile(try counter(t.a, false, 1000));
    const m2 = try t.compile(try counter(t.a, false, 2000));
    const m3 = try t.compile(try counter(t.a, false, 3000));
    const x = try burn(&t, m1, 1 << 40);
    const y = try burn(&t, m1, 1 << 40);
    try std.testing.expect(x.out == .returned and y.out == .returned);
    try std.testing.expect(x.used > 1000);
    try std.testing.expectEqual(x.used, y.used);
    const f2 = (try burn(&t, m2, 1 << 40)).used;
    const f3 = (try burn(&t, m3, 1 << 40)).used;
    try std.testing.expectEqual(f2 - x.used, f3 - f2); // a fixed cost per iteration
}

test "fuel: exhaustion traps at the limit, at the same point every time" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var t = T{ .eng = try engine.Engine.init(), .a = arena.allocator() };
    defer t.eng.deinit();
    const spin = try t.compile(try module(t.a, false, &.{0}, &spin_body));
    for (0..3) |_| {
        const r = try burn(&t, spin, 1_000_000);
        try std.testing.expect(r.out == .trapped and r.out.trapped == .out_of_fuel);
        try std.testing.expectEqual(@as(u64, 1_000_000), r.used); // an exhausted step used exactly its limit
    }
    try std.testing.expectEqualStrings("fuel exhausted", engine.Trap.out_of_fuel.v8Message());
    // A counting loop: its exact need passes; half of it runs out, every time.
    // (wasmtime checks fuel at function entries and loop headers, so a run
    // may overshoot by the few instructions after its last check; `used` is
    // then clamped to the limit. Exhaustion itself is only ever at a check.)
    const m = try t.compile(try counter(t.a, false, 1000));
    const need = (try burn(&t, m, 1 << 40)).used;
    const ok = try burn(&t, m, need);
    try std.testing.expect(ok.out == .returned);
    try std.testing.expectEqual(need, ok.used);
    for (0..2) |_| {
        const short = try burn(&t, m, need / 2);
        try std.testing.expect(short.out == .trapped and short.out.trapped == .out_of_fuel);
        try std.testing.expectEqual(need / 2, short.used);
    }
}

test "fuel: nested instances draw on one budget; a step's fuel is their sum" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var t = T{ .eng = try engine.Engine.init(), .a = arena.allocator() };
    defer t.eng.deinit();
    const parent = try t.compile(try counter(t.a, true, 500));
    const child = try t.compile(try counter(t.a, false, 1000));
    const c_alone = (try burn(&t, child, 1 << 40)).used;
    const p_alone = (try burn(&t, parent, 1 << 40)).used; // its import does nothing

    var meter = engine.Meter.init(1 << 40);
    var nest = Nest{ .t = &t, .child = child, .meter = &meter };
    var em: []const u8 = "";
    const out = try parent.run(&t.eng, &nest, Nest.call, &em, t.a, &meter);
    try std.testing.expect(out == .returned and nest.child_outcome.? == .returned);
    try std.testing.expectEqual(p_alone + c_alone, meter.used());

    // Enough for the child alone but not for both: the parent runs out after the child returns.
    const lim = c_alone + p_alone / 2;
    var tight = engine.Meter.init(lim);
    nest = .{ .t = &t, .child = child, .meter = &tight };
    const o2 = try parent.run(&t.eng, &nest, Nest.call, &em, t.a, &tight);
    try std.testing.expect(nest.child_outcome.? == .returned);
    try std.testing.expect(o2 == .trapped and o2.trapped == .out_of_fuel);
    try std.testing.expectEqual(lim, tight.used());

    // The child alone past the budget: it traps out of fuel; the parent is unwound.
    var small = engine.Meter.init(c_alone / 2);
    nest = .{ .t = &t, .child = child, .meter = &small };
    const o3 = try parent.run(&t.eng, &nest, Nest.call, &em, t.a, &small);
    try std.testing.expect(o3 == .aborted);
    try std.testing.expect(nest.child_outcome.? == .trapped and nest.child_outcome.?.trapped == .out_of_fuel);
    try std.testing.expectEqual(c_alone / 2, small.used());
}

test "fuel: a segment starts a new step's count with a full budget" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    var t = T{ .eng = try engine.Engine.init(), .a = arena.allocator() };
    defer t.eng.deinit();
    const m = try t.compile(try counter(t.a, false, 1000));
    const need = (try burn(&t, m, 1 << 40)).used;
    var meter = engine.Meter.init(need + need / 2);
    var em: []const u8 = "";
    var dummy: u8 = 0;
    try std.testing.expect((try m.run(&t.eng, &dummy, noop, &em, t.a, &meter)) == .returned);
    try std.testing.expectEqual(need, meter.used());
    meter.segment();
    try std.testing.expectEqual(@as(u64, 0), meter.used());
    // Without the segment the second run would exceed the limit; with it, it fits.
    try std.testing.expect((try m.run(&t.eng, &dummy, noop, &em, t.a, &meter)) == .returned);
    try std.testing.expectEqual(need, meter.used());
}
