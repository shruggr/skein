// 0.8.0: a store written in an older format (here format 10, the one before the instance's step
// number) is refused for writing by every backend, before anything is rewritten, with one message;
// a read-only open holds it and says so (predatesFuel), and the state record stays as it was.
const std = @import("std");
const cbor = @import("cbor");
const index = @import("index.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const RocksStore = @import("rocksdb_store.zig").RocksStore;
const Value = cbor.Value;
const testing = std.testing;

/// A state record in `format` with a log tip (any CID: the open reads only the record), put at the pointer.
fn writeOldState(a: std.mem.Allocator, b: index.Backend, format: i64) ![]u8 {
    const tip = try cbor.block(a, cbor.string("an old log's tip"));
    var idx = cbor.MapBuilder.init(a);
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string(index.STATE_KIND));
    try m.put("format", cbor.int(format));
    try m.put("log", .{ .cid = tip.cid });
    try m.put("cursor", cbor.int(3));
    try m.put("heads", .null);
    try m.put("index", idx.value());
    const blk = try cbor.block(a, m.value());
    try b.vt.begin(b.ctx);
    try b.vt.put(b.ctx, tip.cid, tip.bytes);
    try b.vt.put(b.ctx, blk.cid, blk.bytes);
    try b.vt.setPointer(b.ctx, index.POINTER, blk.cid);
    try b.vt.commit(b.ctx);
    return blk.cid;
}

fn tmpPath(a: std.mem.Allocator, tag: []const u8) ![]u8 {
    const base = std.c.getenv("TMPDIR");
    const dir = if (base) |x| std.mem.span(x) else "/tmp";
    return std.fmt.allocPrint(a, "{s}/skein-format-test-{s}-{d}", .{ dir, tag, std.c.getpid() });
}

test "format 11 (0.8.0): a format-10 store is refused for writing — SQLite and RocksDB alike, nothing rewritten; read-only it is held and says so" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expect(std.mem.indexOf(u8, index.formatRefusal(10), "format 11") != null);
    try testing.expect(std.mem.indexOf(u8, index.formatRefusal(10), "fresh home") != null);
    index.log_refusals = false;
    defer index.log_refusals = true;

    // SQLite.
    const path = try tmpPath(a, "sqlite.db");
    std.Io.Dir.cwd().deleteFile(testing.io, path) catch {};
    defer std.Io.Dir.cwd().deleteFile(testing.io, path) catch {};
    var old: []u8 = undefined;
    {
        const s = try SqliteStore.open(testing.allocator, testing.io, path);
        defer s.close();
        try s.store().commit(); // its own state record first: the close then writes nothing over ours
        old = try writeOldState(a, s.backend(), 10);
    }
    try testing.expectError(error.PredatesFuel, SqliteStore.open(testing.allocator, testing.io, path));
    {
        const s = try SqliteStore.openReadOnly(testing.allocator, path);
        defer s.close();
        try testing.expect(s.predatesFuel());
        try testing.expectEqual(@as(i64, 10), s.ix.loaded_format);
        try testing.expectEqualSlices(u8, old, (try s.store().state(a)).?);
    }

    // RocksDB.
    const dir = try tmpPath(a, "rocks");
    std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};
    defer std.Io.Dir.cwd().deleteTree(testing.io, dir) catch {};
    {
        const s = try RocksStore.open(testing.allocator, testing.io, dir, "ix");
        defer s.close();
        try s.store().commit(); // its own state record first: the close then writes nothing over ours
        old = try writeOldState(a, s.backend(), 10);
    }
    try testing.expectError(error.PredatesFuel, RocksStore.open(testing.allocator, testing.io, dir, "ix"));
    {
        const s = try RocksStore.openReadOnly(testing.allocator, testing.io, dir, "ix");
        defer s.close();
        try testing.expect(s.predatesFuel());
        try testing.expectEqual(@as(i64, 10), s.ix.loaded_format);
        try testing.expectEqualSlices(u8, old, (try s.store().state(a)).?);
    }
    // A store in this format opens.
    {
        const s = try RocksStore.open(testing.allocator, testing.io, dir, "fresh");
        defer s.close();
        try testing.expect(!s.predatesFuel());
    }
}
