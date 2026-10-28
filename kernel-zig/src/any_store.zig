// A store on any backend (#96, #158): the SQLite file (sqlite_store.zig, the
// default), a set in the host's LMDB environment (lmdb_store.zig), or a set in
// the host's RocksDB database (rocksdb_store.zig: the one-process kernel's,
// `skein-kernel host`). What `serve`, `replay`, `dump`, `fuel`, `shell` and
// `migrate` hold; above it the kernel sees the same store.Store either way.
//
// A store named on the command line is a SQLite file's path,
// `lmdb:<env dir>#<set>` — a set in an environment — or
// `rocksdb:<db dir>#<set>` — a set in a RocksDB database, which one process
// opens at a time (a tool opens it while `skein-kernel host` is down). `serve`
// takes the LMDB environment from SKEIN_STORE and the set from its handle
// (serve.zig); `host` opens its database once and its sets by frame (host.zig).
const std = @import("std");
const storem = @import("store.zig");
const index = @import("index.zig");
pub const SqliteStore = @import("sqlite_store.zig").SqliteStore;
pub const LmdbStore = @import("lmdb_store.zig").LmdbStore;
pub const RocksStore = @import("rocksdb_store.zig").RocksStore;

pub const PREFIX = "lmdb:";
pub const ROCKS_PREFIX = "rocksdb:";

/// `lmdb:<dir>#<set>` → its parts; null for a SQLite path.
pub const Spec = struct { dir: []const u8, set: []const u8 };

pub fn parseSpec(spec: []const u8) ?Spec {
    return parseWith(PREFIX, spec);
}

/// `rocksdb:<dir>#<set>` → its parts; null for anything else.
pub fn parseRocksSpec(spec: []const u8) ?Spec {
    return parseWith(ROCKS_PREFIX, spec);
}

fn parseWith(prefix: []const u8, spec: []const u8) ?Spec {
    if (!std.mem.startsWith(u8, spec, prefix)) return null;
    const rest = spec[prefix.len..];
    const hash = std.mem.lastIndexOfScalar(u8, rest, '#') orelse return null;
    if (hash == 0 or hash + 1 == rest.len) return null;
    return .{ .dir = rest[0..hash], .set = rest[hash + 1 ..] };
}

pub const AnyStore = union(enum) {
    sqlite: *SqliteStore,
    lmdb: *LmdbStore,
    rocksdb: *RocksStore,

    /// A store to run on, created if missing.
    pub fn open(alloc: std.mem.Allocator, io: std.Io, spec: []const u8) !AnyStore {
        if (std.mem.startsWith(u8, spec, ROCKS_PREFIX)) {
            const p = parseRocksSpec(spec) orelse return badSpec(spec);
            return .{ .rocksdb = try RocksStore.open(alloc, io, p.dir, p.set) };
        }
        if (std.mem.startsWith(u8, spec, PREFIX)) {
            const p = parseSpec(spec) orelse return badSpec(spec);
            return .{ .lmdb = try LmdbStore.open(alloc, io, p.dir, p.set) };
        }
        return .{ .sqlite = try SqliteStore.open(alloc, io, spec) };
    }

    /// An existing store for reading only.
    pub fn openReadOnly(alloc: std.mem.Allocator, io: std.Io, spec: []const u8) !AnyStore {
        if (std.mem.startsWith(u8, spec, ROCKS_PREFIX)) {
            const p = parseRocksSpec(spec) orelse return badSpec(spec);
            return .{ .rocksdb = try RocksStore.openReadOnly(alloc, io, p.dir, p.set) };
        }
        if (std.mem.startsWith(u8, spec, PREFIX)) {
            const p = parseSpec(spec) orelse return badSpec(spec);
            return .{ .lmdb = try LmdbStore.openReadOnly(alloc, io, p.dir, p.set) };
        }
        return .{ .sqlite = try SqliteStore.openReadOnly(alloc, spec) };
    }

    fn badSpec(spec: []const u8) error{BadStoreSpec} {
        std.log.err("{s}: a set is lmdb:<env dir>#<set> or rocksdb:<db dir>#<set>", .{spec});
        return error.BadStoreSpec;
    }

    pub fn close(s: AnyStore) void {
        switch (s) {
            inline else => |x| x.close(),
        }
    }
    pub fn store(s: AnyStore) storem.Store {
        return switch (s) {
            inline else => |x| x.store(),
        };
    }
    /// The backend under the index (the host chain's tracker writes through it, #156).
    pub fn backend(s: AnyStore) index.Backend {
        return switch (s) {
            inline else => |x| x.backend(),
        };
    }
    pub fn ix(s: AnyStore) *index.Index {
        return switch (s) {
            inline else => |x| x.ix,
        };
    }
    pub fn predatesFuel(s: AnyStore) bool {
        return switch (s) {
            inline else => |x| x.predatesFuel(),
        };
    }
    pub fn blocksOfCodec(s: AnyStore, a: std.mem.Allocator, codec: u64) ![][2][]u8 {
        return switch (s) {
            inline else => |x| x.blocksOfCodec(a, codec),
        };
    }
    pub fn allCids(s: AnyStore, a: std.mem.Allocator) ![][]u8 {
        return switch (s) {
            inline else => |x| x.allCids(a),
        };
    }
    pub fn restore(s: AnyStore, state: []const u8) !void {
        return switch (s) {
            inline else => |x| x.restore(state),
        };
    }
};
