// The store as one SQLite file, and only as a key→bytes map (issue #30): the
// `blocks` table (the same as src/runtime/sqlite.ts's) and a `pointers` table
// holding one row, the CID of the state record (index.zig). The index — the
// log by n, chains, thread states, sleepers, awaits, edges, heads — is blocks
// like any other record; nothing about it is a schema.
//
// A file the TypeScript runtime (or the kernel before #30) wrote has the log
// in `entries` and the index in `chains`/`updates`/`edges`. Opened here, it
// is imported: the maps are built from those rows (the log from `entries`,
// every chain from its origin and updates, all derived as the incremental
// path derives them), then — opened for writing — the state record is written
// and the old tables are renamed `legacy_*` so nothing reads them stale. Read
// only (a replay's source), the import stays in memory.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const sql = @import("sqlite.zig");
const storem = @import("store.zig");
const index = @import("index.zig");
const Value = cbor.Value;

pub const DDL =
    \\CREATE TABLE IF NOT EXISTS blocks (
    \\  cid   BLOB PRIMARY KEY,
    \\  bytes BLOB NOT NULL
    \\) WITHOUT ROWID;
    \\
    \\-- The mutable pointers: "state" → the state record (index.zig).
    \\CREATE TABLE IF NOT EXISTS pointers (
    \\  name TEXT PRIMARY KEY,
    \\  cid  BLOB NOT NULL
    \\) WITHOUT ROWID;
    \\
;

/// The tables of the format before #30, renamed on import.
const LEGACY = [_][]const u8{ "chains", "updates", "edges", "messages", "handles", "entries", "meta" };

pub const SqliteStore = struct {
    db: *sql.Db,
    alloc: std.mem.Allocator,
    ix: *index.Index,
    read_only: bool,

    /// An existing file for reading only: nothing is written (an import stays in memory).
    pub fn openReadOnly(alloc: std.mem.Allocator, path: []const u8) !*SqliteStore {
        const db = try sql.Db.open(alloc, path, true);
        errdefer db.close();
        try db.exec("PRAGMA busy_timeout = 5000;");
        return init(alloc, db, path, true);
    }

    /// A store to run on, created if missing. A store with a log in an older
    /// format is refused (re-genesis): before fuel metering (issue #5) its
    /// updates carry no fuel; before format 2 (issue #33) its entries are
    /// host-signed and its keys hex.
    pub fn open(alloc: std.mem.Allocator, path: []const u8) !*SqliteStore {
        if (std.fs.cwd().statFile(path)) |st| {
            if (st.size > 0) {
                const probe = try openReadOnly(alloc, path);
                defer probe.close();
                if (probe.predatesFuel()) {
                    if (probe.ix.loaded_format < 1) {
                        std.log.err("{s}: a store written before fuel metering (issue #5): its updates carry no fuel; refused (start a new store: re-genesis)", .{path});
                    } else if (probe.ix.loaded_format == 2) {
                        std.log.err("{s}: a store written before format 3 (issue #40: messages as mail records, no envelopes or emits): refused (start a new store: re-genesis)", .{path});
                    } else {
                        std.log.err("{s}: a store written before format 2 (issue #33: unsigned entries, keys as bytes): refused (start a new store: re-genesis)", .{path});
                    }
                    return error.PredatesFuel;
                }
            }
        } else |_| {}
        const db = try sql.Db.open(alloc, path, false);
        errdefer db.close();
        try db.exec(
            \\
            \\      PRAGMA journal_mode = WAL;
            \\      PRAGMA synchronous = NORMAL;
            \\      PRAGMA busy_timeout = 5000;
            \\
        );
        try db.exec(DDL);
        return init(alloc, db, path, false);
    }

    fn init(alloc: std.mem.Allocator, db: *sql.Db, path: []const u8, read_only: bool) !*SqliteStore {
        const s = try alloc.create(SqliteStore);
        errdefer alloc.destroy(s);
        s.* = .{ .db = db, .alloc = alloc, .ix = undefined, .read_only = read_only };
        s.ix = try index.Index.init(alloc, s.backend(), read_only);
        errdefer s.ix.deinit();
        const has_pointers = try s.hasTable("pointers");
        if (has_pointers and try s.ix.load()) {
            if (!read_only) try s.retireLegacy();
            return s;
        }
        if (try s.hasTable("entries") or try s.hasTable("chains")) {
            try s.importLegacy(path);
            if (!read_only) {
                try s.ix.commitAll();
                try s.retireLegacy();
            }
        }
        return s;
    }

    /// Holds a log written in an older format than this kernel's (a state
    /// record without `format` or with a lower one, or an older file's tables).
    pub fn predatesFuel(s: *SqliteStore) bool {
        return s.ix.loaded_format < index.FORMAT and s.ix.work.tip.get() != null;
    }

    pub fn close(s: *SqliteStore) void {
        s.ix.commitAll() catch |err| std.log.err("store: final commit: {s}", .{@errorName(err)});
        s.ix.deinit();
        s.db.close();
        s.alloc.destroy(s);
    }

    pub fn store(s: *SqliteStore) storem.Store {
        return s.ix.store();
    }

    fn hasTable(s: *SqliteStore, name: []const u8) !bool {
        const st = try s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
        try st.bind(&.{.{ .text = name }});
        const r = try st.step();
        st.done();
        return r;
    }

    /// Every block of one codec (the replay tool copies modules this way).
    pub fn blocksOfCodec(s: *SqliteStore, a: std.mem.Allocator, codec: u64) ![][2][]u8 {
        const st = try s.db.prepare("SELECT cid, bytes FROM blocks ORDER BY cid");
        var out = std.array_list.Managed([2][]u8).init(a);
        while (try st.step()) {
            const c = st.blob(0);
            if (cidm.codecOf(c) != codec) continue;
            try out.append(.{ try a.dupe(u8, c), try a.dupe(u8, st.blob(1)) });
        }
        return out.items;
    }

    /// Every block's CID, in CID order (dump).
    pub fn allCids(s: *SqliteStore, a: std.mem.Allocator) ![][]u8 {
        const st = try s.db.prepare("SELECT cid FROM blocks ORDER BY cid");
        var out = std.array_list.Managed([]u8).init(a);
        while (try st.step()) try out.append(try a.dupe(u8, st.blob(0)));
        return out.items;
    }

    /// Adopt a checkpoint (issue #4): the state record `state`, whose blocks
    /// the loader has already put (verified against its packet), becomes this
    /// store's state — the pointer moves to it and the index is read from it,
    /// never rebuilt. Only into a store with no log; only this kernel's format.
    pub fn restore(s: *SqliteStore, state: []const u8) !void {
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

    // -------------------------------------------------------- the backend

    fn backend(s: *SqliteStore) index.Backend {
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
    };

    fn self(ctx: *anyopaque) *SqliteStore {
        return @ptrCast(@alignCast(ctx));
    }

    fn getFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const st = try self(ctx).db.prepare("SELECT bytes FROM blocks WHERE cid = ?");
        try st.bind(&.{.{ .blob = cid }});
        if (!try st.step()) return null;
        defer st.done();
        return try a.dupe(u8, st.blob(0));
    }

    fn hasFn(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        const st = try self(ctx).db.prepare("SELECT 1 AS x FROM blocks WHERE cid = ?");
        try st.bind(&.{.{ .blob = cid }});
        const r = try st.step();
        st.done();
        return r;
    }

    fn putFn(ctx: *anyopaque, cid: []const u8, b: []const u8) anyerror!void {
        if (self(ctx).read_only) return error.ReadOnly;
        try (try self(ctx).db.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)")).run(&.{ .{ .blob = cid }, .{ .blob = b } });
    }

    fn beginFn(ctx: *anyopaque) anyerror!void {
        try (try self(ctx).db.prepare("BEGIN IMMEDIATE")).run(&.{});
    }
    fn commitFn(ctx: *anyopaque) anyerror!void {
        try (try self(ctx).db.prepare("COMMIT")).run(&.{});
    }
    fn rollbackFn(ctx: *anyopaque) void {
        const s = self(ctx);
        if (s.db.inTransaction()) (s.db.prepare("ROLLBACK") catch return).run(&.{}) catch {};
    }

    fn pointerFn(ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const st = try self(ctx).db.prepare("SELECT cid FROM pointers WHERE name = ?");
        try st.bind(&.{.{ .text = name }});
        if (!try st.step()) return null;
        defer st.done();
        return try a.dupe(u8, st.blob(0));
    }

    fn setPointerFn(ctx: *anyopaque, name: []const u8, cid: []const u8) anyerror!void {
        try (try self(ctx).db.prepare("INSERT INTO pointers (name, cid) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET cid = excluded.cid")).run(&.{ .{ .text = name }, .{ .blob = cid } });
    }

    // -------------------------------------------------------- the format before #30

    fn columns(s: *SqliteStore, table: []const u8, a: std.mem.Allocator) ![][]u8 {
        // Static SQL: the statement cache keys on the text.
        const st = try s.db.prepare("SELECT cid, name FROM pragma_table_info(?)");
        try st.bind(&.{.{ .text = table }});
        var out = std.array_list.Managed([]u8).init(a);
        while (try st.step()) try out.append(try a.dupe(u8, st.text(1)));
        return out.items;
    }

    fn importLegacy(s: *SqliteStore, path: []const u8) !void {
        var arena = std.heap.ArenaAllocator.init(s.alloc);
        defer arena.deinit();
        const a = arena.allocator();
        // sqlite.ts rebuilds an older index before use; that rebuild is not ported (README).
        if (try s.hasTable("chains")) {
            const cols = try s.columns("chains", a);
            for ([_][]const u8{ "tip_at", "program", "waiting_from", "awaits" }) |want| {
                var found = false;
                for (cols) |c| if (std.mem.eql(u8, c, want)) {
                    found = true;
                };
                if (!found) return stale(path);
            }
            if (!try s.hasTable("messages")) return stale(path);
            if (!try s.hasTable("updates")) return stale(path);
        }
        if (try s.hasTable("entries")) {
            const st = try s.db.prepare("SELECT n, cid, envelope FROM entries ORDER BY n");
            while (try st.step()) {
                const uniq: ?[]const u8 = if (st.isNull(2)) null else try a.dupe(u8, st.blob(2));
                try s.ix.importEntry(st.int(0), try a.dupe(u8, st.blob(1)), uniq);
            }
        }
        if (try s.hasTable("chains")) {
            const Chain = struct { origin: []u8, tip: []u8, seq: i64 };
            var chains = std.array_list.Managed(Chain).init(a);
            {
                const st = try s.db.prepare("SELECT origin, tip, seq FROM chains ORDER BY origin");
                while (try st.step()) try chains.append(.{ .origin = try a.dupe(u8, st.blob(0)), .tip = try a.dupe(u8, st.blob(1)), .seq = st.int(2) });
            }
            for (chains.items) |c| {
                const st = try s.db.prepare("SELECT cid FROM updates WHERE origin = ? ORDER BY seq");
                try st.bind(&.{.{ .blob = c.origin }});
                var ups = std.array_list.Managed([]const u8).init(a);
                while (try st.step()) try ups.append(try a.dupe(u8, st.blob(0)));
                try s.ix.importChain(c.origin, ups.items, c.tip, c.seq);
            }
        }
        if (try s.hasTable("meta")) {
            const st = try s.db.prepare("SELECT value FROM meta WHERE key = 'cursor'");
            if (try st.step()) {
                s.ix.setCursor(st.int(0));
                st.done();
            }
        }
    }

    fn stale(path: []const u8) error{StaleIndex} {
        std.log.err("{s}: an older store whose index needs a rebuild (skein-dev rebuild)", .{path});
        return error.StaleIndex;
    }

    /// The pre-#30 tables, renamed so that nothing reads them as current.
    fn retireLegacy(s: *SqliteStore) !void {
        var buf: [128]u8 = undefined;
        for (LEGACY) |t| {
            if (!try s.hasTable(t)) continue;
            const legacy = try std.fmt.bufPrint(&buf, "legacy_{s}", .{t});
            if (try s.hasTable(legacy)) {
                // Already retired once; a TS opener (sqlite.ts) recreated the table empty
                // on a later open. Drop the empty duplicate; a filled one is a real conflict.
                var qb: [128]u8 = undefined;
                const cnt = try s.db.prepare(try std.fmt.bufPrint(&qb, "SELECT COUNT(*) FROM \"{s}\"", .{t}));
                _ = try cnt.step();
                const n = cnt.int(0);
                cnt.done();
                if (n != 0) {
                    std.log.err("store: both {s} and {s} hold rows; refusing to retire", .{ t, legacy });
                    return error.LegacyConflict;
                }
                var qd: [128]u8 = undefined;
                try s.db.exec(try std.fmt.bufPrint(&qd, "DROP TABLE \"{s}\"", .{t}));
                continue;
            }
            var qr: [160]u8 = undefined;
            const q = try std.fmt.bufPrint(&qr, "ALTER TABLE \"{s}\" RENAME TO \"legacy_{s}\"", .{ t, t });
            try s.db.exec(q);
        }
    }
};
