// Fuel by instrumentation (issue #35): a module rewritten so that it counts
// its own fuel exactly as wasmtime's `consume_fuel` does, for an engine that
// has none (V8). The count lives in a mutable i64 global the module exports
// (`__skein_fuel`), kept the way wasmtime keeps `VMStoreContext.fuel_consumed`:
// minus the fuel left, out of fuel when it reaches 0 or more.
//
// Wasmtime v49 (crates/cranelift/src/func_environ.rs, wasmtime-environ's
// tunables.rs) — reproduced here point for point:
//
//   cost      1 per operator, except nop, drop, block, loop, unreachable,
//             return, else and end (0); a function entry costs 1. The bulk
//             operators also cost 1 per unit: memory.copy/fill/init per byte,
//             memory.grow per page, table.copy/fill/init per element,
//             table.grow per element — charged when the operation succeeds
//             (a small constant count, ≤ 128, is charged up front instead).
//   buffered  costs accumulate at translation time and are added to a
//             function-local counter (here a local) only at: loop, if, br,
//             br_if, br_table, end, else, the calls, return, unreachable, the
//             return_calls, and around the bulk operators. Operators in
//             unreachable code count nothing.
//   saved     the local is stored to the global before every call, return,
//             unreachable and return_call and at the function's exit, and
//             reloaded after every call — so what a host function reads is
//             exact, and so is what is left after a trap (the last save).
//   checked   at function entry, at every loop header and after a bulk
//             operator with a runtime (or large) count: if the counter is ≥ 0
//             the counter is saved and the instance traps out of fuel. Here
//             that is `__skein_oog` = 1 then `unreachable`, which the engine
//             reports as out of fuel.
//
// What is not modelled (none occurs in the programs skein runs; see the
// README): statically out-of-bounds loads/stores (wasmtime treats what
// follows as unreachable), and a bulk operator's count that is a constant
// carried through a local across a control-flow merge (wasmtime may still
// see the constant; here it is then runtime: the same total on success, only
// a failed grow or the exhaustion point could differ). Exceptions, GC and
// typed function references, and memory64 are refused.
//
// A start function is not run at instantiation: a new function that calls it
// is exported as `__skein_start` for the engine to call once the fuel is set.
// wasmtime runs a start function under the fuel it was given through a
// trampoline that is metered like a function of one call (entry 1, call 1):
// the wrapper is exactly that. (No pinned program has a start function.)
const std = @import("std");
const engine = @import("engine.zig");

pub const FUEL_EXPORT = "__skein_fuel";
pub const OOG_EXPORT = "__skein_oog";
pub const START_EXPORT = "__skein_start";

pub const Instrumented = struct {
    bytes: []u8,
    /// The function imports, in import order (the engine answers them by index).
    imports: []engine.Import,
    /// The module had a start function (exported as START_EXPORT).
    has_start: bool,
};

pub const Error = error{ Malformed, Unsupported, OutOfMemory };

const FuncType = struct { nparams: u32, nresults: u32, result_i64: bool };

const Reader = struct {
    b: []const u8,
    i: usize = 0,

    fn eof(r: *const Reader) bool {
        return r.i >= r.b.len;
    }
    fn byte(r: *Reader) Error!u8 {
        if (r.i >= r.b.len) return error.Malformed;
        r.i += 1;
        return r.b[r.i - 1];
    }
    fn bytes(r: *Reader, n: usize) Error![]const u8 {
        if (r.b.len - r.i < n) return error.Malformed;
        r.i += n;
        return r.b[r.i - n .. r.i];
    }
    fn u(r: *Reader) Error!u64 {
        var result: u64 = 0;
        var shift: u32 = 0;
        while (true) {
            const x = try r.byte();
            if (shift < 64) result |= @as(u64, x & 0x7f) << @intCast(shift);
            if (x & 0x80 == 0) return result;
            shift += 7;
            if (shift > 70) return error.Malformed;
        }
    }
    fn u32_(r: *Reader) Error!u32 {
        const v = try r.u();
        if (v > std.math.maxInt(u32)) return error.Malformed;
        return @intCast(v);
    }
    fn s(r: *Reader) Error!i64 {
        var result: i64 = 0;
        var shift: u32 = 0;
        while (true) {
            const x = try r.byte();
            if (shift < 64) result |= @as(i64, x & 0x7f) << @intCast(shift);
            shift += 7;
            if (x & 0x80 == 0) {
                if (shift < 64 and (x & 0x40) != 0) result |= @as(i64, -1) << @intCast(shift);
                return result;
            }
            if (shift > 70) return error.Malformed;
        }
    }
    fn name(r: *Reader) Error![]const u8 {
        return r.bytes(try r.u32_());
    }
};

fn putU(out: *std.array_list.Managed(u8), v: u64) !void {
    var x = v;
    while (true) {
        const b: u8 = @intCast(x & 0x7f);
        x >>= 7;
        if (x == 0) return out.append(b);
        try out.append(b | 0x80);
    }
}

fn putS(out: *std.array_list.Managed(u8), v: i64) !void {
    var x = v;
    while (true) {
        const b: u8 = @intCast(x & 0x7f);
        x >>= 7;
        const done = (x == 0 and b & 0x40 == 0) or (x == -1 and b & 0x40 != 0);
        if (done) return out.append(b);
        try out.append(b | 0x80);
    }
}

/// A value type: the numeric/vector types and the two nullable abstract references.
fn valType(r: *Reader) Error!u8 {
    const t = try r.byte();
    return switch (t) {
        0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f => t,
        else => error.Unsupported, // typed references (GC, function references)
    };
}

fn limits(r: *Reader) Error!void {
    const flags = try r.byte();
    if (flags & 0x04 != 0) return error.Unsupported; // memory64 / table64
    if (flags & ~@as(u8, 0x03) != 0) return error.Unsupported; // custom page sizes
    _ = try r.u();
    if (flags & 1 != 0) _ = try r.u();
}

/// A block type: empty, one value type, or a type index (s33).
fn blockType(r: *Reader) Error!void {
    const b = r.b[r.i];
    if (b == 0x40) {
        r.i += 1;
        return;
    }
    if (b & 0xc0 == 0x40) { // a one-byte negative s33: a value type
        _ = try valType(r);
        return;
    }
    const x = try r.s();
    if (x < 0) return error.Malformed;
}

fn memarg(r: *Reader) Error!void {
    const al = try r.u32_();
    if (al & 0x40 != 0) _ = try r.u32_(); // multi-memory: the memory index
    _ = try r.u();
}

pub fn instrument(a: std.mem.Allocator, wasm: []const u8) Error!Instrumented {
    var r = Reader{ .b = wasm };
    const head = try r.bytes(8);
    if (!std.mem.eql(u8, head[0..4], "\x00asm")) return error.Malformed;
    if (!std.mem.eql(u8, head[4..8], "\x01\x00\x00\x00")) return error.Unsupported; // a component, or another version

    var types = std.array_list.Managed(FuncType).init(a);
    var imports = std.array_list.Managed(engine.Import).init(a);
    var func_types = std.array_list.Managed(u32).init(a); // every function: imports, then defined
    var n_imported_funcs: u32 = 0;
    var n_imported_globals: u32 = 0;
    var n_defined_globals: u32 = 0;
    var start: ?u32 = null;

    const Section = struct { id: u8, body: []const u8 };
    var sections = std.array_list.Managed(Section).init(a);

    while (!r.eof()) {
        const id = try r.byte();
        const size = try r.u32_();
        const body = try r.bytes(size);
        try sections.append(.{ .id = id, .body = body });
        var sr = Reader{ .b = body };
        switch (id) {
            1 => {
                const n = try sr.u32_();
                for (0..n) |_| {
                    const form = try sr.byte();
                    if (form != 0x60) return error.Unsupported; // rec / sub types (GC)
                    const np = try sr.u32_();
                    for (0..np) |_| _ = try valType(&sr);
                    const nr = try sr.u32_();
                    var r64 = false;
                    for (0..nr) |k| {
                        const t = try valType(&sr);
                        if (k == 0) r64 = t == 0x7e;
                    }
                    try types.append(.{ .nparams = np, .nresults = nr, .result_i64 = r64 });
                }
            },
            2 => {
                const n = try sr.u32_();
                for (0..n) |_| {
                    const mod = try sr.name();
                    const nm = try sr.name();
                    const kind = try sr.byte();
                    switch (kind) {
                        0 => {
                            const ti = try sr.u32_();
                            if (ti >= types.items.len) return error.Malformed;
                            const ft = types.items[ti];
                            try imports.append(.{ .module = mod, .name = nm, .nparams = ft.nparams, .nresults = ft.nresults, .result_i64 = ft.result_i64 });
                            try func_types.append(ti);
                            n_imported_funcs += 1;
                        },
                        1 => {
                            _ = try valType(&sr);
                            try limits(&sr);
                        },
                        2 => try limits(&sr),
                        3 => {
                            _ = try valType(&sr);
                            _ = try sr.byte();
                            n_imported_globals += 1;
                        },
                        else => return error.Unsupported, // tags (exceptions)
                    }
                }
            },
            3 => {
                const n = try sr.u32_();
                for (0..n) |_| try func_types.append(try sr.u32_());
            },
            6 => n_defined_globals = try sr.u32_(),
            8 => start = try sr.u32_(),
            13 => return error.Unsupported, // tags
            else => {},
        }
    }

    const fuel_global = n_imported_globals + n_defined_globals;
    const oog_global = fuel_global + 1;

    // The start function is run through a new function that calls it: wasmtime
    // runs a start function through a trampoline that counts as one (its entry
    // and its call: 2 before the start function's own entry).
    var void_type: ?u32 = null;
    for (types.items, 0..) |t, i| if (t.nparams == 0 and t.nresults == 0) {
        void_type = @intCast(i);
        break;
    };
    const new_type = start != null and void_type == null;
    if (new_type) void_type = @intCast(types.items.len);
    const wrapper: ?u32 = if (start != null) @intCast(func_types.items.len) else null;
    if (wrapper != null) {
        var have_types = false;
        var have_funcs = false;
        var have_code = false;
        for (sections.items) |sec| switch (sec.id) {
            1 => have_types = true,
            3 => have_funcs = true,
            10 => have_code = true,
            else => {},
        };
        if (!have_types or !have_funcs or !have_code) return error.Malformed; // a start function is a defined function
    }

    var out = std.array_list.Managed(u8).init(a);
    try out.appendSlice(head);
    var have_globals = false;
    var have_exports = false;
    for (sections.items) |sec| {
        if (sec.id == 6) have_globals = true;
        if (sec.id == 7) have_exports = true;
    }
    // Where a missing section goes: before the first later known section.
    const order = struct {
        fn rank(id: u8) u8 {
            return switch (id) {
                1 => 1, 2 => 2, 3 => 3, 4 => 4, 5 => 5, 13 => 6, 6 => 7, 7 => 8, 8 => 9, 9 => 10, 12 => 11, 10 => 12, 11 => 13,
                else => 0, // custom: stays where it is
            };
        }
    }.rank;
    var wrote_globals = false;
    var wrote_exports = false;
    var sec_buf = std.array_list.Managed(u8).init(a);

    for (sections.items) |sec| {
        const rk = order(sec.id);
        if (rk != 0) {
            if (!have_globals and !wrote_globals and rk > order(6)) {
                try globalsSection(&out, &sec_buf, 0, "");
                wrote_globals = true;
            }
            if (!have_exports and !wrote_exports and rk > order(7)) {
                try exportsSection(&out, &sec_buf, null, 0, fuel_global, oog_global, wrapper);
                wrote_exports = true;
            }
        }
        switch (sec.id) {
            1, 3 => if (wrapper != null and (sec.id == 3 or new_type)) {
                // One more type (() -> ()) or one more function (the start wrapper), at the end.
                var sr = Reader{ .b = sec.body };
                const n = try sr.u32_();
                sec_buf.clearRetainingCapacity();
                try putU(&sec_buf, n + 1);
                try sec_buf.appendSlice(sec.body[sr.i..]);
                if (sec.id == 1) try sec_buf.appendSlice(&.{ 0x60, 0x00, 0x00 }) else try putU(&sec_buf, void_type.?);
                try out.append(sec.id);
                try putU(&out, sec_buf.items.len);
                try out.appendSlice(sec_buf.items);
            } else {
                try out.append(sec.id);
                try putU(&out, sec.body.len);
                try out.appendSlice(sec.body);
            },
            6 => {
                var sr = Reader{ .b = sec.body };
                const n = try sr.u32_();
                try globalsSection(&out, &sec_buf, n, sec.body[sr.i..]);
                wrote_globals = true;
            },
            7 => {
                var sr = Reader{ .b = sec.body };
                const n = try sr.u32_();
                try exportsSection(&out, &sec_buf, sec.body[sr.i..], n, fuel_global, oog_global, wrapper);
                wrote_exports = true;
            },
            8 => {}, // the start function: run through its wrapper, exported (START_EXPORT)
            10 => {
                sec_buf.clearRetainingCapacity();
                var sr = Reader{ .b = sec.body };
                const n = try sr.u32_();
                try putU(&sec_buf, n + @as(u32, if (wrapper != null) 1 else 0));
                var body_buf = std.array_list.Managed(u8).init(a);
                for (0..n) |k| {
                    const size = try sr.u32_();
                    const body = try sr.bytes(size);
                    const fi = n_imported_funcs + @as(u32, @intCast(k));
                    if (fi >= func_types.items.len) return error.Malformed;
                    const ti = func_types.items[fi];
                    if (ti >= types.items.len) return error.Malformed;
                    body_buf.clearRetainingCapacity();
                    try rewriteBody(a, &body_buf, body, types.items[ti].nparams, fuel_global, oog_global);
                    try putU(&sec_buf, body_buf.items.len);
                    try sec_buf.appendSlice(body_buf.items);
                }
                if (start) |f| {
                    var raw = std.array_list.Managed(u8).init(a);
                    try raw.appendSlice(&.{ 0x00, 0x10 }); // no locals; call
                    try putU(&raw, f);
                    try raw.append(0x0b);
                    body_buf.clearRetainingCapacity();
                    try rewriteBody(a, &body_buf, raw.items, 0, fuel_global, oog_global);
                    try putU(&sec_buf, body_buf.items.len);
                    try sec_buf.appendSlice(body_buf.items);
                }
                try out.append(10);
                try putU(&out, sec_buf.items.len);
                try out.appendSlice(sec_buf.items);
            },
            else => {
                try out.append(sec.id);
                try putU(&out, sec.body.len);
                try out.appendSlice(sec.body);
            },
        }
    }
    if (!wrote_globals) try globalsSection(&out, &sec_buf, 0, "");
    if (!wrote_exports) try exportsSection(&out, &sec_buf, null, 0, fuel_global, oog_global, wrapper);

    return .{ .bytes = try out.toOwnedSlice(), .imports = try imports.toOwnedSlice(), .has_start = start != null };
}

/// The global section: the `n` old entries, then the counter and the flag.
fn globalsSection(out: *std.array_list.Managed(u8), buf: *std.array_list.Managed(u8), n: u32, old: []const u8) !void {
    buf.clearRetainingCapacity();
    try putU(buf, n + 2);
    try buf.appendSlice(old);
    try buf.appendSlice(&.{ 0x7e, 0x01, 0x42, 0x00, 0x0b }); // (mut i64) (i64.const 0)
    try buf.appendSlice(&.{ 0x7f, 0x01, 0x41, 0x00, 0x0b }); // (mut i32) (i32.const 0)
    try out.append(6);
    try putU(out, buf.items.len);
    try out.appendSlice(buf.items);
}

fn exportsSection(out: *std.array_list.Managed(u8), buf: *std.array_list.Managed(u8), old: ?[]const u8, n: u32, fuel_global: u32, oog_global: u32, start: ?u32) !void {
    buf.clearRetainingCapacity();
    try putU(buf, n + 2 + @as(u32, if (start != null) 1 else 0));
    if (old) |o| try buf.appendSlice(o);
    try putU(buf, FUEL_EXPORT.len);
    try buf.appendSlice(FUEL_EXPORT);
    try buf.append(3);
    try putU(buf, fuel_global);
    try putU(buf, OOG_EXPORT.len);
    try buf.appendSlice(OOG_EXPORT);
    try buf.append(3);
    try putU(buf, oog_global);
    if (start) |f| {
        try putU(buf, START_EXPORT.len);
        try buf.appendSlice(START_EXPORT);
        try buf.append(0);
        try putU(buf, f);
    }
    try out.append(7);
    try putU(out, buf.items.len);
    try out.appendSlice(buf.items);
}

const Frame = struct {
    kind: enum { func, block, loop, @"if" },
    /// A branch in reachable code targets this frame's exit (not a loop's).
    branched: bool = false,
    /// if: the `if` itself was reachable.
    head_reachable: bool = true,
    /// if: whether the consequent ended reachable, once its `else` is seen.
    consequent_ends: ?bool = null,
};

const Emitter = struct {
    out: *std.array_list.Managed(u8),
    f: u32, // the local fuel counter (i64)
    t: u32, // a count (i32)
    res: u32, // a grow's result (i32)
    fuel: u32, // the global counter
    oog: u32, // the out-of-fuel flag

    fn op(e: *Emitter, bytes: []const u8) !void {
        try e.out.appendSlice(bytes);
    }
    fn idx(e: *Emitter, code: u8, i: u32) !void {
        try e.out.append(code);
        try putU(e.out, i);
    }
    /// fuel_increment_var: the counter += k.
    fn add(e: *Emitter, k: i64) !void {
        if (k == 0) return;
        try e.idx(0x20, e.f);
        try e.out.append(0x42);
        try putS(e.out, k);
        try e.op(&.{0x7c}); // i64.add
        try e.idx(0x21, e.f);
    }
    /// The counter += the unsigned i32 in local `t`.
    fn addLocal(e: *Emitter) !void {
        try e.idx(0x20, e.f);
        try e.idx(0x20, e.t);
        try e.op(&.{0xad}); // i64.extend_i32_u
        try e.op(&.{0x7c});
        try e.idx(0x21, e.f);
    }
    fn save(e: *Emitter) !void {
        try e.idx(0x20, e.f);
        try e.idx(0x24, e.fuel);
    }
    fn load(e: *Emitter) !void {
        try e.idx(0x23, e.fuel);
        try e.idx(0x21, e.f);
    }
    /// fuel_check after the flush: counter ≥ 0 → save, flag, trap.
    fn check(e: *Emitter) !void {
        try e.idx(0x20, e.f);
        try e.op(&.{ 0x42, 0x00, 0x59, 0x04, 0x40 }); // i64.const 0; i64.ge_s; if
        try e.save();
        try e.op(&.{ 0x41, 0x01 });
        try e.idx(0x24, e.oog);
        try e.op(&.{ 0x00, 0x0b }); // unreachable; end
    }
};

/// Rewrite one function body (locals + expression) with the fuel accounting.
fn rewriteBody(a: std.mem.Allocator, out: *std.array_list.Managed(u8), body: []const u8, nparams: u32, fuel_global: u32, oog_global: u32) Error!void {
    _ = a;
    var r = Reader{ .b = body };
    const groups = try r.u32_();
    var nlocals: u64 = nparams;
    const locals_start = r.i;
    for (0..groups) |_| {
        nlocals += try r.u32_();
        _ = try valType(&r);
    }
    if (nlocals + 3 > std.math.maxInt(u32)) return error.Malformed;
    try putU(out, groups + 2);
    try out.appendSlice(body[locals_start..r.i]);
    try out.appendSlice(&.{ 0x01, 0x7e, 0x02, 0x7f }); // (local i64) (local i32 i32)
    var e = Emitter{ .out = out, .f = @intCast(nlocals), .t = @intCast(nlocals + 1), .res = @intCast(nlocals + 2), .fuel = fuel_global, .oog = oog_global };

    var frames: [4096]Frame = undefined;
    var depth: usize = 1;
    frames[0] = .{ .kind = .func };
    var reachable = true;
    var pending: i64 = 1; // a function entry costs 1

    // Function entry: load, check.
    try e.load();
    try e.add(pending);
    pending = 0;
    try e.check();

    // The constant on top of the operand stack, if the last operator put one there.
    var top_const: ?u64 = null;

    while (true) {
        if (r.eof()) return error.Malformed;
        const at = r.i;
        const code = try r.byte();
        // Decode the immediates (r moves past them) and classify.
        const Kind = enum { plain, free, call, exit, loop, @"if", block, br, br_if, br_table, end, @"else", grow, bulk, table_grow, iconst, local_get, local_set };
        var kind: Kind = .plain;
        var target: u32 = 0;
        var const_val: u64 = 0;
        switch (code) {
            0x00 => kind = .exit, // unreachable
            0x01, 0x1a => kind = .free, // nop, drop
            0x02 => {
                try blockType(&r);
                kind = .block;
            },
            0x03 => {
                try blockType(&r);
                kind = .loop;
            },
            0x04 => {
                try blockType(&r);
                kind = .@"if";
            },
            0x05 => kind = .@"else",
            0x0b => kind = .end,
            0x0c => {
                target = try r.u32_();
                kind = .br;
            },
            0x0d => {
                target = try r.u32_();
                kind = .br_if;
            },
            0x0e => kind = .br_table,
            0x0f => kind = .exit, // return
            0x10 => {
                _ = try r.u32_();
                kind = .call;
            },
            0x11 => {
                _ = try r.u32_();
                _ = try r.u32_();
                kind = .call;
            },
            0x12 => {
                _ = try r.u32_();
                kind = .exit; // return_call
            },
            0x13 => {
                _ = try r.u32_();
                _ = try r.u32_();
                kind = .exit; // return_call_indirect
            },
            0x1b => {},
            0x1c => {
                const n = try r.u32_();
                for (0..n) |_| _ = try valType(&r);
            },
            0x20 => {
                target = try r.u32_();
                kind = .local_get;
            },
            0x21, 0x22 => {
                target = try r.u32_();
                kind = .local_set;
            },
            0x23, 0x24, 0x25, 0x26 => _ = try r.u32_(),
            0x28...0x3e => try memarg(&r),
            0x3f => _ = try r.u32_(),
            0x40 => {
                if (try r.u32_() != 0) return error.Unsupported; // multi-memory grow
                kind = .grow;
            },
            0x41 => {
                const v = try r.s();
                const_val = @as(u32, @bitCast(@as(i32, @truncate(v))));
                kind = .iconst;
            },
            0x42 => {
                const v = try r.s();
                const_val = @bitCast(v);
                kind = .iconst;
            },
            0x43 => _ = try r.bytes(4),
            0x44 => _ = try r.bytes(8),
            0x45...0xc4 => {},
            0xd0 => {
                const h = r.b[r.i];
                if (h == 0x70 or h == 0x6f) r.i += 1 else return error.Unsupported;
            },
            0xd1 => {},
            0xd2 => _ = try r.u32_(),
            0xfc => {
                const sub = try r.u32_();
                switch (sub) {
                    0...7 => {},
                    8 => { // memory.init
                        _ = try r.u32_();
                        if (try r.u32_() != 0) return error.Unsupported;
                        kind = .bulk;
                    },
                    9, 13 => _ = try r.u32_(), // data.drop, elem.drop
                    10 => { // memory.copy
                        if (try r.u32_() != 0 or try r.u32_() != 0) return error.Unsupported;
                        kind = .bulk;
                    },
                    11 => { // memory.fill
                        if (try r.u32_() != 0) return error.Unsupported;
                        kind = .bulk;
                    },
                    12, 14 => { // table.init, table.copy
                        _ = try r.u32_();
                        _ = try r.u32_();
                        kind = .bulk;
                    },
                    15 => {
                        _ = try r.u32_();
                        kind = .table_grow;
                    },
                    16 => _ = try r.u32_(), // table.size
                    17 => {
                        _ = try r.u32_();
                        kind = .bulk; // table.fill
                    },
                    else => return error.Unsupported,
                }
            },
            0xfd => try simdImmediates(&r, try r.u32_()),
            0xfe => {
                const sub = try r.u32_();
                if (sub == 0x03) _ = try r.byte() else try memarg(&r);
            },
            else => return error.Unsupported, // exceptions, GC, typed function references, …
        }
        if (kind == .br_table) {
            const n = try r.u32_();
            for (0..n) |_| _ = try r.u32_();
            _ = try r.u32_();
        }
        const raw = r.b[at..r.i];

        if (!reachable) {
            // Unreachable code counts nothing; only the control structure is followed.
            switch (kind) {
                .block, .loop => {
                    if (depth == frames.len) return error.Unsupported;
                    frames[depth] = .{ .kind = if (kind == .loop) .loop else .block };
                    depth += 1;
                },
                .@"if" => {
                    if (depth == frames.len) return error.Unsupported;
                    frames[depth] = .{ .kind = .@"if", .head_reachable = false };
                    depth += 1;
                },
                .@"else" => {
                    const fr = &frames[depth - 1];
                    fr.consequent_ends = false;
                    if (fr.head_reachable) reachable = true;
                },
                .end => {
                    depth -= 1;
                    const fr = frames[depth];
                    const anyway = switch (fr.kind) {
                        .@"if" => if (fr.consequent_ends) |ce| fr.head_reachable and ce else fr.head_reachable,
                        else => false,
                    };
                    if (fr.branched or anyway) reachable = true;
                    if (depth == 0) {
                        // The function's end, reached only by branches to it: they saved.
                        try e.op(raw);
                        if (!r.eof()) return error.Malformed;
                        return;
                    }
                },
                else => {},
            }
            try e.op(raw);
            top_const = null;
            continue;
        }

        const cost: i64 = switch (kind) {
            .free, .block, .loop, .end, .@"else" => 0,
            .exit => if (code == 0x00 or code == 0x0f) 0 else 1,
            else => 1,
        };
        pending += cost;

        switch (kind) {
            .call => {
                try e.add(pending);
                pending = 0;
                try e.save();
                try e.op(raw);
                try e.load();
            },
            .exit => {
                try e.add(pending);
                pending = 0;
                try e.save();
                try e.op(raw);
                reachable = false;
            },
            .loop => {
                try e.add(pending);
                pending = 0;
                try e.op(raw);
                try e.check();
                if (depth == frames.len) return error.Unsupported;
                frames[depth] = .{ .kind = .loop };
                depth += 1;
            },
            .block => {
                try e.op(raw);
                if (depth == frames.len) return error.Unsupported;
                frames[depth] = .{ .kind = .block };
                depth += 1;
            },
            .@"if" => {
                try e.add(pending);
                pending = 0;
                try e.op(raw);
                if (depth == frames.len) return error.Unsupported;
                frames[depth] = .{ .kind = .@"if", .head_reachable = true };
                depth += 1;
            },
            .@"else" => {
                try e.add(pending);
                pending = 0;
                try e.op(raw);
                frames[depth - 1].consequent_ends = true;
            },
            .br, .br_if => {
                try e.add(pending);
                pending = 0;
                if (target >= depth) return error.Malformed;
                const fi = depth - 1 - target;
                if (frames[fi].kind != .loop) frames[fi].branched = true;
                if (fi == 0) {
                    // A branch to the function's label leaves it: save on the way out.
                    if (kind == .br) {
                        try e.save();
                    } else {
                        try e.idx(0x22, e.t); // local.tee t (the condition)
                        try e.op(&.{ 0x04, 0x40 });
                        try e.save();
                        try e.op(&.{0x0b});
                        try e.idx(0x20, e.t);
                    }
                }
                try e.op(raw);
                if (kind == .br) reachable = false;
            },
            .br_table => {
                try e.add(pending);
                pending = 0;
                var tr = Reader{ .b = raw[1..] };
                const n = try tr.u32_();
                var to_func = false;
                for (0..n + 1) |_| {
                    const l = try tr.u32_();
                    if (l >= depth) return error.Malformed;
                    const fi = depth - 1 - l;
                    if (frames[fi].kind != .loop) frames[fi].branched = true;
                    if (fi == 0) to_func = true;
                }
                if (to_func) try e.save();
                try e.op(raw);
                reachable = false;
            },
            .end => {
                try e.add(pending);
                pending = 0;
                depth -= 1;
                if (depth == 0) {
                    // The function's exit: save (the branches to it saved on their way).
                    try e.save();
                    try e.op(raw);
                    if (!r.eof()) return error.Malformed;
                    return;
                }
                try e.op(raw);
            },
            .grow, .table_grow => {
                const small = if (top_const) |c| c <= 128 else false;
                if (small) {
                    pending += @intCast(top_const.?);
                    try e.op(raw);
                    if (kind == .table_grow) {
                        try e.add(pending); // the flat cost is committed before the branch
                        pending = 0;
                    }
                } else {
                    if (top_const == null) try e.idx(0x22, e.t); // local.tee t (the count)
                    try e.op(raw);
                    try e.add(pending);
                    pending = 0;
                    try e.idx(0x22, e.res);
                    try e.op(&.{ 0x41, 0x7f, 0x47, 0x04, 0x40 }); // i32.const -1; i32.ne; if
                    if (top_const) |c| try e.add(@intCast(c)) else try e.addLocal();
                    try e.check();
                    try e.op(&.{0x0b});
                    try e.idx(0x20, e.res);
                }
            },
            .bulk => {
                const small = if (top_const) |c| c <= 128 else false;
                if (small) {
                    pending += @intCast(top_const.?);
                    try e.op(raw);
                } else {
                    if (top_const == null) try e.idx(0x22, e.t);
                    try e.op(raw);
                    try e.add(pending);
                    pending = 0;
                    if (top_const) |c| try e.add(@intCast(c)) else try e.addLocal();
                    try e.check();
                }
            },
            else => try e.op(raw),
        }

        top_const = switch (kind) {
            .iconst => const_val,
            .free => if (code == 0x01) top_const else null,
            else => null,
        };
        // local.get of a constant is not tracked (see the header): runtime from here.
    }
}

fn simdImmediates(r: *Reader, sub: u32) Error!void {
    switch (sub) {
        0...11, 92, 93 => try memarg(r),
        12, 13 => _ = try r.bytes(16),
        21...34 => _ = try r.byte(),
        84...91 => {
            try memarg(r);
            _ = try r.byte();
        },
        else => if (sub > 0x113) return error.Unsupported,
    }
}

test "leb" {
    var buf = std.array_list.Managed(u8).init(std.testing.allocator);
    defer buf.deinit();
    for ([_]i64{ 0, 1, -1, 63, 64, -64, -65, 1 << 40, -(1 << 40), std.math.maxInt(i64), std.math.minInt(i64) }) |v| {
        buf.clearRetainingCapacity();
        try putS(&buf, v);
        var r = Reader{ .b = buf.items };
        try std.testing.expectEqual(v, try r.s());
    }
}
