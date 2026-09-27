// A thin binding to the system libsqlite3: open, exec, prepared statements
// (cached by SQL text), typed bind and column reads. Only sqlite_store.zig
// uses it.
const std = @import("std");
pub const c = @cImport(@cInclude("sqlite3.h"));

pub const Error = error{Sqlite};

pub const Db = struct {
    db: *c.sqlite3,
    cache: std.StringHashMap(*c.sqlite3_stmt),
    alloc: std.mem.Allocator,
    last_error: [512]u8 = undefined,
    last_error_len: usize = 0,

    pub fn open(alloc: std.mem.Allocator, path: []const u8, read_only: bool) !*Db {
        const z = try alloc.dupeZ(u8, path);
        defer alloc.free(z);
        var h: ?*c.sqlite3 = null;
        const flags: c_int = if (read_only) c.SQLITE_OPEN_READONLY | c.SQLITE_OPEN_URI else c.SQLITE_OPEN_READWRITE | c.SQLITE_OPEN_CREATE | c.SQLITE_OPEN_URI;
        if (c.sqlite3_open_v2(z.ptr, &h, flags, null) != c.SQLITE_OK) {
            if (h) |x| _ = c.sqlite3_close(x);
            return error.Sqlite;
        }
        const d = try alloc.create(Db);
        d.* = .{ .db = h.?, .cache = std.StringHashMap(*c.sqlite3_stmt).init(alloc), .alloc = alloc };
        return d;
    }

    pub fn close(d: *Db) void {
        var it = d.cache.iterator();
        while (it.next()) |kv| {
            _ = c.sqlite3_finalize(kv.value_ptr.*);
        }
        d.cache.deinit();
        _ = c.sqlite3_close(d.db);
        d.alloc.destroy(d);
    }

    pub fn errmsg(d: *Db) []const u8 {
        return std.mem.span(c.sqlite3_errmsg(d.db));
    }

    pub fn exec(d: *Db, sql: []const u8) !void {
        const z = try d.alloc.dupeZ(u8, sql);
        defer d.alloc.free(z);
        var err: [*c]u8 = null;
        if (c.sqlite3_exec(d.db, z.ptr, null, null, &err) != c.SQLITE_OK) {
            if (err != null) {
                std.log.err("sqlite: {s}", .{std.mem.span(err)});
                c.sqlite3_free(err);
            }
            return error.Sqlite;
        }
    }

    pub fn prepare(d: *Db, sql: []const u8) !Stmt {
        if (d.cache.get(sql)) |s| {
            _ = c.sqlite3_reset(s);
            _ = c.sqlite3_clear_bindings(s);
            return .{ .s = s, .db = d };
        }
        var s: ?*c.sqlite3_stmt = null;
        if (c.sqlite3_prepare_v2(d.db, sql.ptr, @intCast(sql.len), &s, null) != c.SQLITE_OK) {
            std.log.err("sqlite prepare: {s}: {s}", .{ d.errmsg(), sql });
            return error.Sqlite;
        }
        try d.cache.put(sql, s.?);
        return .{ .s = s.?, .db = d };
    }

    pub fn changes(d: *Db) i64 {
        return c.sqlite3_changes(d.db);
    }

    pub fn inTransaction(d: *Db) bool {
        return c.sqlite3_get_autocommit(d.db) == 0;
    }
};

pub const Arg = union(enum) {
    null,
    int: i64,
    float: f64,
    text: []const u8,
    blob: []const u8,
};

pub const Stmt = struct {
    s: *c.sqlite3_stmt,
    db: *Db,

    pub fn bind(st: Stmt, args: []const Arg) !void {
        for (args, 1..) |a, i| {
            const idx: c_int = @intCast(i);
            const rc = switch (a) {
                .null => c.sqlite3_bind_null(st.s, idx),
                .int => |v| c.sqlite3_bind_int64(st.s, idx, v),
                .float => |v| c.sqlite3_bind_double(st.s, idx, v),
                .text => |v| c.sqlite3_bind_text(st.s, idx, v.ptr, @intCast(v.len), c.SQLITE_TRANSIENT),
                .blob => |v| c.sqlite3_bind_blob(st.s, idx, if (v.len == 0) "" else v.ptr, @intCast(v.len), c.SQLITE_TRANSIENT),
            };
            if (rc != c.SQLITE_OK) return error.Sqlite;
        }
    }

    /// true: a row is ready; false: done.
    pub fn step(st: Stmt) !bool {
        const rc = c.sqlite3_step(st.s);
        if (rc == c.SQLITE_ROW) return true;
        if (rc == c.SQLITE_DONE) {
            _ = c.sqlite3_reset(st.s);
            return false;
        }
        std.log.err("sqlite step: {s}", .{st.db.errmsg()});
        _ = c.sqlite3_reset(st.s);
        return error.Sqlite;
    }

    pub fn run(st: Stmt, args: []const Arg) !void {
        try st.bind(args);
        while (try st.step()) {}
    }

    pub fn done(st: Stmt) void {
        _ = c.sqlite3_reset(st.s);
    }

    pub fn isNull(st: Stmt, col: c_int) bool {
        return c.sqlite3_column_type(st.s, col) == c.SQLITE_NULL;
    }
    pub fn int(st: Stmt, col: c_int) i64 {
        return c.sqlite3_column_int64(st.s, col);
    }
    /// Valid until the next step/reset: copy it.
    pub fn blob(st: Stmt, col: c_int) []const u8 {
        const p = c.sqlite3_column_blob(st.s, col);
        const n: usize = @intCast(c.sqlite3_column_bytes(st.s, col));
        if (p == null or n == 0) return "";
        return @as([*]const u8, @ptrCast(p))[0..n];
    }
    pub fn text(st: Stmt, col: c_int) []const u8 {
        const p = c.sqlite3_column_text(st.s, col);
        const n: usize = @intCast(c.sqlite3_column_bytes(st.s, col));
        if (p == null or n == 0) return "";
        return @as([*]const u8, @ptrCast(p))[0..n];
    }
};
