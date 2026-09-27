// The wasm engine behind a small interface: compile a module, run its
// `_start` with every function import answered by one host callback
// (by import index), and report how it ended. wasmtime's C API is the only
// backend today; nothing outside this file sees it (a browser build would
// put V8 behind the same four calls).
const std = @import("std");
pub const c = @cImport(@cInclude("wasmtime.h"));

pub const Import = struct {
    module: []const u8,
    name: []const u8,
    nparams: usize,
    /// 0 or 1; `result_i64` says which width.
    nresults: usize,
    result_i64: bool,
};

pub const Ret = union(enum) {
    /// Return this (as the declared result type; ignored when there is none).
    value: i64,
    /// Unwind the instance: the host has recorded why (exit, a fatal error, a park).
    abort,
};

pub const HostFn = *const fn (ctx: *anyopaque, index: usize, args: []const i64, mem: []u8) Ret;

pub const Trap = enum {
    unreachable_code,
    memory_out_of_bounds,
    divide_by_zero,
    integer_overflow,
    bad_conversion,
    table_out_of_bounds,
    indirect_call_null,
    bad_signature,
    heap_misaligned,
    stack_overflow,
    other,

    /// What V8 says for the same trap (a RuntimeError's message), which the
    /// TypeScript runtime writes as "<argv0>: trapped: <message>".
    /// Stack overflow is not a RuntimeError under V8 but a RangeError. Checked
    /// against Node 26 with hand-built modules (README, "What is not the same").
    pub fn v8Message(t: Trap) []const u8 {
        return switch (t) {
            .unreachable_code => "unreachable",
            .memory_out_of_bounds => "memory access out of bounds",
            .divide_by_zero => "divide by zero",
            .integer_overflow => "divide result unrepresentable",
            .bad_conversion => "float unrepresentable in integer range",
            .table_out_of_bounds => "table index is out of bounds",
            .indirect_call_null, .bad_signature => "function signature mismatch", // V8 (Node 26) says this for a null entry too
            .heap_misaligned => "operation does not support unaligned accesses",
            .stack_overflow => "Maximum call stack size exceeded",
            .other => "wasm trap",
        };
    }
};

pub const Outcome = union(enum) {
    /// `_start` returned.
    returned,
    /// The host aborted it (Ret.abort).
    aborted,
    trapped: Trap,
};

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

    /// Compile. On failure `err_msg` gets the engine's message.
    pub fn compile(eng: *Engine, alloc: std.mem.Allocator, bytes: []const u8, err_msg: *[]const u8) !*Module {
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
        mod.* = .{ .m = m.?, .linker = linker, .imports = try list.toOwnedSlice() };
        return mod;
    }

    /// Instantiate in a store of its own and run `_start`.
    pub fn run(mod: *Module, eng: *Engine, host_ctx: *anyopaque, host: HostFn, err_msg: *[]const u8, alloc: std.mem.Allocator) !Outcome {
        var session = Session{ .ctx = host_ctx, .host = host, .mod = mod };
        const store = c.wasmtime_store_new(eng.e, &session, null) orelse return error.Engine;
        defer c.wasmtime_store_delete(store);
        const ctx = c.wasmtime_store_context(store);
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
