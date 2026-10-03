// The wasm shell (first a port of the TypeScript shell, deleted in #55): brush running uutils coreutils and the
// toolset, all over a copy-on-write view of a git-shaped tree. brush asks the
// host to run external commands through skein.spawn; each runs to completion
// as a fresh instance sharing the filesystem view.
const std = @import("std");
const wasi = @import("wasi.zig");
const vfsm = @import("vfs.zig");
const tree = @import("tree.zig");
const cidm = @import("cid");
const cbor = @import("cbor");
const Value = cbor.Value;
const runner = @import("runner.zig");
const syscalls = @import("syscalls.zig");
const Store = @import("store.zig").Store;

/// What a command needs besides its module (the record's `support`): files
/// mounted read-only at `mount` for that command only, and env defaults the
/// caller's env overrides (python's stdlib, #25).
pub const SupportFile = struct { name: []const u8, bytes: []const u8 };
pub const Support = struct {
    mount: []const u8,
    files: []const SupportFile, // path under mount → bytes
    env: []const [2][]const u8,
};

pub const Modules = struct {
    brush: *runner.Compiled,
    coreutils: *runner.Compiled,
    /// Every other command of the record's `modules` (two names may share a module: `node` is qjs).
    extra: std.StringHashMap(*runner.Compiled),
    utils: std.StringHashMap(void),
    support: std.StringHashMap(Support),
};

/// A support file from the store, checked against its CID.
fn loadFile(gpa: std.mem.Allocator, s: Store, a: std.mem.Allocator, c: []const u8, msg: *[]const u8) ![]const u8 {
    const b = (s.bytes(gpa, c) catch null) orelse {
        msg.* = try std.fmt.allocPrint(a, "shell program: file not in store: {s}", .{try cidm.format(a, c)});
        return error.NotInStore;
    };
    if (!std.mem.eql(u8, try cidm.ofRaw(a, b), c)) {
        msg.* = try std.fmt.allocPrint(a, "shell program: file {s}: bytes do not match the CID", .{try cidm.format(a, c)});
        return error.BadHash;
    }
    return b;
}

/// Loaded shells by program record CID (text).
var cached: ?std.StringHashMap(*Modules) = null;

fn bad(a: std.mem.Allocator, msg: *[]const u8, comptime f: []const u8, args: anytype) error{ BadShellProgram, OutOfMemory } {
    msg.* = try std.fmt.allocPrint(a, "shell program: " ++ f, args);
    return error.BadShellProgram;
}

/// A shell program's modules (#83: the record names them — `modules`
/// {<command>: <raw module CID>}, brush and coreutils among them, and
/// `support` {<command>: {mount, files: {<path>: <raw CID>}, env}}; the
/// shell app's install writes it from its manifest), loaded from the store,
/// and the utilities the coreutils build lists (`coreutils --list`, fixed
/// clock, zero random). Cached by the record's CID `pc`.
pub fn loadModules(r: *runner.Runner, s: Store, a: std.mem.Allocator, prog: Value, pc: []const u8, msg: *[]const u8) !*Modules {
    if (cached == null) cached = std.StringHashMap(*Modules).init(r.gpa);
    const key = try cidm.format(a, pc);
    if (cached.?.get(key)) |m| return m;
    const ms = prog.get("modules") orelse return bad(a, msg, "no modules", .{});
    if (ms != .map) return bad(a, msg, "modules is not a map", .{});
    var brush: ?*runner.Compiled = null;
    var coreutils: ?*runner.Compiled = null;
    var extra = std.StringHashMap(*runner.Compiled).init(r.gpa);
    for (ms.map) |e| {
        const c = Value.cidOf(e.value) orelse return bad(a, msg, "module {s} is not a CID", .{e.key});
        const m = try r.load(s, a, c, msg);
        if (std.mem.eql(u8, e.key, "brush")) brush = m else if (std.mem.eql(u8, e.key, "coreutils")) coreutils = m else try extra.put(try r.gpa.dupe(u8, e.key), m);
    }
    if (brush == null or coreutils == null) return bad(a, msg, "modules names no brush or no coreutils", .{});
    var support = std.StringHashMap(Support).init(r.gpa);
    if (prog.get("support")) |sm| if (sm == .map) for (sm.map) |e| {
        const mount = Value.str(e.value.get("mount")) orelse return bad(a, msg, "support {s}: no mount", .{e.key});
        var files = std.array_list.Managed(SupportFile).init(r.gpa);
        if (e.value.get("files")) |fs| if (fs == .map) for (fs.map) |f| {
            const c = Value.cidOf(f.value) orelse return bad(a, msg, "support {s}: file {s} is not a CID", .{ e.key, f.key });
            try files.append(.{ .name = try r.gpa.dupe(u8, f.key), .bytes = try loadFile(r.gpa, s, a, c, msg) });
        };
        var env = std.array_list.Managed([2][]const u8).init(r.gpa);
        if (e.value.get("env")) |es| if (es == .map) for (es.map) |kv| {
            try env.append(.{ try r.gpa.dupe(u8, kv.key), try r.gpa.dupe(u8, Value.str(kv.value) orelse return bad(a, msg, "support {s}: env {s} is not text", .{ e.key, kv.key })) });
        };
        try support.put(try r.gpa.dupe(u8, e.key), .{ .mount = try r.gpa.dupe(u8, mount), .files = files.items, .env = env.items });
    };
    const m = try r.gpa.create(Modules);
    m.* = .{ .brush = brush.?, .coreutils = coreutils.?, .extra = extra, .utils = std.StringHashMap(void).init(r.gpa), .support = support };

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
    _ = r.runModule(aa, m.coreutils, v, &.{ "coreutils", "--list" }, &.{}, stdio, &svc, null) catch {};
    var it = std.mem.tokenizeAny(u8, out.read(out.size()), " \t\n\r\x0b\x0c");
    while (it.next()) |u| try m.utils.put(try r.gpa.dupe(u8, u), {});
    try cached.?.put(try r.gpa.dupe(u8, key), m);
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
    /// shell.ts's default sleep outside a thread: the run's clock moves to the
    /// earliest deadline (QuickJS's timers wait for the clock to pass it).
    fn sleep(ctx: *anyopaque, clocks: []const wasi.Clock) wasi.Stop!void {
        const f: *Fixed = @ptrCast(@alignCast(ctx));
        var until: ?u64 = null;
        for (clocks) |c| {
            const t = if (c.absolute) c.timeout else f.ns +% c.timeout;
            if (until == null or t < until.?) until = t;
        }
        if (until) |u| if (u > f.ns) {
            f.ns = u;
        };
    }
};

/// A `#!` line's interpreter (shell.ts shebang): its basename, through `env`
/// (skipping env's options), and the arguments after it.
const Shebang = struct { name: []const u8, args: []const []const u8 };
fn shebang(a: std.mem.Allocator, data: []const u8) !?Shebang {
    const end = std.mem.indexOfScalar(u8, data, '\n');
    const line = data[2..if (end) |e| e else @min(data.len, 256)];
    var words = std.array_list.Managed([]const u8).init(a);
    var it = std.mem.tokenizeAny(u8, line, " \t\r\x0b\x0c");
    while (it.next()) |w| try words.append(w);
    var ws = words.items;
    if (ws.len == 0) return null;
    if (std.mem.eql(u8, std.fs.path.basenamePosix(ws[0]), "env")) {
        ws = ws[1..];
        while (ws.len > 0 and ws[0].len > 0 and ws[0][0] == '-') ws = ws[1..];
        if (ws.len == 0) return null;
    }
    return .{ .name = lastPart(ws[0]), .args = ws[1..] };
}
/// `prog.split("/").pop()`: the part after the last slash (empty after a trailing one).
fn lastPart(p: []const u8) []const u8 {
    const i = std.mem.lastIndexOfScalar(u8, p, '/') orelse return p;
    return p[i + 1 ..];
}

/// A read-only directory tree holding a program's support files, outside the
/// Vfs's root (shell.ts mountDir; inode numbers from the descriptor range, in the same order).
fn mountDir(a: std.mem.Allocator, v: *vfsm.Vfs, sup: *const Support) !*vfsm.Node {
    const newMap = struct {
        fn f(al: std.mem.Allocator) !*std.StringHashMap(*vfsm.Node) {
            const m = try al.create(std.StringHashMap(*vfsm.Node));
            m.* = std.StringHashMap(*vfsm.Node).init(al);
            return m;
        }
    }.f;
    const root = try a.create(vfsm.Node);
    root.* = .{ .kind = .dir, .entries = try newMap(a), .readonly = true, .ino = v.nextDescIno() };
    const sorted = try a.dupe(SupportFile, sup.files);
    std.mem.sort(SupportFile, sorted, {}, struct {
        fn lt(_: void, x: SupportFile, y: SupportFile) bool {
            return std.mem.lessThan(u8, x.name, y.name);
        }
    }.lt);
    for (sorted) |f| {
        var parts = std.array_list.Managed([]const u8).init(a);
        var it = std.mem.tokenizeScalar(u8, f.name, '/');
        while (it.next()) |x| try parts.append(x);
        const name = parts.pop().?;
        var dir = root;
        for (parts.items) |p| {
            const next = dir.entries.?.get(p) orelse blk: {
                const d = try a.create(vfsm.Node);
                d.* = .{ .kind = .dir, .entries = try newMap(a), .readonly = true, .ino = v.nextDescIno(), .parent = dir, .name = p };
                try dir.entries.?.put(p, d);
                break :blk d;
            };
            dir = next;
        }
        const bytes = f.bytes;
        const node = try a.create(vfsm.Node);
        node.* = .{ .kind = .file, .data = @constCast(bytes), .cap = bytes.len, .ino = v.nextDescIno(), .parent = dir, .name = name };
        try dir.entries.?.put(name, node);
    }
    return root;
}

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
        var name: ?[]const u8 = null;
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
                name = req.program;
                try args.append(req.program);
            } else return .not_found;
        } else {
            // A path in the tree: a `#!` script. Its interpreter runs it when that
            // is an extra program (`#!/usr/bin/env python3`); anything else runs
            // under the shell. Nothing else is executable.
            const path = if (req.program[0] == '/') req.program else try std.fmt.allocPrint(a, "{s}/{s}", .{ req.cwd, req.program });
            const node = run.v.resolve(run.v.root, path, true) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return .not_found, // .catch(() => undefined)
            };
            var data: ?[]const u8 = null;
            if (node.kind == .file) {
                const d = run.v.content(node) catch |err| switch (err) {
                    error.Errno => return .{ .errno = run.v.errno }, // NotFound → EIO, through guardAsync
                    error.Fatal => return error.Fatal,
                    error.OutOfMemory => return error.OutOfMemory,
                };
                if (d.len >= 2 and d[0] == '#' and d[1] == '!') data = d;
            }
            if (data == null) {
                const argv0 = if (req.argv.len > 0) req.argv[0] else "undefined";
                wasi.writeTo(req.stdio[2], try std.fmt.allocPrint(a, "{s}: cannot execute: only #! scripts run from the tree\n", .{argv0}));
                return .{ .code = 126 };
            }
            const interp = try shebang(a, data.?);
            if (interp != null and !isShell(interp.?.name) and run.mods.extra.contains(interp.?.name)) {
                name = interp.?.name;
                file = run.mods.extra.get(interp.?.name).?;
                try args.append(interp.?.name);
                try args.appendSlice(interp.?.args);
                try args.append(req.program);
            } else {
                file = run.mods.brush;
                try args.appendSlice(&.{ "bash", "--disable-color", req.program });
            }
        }
        try args.appendSlice(rest);
        const sup = if (name) |n| run.mods.support.getPtr(n) else null;
        if (sup == null) return .{ .code = try run.r.runModule(a, file, run.v, args.items, env.items, req.stdio, &run.svc, null) };
        // Environment defaults the caller's env overrides; the support files mounted for this process only.
        for (sup.?.env) |kv| {
            var has = false;
            for (env.items) |e| if (e.len > kv[0].len and std.mem.startsWith(u8, e, kv[0]) and e[kv[0].len] == '=') {
                has = true;
            };
            if (!has) try env.append(try std.fmt.allocPrint(a, "{s}={s}", .{ kv[0], kv[1] }));
        }
        const mounts = try a.alloc(wasi.Mount, 1);
        mounts[0] = .{ .path = sup.?.mount, .dir = try mountDir(a, run.v, sup.?) };
        var svc = run.svc;
        svc.mounts = mounts;
        return .{ .code = try run.r.runModule(a, file, run.v, args.items, env.items, req.stdio, &svc, null) };
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
    } else .{ .ctx = &fixed, .state = st, .clock = Fixed.clock, .random = Fixed.random, .sleep = Fixed.sleep };
    // spawn and exists need the Run; the thread's callbacks their own ctx: route through a trampoline.
    var tramp = Trampoline{ .run = &runc, .inner = runc.svc };
    runc.svc = .{
        .ctx = &tramp,
        .state = st,
        .clock = Trampoline.clock,
        .random = Trampoline.random,
        .sleep = Trampoline.sleep,
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
