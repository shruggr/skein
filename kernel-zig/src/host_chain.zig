// The host chain's tracker (#156 piece two, #133): the header chain a host
// keeps once for all its instances, kept by the kernel process — `skein-kernel
// host` writes it into the `host/chain` set of its RocksDB database (every
// instance reads it through the chain exception, rocksdb_store.zig); `serve`
// writes it into its one instance's own store (SQLite, or its LMDB set). The
// code is the SDK's `chain` module (skein-sdk `chain.host`: `Chain.add`, the
// heavier-branch rule, `image.loadMaps`), used natively here.
//
// The record, under the pointer `host/chain` (RocksDB: in the set
// `host/chain`; SQLite: the pointer row `host/chain`; LMDB serve: in its set):
//
//   {kind: "host-chain", network, maps: {headers, heights}, tip: {height, hash}}
//
// The three frames (host.zig, serve.zig; no `h`):
//
//   headers {raws: [bytes]}         a run of headers, parents first → {root, height, hash, added, replaced}
//   chain-import {set, root}        an image's chain/headers (the tree `root`, whose blocks the
//                                   instance `set` holds) into an empty host chain → the same, or
//                                   refused when the host chain has a tip
//   chain                           → {root, height, hash} or null
//
// The network is the host's (SKEIN_NETWORK, default main): a record of another
// network is refused. Writes serialize on one mutex (one writer: the host);
// reads are by CID. The shim below is the SDK chain `Store` over a kernel
// backend: get, put, putBlock — the three functions the header chain uses.
const std = @import("std");
const cbor = @import("cbor");
const index = @import("index.zig");
const envm = @import("env.zig");
const lib = @import("chainlib");
const Value = cbor.Value;
const Io = std.Io;

/// The pointer the host chain record is kept under.
pub const POINTER = "host/chain";

/// A reader of blocks by CID (an instance's set, for an import): null when it does not hold one.
pub const Reader = struct {
    ctx: *anyopaque,
    get: *const fn (ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8,
};

pub const Answer = struct { root: []const u8, height: u32, hash: [32]u8, added: u32 = 0, replaced: u32 = 0 };

/// The host's network (SKEIN_NETWORK, default main).
pub fn hostNetwork() !lib.chain.Network {
    const n = envm.get("SKEIN_NETWORK") orelse "main";
    return lib.chain.Network.parse(n) orelse error.BadNetwork;
}

pub const HostChain = struct {
    backend: index.Backend,
    network: lib.chain.Network,
    io: Io,
    mu: Io.Mutex = .init,

    pub fn init(backend: index.Backend, network: lib.chain.Network, io: Io) HostChain {
        return .{ .backend = backend, .network = network, .io = io };
    }

    // ------------------------------------------------ the SDK store over the backend

    const Shim = struct {
        hc: *HostChain,
        extra: ?Reader = null,

        fn self(p: *anyopaque) *Shim {
            return @ptrCast(@alignCast(p));
        }
        fn getFn(p: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror![]const u8 {
            const s = self(p);
            const b = s.hc.backend;
            if (try b.vt.get(b.ctx, a, cid)) |x| return x;
            if (s.extra) |r| if (try r.get(r.ctx, a, cid)) |x| return x;
            return error.NotFound;
        }
        /// dag-cbor bytes → canonical, as the kernel's `put` stores a record: its CID.
        fn putFn(p: *anyopaque, a: std.mem.Allocator, bytes: []const u8) anyerror![]const u8 {
            const s = self(p);
            const blk = try cbor.block(a, try cbor.decode(a, bytes));
            try s.hc.backend.vt.put(s.hc.backend.ctx, blk.cid, blk.bytes);
            return blk.cid;
        }
        fn putBlockFn(p: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
            const s = self(p);
            try s.hc.backend.vt.put(s.hc.backend.ctx, cid, bytes);
        }
        fn store(s: *Shim) lib.store.Store {
            return .{ .ptr = s, .getFn = getFn, .putFn = putFn, .putBlockFn = putBlockFn };
        }
    };

    fn lock(hc: *HostChain) void {
        hc.mu.lockUncancelable(hc.io);
    }
    fn unlock(hc: *HostChain) void {
        hc.mu.unlock(hc.io);
    }

    /// The current record's CID, or null.
    fn pointer(hc: *HostChain, a: std.mem.Allocator) !?[]u8 {
        return hc.backend.vt.pointer(hc.backend.ctx, a, POINTER);
    }

    fn answerOf(a: std.mem.Allocator, s: lib.store.Store, root: []const u8) !Answer {
        const r = try lib.host.read(a, s, root);
        const t = r.tip orelse return error.BadHostChain;
        return .{ .root = root, .height = t.height, .hash = t.hash };
    }

    /// The host chain as it stands: its record and tip, or null.
    pub fn current(hc: *HostChain, a: std.mem.Allocator) !?Answer {
        hc.lock();
        defer hc.unlock();
        var shim = Shim{ .hc = hc };
        const root = (try hc.pointer(a)) orelse return null;
        return try answerOf(a, shim.store(), root);
    }

    /// A run of headers, parents first: `Chain.add` (its checks, the heavier branch), the record
    /// saved and the pointer moved in one commit. Nothing new (every header known, or a lighter
    /// branch): nothing written, the record as it stands. A run that does not connect is refused as
    /// `Chain.add` refuses it.
    pub fn add(hc: *HostChain, a: std.mem.Allocator, raws: []const []const u8) !Answer {
        hc.lock();
        defer hc.unlock();
        var shim = Shim{ .hc = hc };
        const s = shim.store();
        const prior = try hc.pointer(a);
        var h = try lib.host.Host.open(a, s, prior, hc.network);
        const b = hc.backend;
        try b.vt.begin(b.ctx);
        errdefer b.vt.rollback(b.ctx);
        const res = try h.add(raws);
        if (prior != null and res.added == 0 and res.replaced == 0) {
            b.vt.rollback(b.ctx);
            return answerOf(a, s, prior.?);
        }
        const root = (try h.save()) orelse return error.BadHostChain;
        try b.vt.setPointer(b.ctx, POINTER, root);
        try b.vt.commit(b.ctx);
        var ans = try answerOf(a, s, root);
        ans.added = res.added;
        ans.replaced = res.replaced;
        return ans;
    }

    /// The header chain an image tree carries (`root`; its blocks read through `from`, the
    /// instance's set that holds them) into the empty host chain: error.NotEmpty when the host
    /// chain has a tip, error.NoChain when the tree carries none.
    pub fn import(hc: *HostChain, a: std.mem.Allocator, from: ?Reader, root: []const u8) !Answer {
        hc.lock();
        defer hc.unlock();
        var shim = Shim{ .hc = hc, .extra = from };
        const s = shim.store();
        if ((try hc.pointer(a)) != null) return error.NotEmpty;
        var h = try lib.host.Host.open(a, s, null, hc.network);
        const b = hc.backend;
        try b.vt.begin(b.ctx);
        errdefer b.vt.rollback(b.ctx);
        const got = (try h.import(root)) orelse return error.NoChain;
        const rec = (try h.save()) orelse return error.BadHostChain;
        try b.vt.setPointer(b.ctx, POINTER, rec);
        try b.vt.commit(b.ctx);
        var ans = try answerOf(a, s, rec);
        ans.added = got.headers;
        return ans;
    }
};

/// An answer as the frame's value: {root, height, hash (display hex), added?, replaced?}.
pub fn answerValue(a: std.mem.Allocator, ans: Answer, with_counts: bool) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("root", cbor.cidv(ans.root));
    try m.put("height", cbor.int(ans.height));
    try m.put("hash", cbor.string(try a.dupe(u8, &lib.header.toHex(ans.hash))));
    if (with_counts) {
        try m.put("added", cbor.int(ans.added));
        try m.put("replaced", cbor.int(ans.replaced));
    }
    return m.value();
}

/// The `headers` frame's raws: {raws: [bytes]}.
pub fn rawsOf(a: std.mem.Allocator, v: Value) ![]const []const u8 {
    const arr = v.get("raws") orelse return error.BadRequest;
    if (arr != .array) return error.BadRequest;
    const out = try a.alloc([]const u8, arr.array.len);
    for (arr.array, out) |x, *o| o.* = Value.bytesOf(x) orelse return error.BadRequest;
    return out;
}

/// Whether `op` is one of the three frames.
pub fn isOp(op: []const u8) bool {
    for ([_][]const u8{ "chain", "headers", "chain-import" }) |x| if (std.mem.eql(u8, op, x)) return true;
    return false;
}

/// One of the three frames over `hc` (`from`: the reader of `chain-import`'s set): the answer value.
pub fn run(hc: *HostChain, a: std.mem.Allocator, op: []const u8, v: Value, from: ?Reader) !Value {
    const eq = std.mem.eql;
    if (eq(u8, op, "chain")) {
        return if (try hc.current(a)) |c| answerValue(a, c, false) else .null;
    }
    if (eq(u8, op, "headers")) return answerValue(a, try hc.add(a, try rawsOf(a, v)), true);
    if (eq(u8, op, "chain-import")) {
        const root = Value.cidOf(v.get("root")) orelse return error.BadRequest;
        return answerValue(a, try hc.import(a, from, root), true);
    }
    return error.UnknownOp;
}

// ------------------------------------------------------------------ tests

const testing = std.testing;
const rocks = @import("rocksdb_store.zig");

fn mine(prev: [32]u8, n: u32) [80]u8 {
    var h = lib.header.Header{ .version = 1, .prev_hash = prev, .merkle_root = .{@as(u8, @truncate(n))} ** 32, .time = 1_790_000_000 + n * 600, .bits = 0x207fffff, .nonce = 0 };
    while (true) : (h.nonce += 1) {
        const raw = h.serialize();
        if (lib.header.powOk(&raw)) return raw;
    }
}

fn regtest(a: std.mem.Allocator, n: usize) ![][80]u8 {
    const out = try a.alloc([80]u8, n);
    out[0] = lib.chain.Network.regtest.genesis();
    for (out[1..], 1..) |*h, i| h.* = mine(lib.header.hash(&out[i - 1]), @intCast(i));
    return out;
}

/// An instance set's backend as the SDK's store (to write an image tree into it).
const SetStore = struct {
    b: index.Backend,
    fn get(p: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror![]const u8 {
        const s: *SetStore = @ptrCast(@alignCast(p));
        return (try s.b.vt.get(s.b.ctx, a, cid)) orelse error.NotFound;
    }
    fn put(p: *anyopaque, a: std.mem.Allocator, bytes: []const u8) anyerror![]const u8 {
        const s: *SetStore = @ptrCast(@alignCast(p));
        const blk = try cbor.block(a, try cbor.decode(a, bytes));
        try s.b.vt.put(s.b.ctx, blk.cid, blk.bytes);
        return blk.cid;
    }
    fn putBlock(p: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
        const s: *SetStore = @ptrCast(@alignCast(p));
        try s.b.vt.put(s.b.ctx, cid, bytes);
    }
    fn store(s: *SetStore) lib.store.Store {
        return .{ .ptr = s, .getFn = get, .putFn = put, .putBlockFn = putBlock };
    }
};

const SetRead = struct {
    db: *rocks.Db,
    set: []const u8,
    fn get(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const r: *SetRead = @ptrCast(@alignCast(ctx));
        return r.db.setGet(a, r.set, cid);
    }
};

test "host chain on RocksDB: headers into host/chain, read by every instance; nothing new writes nothing; a heavier branch; an image imported into an empty one only" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const base = if (std.c.getenv("TMPDIR")) |b| std.mem.span(b) else "/tmp";
    const dir = try std.fmt.allocPrint(a, "{s}/skein-hostchain-test-{d}", .{ base, std.c.getpid() });
    std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};
    defer std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};

    const db = try rocks.Db.open(testing.allocator, testing.io, dir, false);
    defer db.close(testing.allocator);
    const cs = try rocks.RocksStore.openChain(testing.allocator, db);
    defer cs.close();
    var hc = HostChain.init(cs.backend(), .regtest, testing.io);
    try testing.expect((try hc.current(a)) == null);

    const hs = try regtest(a, 12);
    const raws = try a.alloc([]const u8, 10);
    for (hs[1..11], raws) |*h, *r| r.* = h;
    const r1 = try hc.add(a, raws);
    try testing.expectEqual(@as(u32, 10), r1.height);
    try testing.expectEqual(@as(u32, 10), r1.added);
    try testing.expectEqualSlices(u8, &lib.header.hash(&hs[10]), &r1.hash);
    // The same run again: nothing written, the same record.
    const r1b = try hc.add(a, raws[5..]);
    try testing.expectEqualSlices(u8, r1.root, r1b.root);
    try testing.expectEqual(@as(u32, 0), r1b.added);
    // A run that does not connect: refused, nothing written.
    try testing.expectError(error.Unconnected, hc.add(a, &.{&mine(.{9} ** 32, 99)}));
    try testing.expectEqualSlices(u8, r1.root, (try hc.current(a)).?.root);

    // Every instance reads the host chain (the chain exception); its blocks are no instance's members.
    const alice = try rocks.RocksStore.openIn(testing.allocator, db, "alice");
    defer alice.close();
    const bob = try rocks.RocksStore.openIn(testing.allocator, db, "bob");
    defer bob.close();
    const hcid = lib.store.hashCid(.block, lib.header.hash(&hs[7]));
    try testing.expect((try alice.store().bytes(a, r1.root)) != null);
    try testing.expect((try bob.store().bytes(a, &hcid)) != null);
    const own = try cbor.block(a, cbor.string("alice's own"));
    try alice.store().putBlock(own.cid, own.bytes);
    try testing.expect((try bob.store().bytes(a, own.cid)) == null);

    // A heavier branch from 8: two replaced, three added.
    const b9 = mine(lib.header.hash(&hs[8]), 109);
    const b10 = mine(lib.header.hash(&b9), 110);
    const b11 = mine(lib.header.hash(&b10), 111);
    const r2 = try hc.add(a, &.{ &b9, &b10, &b11 });
    try testing.expectEqual(@as(u32, 11), r2.height);
    try testing.expectEqual(@as(u32, 2), r2.replaced);
    try testing.expectEqual(@as(u32, 3), r2.added);
    // The old record still reads (an old event resolves on replay).
    try testing.expect((try alice.store().bytes(a, r1.root)) != null);

    // An image: its tree in carol's set; imported into a host chain that has a tip: refused.
    const carol = try rocks.RocksStore.openIn(testing.allocator, db, "carol");
    defer carol.close();
    var ss = SetStore{ .b = carol.backend() };
    const img = try lib.image.write(a, ss.store(), hs);
    var rd = SetRead{ .db = db, .set = "carol" };
    try testing.expectError(error.NotEmpty, hc.import(a, .{ .ctx = &rd, .get = SetRead.get }, &img.root));

    // Into an empty host chain (a second database): the image's tip; the same record as adding the run.
    const dir2 = try std.fmt.allocPrint(a, "{s}-2", .{dir});
    std.Io.Dir.cwd().deleteTree(testing.io, dir2) catch {};
    defer std.Io.Dir.cwd().deleteTree(testing.io, dir2) catch {};
    const db2 = try rocks.Db.open(testing.allocator, testing.io, dir2, false);
    defer db2.close(testing.allocator);
    const cs2 = try rocks.RocksStore.openChain(testing.allocator, db2);
    defer cs2.close();
    const dave = try rocks.RocksStore.openIn(testing.allocator, db2, "dave");
    defer dave.close();
    var ss2 = SetStore{ .b = dave.backend() };
    const img2 = try lib.image.write(a, ss2.store(), hs[0..11]);
    var hc2 = HostChain.init(cs2.backend(), .regtest, testing.io);
    var rd2 = SetRead{ .db = db2, .set = "dave" };
    const imp = try hc2.import(a, .{ .ctx = &rd2, .get = SetRead.get }, &img2.root);
    try testing.expectEqual(@as(u32, 10), imp.height);
    try testing.expectEqual(@as(u32, 11), imp.added);
    try testing.expectEqualSlices(u8, r1.root, imp.root);
    // Another network: refused.
    var hc3 = HostChain.init(cs2.backend(), .main, testing.io);
    try testing.expectError(error.NetworkMismatch, hc3.add(a, &.{&b9}));
}
