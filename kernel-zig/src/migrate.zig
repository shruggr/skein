// `skein-kernel migrate --from <store> --into <target> --set <handle>` (#96,
// #158): a store copied into a set of the host's shared store — an LMDB
// environment (`--into <env dir>`) or the one-process kernel's RocksDB
// database (`--into rocksdb:<db dir>`, while `skein-kernel host` is down) —
// every block into `blocks` and the set's members, the state pointer last
// (the set's size counted as the blocks go in). The source is a SQLite file or
// (into RocksDB) an LMDB set, `lmdb:<env dir>#<set>`. The records are the same
// bytes: the state CID and the CID list stay as they were. A target set that
// already has a state pointer is refused; a source in an older format (or
// with no state) too. The source is only read; nothing deletes it
// (`skein-host migrate-store` keeps a file beside, renamed).
const std = @import("std");
const cidm = @import("cid");
const lmdb = @import("lmdb_store.zig");
const rocks = @import("rocksdb_store.zig");
const any = @import("any_store.zig");

/// Blocks per write transaction: the pointer moves in the last one, so a set half-copied (a crash)
/// has no state and a second run completes it.
const BATCH = 4096;

pub fn main(gpa: std.mem.Allocator, io: std.Io, from: []const u8, into: []const u8, set: []const u8) !u8 {
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    const src = try any.AnyStore.openReadOnly(gpa, io, from);
    defer src.close();
    if (src.predatesFuel()) {
        std.debug.print("{s}: a store in an older format than this kernel's: not migrated (start a new store: re-genesis)\n", .{from});
        return 1;
    }
    const state = (try src.store().state(a)) orelse {
        std.debug.print("{s}: no state record: nothing to migrate\n", .{from});
        return 1;
    };

    if (std.mem.startsWith(u8, into, any.ROCKS_PREFIX)) {
        const dir = into[any.ROCKS_PREFIX.len..];
        const db = try rocks.Db.open(gpa, io, dir, false);
        defer db.close(gpa);
        const dst = try rocks.RocksStore.openIn(gpa, db, set);
        defer dst.close();
        return copy(io, a, gpa, src, dst, state, into, set);
    }
    const env = try lmdb.Env.open(gpa, io, into, false);
    defer env.close(gpa);
    const dst = try lmdb.LmdbStore.openIn(gpa, env, set);
    defer dst.close();
    return copy(io, a, gpa, src, dst, state, into, set);
}

fn copy(io: std.Io, a: std.mem.Allocator, gpa: std.mem.Allocator, src: any.AnyStore, dst: anytype, state: []const u8, into: []const u8, set: []const u8) !u8 {
    if (try dst.hasState()) {
        std.debug.print("{s}#{s}: the set has a state already: refused\n", .{ into, set });
        return 1;
    }

    const cids = try src.allCids(a);
    var batch = std.array_list.Managed([2][]const u8).init(gpa);
    defer batch.deinit();
    var i: usize = 0;
    while (i < cids.len or i == 0) {
        var scratch = std.heap.ArenaAllocator.init(gpa);
        defer scratch.deinit();
        const sa = scratch.allocator();
        batch.clearRetainingCapacity();
        const end = @min(cids.len, i + BATCH);
        for (cids[i..end]) |c| {
            const b = (try src.store().bytes(sa, c)) orelse return error.MissingBlock;
            try batch.append(.{ c, b });
        }
        try dst.putBatch(batch.items, if (end == cids.len) state else null);
        i = end;
        if (cids.len == 0) break;
    }
    // The index read from the state just written: closing writes nothing.
    dst.ix.forest.reset(true);
    if (!try dst.ix.load()) return error.MissingState;

    const size = try dst.store().size();
    const out = try std.fmt.allocPrint(a, "{{\"set\":\"{s}\",\"blocks\":{d},\"size\":{d},\"state\":\"{s}\"}}\n", .{ set, cids.len, size, try cidm.format(a, state) });
    try std.Io.File.stdout().writeStreamingAll(io, out);
    return 0;
}
