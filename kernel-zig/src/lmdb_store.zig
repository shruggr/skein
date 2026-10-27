// The store in one LMDB environment shared by every instance of a host
// (#96, #133): one block table, a member set per instance as the read gate.
// The environment is a directory ($SKEIN_HOME/store/: data.mdb, lock.mdb),
// opened by every `skein-kernel serve` of the host and read by the host
// (lmdb-js, src/runtime/index-store.ts). LMDB is multi-process: readers never
// block; one writer at a time across the environment.
//
//   blocks    cid → bytes                 every block once, content-addressed (never overwritten)
//   members   <set> ‖ 0x00 ‖ cid → ∅      what the set holds
//   pointers  <set> ‖ 0x00 ‖ name → cid   the set's pointers (index.POINTER), and `size`
//
// A set is the instance's handle. The reserved set `host/chain` is the one
// exception to the gate: every set's read checks its own members, then the
// chain's (the host's chain service writes it, #156; nothing here does). A
// block in `blocks` that is in neither set is absent for this instance: the
// gate decides presence, never content.
//
// `size` (#130) is the set's share: the bytes of every block it holds, counted
// once per set as each membership is added (u64 big-endian under the pointer
// name `size`), not the environment's file size.
//
// The index (index.zig) brackets every commit in begin … commit: the write
// transaction is held only across a commit. A put outside one is its own
// write transaction, as SQLite's autocommit is.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const storem = @import("store.zig");
const index = @import("index.zig");
const Value = cbor.Value;
pub const c = @cImport(@cInclude("lmdb.h"));

/// The chain's member set (#133): readable by every set; written by the host's chain service only.
pub const CHAIN_SET = "host/chain";
/// The pointer name of a set's size counter.
pub const SIZE = "size";
/// 1 TiB: address space reserved, nothing on disk until used.
pub const MAP_SIZE: usize = 1 << 40;
/// One reader slot per process with a read transaction open: thousands of serve processes is the target.
pub const MAX_READERS: c_uint = 4096;

pub const Error = error{Lmdb};

fn check(rc: c_int) Error!void {
    if (rc == 0) return;
    std.log.err("lmdb: {s}", .{std.mem.span(c.mdb_strerror(rc))});
    return error.Lmdb;
}

fn val(b: []const u8) c.MDB_val {
    return .{ .mv_size = b.len, .mv_data = @constCast(@ptrCast(b.ptr)) };
}

fn bytesOf(v: c.MDB_val) []const u8 {
    if (v.mv_size == 0) return &.{};
    return @as([*]const u8, @ptrCast(v.mv_data.?))[0..v.mv_size];
}

/// One LMDB environment, opened once per process (LMDB forbids opening it twice in one process).
pub const Env = struct {
    env: *c.MDB_env,
    blocks: c.MDB_dbi,
    members: c.MDB_dbi,
    pointers: c.MDB_dbi,
    read_only: bool,
    /// The write transaction a store of this process holds (one at a time per environment).
    wtxn: ?*c.MDB_txn = null,

    /// The environment at `dir`, created (the directory and the three tables) unless read only.
    pub fn open(alloc: std.mem.Allocator, io: std.Io, dir: []const u8, read_only: bool) !*Env {
        if (!read_only) std.Io.Dir.cwd().createDirPath(io, dir) catch {};
        var e: ?*c.MDB_env = null;
        try check(c.mdb_env_create(&e));
        errdefer c.mdb_env_close(e);
        try check(c.mdb_env_set_maxdbs(e, 4));
        try check(c.mdb_env_set_mapsize(e, MAP_SIZE));
        try check(c.mdb_env_set_maxreaders(e, MAX_READERS));
        const z = try alloc.dupeZ(u8, dir);
        defer alloc.free(z);
        // NOTLS: read transactions are not bound to threads. NOMETASYNC: one flush per commit, the
        // meta page's deferred — a system crash may undo the last commit, never corrupt (SQLite's WAL
        // with synchronous = NORMAL keeps the same promise).
        var flags: c_uint = c.MDB_NOTLS | c.MDB_NOMETASYNC;
        if (read_only) flags |= c.MDB_RDONLY;
        const rc = c.mdb_env_open(e, z.ptr, flags, 0o644);
        if (rc != 0) {
            std.log.err("lmdb: {s}: {s}", .{ dir, std.mem.span(c.mdb_strerror(rc)) });
            return error.Lmdb;
        }
        var dead: c_int = 0;
        _ = c.mdb_reader_check(e, &dead); // slots of processes gone
        const env = try alloc.create(Env);
        errdefer alloc.destroy(env);
        env.* = .{ .env = e.?, .blocks = 0, .members = 0, .pointers = 0, .read_only = read_only };
        var t: ?*c.MDB_txn = null;
        try check(c.mdb_txn_begin(e, null, if (read_only) c.MDB_RDONLY else 0, &t));
        errdefer c.mdb_txn_abort(t);
        const create: c_uint = if (read_only) 0 else c.MDB_CREATE;
        try check(c.mdb_dbi_open(t, "blocks", create, &env.blocks));
        try check(c.mdb_dbi_open(t, "members", create, &env.members));
        try check(c.mdb_dbi_open(t, "pointers", create, &env.pointers));
        try check(c.mdb_txn_commit(t));
        return env;
    }

    pub fn close(env: *Env, alloc: std.mem.Allocator) void {
        if (env.wtxn) |t| c.mdb_txn_abort(t);
        c.mdb_env_close(env.env);
        alloc.destroy(env);
    }
};

pub const LmdbStore = struct {
    env: *Env,
    owns_env: bool,
    alloc: std.mem.Allocator,
    ix: *index.Index,
    read_only: bool,
    /// The set's name, `<set> ‖ 0x00` (the key prefix of its members and pointers).
    prefix: []u8,
    /// The chain's prefix, `host/chain ‖ 0x00`.
    chain_prefix: []const u8 = CHAIN_SET ++ "\x00",
    /// A read transaction kept reset between reads (renewed for each: the latest commit).
    rtxn: ?*c.MDB_txn = null,
    /// This store's own write transaction, between begin and commit.
    in_txn: bool = false,
    /// Key scratch: prefix ‖ cid or prefix ‖ name.
    key_buf: std.array_list.Managed(u8),

    /// The set `set` in the environment at `dir`, created if missing.
    pub fn open(alloc: std.mem.Allocator, io: std.Io, dir: []const u8, set: []const u8) !*LmdbStore {
        const env = try Env.open(alloc, io, dir, false);
        errdefer env.close(alloc);
        return init(alloc, env, true, set, false);
    }

    /// An existing environment's set for reading only (nothing is written).
    pub fn openReadOnly(alloc: std.mem.Allocator, io: std.Io, dir: []const u8, set: []const u8) !*LmdbStore {
        const env = try Env.open(alloc, io, dir, true);
        errdefer env.close(alloc);
        return init(alloc, env, true, set, true);
    }

    /// A set in an environment this process already holds open (the migrate tool, the tests).
    pub fn openIn(alloc: std.mem.Allocator, env: *Env, set: []const u8) !*LmdbStore {
        return init(alloc, env, false, set, env.read_only);
    }

    fn init(alloc: std.mem.Allocator, env: *Env, owns_env: bool, set: []const u8, read_only: bool) !*LmdbStore {
        if (set.len == 0 or std.mem.indexOfScalar(u8, set, 0) != null) return error.BadSet;
        const s = try alloc.create(LmdbStore);
        errdefer alloc.destroy(s);
        const prefix = try std.mem.concat(alloc, u8, &.{ set, "\x00" });
        errdefer alloc.free(prefix);
        s.* = .{ .env = env, .owns_env = owns_env, .alloc = alloc, .ix = undefined, .read_only = read_only, .prefix = prefix, .key_buf = .init(alloc) };
        errdefer s.key_buf.deinit();
        s.ix = try index.Index.init(alloc, s.backend(), read_only);
        errdefer s.ix.deinit();
        _ = try s.ix.load();
        return s;
    }

    /// No store in an environment holds the format before #30 (only this kernel writes one; the
    /// migrate tool refuses an older SQLite store), so nothing here predates fuel.
    pub fn predatesFuel(_: *LmdbStore) bool {
        return false;
    }

    pub fn close(s: *LmdbStore) void {
        s.ix.commitAll() catch |err| std.log.err("store: final commit: {s}", .{@errorName(err)});
        s.ix.deinit();
        if (s.rtxn) |t| c.mdb_txn_abort(t);
        if (s.owns_env) s.env.close(s.alloc);
        s.key_buf.deinit();
        s.alloc.free(s.prefix);
        s.alloc.destroy(s);
    }

    pub fn store(s: *LmdbStore) storem.Store {
        return s.ix.store();
    }

    /// The set's name (its prefix without the separator).
    pub fn setName(s: *LmdbStore) []const u8 {
        return s.prefix[0 .. s.prefix.len - 1];
    }

    // -------------------------------------------------------- transactions

    /// The transaction a read runs in: this store's write transaction, else the renewed read one.
    fn readTxn(s: *LmdbStore) !*c.MDB_txn {
        if (s.in_txn) return s.env.wtxn.?;
        if (s.rtxn) |t| {
            try check(c.mdb_txn_renew(t));
            return t;
        }
        var t: ?*c.MDB_txn = null;
        try check(c.mdb_txn_begin(s.env.env, null, c.MDB_RDONLY, &t));
        s.rtxn = t;
        return t.?;
    }

    fn doneReading(s: *LmdbStore) void {
        if (s.in_txn) return;
        if (s.rtxn) |t| c.mdb_txn_reset(t);
    }

    fn key(s: *LmdbStore, prefix: []const u8, rest: []const u8) ![]const u8 {
        s.key_buf.clearRetainingCapacity();
        try s.key_buf.appendSlice(prefix);
        try s.key_buf.appendSlice(rest);
        return s.key_buf.items;
    }

    fn present(s: *LmdbStore, t: *c.MDB_txn, d: c.MDB_dbi, k: []const u8) !bool {
        _ = s;
        var kv = val(k);
        var v: c.MDB_val = undefined;
        const rc = c.mdb_get(t, d, &kv, &v);
        if (rc == c.MDB_NOTFOUND) return false;
        try check(rc);
        return true;
    }

    /// The gate: the set's own members, then the chain's.
    fn member(s: *LmdbStore, t: *c.MDB_txn, cid: []const u8) !bool {
        if (try s.present(t, s.env.members, try s.key(s.prefix, cid))) return true;
        return s.present(t, s.env.members, try s.key(s.chain_prefix, cid));
    }

    // -------------------------------------------------------- the backend

    fn backend(s: *LmdbStore) index.Backend {
        return .{ .ctx = s, .vt = &backend_vt };
    }

    const backend_vt = index.Backend.VT{
        .get = getFn,
        .has = hasFn,
        .put = putFn,
        .begin = beginFn,
        .commit = commitFn,
        .rollback = rollbackFn,
        .pointer = pointerFn,
        .setPointer = setPointerFn,
        .size = sizeFn,
    };

    fn self(ctx: *anyopaque) *LmdbStore {
        return @ptrCast(@alignCast(ctx));
    }

    fn getFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const s = self(ctx);
        const t = try s.readTxn();
        defer s.doneReading();
        if (!try s.member(t, cid)) return null;
        var kv = val(cid);
        var v: c.MDB_val = undefined;
        const rc = c.mdb_get(t, s.env.blocks, &kv, &v);
        if (rc == c.MDB_NOTFOUND) return null;
        try check(rc);
        return try a.dupe(u8, bytesOf(v));
    }

    fn hasFn(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        const s = self(ctx);
        const t = try s.readTxn();
        defer s.doneReading();
        if (!try s.member(t, cid)) return false;
        return s.present(t, s.env.blocks, cid);
    }

    /// The block once (never overwritten), then the membership; a new membership adds the
    /// block's length to the set's size.
    fn putIn(s: *LmdbStore, t: *c.MDB_txn, cid: []const u8, b: []const u8) !void {
        var kb = val(cid);
        var vb = val(b);
        const rb = c.mdb_put(t, s.env.blocks, &kb, &vb, c.MDB_NOOVERWRITE);
        if (rb != c.MDB_KEYEXIST) try check(rb);
        var km = val(try s.key(s.prefix, cid));
        var empty = val(&.{});
        const rm = c.mdb_put(t, s.env.members, &km, &empty, c.MDB_NOOVERWRITE);
        if (rm == c.MDB_KEYEXIST) return;
        try check(rm);
        const was = try s.sizeIn(t);
        var n: [8]u8 = undefined;
        std.mem.writeInt(u64, &n, was + b.len, .big);
        try s.putPointerIn(t, SIZE, &n);
    }

    fn putFn(ctx: *anyopaque, cid: []const u8, b: []const u8) anyerror!void {
        const s = self(ctx);
        if (s.read_only) return error.ReadOnly;
        if (s.in_txn) return s.putIn(s.env.wtxn.?, cid, b);
        var t: ?*c.MDB_txn = null;
        try check(c.mdb_txn_begin(s.env.env, null, 0, &t));
        errdefer c.mdb_txn_abort(t);
        try s.putIn(t.?, cid, b);
        try check(c.mdb_txn_commit(t));
    }

    fn beginFn(ctx: *anyopaque) anyerror!void {
        const s = self(ctx);
        if (s.read_only) return error.ReadOnly;
        if (s.env.wtxn != null) return error.TransactionOpen;
        var t: ?*c.MDB_txn = null;
        try check(c.mdb_txn_begin(s.env.env, null, 0, &t));
        s.env.wtxn = t;
        s.in_txn = true;
    }

    fn commitFn(ctx: *anyopaque) anyerror!void {
        const s = self(ctx);
        const t = s.env.wtxn orelse return error.NoTransaction;
        s.env.wtxn = null;
        s.in_txn = false;
        try check(c.mdb_txn_commit(t));
    }

    fn rollbackFn(ctx: *anyopaque) void {
        const s = self(ctx);
        if (!s.in_txn) return;
        if (s.env.wtxn) |t| c.mdb_txn_abort(t);
        s.env.wtxn = null;
        s.in_txn = false;
    }

    fn pointerIn(s: *LmdbStore, t: *c.MDB_txn, name: []const u8) !?[]const u8 {
        var kv = val(try s.key(s.prefix, name));
        var v: c.MDB_val = undefined;
        const rc = c.mdb_get(t, s.env.pointers, &kv, &v);
        if (rc == c.MDB_NOTFOUND) return null;
        try check(rc);
        return bytesOf(v);
    }

    fn putPointerIn(s: *LmdbStore, t: *c.MDB_txn, name: []const u8, v: []const u8) !void {
        var kv = val(try s.key(s.prefix, name));
        var vv = val(v);
        try check(c.mdb_put(t, s.env.pointers, &kv, &vv, 0));
    }

    fn pointerFn(ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const s = self(ctx);
        const t = try s.readTxn();
        defer s.doneReading();
        const v = (try s.pointerIn(t, name)) orelse return null;
        return try a.dupe(u8, v);
    }

    fn setPointerFn(ctx: *anyopaque, name: []const u8, cid: []const u8) anyerror!void {
        const s = self(ctx);
        if (s.read_only) return error.ReadOnly;
        if (s.in_txn) return s.putPointerIn(s.env.wtxn.?, name, cid);
        var t: ?*c.MDB_txn = null;
        try check(c.mdb_txn_begin(s.env.env, null, 0, &t));
        errdefer c.mdb_txn_abort(t);
        try s.putPointerIn(t.?, name, cid);
        try check(c.mdb_txn_commit(t));
    }

    fn sizeIn(s: *LmdbStore, t: *c.MDB_txn) !u64 {
        const v = (try s.pointerIn(t, SIZE)) orelse return 0;
        if (v.len != 8) return error.BadSize;
        return std.mem.readInt(u64, v[0..8], .big);
    }

    /// #130: the bytes of every block the set holds (its share; see the header).
    fn sizeFn(ctx: *anyopaque) anyerror!u64 {
        const s = self(ctx);
        const t = try s.readTxn();
        defer s.doneReading();
        return s.sizeIn(t);
    }

    // -------------------------------------------------------- what the tools read

    /// Each CID the set holds, in CID order (its members' key order), with `f` called on each.
    fn eachMember(s: *LmdbStore, ctx: anytype, comptime f: fn (@TypeOf(ctx), *c.MDB_txn, []const u8) anyerror!void) !void {
        const t = try s.readTxn();
        defer s.doneReading();
        var cur: ?*c.MDB_cursor = null;
        try check(c.mdb_cursor_open(t, s.env.members, &cur));
        defer c.mdb_cursor_close(cur);
        var k = val(s.prefix);
        var v: c.MDB_val = undefined;
        var rc = c.mdb_cursor_get(cur, &k, &v, c.MDB_SET_RANGE);
        while (rc == 0) : (rc = c.mdb_cursor_get(cur, &k, &v, c.MDB_NEXT)) {
            const kb = bytesOf(k);
            if (!std.mem.startsWith(u8, kb, s.prefix)) break;
            try f(ctx, t, kb[s.prefix.len..]);
        }
        if (rc != c.MDB_NOTFOUND and rc != 0) try check(rc);
    }

    /// Every block of one codec the set holds (the replay tool copies modules this way).
    pub fn blocksOfCodec(s: *LmdbStore, a: std.mem.Allocator, codec: u64) ![][2][]u8 {
        const Ctx = struct { s: *LmdbStore, a: std.mem.Allocator, codec: u64, out: *std.array_list.Managed([2][]u8) };
        var out = std.array_list.Managed([2][]u8).init(a);
        try s.eachMember(Ctx{ .s = s, .a = a, .codec = codec, .out = &out }, struct {
            fn f(x: Ctx, t: *c.MDB_txn, cid: []const u8) anyerror!void {
                if (cidm.codecOf(cid) != x.codec) return;
                var kv = val(cid);
                var v: c.MDB_val = undefined;
                const rc = c.mdb_get(t, x.s.env.blocks, &kv, &v);
                if (rc == c.MDB_NOTFOUND) return;
                try check(rc);
                try x.out.append(.{ try x.a.dupe(u8, cid), try x.a.dupe(u8, bytesOf(v)) });
            }
        }.f);
        return out.items;
    }

    /// Every CID the set holds, in CID order (dump).
    pub fn allCids(s: *LmdbStore, a: std.mem.Allocator) ![][]u8 {
        const Ctx = struct { a: std.mem.Allocator, out: *std.array_list.Managed([]u8) };
        var out = std.array_list.Managed([]u8).init(a);
        try s.eachMember(Ctx{ .a = a, .out = &out }, struct {
            fn f(x: Ctx, _: *c.MDB_txn, cid: []const u8) anyerror!void {
                try x.out.append(try x.a.dupe(u8, cid));
            }
        }.f);
        return out.items;
    }

    /// Adopt a checkpoint (issue #4), as SqliteStore.restore: the pointer moves to the state record
    /// (its blocks already put) and the index is read from it. Only into a set with no log.
    pub fn restore(s: *LmdbStore, state: []const u8) !void {
        if (s.read_only) return error.ReadOnly;
        if (s.ix.work.tip.get() != null or s.ix.work.cursor != 0) return error.StoreNotEmpty;
        var arena = std.heap.ArenaAllocator.init(s.alloc);
        defer arena.deinit();
        const a = arena.allocator();
        const b = (try getFn(s, a, state)) orelse return error.MissingState;
        const v = cbor.decode(a, b) catch return error.BadState;
        if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", index.STATE_KIND)) return error.BadState;
        if ((Value.intOf(v.get("format")) orelse 0) != index.FORMAT) return error.PredatesFuel;
        try beginFn(s);
        errdefer rollbackFn(s);
        try setPointerFn(s, index.POINTER, state);
        try commitFn(s);
        s.ix.forest.reset(true);
        if (!try s.ix.load()) return error.MissingState;
    }

    /// Whether the set has a state pointer (the migrate tool refuses such a target).
    pub fn hasState(s: *LmdbStore) !bool {
        var arena = std.heap.ArenaAllocator.init(s.alloc);
        defer arena.deinit();
        return (try pointerFn(s, arena.allocator(), index.POINTER)) != null;
    }

    /// Put many blocks in one write transaction (the migrate tool), then optionally the state pointer.
    pub fn putBatch(s: *LmdbStore, blocks: []const [2][]const u8, state: ?[]const u8) !void {
        try beginFn(s);
        errdefer rollbackFn(s);
        for (blocks) |b| try s.putIn(s.env.wtxn.?, b[0], b[1]);
        if (state) |st| try s.putPointerIn(s.env.wtxn.?, index.POINTER, st);
        try commitFn(s);
    }
};

// ------------------------------------------------------------------ tests

const testing = std.testing;

fn tmpEnvDir(a: std.mem.Allocator, tag: []const u8) ![]u8 {
    const base = std.c.getenv("TMPDIR");
    const dir = if (base) |b| std.mem.span(b) else "/tmp";
    return std.fmt.allocPrint(a, "{s}/skein-lmdb-test-{s}-{d}", .{ dir, tag, std.c.getpid() });
}

fn rmTree(dir: []const u8) void {
    std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};
}

test "lmdb store: open, put/get through the gate, pointer, size, idempotent put, two sets" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const dir = try tmpEnvDir(a, "sets");
    defer rmTree(dir);

    const env = try Env.open(testing.allocator, testing.io, dir, false);
    defer env.close(testing.allocator);
    const sa = try LmdbStore.openIn(testing.allocator, env, "alice");
    defer sa.close();
    const sb = try LmdbStore.openIn(testing.allocator, env, "bob");
    defer sb.close();
    const A = sa.ix.backend;
    const B = sb.ix.backend;

    const x = try cbor.block(a, cbor.string("only alice"));
    const y = try cbor.block(a, cbor.string("only bob"));
    const z = try cbor.block(a, cbor.string("both"));

    try A.vt.put(A.ctx, x.cid, x.bytes);
    try B.vt.put(B.ctx, y.cid, y.bytes);
    try A.vt.put(A.ctx, z.cid, z.bytes);
    try B.vt.put(B.ctx, z.cid, z.bytes);
    // Idempotent: the same block again adds nothing.
    try A.vt.put(A.ctx, x.cid, x.bytes);

    // The gate: a block another set put is absent here.
    try testing.expect(try A.vt.has(A.ctx, x.cid));
    try testing.expect(!try A.vt.has(A.ctx, y.cid));
    try testing.expect((try A.vt.get(A.ctx, a, y.cid)) == null);
    try testing.expect(!try B.vt.has(B.ctx, x.cid));
    try testing.expectEqualSlices(u8, x.bytes, (try A.vt.get(A.ctx, a, x.cid)).?);
    try testing.expectEqualSlices(u8, z.bytes, (try B.vt.get(B.ctx, a, z.cid)).?);

    // Size: each set's own blocks, a shared one counted for each, a repeated put not again.
    try testing.expectEqual(@as(u64, x.bytes.len + z.bytes.len), try A.vt.size.?(A.ctx));
    try testing.expectEqual(@as(u64, y.bytes.len + z.bytes.len), try B.vt.size.?(B.ctx));

    // Pointers are per set.
    try A.vt.setPointer(A.ctx, "p", x.cid);
    try testing.expectEqualSlices(u8, x.cid, (try A.vt.pointer(A.ctx, a, "p")).?);
    try testing.expect((try B.vt.pointer(B.ctx, a, "p")) == null);

    // A transaction: begin, puts and a pointer, rollback leaves nothing; commit keeps it.
    const w = try cbor.block(a, cbor.string("rolled back"));
    try A.vt.begin(A.ctx);
    try A.vt.put(A.ctx, w.cid, w.bytes);
    try testing.expect(try A.vt.has(A.ctx, w.cid)); // read through the write transaction
    A.vt.rollback(A.ctx);
    try testing.expect(!try A.vt.has(A.ctx, w.cid));
    try A.vt.begin(A.ctx);
    try A.vt.put(A.ctx, w.cid, w.bytes);
    try A.vt.commit(A.ctx);
    try testing.expect(try A.vt.has(A.ctx, w.cid));

    // The set's CIDs, in CID order, only its own.
    const ids = try sa.allCids(a);
    try testing.expectEqual(@as(usize, 3), ids.len);
    for (ids[1..], 0..) |id, i| try testing.expect(std.mem.order(u8, ids[i], id) == .lt);
    for (ids) |id| try testing.expect(!std.mem.eql(u8, id, y.cid));
    try testing.expectEqual(@as(usize, 3), (try sa.blocksOfCodec(a, cidm.DAG_CBOR)).len);

    // The chain's set: readable by every set, counted in no set's size.
    const ch = try LmdbStore.openIn(testing.allocator, env, CHAIN_SET);
    defer ch.close();
    const C = ch.ix.backend;
    const h = try cbor.block(a, cbor.string("a header"));
    try C.vt.put(C.ctx, h.cid, h.bytes);
    try testing.expectEqualSlices(u8, h.bytes, (try A.vt.get(A.ctx, a, h.cid)).?);
    try testing.expect(try B.vt.has(B.ctx, h.cid));
    try testing.expectEqual(@as(u64, y.bytes.len + z.bytes.len), try B.vt.size.?(B.ctx));
    try testing.expectEqual(@as(usize, 3), (try sa.allCids(a)).len);
}

test "lmdb store: the index commits, reopens and reads only through its set" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const dir = try tmpEnvDir(a, "index");
    defer rmTree(dir);

    var state: []u8 = undefined;
    {
        const s = try LmdbStore.open(testing.allocator, testing.io, dir, "alice");
        defer s.close();
        const st = s.store();
        _ = try st.put(a, cbor.string("a record"));
        try st.cursorSet(1);
        state = try a.dupe(u8, (try st.state(a)).?);
    }
    {
        const s = try LmdbStore.openReadOnly(testing.allocator, testing.io, dir, "alice");
        defer s.close();
        try testing.expectEqualSlices(u8, state, (try s.store().state(a)).?);
        try testing.expectEqual(@as(i64, 1), try s.store().cursorGet());
        try testing.expect(try s.hasState());
        try testing.expectError(error.ReadOnly, s.store().putBlock(state, "x"));
    }
    {
        // Another set in the same environment sees none of it.
        const s = try LmdbStore.open(testing.allocator, testing.io, dir, "bob");
        defer s.close();
        try testing.expect((try s.store().state(a)) == null);
        try testing.expect(!try s.store().has(state));
        try testing.expect(!try s.hasState());
    }
}
