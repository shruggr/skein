// wasi_snapshot_preview1 over a Vfs, for one process (one wasm instance),
// plus the `skein` imports the patched brush uses (cmd_exists, pipe, spawn)
// and, for handler programs, the skein syscalls (program.zig). A port of
// src/runtime/wasi/host.ts; host-go/wasi.go was the first port and proved the
// method. Nothing here touches the host: the filesystem is the tree, stdio are
// in-memory pipes, clock/random/sleep/spawn come from the run.
const std = @import("std");
const engine = @import("engine.zig");
const vfsm = @import("vfs.zig");
const json = @import("json.zig");
const program = @import("program.zig");
const Vfs = vfsm.Vfs;
const Node = vfsm.Node;
const E = vfsm.E;

// ---------------------------------------------------------------- pipes and descriptions

/// A byte queue between processes. Processes run one at a time, so an empty pipe reads as end of file.
pub const Pipe = struct {
    buf: std.array_list.Managed(u8),
    head: usize = 0,
    limit: usize,

    pub fn init(alloc: std.mem.Allocator, limit: usize, initial: []const u8) !*Pipe {
        const p = try alloc.create(Pipe);
        p.* = .{ .buf = std.array_list.Managed(u8).init(alloc), .limit = limit };
        if (initial.len > 0) _ = try p.write(initial);
        return p;
    }
    pub fn size(p: *const Pipe) usize {
        return p.buf.items.len - p.head;
    }
    /// All of b, or nothing if that would pass the limit.
    pub fn write(p: *Pipe, b: []const u8) !bool {
        if (p.size() + b.len > p.limit) return false;
        if (p.head > 0 and p.head >= p.buf.items.len / 2) {
            const n = p.size();
            std.mem.copyForwards(u8, p.buf.items[0..n], p.buf.items[p.head..]);
            p.buf.shrinkRetainingCapacity(n);
            p.head = 0;
        }
        try p.buf.appendSlice(b);
        return true;
    }
    pub fn read(p: *Pipe, max: usize) []const u8 {
        const n = @min(max, p.size());
        const s = p.buf.items[p.head .. p.head + n];
        p.head += n;
        return s;
    }
    pub fn drain(p: *Pipe, alloc: std.mem.Allocator) ![]u8 {
        return alloc.dupe(u8, p.read(p.size()));
    }
};

pub const DescKind = enum { file, dir, pipe, null };

/// An open file description; fds of parent and child share them.
pub const Desc = struct {
    t: DescKind,
    ino: u64,
    node: ?*Node = null,
    pos: usize = 0,
    append: bool = false,
    read: bool = false,
    write: bool = false,
    preopen: ?[]const u8 = null,
    pipe: ?*Pipe = null,
    /// pipe: the write end
    wend: bool = false,
};

pub fn nullDesc(alloc: std.mem.Allocator, v: *Vfs) !*Desc {
    const d = try alloc.create(Desc);
    d.* = .{ .t = .null, .ino = v.nextDescIno() };
    return d;
}

pub fn pipeDesc(alloc: std.mem.Allocator, v: *Vfs, p: *Pipe, write_end: bool) !*Desc {
    const d = try alloc.create(Desc);
    d.* = .{ .t = .pipe, .pipe = p, .wend = write_end, .ino = v.nextDescIno() };
    return d;
}

const FT_UNKNOWN: u8 = 0;
const FT_CHAR: u8 = 2;
const FT_DIR: u8 = 3;
const FT_FILE: u8 = 4;
const FT_LINK: u8 = 7;
const O_CREAT = 1;
const O_DIRECTORY = 2;
const O_EXCL = 4;
const O_TRUNC = 8;
const FDFLAG_APPEND = 1;
const RIGHT_READ: u64 = 1 << 1;
const RIGHT_WRITE: u64 = 1 << 6;
const ALL_RIGHTS: u64 = (1 << 30) - 1;

// ---------------------------------------------------------------- the run's services

pub const SpawnRequest = struct { program: []const u8, cwd: []const u8, argv: []const []const u8, env: []const []const u8, stdio: [3]*Desc };
pub const Clock = struct { timeout: u64, absolute: bool };
/// A child's exit code, no such program (ENOENT), or an errno for the caller (a missing record: EIO).
pub const SpawnResult = union(enum) { code: i32, not_found, errno: u16 };

/// What a run provides its processes: the scheduler's clock/random/sleep, the shell's spawn.
pub const RunState = struct {
    fatal: ?Fatal = null,
    parked: bool = false,
    /// The step's fuel budget, shared by every instance of the run (issue #5); null: unmetered.
    meter: ?*engine.Meter = null,
};

pub const Services = struct {
    ctx: *anyopaque,
    /// Shared by every process of a run: why it is being unwound.
    state: *RunState,
    clock: *const fn (ctx: *anyopaque, id: u32) u64,
    random: *const fn (ctx: *anyopaque, out: []u8) void,
    /// A sleep (poll_oneoff on clocks only). null: returns at once.
    sleep: ?*const fn (ctx: *anyopaque, clocks: []const Clock) Stop!void = null,
    spawn: ?*const fn (ctx: *anyopaque, parent: *Process, req: SpawnRequest) Stop!SpawnResult = null,
    exists: ?*const fn (ctx: *anyopaque, name: []const u8) bool = null,
    /// Read-only directories outside the tree, preopened at fd 4… under the
    /// given absolute paths (host.ts `mounts`): a program's support files,
    /// e.g. python's stdlib zip. Per process: the shell passes a copy of its
    /// services with these set for the programs that have support.
    mounts: []const Mount = &.{},
};

pub const Mount = struct { path: []const u8, dir: *Node };

/// Why a process is being unwound, beyond its own exit: recorded on the process.
pub const Stop = error{
    /// A host error that is not the program's business: ends the whole run (a JS throw).
    Fatal,
    /// A sleeping shell thread rests here: the run is abandoned and re-executed on wake.
    Park,
    OutOfMemory,
};

pub const Fatal = struct {
    /// fuel: the step's budget ran out (issue #5), recorded as `fuel exhausted`.
    kind: enum { plain, diverged, no_witness, fuel } = .plain,
    message: []const u8,
};

// ---------------------------------------------------------------- the import table

pub const Fn = enum {
    unknown,
    // wasi_snapshot_preview1
    args_sizes_get,
    args_get,
    environ_sizes_get,
    environ_get,
    clock_res_get,
    clock_time_get,
    random_get,
    proc_exit,
    proc_raise,
    sched_yield,
    poll_oneoff,
    fd_write,
    fd_read,
    fd_pread,
    fd_pwrite,
    fd_seek,
    fd_tell,
    fd_close,
    fd_fdstat_get,
    fd_fdstat_set_flags,
    fd_fdstat_set_rights,
    fd_prestat_get,
    fd_prestat_dir_name,
    fd_filestat_get,
    fd_filestat_set_size,
    fd_filestat_set_times,
    fd_advise,
    fd_allocate,
    fd_datasync,
    fd_sync,
    fd_renumber,
    fd_readdir,
    path_open,
    path_filestat_get,
    path_filestat_set_times,
    path_create_directory,
    path_remove_directory,
    path_unlink_file,
    path_rename,
    path_symlink,
    path_readlink,
    path_link,
    sock_accept,
    sock_recv,
    sock_send,
    sock_shutdown,
    // skein, the shell's
    cmd_exists,
    pipe,
    spawn,
    // skein, a handler program's (program.zig)
    input,
    get,
    put,
    putblock,
    keep,
    launch,
    @"await",
    head,
    advance,
    subscribe,
    wallet,
    http,
    deadline,
    call,
    take,
    @"error",
};

const wasi_first = @intFromEnum(Fn.args_sizes_get);
const wasi_last = @intFromEnum(Fn.sock_shutdown);
const shell_first = @intFromEnum(Fn.cmd_exists);
const shell_last = @intFromEnum(Fn.spawn);
const prog_first = @intFromEnum(Fn.input);

/// The function an import binds to, for a process that is (or is not) a handler program.
pub fn bind(module: []const u8, name: []const u8, is_program: bool) Fn {
    const f = std.meta.stringToEnum(Fn, name) orelse return .unknown;
    const i = @intFromEnum(f);
    if (std.mem.eql(u8, module, "wasi_snapshot_preview1")) return if (i >= wasi_first and i <= wasi_last) f else .unknown;
    if (std.mem.eql(u8, module, "skein")) {
        if (i >= shell_first and i <= shell_last) return f;
        if (i >= prog_first and is_program) return f;
    }
    return .unknown;
}

// ---------------------------------------------------------------- the process

pub const Process = struct {
    alloc: std.mem.Allocator,
    vfs: *Vfs,
    args: []const []const u8,
    env: []const []const u8,
    fds: std.AutoHashMap(i32, *Desc),
    svc: *const Services,
    /// A handler program's skein syscalls; null for the shell's processes.
    prog: ?*program.Imports = null,
    bindings: []const Fn = &.{},
    mem: []u8 = &.{},
    exit_code: ?i32 = null,

    pub fn init(alloc: std.mem.Allocator, v: *Vfs, args: []const []const u8, env: []const []const u8, stdio: [3]*Desc, svc: *const Services) !*Process {
        const p = try alloc.create(Process);
        p.* = .{ .alloc = alloc, .vfs = v, .args = args, .env = env, .fds = std.AutoHashMap(i32, *Desc).init(alloc), .svc = svc };
        for (stdio, 0..) |d, i| try p.fds.put(@intCast(i), d);
        const root = try alloc.create(Desc);
        root.* = .{ .t = .dir, .node = v.root, .preopen = "/", .ino = v.root.ino };
        try p.fds.put(3, root);
        for (svc.mounts, 0..) |m, i| {
            const d = try alloc.create(Desc);
            d.* = .{ .t = .dir, .node = m.dir, .preopen = m.path, .ino = m.dir.ino };
            try p.fds.put(@intCast(4 + i), d);
        }
        return p;
    }

    pub fn fail(p: *Process, msg: []const u8) Stop {
        if (p.svc.state.fatal == null) p.svc.state.fatal = .{ .message = msg };
        return error.Fatal;
    }

    fn add(p: *Process, d: *Desc) !i32 {
        var fd: i32 = 3;
        while (p.fds.contains(fd)) fd += 1;
        try p.fds.put(fd, d);
        return fd;
    }

    fn desc(p: *Process, fd: i64) FsE!*Desc {
        return p.fds.get(@truncate(fd)) orelse p.errno(E.BADF);
    }

    fn dirDesc(p: *Process, fd: i64) FsE!*Node {
        const d = try p.desc(fd);
        if (d.t != .dir) return p.errno(if (d.t == .file) E.NOTDIR else E.BADF);
        return d.node.?;
    }

    // -------------------------------------------------- memory (bounds as V8's views have them)

    fn range(p: *Process, ptr: i64, n: usize) Stop![]u8 {
        const start: u64 = @as(u32, @truncate(@as(u64, @bitCast(ptr))));
        if (start + n > p.mem.len) return p.fail("Offset is outside the bounds of the DataView");
        engine.touch(p.mem, @intCast(start), n);
        return p.mem[@intCast(start)..@intCast(start + n)];
    }
    pub fn setU8(p: *Process, ptr: i64, v: u8) Stop!void {
        (try p.range(ptr, 1))[0] = v;
    }
    pub fn setU16(p: *Process, ptr: i64, v: u16) Stop!void {
        std.mem.writeInt(u16, (try p.range(ptr, 2))[0..2], v, .little);
    }
    pub fn setU32(p: *Process, ptr: i64, v: u32) Stop!void {
        std.mem.writeInt(u32, (try p.range(ptr, 4))[0..4], v, .little);
    }
    pub fn setU64(p: *Process, ptr: i64, v: u64) Stop!void {
        std.mem.writeInt(u64, (try p.range(ptr, 8))[0..8], v, .little);
    }
    fn getU8(p: *Process, ptr: i64) Stop!u8 {
        return (try p.range(ptr, 1))[0];
    }
    fn getU16(p: *Process, ptr: i64) Stop!u16 {
        return std.mem.readInt(u16, (try p.range(ptr, 2))[0..2], .little);
    }
    fn getU32(p: *Process, ptr: i64) Stop!u32 {
        return std.mem.readInt(u32, (try p.range(ptr, 4))[0..4], .little);
    }
    fn getU64(p: *Process, ptr: i64) Stop!u64 {
        return std.mem.readInt(u64, (try p.range(ptr, 8))[0..8], .little);
    }
    /// Uint8Array.slice(ptr, ptr+n): clamped to memory, copied.
    pub fn slice(p: *Process, ptr: i64, n: i64) ![]u8 {
        const start: usize = @min(@as(u32, @truncate(@as(u64, @bitCast(ptr)))), p.mem.len);
        const end: usize = @min(start + @as(usize, @as(u32, @truncate(@as(u64, @bitCast(n))))), p.mem.len);
        engine.touch(p.mem, start, end - start);
        return p.alloc.dupe(u8, p.mem[start..end]);
    }
    /// Uint8Array.set(bytes, ptr): all of it or a RangeError.
    pub fn set(p: *Process, ptr: i64, bytes: []const u8) Stop!void {
        const start: u64 = @as(u32, @truncate(@as(u64, @bitCast(ptr))));
        if (start + bytes.len > p.mem.len) return p.fail("offset is out of bounds");
        engine.touch(p.mem, @intCast(start), bytes.len);
        @memcpy(p.mem[@intCast(start)..@intCast(start + bytes.len)], bytes);
    }
    pub fn str(p: *Process, ptr: i64, n: i64) ![]u8 {
        return p.slice(ptr, n);
    }

    // -------------------------------------------------- dispatch

    pub const FsE = error{ Errno, Fatal, Park, OutOfMemory };

    fn errno(p: *Process, e: u16) FsE {
        p.vfs.errno = e;
        return error.Errno;
    }

    /// The engine's host callback.
    pub fn call(ctx: *anyopaque, index: usize, a: []const i64, mem: []u8) engine.Ret {
        const p: *Process = @ptrCast(@alignCast(ctx));
        p.mem = mem;
        const f = if (index < p.bindings.len) p.bindings[index] else .unknown;
        const st = p.svc.state;
        const r = p.dispatch(f, a) catch |err| switch (err) {
            error.Errno => return .{ .value = p.vfs.errno },
            error.Park => {
                st.parked = true;
                return .abort;
            },
            error.Exit => return .abort,
            error.Fatal => {
                if (st.fatal == null) st.fatal = .{ .message = p.vfs.fatal_msg };
                return .abort;
            },
            else => {
                if (st.fatal == null) st.fatal = .{ .message = @errorName(err) };
                return .abort;
            },
        };
        return .{ .value = r };
    }

    /// One preview1 call against `p.mem` (the engine callback, or component.zig over a scratch memory).
    pub fn dispatch(p: *Process, f: Fn, a: []const i64) !i64 {
        return switch (f) {
            .unknown => E.NOSYS,
            .args_sizes_get => p.sizes(p.args, a[0], a[1]),
            .args_get => p.strings(p.args, a[0], a[1]),
            .environ_sizes_get => p.sizes(p.env, a[0], a[1]),
            .environ_get => p.strings(p.env, a[0], a[1]),
            .clock_res_get => blk: {
                try p.setU64(a[1], 1);
                break :blk 0;
            },
            .clock_time_get => blk: {
                const t = p.svc.clock(p.svc.ctx, @truncate(@as(u64, @bitCast(a[0]))));
                try p.setU64(a[2], t);
                break :blk 0;
            },
            .random_get => blk: {
                const n: usize = @as(u32, @truncate(@as(u64, @bitCast(a[1]))));
                const buf = try p.alloc.alloc(u8, n);
                p.svc.random(p.svc.ctx, buf);
                try p.set(a[0], buf);
                break :blk 0;
            },
            .proc_exit => {
                p.exit_code = @truncate(a[0]);
                return error.Exit;
            },
            .proc_raise => E.NOSYS,
            .sched_yield => 0,
            .poll_oneoff => p.pollOneoff(a[0], a[1], a[2], a[3]),
            .fd_write => p.fdWrite(a[0], a[1], a[2], a[3]),
            .fd_read => p.fdRead(a[0], a[1], a[2], a[3], null),
            .fd_pread => p.fdRead(a[0], a[1], a[2], a[4], a[3]),
            .fd_pwrite => E.NOTSUP,
            .fd_seek => p.fdSeek(a[0], a[1], a[2], a[3]),
            .fd_tell => p.fdSeek(a[0], 0, 1, a[1]),
            .fd_close => if (p.fds.remove(@truncate(a[0]))) 0 else E.BADF,
            .fd_fdstat_get => p.fdstat(a[0], a[1]),
            .fd_fdstat_set_flags => blk: {
                const d = try p.desc(a[0]);
                if (d.t == .file) d.append = (a[1] & FDFLAG_APPEND) != 0;
                break :blk 0;
            },
            .fd_fdstat_set_rights => 0,
            .fd_prestat_get => blk: {
                const d = p.fds.get(@truncate(a[0])) orelse break :blk E.BADF;
                if (d.t != .dir or d.preopen == null) break :blk E.BADF;
                try p.setU8(a[1], 0);
                try p.setU32(a[1] + 4, @intCast(d.preopen.?.len));
                break :blk 0;
            },
            .fd_prestat_dir_name => blk: {
                const d = p.fds.get(@truncate(a[0])) orelse break :blk E.BADF;
                if (d.t != .dir or d.preopen == null) break :blk E.BADF;
                const pre = d.preopen.?;
                try p.set(a[1], pre[0..@min(pre.len, @as(u32, @truncate(@as(u64, @bitCast(a[2])))))]);
                break :blk 0;
            },
            .fd_filestat_set_size => blk: {
                const d = try p.desc(a[0]);
                if (d.t != .file or !d.write or d.node.?.kind == .object) break :blk E.BADF;
                _ = try p.vfs.setSize(d.node.?, @intCast(@as(u64, @bitCast(a[1]))));
                p.vfs.dirty(d.node.?);
                break :blk 0;
            },
            .fd_filestat_set_times, .fd_advise, .fd_allocate, .fd_datasync, .fd_sync, .path_filestat_set_times => 0,
            .fd_renumber => blk: {
                const d = try p.desc(a[0]);
                try p.fds.put(@truncate(a[1]), d);
                _ = p.fds.remove(@truncate(a[0]));
                break :blk 0;
            },
            .sock_accept, .sock_recv, .sock_send, .sock_shutdown => E.NOTSUP,
            .fd_filestat_get => p.fdFilestat(a[0], a[1]),
            .fd_readdir => p.fdReaddir(a[0], a[1], a[2], a[3], a[4]),
            .path_open => p.pathOpen(a[0], a[1], try p.str(a[2], a[3]), a[4], @bitCast(a[5]), a[7], a[8]),
            .path_filestat_get => p.pathFilestat(a[0], a[1], try p.str(a[2], a[3]), a[4]),
            .path_create_directory => p.mkdir(a[0], try p.str(a[1], a[2])),
            .path_remove_directory => p.rmdir(a[0], try p.str(a[1], a[2])),
            .path_unlink_file => p.unlinkFile(a[0], try p.str(a[1], a[2])),
            .path_rename => p.rename(a[0], try p.str(a[1], a[2]), a[3], try p.str(a[4], a[5])),
            .path_symlink => p.symlink(try p.slice(a[0], a[1]), a[2], try p.str(a[3], a[4])),
            .path_readlink => p.readlink(a[0], try p.str(a[1], a[2]), a[3], a[4], a[5]),
            .path_link => p.hardlink(a[0], try p.str(a[2], a[3]), a[4], try p.str(a[5], a[6])),
            .cmd_exists => blk: {
                const name = try p.str(a[0], a[1]);
                const f2 = p.svc.exists orelse break :blk 0;
                break :blk if (f2(p.svc.ctx, name)) 1 else 0;
            },
            .pipe => blk: {
                const pipe = try Pipe.init(p.alloc, 64 << 20, "");
                const r = try p.add(try pipeDesc(p.alloc, p.vfs, pipe, false));
                const w = try p.add(try pipeDesc(p.alloc, p.vfs, pipe, true));
                try p.setU32(a[0], @intCast(r));
                try p.setU32(a[0] + 4, @intCast(w));
                break :blk 0;
            },
            .spawn => p.spawn(a[0], a[1], a[2..5], a[5]),
            else => {
                const imp = p.prog orelse return E.NOSYS;
                return imp.call(p, f, a);
            },
        };
    }

    // -------------------------------------------------- args, env

    fn sizes(p: *Process, list: []const []const u8, count: i64, size: i64) !i64 {
        var n: usize = 0;
        for (list) |s| n += s.len + 1;
        try p.setU32(count, @intCast(list.len));
        try p.setU32(size, @intCast(n));
        return 0;
    }

    fn strings(p: *Process, list: []const []const u8, ptrs: i64, buf0: i64) !i64 {
        var buf = buf0;
        for (list, 0..) |s, i| {
            try p.setU32(ptrs + @as(i64, @intCast(i)) * 4, @truncate(@as(u64, @bitCast(buf))));
            try p.set(buf, s);
            try p.set(buf + @as(i64, @intCast(s.len)), &.{0});
            buf += @intCast(s.len + 1);
        }
        return 0;
    }

    // -------------------------------------------------- fd io

    fn iovs(p: *Process, ptr: i64, n: i64) ![][2]i64 {
        const count: usize = @as(u32, @truncate(@as(u64, @bitCast(n))));
        const out = try p.alloc.alloc([2]i64, count);
        for (out, 0..) |*o, i| {
            const at = ptr + @as(i64, @intCast(i)) * 8;
            o.* = .{ try p.getU32(at), try p.getU32(at + 4) };
        }
        return out;
    }

    fn fdWrite(p: *Process, fd: i64, iov: i64, n: i64, nw: i64) !i64 {
        const d = try p.desc(fd);
        const list = try p.iovs(iov, n);
        var bufs = try p.alloc.alloc([]u8, list.len);
        var total: usize = 0;
        for (list, 0..) |io, i| {
            bufs[i] = try p.slice(io[0], io[1]);
            total += bufs[i].len;
        }
        switch (d.t) {
            .null => {},
            .pipe => {
                if (!d.wend) return E.BADF;
                for (bufs) |b| if (!try d.pipe.?.write(b)) return E.PIPE;
            },
            .file => {
                if (!d.write) return E.BADF;
                const node = d.node.?;
                if (node.kind == .object) return E.BADF; // renamed into a loose object while open
                const len = node.data.?.len;
                const at = if (d.append) len else d.pos;
                const next = try p.vfs.setSize(node, @max(len, at + total));
                var off = at;
                for (bufs) |b| {
                    @memcpy(next[off .. off + b.len], b);
                    off += b.len;
                }
                p.vfs.dirty(node);
                d.pos = off;
            },
            .dir => return E.BADF,
        }
        try p.setU32(nw, @intCast(total));
        return 0;
    }

    fn fdRead(p: *Process, fd: i64, iov: i64, n: i64, nr: i64, at: ?i64) !i64 {
        const d = try p.desc(fd);
        var got: usize = 0;
        for (try p.iovs(iov, n)) |io| {
            const l: usize = @intCast(io[1]);
            var chunk: []const u8 = &.{};
            switch (d.t) {
                .null => {},
                .pipe => {
                    if (d.wend) return E.BADF;
                    chunk = d.pipe.?.read(l);
                },
                .file => {
                    if (!d.read) return E.BADF;
                    const data = d.node.?.data.?;
                    const pos: usize = if (at) |x| @as(usize, @intCast(@as(u64, @bitCast(x)))) + got else d.pos;
                    if (pos < data.len) chunk = data[pos..@min(data.len, pos + l)];
                    if (at == null) d.pos += chunk.len;
                },
                .dir => return E.ISDIR,
            }
            try p.set(io[0], chunk);
            got += chunk.len;
            if (chunk.len < l) break;
        }
        try p.setU32(nr, @intCast(got));
        return 0;
    }

    fn fdSeek(p: *Process, fd: i64, off: i64, whence: i64, out: i64) !i64 {
        const d = try p.desc(fd);
        if (d.t != .file) return if (d.t == .dir) E.BADF else E.SPIPE;
        const w: u8 = @truncate(@as(u64, @bitCast(whence)));
        const base: i64 = if (w == 0) 0 else if (w == 1) @intCast(d.pos) else @intCast(d.node.?.data.?.len);
        const pos = base + off;
        if (pos < 0) return E.INVAL;
        d.pos = @intCast(pos);
        try p.setU64(out, @intCast(pos));
        return 0;
    }

    fn fdstat(p: *Process, fd: i64, buf: i64) !i64 {
        const d = try p.desc(fd);
        const ft: u8 = switch (d.t) {
            .file => FT_FILE,
            .dir => FT_DIR,
            .null => FT_CHAR,
            .pipe => FT_UNKNOWN,
        };
        try p.setU8(buf, ft);
        try p.setU16(buf + 2, if (d.t == .file and d.append) FDFLAG_APPEND else 0);
        try p.setU64(buf + 8, ALL_RIGHTS);
        try p.setU64(buf + 16, ALL_RIGHTS);
        return 0;
    }

    /// Git records no times, so every file reads as the epoch.
    fn writeStat(p: *Process, buf: i64, ino: u64, ft: u8, size: usize) !void {
        try p.setU64(buf, 1);
        try p.setU64(buf + 8, ino);
        try p.setU8(buf + 16, ft);
        try p.setU64(buf + 24, 1);
        try p.setU64(buf + 32, size);
        try p.setU64(buf + 40, 0);
        try p.setU64(buf + 48, 0);
        try p.setU64(buf + 56, 0);
    }

    fn fdFilestat(p: *Process, fd: i64, buf: i64) !i64 {
        const d = try p.desc(fd);
        switch (d.t) {
            .file => try p.writeStat(buf, d.ino, FT_FILE, d.node.?.data.?.len),
            .dir => try p.writeStat(buf, d.ino, FT_DIR, 0),
            .null => try p.writeStat(buf, d.ino, FT_CHAR, 0),
            .pipe => try p.writeStat(buf, d.ino, FT_UNKNOWN, d.pipe.?.size()),
        }
        return 0;
    }

    const Ent = struct { name: []const u8, ino: u64, ft: u8 };

    fn entLess(_: void, a: Ent, b: Ent) bool {
        return json.utf16Order(a.name, b.name) == .lt;
    }

    fn fdReaddir(p: *Process, fd: i64, buf: i64, len_: i64, cookie: i64, used: i64) !i64 {
        const dir = try p.dirDesc(fd);
        const m = try p.vfs.entries(dir);
        var names = std.array_list.Managed(Ent).init(p.alloc);
        var it = m.iterator();
        while (it.next()) |kv| {
            const n = kv.value_ptr.*;
            try names.append(.{ .name = kv.key_ptr.*, .ino = n.ino, .ft = switch (n.kind) {
                .file, .object => FT_FILE,
                .link => FT_LINK,
                else => FT_DIR,
            } });
        }
        std.mem.sort(Ent, names.items, {}, entLess);
        var list = std.array_list.Managed(Ent).init(p.alloc);
        try list.append(.{ .name = ".", .ino = dir.ino, .ft = FT_DIR });
        try list.append(.{ .name = "..", .ino = (dir.parent orelse dir).ino, .ft = FT_DIR });
        try list.appendSlice(names.items);
        const len: usize = @as(u32, @truncate(@as(u64, @bitCast(len_))));
        var out = std.array_list.Managed(u8).init(p.alloc);
        var i: u64 = @bitCast(cookie);
        while (i < list.items.len and out.items.len < len) : (i += 1) {
            const e = list.items[@intCast(i)];
            var h: [24]u8 = [_]u8{0} ** 24;
            std.mem.writeInt(u64, h[0..8], i + 1, .little);
            std.mem.writeInt(u64, h[8..16], e.ino, .little);
            std.mem.writeInt(u32, h[16..20], @intCast(e.name.len), .little);
            h[20] = e.ft;
            try out.appendSlice(&h);
            try out.appendSlice(e.name);
        }
        const all = out.items[0..@min(out.items.len, len)]; // a truncated last entry tells libc to retry bigger
        try p.set(buf, all);
        try p.setU32(used, @intCast(all.len));
        return 0;
    }

    // -------------------------------------------------- paths

    fn pathOpen(p: *Process, dirfd: i64, dirflags: i64, path: []const u8, oflags: i64, rights: u64, fdflags: i64, out: i64) anyerror!i64 {
        const v = p.vfs;
        const base = try p.dirDesc(dirfd);
        if (try p.device(base, path)) |dev| {
            try p.setU32(out, @intCast(try p.add(dev)));
            return 0;
        }
        const follow = (dirflags & 1) != 0;
        const want_write = (rights & RIGHT_WRITE) != 0 or (oflags & O_TRUNC) != 0;
        const par = try v.resolveParent(base, path);
        const dir = par.dir;
        const name = par.name;
        var node: ?*Node = null;
        if (name.len == 0 or std.mem.eql(u8, name, ".")) {
            node = dir;
        } else if (std.mem.eql(u8, name, "..")) {
            node = dir.parent orelse dir;
        } else {
            node = (try v.entries(dir)).get(name);
            if (node != null and node.?.kind == .link and follow) {
                if (v.resolve(dir, name, true)) |t| {
                    node = t;
                } else |err| {
                    // A dangling symlink with O_CREAT creates its target, as on unix.
                    if (!(err == error.Errno and v.errno == E.NOENT and (oflags & O_CREAT) != 0)) return err;
                    const t = try v.content(node.?);
                    const np = if (t.len > 0 and t[0] == '/') t else try std.fmt.allocPrint(p.alloc, "{s}/{s}", .{ try v.pathOf(dir), t });
                    return p.pathOpen(dirfd, dirflags, np, oflags, rights, fdflags, out);
                }
            }
        }
        if (node != null and (oflags & O_CREAT) != 0 and (oflags & O_EXCL) != 0) return E.EXIST;
        if (node == null) {
            if ((oflags & O_CREAT) == 0) return E.NOENT;
            if ((oflags & O_DIRECTORY) != 0) return E.INVAL;
            try v.checkName(name);
            if (dir.readonly) return E.ROFS;
            node = try v.newFile(dir, "", false);
            try v.link(dir, name, node.?);
        }
        const n = node.?;
        if (n.kind == .link) return E.LOOP;
        if (n.kind == .dir or n.kind == .module) {
            if (want_write) return E.ISDIR;
            // TS: a module opened directly hands out the module node itself (reads fail with EIO).
            const d = try p.alloc.create(Desc);
            d.* = .{ .t = .dir, .node = n, .ino = n.ino };
            try p.setU32(out, @intCast(try p.add(d)));
            return 0;
        }
        if ((oflags & O_DIRECTORY) != 0) return E.NOTDIR;
        if (n.kind == .object and want_write) return E.ACCES; // a loose object is 0444, as git makes it
        if (want_write and n.parent != null and n.parent.?.readonly) return E.ROFS; // a mount (host.ts)
        _ = try v.content(n);
        if ((oflags & O_TRUNC) != 0 and n.data.?.len > 0) {
            n.data = n.data.?[0..0];
            v.dirty(n);
        }
        const d = try p.alloc.create(Desc);
        d.* = .{
            .t = .file,
            .node = n,
            .ino = n.ino,
            .append = (fdflags & FDFLAG_APPEND) != 0,
            .read = (rights & RIGHT_READ) != 0 or !want_write,
            .write = want_write,
        };
        try p.setU32(out, @intCast(try p.add(d)));
        return 0;
    }

    /// /dev/null and /dev/std{in,out,err} exist whatever the tree holds (unless it has its own /dev, among entries already loaded).
    fn device(p: *Process, base: *Node, path: []const u8) !?*Desc {
        const root = p.vfs.root;
        if (base != root and !(path.len > 0 and path[0] == '/')) return null;
        var parts = std.array_list.Managed(u8).init(p.alloc);
        var it = std.mem.splitScalar(u8, path, '/');
        while (it.next()) |x| {
            if (x.len == 0 or std.mem.eql(u8, x, ".")) continue;
            if (parts.items.len > 0) try parts.append('/');
            try parts.appendSlice(x);
        }
        const s = parts.items;
        if (!std.mem.startsWith(u8, s, "dev/")) return null;
        if (root.entries) |m| if (m.contains("dev")) return null;
        if (std.mem.eql(u8, s, "dev/null")) return try nullDesc(p.alloc, p.vfs);
        if (std.mem.eql(u8, s, "dev/stdin")) return p.fds.get(0);
        if (std.mem.eql(u8, s, "dev/stdout")) return p.fds.get(1);
        if (std.mem.eql(u8, s, "dev/stderr")) return p.fds.get(2);
        return null;
    }

    fn pathFilestat(p: *Process, fd: i64, flags: i64, path: []const u8, buf: i64) !i64 {
        if (try p.device(try p.dirDesc(fd), path)) |dev| {
            try p.writeStat(buf, dev.ino, FT_CHAR, 0);
            return 0;
        }
        const n = try p.vfs.resolve(try p.dirDesc(fd), path, (flags & 1) != 0);
        switch (n.kind) {
            .dir, .module => try p.writeStat(buf, n.ino, FT_DIR, 0),
            .file, .object => try p.writeStat(buf, n.ino, FT_FILE, (try p.vfs.content(n)).len),
            .link => try p.writeStat(buf, n.ino, FT_LINK, (try p.vfs.content(n)).len),
        }
        return 0;
    }

    fn isDotName(name: []const u8) bool {
        return name.len == 0 or std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..");
    }

    fn mkdir(p: *Process, fd: i64, path: []const u8) !i64 {
        const v = p.vfs;
        const par = try v.resolveParent(try p.dirDesc(fd), path);
        if (isDotName(par.name)) return E.EXIST;
        if ((try v.entries(par.dir)).contains(par.name)) return E.EXIST;
        if (par.dir.readonly) return E.ROFS;
        try v.link(par.dir, par.name, try v.newDir(par.dir));
        return 0;
    }

    fn rmdir(p: *Process, fd: i64, path: []const u8) !i64 {
        const v = p.vfs;
        const par = try v.resolveParent(try p.dirDesc(fd), path);
        if (isDotName(par.name)) return E.INVAL;
        const n = (try v.entries(par.dir)).get(par.name) orelse return E.NOENT;
        if (n.kind != .dir and n.kind != .module) return E.NOTDIR;
        if (n.kind == .dir and (try v.entries(n)).count() > 0) return E.NOTEMPTY;
        try v.unlink(par.dir, par.name);
        return 0;
    }

    fn unlinkFile(p: *Process, fd: i64, path: []const u8) !i64 {
        const v = p.vfs;
        const par = try v.resolveParent(try p.dirDesc(fd), path);
        if (isDotName(par.name)) return E.ISDIR;
        const n = (try v.entries(par.dir)).get(par.name) orelse return E.NOENT;
        if (n.kind == .dir or n.kind == .module) return E.ISDIR;
        try v.unlink(par.dir, par.name);
        return 0;
    }

    fn rename(p: *Process, fd: i64, from: []const u8, fd2: i64, to: []const u8) !i64 {
        const v = p.vfs;
        const a = try v.resolveParent(try p.dirDesc(fd), from);
        const b = try v.resolveParent(try p.dirDesc(fd2), to);
        if (isDotName(a.name) or isDotName(b.name)) return E.INVAL;
        const src = (try v.entries(a.dir)).get(a.name) orelse return E.NOENT;
        const dst = (try v.entries(b.dir)).get(b.name);
        if (dst == src) return 0;
        if (b.dir.readonly) return E.ROFS;
        if (src.kind == .dir) {
            var x: ?*Node = b.dir;
            while (x) |y| : (x = y.parent) if (y == src) return E.INVAL; // into itself
            if (dst != null and dst.?.kind != .dir) return E.NOTDIR;
            if (dst != null and dst.?.kind == .dir and (try v.entries(dst.?)).count() > 0) return E.NOTEMPTY;
        } else if (dst != null and dst.?.kind == .dir) return E.ISDIR;
        try v.checkName(b.name);
        try v.admit(b.dir, b.name, src); // a loose object's bytes are checked before anything moves
        try v.unlink(a.dir, a.name);
        try v.link(b.dir, b.name, src);
        return 0;
    }

    fn symlink(p: *Process, target: []u8, fd: i64, path: []const u8) !i64 {
        const v = p.vfs;
        const par = try v.resolveParent(try p.dirDesc(fd), path);
        if ((try v.entries(par.dir)).contains(par.name)) return E.EXIST;
        if (par.dir.readonly) return E.ROFS;
        try v.checkName(par.name);
        try v.link(par.dir, par.name, try v.newLink(par.dir, target));
        return 0;
    }

    fn readlink(p: *Process, fd: i64, path: []const u8, buf: i64, len: i64, used: i64) !i64 {
        const n = try p.vfs.resolve(try p.dirDesc(fd), path, false);
        if (n.kind != .link) return E.INVAL;
        const t = try p.vfs.content(n);
        const cut = t[0..@min(t.len, @as(u32, @truncate(@as(u64, @bitCast(len)))))];
        try p.set(buf, cut);
        try p.setU32(used, @intCast(cut.len));
        return 0;
    }

    /// Git has no hard links: a link is a copy that shares nothing afterwards.
    fn hardlink(p: *Process, fd: i64, from: []const u8, fd2: i64, to: []const u8) !i64 {
        const v = p.vfs;
        const src = try v.resolve(try p.dirDesc(fd), from, false);
        if (src.kind != .file and src.kind != .object) return E.PERM;
        const par = try v.resolveParent(try p.dirDesc(fd2), to);
        if ((try v.entries(par.dir)).contains(par.name)) return E.EXIST;
        if (par.dir.readonly) return E.ROFS;
        try v.checkName(par.name);
        try v.link(par.dir, par.name, try v.newFile(par.dir, try v.content(src), src.exec));
        return 0;
    }

    // -------------------------------------------------- time

    fn pollOneoff(p: *Process, in: i64, out: i64, n_: i64, nout: i64) !i64 {
        const n: usize = @as(u32, @truncate(@as(u64, @bitCast(n_))));
        var clocks = std.array_list.Managed(Clock).init(p.alloc);
        var fds = false;
        for (0..n) |i| {
            const s = in + @as(i64, @intCast(i)) * 48;
            if (try p.getU8(s + 8) == 0) {
                try clocks.append(.{ .timeout = try p.getU64(s + 24), .absolute = (try p.getU16(s + 40)) & 1 != 0 });
            } else fds = true;
        }
        if (clocks.items.len > 0 and !fds) {
            if (p.svc.sleep) |sleep| try sleep(p.svc.ctx, clocks.items);
        }
        for (0..n) |i| {
            const s = in + @as(i64, @intCast(i)) * 48;
            const e = out + @as(i64, @intCast(i)) * 32;
            const tag = try p.getU8(s + 8);
            try p.setU64(e, try p.getU64(s));
            try p.setU16(e + 8, 0);
            try p.setU8(e + 10, tag);
            var bytes: u64 = 0;
            if (tag == 1) {
                if (p.fds.get(@bitCast(try p.getU32(s + 16)))) |d| {
                    if (d.t == .pipe) bytes = d.pipe.?.size() else if (d.t == .file) bytes = d.node.?.data.?.len -| d.pos;
                }
            }
            try p.setU64(e + 16, bytes);
            try p.setU16(e + 24, 0);
        }
        try p.setU32(nout, @intCast(n));
        return 0;
    }

    // -------------------------------------------------- spawn

    fn spawn(p: *Process, req: i64, len: i64, stdio: []const i64, code: i64) !i64 {
        const f = p.svc.spawn orelse return E.NOSYS;
        const raw = try p.str(req, len);
        var fields = std.array_list.Managed([]const u8).init(p.alloc);
        var it = std.mem.splitScalar(u8, raw, 0);
        while (it.next()) |x| try fields.append(x);
        var i: usize = 0;
        const next = struct {
            fn f2(fs: []const []const u8, idx: *usize) []const u8 {
                if (idx.* >= fs.len) return "";
                idx.* += 1;
                return fs[idx.* - 1];
            }
        }.f2;
        const prog = next(fields.items, &i);
        const cwd = next(fields.items, &i);
        const argc = std.fmt.parseInt(usize, next(fields.items, &i), 10) catch 0;
        const argv = fields.items[@min(i, fields.items.len)..@min(i + argc, fields.items.len)];
        i += argc;
        const envc = std.fmt.parseInt(usize, next(fields.items, &i), 10) catch 0;
        const env = fields.items[@min(i, fields.items.len)..@min(i + envc, fields.items.len)];
        var descs: [3]*Desc = undefined;
        for (0..3) |k| {
            const fd: i32 = @truncate(stdio[k]);
            descs[k] = if (fd < 0) try nullDesc(p.alloc, p.vfs) else p.fds.get(fd) orelse try nullDesc(p.alloc, p.vfs);
        }
        switch (try f(p.svc.ctx, p, .{ .program = prog, .cwd = cwd, .argv = argv, .env = env, .stdio = descs })) {
            .not_found => return E.NOENT,
            .errno => |e| return e,
            .code => |r| {
                try p.setU32(code, @bitCast(r));
                return 0;
            },
        }
    }
};

/// Write a diagnostic to a descriptor if it is a pipe's write end (shell.ts writeTo).
pub fn writeTo(d: *Desc, s: []const u8) void {
    if (d.t == .pipe and d.wend) _ = d.pipe.?.write(s) catch {};
}
