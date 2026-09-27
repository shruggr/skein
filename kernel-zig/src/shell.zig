// The wasm shell (src/runtime/shell.ts): brush running uutils coreutils and the
// toolset, all over a copy-on-write view of a git-shaped tree. brush asks the
// host to run external commands through skein.spawn; each runs to completion
// as a fresh instance sharing the filesystem view.
const std = @import("std");
const wasi = @import("wasi.zig");
const vfsm = @import("vfs.zig");
const tree = @import("tree.zig");
const cidm = @import("cid.zig");
const programs = @import("programs.zig");
const runner = @import("runner.zig");
const syscalls = @import("syscalls.zig");
const Store = @import("store.zig").Store;

pub const Modules = struct {
    brush: *runner.Compiled,
    coreutils: *runner.Compiled,
    extra: std.StringHashMap(*runner.Compiled),
    utils: std.StringHashMap(void),
};

var cached: ?*Modules = null;

/// The shell's modules from the store (programs.ts loadShellModules), and the
/// utilities the coreutils build lists (`coreutils --list`, fixed clock, zero random).
pub fn loadModules(r: *runner.Runner, s: Store, a: std.mem.Allocator, msg: *[]const u8) !*Modules {
    if (cached) |m| return m;
    const brush = try r.load(s, a, try programs.moduleCid(a, "brush"), msg);
    const coreutils = try r.load(s, a, try programs.moduleCid(a, "coreutils"), msg);
    var extra = std.StringHashMap(*runner.Compiled).init(r.gpa);
    for (programs.tool_names) |t| try extra.put(t, try r.load(s, a, try programs.moduleCid(a, t), msg));
    const m = try r.gpa.create(Modules);
    m.* = .{ .brush = brush, .coreutils = coreutils, .extra = extra, .utils = std.StringHashMap(void).init(r.gpa) };

    var arena = std.heap.ArenaAllocator.init(r.gpa);
    defer arena.deinit();
    const aa = arena.allocator();
    const empty = (try tree.hashTree(aa, &.{})).cid;
    const v = try vfsm.Vfs.init(aa, null, empty);
    const out = try wasi.Pipe.init(aa, 64 << 20, "");
    var st = wasi.RunState{};
    var fixed = Fixed{ .ns = 0, .zero = true };
    var svc = wasi.Services{ .ctx = &fixed, .state = &st, .clock = Fixed.clock, .random = Fixed.random };
    const stdio = [3]*wasi.Desc{ try wasi.nullDesc(aa, v), try wasi.pipeDesc(aa, v, out, true), try wasi.nullDesc(aa, v) };
    _ = r.runModule(aa, coreutils, v, &.{ "coreutils", "--list" }, &.{}, stdio, &svc, null) catch {};
    var it = std.mem.tokenizeAny(u8, out.read(out.size()), " \t\n\r\x0b\x0c");
    while (it.next()) |u| try m.utils.put(try r.gpa.dupe(u8, u), {});
    cached = m;
    return m;
}

const shells = [_][]const u8{ "sh", "bash", "brush" };
fn isShell(n: []const u8) bool {
    for (shells) |s| if (std.mem.eql(u8, s, n)) return true;
    return false;
}

/// A run outside a thread: every clock reads one value, random is splitmix32 (or zeros).
pub const Fixed = struct {
    ns: u64,
    mix: syscalls.SplitMix = .{ .s = 0 },
    zero: bool = false,
    fn clock(ctx: *anyopaque, _: u32) u64 {
        const f: *Fixed = @ptrCast(@alignCast(ctx));
        return f.ns;
    }
    fn random(ctx: *anyopaque, out: []u8) void {
        const f: *Fixed = @ptrCast(@alignCast(ctx));
        if (f.zero) @memset(out, 0) else f.mix.fill(out);
    }
};

/// Where a thread's clock, random and sleeps come from; null: runShell's defaults (time/seed).
pub const Thread = struct {
    ctx: *anyopaque,
    clock: *const fn (ctx: *anyopaque, id: u32) u64,
    random: *const fn (ctx: *anyopaque, out: []u8) void,
    sleep: *const fn (ctx: *anyopaque, clocks: []const wasi.Clock) wasi.Stop!void,
};

pub const Options = struct {
    tree: []const u8,
    cmd: []const u8,
    cwd: ?[]const u8 = null,
    /// KEY=VALUE overrides, applied over the defaults in order.
    env: []const [2][]const u8 = &.{},
    stdin: []const u8 = "",
    time_ms: i64 = 0,
    seed: u32 = 0,
    limit: usize = 64 << 20,
    thread: ?Thread = null,
};

pub const Result = struct { exit_code: i32, stdout: []u8, stderr: []u8, tree: []const u8 };

pub const Error = error{ Fatal, Park, OutOfMemory, CwdNotDir };

const Run = struct {
    r: *runner.Runner,
    mods: *Modules,
    v: *vfsm.Vfs,
    svc: wasi.Services,
    alloc: std.mem.Allocator,

    fn exists(ctx: *anyopaque, name: []const u8) bool {
        const run: *Run = @ptrCast(@alignCast(ctx));
        return isShell(name) or std.mem.eql(u8, name, "coreutils") or run.mods.utils.contains(name) or run.mods.extra.contains(name);
    }

    fn spawn(ctx: *anyopaque, parent: *wasi.Process, req: wasi.SpawnRequest) wasi.Stop!wasi.SpawnResult {
        _ = parent;
        const run: *Run = @ptrCast(@alignCast(ctx));
        const a = run.alloc;
        var env = std.array_list.Managed([]const u8).init(a);
        for (req.env) |e| if (!std.mem.startsWith(u8, e, "PWD=")) try env.append(e);
        try env.append(try std.fmt.allocPrint(a, "PWD={s}", .{if (req.cwd.len == 0) "/" else req.cwd}));
        var args = std.array_list.Managed([]const u8).init(a);
        const rest = if (req.argv.len > 0) req.argv[1..] else req.argv;
        var file: *runner.Compiled = undefined;
        if (std.mem.indexOfScalar(u8, req.program, '/') == null) {
            if (isShell(req.program)) {
                file = run.mods.brush;
                try args.appendSlice(&.{ "bash", "--disable-color" });
            } else if (std.mem.eql(u8, req.program, "coreutils")) {
                file = run.mods.coreutils;
                try args.append("coreutils");
            } else if (run.mods.utils.contains(req.program)) {
                file = run.mods.coreutils;
                try args.append(req.program);
            } else if (run.mods.extra.get(req.program)) |m| {
                file = m;
                try args.append(req.program);
            } else return .not_found;
        } else {
            // A path in the tree: scripts run under the shell; nothing else is executable.
            const path = if (req.program[0] == '/') req.program else try std.fmt.allocPrint(a, "{s}/{s}", .{ req.cwd, req.program });
            const node = run.v.resolve(run.v.root, path, true) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return .not_found, // .catch(() => undefined)
            };
            var ok = false;
            if (node.kind == .file) {
                const d = run.v.content(node) catch |err| switch (err) {
                    error.Errno => return .{ .errno = run.v.errno }, // NotFound → EIO, through guardAsync
                    error.Fatal => return error.Fatal,
                    error.OutOfMemory => return error.OutOfMemory,
                };
                ok = d.len >= 2 and d[0] == '#' and d[1] == '!';
            }
            if (!ok) {
                const argv0 = if (req.argv.len > 0) req.argv[0] else "undefined";
                wasi.writeTo(req.stdio[2], try std.fmt.allocPrint(a, "{s}: cannot execute: only shell scripts run from the tree\n", .{argv0}));
                return .{ .code = 126 };
            }
            file = run.mods.brush;
            try args.appendSlice(&.{ "bash", "--disable-color", req.program });
        }
        try args.appendSlice(rest);
        return .{ .code = try run.r.runModule(a, file, run.v, args.items, env.items, req.stdio, &run.svc, null) };
    }
};

/// JavaScript object-spread env: defaults, then overrides in order (a key keeps
/// its first position), then PWD last.
fn mergeEnv(a: std.mem.Allocator, over: []const [2][]const u8, pwd: []const u8) ![]const []const u8 {
    var keys = std.array_list.Managed([]const u8).init(a);
    var vals = std.array_list.Managed([]const u8).init(a);
    const defaults = [_][2][]const u8{ .{ "HOME", "/" }, .{ "PATH", "/usr/local/bin:/usr/bin:/bin" }, .{ "LANG", "C.UTF-8" }, .{ "USER", "skein" } };
    const all = [_][]const [2][]const u8{ &defaults, over, &.{.{ "PWD", pwd }} };
    for (all) |list| for (list) |kv| {
        var found = false;
        for (keys.items, 0..) |k, i| if (std.mem.eql(u8, k, kv[0])) {
            vals.items[i] = kv[1];
            found = true;
        };
        if (!found) {
            try keys.append(kv[0]);
            try vals.append(kv[1]);
        }
    };
    const out = try a.alloc([]const u8, keys.items.len);
    for (keys.items, vals.items, 0..) |k, v, i| out[i] = try std.fmt.allocPrint(a, "{s}={s}", .{ k, v });
    return out;
}

/// Run a command line over a tree. New objects go to the store.
pub fn runShell(a: std.mem.Allocator, r: *runner.Runner, s: Store, mods: *Modules, o: Options, st: *wasi.RunState, cwd_msg: *[]const u8) Error!Result {
    const v = try vfsm.Vfs.init(a, s, o.tree);
    var cwd_parts = std.array_list.Managed(u8).init(a);
    try cwd_parts.append('/');
    var it = std.mem.tokenizeScalar(u8, o.cwd orelse "/", '/');
    var first = true;
    while (it.next()) |p| {
        if (!first) try cwd_parts.append('/');
        try cwd_parts.appendSlice(p);
        first = false;
    }
    const cwd = cwd_parts.items;
    const at: ?*vfsm.Node = v.resolve(v.root, cwd, true) catch |err| switch (err) {
        error.Errno => null,
        error.Fatal => {
            st.fatal = .{ .message = v.fatal_msg };
            return error.Fatal;
        },
        error.OutOfMemory => return error.OutOfMemory,
    };
    if (at == null or at.?.kind != .dir) {
        cwd_msg.* = try std.fmt.allocPrint(a, "cwd is not a directory in the tree: {s}", .{cwd});
        return error.CwdNotDir;
    }

    const stdout = try wasi.Pipe.init(a, o.limit, "");
    const stderr = try wasi.Pipe.init(a, o.limit, "");
    const stdin = try wasi.Pipe.init(a, @max(o.limit, o.stdin.len), o.stdin);
    var fixed = Fixed{ .ns = @intCast(o.time_ms * 1_000_000), .mix = .{ .s = o.seed } };
    var runc = Run{ .r = r, .mods = mods, .v = v, .alloc = a, .svc = undefined };
    runc.svc = if (o.thread) |t| .{
        .ctx = t.ctx,
        .state = st,
        .clock = t.clock,
        .random = t.random,
        .sleep = t.sleep,
    } else .{ .ctx = &fixed, .state = st, .clock = Fixed.clock, .random = Fixed.random };
    // spawn and exists need the Run; the thread's callbacks their own ctx: route through a trampoline.
    var tramp = Trampoline{ .run = &runc, .inner = runc.svc };
    runc.svc = .{
        .ctx = &tramp,
        .state = st,
        .clock = Trampoline.clock,
        .random = Trampoline.random,
        .sleep = if (o.thread != null) Trampoline.sleep else null,
        .spawn = Trampoline.spawn,
        .exists = Trampoline.exists,
    };
    const env = try mergeEnv(a, o.env, cwd);
    const stdio = [3]*wasi.Desc{ try wasi.pipeDesc(a, v, stdin, false), try wasi.pipeDesc(a, v, stdout, true), try wasi.pipeDesc(a, v, stderr, true) };
    const code = r.runModule(a, mods.brush, v, &.{ "bash", "--disable-color", "-c", o.cmd }, env, stdio, &runc.svc, null) catch |err| switch (err) {
        error.Fatal => return error.Fatal,
        error.Park => return error.Park,
        error.OutOfMemory => return error.OutOfMemory,
    };
    const root = v.commit() catch |err| {
        st.fatal = .{ .message = @errorName(err) };
        return error.Fatal;
    };
    return .{ .exit_code = code, .stdout = try stdout.drain(a), .stderr = try stderr.drain(a), .tree = root };
}

const Trampoline = struct {
    run: *Run,
    inner: wasi.Services,
    fn self(ctx: *anyopaque) *Trampoline {
        return @ptrCast(@alignCast(ctx));
    }
    fn clock(ctx: *anyopaque, id: u32) u64 {
        const t = self(ctx);
        return t.inner.clock(t.inner.ctx, id);
    }
    fn random(ctx: *anyopaque, out: []u8) void {
        const t = self(ctx);
        t.inner.random(t.inner.ctx, out);
    }
    fn sleep(ctx: *anyopaque, clocks: []const wasi.Clock) wasi.Stop!void {
        const t = self(ctx);
        return t.inner.sleep.?(t.inner.ctx, clocks);
    }
    fn spawn(ctx: *anyopaque, parent: *wasi.Process, req: wasi.SpawnRequest) wasi.Stop!wasi.SpawnResult {
        return Run.spawn(self(ctx).run, parent, req);
    }
    fn exists(ctx: *anyopaque, name: []const u8) bool {
        return Run.exists(self(ctx).run, name);
    }
};
