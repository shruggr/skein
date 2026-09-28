// `skein-kernel dump <store.db>`: a store's derived state as JSON, read
// through the index (issue #30) — the store's own state record, or, for a
// file in the format before #30, the maps imported from its tables in memory.
// equiv/replays.ts compares it with the same questions asked of the
// TypeScript runtime's tables. CIDs in their base32 text form.
//
//   {state, roots: {map: cid|null}, cursor, log,
//    entries: [[n, cid, unique|null]], chains: [[origin, tip, seq, kind|null]],
//    updates: [[origin, seq, cid]], threads: [origin] (at, origin),
//    resting: [origin] (at, origin), sleepers: [[until, origin]],
//    awaits: [[envelope, origin]], edges: [[from, seq, ord, to, rel, locator|null]],
//    heads: [[name, tree]], blocks: [cid] (not index nodes or state records),
//    indexBlocks: n}
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const index = @import("index.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Value = cbor.Value;

fn num(k: []const u8) i64 {
    return @bitCast(std.mem.readInt(u64, k[0..8], .big) ^ (1 << 63));
}

/// A CID at the front of `k`: its length (binary CIDs are prefix-free).
fn cidLen(k: []const u8) usize {
    var pos: usize = 0;
    if (k.len >= 34 and k[0] == 0x12 and k[1] == 0x20) return 34;
    _ = cidm.readUvarint(k, &pos) catch return k.len;
    _ = cidm.readUvarint(k, &pos) catch return k.len;
    _ = cidm.readUvarint(k, &pos) catch return k.len;
    const n = cidm.readUvarint(k, &pos) catch return k.len;
    return pos + @as(usize, @intCast(n));
}

/// A uvarint-length-prefixed string at the front of `k`: (string, bytes used).
fn strAt(k: []const u8) struct { s: []const u8, used: usize } {
    var pos: usize = 0;
    const n = cidm.readUvarint(k, &pos) catch return .{ .s = "", .used = k.len };
    return .{ .s = k[pos .. pos + @as(usize, @intCast(n))], .used = pos + @as(usize, @intCast(n)) };
}

const W = struct {
    out: std.array_list.Managed(u8),
    a: std.mem.Allocator,
    fn cid(w: *W, c: ?[]const u8) !void {
        if (c) |x| try w.out.writer().print("\"{s}\"", .{try cidm.format(w.a, x)}) else try w.out.appendSlice("null");
    }
    fn str(w: *W, s: ?[]const u8) !void {
        if (s) |x| try w.out.writer().print("{f}", .{std.json.fmt(x, .{})}) else try w.out.appendSlice("null");
    }
    fn raw(w: *W, s: []const u8) !void {
        try w.out.appendSlice(s);
    }
    fn int(w: *W, n: i64) !void {
        try w.out.writer().print("{d}", .{n});
    }
    fn sep(w: *W, i: usize) !void {
        if (i > 0) try w.out.append(',');
    }
};

fn isIndexBlock(a: std.mem.Allocator, c: []const u8, bytes: []const u8) bool {
    if (cidm.codecOf(c) != cidm.DAG_CBOR) return false;
    const v = cbor.decode(a, bytes) catch return false;
    if (v == .map) return std.mem.eql(u8, Value.str(v.get("kind")) orelse "", index.STATE_KIND);
    if (v != .array or v.array.len != 2 or v.array[1] != .array) return false;
    if (v.array[0] != .null and v.array[0] != .cid) return false;
    for (v.array[1].array) |e| {
        if (e != .array or e.array.len != 3 or e.array[0] != .bytes) return false;
        if (e.array[2] != .null and e.array[2] != .cid) return false;
    }
    return v.array[1].array.len > 0;
}

pub fn main(gpa: std.mem.Allocator, path: []const u8) !u8 {
    const ss = try SqliteStore.openReadOnly(gpa, path);
    defer ss.close();
    const ix = ss.ix;
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    var w = W{ .out = std.array_list.Managed(u8).init(gpa), .a = a };
    defer w.out.deinit();

    try w.raw("{\"state\":");
    try w.cid(try ix.stateCid(a));
    try w.raw(",\"roots\":{");
    inline for (@typeInfo(index.Map).@"enum".fields, 0..) |f, i| {
        try w.sep(i);
        try w.out.writer().print("\"{s}\":", .{f.name});
        try w.cid(ix.work.roots[f.value].get());
    }
    try w.raw("},\"cursor\":");
    try w.int(ix.work.cursor);
    try w.raw(",\"log\":");
    try w.cid(ix.work.tip.get());

    // entries: the log map, with each entry's unique record from the unique map
    var uniq = std.StringHashMap([]const u8).init(a);
    for (try ix.all(a, .unique)) |kv| try uniq.put(kv.value.cid, kv.key);
    try w.raw(",\"entries\":[");
    for (try ix.all(a, .log), 0..) |kv, i| {
        try w.sep(i);
        try w.raw("[");
        try w.int(num(kv.key));
        try w.raw(",");
        try w.cid(kv.value.cid);
        try w.raw(",");
        try w.cid(uniq.get(kv.value.cid));
        try w.raw("]");
    }
    try w.raw("],\"chains\":[");
    for (try ix.all(a, .chains), 0..) |kv, i| {
        try w.sep(i);
        try w.raw("[");
        try w.cid(kv.key);
        try w.raw(",");
        try w.cid(Value.cidOf(kv.value.get("tip")));
        try w.raw(",");
        try w.int(@intCast(Value.intOf(kv.value.get("seq")) orelse 0));
        try w.raw(",");
        try w.str(Value.str(kv.value.get("kind")));
        try w.raw("]");
    }
    try w.raw("],\"updates\":[");
    for (try ix.all(a, .updates), 0..) |kv, i| {
        try w.sep(i);
        const l = cidLen(kv.key);
        try w.raw("[");
        try w.cid(kv.key[0..l]);
        try w.raw(",");
        try w.int(num(kv.key[l..]));
        try w.raw(",");
        try w.cid(kv.value.cid);
        try w.raw("]");
    }
    inline for (.{ "threads", "resting" }) |name| {
        try w.raw("],\"" ++ name ++ "\":[");
        for (try ix.all(a, @field(index.Map, name)), 0..) |kv, i| {
            try w.sep(i);
            try w.cid(kv.key[8..]);
        }
    }
    try w.raw("],\"sleepers\":[");
    for (try ix.all(a, .sleepers), 0..) |kv, i| {
        try w.sep(i);
        try w.raw("[");
        try w.int(num(kv.key));
        try w.raw(",");
        try w.cid(kv.key[8..]);
        try w.raw("]");
    }
    try w.raw("],\"awaits\":[");
    for (try ix.all(a, .awaits), 0..) |kv, i| {
        try w.sep(i);
        const l = cidLen(kv.key);
        try w.raw("[");
        try w.cid(kv.key[0..l]);
        try w.raw(",");
        try w.cid(kv.key[l + 8 ..]);
        try w.raw("]");
    }
    try w.raw("],\"edges\":[");
    for (try ix.all(a, .edges), 0..) |kv, i| {
        try w.sep(i);
        const to = strAt(kv.key);
        const rest = kv.key[to.used..];
        const l = cidLen(rest);
        try w.raw("[");
        try w.cid(rest[0..l]);
        try w.raw(",");
        try w.int(num(rest[l..]));
        try w.raw(",");
        try w.int(num(rest[l + 8 ..]));
        try w.raw(",");
        try w.str(to.s);
        try w.raw(",");
        try w.str(Value.str(kv.value.array[0]));
        try w.raw(",");
        try w.str(Value.str(kv.value.array[1]));
        try w.raw("]");
    }
    try w.raw("],\"heads\":[");
    for (try ix.all(a, .heads), 0..) |kv, i| {
        try w.sep(i);
        try w.raw("[");
        try w.str(strAt(kv.key).s);
        try w.raw(",");
        try w.cid(kv.value.cid);
        try w.raw("]");
    }
    try w.raw("],\"blocks\":[");
    var n_index: usize = 0;
    var first = true;
    for (try ss.allCids(a)) |c| {
        const b = (try ss.store().bytes(a, c)).?;
        if (isIndexBlock(a, c, b)) {
            n_index += 1;
            continue;
        }
        if (!first) try w.raw(",");
        first = false;
        try w.cid(c);
    }
    try w.out.writer().print("],\"indexBlocks\":{d}}}\n", .{n_index});
    try std.fs.File.stdout().writeAll(w.out.items);
    return 0;
}
