// WASI 0.2 components (issue #34): compile a component, instantiate it with
// the standard worlds and skein's own interface answered over the graph, run
// its `wasi:cli/run` export, report how it ended — the component twin of
// engine.Module.run.
//
// The host side is written by hand against wasmtime's component C API
// (wasmtime_component_linker_instance_add_func: dynamic values, canonical ABI
// lifting and lowering done by wasmtime). The WIT is the SDK's wit/ (shruggr/skein-sdk, #75; package
// skein:kernel, world `handler`); WASI 0.2.12, the version wasmtime v49 ships
// and its preview1 adapter imports (older 0.2.x imports link by semver).
//
// One behaviour for both ABIs: every wasi:filesystem / wasi:io / wasi:cli
// call is answered by the preview1 implementation itself (wasi.Process.
// dispatch) run against a scratch memory — descriptors are the process's fds,
// streams read and write through fd_read/fd_write — so a component sees the
// same tree, the same errors and the same inode numbers as a module.
// Clocks and random are the run's (the entry's stamp, the entry-derived
// stream); the skein interface calls program.Host as the preview1 `skein`
// imports do. What cannot be the same is listed in kernel-zig/README.md
// ("Components").
const std = @import("std");
const envm = @import("env.zig");
const engine = @import("engine.zig");
const wasi = @import("wasi.zig");
const program = @import("program.zig");
const vfsm = @import("vfs.zig");
const c = engine.c;
const E = vfsm.E;

pub const WASI_VERSION = "0.2.12";
pub const SKEIN_INTERFACE = "skein:kernel/skein@0.1.0";

/// A component binary (layer 1) rather than a core module (version 1).
pub fn isComponent(bytes: []const u8) bool {
    return bytes.len >= 8 and std.mem.eql(u8, bytes[0..4], "\x00asm") and std.mem.eql(u8, bytes[4..8], "\x0d\x00\x01\x00");
}

// ---------------------------------------------------------------- the import table

const Rt = enum(u32) {
    descriptor = 1,
    dir_stream,
    input_stream,
    output_stream,
    pollable,
    io_error,
    terminal_input,
    terminal_output,
};

const F = enum(u32) {
    // wasi:cli
    get_environment,
    get_arguments,
    initial_cwd,
    exit,
    exit_with_code,
    get_stdin,
    get_stdout,
    get_stderr,
    get_terminal_stdin,
    get_terminal_stdout,
    get_terminal_stderr,
    // wasi:clocks
    mono_now,
    mono_resolution,
    subscribe_instant,
    subscribe_duration,
    wall_now,
    wall_resolution,
    // wasi:random
    random_bytes,
    random_u64,
    insecure_bytes,
    insecure_u64,
    insecure_seed,
    // wasi:io
    error_debug,
    poll,
    pollable_ready,
    pollable_block,
    in_read,
    in_blocking_read,
    in_skip,
    in_blocking_skip,
    in_subscribe,
    out_check_write,
    out_write,
    out_blocking_write_flush,
    out_flush,
    out_blocking_flush,
    out_subscribe,
    out_write_zeroes,
    out_blocking_write_zeroes,
    out_splice,
    out_blocking_splice,
    // wasi:filesystem
    get_directories,
    fs_error_code,
    d_read_via_stream,
    d_write_via_stream,
    d_append_via_stream,
    d_advise,
    d_sync_data,
    d_get_flags,
    d_get_type,
    d_set_size,
    d_set_times,
    d_read,
    d_write,
    d_read_directory,
    d_sync,
    d_create_directory_at,
    d_stat,
    d_stat_at,
    d_set_times_at,
    d_link_at,
    d_open_at,
    d_readlink_at,
    d_remove_directory_at,
    d_rename_at,
    d_symlink_at,
    d_unlink_file_at,
    d_is_same_object,
    d_metadata_hash,
    d_metadata_hash_at,
    dirs_read,
    // skein:kernel/skein
    sk_input,
    sk_get,
    sk_put,
    sk_putblock,
    sk_keep,
    sk_launch,
    sk_await,
    sk_head,
    sk_advance,
    sk_wallet,
    sk_emit,
    sk_deadline,
    sk_call,
    sk_edges,
    sk_authfetch,
};

const Def = struct { name: []const u8, f: F };
const ResDef = struct { name: []const u8, ty: Rt };
/// `resources`: the resource types the interface defines and those it `use`s
/// (the linker checks each instance's types against the WIT's).
const Iface = struct { name: []const u8, resources: []const ResDef = &.{}, funcs: []const Def };

const V = "@" ++ WASI_VERSION;

const interfaces = [_]Iface{
    .{ .name = "wasi:cli/environment" ++ V, .funcs = &.{
        .{ .name = "get-environment", .f = .get_environment },
        .{ .name = "get-arguments", .f = .get_arguments },
        .{ .name = "initial-cwd", .f = .initial_cwd },
    } },
    .{ .name = "wasi:cli/exit" ++ V, .funcs = &.{
        .{ .name = "exit", .f = .exit },
        .{ .name = "exit-with-code", .f = .exit_with_code },
    } },
    .{ .name = "wasi:io/error" ++ V, .resources = &.{.{ .name = "error", .ty = .io_error }}, .funcs = &.{
        .{ .name = "[method]error.to-debug-string", .f = .error_debug },
    } },
    .{ .name = "wasi:io/poll" ++ V, .resources = &.{.{ .name = "pollable", .ty = .pollable }}, .funcs = &.{
        .{ .name = "poll", .f = .poll },
        .{ .name = "[method]pollable.ready", .f = .pollable_ready },
        .{ .name = "[method]pollable.block", .f = .pollable_block },
    } },
    .{ .name = "wasi:io/streams" ++ V, .resources = &.{ .{ .name = "input-stream", .ty = .input_stream }, .{ .name = "output-stream", .ty = .output_stream }, .{ .name = "error", .ty = .io_error }, .{ .name = "pollable", .ty = .pollable } }, .funcs = &.{
        .{ .name = "[method]input-stream.read", .f = .in_read },
        .{ .name = "[method]input-stream.blocking-read", .f = .in_blocking_read },
        .{ .name = "[method]input-stream.skip", .f = .in_skip },
        .{ .name = "[method]input-stream.blocking-skip", .f = .in_blocking_skip },
        .{ .name = "[method]input-stream.subscribe", .f = .in_subscribe },
        .{ .name = "[method]output-stream.check-write", .f = .out_check_write },
        .{ .name = "[method]output-stream.write", .f = .out_write },
        .{ .name = "[method]output-stream.blocking-write-and-flush", .f = .out_blocking_write_flush },
        .{ .name = "[method]output-stream.flush", .f = .out_flush },
        .{ .name = "[method]output-stream.blocking-flush", .f = .out_blocking_flush },
        .{ .name = "[method]output-stream.subscribe", .f = .out_subscribe },
        .{ .name = "[method]output-stream.write-zeroes", .f = .out_write_zeroes },
        .{ .name = "[method]output-stream.blocking-write-zeroes-and-flush", .f = .out_blocking_write_zeroes },
        .{ .name = "[method]output-stream.splice", .f = .out_splice },
        .{ .name = "[method]output-stream.blocking-splice", .f = .out_blocking_splice },
    } },
    .{ .name = "wasi:cli/stdin" ++ V, .resources = &.{.{ .name = "input-stream", .ty = .input_stream }}, .funcs = &.{.{ .name = "get-stdin", .f = .get_stdin }} },
    .{ .name = "wasi:cli/stdout" ++ V, .resources = &.{.{ .name = "output-stream", .ty = .output_stream }}, .funcs = &.{.{ .name = "get-stdout", .f = .get_stdout }} },
    .{ .name = "wasi:cli/stderr" ++ V, .resources = &.{.{ .name = "output-stream", .ty = .output_stream }}, .funcs = &.{.{ .name = "get-stderr", .f = .get_stderr }} },
    .{ .name = "wasi:cli/terminal-input" ++ V, .resources = &.{.{ .name = "terminal-input", .ty = .terminal_input }}, .funcs = &.{} },
    .{ .name = "wasi:cli/terminal-output" ++ V, .resources = &.{.{ .name = "terminal-output", .ty = .terminal_output }}, .funcs = &.{} },
    .{ .name = "wasi:cli/terminal-stdin" ++ V, .resources = &.{.{ .name = "terminal-input", .ty = .terminal_input }}, .funcs = &.{.{ .name = "get-terminal-stdin", .f = .get_terminal_stdin }} },
    .{ .name = "wasi:cli/terminal-stdout" ++ V, .resources = &.{.{ .name = "terminal-output", .ty = .terminal_output }}, .funcs = &.{.{ .name = "get-terminal-stdout", .f = .get_terminal_stdout }} },
    .{ .name = "wasi:cli/terminal-stderr" ++ V, .resources = &.{.{ .name = "terminal-output", .ty = .terminal_output }}, .funcs = &.{.{ .name = "get-terminal-stderr", .f = .get_terminal_stderr }} },
    .{ .name = "wasi:clocks/monotonic-clock" ++ V, .resources = &.{.{ .name = "pollable", .ty = .pollable }}, .funcs = &.{
        .{ .name = "now", .f = .mono_now },
        .{ .name = "resolution", .f = .mono_resolution },
        .{ .name = "subscribe-instant", .f = .subscribe_instant },
        .{ .name = "subscribe-duration", .f = .subscribe_duration },
    } },
    .{ .name = "wasi:clocks/wall-clock" ++ V, .funcs = &.{
        .{ .name = "now", .f = .wall_now },
        .{ .name = "resolution", .f = .wall_resolution },
    } },
    .{ .name = "wasi:filesystem/types" ++ V, .resources = &.{ .{ .name = "descriptor", .ty = .descriptor }, .{ .name = "directory-entry-stream", .ty = .dir_stream }, .{ .name = "input-stream", .ty = .input_stream }, .{ .name = "output-stream", .ty = .output_stream }, .{ .name = "error", .ty = .io_error } }, .funcs = &.{
        .{ .name = "filesystem-error-code", .f = .fs_error_code },
        .{ .name = "[method]descriptor.read-via-stream", .f = .d_read_via_stream },
        .{ .name = "[method]descriptor.write-via-stream", .f = .d_write_via_stream },
        .{ .name = "[method]descriptor.append-via-stream", .f = .d_append_via_stream },
        .{ .name = "[method]descriptor.advise", .f = .d_advise },
        .{ .name = "[method]descriptor.sync-data", .f = .d_sync_data },
        .{ .name = "[method]descriptor.get-flags", .f = .d_get_flags },
        .{ .name = "[method]descriptor.get-type", .f = .d_get_type },
        .{ .name = "[method]descriptor.set-size", .f = .d_set_size },
        .{ .name = "[method]descriptor.set-times", .f = .d_set_times },
        .{ .name = "[method]descriptor.read", .f = .d_read },
        .{ .name = "[method]descriptor.write", .f = .d_write },
        .{ .name = "[method]descriptor.read-directory", .f = .d_read_directory },
        .{ .name = "[method]descriptor.sync", .f = .d_sync },
        .{ .name = "[method]descriptor.create-directory-at", .f = .d_create_directory_at },
        .{ .name = "[method]descriptor.stat", .f = .d_stat },
        .{ .name = "[method]descriptor.stat-at", .f = .d_stat_at },
        .{ .name = "[method]descriptor.set-times-at", .f = .d_set_times_at },
        .{ .name = "[method]descriptor.link-at", .f = .d_link_at },
        .{ .name = "[method]descriptor.open-at", .f = .d_open_at },
        .{ .name = "[method]descriptor.readlink-at", .f = .d_readlink_at },
        .{ .name = "[method]descriptor.remove-directory-at", .f = .d_remove_directory_at },
        .{ .name = "[method]descriptor.rename-at", .f = .d_rename_at },
        .{ .name = "[method]descriptor.symlink-at", .f = .d_symlink_at },
        .{ .name = "[method]descriptor.unlink-file-at", .f = .d_unlink_file_at },
        .{ .name = "[method]descriptor.is-same-object", .f = .d_is_same_object },
        .{ .name = "[method]descriptor.metadata-hash", .f = .d_metadata_hash },
        .{ .name = "[method]descriptor.metadata-hash-at", .f = .d_metadata_hash_at },
        .{ .name = "[method]directory-entry-stream.read-directory-entry", .f = .dirs_read },
    } },
    .{ .name = "wasi:filesystem/preopens" ++ V, .resources = &.{.{ .name = "descriptor", .ty = .descriptor }}, .funcs = &.{.{ .name = "get-directories", .f = .get_directories }} },
    .{ .name = "wasi:random/random" ++ V, .funcs = &.{
        .{ .name = "get-random-bytes", .f = .random_bytes },
        .{ .name = "get-random-u64", .f = .random_u64 },
    } },
    .{ .name = "wasi:random/insecure" ++ V, .funcs = &.{
        .{ .name = "get-insecure-random-bytes", .f = .insecure_bytes },
        .{ .name = "get-insecure-random-u64", .f = .insecure_u64 },
    } },
    .{ .name = "wasi:random/insecure-seed" ++ V, .funcs = &.{.{ .name = "insecure-seed", .f = .insecure_seed }} },
    .{ .name = SKEIN_INTERFACE, .funcs = &.{
        .{ .name = "input", .f = .sk_input },
        .{ .name = "get", .f = .sk_get },
        .{ .name = "put", .f = .sk_put },
        .{ .name = "putblock", .f = .sk_putblock },
        .{ .name = "keep", .f = .sk_keep },
        .{ .name = "launch", .f = .sk_launch },
        .{ .name = "await", .f = .sk_await },
        .{ .name = "head", .f = .sk_head },
        .{ .name = "advance", .f = .sk_advance },
        .{ .name = "wallet", .f = .sk_wallet },
        .{ .name = "emit", .f = .sk_emit },
        .{ .name = "deadline", .f = .sk_deadline },
        .{ .name = "call", .f = .sk_call },
        .{ .name = "edges", .f = .sk_edges },
        .{ .name = "authfetch", .f = .sk_authfetch },
    } },
};

// ---------------------------------------------------------------- compile

pub const Component = struct {
    comp: *c.wasmtime_component_t,
    linker: *c.wasmtime_component_linker_t,
    /// The `run` function of the `wasi:cli/run@0.2.x` export.
    run_index: *c.wasmtime_component_export_index_t,

    /// Compile and link. On failure `err_msg` gets the engine's message.
    pub fn compile(eng: *engine.Engine, alloc: std.mem.Allocator, bytes: []const u8, err_msg: *[]const u8) !*Component {
        var comp: ?*c.wasmtime_component_t = null;
        if (c.wasmtime_component_new(eng.e, bytes.ptr, bytes.len, &comp)) |err| {
            err_msg.* = errorText(alloc, err);
            return error.Compile;
        }
        errdefer c.wasmtime_component_delete(comp.?);
        const run_index = findRun(eng, comp.?) orelse {
            err_msg.* = "no wasi:cli/run@0.2 export";
            return error.Compile;
        };
        const linker = try buildLinker(eng, alloc, err_msg);
        errdefer c.wasmtime_component_linker_delete(linker);
        // What the kernel does not answer (sockets, …) links as a trap, as a
        // preview1 import the kernel does not know answers ENOSYS.
        if (c.wasmtime_component_linker_define_unknown_imports_as_traps(linker, comp.?)) |err| {
            err_msg.* = errorText(alloc, err);
            return error.Link;
        }
        const out = try alloc.create(Component);
        out.* = .{ .comp = comp.?, .linker = linker, .run_index = run_index };
        return out;
    }

    /// Instantiate in a store of its own and call `wasi:cli/run`. The meter as
    /// for engine.Module.run: fuel is per store, so a component draws on the
    /// step's budget exactly as a module does.
    pub fn run(comp: *Component, eng: *engine.Engine, p: *wasi.Process, err_msg: *[]const u8, alloc: std.mem.Allocator, meter: ?*engine.Meter) !engine.Outcome {
        var s = Session{ .alloc = alloc, .p = p, .res = std.array_list.Managed(?Res).init(alloc) };
        const store = c.wasmtime_store_new(eng.e, &s, null) orelse return error.Engine;
        defer c.wasmtime_store_delete(store);
        const ctx = c.wasmtime_store_context(store).?;
        s.ctx = ctx;
        var frame = engine.Meter.Frame{ .ctx = ctx };
        if (meter) |m| m.enter(&frame) else engine.setFuel(ctx, engine.UNMETERED);
        defer if (meter) |m| m.exit(&frame);

        var inst: c.wasmtime_component_instance_t = undefined;
        if (c.wasmtime_component_linker_instantiate(comp.linker, ctx, comp.comp, &inst)) |err| {
            return s.ended(err, err_msg, error.Instantiate);
        }
        var func: c.wasmtime_component_func_t = undefined;
        if (!c.wasmtime_component_instance_get_func(&inst, ctx, comp.run_index, &func)) {
            err_msg.* = "no wasi:cli/run export";
            return error.Instantiate;
        }
        var result: Val = boolean(false); // the call drops what it overwrites
        if (c.wasmtime_component_func_call(&func, ctx, null, 0, &result, 1)) |err| {
            return s.ended(err, err_msg, error.Call);
        }
        defer c.wasmtime_component_val_delete(&result);
        if (result.kind == c.WASMTIME_COMPONENT_RESULT and !result.of.result.is_ok) {
            // run → err: exit status 1, as `exit(err)`.
            p.exit_code = 1;
            return .aborted;
        }
        return .returned;
    }
};

fn findRun(eng: *engine.Engine, comp: *c.wasmtime_component_t) ?*c.wasmtime_component_export_index_t {
    const ty = c.wasmtime_component_type(comp) orelse return null;
    defer c.wasmtime_component_type_delete(ty);
    const n = c.wasmtime_component_type_export_count(ty, eng.e);
    for (0..n) |i| {
        var name: [*c]const u8 = null;
        var len: usize = 0;
        var ext: ?*c.wasmtime_component_extern_t = null;
        if (!c.wasmtime_component_type_export_nth(ty, eng.e, i, &name, &len, &ext)) continue;
        if (ext) |e| c.wasmtime_component_extern_delete(e);
        const s = name[0..len];
        if (!std.mem.startsWith(u8, s, "wasi:cli/run@0.2.")) continue;
        const inst = c.wasmtime_component_get_export_index(comp, null, s.ptr, s.len) orelse return null;
        defer c.wasmtime_component_export_index_delete(inst);
        return c.wasmtime_component_get_export_index(comp, inst, "run", 3);
    }
    return null;
}

fn buildLinker(eng: *engine.Engine, alloc: std.mem.Allocator, err_msg: *[]const u8) !*c.wasmtime_component_linker_t {
    const linker = c.wasmtime_component_linker_new(eng.e) orelse return error.Engine;
    errdefer c.wasmtime_component_linker_delete(linker);
    const root = c.wasmtime_component_linker_root(linker) orelse return error.Engine;
    defer c.wasmtime_component_linker_instance_delete(root);
    for (interfaces) |iface| {
        var li: ?*c.wasmtime_component_linker_instance_t = null;
        if (c.wasmtime_component_linker_instance_add_instance(root, iface.name.ptr, iface.name.len, &li)) |err| {
            err_msg.* = errorText(alloc, err);
            return error.Link;
        }
        defer c.wasmtime_component_linker_instance_delete(li);
        for (iface.resources) |r| {
            const ty = c.wasmtime_component_resource_type_new_host(@intFromEnum(r.ty));
            defer c.wasmtime_component_resource_type_delete(ty);
            if (c.wasmtime_component_linker_instance_add_resource(li, r.name.ptr, r.name.len, ty, destructor, @ptrFromInt(@intFromEnum(r.ty)), null)) |err| {
                err_msg.* = errorText(alloc, err);
                return error.Link;
            }
        }
        for (iface.funcs) |d| {
            if (c.wasmtime_component_linker_instance_add_func(li, d.name.ptr, d.name.len, callback, @ptrFromInt(@intFromEnum(d.f) + 1), null)) |err| {
                err_msg.* = errorText(alloc, err);
                return error.Link;
            }
        }
    }
    return linker;
}

fn errorText(alloc: std.mem.Allocator, err: *c.wasmtime_error_t) []const u8 {
    defer c.wasmtime_error_delete(err);
    var msg: c.wasm_name_t = undefined;
    c.wasmtime_error_message(err, &msg);
    defer c.wasm_byte_vec_delete(&msg);
    return alloc.dupe(u8, msg.data[0..msg.size]) catch "wasmtime error";
}

// ---------------------------------------------------------------- the run

const Val = c.wasmtime_component_val_t;

const Stream = struct { fd: i32, owned: bool };
const Ent = struct { name: []const u8, ft: u8 };
const Res = union(enum) {
    /// A preopen's descriptor names its fd; one open-at made owns it (closed on drop).
    desc: Stream,
    dirs: struct { ents: []Ent, i: usize = 0 },
    in: Stream,
    out: Stream,
    /// null: always ready (a stream's); a clock: a sleep.
    poll: ?wasi.Clock,
    err: u16,
};


const Abort = error{ Abort, OutOfMemory };

/// The largest read a single call hands back (a read may return less than asked).
const MAX_READ: u64 = 16 << 20;
/// What check-write allows (the pipes check their own limits).
const WRITE_BUDGET: u64 = 1 << 20;

const Session = struct {
    alloc: std.mem.Allocator,
    p: *wasi.Process,
    ctx: *c.wasmtime_context_t = undefined,
    res: std.array_list.Managed(?Res),
    aborted: bool = false,
    scratch: []u8 = &.{},
    top: usize = 0,
    /// fds for the file streams' own descriptions (a position of their own), out of the program's way.
    next_hidden: i32 = 1 << 24,

    /// How the run ended when the engine returned an error.
    fn ended(s: *Session, err: *c.wasmtime_error_t, err_msg: *[]const u8, e: anyerror) anyerror!engine.Outcome {
        if (s.aborted) {
            c.wasmtime_error_delete(err);
            return .aborted;
        }
        const msg = errorText(s.alloc, err);
        if (engine.getFuel(s.ctx) == 0) return .{ .trapped = .out_of_fuel };
        if (trapOf(msg)) |t| return .{ .trapped = t };
        err_msg.* = msg;
        return e;
    }

    // -------------------------------------------------- resources

    fn add(s: *Session, r: Res) Abort!u32 {
        try s.res.append(r);
        return @intCast(s.res.items.len);
    }

    fn get(s: *Session, rep: u32) Abort!*Res {
        if (rep == 0 or rep > s.res.items.len) return s.fatal("component: unknown resource");
        if (s.res.items[rep - 1]) |*r| return r;
        return s.fatal("component: dropped resource");
    }

    fn drop(s: *Session, rep: u32) void {
        if (rep == 0 or rep > s.res.items.len) return;
        const r = s.res.items[rep - 1] orelse return;
        s.res.items[rep - 1] = null;
        switch (r) {
            .desc => |d| if (d.owned) {
                _ = s.p.fds.remove(d.fd);
            },
            .in, .out => |st| if (st.owned) {
                _ = s.p.fds.remove(st.fd);
            },
            else => {},
        }
    }

    fn fatal(s: *Session, msg: []const u8) Abort {
        const st = s.p.svc.state;
        if (st.fatal == null) st.fatal = .{ .message = msg };
        return error.Abort;
    }

    fn newRes(s: *Session, ty: Rt, r: Res) Abort!Val {
        const rep = try s.add(r);
        const h = c.wasmtime_component_resource_host_new(true, rep, @intFromEnum(ty));
        defer c.wasmtime_component_resource_host_delete(h);
        var any: ?*c.wasmtime_component_resource_any_t = null;
        if (c.wasmtime_component_resource_host_to_any(s.ctx, h, &any)) |err| return s.fatal(errorText(s.alloc, err));
        return .{ .kind = c.WASMTIME_COMPONENT_RESOURCE, .of = .{ .resource = any } };
    }

    fn repOf(s: *Session, v: *const Val) Abort!u32 {
        if (v.kind != c.WASMTIME_COMPONENT_RESOURCE) return s.fatal("component: expected a resource");
        var h: ?*c.wasmtime_component_resource_host_t = null;
        if (c.wasmtime_component_resource_any_to_host(s.ctx, v.of.resource, &h)) |err| return s.fatal(errorText(s.alloc, err));
        defer c.wasmtime_component_resource_host_delete(h);
        return c.wasmtime_component_resource_host_rep(h);
    }

    fn descFd(s: *Session, v: *const Val) Abort!i32 {
        return switch ((try s.get(try s.repOf(v))).*) {
            .desc => |d| d.fd,
            else => s.fatal("component: not a descriptor"),
        };
    }

    fn streamOf(s: *Session, v: *const Val) Abort!Stream {
        return switch ((try s.get(try s.repOf(v))).*) {
            .in, .out => |st| st,
            else => s.fatal("component: not a stream"),
        };
    }

    // -------------------------------------------------- preview1 over a scratch memory

    fn reset(s: *Session) void {
        s.top = 0;
    }

    /// Room for n bytes in the scratch memory; its offset.
    fn reserve(s: *Session, n: usize) Abort!i64 {
        const at = std.mem.alignForward(usize, s.top, 8);
        if (at + n > s.scratch.len) {
            const grown = try s.alloc.alloc(u8, @max(at + n, s.scratch.len * 2, 4096));
            @memcpy(grown[0..s.scratch.len], s.scratch);
            s.scratch = grown;
        }
        s.top = at + n;
        return @intCast(at);
    }

    fn put(s: *Session, b: []const u8) Abort!i64 {
        const at = try s.reserve(b.len);
        @memcpy(s.scratch[@intCast(at)..][0..b.len], b);
        return at;
    }

    fn mem(s: *Session, off: i64, n: usize) []u8 {
        return s.scratch[@intCast(off)..][0..n];
    }

    fn u32At(s: *Session, off: i64) u32 {
        return std.mem.readInt(u32, s.mem(off, 4)[0..4], .little);
    }

    fn u64At(s: *Session, off: i64) u64 {
        return std.mem.readInt(u64, s.mem(off, 8)[0..8], .little);
    }

    /// One preview1 call; its errno (0: success). A stop (exit, fatal, park) aborts the component.
    fn p1(s: *Session, f: wasi.Fn, a: []const i64) Abort!u16 {
        const e = try s.p1Call(f, a);
        if (traceOn()) std.debug.print("  {s}{any} → {d}\n", .{ @tagName(f), a, e });
        return e;
    }

    fn p1Call(s: *Session, f: wasi.Fn, a: []const i64) Abort!u16 {
        const p = s.p;
        p.mem = s.scratch;
        const st = p.svc.state;
        const r = p.dispatch(f, a) catch |err| switch (err) {
            error.Errno => return p.vfs.errno,
            error.Park => {
                st.parked = true;
                return error.Abort;
            },
            error.Exit => return error.Abort,
            error.Fatal => {
                if (st.fatal == null) st.fatal = .{ .message = p.vfs.fatal_msg };
                return error.Abort;
            },
            else => {
                if (st.fatal == null) st.fatal = .{ .message = @errorName(err) };
                return error.Abort;
            },
        };
        return @intCast(r);
    }

    // -------------------------------------------------- the calls

    fn call(s: *Session, f: F, a: []Val) Abort!?Val {
        s.reset();
        const p = s.p;
        const svc = p.svc;
        switch (f) {
            // ---- wasi:cli
            .get_environment => {
                var l = listUninit(p.env.len);
                for (p.env, 0..) |kv, i| {
                    const eq = std.mem.indexOfScalar(u8, kv, '=') orelse kv.len;
                    l.data[i] = tuple(&.{ vStr(kv[0..eq]), vStr(if (eq < kv.len) kv[eq + 1 ..] else "") });
                }
                return .{ .kind = c.WASMTIME_COMPONENT_LIST, .of = .{ .list = l } };
            },
            .get_arguments => {
                var l = listUninit(p.args.len);
                for (p.args, 0..) |x, i| l.data[i] = vStr(x);
                return .{ .kind = c.WASMTIME_COMPONENT_LIST, .of = .{ .list = l } };
            },
            .initial_cwd => return vNone(),
            .exit => {
                p.exit_code = if (a[0].of.result.is_ok) 0 else 1;
                return error.Abort;
            },
            .exit_with_code => {
                p.exit_code = a[0].of.u8;
                return error.Abort;
            },
            .get_stdin => return try s.newRes(.input_stream, .{ .in = .{ .fd = 0, .owned = false } }),
            .get_stdout => return try s.newRes(.output_stream, .{ .out = .{ .fd = 1, .owned = false } }),
            .get_stderr => return try s.newRes(.output_stream, .{ .out = .{ .fd = 2, .owned = false } }),
            .get_terminal_stdin, .get_terminal_stdout, .get_terminal_stderr => return vNone(),

            // ---- wasi:clocks: the run's clock (the entry's stamp), as clock_time_get
            .mono_now => return u64v(svc.clock(svc.ctx, 1)),
            .mono_resolution => return u64v(1),
            .wall_now => return datetime(svc.clock(svc.ctx, 0)),
            .wall_resolution => return datetime(1),
            .subscribe_instant => return try s.newRes(.pollable, .{ .poll = .{ .timeout = a[0].of.u64, .absolute = true } }),
            .subscribe_duration => return try s.newRes(.pollable, .{ .poll = .{ .timeout = a[0].of.u64, .absolute = false } }),

            // ---- wasi:random: the run's stream, as random_get (insecure too)
            .random_bytes, .insecure_bytes => {
                const n: usize = @intCast(@min(a[0].of.u64, MAX_READ));
                const buf = try s.alloc.alloc(u8, n);
                svc.random(svc.ctx, buf);
                return vBytes(buf);
            },
            .random_u64, .insecure_u64 => {
                var b: [8]u8 = undefined;
                svc.random(svc.ctx, &b);
                return u64v(std.mem.readInt(u64, &b, .little));
            },
            .insecure_seed => {
                var b: [16]u8 = undefined;
                svc.random(svc.ctx, &b);
                return tuple(&.{ u64v(std.mem.readInt(u64, b[0..8], .little)), u64v(std.mem.readInt(u64, b[8..16], .little)) });
            },

            // ---- wasi:io
            .error_debug => {
                const e = switch ((try s.get(try s.repOf(&a[0]))).*) {
                    .err => |x| x,
                    else => 0,
                };
                return vStr(errorCodeName(e));
            },
            .poll => {
                const l = a[0].of.list;
                try s.pollAll(l.data[0..l.size]);
                var out = listUninit(l.size);
                for (0..l.size) |i| out.data[i] = .{ .kind = c.WASMTIME_COMPONENT_U32, .of = .{ .u32 = @intCast(i) } };
                return .{ .kind = c.WASMTIME_COMPONENT_LIST, .of = .{ .list = out } };
            },
            .pollable_ready => return boolean(true),
            .pollable_block => {
                try s.pollAll(a[0..1]);
                return null;
            },
            .in_read, .in_blocking_read => {
                const st = try s.streamOf(&a[0]);
                return switch (try s.readStream(st.fd, a[1].of.u64)) {
                    .ok => |b| vOk(vBytes(b)),
                    .closed => vErr(variant("closed", null)),
                    .errno => |e| vErr(variant("last-operation-failed", try s.newRes(.io_error, .{ .err = e }))),
                };
            },
            .in_skip, .in_blocking_skip => {
                const st = try s.streamOf(&a[0]);
                return switch (try s.readStream(st.fd, a[1].of.u64)) {
                    .ok => |b| vOk(u64v(b.len)),
                    .closed => vErr(variant("closed", null)),
                    .errno => |e| vErr(variant("last-operation-failed", try s.newRes(.io_error, .{ .err = e }))),
                };
            },
            .in_subscribe, .out_subscribe => {
                // every resource argument is taken (a borrow left untaken outlives the call)
                _ = try s.repOf(&a[0]);
                return try s.newRes(.pollable, .{ .poll = null });
            },
            .out_check_write => {
                _ = try s.streamOf(&a[0]);
                return vOk(u64v(WRITE_BUDGET));
            },
            .out_write, .out_blocking_write_flush => {
                const st = try s.streamOf(&a[0]);
                return s.writeResult(try s.writeStream(st.fd, try listBytes(s.alloc, &a[1])));
            },
            .out_write_zeroes, .out_blocking_write_zeroes => {
                const st = try s.streamOf(&a[0]);
                const z = try s.alloc.alloc(u8, @intCast(@min(a[1].of.u64, MAX_READ)));
                @memset(z, 0);
                return s.writeResult(try s.writeStream(st.fd, z));
            },
            .out_flush, .out_blocking_flush => {
                _ = try s.streamOf(&a[0]);
                return vOk(null);
            },
            .out_splice, .out_blocking_splice => {
                const dst = try s.streamOf(&a[0]);
                const src = try s.streamOf(&a[1]);
                switch (try s.readStream(src.fd, a[2].of.u64)) {
                    .ok => |b| {
                        const e = try s.writeStream(dst.fd, b);
                        if (e != 0) return vErr(variant("last-operation-failed", try s.newRes(.io_error, .{ .err = e })));
                        return vOk(u64v(b.len));
                    },
                    .closed => return vErr(variant("closed", null)),
                    .errno => |e| return vErr(variant("last-operation-failed", try s.newRes(.io_error, .{ .err = e }))),
                }
            },

            // ---- wasi:filesystem: preview1's own calls on the process's fds
            .get_directories => {
                var fds = std.array_list.Managed(i32).init(s.alloc);
                var it = p.fds.iterator();
                while (it.next()) |kv| if (kv.value_ptr.*.preopen != null and kv.key_ptr.* < (1 << 24)) try fds.append(kv.key_ptr.*);
                std.mem.sort(i32, fds.items, {}, std.sort.asc(i32));
                var l = listUninit(fds.items.len);
                for (fds.items, 0..) |fd, i| l.data[i] = tuple(&.{ try s.newRes(.descriptor, .{ .desc = .{ .fd = fd, .owned = false } }), vStr(p.fds.get(fd).?.preopen.?) });
                return .{ .kind = c.WASMTIME_COMPONENT_LIST, .of = .{ .list = l } };
            },
            .fs_error_code => {
                return switch ((try s.get(try s.repOf(&a[0]))).*) {
                    .err => |e| vSome(enumv(errorCodeName(e))),
                    else => vNone(),
                };
            },
            .d_read_via_stream => {
                const fd = try s.descFd(&a[0]);
                return vOk(try s.newRes(.input_stream, .{ .in = try s.fileStream(fd, a[1].of.u64, false) }));
            },
            .d_write_via_stream => {
                const fd = try s.descFd(&a[0]);
                return vOk(try s.newRes(.output_stream, .{ .out = try s.fileStream(fd, a[1].of.u64, false) }));
            },
            .d_append_via_stream => {
                const fd = try s.descFd(&a[0]);
                return vOk(try s.newRes(.output_stream, .{ .out = try s.fileStream(fd, 0, true) }));
            },
            .d_advise => return s.errnoResult(try s.p1(.fd_advise, &.{ try s.descFd(&a[0]), 0, 0, 0 }), null),
            .d_sync_data => return s.errnoResult(try s.p1(.fd_datasync, &.{try s.descFd(&a[0])}), null),
            .d_sync => return s.errnoResult(try s.p1(.fd_sync, &.{try s.descFd(&a[0])}), null),
            .d_set_times => return s.errnoResult(try s.p1(.fd_filestat_set_times, &.{ try s.descFd(&a[0]), 0, 0, 0 }), null),
            .d_set_times_at => {
                const fd = try s.descFd(&a[0]);
                const path = try s.put(str(&a[2]));
                return s.errnoResult(try s.p1(.path_filestat_set_times, &.{ fd, flagSet(&a[1], "symlink-follow"), path, @intCast(str(&a[2]).len), 0, 0, 0 }), null);
            },
            .d_get_flags => {
                const fd = try s.descFd(&a[0]);
                const d = p.fds.get(fd) orelse return vErr(enumv(errorCodeName(E.BADF)));
                var names: [3][]const u8 = undefined;
                var n: usize = 0;
                if (d.t == .dir) {
                    names[n] = "read";
                    n += 1;
                    names[n] = "mutate-directory";
                    n += 1;
                } else {
                    if (d.read or !d.write) {
                        names[n] = "read";
                        n += 1;
                    }
                    if (d.write) {
                        names[n] = "write";
                        n += 1;
                    }
                }
                return vOk(flags(names[0..n]));
            },
            .d_get_type => {
                const fd = try s.descFd(&a[0]);
                const stat = try s.reserve(24);
                const e = try s.p1(.fd_fdstat_get, &.{ fd, stat });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                return vOk(enumv(typeName(s.mem(stat, 1)[0])));
            },
            .d_set_size => return s.errnoResult(try s.p1(.fd_filestat_set_size, &.{ try s.descFd(&a[0]), @bitCast(a[1].of.u64) }), null),
            .d_read => {
                const fd = try s.descFd(&a[0]);
                const want: usize = @intCast(@min(a[1].of.u64, MAX_READ));
                const buf = try s.reserve(want);
                const iov = try s.reserve(8);
                std.mem.writeInt(u32, s.mem(iov, 4)[0..4], @intCast(buf), .little);
                std.mem.writeInt(u32, s.mem(iov + 4, 4)[0..4], @intCast(want), .little);
                const nr = try s.reserve(4);
                const e = try s.p1(.fd_pread, &.{ fd, iov, 1, @bitCast(a[2].of.u64), nr });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                const got = s.u32At(nr);
                return vOk(tuple(&.{ vBytes(s.mem(buf, got)), boolean(got < want or want == 0) }));
            },
            // preview1's fd_pwrite is not supported; neither is this.
            .d_write => return vErr(enumv(errorCodeName(E.NOTSUP))),
            .d_read_directory => {
                const fd = try s.descFd(&a[0]);
                const ents = s.readdir(fd) catch |e2| switch (e2) {
                    error.Errno => return vErr(enumv(errorCodeName(p.vfs.errno))),
                    else => |x| return x,
                };
                return vOk(try s.newRes(.dir_stream, .{ .dirs = .{ .ents = ents } }));
            },
            .dirs_read => {
                const r = try s.get(try s.repOf(&a[0]));
                if (r.* != .dirs) return s.fatal("component: not a directory stream");
                const ds = &r.dirs;
                if (ds.i >= ds.ents.len) return vOk(vNone());
                const e = ds.ents[ds.i];
                ds.i += 1;
                return vOk(vSome(record(&.{ .{ "type", enumv(typeName(e.ft)) }, .{ "name", vStr(e.name) } })));
            },
            .d_create_directory_at => return s.pathOp(.path_create_directory, &a[0], &a[1]),
            .d_remove_directory_at => return s.pathOp(.path_remove_directory, &a[0], &a[1]),
            .d_unlink_file_at => return s.pathOp(.path_unlink_file, &a[0], &a[1]),
            .d_stat => {
                const fd = try s.descFd(&a[0]);
                const buf = try s.reserve(64);
                const e = try s.p1(.fd_filestat_get, &.{ fd, buf });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                return vOk(s.statValue(buf));
            },
            .d_stat_at => {
                const fd = try s.descFd(&a[0]);
                const path = str(&a[2]);
                const pp = try s.put(path);
                const buf = try s.reserve(64);
                const e = try s.p1(.path_filestat_get, &.{ fd, flagSet(&a[1], "symlink-follow"), pp, @intCast(path.len), buf });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                return vOk(s.statValue(buf));
            },
            .d_metadata_hash => {
                const fd = try s.descFd(&a[0]);
                const buf = try s.reserve(64);
                const e = try s.p1(.fd_filestat_get, &.{ fd, buf });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                return vOk(record(&.{ .{ "lower", u64v(s.u64At(buf + 8)) }, .{ "upper", u64v(0) } }));
            },
            .d_metadata_hash_at => {
                const fd = try s.descFd(&a[0]);
                const path = str(&a[2]);
                const pp = try s.put(path);
                const buf = try s.reserve(64);
                const e = try s.p1(.path_filestat_get, &.{ fd, flagSet(&a[1], "symlink-follow"), pp, @intCast(path.len), buf });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                return vOk(record(&.{ .{ "lower", u64v(s.u64At(buf + 8)) }, .{ "upper", u64v(0) } }));
            },
            .d_link_at => {
                const fd = try s.descFd(&a[0]);
                const old = str(&a[2]);
                const fd2 = try s.descFd(&a[3]);
                const new = str(&a[4]);
                const op = try s.put(old);
                const np = try s.put(new);
                return s.errnoResult(try s.p1(.path_link, &.{ fd, flagSet(&a[1], "symlink-follow"), op, @intCast(old.len), fd2, np, @intCast(new.len) }), null);
            },
            .d_rename_at => {
                const fd = try s.descFd(&a[0]);
                const old = str(&a[1]);
                const fd2 = try s.descFd(&a[2]);
                const new = str(&a[3]);
                const op = try s.put(old);
                const np = try s.put(new);
                return s.errnoResult(try s.p1(.path_rename, &.{ fd, op, @intCast(old.len), fd2, np, @intCast(new.len) }), null);
            },
            .d_symlink_at => {
                const fd = try s.descFd(&a[0]);
                const target = str(&a[1]);
                const new = str(&a[2]);
                const tp = try s.put(target);
                const np = try s.put(new);
                return s.errnoResult(try s.p1(.path_symlink, &.{ tp, @intCast(target.len), fd, np, @intCast(new.len) }), null);
            },
            .d_readlink_at => {
                const fd = try s.descFd(&a[0]);
                const path = str(&a[1]);
                var cap: usize = 4096;
                while (true) {
                    s.reset();
                    const pp = try s.put(path);
                    const buf = try s.reserve(cap);
                    const used = try s.reserve(4);
                    const e = try s.p1(.path_readlink, &.{ fd, pp, @intCast(path.len), buf, @intCast(cap), used });
                    if (e != 0) return vErr(enumv(errorCodeName(e)));
                    const n = s.u32At(used);
                    if (n < cap) return vOk(vStr(s.mem(buf, n)));
                    cap *= 2;
                }
            },
            .d_open_at => {
                const fd = try s.descFd(&a[0]);
                const path = str(&a[2]);
                const pp = try s.put(path);
                const out = try s.reserve(4);
                var oflags: i64 = 0;
                if (flagSet(&a[3], "create") != 0) oflags |= 1;
                if (flagSet(&a[3], "directory") != 0) oflags |= 2;
                if (flagSet(&a[3], "exclusive") != 0) oflags |= 4;
                if (flagSet(&a[3], "truncate") != 0) oflags |= 8;
                var rights: i64 = 0;
                if (flagSet(&a[4], "read") != 0) rights |= 1 << 1;
                if (flagSet(&a[4], "write") != 0) rights |= 1 << 6;
                const e = try s.p1(.path_open, &.{ fd, flagSet(&a[1], "symlink-follow"), pp, @intCast(path.len), oflags, rights, 0, 0, out });
                if (e != 0) return vErr(enumv(errorCodeName(e)));
                return vOk(try s.newRes(.descriptor, .{ .desc = .{ .fd = @bitCast(s.u32At(out)), .owned = true } }));
            },
            .d_is_same_object => {
                const x = p.fds.get(try s.descFd(&a[0]));
                const y = p.fds.get(try s.descFd(&a[1]));
                if (x == null or y == null) return boolean(false);
                return boolean(x.? == y.? or (x.?.node != null and x.?.node == y.?.node));
            },

            // ---- skein:kernel/skein: program.Host, as the preview1 imports call it
            .sk_input, .sk_get, .sk_put, .sk_putblock, .sk_keep, .sk_launch, .sk_await, .sk_head, .sk_advance, .sk_wallet, .sk_emit, .sk_deadline, .sk_call, .sk_edges, .sk_authfetch => return s.skein(f, a),
        }
    }

    fn errnoResult(_: *Session, e: u16, payload: ?Val) Val {
        return if (e == 0) vOk(payload) else vErr(enumv(errorCodeName(e)));
    }

    fn pathOp(s: *Session, f: wasi.Fn, d: *const Val, path_v: *const Val) Abort!?Val {
        const fd = try s.descFd(d);
        const path = str(path_v);
        const pp = try s.put(path);
        return s.errnoResult(try s.p1(f, &.{ fd, pp, @intCast(path.len) }), null);
    }

    fn statValue(s: *Session, buf: i64) Val {
        const epoch = vSome(datetime(0));
        return record(&.{
            .{ "type", enumv(typeName(s.mem(buf + 16, 1)[0])) },
            .{ "link-count", u64v(s.u64At(buf + 24)) },
            .{ "size", u64v(s.u64At(buf + 32)) },
            // Git records no times: every file reads as the epoch, as fd_filestat_get says.
            .{ "data-access-timestamp", epoch },
            .{ "data-modification-timestamp", vSome(datetime(0)) },
            .{ "status-change-timestamp", vSome(datetime(0)) },
        });
    }

    /// A stream over a descriptor: a file gets a description of its own (its
    /// position, append or not), anything else is read and written as is.
    fn fileStream(s: *Session, fd: i32, offset: u64, append: bool) Abort!Stream {
        const d = s.p.fds.get(fd) orelse return .{ .fd = fd, .owned = false };
        if (d.t != .file) return .{ .fd = fd, .owned = false };
        const own = try s.alloc.create(wasi.Desc);
        own.* = d.*;
        own.pos = @intCast(offset);
        own.append = append;
        const h = s.next_hidden;
        s.next_hidden += 1;
        try s.p.fds.put(h, own);
        return .{ .fd = h, .owned = true };
    }

    const Read = union(enum) { ok: []const u8, closed, errno: u16 };

    fn readStream(s: *Session, fd: i32, len: u64) Abort!Read {
        const want: usize = @intCast(@min(len, MAX_READ));
        const buf = try s.reserve(want);
        const iov = try s.reserve(8);
        std.mem.writeInt(u32, s.mem(iov, 4)[0..4], @intCast(buf), .little);
        std.mem.writeInt(u32, s.mem(iov + 4, 4)[0..4], @intCast(want), .little);
        const nr = try s.reserve(4);
        const e = try s.p1(.fd_read, &.{ fd, iov, 1, nr });
        if (e != 0) return .{ .errno = e };
        const got = s.u32At(nr);
        if (got == 0 and want > 0) return .closed; // preview1: a read of 0 is the end
        return .{ .ok = try s.alloc.dupe(u8, s.mem(buf, got)) };
    }

    fn writeStream(s: *Session, fd: i32, b: []const u8) Abort!u16 {
        const buf = try s.put(b);
        const iov = try s.reserve(8);
        std.mem.writeInt(u32, s.mem(iov, 4)[0..4], @intCast(buf), .little);
        std.mem.writeInt(u32, s.mem(iov + 4, 4)[0..4], @intCast(b.len), .little);
        const nw = try s.reserve(4);
        return s.p1(.fd_write, &.{ fd, iov, 1, nw });
    }

    fn writeResult(s: *Session, e: u16) Abort!?Val {
        if (e == 0) return vOk(null);
        return vErr(variant("last-operation-failed", try s.newRes(.io_error, .{ .err = e })));
    }

    /// poll_oneoff's rule: clocks alone are a sleep (the run's sleep service, if any); every subscription fires.
    fn pollAll(s: *Session, ps: []const Val) Abort!void {
        var clocks = std.array_list.Managed(wasi.Clock).init(s.alloc);
        var other = false;
        for (ps) |*v| switch ((try s.get(try s.repOf(v))).*) {
            .poll => |x| if (x) |clk| try clocks.append(clk) else {
                other = true;
            },
            else => other = true,
        };
        if (clocks.items.len > 0 and !other) {
            if (s.p.svc.sleep) |sleep| sleep(s.p.svc.ctx, clocks.items) catch |e| switch (e) {
                error.Park => {
                    s.p.svc.state.parked = true;
                    return error.Abort;
                },
                error.Fatal => return error.Abort,
                error.OutOfMemory => return error.OutOfMemory,
            };
        }
    }

    /// The directory's entries as fd_readdir lists them, without "." and "..".
    fn readdir(s: *Session, fd: i32) (Abort || error{Errno})![]Ent {
        var cap: usize = 1 << 16;
        while (true) {
            s.reset();
            const buf = try s.reserve(cap);
            const used = try s.reserve(4);
            const e = try s.p1(.fd_readdir, &.{ fd, buf, @intCast(cap), 0, used });
            if (e != 0) {
                s.p.vfs.errno = e;
                return error.Errno;
            }
            const n = s.u32At(used);
            if (n >= cap) {
                cap *= 4;
                continue;
            }
            var out = std.array_list.Managed(Ent).init(s.alloc);
            const b = s.mem(buf, n);
            var i: usize = 0;
            while (i + 24 <= b.len) {
                const nl = std.mem.readInt(u32, b[i + 16 ..][0..4], .little);
                const ft = b[i + 20];
                const name = b[i + 24 .. i + 24 + nl];
                i += 24 + nl;
                if (std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..")) continue;
                try out.append(.{ .name = try s.alloc.dupe(u8, name), .ft = ft });
            }
            return out.toOwnedSlice();
        }
    }



    fn skein(s: *Session, f: F, a: []Val) Abort!?Val {
        const imp = s.p.prog orelse return vErr(vStr("skein: not a handler program"));
        return s.skeinCall(imp, f, a) catch |e| switch (e) {
            error.Failed => vErr(vStr(imp.last_error)),
            error.Fatal => {
                s.p.svc.state.fatal = imp.fatal;
                return error.Abort;
            },
            error.OutOfMemory => error.OutOfMemory,
        };
    }

    fn skeinCall(s: *Session, imp: *program.Imports, f: F, a: []Val) program.Err!Val {
        const h = imp.host;
        const A = s.alloc;
        switch (f) {
            .sk_input => return vBytes(h.input(imp)),
            .sk_get => return vOk(vBytes(try h.get(imp, try program.checkCid(imp, try listBytes(A, &a[0]))))),
            .sk_put => return vOk(vBytes(try h.put(imp, try listBytes(A, &a[0])))),
            .sk_putblock => {
                try h.putBlock(imp, try program.checkCid(imp, try listBytes(A, &a[0])), try listBytes(A, &a[1]));
                return vOk(null);
            },
            .sk_keep => {
                try h.keep(imp, try program.checkCid(imp, try listBytes(A, &a[0])));
                return vOk(null);
            },
            .sk_launch => {
                const prog = try program.checkCid(imp, try listBytes(A, &a[0]));
                const args = try program.checkCid(imp, try listBytes(A, &a[1]));
                return vOk(vBytes(try h.launch(imp, prog, args)));
            },
            .sk_await => {
                try h.awaitReply(imp, try program.checkCid(imp, try listBytes(A, &a[0])));
                return vOk(null);
            },
            .sk_head => {
                const t = try h.head(imp, try A.dupe(u8, str(&a[0])));
                return vOk(if (t) |x| vSome(vBytes(x)) else vNone());
            },
            .sk_advance => {
                const n = try A.dupe(u8, str(&a[0]));
                try h.advance(imp, n, try program.checkCid(imp, try listBytes(A, &a[1])));
                return vOk(null);
            },
            .sk_wallet => return vOk(vBytes(try h.wallet(imp, try listBytes(A, &a[0])))),
            .sk_emit => return vOk(vBytes(try h.emit(imp, try listBytes(A, &a[0])))),
            .sk_authfetch => return vOk(vBytes(try h.authfetch(imp, try listBytes(A, &a[0])))),
            .sk_deadline => {
                try h.deadline(imp, a[0].of.s64);
                return vOk(null);
            },
            .sk_call => {
                const prog = try program.checkCid(imp, try listBytes(A, &a[0]));
                const func = try A.dupe(u8, str(&a[1]));
                return vOk(vBytes(try h.call(imp, prog, func, try listBytes(A, &a[2]))));
            },
            .sk_edges => {
                const to = try program.checkCid(imp, try listBytes(A, &a[0]));
                const rel: ?[]const u8 = if (a[1].of.option) |o| try A.dupe(u8, str(o)) else null;
                return vOk(vBytes(try h.edges(imp, to, rel)));
            },
            else => unreachable,
        }
    }

};

// ---------------------------------------------------------------- engine callbacks

fn callback(data: ?*anyopaque, ctx: ?*c.wasmtime_context_t, _: ?*const c.wasmtime_component_func_type_t, args: [*c]Val, nargs: usize, results: [*c]Val, nresults: usize) callconv(.c) ?*c.wasmtime_error_t {
    const f: F = @enumFromInt(@intFromPtr(data) - 1);
    const s: *Session = @ptrCast(@alignCast(c.wasmtime_context_get_data(ctx)));
    s.ctx = ctx.?;
    if (traceOn()) std.debug.print("component: {s}\n", .{@tagName(f)});
    const r = s.call(f, args[0..nargs]) catch |e| {
        if (e == error.OutOfMemory) _ = s.fatal("out of memory") catch {};
        s.aborted = true;
        return c.wasmtime_error_new("skein: abort");
    };
    if (r) |v| {
        if (nresults > 0) results[0] = v;
    }
    return null;
}

fn destructor(data: ?*anyopaque, ctx: ?*c.wasmtime_context_t, rep: u32) callconv(.c) ?*c.wasmtime_error_t {
    _ = data;
    const s: *Session = @ptrCast(@alignCast(c.wasmtime_context_get_data(ctx)));
    s.drop(rep);
    return null;
}

/// wasmtime's trap messages (its Display for Trap) → the trap, for the V8 wording.
fn trapOf(msg: []const u8) ?engine.Trap {
    const table = [_]struct { []const u8, engine.Trap }{
        .{ "all fuel consumed", .out_of_fuel },
        .{ "call stack exhausted", .stack_overflow },
        .{ "out of bounds memory access", .memory_out_of_bounds },
        .{ "unaligned atomic", .heap_misaligned },
        .{ "out of bounds table access", .table_out_of_bounds },
        .{ "uninitialized element", .indirect_call_null },
        .{ "indirect call type mismatch", .bad_signature },
        .{ "integer overflow", .integer_overflow },
        .{ "integer divide by zero", .divide_by_zero },
        .{ "invalid conversion to integer", .bad_conversion },
        .{ "unreachable", .unreachable_code },
    };
    for (table) |t| if (std.mem.indexOf(u8, msg, t[0]) != null) return t[1];
    if (std.mem.indexOf(u8, msg, "wasm trap") != null) return .other;
    return null;
}

// ---------------------------------------------------------------- values

fn listUninit(n: usize) c.wasmtime_component_vallist_t {
    var l: c.wasmtime_component_vallist_t = undefined;
    c.wasmtime_component_vallist_new_uninit(&l, n);
    return l;
}

fn wname(s: []const u8) c.wasm_name_t {
    var n: c.wasm_name_t = undefined;
    c.wasm_byte_vec_new(&n, s.len, s.ptr);
    return n;
}

fn vStr(s: []const u8) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_STRING, .of = .{ .string = wname(s) } };
}

fn enumv(s: []const u8) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_ENUM, .of = .{ .enumeration = wname(s) } };
}

fn vBytes(b: []const u8) Val {
    const l = listUninit(b.len);
    for (b, 0..) |x, i| l.data[i] = .{ .kind = c.WASMTIME_COMPONENT_U8, .of = .{ .u8 = x } };
    return .{ .kind = c.WASMTIME_COMPONENT_LIST, .of = .{ .list = l } };
}

fn u64v(x: u64) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_U64, .of = .{ .u64 = x } };
}

fn boolean(x: bool) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_BOOL, .of = .{ .boolean = x } };
}

fn heap(v: ?Val) ?*Val {
    var x = v orelse return null;
    return c.wasmtime_component_val_new(&x);
}

fn vOk(v: ?Val) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_RESULT, .of = .{ .result = .{ .is_ok = true, .val = heap(v) } } };
}

fn vErr(v: ?Val) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_RESULT, .of = .{ .result = .{ .is_ok = false, .val = heap(v) } } };
}

fn vSome(v: Val) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_OPTION, .of = .{ .option = heap(v) } };
}

fn vNone() Val {
    return .{ .kind = c.WASMTIME_COMPONENT_OPTION, .of = .{ .option = null } };
}

fn variant(case: []const u8, v: ?Val) Val {
    return .{ .kind = c.WASMTIME_COMPONENT_VARIANT, .of = .{ .variant = .{ .discriminant = wname(case), .val = heap(v) } } };
}

fn tuple(vs: []const Val) Val {
    var t: c.wasmtime_component_valtuple_t = undefined;
    c.wasmtime_component_valtuple_new_uninit(&t, vs.len);
    for (vs, 0..) |v, i| t.data[i] = v;
    return .{ .kind = c.WASMTIME_COMPONENT_TUPLE, .of = .{ .tuple = t } };
}

fn record(fields: []const struct { []const u8, Val }) Val {
    var r: c.wasmtime_component_valrecord_t = undefined;
    c.wasmtime_component_valrecord_new_uninit(&r, fields.len);
    for (fields, 0..) |f, i| r.data[i] = .{ .name = wname(f[0]), .val = f[1] };
    return .{ .kind = c.WASMTIME_COMPONENT_RECORD, .of = .{ .record = r } };
}

fn flags(names: []const []const u8) Val {
    var fl: c.wasmtime_component_valflags_t = undefined;
    c.wasmtime_component_valflags_new_uninit(&fl, names.len);
    for (names, 0..) |n, i| fl.data[i] = wname(n);
    return .{ .kind = c.WASMTIME_COMPONENT_FLAGS, .of = .{ .flags = fl } };
}

fn datetime(ns: u64) Val {
    return record(&.{ .{ "seconds", u64v(ns / 1_000_000_000) }, .{ "nanoseconds", .{ .kind = c.WASMTIME_COMPONENT_U32, .of = .{ .u32 = @intCast(ns % 1_000_000_000) } } } });
}

fn item(l: c.wasmtime_component_vallist_t, i: usize) *const Val {
    const d: [*]Val = @ptrCast(l.data);
    return &d[i];
}

fn optStr(x: ?[]const u8) Val {
    return if (x) |v| vSome(vStr(v)) else vNone();
}

fn optU64(x: ?u64) Val {
    return if (x) |v| vSome(u64v(v)) else vNone();
}

fn str(v: *const Val) []const u8 {
    const n = v.of.string;
    if (n.size == 0) return "";
    return n.data[0..n.size];
}

/// A list<u8> argument's bytes (a copy: the values go when the call returns).
fn listBytes(alloc: std.mem.Allocator, v: *const Val) error{OutOfMemory}![]const u8 {
    const l = v.of.list;
    const out = try alloc.alloc(u8, l.size);
    for (0..l.size) |i| out[i] = l.data[i].of.u8;
    return out;
}

fn flagSet(v: *const Val, which: []const u8) i64 {
    const fl = v.of.flags;
    for (0..fl.size) |i| {
        const n = fl.data[i];
        if (n.size == which.len and std.mem.eql(u8, n.data[0..n.size], which)) return 1;
    }
    return 0;
}

fn typeName(ft: u8) []const u8 {
    return switch (ft) {
        1 => "block-device",
        2 => "character-device",
        3 => "directory",
        4 => "regular-file",
        5, 6 => "socket",
        7 => "symbolic-link",
        else => "unknown",
    };
}

/// A preview1 errno → wasi:filesystem's error-code (the preview1 adapter maps it back).
fn errorCodeName(e: u16) []const u8 {
    return switch (e) {
        2 => "access",
        6 => "would-block",
        7 => "already",
        8 => "bad-descriptor",
        10 => "busy",
        16 => "deadlock",
        19 => "quota",
        20 => "exist",
        22 => "file-too-large",
        25 => "illegal-byte-sequence",
        26 => "in-progress",
        27 => "interrupted",
        28 => "invalid",
        29 => "io",
        31 => "is-directory",
        32 => "loop",
        34 => "too-many-links",
        35 => "message-size",
        37 => "name-too-long",
        43 => "no-device",
        44 => "no-entry",
        46 => "no-lock",
        48 => "insufficient-memory",
        51 => "insufficient-space",
        54 => "not-directory",
        55 => "not-empty",
        56 => "not-recoverable",
        59 => "no-tty",
        60 => "no-such-device",
        61 => "overflow",
        63 => "not-permitted",
        64 => "pipe",
        69 => "read-only",
        70 => "invalid-seek",
        74 => "text-file-busy",
        75 => "cross-device",
        else => "unsupported", // notsup, nosys
    };
}

/// SKEIN_COMPONENT_TRACE=1: every component call and the preview1 call behind it, on stderr (debugging).
var trace_on: ?bool = null;
fn traceOn() bool {
    if (trace_on == null) trace_on = if (envm.get("SKEIN_COMPONENT_TRACE")) |v| std.mem.eql(u8, v, "1") else false;
    return trace_on.?;
}
