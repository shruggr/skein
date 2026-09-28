// The browser engine backend (engine.zig is the interface; issue #35): V8,
// through the JS shim (kernel-zig/web/kernel.js). The kernel is itself a wasm
// instance here, so it cannot run a program: it hands the shim the program's
// bytes, rewritten to count its own fuel (wasm_fuel.zig), and the shim
// compiles, instantiates and runs it with an import object whose every
// function calls back into the kernel (`skein_host_call`, web.zig) — the same
// host callback, by import index, as wasmtime's.
//
// Memory: a program's linear memory is not the kernel's. During a host call
// the callback gets `mem`, a mirror of the program's memory in the kernel's
// own: its pages are fetched from the program on first touch (engine.touch,
// from wasi.zig's accessors) and every fetched page is written back when the
// host call returns. Nothing else runs in the program meanwhile, so the
// mirror is exact for the call's duration; nothing is kept between calls.
//
// Fuel: the instrumented module keeps wasmtime's counter in its exported
// global; the shim reads and writes it (fuel_get/fuel_set), so the Meter here
// is the wasmtime one over that counter, and the fuel is the same number.
const std = @import("std");
const iface = @import("engine.zig");
const wasm_fuel = @import("wasm_fuel.zig");
const Import = iface.Import;
const Ret = iface.Ret;
const HostFn = iface.HostFn;
const Trap = iface.Trap;
const Outcome = iface.Outcome;
const UNMETERED = iface.UNMETERED;

// The shim's engine (kernel-zig/web/kernel.js, `skein_engine`).
const shim = struct {
    /// Compile instrumented bytes; `desc` is one record per function import
    /// (result kind u8: 0 none, 1 i32, 2 i64; the index of its first
    /// occurrence u32 LE). A module handle, or < 0 (the message: take_error).
    extern "skein_engine" fn compile(ptr: [*]const u8, len: usize, desc: [*]const u8, desc_len: usize) i32;
    /// A new instance of a module, instantiated (no code runs: the start
    /// function is an export). An instance handle, or < 0 (take_error).
    extern "skein_engine" fn instantiate(module: i32) i32;
    /// Run it: the start function first when `has_start`, then the entry
    /// export. 0 returned; 1 the kernel aborted it; 2 trapped (take_error: the
    /// engine's message); 3 out of fuel; < 0 another failure (take_error).
    extern "skein_engine" fn run(instance: i32, has_start: i32, entry: [*]const u8, entry_len: usize) i32;
    extern "skein_engine" fn release(instance: i32) void;
    extern "skein_engine" fn fuel_get(instance: i32) i64;
    extern "skein_engine" fn fuel_set(instance: i32, v: i64) void;
    /// The program's memory [at, at+len) ↔ the kernel's [ptr, ptr+len).
    extern "skein_engine" fn mem_read(instance: i32, at: u32, len: u32, ptr: [*]u8) void;
    extern "skein_engine" fn mem_write(instance: i32, at: u32, len: u32, ptr: [*]const u8) void;
    extern "skein_engine" fn error_len() usize;
    extern "skein_engine" fn error_take(ptr: [*]u8) void;
};

fn takeError(alloc: std.mem.Allocator) []const u8 {
    const n = shim.error_len();
    const b = alloc.alloc(u8, n) catch return "engine error";
    if (n > 0) shim.error_take(b.ptr);
    return b;
}

pub const Engine = struct {
    pub fn init() !Engine {
        return .{};
    }
    pub fn deinit(_: *Engine) void {}
};

pub const Module = struct {
    handle: i32,
    imports: []Import,
    /// The export to run; `_start` unless a test says otherwise.
    entry: ?[]const u8 = null,
    has_start: bool,

    /// Instrument (fuel), then compile in the shim. On failure `err_msg` gets the reason.
    pub fn compile(eng: *Engine, alloc: std.mem.Allocator, bytes: []const u8, err_msg: *[]const u8) !*Module {
        _ = eng;
        const ins = wasm_fuel.instrument(alloc, bytes) catch |err| {
            err_msg.* = switch (err) {
                error.Unsupported => "a wasm feature the browser build does not meter (exceptions, GC, typed function references, memory64, components)",
                error.Malformed => "malformed module",
                error.OutOfMemory => "out of memory",
            };
            return error.Compile;
        };
        var desc = try alloc.alloc(u8, ins.imports.len * 5);
        for (ins.imports, 0..) |imp, i| {
            desc[i * 5] = if (imp.nresults == 0) 0 else if (imp.result_i64) 2 else 1;
            var first: u32 = @intCast(i);
            for (ins.imports[0..i], 0..) |p, j| if (std.mem.eql(u8, p.module, imp.module) and std.mem.eql(u8, p.name, imp.name)) {
                first = @intCast(j);
                break;
            };
            std.mem.writeInt(u32, desc[i * 5 + 1 ..][0..4], first, .little);
        }
        const h = shim.compile(ins.bytes.ptr, ins.bytes.len, desc.ptr, desc.len);
        if (h < 0) {
            err_msg.* = takeError(alloc);
            return error.Compile;
        }
        const imports = try alloc.alloc(Import, ins.imports.len);
        for (ins.imports, 0..) |imp, i| imports[i] = .{ .module = try alloc.dupe(u8, imp.module), .name = try alloc.dupe(u8, imp.name), .nparams = imp.nparams, .nresults = imp.nresults, .result_i64 = imp.result_i64 };
        const m = try alloc.create(Module);
        m.* = .{ .handle = h, .imports = imports, .has_start = ins.has_start };
        return m;
    }

    /// Instantiate and run the entry. With a meter the instance draws on its
    /// budget (and what it burns is added to it); without one it runs
    /// unmetered (UNMETERED fuel: runs outside a step).
    pub fn run(mod: *Module, eng: *Engine, host_ctx: *anyopaque, host: HostFn, err_msg: *[]const u8, alloc: std.mem.Allocator, meter: ?*Meter) !Outcome {
        _ = eng;
        const inst = shim.instantiate(mod.handle);
        if (inst < 0) {
            err_msg.* = takeError(alloc);
            return error.Instantiate;
        }
        defer shim.release(inst);
        var session = Session{ .ctx = host_ctx, .host = host, .mod = mod, .inst = inst, .alloc = alloc, .prev = active };
        active = &session;
        defer {
            active = session.prev;
            session.deinit();
        }
        var frame = Meter.Frame{ .inst = inst };
        if (meter) |m| m.enter(&frame) else frameSet(&frame, UNMETERED);
        defer if (meter) |m| m.exit(&frame);
        const entry = if (mod.entry) |e| e else "_start";
        const code = shim.run(inst, @intFromBool(mod.has_start), entry.ptr, entry.len);
        return switch (code) {
            0 => .returned,
            1 => .aborted,
            2 => blk: {
                const msg = takeError(alloc);
                break :blk if (session.aborted) .aborted else .{ .trapped = trapOf(msg) };
            },
            3 => .{ .trapped = .out_of_fuel },
            else => {
                err_msg.* = takeError(alloc);
                return if (code == -2) error.Instantiate else error.Call;
            },
        };
    }
};

/// A trap from V8's message (Trap.v8Message is the other direction).
fn trapOf(msg: []const u8) Trap {
    inline for (@typeInfo(Trap).@"enum".fields) |f| {
        const t: Trap = @enumFromInt(f.value);
        if (t != .other and t != .out_of_fuel and std.mem.eql(u8, msg, t.v8Message())) return t;
    }
    if (std.mem.indexOf(u8, msg, "signature mismatch") != null) return .bad_signature;
    if (std.mem.indexOf(u8, msg, "null function") != null) return .indirect_call_null;
    if (std.mem.indexOf(u8, msg, "call stack") != null) return .stack_overflow;
    if (std.mem.indexOf(u8, msg, "out of bounds") != null) {
        if (std.mem.indexOf(u8, msg, "table") != null) return .table_out_of_bounds;
        return .memory_out_of_bounds;
    }
    return .other;
}

// ------------------------------------------------------------------ fuel

pub fn setFuel(inst: i32, f: u64) void {
    shim.fuel_set(inst, -@as(i64, @intCast(f)));
}

pub fn getFuel(inst: i32) u64 {
    const v = shim.fuel_get(inst);
    return if (v < 0) @intCast(-v) else 0;
}

fn frameGet(f: *const Meter.Frame) u64 {
    return getFuel(f.inst);
}

fn frameSet(f: *Meter.Frame, fuel: u64) void {
    setFuel(f.inst, fuel);
}

/// One step's fuel (engine_wasmtime.zig's Meter, over the instrumented counter).
pub const Meter = struct {
    limit: u64,
    spent: u64 = 0,
    base: u64 = 0,
    top: ?*Frame = null,

    pub const Frame = struct {
        inst: i32,
        given: u64 = 0,
        prev: ?*Frame = null,
    };

    pub fn init(limit: u64) Meter {
        return .{ .limit = limit };
    }

    fn budget(m: *const Meter) u64 {
        return m.limit -| (m.spent - m.base);
    }

    fn settle(m: *Meter) void {
        const f = m.top orelse return;
        const rem = frameGet(f);
        m.spent += f.given -| rem;
        f.given = rem;
    }

    fn give(m: *Meter, f: *Frame) void {
        f.given = m.budget();
        frameSet(f, f.given);
    }

    pub fn enter(m: *Meter, f: *Frame) void {
        m.settle();
        f.prev = m.top;
        m.top = f;
        m.give(f);
    }

    pub fn exit(m: *Meter, f: *Frame) void {
        m.settle();
        m.top = f.prev;
        if (m.top) |p| m.give(p);
    }

    pub fn used(m: *Meter) u64 {
        m.settle();
        return @min(m.spent - m.base, m.limit);
    }

    pub fn segment(m: *Meter) void {
        m.settle();
        m.base = m.spent;
        if (m.top) |f| m.give(f);
    }
};

// ------------------------------------------------------------------ host calls and the memory mirror

const PAGE = 4096;

const Session = struct {
    ctx: *anyopaque,
    host: HostFn,
    mod: *Module,
    inst: i32,
    alloc: std.mem.Allocator,
    prev: ?*Session,
    aborted: bool = false,
    /// The mirror of the program's memory (as long as it was at the last call).
    mirror: []u8 = &.{},
    fetched: std.DynamicBitSetUnmanaged = .{},
    /// Runs of fetched pages [first, first+n), to write back.
    runs: std.array_list.Managed([2]u32) = undefined,
    runs_init: bool = false,

    fn deinit(s: *Session) void {
        if (s.mirror.len > 0) std.heap.wasm_allocator.free(s.mirror);
        s.fetched.deinit(std.heap.wasm_allocator);
        if (s.runs_init) s.runs.deinit();
    }

    /// The mirror sized to the program's memory now (contents are refetched per call).
    fn size(s: *Session, len: usize) ![]u8 {
        if (s.mirror.len != len) {
            if (s.mirror.len > 0) std.heap.wasm_allocator.free(s.mirror);
            s.mirror = &.{};
            s.mirror = try std.heap.wasm_allocator.alloc(u8, len);
            try s.fetched.resize(std.heap.wasm_allocator, (len + PAGE - 1) / PAGE, false);
        }
        if (!s.runs_init) {
            s.runs = std.array_list.Managed([2]u32).init(std.heap.wasm_allocator);
            s.runs_init = true;
        }
        return s.mirror;
    }

    fn fetch(s: *Session, start: usize, n: usize) void {
        if (n == 0) return;
        const first = start / PAGE;
        const last = (start + n - 1) / PAGE;
        var p = first;
        while (p <= last) {
            if (s.fetched.isSet(p)) {
                p += 1;
                continue;
            }
            var q = p;
            while (q <= last and !s.fetched.isSet(q)) : (q += 1) s.fetched.set(q);
            const at = p * PAGE;
            const end = @min(q * PAGE, s.mirror.len);
            shim.mem_read(s.inst, @intCast(at), @intCast(end - at), s.mirror.ptr + at);
            s.runs.append(.{ @intCast(p), @intCast(q - p) }) catch @panic("out of memory");
            p = q;
        }
    }

    fn writeBack(s: *Session) void {
        for (s.runs.items) |run| {
            const at = @as(usize, run[0]) * PAGE;
            const end = @min((@as(usize, run[0]) + run[1]) * PAGE, s.mirror.len);
            shim.mem_write(s.inst, @intCast(at), @intCast(end - at), s.mirror.ptr + at);
            for (run[0]..run[0] + run[1]) |p| s.fetched.unset(p);
        }
        s.runs.clearRetainingCapacity();
    }
};

/// The running instances, innermost first (a shell's child runs inside its spawn call).
var active: ?*Session = null;

pub fn touch(mem: []u8, start: usize, n: usize) void {
    var s = active;
    while (s) |x| : (s = x.prev) {
        if (x.mirror.ptr == mem.ptr and x.mirror.len == mem.len) return x.fetch(start, n);
    }
}

/// The arguments of the host call in progress, and its result (web.zig exports the address).
pub var args: [16]i64 = undefined;

/// A program's import `index` was called (the shim's import function). 0: the
/// result is in args[0]; 1: abort (the shim throws to unwind the program).
pub fn hostCall(inst: i32, index: u32, nargs: u32, mem_len: u32) i32 {
    var s = active;
    while (s) |x| : (s = x.prev) {
        if (x.inst == inst) break;
    }
    const sess = s orelse return 1;
    var a: [16]i64 = undefined;
    const n = @min(nargs, a.len);
    @memcpy(a[0..n], args[0..n]);
    const mem = sess.size(mem_len) catch return 1;
    const r = sess.host(sess.ctx, index, a[0..n], mem);
    switch (r) {
        .abort => {
            sess.runs.clearRetainingCapacity();
            sess.fetched.unsetAll();
            sess.aborted = true;
            return 1;
        },
        .value => |v| {
            sess.writeBack();
            args[0] = v;
            return 0;
        },
    }
}
