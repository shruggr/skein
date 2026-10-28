// `skein-kernel host` (#158): one kernel process for the whole host. It holds
// every instance of the host, each a set of one RocksDB database (#96,
// rocksdb_store.zig), and runs them on a pool of worker threads; the router
// (src/host/kernel.ts KernelHost) speaks to it over stdin/stdout in the frames
// `serve` speaks (ipc.zig; serve.zig is one instance per process and stays),
// each instance-scoped frame tagged with its handle, `h`.
//
// Threads:
//   - the I/O thread (main): reads stdin (and the host-read socket), writes
//     nothing a worker writes without the output lock, owns the signals. It
//     never runs a step or a call. A frame with `h` goes to that instance's
//     inbox (a `call` to the read queue) and the instance becomes runnable; an
//     answer (`re`) to a kernel request wakes the worker waiting on it; the
//     host-level ops it serves itself: `open {h, v: {domain, db}}`, `close
//     {h}`, `instances`, `stop`, and the host's reads `get`/`has` (a CID; no
//     `h`) and `state {h}` (the set's committed state pointer). A read naming
//     `set` answers through that set's member gate (what the instance holds:
//     a client planning an install sends only the blocks it lacks); without
//     one, from every block of the database. `members {set}` lists the CIDs a
//     set holds (a checkpoint's extras).
//   - workers (SKEIN_WORKERS, default the CPU count): take a runnable instance
//     off the run queue, run its inbox to empty (each frame as serve's
//     handleOp does: `admit` steps the runtime there and then), put it down. An
//     instance is on one worker at a time (`running`, under the queue lock):
//     a frame for a running instance waits in its inbox. A `call` (#40) runs on
//     any worker against the set as committed (rocksdb_store.zig View), never
//     the instance's working state, so a read runs beside its instance's step.
//   - the kernel's own requests (`wallet`, `http`): the worker writes the
//     request frame (tagged `h`) and waits for the I/O thread to hand it the
//     answer (`Requests`). No nesting: the I/O thread serves the host's other
//     frames meanwhile, and this instance's wait in its inbox.
//   - `answer` waits (#66): per instance, answered from the step's
//     `on_answer`; their bounds kept by the I/O thread's poll timeout, which
//     queues an `expire` for the instance whose bound came.
//
// The host-read socket (`<db dir>/kernel.sock`): the same ungated reads
// (`get`, `has`, `state`) for the host's synchronous store reader
// (src/host/stores.ts: the router's reads and the CLI's, which is another
// process); nothing else is served there. Its own thread: a reader the router
// blocks on is answered even while a worker waits to write a frame the
// router has not read yet.
//
// Shutdown: `stop`, SIGTERM/SIGINT or stdin's EOF: nothing new is taken, the
// items running finish (at EOF a step waiting on the host gets PeerGone),
// every instance is stopped and its store closed, the database flushed and
// closed, exit 0.
const std = @import("std");
const envm = @import("env.zig");
const cbor = @import("cbor");
const cidm = @import("cid");
const ipc = @import("ipc.zig");
const logm = @import("log.zig");
const dispatchm = @import("dispatch.zig");
const programsm = @import("programs.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const replay = @import("replay.zig");
const authfetch = @import("authfetch.zig");
const storem = @import("store.zig");
const rocks = @import("rocksdb_store.zig");
const any = @import("any_store.zig");
const host_chain = @import("host_chain.zig");
const AnyStore = any.AnyStore;
const Value = cbor.Value;
const Io = std.Io;

var sig_pipe: [2]std.posix.fd_t = .{ -1, -1 };
var sig_name: []const u8 = "";

fn onSignal(sig: std.posix.SIG) callconv(.c) void {
    sig_name = if (sig == .INT) "SIGINT" else "SIGTERM";
    _ = std.posix.system.write(sig_pipe[1], "x", 1);
}

var g_io: Io = undefined;

var say_mu: Io.Mutex = .init;

/// A whole line on stderr: workers write at once, and a line is never split between them.
fn sayRaw(line: []const u8) void {
    var buf: [8192]u8 = undefined;
    const n = @min(line.len, buf.len - 1);
    @memcpy(buf[0..n], line[0..n]);
    buf[n] = '\n';
    say_mu.lockUncancelable(g_io);
    defer say_mu.unlock(g_io);
    Io.File.stderr().writeStreamingAll(g_io, buf[0 .. n + 1]) catch {};
}

fn nowMs() i64 {
    return @intCast(Io.Clock.real.now(g_io).toMilliseconds());
}

// ------------------------------------------------------------------ the kernel's requests

/// The kernel's requests to the host (`wallet`, `http`) waiting for their answers: a worker
/// registers one, writes the frame, and waits; the I/O thread delivers the answer frame.
pub const Requests = struct {
    gpa: std.mem.Allocator,
    io: Io,
    mu: Io.Mutex = .init,
    cond: Io.Condition = .init,
    next: i64 = 1,
    gone: bool = false,
    /// id → the answer frame's bytes once delivered (gpa-owned), null while waited on.
    slots: std.AutoHashMapUnmanaged(i64, ?[]u8) = .empty,

    pub fn init(gpa: std.mem.Allocator, io: Io) Requests {
        return .{ .gpa = gpa, .io = io };
    }

    pub fn deinit(r: *Requests) void {
        var it = r.slots.valueIterator();
        while (it.next()) |v| if (v.*) |b| r.gpa.free(b);
        r.slots.deinit(r.gpa);
    }

    /// A new request's id, waited on from now.
    pub fn register(r: *Requests) !i64 {
        r.mu.lockUncancelable(r.io);
        defer r.mu.unlock(r.io);
        const id = r.next;
        r.next += 1;
        try r.slots.put(r.gpa, id, null);
        return id;
    }

    /// The answer to `id` (taking `bytes`); false (and `bytes` freed) if no one waits on it.
    pub fn deliver(r: *Requests, id: i64, bytes: []u8) bool {
        r.mu.lockUncancelable(r.io);
        defer r.mu.unlock(r.io);
        const slot = r.slots.getPtr(id) orelse {
            r.gpa.free(bytes);
            return false;
        };
        if (slot.*) |old| r.gpa.free(old);
        slot.* = bytes;
        r.cond.broadcast(r.io);
        return true;
    }

    /// Block until `id` is answered: its frame's bytes (the caller frees them with the gpa).
    pub fn wait(r: *Requests, id: i64) ![]u8 {
        r.mu.lockUncancelable(r.io);
        defer r.mu.unlock(r.io);
        while (true) {
            const slot = r.slots.get(id) orelse return error.PeerGone;
            if (slot) |b| {
                _ = r.slots.remove(id);
                return b;
            }
            if (r.gone) {
                _ = r.slots.remove(id);
                return error.PeerGone;
            }
            r.cond.waitUncancelable(r.io, &r.mu);
        }
    }

    /// The host is gone: every wait ends with PeerGone.
    pub fn failAll(r: *Requests) void {
        r.mu.lockUncancelable(r.io);
        defer r.mu.unlock(r.io);
        r.gone = true;
        r.cond.broadcast(r.io);
    }
};

// ------------------------------------------------------------------ the run queue

/// One queued frame of an instance's (its bytes, gpa-owned), or its bound came (`expire`).
const Item = struct { bytes: ?[]u8 };

/// The run queue (#158): runnable instances and the read queue's calls, taken by the workers. An
/// instance is queued at most once and runs on one worker at a time; a frame for a running
/// instance waits in its inbox, and the worker that holds it drains that before putting it down.
/// Generic over the instance type: `T` has `inbox: std.ArrayListUnmanaged(Item)`, `queued: bool`,
/// `running: bool`, `refs: usize` (reads in flight), all under the queue's lock.
pub fn RunQueue(comptime T: type, comptime R: type) type {
    return struct {
        const Q = @This();
        gpa: std.mem.Allocator,
        io: Io,
        mu: Io.Mutex = .init,
        cond: Io.Condition = .init,
        /// Signalled when an instance's reads in flight drop to none (a close waits for that).
        refs_cond: Io.Condition = .init,
        ready: std.ArrayListUnmanaged(*T) = .empty,
        reads: std.ArrayListUnmanaged(R) = .empty,
        quit: bool = false,
        /// Workers holding an item.
        active: usize = 0,

        pub fn init(gpa: std.mem.Allocator, io: Io) Q {
            return .{ .gpa = gpa, .io = io };
        }

        pub fn deinit(q: *Q) void {
            q.ready.deinit(q.gpa);
            q.reads.deinit(q.gpa);
        }

        pub fn lock(q: *Q) void {
            q.mu.lockUncancelable(q.io);
        }
        pub fn unlock(q: *Q) void {
            q.mu.unlock(q.io);
        }

        /// Under the lock: `item` into `t`'s inbox; `t` runnable unless running or queued.
        pub fn pushLocked(q: *Q, t: *T, item: Item) !void {
            try t.inbox.append(q.gpa, item);
            if (!t.running and !t.queued) {
                t.queued = true;
                try q.ready.append(q.gpa, t);
                q.cond.signal(q.io);
            }
        }

        pub fn push(q: *Q, t: *T, item: Item) !void {
            q.lock();
            defer q.unlock();
            try q.pushLocked(t, item);
        }

        /// Under the lock: a read for any worker.
        pub fn pushReadLocked(q: *Q, r: R) !void {
            try q.reads.append(q.gpa, r);
            q.cond.signal(q.io);
        }

        pub const Work = union(enum) { inst: *T, read: R, quit };

        /// Block until there is work (a read first), or the queue is quitting. A taken instance is
        /// `running` until `next` finds its inbox empty.
        pub fn take(q: *Q) Work {
            q.lock();
            defer q.unlock();
            while (true) {
                if (q.quit) return .quit;
                if (q.reads.items.len > 0) {
                    q.active += 1;
                    return .{ .read = q.reads.orderedRemove(0) };
                }
                if (q.ready.items.len > 0) {
                    const t = q.ready.orderedRemove(0);
                    t.queued = false;
                    t.running = true;
                    q.active += 1;
                    return .{ .inst = t };
                }
                q.cond.waitUncancelable(q.io, &q.mu);
            }
        }

        /// The next frame of a running instance's inbox; null: its inbox is empty (or the queue
        /// quits) and it is put down — not running, and not touched by this worker again.
        pub fn next(q: *Q, t: *T) ?Item {
            q.lock();
            defer q.unlock();
            if (q.quit or t.inbox.items.len == 0) {
                t.running = false;
                q.active -= 1;
                q.cond.broadcast(q.io);
                return null;
            }
            return t.inbox.orderedRemove(0);
        }

        /// A read is done.
        pub fn readDone(q: *Q, t: *T) void {
            q.lock();
            defer q.unlock();
            q.active -= 1;
            t.refs -= 1;
            if (t.refs == 0) q.refs_cond.broadcast(q.io);
            q.cond.broadcast(q.io);
        }

        /// An instance being freed by its worker: that worker is no longer active.
        pub fn dropped(q: *Q) void {
            q.lock();
            defer q.unlock();
            q.active -= 1;
            q.cond.broadcast(q.io);
        }

        pub fn stop(q: *Q) void {
            q.lock();
            defer q.unlock();
            q.quit = true;
            q.cond.broadcast(q.io);
        }
    };
}

// ------------------------------------------------------------------ an instance

const Waiter = struct { id: i64, entry: []u8, until: i64 };

const Inst = struct {
    host: *Host,
    handle: []u8,
    domain: []u8 = "",
    spec: []u8 = "",
    // Under the queue's lock:
    state: enum { opening, open, closing } = .opening,
    inbox: std.ArrayListUnmanaged(Item) = .empty,
    queued: bool = false,
    running: bool = false,
    refs: usize = 0,
    expire_queued: bool = false,
    // The worker holding the instance's:
    store: ?*rocks.RocksStore = null,
    rt: ?*scheduler.Runtime = null,
    idle_waiters: std.ArrayListUnmanaged(i64) = .empty,
    // Under `wmu` (the worker adds and answers them; the I/O thread reads the bounds):
    wmu: Io.Mutex = .init,
    waiters: std.ArrayListUnmanaged(Waiter) = .empty,

    fn earliest(t: *Inst) ?i64 {
        const io = t.host.io;
        t.wmu.lockUncancelable(io);
        defer t.wmu.unlock(io);
        var until: ?i64 = null;
        for (t.waiters.items) |w| until = if (until) |u| @min(u, w.until) else w.until;
        return until;
    }
};

const Read = struct { inst: *Inst, bytes: []u8 };
const Queue = RunQueue(Inst, Read);

// ------------------------------------------------------------------ the process

const Host = struct {
    gpa: std.mem.Allocator,
    io: Io,
    db: *rocks.Db,
    dir: []const u8,
    runner: *runner.Runner,
    out_mu: Io.Mutex = .init,
    q: Queue,
    /// handle → instance; under the queue's lock.
    insts: std.StringHashMapUnmanaged(*Inst) = .empty,
    reqs: Requests,
    /// Written by a worker that adds an `answer` waiter: the I/O thread's poll takes its bound.
    wake_fd: std.posix.fd_t = -1,
    /// The host chain (#156): its tracker over the set `host/chain`, and the frames for it
    /// (`headers`, `chain-import`) run in order on their own thread, off the I/O thread.
    hc: host_chain.HostChain = undefined,
    chain_set: ?*rocks.RocksStore = null,
    cq_mu: Io.Mutex = .init,
    cq_cond: Io.Condition = .init,
    cq: std.ArrayListUnmanaged([]u8) = .empty,
    cq_quit: bool = false,

    fn wakeIo(h: *Host) void {
        if (h.wake_fd >= 0) _ = std.posix.system.write(h.wake_fd, "w", 1);
    }

    // ------------------------------------------------ output

    fn send(h: *Host, v: Value) void {
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        h.out_mu.lockUncancelable(h.io);
        defer h.out_mu.unlock(h.io);
        ipc.write(h.io, Io.File.stdout(), arena.allocator(), v) catch |err| std.log.err("peer write: {s}", .{@errorName(err)});
    }

    fn reply(h: *Host, a: std.mem.Allocator, handle: ?[]const u8, id: i64, ok: ?Value, err: ?[]const u8, rejected: ?[]const u8) void {
        var m = cbor.MapBuilder.init(a);
        m.put("re", cbor.int(id)) catch return;
        if (handle) |x| m.put("h", cbor.string(x)) catch return;
        if (ok) |v| m.put("ok", v) catch return else if (err == null and rejected == null) m.put("ok", .null) catch return;
        m.put("error", cbor.optStr(err)) catch return;
        m.put("rejected", cbor.optStr(rejected)) catch return;
        h.send(m.value());
    }

    fn notify(h: *Host, a: std.mem.Allocator, handle: ?[]const u8, op: []const u8, payload: ?Value) void {
        var m = cbor.MapBuilder.init(a);
        m.put("op", cbor.string(op)) catch return;
        if (handle) |x| m.put("h", cbor.string(x)) catch return;
        m.put("v", payload) catch return;
        h.send(m.value());
    }

    /// A line of an instance's: on stderr, `@<handle> <line>` (KernelHost routes it to that instance's log).
    fn sayFor(h: *Host, handle: []const u8, line: []const u8) void {
        var buf = std.array_list.Managed(u8).init(h.gpa);
        defer buf.deinit();
        buf.print("@{s} {s}", .{ handle, line }) catch return;
        sayRaw(buf.items);
    }

    // ------------------------------------------------ the I/O thread's frames

    fn onFrame(h: *Host, a: std.mem.Allocator, bytes: []const u8) !void {
        const f = cbor.decode(a, bytes) catch return;
        if (Value.intOf(f.get("re"))) |re| {
            _ = h.reqs.deliver(@intCast(re), try h.gpa.dupe(u8, bytes));
            return;
        }
        const op = Value.str(f.get("op")) orelse return;
        const id: i64 = @intCast(Value.intOf(f.get("id")) orelse 0);
        const handle = Value.str(f.get("h"));
        const v = f.get("v") orelse .null;
        const eq = std.mem.eql;
        if (eq(u8, op, "say")) return sayRaw(Value.str(v) orelse "");
        if (handle == null) {
            // #156: the host chain's frames go to its thread, in order (`chain` after a pending import).
            if (host_chain.isOp(op)) {
                h.cq_mu.lockUncancelable(h.io);
                defer h.cq_mu.unlock(h.io);
                try h.cq.append(h.gpa, try h.gpa.dupe(u8, bytes));
                h.cq_cond.signal(h.io);
                return;
            }
            if (h.hostRead(a, op, id, v, null, Value.str(f.get("set")))) |ans| return h.send(ans);
            if (eq(u8, op, "instances")) {
                h.q.lock();
                var list = std.array_list.Managed(Value).init(a);
                var it = h.insts.iterator();
                while (it.next()) |e| if (e.value_ptr.*.state == .open) try list.append(cbor.string(try a.dupe(u8, e.key_ptr.*)));
                h.q.unlock();
                return h.reply(a, null, id, .{ .array = list.items }, null, null);
            }
            if (eq(u8, op, "stop")) return error.Stop;
            return h.reply(a, null, id, null, "unknown op (an instance's needs h)", null);
        }
        const hd = handle.?;
        if (eq(u8, op, "state")) {
            if (h.hostRead(a, op, id, v, hd, null)) |ans| return h.send(ans);
        }
        h.q.lock();
        defer h.q.unlock();
        const had = h.insts.get(hd);
        if (eq(u8, op, "open")) {
            if (had) |t| {
                if (t.state == .closing) return h.reply(a, hd, id, null, "open: the instance is closing", null);
                return h.q.pushLocked(t, .{ .bytes = try h.gpa.dupe(u8, bytes) }); // idempotent: answered in order
            }
            const t = try h.gpa.create(Inst);
            t.* = .{ .host = h, .handle = try h.gpa.dupe(u8, hd) };
            try h.insts.put(h.gpa, t.handle, t);
            return h.q.pushLocked(t, .{ .bytes = try h.gpa.dupe(u8, bytes) });
        }
        const t = had orelse return h.reply(a, hd, id, null, "not open", null);
        if (t.state == .closing) return h.reply(a, hd, id, null, "closed", null);
        if (eq(u8, op, "call") and t.state == .open) {
            t.refs += 1;
            return h.q.pushReadLocked(.{ .inst = t, .bytes = try h.gpa.dupe(u8, bytes) });
        }
        try h.q.pushLocked(t, .{ .bytes = try h.gpa.dupe(u8, bytes) });
    }

    /// The ungated host reads (#158): `get`/`has` a block by CID whichever set holds it, `state` a
    /// set's committed pointer. The answer frame, or null if `op` is not one.
    fn hostRead(h: *Host, a: std.mem.Allocator, op: []const u8, id: i64, v: Value, handle: ?[]const u8, set: ?[]const u8) ?Value {
        const eq = std.mem.eql;
        var m = cbor.MapBuilder.init(a);
        m.put("re", cbor.int(id)) catch return null;
        if (handle) |x| m.put("h", cbor.string(x)) catch return null;
        const r: anyerror!Value = blk: {
            if (eq(u8, op, "get") and handle == null) {
                const c = Value.cidOf(v) orelse break :blk error.BadRequest;
                const b = (if (set) |x| h.db.setGet(a, x, c) else h.db.blockGet(a, c)) catch |e| break :blk e;
                break :blk if (b) |x| Value{ .bytes = x } else .null;
            } else if (eq(u8, op, "has") and handle == null) {
                const c = Value.cidOf(v) orelse break :blk error.BadRequest;
                break :blk Value{ .bool = (if (set) |x| h.db.setHas(a, x, c) else h.db.blockHas(c)) catch |e| break :blk e };
            } else if (eq(u8, op, "members") and handle == null and set != null) {
                // Every CID the set holds (a checkpoint's extras, `skein-host pack`; a test's grep).
                const cids = h.db.membersOf(a, set.?) catch |e| break :blk e;
                const arr = a.alloc(Value, cids.len) catch |e| break :blk e;
                for (cids, arr) |x, *y| y.* = cbor.cidv(x);
                break :blk Value{ .array = arr };
            } else if (eq(u8, op, "chain") and handle == null) {
                // #156: the host chain as it stands: {root, height, hash} | null.
                break :blk host_chain.run(&h.hc, a, op, v, null) catch |e| break :blk e;
            } else if (eq(u8, op, "state") and handle != null) {
                const p = h.db.pointerOf(a, handle.?, "state") catch |e| break :blk e;
                break :blk if (p) |x| cbor.cidv(x) else .null;
            } else return null;
        };
        if (r) |ok| {
            m.put("ok", ok) catch return null;
        } else |err| {
            m.put("error", cbor.string(@errorName(err))) catch return null;
        }
        return m.value();
    }

    /// Bounds that came: an `expire` queued for each instance with a waiter past its bound. The
    /// poll's timeout: the earliest bound left (-1: none).
    fn bounds(h: *Host, quitting: bool) i32 {
        var earliest: ?i64 = null;
        const now = nowMs();
        h.q.lock();
        defer h.q.unlock();
        var it = h.insts.valueIterator();
        while (it.next()) |tp| {
            const t = tp.*;
            const u = t.earliest() orelse continue;
            if (u <= now) {
                if (!t.expire_queued and t.state != .closing) {
                    t.expire_queued = true;
                    h.q.pushLocked(t, .{ .bytes = null }) catch {};
                }
                continue;
            }
            earliest = if (earliest) |e| @min(e, u) else u;
        }
        if (quitting) return 50;
        const e = earliest orelse return -1;
        return @intCast(std.math.clamp(e - now, 0, std.math.maxInt(i32)));
    }

    // ------------------------------------------------ the workers

    fn worker(h: *Host) void {
        while (true) {
            switch (h.q.take()) {
                .quit => return,
                .read => |r| {
                    h.runRead(r);
                    h.q.readDone(r.inst);
                },
                .inst => |t| {
                    while (h.q.next(t)) |item| {
                        if (h.runItem(t, item) == .freed) break;
                    }
                },
            }
        }
    }

    fn runRead(h: *Host, r: Read) void {
        defer h.gpa.free(r.bytes);
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const f = cbor.decode(a, r.bytes) catch return;
        const id: i64 = @intCast(Value.intOf(f.get("id")) orelse 0);
        h.doCall(a, r.inst, id, f.get("v") orelse .null) catch |err| h.reply(a, r.inst.handle, id, null, @errorName(err), null);
    }

    const Ran = enum { kept, freed };

    fn runItem(h: *Host, t: *Inst, item: Item) Ran {
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const bytes = item.bytes orelse {
            h.q.lock();
            t.expire_queued = false;
            h.q.unlock();
            h.expire(a, t);
            return .kept;
        };
        defer h.gpa.free(bytes);
        const f = cbor.decode(a, bytes) catch return .kept;
        const op = Value.str(f.get("op")) orelse return .kept;
        const id: i64 = @intCast(Value.intOf(f.get("id")) orelse 0);
        const v = f.get("v") orelse .null;
        if (std.mem.eql(u8, op, "close")) return h.doClose(a, t, id);
        if (std.mem.eql(u8, op, "open")) {
            h.doOpen(a, t, id, v) catch |err| h.reply(a, t.handle, id, null, @errorName(err), null);
            // Opened nothing: dropped as a close would (frames queued behind it answered "closed").
            if (t.rt == null) return h.free(a, t, null);
            return .kept;
        }
        if (t.rt == null) {
            h.reply(a, t.handle, id, null, "not open", null);
            return .kept;
        }
        h.handleOp(a, t, op, id, v) catch |err| h.reply(a, t.handle, id, null, @errorName(err), null);
        return .kept;
    }

    fn doOpen(h: *Host, a: std.mem.Allocator, t: *Inst, id: i64, v: Value) !void {
        if (t.rt != null) return h.reply(a, t.handle, id, .null, null, null);
        const spec = Value.str(v.get("db")) orelse return error.BadRequest;
        const p = any.parseRocksSpec(spec) orelse return h.reply(a, t.handle, id, null, try std.fmt.allocPrint(a, "open: {s} is not rocksdb:<dir>#<set>", .{spec}), null);
        if (!std.mem.eql(u8, p.dir, h.dir)) return h.reply(a, t.handle, id, null, try std.fmt.allocPrint(a, "open: {s} is not this process's database ({s})", .{ p.dir, h.dir }), null);
        if (!std.mem.eql(u8, p.set, t.handle)) return h.reply(a, t.handle, id, null, try std.fmt.allocPrint(a, "open: an instance's set is its handle ({s}), not {s}", .{ t.handle, p.set }), null);
        t.domain = try h.gpa.dupe(u8, Value.str(v.get("domain")) orelse "localhost");
        t.spec = try h.gpa.dupe(u8, spec);
        const st = try rocks.RocksStore.openIn(h.gpa, h.db, t.handle);
        errdefer st.close();
        try replay.install(h.gpa, h.io, AnyStore{ .rocksdb = st }, sayRaw);
        t.store = st;
        t.rt = try scheduler.Runtime.init(h.gpa, st.store(), h.runner, .{
            .ctx = t,
            .wallet = pWallet,
            .http = pHttp,
            .emit = pEmit,
            .on_answer = pOnAnswer,
            .say = pSay,
            .io = h.io,
        });
        h.q.lock();
        t.state = .open;
        h.q.unlock();
        h.reply(a, t.handle, id, .null, null, null);
    }

    /// Close (dehydrate): after the reads in flight, the runtime stopped and freed, the store closed.
    fn doClose(h: *Host, a: std.mem.Allocator, t: *Inst, id: i64) Ran {
        return h.free(a, t, id);
    }

    /// The instance gone: out of the map once its reads in flight are done, what is queued for it
    /// answered "closed", freed (its runtime stopped, its store's last commit); then `close_id`
    /// answered.
    fn free(h: *Host, a: std.mem.Allocator, t: *Inst, close_id: ?i64) Ran {
        h.q.lock();
        t.state = .closing;
        while (t.refs > 0) h.q.refs_cond.waitUncancelable(h.io, &h.q.mu);
        _ = h.insts.remove(t.handle);
        const left = t.inbox.toOwnedSlice(h.gpa) catch &.{};
        h.q.unlock();
        h.q.dropped();
        for (left) |it| if (it.bytes) |b| {
            if (cbor.decode(a, b)) |f| {
                if (Value.intOf(f.get("id"))) |fid| h.reply(a, t.handle, @intCast(fid), null, "closed", null);
            } else |_| {}
            h.gpa.free(b);
        };
        h.gpa.free(left);
        // Whoever waits on it (an `answer`, an `idle`) is answered: it is gone.
        for (t.waiters.items) |w| h.reply(a, t.handle, w.id, null, "closed", null);
        for (t.idle_waiters.items) |w| h.reply(a, t.handle, w, .null, null, null);
        const handle = a.dupe(u8, t.handle) catch "";
        h.dispose(t);
        if (close_id) |id| h.reply(a, handle, id, .null, null, null);
        return .freed;
    }

    fn dispose(h: *Host, t: *Inst) void {
        if (t.rt) |rt| rt.deinit();
        if (t.store) |st| st.close();
        for (t.waiters.items) |w| h.gpa.free(w.entry);
        t.waiters.deinit(h.gpa);
        t.idle_waiters.deinit(h.gpa);
        t.inbox.deinit(h.gpa);
        if (t.domain.len > 0) h.gpa.free(t.domain);
        if (t.spec.len > 0) h.gpa.free(t.spec);
        h.gpa.free(t.handle);
        h.gpa.destroy(t);
    }

    /// A call (#40) over the set as committed (#158): a view at its state pointer, its own index.
    fn doCall(h: *Host, a: std.mem.Allocator, t: *Inst, id: i64, v: Value) !void {
        const rt = t.rt orelse return h.reply(a, t.handle, id, null, "not open", null);
        const view = try rocks.View.open(h.gpa, h.db, t.handle);
        defer view.close();
        const vs = view.store();
        const g: ?Value = if ((try vs.logTip(a)) != null) logm.genesisOf(a, vs) catch null else null;
        const gv = g orelse return h.reply(a, t.handle, id, null, "call: no genesis", null);
        const prog: []const u8 = Value.cidOf(v.get("program")) orelse blk: {
            const name = Value.str(v.get("program")) orelse return error.BadRequest;
            const progs: Value = gv.get("programs") orelse .null;
            break :blk Value.cidOf(if (progs == .map) progs.get(name) else null) orelse
                return h.reply(a, t.handle, id, null, try std.fmt.allocPrint(a, "call: no program {s} in the genesis", .{name}), null);
        };
        const func = Value.str(v.get("fn")) orelse return error.BadRequest;
        const arg = Value.bytesOf(v.get("arg")) orelse "";
        const now = Value.intOf(v.get("now")) orelse nowMs();
        const r = try rt.callOver(a, vs, prog, func, arg, Value.bytesOf(v.get("caller")), @intCast(now));
        var m = cbor.MapBuilder.init(a);
        try m.put("ok", .{ .bool = r.ok });
        if (r.ok) try m.put("result", .{ .bytes = r.result }) else try m.put("error", cbor.string(r.err));
        try m.put("fuel", cbor.int(r.fuel));
        h.reply(a, t.handle, id, m.value(), null, null);
    }

    // ------------------------------------------------ an instance's frames (serve.zig handleOp)

    fn handleOp(h: *Host, a: std.mem.Allocator, t: *Inst, op: []const u8, id: i64, v: Value) !void {
        const eq = std.mem.eql;
        const rt = t.rt.?;
        const s = t.store.?.store();
        const hd = t.handle;
        if (eq(u8, op, "tip")) {
            h.reply(a, hd, id, cbor.optCid(try s.logTip(a)) orelse .null, null, null);
        } else if (eq(u8, op, "get")) {
            const c = Value.cidOf(v) orelse return error.BadRequest;
            h.reply(a, hd, id, (try s.get(a, c)) orelse .null, null, null);
        } else if (eq(u8, op, "put")) {
            h.reply(a, hd, id, cbor.cidv(try s.put(a, v)), null, null);
        } else if (eq(u8, op, "has")) {
            const c = Value.cidOf(v) orelse return error.BadRequest;
            h.reply(a, hd, id, .{ .bool = try s.has(c) }, null, null);
        } else if (eq(u8, op, "putblock")) {
            const c = Value.cidOf(v.get("cid")) orelse return error.BadRequest;
            const b = Value.bytesOf(v.get("bytes")) orelse return error.BadRequest;
            if (!cidm.hashMatches(c, b)) return h.reply(a, hd, id, null, try std.fmt.allocPrint(a, "putblock: bytes do not hash to {s}", .{try cidm.format(a, c)}), null);
            try s.putBlock(c, b);
            h.reply(a, hd, id, cbor.cidv(c), null, null);
        } else if (eq(u8, op, "restore")) {
            const c = Value.cidOf(v) orelse return error.BadRequest;
            try t.store.?.restore(c);
            h.reply(a, hd, id, cbor.cidv(c), null, null);
        } else if (eq(u8, op, "append")) {
            switch (try rt.appendGenesis(a, v)) {
                .ok => |c| h.reply(a, hd, id, cbor.cidv(c), null, null),
                .answered => h.reply(a, hd, id, null, "append: the genesis is not a request", null),
                .rejected => |r| h.reply(a, hd, id, null, r.message, r.reason.text()),
                .invalid => |m| h.reply(a, hd, id, null, m, null),
            }
        } else if (eq(u8, op, "programs")) {
            var m = cbor.MapBuilder.init(a);
            for (programsm.program_names) |name| {
                if (v == .array) {
                    var wanted = false;
                    for (v.array) |x| wanted = wanted or std.mem.eql(u8, Value.str(x) orelse "", name);
                    if (!wanted) continue;
                }
                try m.put(name, cbor.cidv(try s.put(a, try programsm.program(a, name))));
            }
            h.reply(a, hd, id, m.value(), null, null);
        } else if (eq(u8, op, "head")) {
            const name = Value.str(v) orelse return error.BadRequest;
            h.reply(a, hd, id, cbor.optCid(try s.headTree(a, name)) orelse .null, null, null);
        } else if (eq(u8, op, "genesis")) {
            h.reply(a, hd, id, logm.genesisOf(a, s) catch .null, null, null);
        } else if (eq(u8, op, "dispatch")) {
            const rows = (try dispatchm.current(a, s)) orelse &.{};
            var m = cbor.MapBuilder.init(a);
            try m.put("tip", cbor.optCid(try s.chainTip(a, try dispatchm.origin(a))) orelse .null);
            try m.put("rows", try dispatchm.valueOf(a, rows));
            h.reply(a, hd, id, m.value(), null, null);
        } else if (eq(u8, op, "boxes")) {
            const bs = try rt.boxes(a);
            const arr = try a.alloc(Value, bs.len);
            for (bs, 0..) |b, i| arr[i] = cbor.string(b);
            h.reply(a, hd, id, .{ .array = arr }, null, null);
        } else if (eq(u8, op, "byEnvelope")) {
            const c = Value.cidOf(v) orelse return error.BadRequest;
            h.reply(a, hd, id, cbor.optCid(try s.byEnvelope(a, c)) orelse .null, null, null);
        } else if (eq(u8, op, "admit")) {
            const entry = v.get("entry") orelse return error.BadRequest;
            const res = try rt.admit(a, entry, v.get("request"));
            switch (res) {
                .ok => |c| h.reply(a, hd, id, cbor.cidv(c), null, null),
                .answered => |x| {
                    var m = cbor.MapBuilder.init(a);
                    try m.put("answered", try x.value(a));
                    h.reply(a, hd, id, m.value(), null, null);
                },
                .rejected => |r| h.reply(a, hd, id, null, r.message, r.reason.text()),
                .invalid => |m| h.reply(a, hd, id, null, m, null),
            }
            // Processed here and now: the step runs on this worker (the instance's only one).
            if (res == .ok) rt.kick();
            h.afterDrain(a, t);
        } else if (eq(u8, op, "call")) {
            // A call queued behind the open (it came before the instance was open): the same view.
            try h.doCall(a, t, id, v);
        } else if (eq(u8, op, "answer")) {
            const entry = Value.cidOf(v.get("entry")) orelse return error.BadRequest;
            const wait = Value.intOf(v.get("wait")) orelse 120_000;
            if (try rt.requestThread(a, entry)) |th| {
                const r = try rt.answerOf(a, th);
                if (eq(u8, r.state, "finished") or eq(u8, r.state, "errored")) return h.reply(a, hd, id, try answerValue(rt, a, th), null, null);
            }
            t.wmu.lockUncancelable(h.io);
            defer t.wmu.unlock(h.io);
            try t.waiters.append(h.gpa, .{ .id = id, .entry = try h.gpa.dupe(u8, entry), .until = nowMs() + @as(i64, @intCast(@max(0, wait))) });
            h.wakeIo();
        } else if (eq(u8, op, "idle")) {
            try t.idle_waiters.append(h.gpa, id);
            h.afterDrain(a, t);
        } else if (eq(u8, op, "start")) {
            rt.start() catch |err| return h.reply(a, hd, id, null, try std.fmt.allocPrint(a, "start: {s}@{s}: {s}", .{ hd, t.domain, @errorName(err) }), null);
            h.reply(a, hd, id, .null, null, null);
            rt.kick();
            h.afterDrain(a, t);
        } else if (eq(u8, op, "running")) {
            const ident = Value.str(v) orelse "";
            var buf: [512]u8 = undefined;
            h.sayFor(hd, std.fmt.bufPrint(&buf, "skein runtime {s} ({s}@{s}) · pid {d} · db {s}", .{ ident, hd, t.domain, std.c.getpid(), t.spec }) catch "skein runtime");
        } else {
            h.reply(a, hd, id, null, "unknown op", null);
        }
    }

    fn afterDrain(h: *Host, a: std.mem.Allocator, t: *Inst) void {
        if (t.rt.?.draining) return;
        for (t.idle_waiters.items) |w| h.reply(a, t.handle, w, .null, null, null);
        t.idle_waiters.clearRetainingCapacity();
    }

    fn answerValue(rt: *scheduler.Runtime, a: std.mem.Allocator, thread: ?[]const u8) !Value {
        var m = cbor.MapBuilder.init(a);
        const th = thread orelse {
            try m.put("state", cbor.string("pending"));
            return m.value();
        };
        const r = try rt.answerOf(a, th);
        try m.put("thread", cbor.cidv(th));
        try m.put("state", cbor.string(r.state));
        if (std.mem.eql(u8, r.state, "finished")) try m.put("answer", .{ .bytes = r.stdout });
        if (std.mem.eql(u8, r.state, "errored")) try m.put("error", cbor.string(r.err));
        return m.value();
    }

    /// Waiters past their bound: answered with the thread's state as it stands (serve.zig expire).
    fn expire(h: *Host, a: std.mem.Allocator, t: *Inst) void {
        const rt = t.rt orelse return;
        const now = nowMs();
        var due = std.array_list.Managed(Waiter).init(a);
        {
            t.wmu.lockUncancelable(h.io);
            defer t.wmu.unlock(h.io);
            var i: usize = 0;
            while (i < t.waiters.items.len) {
                if (t.waiters.items[i].until > now) {
                    i += 1;
                    continue;
                }
                due.append(t.waiters.orderedRemove(i)) catch {};
            }
        }
        for (due.items) |w| {
            defer h.gpa.free(w.entry);
            const th = rt.requestThread(a, w.entry) catch null;
            const v = answerValue(rt, a, th) catch |err| {
                h.reply(a, t.handle, w.id, null, @errorName(err), null);
                continue;
            };
            h.reply(a, t.handle, w.id, v, null, null);
        }
    }

    // ------------------------------------------------ the runtime's peers

    fn inst(p: *anyopaque) *Inst {
        return @ptrCast(@alignCast(p));
    }

    /// A request to the host from a worker: the frame tagged with the instance's handle; the worker
    /// waits for the I/O thread to hand it the answer.
    fn request(h: *Host, a: std.mem.Allocator, handle: []const u8, op: []const u8, payload: Value) !Value {
        const id = try h.reqs.register();
        var m = cbor.MapBuilder.init(a);
        try m.put("id", cbor.int(id));
        try m.put("op", cbor.string(op));
        try m.put("h", cbor.string(handle));
        try m.put("v", payload);
        h.send(m.value());
        const bytes = try h.reqs.wait(id);
        defer h.gpa.free(bytes);
        const f = try cbor.decode(a, try a.dupe(u8, bytes));
        if (Value.str(f.get("error")) != null) return error.PeerError;
        return f.get("ok") orelse .null;
    }

    fn pWallet(p: *anyopaque, a: std.mem.Allocator, fr: []const u8) anyerror![]u8 {
        const t = inst(p);
        const r = try t.host.request(a, t.handle, "wallet", .{ .bytes = fr });
        return @constCast(Value.bytesOf(r) orelse return error.BadAnswer);
    }

    fn pHttp(p: *anyopaque, a: std.mem.Allocator, req: authfetch.HttpRequest) anyerror!authfetch.HttpResult {
        const t = inst(p);
        const r = try t.host.request(a, t.handle, "http", try authfetch.httpRequestValue(a, req));
        return authfetch.httpResultOf(a, r);
    }

    fn pEmit(p: *anyopaque, o: scheduler.Outgoing) void {
        const t = inst(p);
        const h = t.host;
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        var m = cbor.MapBuilder.init(a);
        m.put("message", cbor.decode(a, o.message) catch return) catch return;
        m.put("body", .{ .bytes = o.body }) catch return;
        m.put("transport", cbor.string(o.transport)) catch return;
        m.put("address", cbor.string(o.address)) catch return;
        if (o.place) |pl| {
            var at = cbor.MapBuilder.init(a);
            at.put("n", cbor.int(pl.n)) catch return;
            at.put("seq", cbor.int(pl.seq)) catch return;
            at.put("i", cbor.int(pl.i)) catch return;
            at.put("thread", cbor.cidv(pl.thread)) catch return;
            m.put("place", at.value()) catch return;
        }
        h.notify(a, t.handle, "emit", m.value());
    }

    fn pOnAnswer(p: *anyopaque, thread: []const u8, entry: []const u8) void {
        const t = inst(p);
        const h = t.host;
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        var hit = std.array_list.Managed(Waiter).init(a);
        {
            t.wmu.lockUncancelable(h.io);
            defer t.wmu.unlock(h.io);
            var i: usize = 0;
            while (i < t.waiters.items.len) {
                if (!std.mem.eql(u8, t.waiters.items[i].entry, entry)) {
                    i += 1;
                    continue;
                }
                hit.append(t.waiters.orderedRemove(i)) catch {};
            }
        }
        for (hit.items) |w| {
            defer h.gpa.free(w.entry);
            const v = answerValue(t.rt.?, a, thread) catch |err| {
                h.reply(a, t.handle, w.id, null, @errorName(err), null);
                continue;
            };
            h.reply(a, t.handle, w.id, v, null, null);
        }
    }

    fn pSay(p: *anyopaque, line: []const u8) void {
        const t = inst(p);
        t.host.sayFor(t.handle, line);
    }
};

// ------------------------------------------------------------------ the host chain's thread

/// The host chain's writes (#156: `headers`, `chain-import`), in the order they came, answered as
/// they are done: off the I/O thread (an import of a whole chain takes seconds), one at a time.
fn chainThread(h: *Host) void {
    while (true) {
        const bytes = blk: {
            h.cq_mu.lockUncancelable(h.io);
            defer h.cq_mu.unlock(h.io);
            while (h.cq.items.len == 0 and !h.cq_quit) h.cq_cond.waitUncancelable(h.io, &h.cq_mu);
            if (h.cq.items.len == 0) return;
            break :blk h.cq.orderedRemove(0);
        };
        defer h.gpa.free(bytes);
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const f = cbor.decode(a, bytes) catch continue;
        const op = Value.str(f.get("op")) orelse continue;
        const id: i64 = @intCast(Value.intOf(f.get("id")) orelse 0);
        const v = f.get("v") orelse .null;
        // chain-import's set: the instance whose set holds the image's blocks (read through its gate).
        var from_ctx: SetReader = .{ .db = h.db, .set = Value.str(v.get("set")) orelse "" };
        const from: ?host_chain.Reader = if (from_ctx.set.len > 0) .{ .ctx = &from_ctx, .get = SetReader.get } else null;
        const ans = host_chain.run(&h.hc, a, op, v, from) catch |err| {
            h.reply(a, null, id, null, std.fmt.allocPrint(a, "{s}: {s}", .{ op, @errorName(err) }) catch @errorName(err), null);
            continue;
        };
        h.reply(a, null, id, ans, null, null);
    }
}

/// A set's blocks, read through its gate (an image's, for `chain-import`).
const SetReader = struct {
    db: *rocks.Db,
    set: []const u8,
    fn get(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const r: *SetReader = @ptrCast(@alignCast(ctx));
        return r.db.setGet(a, r.set, cid);
    }
};

// ------------------------------------------------------------------ the host-read socket

const Client = struct { fd: std.posix.fd_t, r: ipc.Reader };

fn listenUnix(path: []const u8) !std.posix.fd_t {
    const sys = std.posix.system;
    const rc = sys.socket(sys.AF.UNIX, sys.SOCK.STREAM | sys.SOCK.CLOEXEC, 0);
    if (std.posix.errno(rc) != .SUCCESS) return error.Socket;
    const fd: std.posix.fd_t = @intCast(rc);
    var addr = std.mem.zeroes(sys.sockaddr.un);
    addr.family = sys.AF.UNIX;
    if (path.len >= addr.path.len) return error.NameTooLong;
    @memcpy(addr.path[0..path.len], path);
    var zbuf: [256]u8 = undefined;
    const z = std.fmt.bufPrintZ(&zbuf, "{s}", .{path}) catch return error.NameTooLong;
    _ = sys.unlink(z.ptr);
    if (std.posix.errno(sys.bind(fd, @ptrCast(&addr), @sizeOf(sys.sockaddr.un))) != .SUCCESS) return error.Bind;
    if (std.posix.errno(sys.listen(fd, 64)) != .SUCCESS) return error.Listen;
    return fd;
}

/// The host-read socket's thread: accepts readers, answers their frames, until `wake` is readable.
fn sockThread(h: *Host, lfd: std.posix.fd_t, wake: std.posix.fd_t) void {
    var clients = std.array_list.Managed(Client).init(h.gpa);
    defer clients.deinit();
    var fds = std.array_list.Managed(std.posix.pollfd).init(h.gpa);
    defer fds.deinit();
    while (true) {
        fds.clearRetainingCapacity();
        fds.append(.{ .fd = wake, .events = std.posix.POLL.IN, .revents = 0 }) catch return;
        fds.append(.{ .fd = lfd, .events = std.posix.POLL.IN, .revents = 0 }) catch return;
        for (clients.items) |cl| fds.append(.{ .fd = cl.fd, .events = std.posix.POLL.IN, .revents = 0 }) catch return;
        _ = std.posix.poll(fds.items, -1) catch return;
        if (fds.items[0].revents != 0) break;
        if (fds.items[1].revents != 0) {
            const cfd = std.posix.system.accept4(lfd, null, null, std.posix.SOCK.CLOEXEC);
            if (std.posix.errno(cfd) == .SUCCESS) clients.append(.{ .fd = @intCast(cfd), .r = ipc.Reader.init(h.gpa, @intCast(cfd)) }) catch {};
        }
        var i: usize = fds.items.len - 2;
        while (i > 0) {
            i -= 1;
            if (fds.items[2 + i].revents == 0) continue;
            if (!serveClient(h, &clients.items[i])) {
                _ = std.posix.system.close(clients.items[i].fd);
                clients.items[i].r.buf.deinit();
                _ = clients.orderedRemove(i);
            }
        }
    }
    for (clients.items) |*cl| {
        _ = std.posix.system.close(cl.fd);
        cl.r.buf.deinit();
    }
}

fn serveClient(h: *Host, cl: *Client) bool {
    if (!(cl.r.fill() catch false)) return false;
    while (true) {
        var arena = std.heap.ArenaAllocator.init(h.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const b = (cl.r.next(a) catch return false) orelse return true;
        const f = cbor.decode(a, b) catch return false;
        const op = Value.str(f.get("op")) orelse return false;
        const id: i64 = @intCast(Value.intOf(f.get("id")) orelse 0);
        const ans = h.hostRead(a, op, id, f.get("v") orelse .null, Value.str(f.get("h")), Value.str(f.get("set"))) orelse blk: {
            var m = cbor.MapBuilder.init(a);
            m.put("re", cbor.int(id)) catch return false;
            m.put("error", cbor.string("only the host reads (get, has, members, state, chain) here")) catch return false;
            break :blk m.value();
        };
        ipc.write(h.io, .{ .handle = cl.fd, .flags = .{ .nonblocking = false } }, a, ans) catch return false;
    }
}

// ------------------------------------------------------------------ main

pub fn main(gpa: std.mem.Allocator, io: Io) !void {
    g_io = io;
    const home = envm.get("SKEIN_HOME") orelse try std.fmt.allocPrint(gpa, "{s}/.skein", .{envm.get("HOME") orelse "."});
    const dir = envm.get("SKEIN_STORE_ROCKSDB") orelse try std.fmt.allocPrint(gpa, "{s}/store-rocksdb", .{home});
    const n_workers: usize = if (envm.get("SKEIN_WORKERS")) |w| std.fmt.parseInt(usize, w, 10) catch 1 else std.Thread.getCpuCount() catch 4;

    if (std.posix.errno(std.posix.system.pipe2(&sig_pipe, .{ .CLOEXEC = true, .NONBLOCK = true })) != .SUCCESS) return error.Pipe;
    const sa = std.posix.Sigaction{ .handler = .{ .handler = onSignal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.INT, &sa, null);
    std.posix.sigaction(std.posix.SIG.TERM, &sa, null);
    const ign = std.posix.Sigaction{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.PIPE, &ign, null);

    const db = rocks.Db.open(gpa, io, dir, false) catch |err| {
        var buf: [1024]u8 = undefined;
        sayRaw(std.fmt.bufPrint(&buf, "skein-kernel host: {s}: {s} (another process holds the database?)", .{ dir, @errorName(err) }) catch "skein-kernel host: the database did not open");
        std.process.exit(1);
    };
    const r = try runner.Runner.init(gpa);
    r.io = io;
    var host = Host{ .gpa = gpa, .io = io, .db = db, .dir = dir, .runner = r, .q = Queue.init(gpa, io), .reqs = Requests.init(gpa, io) };
    const network = host_chain.hostNetwork() catch {
        sayRaw("skein-kernel host: SKEIN_NETWORK is main, test or regtest");
        std.process.exit(1);
    };
    host.chain_set = try rocks.RocksStore.openChain(gpa, db);
    host.hc = host_chain.HostChain.init(host.chain_set.?.backend(), network, io);
    const chain_thread = try std.Thread.spawn(.{ .stack_size = 64 << 20, .allocator = gpa }, chainThread, .{&host});
    var io_wake: [2]std.posix.fd_t = .{ -1, -1 };
    if (std.posix.errno(std.posix.system.pipe2(&io_wake, .{ .CLOEXEC = true, .NONBLOCK = true })) != .SUCCESS) return error.Pipe;
    host.wake_fd = io_wake[1];

    const sock_path = try std.fmt.allocPrint(gpa, "{s}/kernel.sock", .{dir});
    const lfd = listenUnix(sock_path) catch |err| blk: {
        var buf: [512]u8 = undefined;
        sayRaw(std.fmt.bufPrint(&buf, "skein-kernel host: the host-read socket {s}: {s}", .{ sock_path, @errorName(err) }) catch "skein-kernel host: no host-read socket");
        break :blk -1;
    };
    var wake: [2]std.posix.fd_t = .{ -1, -1 };
    if (std.posix.errno(std.posix.system.pipe2(&wake, .{ .CLOEXEC = true })) != .SUCCESS) return error.Pipe;
    const sock_thread: ?std.Thread = if (lfd >= 0) try std.Thread.spawn(.{ .allocator = gpa }, sockThread, .{ &host, lfd, wake[0] }) else null;

    const threads = try gpa.alloc(std.Thread, @max(1, n_workers));
    for (threads) |*t| t.* = try std.Thread.spawn(.{ .stack_size = 64 << 20, .allocator = gpa }, Host.worker, .{&host});
    {
        var buf: [512]u8 = undefined;
        sayRaw(std.fmt.bufPrint(&buf, "skein-kernel host · pid {d} · db rocksdb:{s} · {d} workers", .{ std.c.getpid(), dir, threads.len }) catch "skein-kernel host");
    }

    var from_peer = ipc.Reader.init(gpa, std.posix.STDIN_FILENO);
    var stop_id: ?i64 = null;
    var quitting = false;
    var eof = false;
    var fds = std.array_list.Managed(std.posix.pollfd).init(gpa);
    while (true) {
        if (quitting) {
            host.q.lock();
            const busy = host.q.active;
            host.q.unlock();
            if (busy == 0) break;
        }
        fds.clearRetainingCapacity();
        try fds.append(.{ .fd = if (eof) -1 else from_peer.fd, .events = std.posix.POLL.IN, .revents = 0 });
        try fds.append(.{ .fd = sig_pipe[0], .events = std.posix.POLL.IN, .revents = 0 });
        try fds.append(.{ .fd = io_wake[0], .events = std.posix.POLL.IN, .revents = 0 });
        _ = try std.posix.poll(fds.items, host.bounds(quitting));
        if (fds.items[2].revents != 0) {
            var b: [64]u8 = undefined;
            _ = std.posix.read(io_wake[0], &b) catch {};
        }
        if (fds.items[1].revents != 0) {
            var b: [16]u8 = undefined;
            _ = std.posix.read(sig_pipe[0], &b) catch {};
            var buf: [64]u8 = undefined;
            sayRaw(std.fmt.bufPrint(&buf, "{s}: stopping", .{sig_name}) catch "stopping");
            var arena = std.heap.ArenaAllocator.init(gpa);
            defer arena.deinit();
            host.notify(arena.allocator(), null, "stop", null);
            quitting = true;
            host.q.stop();
        }
        if (!eof and fds.items[0].revents != 0) {
            if (!try from_peer.fill()) {
                // EOF: the router is gone (or closed the channel): nothing will answer a request.
                eof = true;
                quitting = true;
                host.q.stop();
                host.reqs.failAll();
                continue;
            }
            while (true) {
                var arena = std.heap.ArenaAllocator.init(gpa);
                defer arena.deinit();
                const a = arena.allocator();
                const b = (try from_peer.next(a)) orelse break;
                host.onFrame(a, b) catch |err| switch (err) {
                    error.Stop => {
                        const f = cbor.decode(a, b) catch continue;
                        stop_id = @intCast(Value.intOf(f.get("id")) orelse 0);
                        quitting = true;
                        host.q.stop();
                    },
                    else => std.log.err("frame: {s}", .{@errorName(err)}),
                };
            }
        }
    }
    for (threads) |t| t.join();
    {
        host.cq_mu.lockUncancelable(io);
        host.cq_quit = true;
        host.cq_cond.broadcast(io);
        host.cq_mu.unlock(io);
    }
    chain_thread.join();
    _ = std.posix.system.write(wake[1], "x", 1);
    if (sock_thread) |t| t.join();
    // Every instance stopped, its store closed (its last commit), the database flushed.
    {
        host.q.lock();
        var list = std.array_list.Managed(*Inst).init(gpa);
        var it = host.insts.valueIterator();
        while (it.next()) |t| list.append(t.*) catch {};
        host.insts.clearRetainingCapacity();
        host.q.unlock();
        for (list.items) |t| {
            for (t.inbox.items) |x| if (x.bytes) |b| gpa.free(b);
            host.dispose(t);
        }
    }
    if (lfd >= 0) {
        _ = std.posix.system.close(lfd);
        var zbuf: [256]u8 = undefined;
        if (std.fmt.bufPrintZ(&zbuf, "{s}", .{sock_path})) |z| {
            _ = std.posix.system.unlink(z.ptr);
        } else |_| {}
    }
    if (host.chain_set) |cs| cs.close();
    db.close(gpa);
    if (stop_id) |id| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        host.reply(arena.allocator(), null, id, .null, null, null);
    }
    std.process.exit(0);
}

// ------------------------------------------------------------------ tests

const testing = std.testing;

test "run queue: an instance is never on two workers, whatever the enqueues" {
    const T = struct {
        inbox: std.ArrayListUnmanaged(Item) = .empty,
        queued: bool = false,
        running: bool = false,
        refs: usize = 0,
        on: std.atomic.Value(u32) = .init(0),
        done: std.atomic.Value(u32) = .init(0),
        overlap: std.atomic.Value(u32) = .init(0),
    };
    const Q = RunQueue(T, u8);
    const N_INST = 8;
    const N_ITEMS = 2000;
    const N_PRODUCERS = 4;
    const N_WORKERS = 8;
    var q = Q.init(testing.allocator, testing.io);
    defer q.deinit();
    var insts: [N_INST]T = .{T{}} ** N_INST;
    defer for (&insts) |*t| t.inbox.deinit(testing.allocator);

    const W = struct {
        fn work(qq: *Q) void {
            while (true) switch (qq.take()) {
                .quit => return,
                .read => unreachable,
                .inst => |t| while (qq.next(t)) |_| {
                    if (t.on.fetchAdd(1, .acq_rel) != 0) _ = t.overlap.fetchAdd(1, .monotonic);
                    var x: u32 = 0;
                    for (0..200) |k| x +%= @intCast(k); // a little work while held
                    std.mem.doNotOptimizeAway(x);
                    _ = t.on.fetchSub(1, .acq_rel);
                    _ = t.done.fetchAdd(1, .monotonic);
                },
            };
        }
        fn produce(qq: *Q, ts: *[N_INST]T, seed: u64) void {
            var rng = std.Random.DefaultPrng.init(seed);
            for (0..N_ITEMS * N_INST / N_PRODUCERS) |_| {
                const t = &ts[rng.random().uintLessThan(usize, N_INST)];
                qq.push(t, .{ .bytes = null }) catch unreachable;
            }
        }
    };
    var ws: [N_WORKERS]std.Thread = undefined;
    for (&ws) |*w| w.* = try std.Thread.spawn(.{}, W.work, .{&q});
    var ps: [N_PRODUCERS]std.Thread = undefined;
    for (&ps, 0..) |*p, i| p.* = try std.Thread.spawn(.{}, W.produce, .{ &q, &insts, i + 1 });
    for (ps) |p| p.join();
    // Every item processed, then stop.
    var total: u32 = 0;
    while (total < N_ITEMS * N_INST) {
        total = 0;
        for (&insts) |*t| total += t.done.load(.monotonic);
        std.Thread.yield() catch {};
    }
    q.stop();
    for (ws) |w| w.join();
    for (&insts) |*t| try testing.expectEqual(@as(u32, 0), t.overlap.load(.monotonic));
    try testing.expectEqual(@as(u32, N_ITEMS * N_INST), total);
}

test "requests: a worker waits on its own answer, delivered from another thread in any order" {
    var r = Requests.init(testing.allocator, testing.io);
    defer r.deinit();
    const N = 16;
    var ids: [N]i64 = undefined;
    for (&ids) |*id| id.* = try r.register();
    var got: [N][]u8 = undefined;
    const W = struct {
        fn wait(rr: *Requests, id: i64, out: *[]u8) void {
            out.* = rr.wait(id) catch unreachable;
        }
    };
    var ts: [N]std.Thread = undefined;
    for (&ts, 0..) |*t, i| t.* = try std.Thread.spawn(.{}, W.wait, .{ &r, ids[i], &got[i] });
    // Answered in reverse, with a stray answer no one waits on.
    try testing.expect(!r.deliver(9999, try testing.allocator.dupe(u8, "stray")));
    var i: usize = N;
    while (i > 0) {
        i -= 1;
        try testing.expect(r.deliver(ids[i], try std.fmt.allocPrint(testing.allocator, "answer {d}", .{ids[i]})));
    }
    for (ts) |t| t.join();
    for (got, ids) |g, id| {
        var buf: [32]u8 = undefined;
        try testing.expectEqualStrings(try std.fmt.bufPrint(&buf, "answer {d}", .{id}), g);
        testing.allocator.free(g);
    }
    // Gone: a wait ends with PeerGone.
    const late = try r.register();
    r.failAll();
    try testing.expectError(error.PeerGone, r.wait(late));
}
