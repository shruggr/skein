// The store in one RocksDB database per host (#158, #96): the one-process
// kernel's backend (`skein-kernel host`, host.zig). The same shape as the
// LMDB environment (lmdb_store.zig, #133) — one block table, a member set per
// instance as the read gate, `host/chain` the one shared set — in three
// column families of one database ($SKEIN_HOME/store-rocksdb/ by default):
//
//   blocks    cid → bytes                 every block once, content-addressed (never overwritten)
//   members   <set> ‖ 0x00 ‖ cid → ∅      what the set holds
//   pointers  <set> ‖ 0x00 ‖ name → cid   the set's pointers (index.POINTER), and `size`
//
// One process opens the database (RocksDB's LOCK file refuses a second): the
// `host` subcommand holds it for every instance, each instance's store a
// `RocksStore` over the shared `Db`; the single-instance tools (replay, dump,
// fuel, shell, migrate) open it alone, while the host is down. The host's own
// reads go to that process over its frames (host.zig: get/has/state).
//
// Writes: the index brackets every commit in begin … commit (index.zig): the
// commit's blocks, memberships, size and the state pointer go into one write
// batch, written at commit with sync = false — the WAL is written, not
// fsynced: an OS crash may lose the last commits, never corrupts. A put
// outside a commit is a batch of its own. A batch belongs to one instance,
// and an instance is on one worker at a time (host.zig), so the store needs
// no lock of its own; the database is thread safe.
//
// Reads: `get`/`has` answer through the set's members, then `host/chain`'s;
// a block only another set holds is absent. A call (#40, #158) reads through
// a `View`: the set at the state pointer as committed when the view was made,
// never the writer's batch — the blocks are immutable, so the CID is the
// snapshot (no RocksDB snapshot needed).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const storem = @import("store.zig");
const index = @import("index.zig");
const Value = cbor.Value;
pub const c = @cImport(@cInclude("rocksdb/c.h"));

/// The chain's member set (#133): readable by every set; written by the host's chain service only.
pub const CHAIN_SET = "host/chain";
/// The pointer name of a set's size counter.
pub const SIZE = "size";

pub const Error = error{Rocks};

fn check(err: ?[*:0]u8) Error!void {
    const e = err orelse return;
    std.log.err("rocksdb: {s}", .{std.mem.span(e)});
    c.rocksdb_free(e);
    return error.Rocks;
}

/// The column families, in the order they are opened (RocksDB requires `default`).
const CF_NAMES = [_][*:0]const u8{ "default", "blocks", "members", "pointers" };

/// One RocksDB database, opened once per process.
pub const Db = struct {
    db: *c.rocksdb_t,
    cfs: [CF_NAMES.len]*c.rocksdb_column_family_handle_t,
    opts: *c.rocksdb_options_t,
    cf_opts: [CF_NAMES.len]*c.rocksdb_options_t,
    bbto: *c.rocksdb_block_based_table_options_t,
    cache: *c.rocksdb_cache_t,
    ro: *c.rocksdb_readoptions_t,
    wo: *c.rocksdb_writeoptions_t,
    read_only: bool,

    pub fn blocks(d: *Db) *c.rocksdb_column_family_handle_t {
        return d.cfs[1];
    }
    pub fn members(d: *Db) *c.rocksdb_column_family_handle_t {
        return d.cfs[2];
    }
    pub fn pointers(d: *Db) *c.rocksdb_column_family_handle_t {
        return d.cfs[3];
    }

    /// The database at `dir`, created (the directory and the column families) unless read only.
    /// Read only: the tools' open of a database no process holds (it reads the WAL too); never
    /// beside a running host (it would see the database as of its open).
    pub fn open(alloc: std.mem.Allocator, io: std.Io, dir: []const u8, read_only: bool) !*Db {
        if (!read_only) std.Io.Dir.cwd().createDirPath(io, dir) catch {};
        const cpus: c_int = @intCast(@min(std.Thread.getCpuCount() catch 4, 64));
        const opts = c.rocksdb_options_create().?;
        errdefer c.rocksdb_options_destroy(opts);
        c.rocksdb_options_set_create_if_missing(opts, @intFromBool(!read_only));
        c.rocksdb_options_set_create_missing_column_families(opts, @intFromBool(!read_only));
        c.rocksdb_options_increase_parallelism(opts, cpus);
        c.rocksdb_options_set_max_background_jobs(opts, @max(4, cpus));
        // One block cache for every column family (64 MiB), bloom filters on blocks and members.
        const cache = c.rocksdb_cache_create_lru(64 << 20).?;
        errdefer c.rocksdb_cache_destroy(cache);
        const bbto = c.rocksdb_block_based_options_create().?;
        errdefer c.rocksdb_block_based_options_destroy(bbto);
        c.rocksdb_block_based_options_set_block_cache(bbto, cache);
        c.rocksdb_block_based_options_set_filter_policy(bbto, c.rocksdb_filterpolicy_create_bloom(10));
        var cf_opts: [CF_NAMES.len]*c.rocksdb_options_t = undefined;
        for (&cf_opts, 0..) |*o, i| {
            o.* = c.rocksdb_options_create_copy(opts).?;
            if (i == 1 or i == 2) c.rocksdb_options_set_block_based_table_factory(o.*, bbto);
        }
        const z = try alloc.dupeZ(u8, dir);
        defer alloc.free(z);
        var handles: [CF_NAMES.len]?*c.rocksdb_column_family_handle_t = .{null} ** CF_NAMES.len;
        var err: ?[*:0]u8 = null;
        const db = if (read_only)
            c.rocksdb_open_for_read_only_column_families(opts, z.ptr, CF_NAMES.len, &CF_NAMES, @ptrCast(&cf_opts), @ptrCast(&handles), 0, @ptrCast(&err))
        else
            c.rocksdb_open_column_families(opts, z.ptr, CF_NAMES.len, &CF_NAMES, @ptrCast(&cf_opts), @ptrCast(&handles), @ptrCast(&err));
        if (err) |e| {
            std.log.err("rocksdb: {s}: {s}", .{ dir, std.mem.span(e) });
            c.rocksdb_free(e);
            for (cf_opts) |o| c.rocksdb_options_destroy(o);
            return error.Rocks;
        }
        const d = try alloc.create(Db);
        const wo = c.rocksdb_writeoptions_create().?;
        c.rocksdb_writeoptions_set_sync(wo, 0); // the WAL written, not fsynced (#158)
        d.* = .{
            .db = db.?,
            .cfs = undefined,
            .opts = opts,
            .cf_opts = cf_opts,
            .bbto = bbto,
            .cache = cache,
            .ro = c.rocksdb_readoptions_create().?,
            .wo = wo,
            .read_only = read_only,
        };
        for (&d.cfs, handles) |*h, x| h.* = x.?;
        return d;
    }

    /// The WAL synced and the memtables flushed (a clean shutdown), then closed.
    pub fn close(d: *Db, alloc: std.mem.Allocator) void {
        if (!d.read_only) {
            var err: ?[*:0]u8 = null;
            c.rocksdb_flush_wal(d.db, 1, @ptrCast(&err));
            check(err) catch {};
            const fo = c.rocksdb_flushoptions_create().?;
            c.rocksdb_flushoptions_set_wait(fo, 1);
            for (d.cfs[1..]) |cf| {
                err = null;
                c.rocksdb_flush_cf(d.db, fo, cf, @ptrCast(&err));
                check(err) catch {};
            }
            c.rocksdb_flushoptions_destroy(fo);
        }
        for (d.cfs) |cf| c.rocksdb_column_family_handle_destroy(cf);
        c.rocksdb_close(d.db);
        c.rocksdb_readoptions_destroy(d.ro);
        c.rocksdb_writeoptions_destroy(d.wo);
        for (d.cf_opts) |o| c.rocksdb_options_destroy(o);
        c.rocksdb_options_destroy(d.opts);
        c.rocksdb_block_based_options_destroy(d.bbto);
        c.rocksdb_cache_destroy(d.cache);
        alloc.destroy(d);
    }

    /// The value at `key` in `cf`, copied into `a`; null if absent.
    pub fn read(d: *Db, a: std.mem.Allocator, cf: *c.rocksdb_column_family_handle_t, key: []const u8) !?[]u8 {
        var err: ?[*:0]u8 = null;
        const p = c.rocksdb_get_pinned_cf(d.db, d.ro, cf, key.ptr, key.len, @ptrCast(&err));
        try check(err);
        const ps = p orelse return null;
        defer c.rocksdb_pinnableslice_destroy(ps);
        var n: usize = 0;
        const v = c.rocksdb_pinnableslice_value(ps, &n);
        if (n == 0) return try a.alloc(u8, 0);
        return try a.dupe(u8, @as([*]const u8, @ptrCast(v))[0..n]);
    }

    /// Whether `key` is in `cf`.
    pub fn present(d: *Db, cf: *c.rocksdb_column_family_handle_t, key: []const u8) !bool {
        var err: ?[*:0]u8 = null;
        const p = c.rocksdb_get_pinned_cf(d.db, d.ro, cf, key.ptr, key.len, @ptrCast(&err));
        try check(err);
        const ps = p orelse return false;
        c.rocksdb_pinnableslice_destroy(ps);
        return true;
    }

    fn write(d: *Db, b: *c.rocksdb_writebatch_t) !void {
        var err: ?[*:0]u8 = null;
        c.rocksdb_write(d.db, d.wo, b, @ptrCast(&err));
        try check(err);
    }

    // ---------------------------------------------------- the host's reads (host.zig: no gate)

    /// A block by CID, whichever set holds it (the host side is trusted, #158).
    pub fn blockGet(d: *Db, a: std.mem.Allocator, cid: []const u8) !?[]u8 {
        return d.read(a, d.blocks(), cid);
    }
    pub fn blockHas(d: *Db, cid: []const u8) !bool {
        return d.present(d.blocks(), cid);
    }
    /// A block through `set`'s gate (its members, then the chain's): what that instance holds.
    pub fn setGet(d: *Db, a: std.mem.Allocator, set: []const u8, cid: []const u8) !?[]u8 {
        const prefix = try std.mem.concat(a, u8, &.{ set, "\x00" });
        return (Gate{ .db = d, .prefix = prefix }).get(a, cid);
    }
    pub fn setHas(d: *Db, a: std.mem.Allocator, set: []const u8, cid: []const u8) !bool {
        const prefix = try std.mem.concat(a, u8, &.{ set, "\x00" });
        return (Gate{ .db = d, .prefix = prefix }).has(cid);
    }
    /// Every CID `set` holds (its own members, not the chain's), in CID order.
    pub fn membersOf(d: *Db, a: std.mem.Allocator, set: []const u8) ![][]u8 {
        const prefix = try std.mem.concat(a, u8, &.{ set, "\x00" });
        const end = try std.mem.concat(a, u8, &.{ set, "\x01" });
        const ro = c.rocksdb_readoptions_create().?;
        defer c.rocksdb_readoptions_destroy(ro);
        c.rocksdb_readoptions_set_iterate_upper_bound(ro, end.ptr, end.len);
        const it = c.rocksdb_create_iterator_cf(d.db, ro, d.members()).?;
        defer c.rocksdb_iter_destroy(it);
        var out = std.array_list.Managed([]u8).init(a);
        c.rocksdb_iter_seek(it, prefix.ptr, prefix.len);
        while (c.rocksdb_iter_valid(it) != 0) : (c.rocksdb_iter_next(it)) {
            var n: usize = 0;
            const k = @as([*]const u8, @ptrCast(c.rocksdb_iter_key(it, &n)))[0..n];
            if (!std.mem.startsWith(u8, k, prefix)) break;
            try out.append(try a.dupe(u8, k[prefix.len..]));
        }
        var err: ?[*:0]u8 = null;
        c.rocksdb_iter_get_error(it, @ptrCast(&err));
        try check(err);
        return out.items;
    }
    /// A set's pointer (`state`, `size`), as committed.
    pub fn pointerOf(d: *Db, a: std.mem.Allocator, set: []const u8, name: []const u8) !?[]u8 {
        const k = try std.mem.concat(a, u8, &.{ set, "\x00", name });
        return d.read(a, d.pointers(), k);
    }
};

/// The gate's reads, shared by the store and a call's view: the set's own members, then the chain's.
const Gate = struct {
    db: *Db,
    prefix: []const u8,
    chain_prefix: []const u8 = CHAIN_SET ++ "\x00",

    fn memberKey(a: std.mem.Allocator, prefix: []const u8, rest: []const u8) ![]u8 {
        return std.mem.concat(a, u8, &.{ prefix, rest });
    }

    fn member(g: Gate, cid: []const u8) !bool {
        var buf: [256]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&buf);
        const fa = fba.allocator();
        if (try g.db.present(g.db.members(), try memberKey(fa, g.prefix, cid))) return true;
        fba.reset();
        return g.db.present(g.db.members(), try memberKey(fa, g.chain_prefix, cid));
    }

    fn get(g: Gate, a: std.mem.Allocator, cid: []const u8) !?[]u8 {
        if (!try g.member(cid)) return null;
        return g.db.read(a, g.db.blocks(), cid);
    }

    fn has(g: Gate, cid: []const u8) !bool {
        if (!try g.member(cid)) return false;
        return g.db.present(g.db.blocks(), cid);
    }

    fn pointer(g: Gate, a: std.mem.Allocator, name: []const u8) !?[]u8 {
        var buf: [256]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&buf);
        return g.db.read(a, g.db.pointers(), try memberKey(fba.allocator(), g.prefix, name));
    }
};

pub const RocksStore = struct {
    db: *Db,
    owns_db: bool,
    alloc: std.mem.Allocator,
    ix: *index.Index,
    read_only: bool,
    /// The set's name, `<set> ‖ 0x00` (the key prefix of its members and pointers).
    prefix: []u8,
    /// The commit being built (begin … commit), else null.
    batch: ?*c.rocksdb_writebatch_t = null,
    /// What the open batch makes members (CID → bytes, gpa-owned): read back through the gate
    /// before the batch is written, and not counted twice in the size.
    pending: std.StringHashMap([]u8),
    /// The pointers the open batch sets (name → value, gpa-owned).
    pending_ptr: std.StringHashMap([]u8),
    /// The set's size as the open batch leaves it.
    pending_size: ?u64 = null,

    /// The set `set` in the database at `dir`, opened by this store alone (the tools).
    pub fn open(alloc: std.mem.Allocator, io: std.Io, dir: []const u8, set: []const u8) !*RocksStore {
        const db = try Db.open(alloc, io, dir, false);
        errdefer db.close(alloc);
        return init(alloc, db, true, set, false);
    }

    /// An existing database's set for reading only (nothing is written; the host is down).
    pub fn openReadOnly(alloc: std.mem.Allocator, io: std.Io, dir: []const u8, set: []const u8) !*RocksStore {
        const db = try Db.open(alloc, io, dir, true);
        errdefer db.close(alloc);
        return init(alloc, db, true, set, true);
    }

    /// A set in a database this process already holds open (the host, migrate, the tests).
    pub fn openIn(alloc: std.mem.Allocator, db: *Db, set: []const u8) !*RocksStore {
        return init(alloc, db, false, set, db.read_only);
    }

    /// The `host/chain` set (#156) for the host chain's tracker (host_chain.zig): written through
    /// the backend alone — its index never loads or writes a state record of its own.
    pub fn openChain(alloc: std.mem.Allocator, db: *Db) !*RocksStore {
        return initWith(alloc, db, false, CHAIN_SET, db.read_only, true);
    }

    fn init(alloc: std.mem.Allocator, db: *Db, owns_db: bool, set: []const u8, read_only: bool) !*RocksStore {
        return initWith(alloc, db, owns_db, set, read_only, false);
    }

    fn initWith(alloc: std.mem.Allocator, db: *Db, owns_db: bool, set: []const u8, read_only: bool, bare: bool) !*RocksStore {
        if (set.len == 0 or std.mem.indexOfScalar(u8, set, 0) != null) return error.BadSet;
        const s = try alloc.create(RocksStore);
        errdefer alloc.destroy(s);
        const prefix = try std.mem.concat(alloc, u8, &.{ set, "\x00" });
        errdefer alloc.free(prefix);
        s.* = .{ .db = db, .owns_db = owns_db, .alloc = alloc, .ix = undefined, .read_only = read_only, .prefix = prefix, .pending = .init(alloc), .pending_ptr = .init(alloc) };
        s.ix = try index.Index.init(alloc, s.backend(), read_only or bare);
        errdefer s.ix.deinit();
        if (!bare) _ = try s.ix.load();
        return s;
    }

    /// No store in a database holds the format before #30 (only this kernel writes one; migrate
    /// refuses an older store), so nothing here predates fuel.
    pub fn predatesFuel(_: *RocksStore) bool {
        return false;
    }

    pub fn close(s: *RocksStore) void {
        s.ix.commitAll() catch |err| std.log.err("store: final commit: {s}", .{@errorName(err)});
        s.ix.deinit();
        s.dropBatch();
        s.pending.deinit();
        s.pending_ptr.deinit();
        if (s.owns_db) s.db.close(s.alloc);
        s.alloc.free(s.prefix);
        s.alloc.destroy(s);
    }

    pub fn store(s: *RocksStore) storem.Store {
        return s.ix.store();
    }

    /// The set's name (its prefix without the separator).
    pub fn setName(s: *RocksStore) []const u8 {
        return s.prefix[0 .. s.prefix.len - 1];
    }

    fn gate(s: *RocksStore) Gate {
        return .{ .db = s.db, .prefix = s.prefix };
    }

    fn dropBatch(s: *RocksStore) void {
        if (s.batch) |b| c.rocksdb_writebatch_destroy(b);
        s.batch = null;
        var it = s.pending.iterator();
        while (it.next()) |e| {
            s.alloc.free(e.key_ptr.*);
            s.alloc.free(e.value_ptr.*);
        }
        s.pending.clearRetainingCapacity();
        var ip = s.pending_ptr.iterator();
        while (ip.next()) |e| {
            s.alloc.free(e.key_ptr.*);
            s.alloc.free(e.value_ptr.*);
        }
        s.pending_ptr.clearRetainingCapacity();
        s.pending_size = null;
    }

    // -------------------------------------------------------- the backend

    /// The backend under the store's index (host_chain.zig writes the host chain through it, #156).
    pub fn backend(s: *RocksStore) index.Backend {
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

    fn self(ctx: *anyopaque) *RocksStore {
        return @ptrCast(@alignCast(ctx));
    }

    fn getFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const s = self(ctx);
        if (s.pending.get(cid)) |b| return try a.dupe(u8, b);
        return s.gate().get(a, cid);
    }

    fn hasFn(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        const s = self(ctx);
        if (s.pending.contains(cid)) return true;
        return s.gate().has(cid);
    }

    fn sizeNow(s: *RocksStore) !u64 {
        if (s.pending_size) |n| return n;
        var buf: [64]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&buf);
        const v = (try s.gate().pointer(fba.allocator(), SIZE)) orelse return 0;
        if (v.len != 8) return error.BadSize;
        return std.mem.readInt(u64, v[0..8], .big);
    }

    /// The block once (written only if `blocks` lacks it), then the membership; a new membership
    /// adds the block's length to the set's size. Into the batch `b`.
    fn putInto(s: *RocksStore, b: *c.rocksdb_writebatch_t, cid: []const u8, bytes: []const u8) !void {
        if (s.pending.contains(cid)) return;
        var kbuf: [256]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&kbuf);
        const mk = try Gate.memberKey(fba.allocator(), s.prefix, cid);
        if (try s.db.present(s.db.members(), mk)) return;
        if (!try s.db.present(s.db.blocks(), cid)) c.rocksdb_writebatch_put_cf(b, s.db.blocks(), cid.ptr, cid.len, bytes.ptr, bytes.len);
        c.rocksdb_writebatch_put_cf(b, s.db.members(), mk.ptr, mk.len, "", 0);
        const n = (try s.sizeNow()) + bytes.len;
        var nb: [8]u8 = undefined;
        std.mem.writeInt(u64, &nb, n, .big);
        const pk = try Gate.memberKey(fba.allocator(), s.prefix, SIZE);
        c.rocksdb_writebatch_put_cf(b, s.db.pointers(), pk.ptr, pk.len, &nb, nb.len);
        s.pending_size = n;
        try s.pending.put(try s.alloc.dupe(u8, cid), try s.alloc.dupe(u8, bytes));
    }

    fn putFn(ctx: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
        const s = self(ctx);
        if (s.read_only) return error.ReadOnly;
        if (s.batch) |b| return s.putInto(b, cid, bytes);
        // A put outside a commit: a batch of its own.
        try beginFn(s);
        errdefer rollbackFn(s);
        try s.putInto(s.batch.?, cid, bytes);
        try commitFn(s);
    }

    fn beginFn(ctx: *anyopaque) anyerror!void {
        const s = self(ctx);
        if (s.read_only) return error.ReadOnly;
        if (s.batch != null) return error.TransactionOpen;
        s.batch = c.rocksdb_writebatch_create() orelse return error.OutOfMemory;
    }

    fn commitFn(ctx: *anyopaque) anyerror!void {
        const s = self(ctx);
        const b = s.batch orelse return error.NoTransaction;
        defer s.dropBatch();
        if (c.rocksdb_writebatch_count(b) > 0) try s.db.write(b);
    }

    fn rollbackFn(ctx: *anyopaque) void {
        self(ctx).dropBatch();
    }

    fn pointerFn(ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const s = self(ctx);
        if (s.pending_ptr.get(name)) |v| return try a.dupe(u8, v);
        return s.gate().pointer(a, name);
    }

    fn setPointerFn(ctx: *anyopaque, name: []const u8, cid: []const u8) anyerror!void {
        const s = self(ctx);
        if (s.read_only) return error.ReadOnly;
        const own = s.batch == null;
        if (own) try beginFn(s);
        errdefer if (own) rollbackFn(s);
        var kbuf: [256]u8 = undefined;
        var fba = std.heap.FixedBufferAllocator.init(&kbuf);
        const k = try Gate.memberKey(fba.allocator(), s.prefix, name);
        c.rocksdb_writebatch_put_cf(s.batch.?, s.db.pointers(), k.ptr, k.len, cid.ptr, cid.len);
        const gop = try s.pending_ptr.getOrPut(name);
        if (gop.found_existing) s.alloc.free(gop.value_ptr.*) else gop.key_ptr.* = try s.alloc.dupe(u8, name);
        gop.value_ptr.* = try s.alloc.dupe(u8, cid);
        if (own) try commitFn(s);
    }

    /// #130: the bytes of every block the set holds (its share; see lmdb_store.zig).
    fn sizeFn(ctx: *anyopaque) anyerror!u64 {
        return self(ctx).sizeNow();
    }

    // -------------------------------------------------------- what the tools read

    /// Each member CID of the set, in CID order, with `f` called on each.
    fn eachMember(s: *RocksStore, ctx: anytype, comptime f: fn (@TypeOf(ctx), []const u8) anyerror!void) !void {
        const ro = c.rocksdb_readoptions_create().?;
        defer c.rocksdb_readoptions_destroy(ro);
        const end = try s.alloc.dupe(u8, s.prefix);
        defer s.alloc.free(end);
        end[end.len - 1] += 1; // <set> ‖ 0x01: just past the set's keys
        c.rocksdb_readoptions_set_iterate_upper_bound(ro, end.ptr, end.len);
        const it = c.rocksdb_create_iterator_cf(s.db.db, ro, s.db.members()).?;
        defer c.rocksdb_iter_destroy(it);
        c.rocksdb_iter_seek(it, s.prefix.ptr, s.prefix.len);
        while (c.rocksdb_iter_valid(it) != 0) : (c.rocksdb_iter_next(it)) {
            var n: usize = 0;
            const k = @as([*]const u8, @ptrCast(c.rocksdb_iter_key(it, &n)))[0..n];
            if (!std.mem.startsWith(u8, k, s.prefix)) break;
            try f(ctx, k[s.prefix.len..]);
        }
        var err: ?[*:0]u8 = null;
        c.rocksdb_iter_get_error(it, @ptrCast(&err));
        try check(err);
    }

    /// Every block of one codec the set holds (the replay tool copies modules this way).
    pub fn blocksOfCodec(s: *RocksStore, a: std.mem.Allocator, codec: u64) ![][2][]u8 {
        const Ctx = struct { s: *RocksStore, a: std.mem.Allocator, codec: u64, out: *std.array_list.Managed([2][]u8) };
        var out = std.array_list.Managed([2][]u8).init(a);
        try s.eachMember(Ctx{ .s = s, .a = a, .codec = codec, .out = &out }, struct {
            fn f(x: Ctx, cid: []const u8) anyerror!void {
                if (cidm.codecOf(cid) != x.codec) return;
                const b = (try x.s.db.read(x.a, x.s.db.blocks(), cid)) orelse return;
                try x.out.append(.{ try x.a.dupe(u8, cid), b });
            }
        }.f);
        return out.items;
    }

    /// Every CID the set holds, in CID order (dump).
    pub fn allCids(s: *RocksStore, a: std.mem.Allocator) ![][]u8 {
        const Ctx = struct { a: std.mem.Allocator, out: *std.array_list.Managed([]u8) };
        var out = std.array_list.Managed([]u8).init(a);
        try s.eachMember(Ctx{ .a = a, .out = &out }, struct {
            fn f(x: Ctx, cid: []const u8) anyerror!void {
                try x.out.append(try x.a.dupe(u8, cid));
            }
        }.f);
        return out.items;
    }

    /// Adopt a checkpoint (issue #4), as SqliteStore.restore: the pointer moves to the state record
    /// (its blocks already put) and the index is read from it. Only into a set with no log.
    pub fn restore(s: *RocksStore, state: []const u8) !void {
        if (s.read_only) return error.ReadOnly;
        if (s.ix.work.tip.get() != null or s.ix.work.cursor != 0) return error.StoreNotEmpty;
        var arena = std.heap.ArenaAllocator.init(s.alloc);
        defer arena.deinit();
        const a = arena.allocator();
        const b = (try getFn(s, a, state)) orelse return error.MissingState;
        const v = cbor.decode(a, b) catch return error.BadState;
        if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", index.STATE_KIND)) return error.BadState;
        if ((Value.intOf(v.get("format")) orelse 0) != index.FORMAT) return error.PredatesFuel;
        try setPointerFn(s, index.POINTER, state);
        s.ix.forest.reset(true);
        if (!try s.ix.load()) return error.MissingState;
    }

    /// Whether the set has a state pointer (the migrate tool refuses such a target).
    pub fn hasState(s: *RocksStore) !bool {
        var arena = std.heap.ArenaAllocator.init(s.alloc);
        defer arena.deinit();
        return (try pointerFn(s, arena.allocator(), index.POINTER)) != null;
    }

    /// Put many blocks in one batch (the migrate tool), then optionally the state pointer.
    pub fn putBatch(s: *RocksStore, blocks: []const [2][]const u8, state: ?[]const u8) !void {
        try beginFn(s);
        errdefer rollbackFn(s);
        for (blocks) |b| try s.putInto(s.batch.?, b[0], b[1]);
        if (state) |st| try setPointerFn(s, index.POINTER, st);
        try commitFn(s);
    }
};

/// A call's view of a set (#40, #158): the index at the state pointer as committed when the view
/// is made, read through the gate, never the writer's batch. Read only; its own forest, so a
/// worker reading it shares nothing mutable with the worker stepping the instance.
pub const View = struct {
    alloc: std.mem.Allocator,
    g: Gate,
    /// The state pointer as read at the view's making (null: no state yet).
    state: ?[]u8,
    ix: *index.Index,

    pub fn open(alloc: std.mem.Allocator, db: *Db, set: []const u8) !*View {
        const v = try alloc.create(View);
        errdefer alloc.destroy(v);
        const prefix = try std.mem.concat(alloc, u8, &.{ set, "\x00" });
        errdefer alloc.free(prefix);
        v.* = .{ .alloc = alloc, .g = .{ .db = db, .prefix = prefix }, .state = null, .ix = undefined };
        v.state = try v.g.pointer(alloc, index.POINTER);
        errdefer if (v.state) |x| alloc.free(x);
        v.ix = try index.Index.init(alloc, v.backend(), true);
        errdefer v.ix.deinit();
        _ = try v.ix.load();
        return v;
    }

    pub fn close(v: *View) void {
        v.ix.deinit();
        if (v.state) |x| v.alloc.free(x);
        v.alloc.free(v.g.prefix);
        v.alloc.destroy(v);
    }

    pub fn store(v: *View) storem.Store {
        return v.ix.store();
    }

    fn backend(v: *View) index.Backend {
        return .{ .ctx = v, .vt = &view_vt };
    }

    const view_vt = index.Backend.VT{
        .get = vGet,
        .has = vHas,
        .put = vPut,
        .begin = vBegin,
        .commit = vBegin,
        .rollback = vRollback,
        .pointer = vPointer,
        .setPointer = vSetPointer,
        .size = null,
    };

    fn vself(ctx: *anyopaque) *View {
        return @ptrCast(@alignCast(ctx));
    }
    fn vGet(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        return vself(ctx).g.get(a, cid);
    }
    fn vHas(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        return vself(ctx).g.has(cid);
    }
    fn vPut(_: *anyopaque, _: []const u8, _: []const u8) anyerror!void {
        return error.ReadOnly;
    }
    fn vBegin(_: *anyopaque) anyerror!void {
        return error.ReadOnly;
    }
    fn vRollback(_: *anyopaque) void {}
    fn vPointer(ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const v = vself(ctx);
        if (std.mem.eql(u8, name, index.POINTER)) return if (v.state) |x| try a.dupe(u8, x) else null;
        return v.g.pointer(a, name);
    }
    fn vSetPointer(_: *anyopaque, _: []const u8, _: []const u8) anyerror!void {
        return error.ReadOnly;
    }
};

// ------------------------------------------------------------------ tests

const testing = std.testing;

fn tmpDir(a: std.mem.Allocator, tag: []const u8) ![]u8 {
    const base = std.c.getenv("TMPDIR");
    const dir = if (base) |b| std.mem.span(b) else "/tmp";
    return std.fmt.allocPrint(a, "{s}/skein-rocks-test-{s}-{d}", .{ dir, tag, std.c.getpid() });
}

fn rmTree(dir: []const u8) void {
    std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};
}

test "rocksdb store: put/get through the gate, pointer, size, idempotent put, two sets" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const dir = try tmpDir(a, "sets");
    rmTree(dir);
    defer rmTree(dir);

    const db = try Db.open(testing.allocator, testing.io, dir, false);
    defer db.close(testing.allocator);
    const sa = try RocksStore.openIn(testing.allocator, db, "alice");
    defer sa.close();
    const sb = try RocksStore.openIn(testing.allocator, db, "bob");
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
    try A.vt.put(A.ctx, x.cid, x.bytes); // idempotent

    // The gate.
    try testing.expect(try A.vt.has(A.ctx, x.cid));
    try testing.expect(!try A.vt.has(A.ctx, y.cid));
    try testing.expect((try A.vt.get(A.ctx, a, y.cid)) == null);
    try testing.expect(!try B.vt.has(B.ctx, x.cid));
    try testing.expectEqualSlices(u8, x.bytes, (try A.vt.get(A.ctx, a, x.cid)).?);
    try testing.expectEqualSlices(u8, z.bytes, (try B.vt.get(B.ctx, a, z.cid)).?);
    // The host's ungated read sees every block once.
    try testing.expect(try db.blockHas(y.cid));

    // Size: each set's own blocks, a shared one counted for each, a repeated put not again.
    try testing.expectEqual(@as(u64, x.bytes.len + z.bytes.len), try A.vt.size.?(A.ctx));
    try testing.expectEqual(@as(u64, y.bytes.len + z.bytes.len), try B.vt.size.?(B.ctx));

    // Pointers are per set.
    try A.vt.setPointer(A.ctx, "p", x.cid);
    try testing.expectEqualSlices(u8, x.cid, (try A.vt.pointer(A.ctx, a, "p")).?);
    try testing.expect((try B.vt.pointer(B.ctx, a, "p")) == null);

    // A batch: begin, puts and a pointer read back before the commit; rollback leaves nothing; commit keeps it.
    const w = try cbor.block(a, cbor.string("rolled back"));
    try A.vt.begin(A.ctx);
    try A.vt.put(A.ctx, w.cid, w.bytes);
    try A.vt.put(A.ctx, w.cid, w.bytes); // once in a batch too
    try testing.expect(try A.vt.has(A.ctx, w.cid));
    try testing.expectEqual(@as(u64, x.bytes.len + z.bytes.len + w.bytes.len), try A.vt.size.?(A.ctx));
    A.vt.rollback(A.ctx);
    try testing.expect(!try A.vt.has(A.ctx, w.cid));
    try testing.expectEqual(@as(u64, x.bytes.len + z.bytes.len), try A.vt.size.?(A.ctx));
    try A.vt.begin(A.ctx);
    try A.vt.put(A.ctx, w.cid, w.bytes);
    try A.vt.setPointer(A.ctx, "q", w.cid);
    try testing.expectEqualSlices(u8, w.cid, (try A.vt.pointer(A.ctx, a, "q")).?);
    try A.vt.commit(A.ctx);
    try testing.expect(try A.vt.has(A.ctx, w.cid));
    try testing.expectEqualSlices(u8, w.cid, (try A.vt.pointer(A.ctx, a, "q")).?);

    // The set's CIDs, in CID order, only its own.
    const ids = try sa.allCids(a);
    try testing.expectEqual(@as(usize, 3), ids.len);
    for (ids[1..], 0..) |id, i| try testing.expect(std.mem.order(u8, ids[i], id) == .lt);
    for (ids) |id| try testing.expect(!std.mem.eql(u8, id, y.cid));
    try testing.expectEqual(@as(usize, 3), (try sa.blocksOfCodec(a, cidm.DAG_CBOR)).len);

    // The chain's set: readable by every set, counted in no set's size.
    const ch = try RocksStore.openIn(testing.allocator, db, CHAIN_SET);
    defer ch.close();
    const C = ch.ix.backend;
    const h = try cbor.block(a, cbor.string("a header"));
    try C.vt.put(C.ctx, h.cid, h.bytes);
    try testing.expectEqualSlices(u8, h.bytes, (try A.vt.get(A.ctx, a, h.cid)).?);
    try testing.expect(try B.vt.has(B.ctx, h.cid));
    try testing.expectEqual(@as(u64, y.bytes.len + z.bytes.len), try B.vt.size.?(B.ctx));
    try testing.expectEqual(@as(usize, 3), (try sa.allCids(a)).len);
}

test "rocksdb store: the index commits, reopens, reads only through its set; a view holds its state" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const dir = try tmpDir(a, "index");
    rmTree(dir);
    defer rmTree(dir);

    var state: []u8 = undefined;
    {
        const db = try Db.open(testing.allocator, testing.io, dir, false);
        defer db.close(testing.allocator);
        const s = try RocksStore.openIn(testing.allocator, db, "alice");
        defer s.close();
        const st = s.store();
        _ = try st.put(a, cbor.string("a record"));
        try st.cursorSet(1);
        state = try a.dupe(u8, (try st.state(a)).?);

        // A view made now holds this state while the writer moves on.
        const v = try View.open(testing.allocator, db, "alice");
        defer v.close();
        try st.cursorSet(2);
        try testing.expect(!std.mem.eql(u8, state, (try st.state(a)).?));
        try testing.expectEqualSlices(u8, state, (try v.store().state(a)).?);
        try testing.expectEqual(@as(i64, 1), try v.store().cursorGet());
        try testing.expectEqual(@as(i64, 2), try st.cursorGet());
        try testing.expectEqualSlices(u8, (try st.state(a)).?, (try db.pointerOf(a, "alice", index.POINTER)).?);
        state = try a.dupe(u8, (try st.state(a)).?);
    }
    {
        const s = try RocksStore.openReadOnly(testing.allocator, testing.io, dir, "alice");
        defer s.close();
        try testing.expectEqualSlices(u8, state, (try s.store().state(a)).?);
        try testing.expectEqual(@as(i64, 2), try s.store().cursorGet());
        try testing.expect(try s.hasState());
        try testing.expectError(error.ReadOnly, s.store().putBlock(state, "x"));
    }
    {
        const s = try RocksStore.open(testing.allocator, testing.io, dir, "bob");
        defer s.close();
        try testing.expect((try s.store().state(a)) == null);
        try testing.expect(!try s.store().has(state));
        try testing.expect(!try s.hasState());
    }
}
