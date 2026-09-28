// index.zig over an in-memory backend: the maps follow chains as sqlite.ts's
// tables did, commits write only new nodes, and an import (the rebuild path)
// comes to the same state record as the incremental path.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const index = @import("index.zig");
const Value = cbor.Value;

const Mem = struct {
    gpa: std.mem.Allocator,
    blocks: std.StringHashMap([]u8),
    ptr: ?[]u8 = null,
    puts: usize = 0,

    fn init(gpa: std.mem.Allocator) Mem {
        return .{ .gpa = gpa, .blocks = std.StringHashMap([]u8).init(gpa) };
    }
    fn deinit(m: *Mem) void {
        var it = m.blocks.iterator();
        while (it.next()) |e| {
            m.gpa.free(e.key_ptr.*);
            m.gpa.free(e.value_ptr.*);
        }
        m.blocks.deinit();
        if (m.ptr) |p| m.gpa.free(p);
    }
    fn self(ctx: *anyopaque) *Mem {
        return @ptrCast(@alignCast(ctx));
    }
    fn get(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const b = self(ctx).blocks.get(cid) orelse return null;
        return try a.dupe(u8, b);
    }
    fn has(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        return self(ctx).blocks.contains(cid);
    }
    fn put(ctx: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
        const m = self(ctx);
        if (m.blocks.contains(cid)) return;
        m.puts += 1;
        try m.blocks.put(try m.gpa.dupe(u8, cid), try m.gpa.dupe(u8, bytes));
    }
    fn nop(_: *anyopaque) anyerror!void {}
    fn nop2(_: *anyopaque) void {}
    fn pointer(ctx: *anyopaque, a: std.mem.Allocator, _: []const u8) anyerror!?[]u8 {
        const p = self(ctx).ptr orelse return null;
        return try a.dupe(u8, p);
    }
    fn setPointer(ctx: *anyopaque, _: []const u8, cid: []const u8) anyerror!void {
        const m = self(ctx);
        if (m.ptr) |p| m.gpa.free(p);
        m.ptr = try m.gpa.dupe(u8, cid);
    }
    const vt = index.Backend.VT{ .get = get, .has = has, .put = put, .begin = nop, .commit = nop, .rollback = nop2, .pointer = pointer, .setPointer = setPointer };
    fn backend(m: *Mem) index.Backend {
        return .{ .ctx = m, .vt = &vt };
    }
};

fn thread(a: std.mem.Allocator, at: i64, nonce: []const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("thread"));
    try m.put("at", cbor.int(at));
    try m.put("nonce", cbor.string(nonce));
    return m.value();
}

fn upd(a: std.mem.Allocator, state: []const u8, at: i64, until: ?i64, awaits: ?[]const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("state", cbor.string(state));
    try m.put("at", cbor.int(at));
    if (until) |u| try m.put("until", cbor.int(u));
    if (awaits) |c| try m.put("awaits", try cbor.cidArray(a, &.{c}));
    return m.value();
}

test "index: maps follow chains; commits write new nodes only; import = incremental" {
    const gpa = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var mem = Mem.init(gpa);
    defer mem.deinit();
    const ix = try index.Index.init(gpa, mem.backend(), false);
    defer ix.deinit();
    const s = ix.store();

    const env = try cbor.cidOfValue(a, cbor.string("an envelope"));
    const t1 = try s.chainOpen(a, try thread(a, 10, "a"));
    const t2 = try s.chainOpen(a, try thread(a, 5, "b"));
    const t3 = try s.chainOpen(a, try thread(a, 7, "c"));
    try std.testing.expectEqual(@as(usize, 3), (try s.resting(a)).len);
    // resting in (at, origin) order; threads the reverse
    try std.testing.expectEqualSlices(u8, t2, (try s.resting(a))[0]);
    try std.testing.expectEqualSlices(u8, t1, (try s.threads(a))[0]);

    _ = try s.chainAppend(a, t1, try upd(a, "running", 11, null, null));
    _ = try s.chainAppend(a, t1, try upd(a, "waiting", 12, 500, null));
    _ = try s.chainAppend(a, t2, try upd(a, "waiting", 13, null, env));
    _ = try s.chainAppend(a, t3, try upd(a, "finished", 14, null, null));
    try std.testing.expectEqual(@as(usize, 2), (try s.resting(a)).len);
    const aw = try s.awaiting(a, env);
    try std.testing.expectEqual(@as(usize, 1), aw.len);
    try std.testing.expectEqualSlices(u8, t2, aw[0]);
    try std.testing.expectEqual(@as(usize, 1), (try ix.all(a, .sleepers)).len);
    try std.testing.expectEqual(@as(usize, 2), (try s.chainUpdates(a, t1)).?.len);
    try std.testing.expectError(error.NotFound, s.chainAppend(a, env, try upd(a, "x", 1, null, null)));
    try std.testing.expectError(error.NoAt, s.chainAppend(a, t1, .{ .map = &.{} }));

    try s.cursorSet(1);
    const puts0 = mem.puts;
    // a wake: t1 runs on; its sleeper goes, t2's await stays
    const u = try s.chainAppend(a, t1, try upd(a, "running", 600, null, null));
    try std.testing.expectEqual(@as(usize, 0), (try ix.all(a, .sleepers)).len);
    try std.testing.expectEqualSlices(u8, u, (try s.chainTip(a, t1)).?);
    try s.cursorSet(2);
    const written = mem.puts - puts0; // the update, the new nodes, the state record
    try std.testing.expect(written >= 3 and written <= 12);

    // a second index imported from the chains and cursor reaches the same state record
    const want = try ix.stateCid(a);
    var mem2 = Mem.init(gpa);
    defer mem2.deinit();
    var it = mem.blocks.iterator();
    while (it.next()) |e| try Mem.put(&mem2, e.key_ptr.*, e.value_ptr.*);
    const ix2 = try index.Index.init(gpa, mem2.backend(), false);
    defer ix2.deinit();
    for ([_][]const u8{ t3, t1, t2 }) |t| {
        const ups = (try s.chainUpdates(a, t)).?;
        try ix2.importChain(t, ups, (try s.chainTip(a, t)).?, @intCast(ups.len));
    }
    ix2.setCursor(2);
    try std.testing.expectEqualSlices(u8, want, try ix2.stateCid(a));

    // reopen from the pointer
    const ix3 = try index.Index.init(gpa, mem.backend(), false);
    defer ix3.deinit();
    try std.testing.expect(try ix3.load());
    try std.testing.expectEqualSlices(u8, want, try ix3.stateCid(a));
    try std.testing.expectEqual(@as(usize, 2), (try ix3.store().resting(a)).len);
}
