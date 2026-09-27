// The filesystem as records (src/runtime/tree.ts): a blob is a git blob
// object, a tree a git tree object, each under CIDv1(git-raw, sha1 of the
// whole object), so a tree's CID is its git id. Pure hashing and parsing.
const std = @import("std");
const cidm = @import("cid.zig");

pub const Mode = enum {
    file, // 100644
    exec, // 100755
    link, // 120000
    dir, // 40000
    module, // 160000
    pub fn text(m: Mode) []const u8 {
        return switch (m) {
            .file => "100644",
            .exec => "100755",
            .link => "120000",
            .dir => "40000",
            .module => "160000",
        };
    }
    pub fn parse(s: []const u8) ?Mode {
        inline for (.{ .file, .exec, .link, .dir, .module }) |m| {
            if (std.mem.eql(u8, s, @as(Mode, m).text())) return m;
        }
        return null;
    }
};

pub const Entry = struct { mode: Mode, name: []const u8, cid: []const u8 };

pub const Error = error{ BadTree, BadBlob, BadEntry };

pub const Hashed = struct { cid: []u8, object: []u8 };

pub fn hashBlob(alloc: std.mem.Allocator, data: []const u8) !Hashed {
    var hbuf: [32]u8 = undefined;
    const h = std.fmt.bufPrint(&hbuf, "blob {d}\x00", .{data.len}) catch unreachable;
    const object = try alloc.alloc(u8, h.len + data.len);
    @memcpy(object[0..h.len], h);
    @memcpy(object[h.len..], data);
    return .{ .cid = try cidm.ofGit(alloc, object), .object = object };
}

const Keyed = struct { e: Entry, key: []const u8 };

fn keyLess(_: void, a: Keyed, b: Keyed) bool {
    return std.mem.order(u8, a.key, b.key) == .lt;
}

pub fn gitDigest(c: []const u8) ?[]const u8 {
    const p = cidm.parts(c) catch return null;
    if (p.codec != cidm.GIT_RAW or p.mh != cidm.SHA1 or p.digest.len != 20) return null;
    return p.digest;
}

/// Sorted as git does: as if a directory's name ended in "/".
pub fn hashTree(alloc: std.mem.Allocator, entries: []const Entry) !Hashed {
    const ks = try alloc.alloc(Keyed, entries.len);
    defer alloc.free(ks);
    for (entries, 0..) |e, i| {
        if (e.name.len == 0 or std.mem.indexOfAny(u8, e.name, "/\x00") != null) return error.BadEntry;
        for (entries[0..i]) |p| if (std.mem.eql(u8, p.name, e.name)) return error.BadEntry;
        if (gitDigest(e.cid) == null) return error.BadEntry;
        ks[i] = .{ .e = e, .key = if (e.mode == .dir) try std.fmt.allocPrint(alloc, "{s}/", .{e.name}) else e.name };
    }
    std.mem.sort(Keyed, ks, {}, keyLess);
    var body = std.array_list.Managed(u8).init(alloc);
    defer body.deinit();
    for (ks) |k| {
        try body.appendSlice(k.e.mode.text());
        try body.append(' ');
        try body.appendSlice(k.e.name);
        try body.append(0);
        try body.appendSlice(gitDigest(k.e.cid).?);
    }
    for (ks) |k| if (k.e.mode == .dir) alloc.free(k.key);
    var hbuf: [32]u8 = undefined;
    const h = std.fmt.bufPrint(&hbuf, "tree {d}\x00", .{body.items.len}) catch unreachable;
    const object = try alloc.alloc(u8, h.len + body.items.len);
    @memcpy(object[0..h.len], h);
    @memcpy(object[h.len..], body.items);
    return .{ .cid = try cidm.ofGit(alloc, object), .object = object };
}

/// "<type> <len>\0…": what follows, if the header is right.
pub fn objectBody(object: []const u8, typ: []const u8) ?[]const u8 {
    const nul = std.mem.indexOfScalar(u8, object, 0) orelse return null;
    var hbuf: [48]u8 = undefined;
    const want = std.fmt.bufPrint(&hbuf, "{s} {d}", .{ typ, object.len - nul - 1 }) catch return null;
    if (!std.mem.eql(u8, object[0..nul], want)) return null;
    return object[nul + 1 ..];
}

/// A tree object's entries in stored order. Names and CIDs point into `object`/`alloc`.
pub fn parseTree(alloc: std.mem.Allocator, object: []const u8) ![]Entry {
    const b = objectBody(object, "tree") orelse return error.BadTree;
    var out = std.array_list.Managed(Entry).init(alloc);
    var i: usize = 0;
    while (i < b.len) {
        const sp = std.mem.indexOfScalarPos(u8, b, i, ' ') orelse return error.BadTree;
        const z = std.mem.indexOfScalarPos(u8, b, sp, 0) orelse return error.BadTree;
        if (z + 21 > b.len) return error.BadTree;
        const mode = Mode.parse(b[i..sp]) orelse return error.BadTree;
        try out.append(.{ .mode = mode, .name = b[sp + 1 .. z], .cid = try cidm.create(alloc, cidm.GIT_RAW, cidm.SHA1, b[z + 1 .. z + 21]) });
        i = z + 21;
    }
    return out.toOwnedSlice();
}

test "empty tree is git's" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const h = try hashTree(arena.allocator(), &.{});
    try std.testing.expectEqualSlices(u8, &.{ 0x4b, 0x82, 0x5d, 0xc6 }, gitDigest(h.cid).?[0..4]);
}
