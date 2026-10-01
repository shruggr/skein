// `skein-kernel serve`: one instance's kernel, driven by the router
// (src/host/kernel.ts, issue #33) over its stdin/stdout: length-prefixed
// dag-cbor frames (ipc.zig). The router hydrates an instance by starting this
// process and stops it by closing stdin (or SIGTERM) once it is idle.
//
// The kernel is this process: the store, the log, the scheduler, the
// programs. Everything outside is the router's: it admits entries (the one
// call in that writes: a request as received, #68, a feed's event),
// waits on a request's thread (`answer`, #66: parked here until the thread
// comes to rest, or its bound), makes `call`s (#40: a program's function
// over the state, for host-side reads), answers the kernel's `wallet`
// requests (the oracle), and carries out what the kernel tells it of
// (`emit`: #70, a signed message for a local provider or the libp2p node,
// the answer coming back as an entry; #65, a broadcast event). Nothing here
// keeps time: a step's deadline and a shell's sleep are wake-me messages to
// the waker provider (#69). Log lines go to stderr.
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
const storem = @import("store.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Value = cbor.Value;

var sig_pipe: [2]std.posix.fd_t = .{ -1, -1 };
var sig_name: []const u8 = "";

/// The process's Io (main's): stderr, the peer channel, the clock, files.
var io: std.Io = undefined;

fn onSignal(sig: std.posix.SIG) callconv(.c) void {
    sig_name = if (sig == .INT) "SIGINT" else "SIGTERM";
    // write(2) itself: async-signal-safe, and a full pipe only drops a wakeup already pending.
    _ = std.posix.system.write(sig_pipe[1], "x", 1);
}

fn say(line: []const u8) void {
    const f = std.Io.File.stderr();
    f.writeStreamingAll(io, line) catch {};
    f.writeStreamingAll(io, "\n") catch {};
}

fn sayf(comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    say(s);
}

fn die(comptime fmt: []const u8, args: anytype) noreturn {
    var buf: [4096]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "skein-kernel serve: " ++ fmt ++ "\n", args) catch "skein-kernel serve: error\n";
    std.Io.File.stderr().writeStreamingAll(io, s) catch {};
    std.process.exit(1);
}

const Server = struct {
    gpa: std.mem.Allocator,
    ss: *SqliteStore,
    store: storem.Store,
    rt: *scheduler.Runtime,
    to_peer: std.Io.File,
    from_peer: ipc.Reader,
    next_id: i64 = 1,
    idle_waiters: std.array_list.Managed(i64),
    handle: []const u8,
    domain: []const u8,
    db_path: []const u8,
    running: bool = false,
    /// Answers the peer sent to an outer request while an inner one waited (encoded frames).
    answers: std.AutoHashMap(i64, []u8),
    /// The host's `answer` requests not yet answered (#66): each waits on a request entry's thread.
    waiters: std.array_list.Managed(Waiter),

    const Waiter = struct { id: i64, entry: []u8, until: i64 };

    fn nowMs() i64 {
        return @intCast(std.Io.Clock.real.now(io).toMilliseconds());
    }

    /// The answer frame for a request's thread: {thread, state, answer?: bytes, error?}.
    fn answerValue(s: *Server, a: std.mem.Allocator, thread: ?[]const u8) !Value {
        var m = cbor.MapBuilder.init(a);
        const t = thread orelse {
            try m.put("state", cbor.string("pending"));
            return m.value();
        };
        const r = try s.rt.answerOf(a, t);
        try m.put("thread", cbor.cidv(t));
        try m.put("state", cbor.string(r.state));
        if (std.mem.eql(u8, r.state, "finished")) try m.put("answer", .{ .bytes = r.stdout });
        if (std.mem.eql(u8, r.state, "errored")) try m.put("error", cbor.string(r.err));
        return m.value();
    }

    /// A request's thread came to rest (the scheduler's on_answer): answer whoever waits on its entry.
    fn answered(s: *Server, a: std.mem.Allocator, thread: []const u8, entry: []const u8) void {
        var i: usize = 0;
        while (i < s.waiters.items.len) {
            const w = s.waiters.items[i];
            if (!std.mem.eql(u8, w.entry, entry)) {
                i += 1;
                continue;
            }
            _ = s.waiters.orderedRemove(i);
            defer s.gpa.free(w.entry);
            const v = s.answerValue(a, thread) catch |err| {
                s.reply(a, w.id, null, @errorName(err), null);
                continue;
            };
            s.reply(a, w.id, v, null, null);
        }
    }

    /// Waiters past their bound: answered with the thread's state as it stands (not at rest).
    fn expire(s: *Server, a: std.mem.Allocator) void {
        const now = nowMs();
        var i: usize = 0;
        while (i < s.waiters.items.len) {
            const w = s.waiters.items[i];
            if (w.until > now) {
                i += 1;
                continue;
            }
            _ = s.waiters.orderedRemove(i);
            defer s.gpa.free(w.entry);
            const t = s.rt.requestThread(a, w.entry) catch null;
            const v = s.answerValue(a, t) catch |err| {
                s.reply(a, w.id, null, @errorName(err), null);
                continue;
            };
            s.reply(a, w.id, v, null, null);
        }
    }

    /// How long the poll may sleep: until the earliest waiter's bound (-1: none).
    fn pollTimeout(s: *Server) i32 {
        if (s.waiters.items.len == 0) return -1;
        var until = s.waiters.items[0].until;
        for (s.waiters.items) |w| until = @min(until, w.until);
        return @intCast(std.math.clamp(until - nowMs(), 0, std.math.maxInt(i32)));
    }

    // ------------------------------------------------------------ frames

    fn frame(a: std.mem.Allocator, entries: []const cbor.Entry) Value {
        return .{ .map = a.dupe(cbor.Entry, entries) catch &.{} };
    }

    fn notify(s: *Server, a: std.mem.Allocator, op: []const u8, payload: ?Value) void {
        var m = cbor.MapBuilder.init(a);
        m.put("op", cbor.string(op)) catch return;
        m.put("v", payload) catch return;
        ipc.write(io, s.to_peer, a, m.value()) catch |err| std.log.err("peer write: {s}", .{@errorName(err)});
    }

    fn reply(s: *Server, a: std.mem.Allocator, id: i64, ok: ?Value, err: ?[]const u8, rejected: ?[]const u8) void {
        var m = cbor.MapBuilder.init(a);
        m.put("re", cbor.int(id)) catch return;
        if (ok) |v| m.put("ok", v) catch return else if (err == null and rejected == null) m.put("ok", .null) catch return;
        m.put("error", cbor.optStr(err)) catch return;
        m.put("rejected", cbor.optStr(rejected)) catch return;
        ipc.write(io, s.to_peer, a, m.value()) catch |e| std.log.err("peer write: {s}", .{@errorName(e)});
    }

    /// A request to the peer; serves the peer's own requests while it waits.
    /// Requests nest (a `call` served while a step waits on the peer makes
    /// its own), and the peer answers in any order: an answer to another
    /// request is kept for it.
    fn request(s: *Server, a: std.mem.Allocator, op: []const u8, payload: Value) !Value {
        const id = s.next_id;
        s.next_id += 1;
        var m = cbor.MapBuilder.init(a);
        try m.put("id", cbor.int(id));
        try m.put("op", cbor.string(op));
        try m.put("v", payload);
        try ipc.write(io, s.to_peer, a, m.value());
        while (true) {
            const f = if (s.answers.fetchRemove(id)) |kv| blk: {
                defer s.gpa.free(kv.value);
                break :blk try cbor.decode(a, try a.dupe(u8, kv.value));
            } else (try s.from_peer.read(a)) orelse return error.PeerGone;
            if (Value.intOf(f.get("re"))) |re| {
                if (re != id) {
                    try s.answers.put(@intCast(re), try s.gpa.dupe(u8, try cbor.encode(a, f)));
                    continue;
                }
                if (Value.str(f.get("error"))) |e| {
                    last_peer_error = try a.dupe(u8, e);
                    return error.PeerError;
                }
                return f.get("ok") orelse .null;
            }
            s.onFrame(a, f);
        }
    }

    var last_peer_error: []const u8 = "";

    // ------------------------------------------------------------ the peer's requests

    fn onFrame(s: *Server, a: std.mem.Allocator, f: Value) void {
        const op = Value.str(f.get("op")) orelse return;
        const id = Value.intOf(f.get("id")) orelse 0;
        const v = f.get("v") orelse .null;
        s.handleOp(a, op, @intCast(id), v) catch |err| s.reply(a, @intCast(id), null, @errorName(err), null);
    }

    fn handleOp(s: *Server, a: std.mem.Allocator, op: []const u8, id: i64, v: Value) !void {
        const eq = std.mem.eql;
        if (eq(u8, op, "say")) {
            say(Value.str(v) orelse "");
        } else if (eq(u8, op, "fatal")) {
            die("{s}", .{Value.str(v) orelse "peer failed"});
        } else if (eq(u8, op, "tip")) {
            s.reply(a, id, cbor.optCid(try s.store.logTip(a)) orelse .null, null, null);
        } else if (eq(u8, op, "get")) {
            const c = Value.cidOf(v) orelse return error.BadRequest;
            s.reply(a, id, (try s.store.get(a, c)) orelse .null, null, null);
        } else if (eq(u8, op, "put")) {
            s.reply(a, id, cbor.cidv(try s.store.put(a, v)), null, null);
        } else if (eq(u8, op, "has")) {
            // Any block, whatever its codec (`get` decodes dag-cbor).
            const c = Value.cidOf(v) orelse return error.BadRequest;
            s.reply(a, id, .{ .bool = try s.store.has(c) }, null, null);
        } else if (eq(u8, op, "putblock")) {
            // The loader's pre-fill (issue #4): a block minted elsewhere (git-raw, raw,
            // dag-cbor, bitcoin-tx/-block), hash-checked against its CID before it is kept.
            const c = Value.cidOf(v.get("cid")) orelse return error.BadRequest;
            const b = Value.bytesOf(v.get("bytes")) orelse return error.BadRequest;
            if (!cidm.hashMatches(c, b)) return s.reply(a, id, null, try std.fmt.allocPrint(a, "putblock: bytes do not hash to {s}", .{try cidm.format(a, c)}), null);
            try s.store.putBlock(c, b);
            s.reply(a, id, cbor.cidv(c), null, null);
        } else if (eq(u8, op, "restore")) {
            // A checkpoint (issue #4): its blocks already put, the state record becomes this store's state.
            const c = Value.cidOf(v) orelse return error.BadRequest;
            try s.ss.restore(c);
            s.reply(a, id, cbor.cidv(c), null, null);
        } else if (eq(u8, op, "append")) {
            switch (try s.store.logAppend(a, v)) {
                .ok => |c| s.reply(a, id, cbor.cidv(c), null, null),
                .rejected => |r| s.reply(a, id, null, r.message, r.reason.text()),
            }
        } else if (eq(u8, op, "programs")) {
            // The programs this kernel pins (a genesis's `programs`): their records put, name → CID.
            // With a list of names, only those (a system tree takes just the shell: no stray records, #36).
            var m = cbor.MapBuilder.init(a);
            for (programsm.program_names) |name| {
                if (v == .array) {
                    var wanted = false;
                    for (v.array) |x| wanted = wanted or std.mem.eql(u8, Value.str(x) orelse "", name);
                    if (!wanted) continue;
                }
                try m.put(name, cbor.cidv(try s.store.put(a, try programsm.program(a, name))));
            }
            s.reply(a, id, m.value(), null, null);
        } else if (eq(u8, op, "head")) {
            // A named head's record, read (the router reads the messagebox's `mailbox` head).
            const name = Value.str(v) orelse return error.BadRequest;
            s.reply(a, id, cbor.optCid(try s.store.headTree(a, name)) orelse .null, null, null);
        } else if (eq(u8, op, "genesis")) {
            s.reply(a, id, logm.genesisOf(a, s.store) catch .null, null, null);
        } else if (eq(u8, op, "dispatch")) {
            // The dispatch table as it stands (#77): {tip: <the chain's tip, the change key> | null, rows}.
            const rows = (try dispatchm.current(a, s.store)) orelse &.{};
            var m = cbor.MapBuilder.init(a);
            try m.put("tip", cbor.optCid(try s.store.chainTip(a, try dispatchm.origin(a))) orelse .null);
            try m.put("rows", try dispatchm.valueOf(a, rows));
            s.reply(a, id, m.value(), null, null);
        } else if (eq(u8, op, "boxes")) {
            const bs = try s.rt.boxes(a);
            const arr = try a.alloc(Value, bs.len);
            for (bs, 0..) |b, i| arr[i] = cbor.string(b);
            s.reply(a, id, .{ .array = arr }, null, null);
        } else if (eq(u8, op, "byEnvelope")) {
            const c = Value.cidOf(v) orelse return error.BadRequest;
            s.reply(a, id, cbor.optCid(try s.store.byEnvelope(a, c)) orelse .null, null, null);
        } else if (eq(u8, op, "admit")) {
            const entry = v.get("entry") orelse return error.BadRequest;
            const res = try s.rt.admit(a, entry, Value.bytesOf(v.get("body")));
            switch (res) {
                .ok => |c| s.reply(a, id, cbor.cidv(c), null, null),
                .rejected => |r| s.reply(a, id, null, r.message, r.reason.text()),
                .invalid => |m| s.reply(a, id, null, m, null),
            }
            // Now process it (mid-step, a drain is running: it loops again when the step is done).
            if (res == .ok) s.rt.kick();
            s.afterDrain(a);
        } else if (eq(u8, op, "call")) {
            // The other call in (#40): a program's function over the current state; no entry, no writes.
            // {program: cid | a genesis program's name, fn, arg: bytes, caller?: bytes, now?: ms}
            //   → {ok: true, result: bytes, fuel} | {ok: false, error, fuel}
            try s.rt.loadGenesis();
            const g = s.rt.genesis orelse return s.reply(a, id, null, "call: no genesis", null);
            const prog: []const u8 = Value.cidOf(v.get("program")) orelse blk: {
                const name = Value.str(v.get("program")) orelse return error.BadRequest;
                const progs: Value = g.get("programs") orelse .null;
                break :blk Value.cidOf(if (progs == .map) progs.get(name) else null) orelse
                    return s.reply(a, id, null, try std.fmt.allocPrint(a, "call: no program {s} in the genesis", .{name}), null);
            };
            const func = Value.str(v.get("fn")) orelse return error.BadRequest;
            const arg = Value.bytesOf(v.get("arg")) orelse "";
            const now = Value.intOf(v.get("now")) orelse std.Io.Clock.real.now(io).toMilliseconds();
            const r = try s.rt.call(a, prog, func, arg, Value.bytesOf(v.get("caller")), @intCast(now));
            var m = cbor.MapBuilder.init(a);
            try m.put("ok", .{ .bool = r.ok });
            if (r.ok) try m.put("result", .{ .bytes = r.result }) else try m.put("error", cbor.string(r.err));
            try m.put("fuel", cbor.int(r.fuel));
            s.reply(a, id, m.value(), null, null);
        } else if (eq(u8, op, "answer")) {
            // #66: a synchronous client waits on the thread its request entry launched.
            // {entry, wait: ms} → {thread, state: "finished", answer: bytes} | {thread, state: "errored", error}
            //   — when that thread comes to rest for good — or, `wait` ms on, the state as it stands
            //   ({thread, state: "waiting"}, or {state: "pending"}: the entry not yet processed).
            const entry = Value.cidOf(v.get("entry")) orelse return error.BadRequest;
            const wait = Value.intOf(v.get("wait")) orelse 120_000;
            if (try s.rt.requestThread(a, entry)) |t| {
                const r = try s.rt.answerOf(a, t);
                if (eq(u8, r.state, "finished") or eq(u8, r.state, "errored")) return s.reply(a, id, try s.answerValue(a, t), null, null);
            }
            try s.waiters.append(.{ .id = id, .entry = try s.gpa.dupe(u8, entry), .until = nowMs() + @as(i64, @intCast(@max(0, wait))) });
        } else if (eq(u8, op, "idle")) {
            try s.idle_waiters.append(id);
            s.afterDrain(a);
        } else if (eq(u8, op, "start")) {
            s.rt.start() catch |err| die("{s}@{s}: {s}", .{ s.handle, s.domain, @errorName(err) });
            s.reply(a, id, .null, null, null);
            s.rt.kick();
            s.afterDrain(a);
        } else if (eq(u8, op, "running")) {
            s.running = true;
            const ident = Value.str(v) orelse "";
            sayf("skein runtime {s} ({s}@{s}) · pid {d} · db {s}", .{ ident, s.handle, s.domain, std.c.getpid(), s.db_path });
        } else {
            s.reply(a, id, null, "unknown op", null);
        }
    }

    /// After processing: whoever waits for idle.
    fn afterDrain(s: *Server, a: std.mem.Allocator) void {
        if (s.rt.draining) return;
        for (s.idle_waiters.items) |w| s.reply(a, w, .null, null, null);
        s.idle_waiters.clearRetainingCapacity();
    }

    // ------------------------------------------------------------ the runtime's peers

    fn ctx(p: *anyopaque) *Server {
        return @ptrCast(@alignCast(p));
    }

    fn pWallet(p: *anyopaque, a: std.mem.Allocator, fr: []const u8) anyerror![]u8 {
        const r = try ctx(p).request(a, "wallet", .{ .bytes = fr });
        return @constCast(Value.bytesOf(r) orelse return error.BadAnswer);
    }

    /// A message (#70) or an event (#65) for the host to carry out, told once
    /// its step is committed: {message: <the signed mail record | the event
    /// record>, body: bytes, transport, address} (an event: transport
    /// "event", address its kind, body the transaction). Nothing comes back:
    /// the answer, if any, is an entry.
    fn pEmit(p: *anyopaque, o: scheduler.Outgoing) void {
        const s = ctx(p);
        var arena = std.heap.ArenaAllocator.init(s.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        var m = cbor.MapBuilder.init(a);
        m.put("message", cbor.decode(a, o.message) catch return) catch return;
        m.put("body", .{ .bytes = o.body }) catch return;
        m.put("transport", cbor.string(o.transport)) catch return;
        m.put("address", cbor.string(o.address)) catch return;
        s.notify(a, "emit", m.value());
    }

    /// A request's thread came to rest (#66): its waiters are answered now, mid-drain.
    fn pOnAnswer(p: *anyopaque, thread: []const u8, entry: []const u8) void {
        const s = ctx(p);
        var arena = std.heap.ArenaAllocator.init(s.gpa);
        defer arena.deinit();
        s.answered(arena.allocator(), thread, entry);
    }

    fn pSay(_: *anyopaque, line: []const u8) void {
        say(line);
    }
};

pub fn main(gpa: std.mem.Allocator, process_io: std.Io) !void {
    io = process_io;
    const home = envm.get("SKEIN_HOME") orelse try std.fmt.allocPrint(gpa, "{s}/.skein", .{envm.get("HOME") orelse "."});
    const db_path = envm.get("SKEIN_DB") orelse try std.fmt.allocPrint(gpa, "{s}/runtime.db", .{home});
    const handle_full = envm.get("SKEIN_HANDLE") orelse "skein@localhost";
    var handle: []const u8 = handle_full;
    var domain: []const u8 = "localhost";
    if (std.mem.indexOfScalar(u8, handle_full, '@')) |i| {
        handle = handle_full[0..i];
        const rest = handle_full[i + 1 ..];
        domain = rest[0 .. std.mem.indexOfScalar(u8, rest, '@') orelse rest.len];
    }

    // Signals.
    if (std.posix.errno(std.posix.system.pipe2(&sig_pipe, .{ .CLOEXEC = true, .NONBLOCK = true })) != .SUCCESS) die("{s}@{s}: pipe2 failed", .{ handle, domain });
    const sa = std.posix.Sigaction{ .handler = .{ .handler = onSignal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.INT, &sa, null);
    std.posix.sigaction(std.posix.SIG.TERM, &sa, null);
    const ign = std.posix.Sigaction{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.PIPE, &ign, null);

    // The store, with the pinned modules installed.
    if (std.fs.path.dirname(db_path)) |d| std.Io.Dir.cwd().createDirPath(io, d) catch {};
    const ss = SqliteStore.open(gpa, io, db_path) catch |err| die("{s}@{s}: {s}: {s}", .{ handle, domain, db_path, @errorName(err) });
    replay.install(gpa, io, ss, say) catch |err| die("{s}@{s}: install: {s}", .{ handle, domain, @errorName(err) });

    const r = try runner.Runner.init(gpa);
    var server = Server{
        .gpa = gpa,
        .ss = ss,
        .store = ss.store(),
        .rt = undefined,
        .to_peer = std.Io.File.stdout(),
        .from_peer = ipc.Reader.init(gpa, std.posix.STDIN_FILENO),
        .idle_waiters = .init(gpa),
        .answers = .init(gpa),
        .waiters = .init(gpa),
        .handle = handle,
        .domain = domain,
        .db_path = db_path,
    };
    server.rt = try scheduler.Runtime.init(gpa, server.store, r, .{
        .ctx = &server,
        .wallet = Server.pWallet,
        .emit = Server.pEmit,
        .on_answer = Server.pOnAnswer,
        .say = Server.pSay,
        .io = io,
    });

    var fds_buf: [2]std.posix.pollfd = undefined;
    while (true) {
        fds_buf[0] = .{ .fd = server.from_peer.fd, .events = std.posix.POLL.IN, .revents = 0 };
        fds_buf[1] = .{ .fd = sig_pipe[0], .events = std.posix.POLL.IN, .revents = 0 };
        _ = try std.posix.poll(&fds_buf, server.pollTimeout());
        if (server.waiters.items.len > 0) {
            var arena = std.heap.ArenaAllocator.init(gpa);
            defer arena.deinit();
            server.expire(arena.allocator());
        }
        if (fds_buf[1].revents != 0) {
            var b: [16]u8 = undefined;
            _ = std.posix.read(sig_pipe[0], &b) catch {};
            sayf("{s}: stopping", .{sig_name});
            var arena = std.heap.ArenaAllocator.init(gpa);
            defer arena.deinit();
            server.notify(arena.allocator(), "stop", null);
            break;
        }
        if (fds_buf[0].revents != 0) {
            // EOF: the router closed the channel (an idle stop, or it is gone).
            if (!try server.from_peer.fill()) break;
            while (true) {
                var arena = std.heap.ArenaAllocator.init(gpa);
                defer arena.deinit();
                const a = arena.allocator();
                const b = (try server.from_peer.next(a)) orelse break;
                const f = cbor.decode(a, b) catch continue;
                server.onFrame(a, f);
            }
        }
    }
    server.rt.stop();
    ss.close();
    std.process.exit(0);
}
