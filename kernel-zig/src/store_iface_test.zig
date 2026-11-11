// The storage interface (index.zig `Backend`), once for every native backend: the only test that
// compares databases. The same scripted sequence — get / has / put, begin / commit / rollback,
// pointer / setPointer, then close and reopen — on SQLite (sqlite_store.zig) and on a RocksDB set
// (rocksdb_store.zig); each answer is written to a transcript, and the two transcripts are the same
// bytes. (The browser build's backend, web_store.zig, is the JS shim's: kernel-zig/web/kernel.js
// MemoryStore and src/host/store-sqlite.ts SqliteSetStore, compared by src/host/store-iface.test.ts.)
const std = @import("std");
const cbor = @import("cbor");
const index = @import("index.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const RocksStore = @import("rocksdb_store.zig").RocksStore;

const testing = std.testing;

/// What a test opens: a backend, and how to close it.
const Opened = struct {
    b: index.Backend,
    ctx: *anyopaque,
    close: *const fn (ctx: *anyopaque) void,
};

fn openSqlite(path: []const u8) !Opened {
    const s = try SqliteStore.open(testing.allocator, testing.io, path);
    return .{ .b = s.backend(), .ctx = s, .close = struct {
        fn f(p: *anyopaque) void {
            @as(*SqliteStore, @ptrCast(@alignCast(p))).close();
        }
    }.f };
}

fn openRocks(dir: []const u8) !Opened {
    const s = try RocksStore.open(testing.allocator, testing.io, dir, "iface");
    return .{ .b = s.backend(), .ctx = s, .close = struct {
        fn f(p: *anyopaque) void {
            @as(*RocksStore, @ptrCast(@alignCast(p))).close();
        }
    }.f };
}

/// The script over one backend (`open` twice: the second time is the reopen); its transcript.
fn script(a: std.mem.Allocator, open: *const fn ([]const u8) anyerror!Opened, where: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    const w = struct {
        fn line(o: *std.ArrayList(u8), al: std.mem.Allocator, what: []const u8, v: ?[]const u8) !void {
            try o.appendSlice(al, what);
            if (v) |x| {
                try o.appendSlice(al, " = ");
                for (x) |byte| try o.print(al, "{x:0>2}", .{byte});
            } else try o.appendSlice(al, " = none");
            try o.append(al, '\n');
        }
        fn yes(o: *std.ArrayList(u8), al: std.mem.Allocator, what: []const u8, v: bool) !void {
            try o.print(al, "{s} = {}\n", .{ what, v });
        }
    };
    const x = try cbor.block(a, cbor.string("x: committed outside a batch"));
    const y = try cbor.block(a, cbor.string("y: in a batch rolled back"));
    const z = try cbor.block(a, cbor.string("z: in a batch committed"));

    {
        const s = try open(where);
        defer s.close(s.ctx);
        const B = s.b;
        try w.line(&out, a, "get x before", try B.vt.get(B.ctx, a, x.cid));
        try w.yes(&out, a, "has x before", try B.vt.has(B.ctx, x.cid));
        try w.line(&out, a, "pointer p before", try B.vt.pointer(B.ctx, a, "p"));
        try B.vt.put(B.ctx, x.cid, x.bytes);
        try B.vt.put(B.ctx, x.cid, x.bytes); // idempotent
        try w.line(&out, a, "get x", try B.vt.get(B.ctx, a, x.cid));
        try w.yes(&out, a, "has x", try B.vt.has(B.ctx, x.cid));
        try B.vt.setPointer(B.ctx, "p", x.cid);
        try w.line(&out, a, "pointer p", try B.vt.pointer(B.ctx, a, "p"));

        // A batch rolled back: read back inside it, gone after.
        try B.vt.begin(B.ctx);
        try B.vt.put(B.ctx, y.cid, y.bytes);
        try B.vt.setPointer(B.ctx, "p", y.cid);
        try B.vt.setPointer(B.ctx, "q", y.cid);
        try w.line(&out, a, "in batch: get y", try B.vt.get(B.ctx, a, y.cid));
        try w.yes(&out, a, "in batch: has y", try B.vt.has(B.ctx, y.cid));
        try w.line(&out, a, "in batch: pointer p", try B.vt.pointer(B.ctx, a, "p"));
        B.vt.rollback(B.ctx);
        try w.line(&out, a, "rolled back: get y", try B.vt.get(B.ctx, a, y.cid));
        try w.yes(&out, a, "rolled back: has y", try B.vt.has(B.ctx, y.cid));
        try w.line(&out, a, "rolled back: pointer p", try B.vt.pointer(B.ctx, a, "p"));
        try w.line(&out, a, "rolled back: pointer q", try B.vt.pointer(B.ctx, a, "q"));

        // A batch committed.
        try B.vt.begin(B.ctx);
        try B.vt.put(B.ctx, z.cid, z.bytes);
        try B.vt.put(B.ctx, z.cid, z.bytes);
        try B.vt.setPointer(B.ctx, "p", z.cid);
        try B.vt.commit(B.ctx);
        try w.line(&out, a, "committed: get z", try B.vt.get(B.ctx, a, z.cid));
        try w.line(&out, a, "committed: pointer p", try B.vt.pointer(B.ctx, a, "p"));
    }
    {
        // Reopened: what was committed is there, nothing of the rollback.
        const s = try open(where);
        defer s.close(s.ctx);
        const B = s.b;
        for ([_]struct { []const u8, []const u8 }{ .{ "x", x.cid }, .{ "y", y.cid }, .{ "z", z.cid } }) |e| {
            try w.line(&out, a, try std.fmt.allocPrint(a, "reopened: get {s}", .{e[0]}), try B.vt.get(B.ctx, a, e[1]));
            try w.yes(&out, a, try std.fmt.allocPrint(a, "reopened: has {s}", .{e[0]}), try B.vt.has(B.ctx, e[1]));
        }
        try w.line(&out, a, "reopened: pointer p", try B.vt.pointer(B.ctx, a, "p"));
        try w.line(&out, a, "reopened: pointer q", try B.vt.pointer(B.ctx, a, "q"));
    }
    return out.items;
}

test "the storage interface: SQLite and RocksDB answer the same script (put, get, has, batches rolled back and committed, pointers, reopen) with the same bytes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const base = if (std.c.getenv("TMPDIR")) |b| std.mem.span(b) else "/tmp";
    const dir = try std.fmt.allocPrint(a, "{s}/skein-store-iface-{d}", .{ base, std.c.getpid() });
    std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};
    try std.Io.Dir.cwd().createDirPath(testing.io, dir);
    defer std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};

    const sqlite = try script(a, openSqlite, try std.fmt.allocPrint(a, "{s}/s.db", .{dir}));
    const rocks = try script(a, openRocks, try std.fmt.allocPrint(a, "{s}/rocks", .{dir}));
    try testing.expectEqualStrings(sqlite, rocks);
    // The script reads what it wrote (not two empty transcripts).
    try testing.expect(std.mem.indexOf(u8, sqlite, "reopened: get z = ") != null and std.mem.indexOf(u8, sqlite, "reopened: get z = none") == null);
    try testing.expect(std.mem.indexOf(u8, sqlite, "reopened: get y = none") != null);
}
