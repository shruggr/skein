// The Store as one SQLite file: the same schema, the same derived columns and
// the same queries as src/runtime/sqlite.ts, so a file written here is the
// file the TypeScript runtime writes (and the explorer reads it unchanged).
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const sql = @import("sqlite.zig");
const storem = @import("store.zig");
const Value = cbor.Value;

pub const DDL =
    \\CREATE TABLE IF NOT EXISTS blocks (
    \\  cid   BLOB PRIMARY KEY,
    \\  bytes BLOB NOT NULL
    \\) WITHOUT ROWID;
    \\
    \\-- One row per origin. Columns below tip are derived from the origin block and
    \\-- the tip block only, so a row can always be recomputed.
    \\CREATE TABLE IF NOT EXISTS chains (
    \\  origin      BLOB PRIMARY KEY REFERENCES blocks(cid),
    \\  tip         BLOB NOT NULL REFERENCES blocks(cid),
    \\  seq         INTEGER NOT NULL,   -- tip's seq; 0 = no updates yet
    \\  kind        TEXT,               -- origin.kind
    \\  thread      BLOB,               -- nodes: origin.thread
    \\  launched_by BLOB,               -- origin.launchedBy
    \\  at          INTEGER,            -- origin.at
    \\  state       TEXT,               -- threads: tip.state (NULL until the first update)
    \\  until       INTEGER,            -- threads: tip.until
    \\  waiting_on  TEXT,               -- threads: tip.waitingOn as a JSON array of CID strings
    \\  tip_at      INTEGER,            -- tip.at (origin.at until the first update): recent activity
    \\  program     BLOB,               -- threads: origin.program
    \\  waiting_from TEXT,              -- threads: tip.waitingFrom (an identity)
    \\  awaits      TEXT                -- threads: tip.awaits (emitted envelopes awaiting a reply) as a JSON array of CID strings
    \\) WITHOUT ROWID;
    \\CREATE INDEX IF NOT EXISTS chains_kind_at ON chains(kind, at);
    \\CREATE INDEX IF NOT EXISTS chains_thread  ON chains(thread, at) WHERE thread IS NOT NULL;
    \\CREATE INDEX IF NOT EXISTS chains_state   ON chains(state) WHERE state IS NOT NULL;
    \\CREATE INDEX IF NOT EXISTS chains_until   ON chains(until) WHERE state = 'waiting';
    \\-- Indexes on migrated columns are created after the migration below.
    \\
    \\-- Every update's position. UNIQUE(origin, seq) is the backstop against forks.
    \\CREATE TABLE IF NOT EXISTS updates (
    \\  cid    BLOB PRIMARY KEY REFERENCES blocks(cid),
    \\  origin BLOB NOT NULL REFERENCES chains(origin) ON DELETE CASCADE,
    \\  seq    INTEGER NOT NULL,
    \\  UNIQUE (origin, seq)
    \\) WITHOUT ROWID;
    \\
    \\-- Pointers out of a chain, keyed by the origin whatever block of the chain
    \\-- holds them: (seq, ord) says which block and where in it, which keeps a
    \\-- rebuild byte-identical regardless of walk order. "to" is a CID string or a
    \\-- URL (URLs always contain ':', CID strings never do).
    \\CREATE TABLE IF NOT EXISTS edges (
    \\  "from"  BLOB NOT NULL REFERENCES chains(origin) ON DELETE CASCADE,
    \\  seq     INTEGER NOT NULL,
    \\  ord     INTEGER NOT NULL,
    \\  "to"    TEXT NOT NULL,
    \\  rel     TEXT NOT NULL,
    \\  locator TEXT,
    \\  PRIMARY KEY ("from", seq, ord)
    \\) WITHOUT ROWID;
    \\CREATE INDEX IF NOT EXISTS edges_to ON edges("to", rel);
    \\
    \\-- Signed messages. Each is one record, not a chain. Only verified messages
    \\-- get a row; UNIQUE("from", seq) refuses a sender's second message at a seq.
    \\CREATE TABLE IF NOT EXISTS messages (
    \\  cid    BLOB PRIMARY KEY REFERENCES blocks(cid),
    \\  "from" TEXT NOT NULL,
    \\  "to"   TEXT,
    \\  seq    INTEGER NOT NULL,
    \\  at     INTEGER NOT NULL,
    \\  UNIQUE ("from", seq)
    \\) WITHOUT ROWID;
    \\CREATE INDEX IF NOT EXISTS messages_at      ON messages(at);
    \\CREATE INDEX IF NOT EXISTS messages_from_at ON messages("from", at);
    \\CREATE INDEX IF NOT EXISTS messages_to_at   ON messages("to", at) WHERE "to" IS NOT NULL;
    \\
    \\-- Not derived and not rebuilt: program bookkeeping, overwritten freely.
    \\CREATE TABLE IF NOT EXISTS handles (
    \\  thread BLOB PRIMARY KEY,
    \\  json   TEXT NOT NULL
    \\) WITHOUT ROWID;
    \\
    \\-- Not derived and not rebuilt: the input log. Each row is one signed
    \\-- log-entry record (also in blocks); admission order is not recoverable from
    \\-- the records. (An older file's message-based "log" table is left unread.)
    \\-- The envelope column is the record the entry is unique by: an admitted envelope, or
    \\-- an outcome's emit (one outcome per emit). They are different records, so
    \\-- one column serves both.
    \\CREATE TABLE IF NOT EXISTS entries (
    \\  n        INTEGER PRIMARY KEY,
    \\  cid      BLOB NOT NULL UNIQUE,
    \\  envelope BLOB UNIQUE
    \\);
    \\
    \\-- Not derived: the scheduler's cursor and similar single values.
    \\CREATE TABLE IF NOT EXISTS meta (
    \\  key   TEXT PRIMARY KEY,
    \\  value INTEGER NOT NULL
    \\) WITHOUT ROWID;
    \\
;

const MIGRATED_INDEXES =
    \\
    \\      CREATE INDEX IF NOT EXISTS chains_tip_at       ON chains(kind, tip_at);
    \\      CREATE INDEX IF NOT EXISTS chains_program      ON chains(program) WHERE program IS NOT NULL;
    \\      CREATE INDEX IF NOT EXISTS chains_waiting_from ON chains(waiting_from) WHERE waiting_from IS NOT NULL;
    \\      CREATE INDEX IF NOT EXISTS chains_awaits       ON chains(kind) WHERE awaits IS NOT NULL;
    \\
;

pub const SqliteStore = struct {
    db: *sql.Db,
    alloc: std.mem.Allocator,

    pub fn open(alloc: std.mem.Allocator, path: []const u8) !*SqliteStore {
        const db = try sql.Db.open(alloc, path, false);
        errdefer db.close();
        try db.exec(
            \\
            \\      PRAGMA journal_mode = WAL;
            \\      PRAGMA synchronous = NORMAL;
            \\      PRAGMA foreign_keys = ON;
            \\      PRAGMA busy_timeout = 5000;
            \\
        );
        var had_chains = false;
        var had_messages = false;
        {
            const st = try db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
            while (try st.step()) {
                const n = st.text(0);
                if (std.mem.eql(u8, n, "chains")) had_chains = true;
                if (std.mem.eql(u8, n, "messages")) had_messages = true;
            }
        }
        try db.exec(DDL);
        var cols = [_]bool{ false, false, false, false };
        const names = [_][]const u8{ "tip_at", "program", "waiting_from", "awaits" };
        const types = [_][]const u8{ "INTEGER", "BLOB", "TEXT", "TEXT" };
        {
            const st = try db.prepare("PRAGMA table_info(chains)");
            while (try st.step()) {
                const n = st.text(1);
                for (names, 0..) |x, i| if (std.mem.eql(u8, n, x)) {
                    cols[i] = true;
                };
            }
        }
        var added = false;
        for (names, 0..) |n, i| if (!cols[i]) {
            const q = try std.fmt.allocPrint(alloc, "ALTER TABLE chains ADD COLUMN {s} {s}", .{ n, types[i] });
            defer alloc.free(q);
            try db.exec(q);
            added = true;
        };
        try db.exec(MIGRATED_INDEXES);
        if (added or (had_chains and !had_messages)) {
            // sqlite.ts rebuilds the derived index here; not ported (issue #32 README).
            std.log.err("{s}: an older store whose index needs a rebuild (skein-dev rebuild)", .{path});
            return error.StaleIndex;
        }
        const s = try alloc.create(SqliteStore);
        s.* = .{ .db = db, .alloc = alloc };
        return s;
    }

    pub fn close(s: *SqliteStore) void {
        s.db.close();
        s.alloc.destroy(s);
    }

    pub fn store(s: *SqliteStore) storem.Store {
        return .{ .ctx = s, .vt = &vtable };
    }

    const vtable = storem.VTable{
        .bytes = bytesFn,
        .has = hasFn,
        .putBlock = putBlockFn,
        .chainOpen = chainOpenFn,
        .chainAppend = chainAppendFn,
        .chainTip = chainTipFn,
        .chainUpdates = chainUpdatesFn,
        .logAppend = logAppendFn,
        .logTip = logTipFn,
        .logFrom = logFromFn,
        .logByUnique = logByUniqueFn,
        .resting = restingFn,
        .awaiting = awaitingFn,
        .threads = threadsFn,
        .cursorGet = cursorGetFn,
        .cursorSet = cursorSetFn,
    };

    fn self(ctx: *anyopaque) *SqliteStore {
        return @ptrCast(@alignCast(ctx));
    }

    // -------------------------------------------------------- transactions

    fn begin(s: *SqliteStore) !void {
        try (try s.db.prepare("BEGIN IMMEDIATE")).run(&.{});
    }
    fn commit(s: *SqliteStore) !void {
        try (try s.db.prepare("COMMIT")).run(&.{});
    }
    fn rollback(s: *SqliteStore) void {
        if (s.db.inTransaction()) (s.db.prepare("ROLLBACK") catch return).run(&.{}) catch {};
    }

    // -------------------------------------------------------- blocks

    fn bytesFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
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

    fn putBlockFn(ctx: *anyopaque, cid: []const u8, b: []const u8) anyerror!void {
        try (try self(ctx).db.prepare("INSERT OR IGNORE INTO blocks (cid, bytes) VALUES (?, ?)")).run(&.{ .{ .blob = cid }, .{ .blob = b } });
    }

    fn put(s: *SqliteStore, a: std.mem.Allocator, v: Value) ![]u8 {
        const blk = try cbor.block(a, v);
        try putBlockFn(s, blk.cid, blk.bytes);
        return blk.cid;
    }

    // -------------------------------------------------------- derivation (sqlite.ts)

    fn strArg(v: ?Value) sql.Arg {
        const x = v orelse return .null;
        return if (x == .string) .{ .text = x.string } else .null;
    }
    fn numArg(v: ?Value) sql.Arg {
        const x = v orelse return .null;
        return switch (x) {
            .int => |i| .{ .int = @intCast(i) },
            .float => |f| .{ .float = f },
            else => .null,
        };
    }
    fn cidArg(v: ?Value) sql.Arg {
        const x = v orelse return .null;
        return if (x == .cid) .{ .blob = x.cid } else .null;
    }

    const EdgeRow = struct { to: []const u8, rel: []const u8, locator: ?[]const u8 };

    fn edge(a: std.mem.Allocator, out: *std.array_list.Managed(EdgeRow), to: ?Value, rel: []const u8, locator: ?Value) !void {
        const t = to orelse return;
        const loc: ?[]const u8 = if (locator) |l| (if (l == .string) l.string else null) else null;
        switch (t) {
            .cid => |c| try out.append(.{ .to = try cidm.format(a, c), .rel = rel, .locator = loc }),
            .string => |x| try out.append(.{ .to = x, .rel = rel, .locator = loc }),
            else => {},
        }
    }

    fn originEdges(a: std.mem.Allocator, b: Value) ![]EdgeRow {
        var out = std.array_list.Managed(EdgeRow).init(a);
        if (b.get("refs")) |refs| if (refs == .array) {
            for (refs.array) |r| {
                if (r != .map) continue;
                const rel = Value.str(r.get("rel")) orelse continue;
                try edge(a, &out, r.get("to"), rel, r.get("locator"));
            }
        };
        try edge(a, &out, b.get("launchedBy"), "launched-by", null);
        return out.items;
    }

    fn updateEdges(a: std.mem.Allocator, u: Value) ![]EdgeRow {
        var out = std.array_list.Managed(EdgeRow).init(a);
        const rest: ?Value = if (u.get("rest")) |r| (if (r == .map) r else null) else null;
        const ws = [_]?Value{ u.get("waitingOn"), if (rest) |r| r.get("waitingOn") else null };
        for (ws) |w| if (w) |x| if (x == .array) {
            for (x.array) |t| try edge(a, &out, t, "depends-on", null);
        };
        try edge(a, &out, u.get("resolution"), "resolves", null);
        if (u.get("emit")) |e| if (e == .map) {
            if (Value.str(e.get("type"))) |ty| if (std.mem.eql(u8, ty, "launched")) try edge(a, &out, e.get("thread"), "launched", null);
        };
        return out.items;
    }

    fn writeEdges(s: *SqliteStore, from: []const u8, seq: i64, edges: []const EdgeRow) !void {
        for (edges, 0..) |e, i| {
            const st = try s.db.prepare("INSERT OR IGNORE INTO edges (\"from\", seq, ord, \"to\", rel, locator)\n      VALUES (?, ?, ?, ?, ?, ?)");
            try st.run(&.{ .{ .blob = from }, .{ .int = seq }, .{ .int = @intCast(i) }, .{ .text = e.to }, .{ .text = e.rel }, if (e.locator) |l| .{ .text = l } else .null });
        }
    }

    fn cidJsonArray(a: std.mem.Allocator, v: ?Value, null_if_empty: bool) !sql.Arg {
        const x = v orelse return .null;
        if (x != .array) return .null;
        var out = std.array_list.Managed(u8).init(a);
        try out.append('[');
        var n: usize = 0;
        for (x.array) |c| {
            if (c != .cid) continue;
            if (n > 0) try out.append(',');
            try out.append('"');
            try out.appendSlice(try cidm.format(a, c.cid));
            try out.append('"');
            n += 1;
        }
        try out.append(']');
        if (n == 0 and null_if_empty) return .null;
        return .{ .text = out.items };
    }

    /// register(): the chain row with tip = origin. false if already there.
    fn register(s: *SqliteStore, a: std.mem.Allocator, cid: []const u8, b: Value) !bool {
        const kind = Value.str(b.get("kind"));
        const is_node = kind != null and std.mem.eql(u8, kind.?, "node");
        const is_thread = kind != null and std.mem.eql(u8, kind.?, "thread");
        const st = try s.db.prepare(
            \\INSERT OR IGNORE INTO chains
            \\      (origin, tip, seq, kind, thread, launched_by, at, tip_at, program)
            \\      VALUES (?1, ?1, 0, ?2, ?3, ?4, ?5, ?5, ?6)
        );
        try st.run(&.{
            .{ .blob = cid },
            strArg(b.get("kind")),
            if (is_node) cidArg(b.get("thread")) else .null,
            cidArg(b.get("launchedBy")),
            numArg(b.get("at")),
            if (is_thread) cidArg(b.get("program")) else .null,
        });
        if (s.db.changes() == 0) return false;
        try s.writeEdges(cid, 0, try originEdges(a, b));
        return true;
    }

    fn move(s: *SqliteStore, a: std.mem.Allocator, origin: []const u8, kind: ?[]const u8, tip: []const u8, seq: i64, t: Value) !void {
        const st = try s.db.prepare(
            \\UPDATE chains SET tip = ?2, seq = ?3,
            \\      state = ?4, until = ?5, waiting_on = ?6, tip_at = ?7, waiting_from = ?8, awaits = ?9
            \\      WHERE origin = ?1
        );
        const is_thread = kind != null and std.mem.eql(u8, kind.?, "thread");
        if (!is_thread) {
            try st.run(&.{ .{ .blob = origin }, .{ .blob = tip }, .{ .int = seq }, .null, .null, .null, numArg(t.get("at")), .null, .null });
        } else {
            try st.run(&.{
                .{ .blob = origin },            .{ .blob = tip },                            .{ .int = seq },
                strArg(t.get("state")),         numArg(t.get("until")),                      try cidJsonArray(a, t.get("waitingOn"), false),
                numArg(t.get("at")),            strArg(t.get("waitingFrom")),                try cidJsonArray(a, t.get("awaits"), true),
            });
        }
    }

    // -------------------------------------------------------- chains

    fn chainOpenFn(ctx: *anyopaque, a: std.mem.Allocator, origin: Value) anyerror![]u8 {
        const s = self(ctx);
        try s.begin();
        errdefer s.rollback();
        const cid = try s.put(a, origin);
        _ = try s.register(a, cid, origin);
        try s.commit();
        return cid;
    }

    fn chainAppendFn(ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8, body: Value) anyerror![]u8 {
        const s = self(ctx);
        try s.begin();
        errdefer s.rollback();
        var tip: []u8 = undefined;
        var seq: i64 = 0;
        var kind: ?[]const u8 = null;
        {
            const st = try s.db.prepare("SELECT tip, seq, kind FROM chains WHERE origin = ?");
            try st.bind(&.{.{ .blob = origin }});
            if (!try st.step()) return error.NotFound;
            tip = try a.dupe(u8, st.blob(0));
            seq = st.int(1) + 1;
            kind = if (st.isNull(2)) null else try a.dupe(u8, st.text(2));
            st.done();
        }
        if (!Value.isNumber(body.get("at"))) return error.NoAt;
        var m = cbor.MapBuilder.init(a);
        for (body.map) |e| try m.put(e.key, e.value);
        try m.put("origin", .{ .cid = origin });
        try m.put("prev", .{ .cid = tip });
        try m.put("seq", .{ .int = seq });
        const update = m.value();
        const cid = try s.put(a, update);
        try (try s.db.prepare("INSERT INTO updates (cid, origin, seq) VALUES (?, ?, ?)")).run(&.{ .{ .blob = cid }, .{ .blob = origin }, .{ .int = seq } });
        try s.writeEdges(origin, seq, try updateEdges(a, update));
        try s.move(a, origin, kind, cid, seq, update);
        try s.commit();
        return cid;
    }

    fn chainTipFn(ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8) anyerror!?[]u8 {
        const st = try self(ctx).db.prepare("SELECT tip, seq, kind FROM chains WHERE origin = ?");
        try st.bind(&.{.{ .blob = origin }});
        if (!try st.step()) return null;
        defer st.done();
        return try a.dupe(u8, st.blob(0));
    }

    fn chainUpdatesFn(ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8) anyerror!?[][]u8 {
        if ((try chainTipFn(ctx, a, origin)) == null) return null;
        return try self(ctx).cidRows(a, "SELECT cid FROM updates WHERE origin = ? ORDER BY seq", &.{.{ .blob = origin }});
    }

    fn cidRows(s: *SqliteStore, a: std.mem.Allocator, comptime q: []const u8, args: []const sql.Arg) ![][]u8 {
        const st = try s.db.prepare(q);
        try st.bind(args);
        var out = std.array_list.Managed([]u8).init(a);
        while (try st.step()) try out.append(try a.dupe(u8, st.blob(0)));
        return out.items;
    }

    // -------------------------------------------------------- the log

    fn logAppendFn(ctx: *anyopaque, a: std.mem.Allocator, entry: Value) anyerror!storem.AppendResult {
        const s = self(ctx);
        try s.begin();
        errdefer s.rollback();
        const env = Value.cidOf(entry.get("envelope"));
        const emit: ?[]const u8 = if (entry.get("outcome")) |o| Value.cidOf(o.get("emit")) else null;
        if (env) |e| if (try logByUniqueFn(ctx, a, e) != null) {
            s.rollback();
            return .{ .rejected = .{ .reason = .duplicate_envelope, .message = try std.fmt.allocPrint(a, "log: envelope {s} is already admitted", .{try cidm.format(a, e)}) } };
        };
        if (emit) |e| if (try logByUniqueFn(ctx, a, e) != null) {
            s.rollback();
            return .{ .rejected = .{ .reason = .duplicate_outcome, .message = try std.fmt.allocPrint(a, "log: emit {s} already has an outcome", .{try cidm.format(a, e)}) } };
        };
        const tip_cid = try logTipFn(ctx, a);
        const n = Value.intOf(entry.get("n")) orelse -1;
        var ok_prev: bool = undefined;
        var ok_n: bool = undefined;
        var ok_time = true;
        const prev = entry.get("prev");
        if (tip_cid) |t| {
            ok_prev = prev != null and prev.? == .cid and std.mem.eql(u8, prev.?.cid, t);
            const tip = (try cbor.decode(a, (try bytesFn(ctx, a, t)).?));
            ok_n = n == (Value.intOf(tip.get("n")) orelse -2) + 1;
            ok_time = stampNs(entry.get("time")) >= stampNs(tip.get("time"));
        } else {
            ok_prev = prev != null and prev.? == .null;
            ok_n = n == 0;
        }
        if (!ok_prev or !ok_n or !ok_time) {
            s.rollback();
            return .{ .rejected = .{ .reason = .out_of_order, .message = try std.fmt.allocPrint(a, "log: entry #{d} does not extend the tip{s}", .{ n, if (ok_time) "" else " (stamped before it)" }) } };
        }
        const cid = try s.put(a, entry);
        const uniq: sql.Arg = if (env) |e| .{ .blob = e } else if (emit) |e| .{ .blob = e } else .null;
        try (try s.db.prepare("INSERT INTO entries (n, cid, envelope) VALUES (?, ?, ?)")).run(&.{ .{ .int = @intCast(n) }, .{ .blob = cid }, uniq });
        try s.commit();
        return .{ .ok = cid };
    }

    fn stampNs(v: ?Value) i128 {
        const t = v orelse return -1;
        if (t != .array or t.array.len != 2) return -1;
        const sec = Value.intOf(t.array[0]) orelse return -1;
        const ns = Value.intOf(t.array[1]) orelse return -1;
        return sec * 1_000_000_000 + ns;
    }

    fn logTipFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror!?[]u8 {
        const st = try self(ctx).db.prepare("SELECT n, cid FROM entries ORDER BY n DESC LIMIT 1");
        if (!try st.step()) return null;
        defer st.done();
        return try a.dupe(u8, st.blob(1));
    }

    fn logFromFn(ctx: *anyopaque, a: std.mem.Allocator, from: i64) anyerror![][]u8 {
        return self(ctx).cidRows(a, "SELECT cid FROM entries WHERE n >= ? ORDER BY n", &.{.{ .int = from }});
    }

    fn logByUniqueFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const st = try self(ctx).db.prepare("SELECT cid FROM entries WHERE envelope = ?");
        try st.bind(&.{.{ .blob = cid }});
        if (!try st.step()) return null;
        defer st.done();
        return try a.dupe(u8, st.blob(0));
    }

    // -------------------------------------------------------- live

    fn restingFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror![][]u8 {
        return self(ctx).cidRows(a,
            \\SELECT origin FROM chains
            \\      WHERE kind = 'thread' AND (state IS NULL OR state <> 'finished')
            \\      ORDER BY at, origin
        , &.{});
    }

    fn awaitingFn(ctx: *anyopaque, a: std.mem.Allocator, envelope: []const u8) anyerror![][]u8 {
        return self(ctx).cidRows(a,
            \\SELECT origin FROM chains
            \\      WHERE kind = 'thread' AND awaits IS NOT NULL
            \\      AND EXISTS (SELECT 1 FROM json_each(awaits) WHERE value = ?) ORDER BY at, origin
        , &.{.{ .text = try cidm.format(a, envelope) }});
    }

    fn threadsFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror![][]u8 {
        return self(ctx).cidRows(a, "SELECT origin FROM chains WHERE kind = 'thread' ORDER BY at DESC, origin DESC", &.{});
    }

    fn cursorGetFn(ctx: *anyopaque) anyerror!i64 {
        const st = try self(ctx).db.prepare("SELECT value FROM meta WHERE key = ?");
        try st.bind(&.{.{ .text = "cursor" }});
        if (!try st.step()) return 0;
        defer st.done();
        return st.int(0);
    }

    fn cursorSetFn(ctx: *anyopaque, n: i64) anyerror!void {
        try (try self(ctx).db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")).run(&.{ .{ .text = "cursor" }, .{ .int = n } });
    }
};
