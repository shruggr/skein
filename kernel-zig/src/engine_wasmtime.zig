// The native engine backend (engine.zig is the interface): wasmtime's C API.
// Compile a module, run its `_start` with every function import answered by
// one host callback (by import index), and report how it ended; fuel is
// wasmtime's own (`consume_fuel`). The browser build puts V8 behind the same
// calls (engine_v8.zig).
const std = @import("std");
pub const c = @cImport(@cInclude("wasmtime.h"));

const iface = @import("engine.zig");
const Import = iface.Import;
const Ret = iface.Ret;
const HostFn = iface.HostFn;
const Trap = iface.Trap;
const Outcome = iface.Outcome;
const wasm_fuel = @import("wasm_fuel.zig");

/// SKEIN_FUEL_MODE=instrument: run every module rewritten by wasm_fuel.zig and
/// meter it by the counter it keeps itself, as the browser build does under V8
/// (issue #35) — wasmtime's own fuel is then only a backstop. A check, not a
/// mode to run instances in: the equivalence suite replays the corpus both ways
/// and requires the same fuel on every update.
pub fn instrumentMode() bool {
    const S = struct {
        var v: ?bool = null;
    };
    if (S.v == null) S.v = if (std.posix.getenv("SKEIN_FUEL_MODE")) |m| std.mem.eql(u8, m, "instrument") else false;
    return S.v.?;
}

pub const Engine = struct {
    e: *c.wasm_engine_t,

    pub fn init() !Engine {
        const cfg = c.wasm_config_new() orelse return error.Engine;
        // The on-disk compilation cache (~/.cache/wasmtime): a cache of the
        // machine code for module bytes, not state. SKEIN_WASMTIME_CACHE=0 turns it off.
        const off = if (std.posix.getenv("SKEIN_WASMTIME_CACHE")) |v| std.mem.eql(u8, v, "0") else false;
        if (!off) {
            if (c.wasmtime_config_cache_config_load(cfg, null)) |err| c.wasmtime_error_delete(err);
        }
        // Fuel (issue #5): every instance counts the wasm it executes. An
        // instruction count, not a clock: the same module and input burn the
        // same fuel on every machine, so it is recorded and replays exactly.
        c.wasmtime_config_consume_fuel_set(cfg, true);
        const e = c.wasm_engine_new_with_config(cfg) orelse return error.Engine;
        return .{ .e = e };
    }

    pub fn deinit(eng: *Engine) void {
        c.wasm_engine_delete(eng.e);
    }
};

pub const Module = struct {
    m: *c.wasmtime_module_t,
    linker: *c.wasmtime_linker_t,
    imports: []Import,
    /// The export to run; `_start` unless a test says otherwise.
    entry: ?[]const u8 = null,
    /// Rewritten by wasm_fuel.zig (instrumentMode): metered by its own counter.
    instrumented: bool = false,
    has_start: bool = false,

    /// Compile. On failure `err_msg` gets the engine's message.
    pub fn compile(eng: *Engine, alloc: std.mem.Allocator, original: []const u8, err_msg: *[]const u8) !*Module {
        return compileWith(eng, alloc, original, err_msg, instrumentMode());
    }

    /// Compile, rewritten by wasm_fuel.zig when `instrumented` (the tests compare the two).
    pub fn compileWith(eng: *Engine, alloc: std.mem.Allocator, original: []const u8, err_msg: *[]const u8, instrumented: bool) !*Module {
        var bytes = original;
        var has_start = false;
        if (instrumented) {
            const ins = wasm_fuel.instrument(alloc, original) catch |err| {
                err_msg.* = @errorName(err);
                return error.Compile;
            };
            bytes = ins.bytes;
            has_start = ins.has_start;
        }
        var m: ?*c.wasmtime_module_t = null;
        if (c.wasmtime_module_new(eng.e, bytes.ptr, bytes.len, &m)) |err| {
            err_msg.* = errorText(alloc, err);
            return error.Compile;
        }
        errdefer c.wasmtime_module_delete(m.?);
        const linker = c.wasmtime_linker_new(eng.e) orelse return error.Engine;
        errdefer c.wasmtime_linker_delete(linker);

        var vec: c.wasm_importtype_vec_t = undefined;
        c.wasmtime_module_imports(m.?, &vec);
        defer c.wasm_importtype_vec_delete(&vec);
        var list = std.array_list.Managed(Import).init(alloc);
        for (0..vec.size) |i| {
            const it = vec.data[i];
            const et = c.wasm_importtype_type(it);
            const ft = c.wasm_externtype_as_functype_const(et) orelse continue; // not a function: left to fail at link
            const mn = c.wasm_importtype_module(it);
            const nn = c.wasm_importtype_name(it);
            const params = c.wasm_functype_params(ft);
            const results = c.wasm_functype_results(ft);
            const imp = Import{
                .module = try alloc.dupe(u8, mn.*.data[0..mn.*.size]),
                .name = try alloc.dupe(u8, nn.*.data[0..nn.*.size]),
                .nparams = params.*.size,
                .nresults = results.*.size,
                .result_i64 = results.*.size > 0 and c.wasm_valtype_kind(results.*.data[0]) == c.WASM_I64,
            };
            const index = list.items.len;
            try list.append(imp);
            // A module may import one function twice (Go does): one definition serves both.
            var dup = false;
            for (list.items[0..index]) |p| if (std.mem.eql(u8, p.module, imp.module) and std.mem.eql(u8, p.name, imp.name)) {
                dup = true;
            };
            if (dup) continue;
            if (c.wasmtime_linker_define_func(linker, imp.module.ptr, imp.module.len, imp.name.ptr, imp.name.len, ft, callback, @ptrFromInt(index + 1), null)) |err| {
                err_msg.* = errorText(alloc, err);
                return error.Link;
            }
        }
        const mod = try alloc.create(Module);
        mod.* = .{ .m = m.?, .linker = linker, .imports = try list.toOwnedSlice(), .instrumented = instrumented, .has_start = has_start };
        return mod;
    }

    /// Instantiate in a store of its own and run `_start`. With a meter the
    /// instance draws on its budget (and what it burns is added to it); without
    /// one it runs unmetered (UNMETERED fuel: runs outside a step).
    pub fn run(mod: *Module, eng: *Engine, host_ctx: *anyopaque, host: HostFn, err_msg: *[]const u8, alloc: std.mem.Allocator, meter: ?*Meter) !Outcome {
        var session = Session{ .ctx = host_ctx, .host = host, .mod = mod };
        const store = c.wasmtime_store_new(eng.e, &session, null) orelse return error.Engine;
        defer c.wasmtime_store_delete(store);
        const ctx = c.wasmtime_store_context(store);
        if (mod.instrumented) return mod.runInstrumented(ctx.?, &session, err_msg, alloc, meter);
        var frame = Meter.Frame{ .ctx = ctx.? };
        if (meter) |m| m.enter(&frame) else setFuel(ctx.?, UNMETERED);
        defer if (meter) |m| m.exit(&frame);
        var inst: c.wasmtime_instance_t = undefined;
        var trap: ?*c.wasm_trap_t = null;
        if (c.wasmtime_linker_instantiate(mod.linker, ctx, mod.m, &inst, &trap)) |err| {
            err_msg.* = errorText(alloc, err);
            return error.Instantiate;
        }
        if (trap) |t| return outcomeOf(&session, t);
        var ext: c.wasmtime_extern_t = undefined;
        const entry = if (mod.entry) |e| e else "_start";
        if (!c.wasmtime_instance_export_get(ctx, &inst, entry.ptr, entry.len, &ext) or ext.kind != c.WASMTIME_EXTERN_FUNC) {
            err_msg.* = "no _start";
            return error.Instantiate;
        }
        if (c.wasmtime_func_call(ctx, &ext.of.func, null, 0, null, 0, &trap)) |err| {
            if (session.aborted) {
                c.wasmtime_error_delete(err);
                return .aborted;
            }
            err_msg.* = errorText(alloc, err); // deletes err
            return error.Call;
        }
        if (trap) |t| return outcomeOf(&session, t);
        return .returned;
    }

    /// instrumentMode: instantiate (nothing runs: the start function is an
    /// export), then meter by the module's own counter, as engine_v8.zig does.
    fn runInstrumented(mod: *Module, ctx: *c.wasmtime_context_t, session: *Session, err_msg: *[]const u8, alloc: std.mem.Allocator, meter: ?*Meter) !Outcome {
        setFuel(ctx, UNMETERED); // wasmtime's own: a backstop only
        var inst: c.wasmtime_instance_t = undefined;
        var trap: ?*c.wasm_trap_t = null;
        if (c.wasmtime_linker_instantiate(mod.linker, ctx, mod.m, &inst, &trap)) |err| {
            err_msg.* = errorText(alloc, err);
            return error.Instantiate;
        }
        if (trap) |t| return outcomeOf(session, t);
        var g: c.wasmtime_extern_t = undefined;
        var oog: c.wasmtime_extern_t = undefined;
        if (!c.wasmtime_instance_export_get(ctx, &inst, wasm_fuel.FUEL_EXPORT, wasm_fuel.FUEL_EXPORT.len, &g) or g.kind != c.WASMTIME_EXTERN_GLOBAL) return error.Instantiate;
        if (!c.wasmtime_instance_export_get(ctx, &inst, wasm_fuel.OOG_EXPORT, wasm_fuel.OOG_EXPORT.len, &oog) or oog.kind != c.WASMTIME_EXTERN_GLOBAL) return error.Instantiate;
        var frame = Meter.Frame{ .ctx = ctx, .global = g.of.global };
        if (meter) |m| m.enter(&frame) else frameSet(&frame, UNMETERED);
        defer if (meter) |m| m.exit(&frame);
        const names = [2][]const u8{ wasm_fuel.START_EXPORT, if (mod.entry) |e| e else "_start" };
        const first: usize = if (mod.has_start) 0 else 1;
        for (names[first..]) |name| {
            var ext: c.wasmtime_extern_t = undefined;
            if (!c.wasmtime_instance_export_get(ctx, &inst, name.ptr, name.len, &ext) or ext.kind != c.WASMTIME_EXTERN_FUNC) {
                err_msg.* = "no _start";
                return error.Instantiate;
            }
            if (c.wasmtime_func_call(ctx, &ext.of.func, null, 0, null, 0, &trap)) |err| {
                if (session.aborted) {
                    c.wasmtime_error_delete(err);
                    return .aborted;
                }
                err_msg.* = errorText(alloc, err);
                return error.Call;
            }
            if (trap) |t| {
                var flag: c.wasmtime_val_t = undefined;
                c.wasmtime_global_get(ctx, &oog.of.global, &flag);
                if (flag.of.i32 != 0 and !session.aborted) {
                    c.wasm_trap_delete(t);
                    return .{ .trapped = .out_of_fuel };
                }
                return outcomeOf(session, t);
            }
        }
        return .returned;
    }
};

/// What an instance has left: wasmtime's fuel, or an instrumented module's counter (−counter, 0 once ≥ 0).
fn frameGet(f: *const Meter.Frame) u64 {
    if (f.global) |g| {
        var v: c.wasmtime_val_t = undefined;
        c.wasmtime_global_get(f.ctx, &g, &v);
        return if (v.of.i64 < 0) @intCast(-v.of.i64) else 0;
    }
    return getFuel(f.ctx);
}

fn frameSet(f: *Meter.Frame, fuel: u64) void {
    if (f.global) |g| {
        var v = c.wasmtime_val_t{ .kind = c.WASMTIME_I64, .of = .{ .i64 = -@as(i64, @intCast(fuel)) } };
        if (c.wasmtime_global_set(f.ctx, &g, &v)) |err| c.wasmtime_error_delete(err);
        return;
    }
    setFuel(f.ctx, fuel);
}

const UNMETERED = iface.UNMETERED;

pub fn setFuel(ctx: *c.wasmtime_context_t, f: u64) void {
    if (c.wasmtime_context_set_fuel(ctx, f)) |err| c.wasmtime_error_delete(err);
}

pub fn getFuel(ctx: *const c.wasmtime_context_t) u64 {
    var f: u64 = 0;
    if (c.wasmtime_context_get_fuel(ctx, &f)) |err| c.wasmtime_error_delete(err);
    return f;
}

/// One step's fuel (issue #5): a single budget shared by every instance that
/// runs in the step — the handler program, or the shell and each child it
/// spawns. Instances nest (a child runs while its parent waits in a host
/// call), so the running ones form a stack: entering a child first settles
/// what its parent burnt so far and gives the child what is left; leaving it
/// settles the child and gives the parent what is left. `used` is the fuel
/// burnt since the last `segment()` (a shell thread's step ends at each
/// sleep); a run that exhausts the budget has used exactly `limit`.
pub const Meter = struct {
    limit: u64,
    /// Fuel burnt over the meter's life by settled instances.
    spent: u64 = 0,
    /// `spent` when the current segment began.
    base: u64 = 0,
    top: ?*Frame = null,

    pub const Frame = struct {
        ctx: *c.wasmtime_context_t,
        /// An instrumented module's counter (instrumentMode); null: wasmtime's fuel.
        global: ?c.wasmtime_global_t = null,
        /// The fuel this instance held when last settled.
        given: u64 = 0,
        prev: ?*Frame = null,
    };

    pub fn init(limit: u64) Meter {
        return .{ .limit = limit };
    }

    fn budget(m: *const Meter) u64 {
        return m.limit -| (m.spent - m.base);
    }

    /// Add what the running instance burnt since it was last settled.
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

    /// Fuel used in the current segment, the running instances included.
    pub fn used(m: *Meter) u64 {
        m.settle();
        return @min(m.spent - m.base, m.limit);
    }

    /// Start a new segment with a full budget (a shell thread resumed after a sleep).
    pub fn segment(m: *Meter) void {
        m.settle();
        m.base = m.spent;
        if (m.top) |f| m.give(f);
    }
};

const Session = struct {
    ctx: *anyopaque,
    host: HostFn,
    mod: *Module,
    aborted: bool = false,
};

fn outcomeOf(s: *Session, t: *c.wasm_trap_t) Outcome {
    defer c.wasm_trap_delete(t);
    if (s.aborted) return .aborted;
    var code: c.wasmtime_trap_code_t = 0;
    if (!c.wasmtime_trap_code(t, &code)) return .{ .trapped = .other };
    return .{ .trapped = switch (code) {
        c.WASMTIME_TRAP_CODE_STACK_OVERFLOW => .stack_overflow,
        c.WASMTIME_TRAP_CODE_MEMORY_OUT_OF_BOUNDS => .memory_out_of_bounds,
        c.WASMTIME_TRAP_CODE_HEAP_MISALIGNED => .heap_misaligned,
        c.WASMTIME_TRAP_CODE_TABLE_OUT_OF_BOUNDS => .table_out_of_bounds,
        c.WASMTIME_TRAP_CODE_INDIRECT_CALL_TO_NULL => .indirect_call_null,
        c.WASMTIME_TRAP_CODE_BAD_SIGNATURE => .bad_signature,
        c.WASMTIME_TRAP_CODE_INTEGER_OVERFLOW => .integer_overflow,
        c.WASMTIME_TRAP_CODE_INTEGER_DIVISION_BY_ZERO => .divide_by_zero,
        c.WASMTIME_TRAP_CODE_BAD_CONVERSION_TO_INTEGER => .bad_conversion,
        c.WASMTIME_TRAP_CODE_UNREACHABLE_CODE_REACHED => .unreachable_code,
        c.WASMTIME_TRAP_CODE_OUT_OF_FUEL => .out_of_fuel,
        else => .other,
    } };
}

fn errorText(alloc: std.mem.Allocator, err: *c.wasmtime_error_t) []const u8 {
    defer c.wasmtime_error_delete(err);
    var msg: c.wasm_name_t = undefined;
    c.wasmtime_error_message(err, &msg);
    defer c.wasm_byte_vec_delete(&msg);
    return alloc.dupe(u8, msg.data[0..msg.size]) catch "wasmtime error";
}

fn callback(env: ?*anyopaque, caller: ?*c.wasmtime_caller_t, args: [*c]const c.wasmtime_val_t, nargs: usize, results: [*c]c.wasmtime_val_t, nresults: usize) callconv(.c) ?*c.wasm_trap_t {
    const index = @intFromPtr(env) - 1;
    const ctx = c.wasmtime_caller_context(caller);
    const s: *Session = @ptrCast(@alignCast(c.wasmtime_context_get_data(ctx)));
    var mem: []u8 = &.{};
    var ext: c.wasmtime_extern_t = undefined;
    if (c.wasmtime_caller_export_get(caller, "memory", 6, &ext)) {
        if (ext.kind == c.WASMTIME_EXTERN_MEMORY) {
            const p = c.wasmtime_memory_data(ctx, &ext.of.memory);
            const n = c.wasmtime_memory_data_size(ctx, &ext.of.memory);
            if (p != null) mem = p[0..n];
        }
        c.wasmtime_extern_delete(&ext);
    }
    var a: [16]i64 = undefined;
    const n = @min(nargs, a.len);
    for (0..n) |i| {
        a[i] = switch (args[i].kind) {
            c.WASMTIME_I32 => args[i].of.i32,
            c.WASMTIME_I64 => args[i].of.i64,
            else => 0,
        };
    }
    const imp = s.mod.imports[index];
    switch (s.host(s.ctx, index, a[0..n], mem)) {
        .abort => {
            s.aborted = true;
            return c.wasmtime_trap_new("skein: abort", 12);
        },
        .value => |v| {
            if (nresults > 0) {
                if (imp.result_i64) {
                    results[0].kind = c.WASMTIME_I64;
                    results[0].of.i64 = v;
                } else {
                    results[0].kind = c.WASMTIME_I32;
                    results[0].of.i32 = @truncate(v);
                }
            }
            return null;
        },
    }
}
