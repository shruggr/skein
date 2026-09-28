// The wasm engine behind a small interface: compile a module, run its
// `_start` with every function import answered by one host callback (by
// import index), meter it with fuel (issue #5), and report how it ended.
// Two backends, chosen by the target: wasmtime's C API natively
// (engine_wasmtime.zig) and V8 through the browser shim when the kernel
// itself is compiled to wasm (engine_v8.zig, issue #35). Nothing outside the
// backends sees either; the kernel uses only what is declared here.
const std = @import("std");
const builtin = @import("builtin");

/// The kernel is itself a wasm module (the browser build, issue #35).
pub const web = builtin.target.cpu.arch.isWasm();
const impl = if (web) @import("engine_v8.zig") else @import("engine_wasmtime.zig");

pub const Engine = impl.Engine;
pub const Module = impl.Module;
pub const Meter = impl.Meter;
pub const setFuel = impl.setFuel;
pub const getFuel = impl.getFuel;
/// wasmtime's C API (native only: the component host, component.zig).
pub const c = impl.c;

/// Before the host reads or writes `mem[start..start+n]` (wasi.zig's memory
/// accessors). Natively `mem` is the instance's own memory and this is
/// nothing; under V8 the instance's memory is not the kernel's, and `mem` is
/// a mirror whose pages are fetched on first touch and written back when the
/// host call returns (engine_v8.zig).
pub inline fn touch(mem: []u8, start: usize, n: usize) void {
    if (web) impl.touch(mem, start, n);
}

/// Fuel for a run outside any step (the shell test driver, the coreutils
/// listing): far beyond anything real, below wasmtime's i64 bound.
pub const UNMETERED: u64 = 1 << 62;

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
    /// The step's fuel ran out (the scheduler records it as `fuel exhausted`, never as a trap).
    out_of_fuel,
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
            .out_of_fuel => "fuel exhausted",
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
