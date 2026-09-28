// `skein-kernel serve`: one instance's kernel, driven by the router
// (src/host/kernel.ts, issue #33) over its stdin/stdout: length-prefixed
// dag-cbor frames (ipc.zig). The router hydrates an instance by starting this
// process and stops it by closing stdin (or SIGTERM) once it is idle.
//
// The kernel is this process: the store, the log, the scheduler, the
// programs. Everything outside is the router's: it admits entries (the one
// call in), answers the kernel's `wallet` and `resolve` requests (the oracle
// and the resolver), carries its emits (`send`) and keeps its earliest
// sleeper deadline (`sleepers`) to wake it. Log lines go to stderr.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const ipc = @import("ipc.zig");
const logm = @import("log.zig");
const programsm = @import("programs.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const replay = @import("replay.zig");
const storem = @import("store.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Value = cbor.Value;

var sig_pipe: [2]std.posix.fd_t = .{ -1, -1 };
var sig_name: []const u8 = "";

fn onSignal(sig: c_int) callconv(.c) void {
    sig_name = if (sig == std.posix.SIG.INT) "SIGINT" else "SIGTERM";
    _ = std.posix.write(sig_pipe[1], "x") catch {};
}

fn say(line: []const u8) void {
    var f = std.fs.File.stderr();
    f.writeAll(line) catch {};
    f.writeAll("\n") catch {};
}

fn sayf(comptime fmt: []const u8, args: anytype) void {
    var buf: [4096]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch return;
    say(s);
}

fn die(comptime fmt: []const u8, args: anytype) noreturn {
    var buf: [4096]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "skein-runtime: " ++ fmt ++ "\n", args) catch "skein-runtime: error\n";
    std.fs.File.stderr().writeAll(s) catch {};
    std.process.exit(1);
}

const Server = struct {
    gpa: std.mem.Allocator,
    ss: *SqliteStore,
    store: storem.Store,
    rt: *scheduler.Runtime,
    to_peer: std.posix.fd_t,
    from_peer: ipc.Reader,
    next_id: i64 = 1,
    idle_waiters: std.array_list.Managed(i64),
    last_sleepers: []u8 = "",
    handle: []const u8,
    domain: []const u8,
    db_path: []const u8,
    running: bool = false,

    // ------------------------------------------------------------ frames

    fn frame(a: std.mem.Allocator, entries: []const cbor.Entry) Value {
        return .{ .map = a.dupe(cbor.Entry, entries) catch &.{} };
    }

    fn notify(s: *Server, a: std.mem.Allocator, op: []const u8, payload: ?Value) void {
        var m = cbor.MapBuilder.init(a);
        m.put("op", cbor.string(op)) catch return;
        m.put("v", payload) catch return;
        ipc.write(s.to_peer, a, m.value()) catch |err| std.log.err("peer write: {s}", .{@errorName(err)});
    }

    fn reply(s: *Server, a: std.mem.Allocator, id: i64, ok: ?Value, err: ?[]const u8, rejected: ?[]const u8) void {
        var m = cbor.MapBuilder.init(a);
        m.put("re", cbor.int(id)) catch return;
        if (ok) |v| m.put("ok", v) catch return else if (err == null and rejected == null) m.put("ok", .null) catch return;
        m.put("error", cbor.optStr(err)) catch return;
        m.put("rejected", cbor.optStr(rejected)) catch return;
        ipc.write(s.to_peer, a, m.value()) catch |e| std.log.err("peer write: {s}", .{@errorName(e)});
    }

    /// A request to the peer; serves the peer's own requests while it waits.
    fn request(s: *Server, a: std.mem.Allocator, op: []const u8, payload: Value) !Value {
        const id = s.next_id;
        s.next_id += 1;
        var m = cbor.MapBuilder.init(a);
        try m.put("id", cbor.int(id));
        try m.put("op", cbor.string(op));
        try m.put("v", payload);
        try ipc.write(s.to_peer, a, m.value());
        while (true) {
            const f = (try s.from_peer.read(a)) orelse return error.PeerGone;
            if (Value.intOf(f.get("re"))) |re| {
                if (re != id) continue;
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
            var m = cbor.MapBuilder.init(a);
            for (programsm.program_names) |name| try m.put(name, cbor.cidv(try s.store.put(a, try programsm.program(a, name))));
            s.reply(a, id, m.value(), null, null);
        } else if (eq(u8, op, "head")) {
            // A named head's record, read (the router reads the messagebox's `mailbox` head).
            const name = Value.str(v) orelse return error.BadRequest;
            s.reply(a, id, cbor.optCid(try s.store.headTree(a, name)) orelse .null, null, null);
        } else if (eq(u8, op, "genesis")) {
            s.reply(a, id, logm.genesisOf(a, s.store) catch .null, null, null);
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
            const res = try s.rt.admit(a, entry, v.get("envelope"), Value.bytesOf(v.get("body")));
            switch (res) {
                .ok => |c| s.reply(a, id, cbor.cidv(c), null, null),
                .rejected => |r| s.reply(a, id, null, r.message, r.reason.text()),
                .invalid => |m| s.reply(a, id, null, m, null),
            }
            // Now process it (mid-step, a drain is running: it loops again when the step is done).
            if (res == .ok) s.rt.kick();
            s.afterDrain(a);
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

    /// After processing: the tick's view of the sleepers, and whoever waits for idle.
    fn afterDrain(s: *Server, a: std.mem.Allocator) void {
        if (s.rt.draining) return;
        s.syncSleepers(a);
        for (s.idle_waiters.items) |w| s.reply(a, w, .null, null, null);
        s.idle_waiters.clearRetainingCapacity();
    }

    fn syncSleepers(s: *Server, a: std.mem.Allocator) void {
        const due = s.rt.sleepersDue(a) catch return;
        var list = std.array_list.Managed(Value).init(a);
        for (due) |d| {
            var m = cbor.MapBuilder.init(a);
            m.put("thread", cbor.cidv(d.thread)) catch return;
            m.put("until", cbor.int(d.until)) catch return;
            list.append(m.value()) catch return;
        }
        const v = Value{ .array = list.items };
        const enc = cbor.encode(a, v) catch return;
        if (std.mem.eql(u8, enc, s.last_sleepers)) return;
        s.gpa.free(s.last_sleepers);
        s.last_sleepers = s.gpa.dupe(u8, enc) catch "";
        s.notify(a, "sleepers", v);
    }

    // ------------------------------------------------------------ the runtime's peers

    fn ctx(p: *anyopaque) *Server {
        return @ptrCast(@alignCast(p));
    }

    fn pWallet(p: *anyopaque, a: std.mem.Allocator, fr: []const u8) anyerror![]u8 {
        const r = try ctx(p).request(a, "wallet", .{ .bytes = fr });
        return @constCast(Value.bytesOf(r) orelse return error.BadAnswer);
    }

    /// A program's http request (#29, pre-#15): the peer performs it (or refuses).
    fn pHttp(p: *anyopaque, a: std.mem.Allocator, req: []const u8) anyerror![]u8 {
        const r = try ctx(p).request(a, "http", .{ .bytes = req });
        return @constCast(Value.bytesOf(r) orelse return error.BadAnswer);
    }

    fn pResolve(p: *anyopaque, a: std.mem.Allocator, h: []const u8, d: []const u8) Value {
        var m = cbor.MapBuilder.init(a);
        m.put("handle", cbor.string(h)) catch {};
        m.put("domain", cbor.string(d)) catch {};
        return ctx(p).request(a, "resolve", m.value()) catch |err| blk: {
            var e = cbor.MapBuilder.init(a);
            e.put("identityKey", .{ .bytes = "" }) catch {};
            e.put("error", cbor.string(if (err == error.PeerError) last_peer_error else @errorName(err))) catch {};
            break :blk e.value();
        };
    }

    fn pSend(p: *anyopaque, a: std.mem.Allocator, o: Value) anyerror!void {
        ctx(p).notify(a, "send", o);
    }

    fn pOnSleep(p: *anyopaque, _: []const u8, _: i64) void {
        const s = ctx(p);
        var arena = std.heap.ArenaAllocator.init(s.gpa);
        defer arena.deinit();
        s.syncSleepers(arena.allocator());
        s.notify(arena.allocator(), "onSleep", null);
    }

    fn pSay(_: *anyopaque, line: []const u8) void {
        say(line);
    }
};

pub fn main(gpa: std.mem.Allocator) !void {
    const home = std.posix.getenv("SKEIN_HOME") orelse try std.fmt.allocPrint(gpa, "{s}/.skein", .{std.posix.getenv("HOME") orelse "."});
    const db_path = std.posix.getenv("SKEIN_DB") orelse try std.fmt.allocPrint(gpa, "{s}/runtime.db", .{home});
    const handle_full = std.posix.getenv("SKEIN_HANDLE") orelse "skein@localhost";
    var handle: []const u8 = handle_full;
    var domain: []const u8 = "localhost";
    if (std.mem.indexOfScalar(u8, handle_full, '@')) |i| {
        handle = handle_full[0..i];
        const rest = handle_full[i + 1 ..];
        domain = rest[0 .. std.mem.indexOfScalar(u8, rest, '@') orelse rest.len];
    }

    // Signals.
    sig_pipe = try std.posix.pipe2(.{ .CLOEXEC = true, .NONBLOCK = true });
    const sa = std.posix.Sigaction{ .handler = .{ .handler = onSignal }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.INT, &sa, null);
    std.posix.sigaction(std.posix.SIG.TERM, &sa, null);
    const ign = std.posix.Sigaction{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.PIPE, &ign, null);

    // The store, with the pinned modules installed.
    if (std.fs.path.dirname(db_path)) |d| std.fs.cwd().makePath(d) catch {};
    const ss = SqliteStore.open(gpa, db_path) catch |err| die("{s}@{s}: {s}: {s}", .{ handle, domain, db_path, @errorName(err) });
    replay.install(gpa, ss, say) catch |err| die("{s}@{s}: install: {s}", .{ handle, domain, @errorName(err) });

    const r = try runner.Runner.init(gpa);
    var server = Server{
        .gpa = gpa,
        .ss = ss,
        .store = ss.store(),
        .rt = undefined,
        .to_peer = std.posix.STDOUT_FILENO,
        .from_peer = ipc.Reader.init(gpa, std.posix.STDIN_FILENO),
        .idle_waiters = .init(gpa),
        .handle = handle,
        .domain = domain,
        .db_path = db_path,
    };
    server.rt = try scheduler.Runtime.init(gpa, server.store, r, .{
        .ctx = &server,
        .wallet = Server.pWallet,
        .resolve = Server.pResolve,
        .http = Server.pHttp,
        .send = Server.pSend,
        .on_sleep = Server.pOnSleep,
        .say = Server.pSay,
    });

    var fds_buf: [2]std.posix.pollfd = undefined;
    while (true) {
        fds_buf[0] = .{ .fd = server.from_peer.fd, .events = std.posix.POLL.IN, .revents = 0 };
        fds_buf[1] = .{ .fd = sig_pipe[0], .events = std.posix.POLL.IN, .revents = 0 };
        _ = try std.posix.poll(&fds_buf, -1);
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
