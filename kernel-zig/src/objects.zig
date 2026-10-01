// The synthetic git object directory (issue #2): git's loose-object format
// over the store's git-raw records. A loose object on disk is the zlib stream
// of the whole object ("<type> <size>\0" + content), named by the sha1 of
// that object — the same bytes and the same hash as the git-raw record the
// store already holds. So `<repo>/.git/objects/xx/yyyy…` needs no storage of
// its own: in the tree it is a gitlink entry (mode 160000) naming the record,
// a read deflates the record on the fly, and a write inflates, checks the
// hash and keeps the record. Pure functions; the VFS (vfs.zig) wires them in.
const std = @import("std");
const cidm = @import("cid");

/// A directory `xx` (two lowercase hex digits) directly inside `.git/objects`.
pub fn isFanoutName(dir: []const u8, parent: []const u8, grandparent: []const u8) bool {
    return dir.len == 2 and isHex(dir) and std.mem.eql(u8, parent, "objects") and std.mem.eql(u8, grandparent, ".git");
}

/// The 38 lowercase hex digits that follow the fanout directory.
pub fn isLooseName(name: []const u8) bool {
    return name.len == 38 and isHex(name);
}

fn isHex(s: []const u8) bool {
    for (s) |c| if (!((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f'))) return false;
    return true;
}

/// The sha1 a loose object at `<fanout>/<name>` must hash to.
pub fn digestOf(fanout: []const u8, name: []const u8) [20]u8 {
    var hex: [40]u8 = undefined;
    @memcpy(hex[0..2], fanout);
    @memcpy(hex[2..], name);
    var d: [20]u8 = undefined;
    _ = std.fmt.hexToBytes(&d, &hex) catch unreachable;
    return d;
}

/// The loose-object bytes for a git object: a zlib stream of stored
/// (uncompressed) deflate blocks. Any zlib stream is a valid loose object;
/// this one costs no compression, is the same for the same object on every
/// host, and is never stored — it exists only while a program reads it.
pub fn deflate(alloc: std.mem.Allocator, object: []const u8) ![]u8 {
    const max_block = 65535;
    const blocks = @max(1, (object.len + max_block - 1) / max_block);
    const out = try alloc.alloc(u8, 2 + blocks * 5 + object.len + 4);
    out[0] = 0x78; // CM=8 (deflate), CINFO=7 (32K window)
    out[1] = 0x01; // FLEVEL=0, FCHECK: 0x7801 % 31 == 0
    var o: usize = 2;
    var i: usize = 0;
    var b: usize = 0;
    while (b < blocks) : (b += 1) {
        const n = @min(max_block, object.len - i);
        out[o] = if (b + 1 == blocks) 1 else 0; // BFINAL, BTYPE=00
        std.mem.writeInt(u16, out[o + 1 ..][0..2], @intCast(n), .little);
        std.mem.writeInt(u16, out[o + 3 ..][0..2], ~@as(u16, @intCast(n)), .little);
        o += 5;
        @memcpy(out[o .. o + n], object[i .. i + n]);
        o += n;
        i += n;
    }
    std.mem.writeInt(u32, out[o..][0..4], std.hash.Adler32.hash(object), .big);
    return out;
}

pub const InflateError = error{ BadStream, BadObject, OutOfMemory };

/// The git object a loose-object file holds: the zlib stream inflated (all of
/// it, nothing after it), with a well-formed "<type> <size>\0" header.
pub fn inflate(alloc: std.mem.Allocator, loose: []const u8) InflateError![]u8 {
    var in: std.Io.Reader = .fixed(loose);
    var aw: std.Io.Writer.Allocating = .init(alloc);
    errdefer aw.deinit();
    const window = try alloc.alloc(u8, std.compress.flate.max_window_len);
    defer alloc.free(window);
    var d: std.compress.flate.Decompress = .init(&in, .zlib, window);
    _ = d.reader.streamRemaining(&aw.writer) catch |e| switch (e) {
        error.WriteFailed => return error.OutOfMemory,
        else => return error.BadStream,
    };
    const object = aw.toOwnedSlice() catch return error.OutOfMemory;
    if (!validHeader(object)) {
        alloc.free(object);
        return error.BadObject;
    }
    return object;
}

fn validHeader(object: []const u8) bool {
    const nul = std.mem.indexOfScalar(u8, object[0..@min(object.len, 32)], 0) orelse return false;
    const sp = std.mem.indexOfScalar(u8, object[0..nul], ' ') orelse return false;
    const typ = object[0..sp];
    const known = [_][]const u8{ "blob", "tree", "commit", "tag" };
    var ok = false;
    for (known) |k| if (std.mem.eql(u8, typ, k)) {
        ok = true;
    };
    if (!ok) return false;
    const size_text = object[sp + 1 .. nul];
    if (size_text.len == 0 or (size_text.len > 1 and size_text[0] == '0')) return false;
    const size = std.fmt.parseInt(usize, size_text, 10) catch return false;
    return size == object.len - nul - 1;
}

/// The CID of a git object whose sha1 is `digest`.
pub fn cidOf(alloc: std.mem.Allocator, digest: []const u8) ![]u8 {
    return cidm.create(alloc, cidm.GIT_RAW, cidm.SHA1, digest);
}

test "deflate round-trips through inflate, and matches zlib's framing" {
    const a = std.testing.allocator;
    const obj = "blob 6\x00hello\n";
    const z = try deflate(a, obj);
    defer a.free(z);
    try std.testing.expectEqualSlices(u8, &.{ 0x78, 0x01, 0x01, 13, 0, 0xf2, 0xff }, z[0..7]);
    const back = try inflate(a, z);
    defer a.free(back);
    try std.testing.expectEqualStrings(obj, back);
}

test "inflate reads what zlib writes (a loose object git made)" {
    // zlib.compress(b"blob 5\0hello") at the default level, as git writes it
    const a = std.testing.allocator;
    const loose = [_]u8{ 0x78, 0x9c, 0x4b, 0xca, 0xc9, 0x4f, 0x52, 0x30, 0x65, 0xc8, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00, 0x19, 0xaa, 0x04, 0x09 };
    const obj = try inflate(a, &loose);
    defer a.free(obj);
    try std.testing.expectEqualStrings("blob 5\x00hello", obj);
    var d: [20]u8 = undefined;
    std.crypto.hash.Sha1.hash(obj, &d, .{});
    try std.testing.expectEqualSlices(u8, &digestOf("b6", "fc4c620b67d95f953a5c1c1230aaab5db5a1b0"), &d);
}

test "inflate refuses a bad header or a bad stream" {
    const a = std.testing.allocator;
    const z = try deflate(a, "blob 7\x00hello\n");
    defer a.free(z);
    try std.testing.expectError(error.BadObject, inflate(a, z));
    try std.testing.expectError(error.BadStream, inflate(a, "not zlib"));
}

test "names" {
    try std.testing.expect(isFanoutName("ab", "objects", ".git"));
    try std.testing.expect(!isFanoutName("pack", "objects", ".git"));
    try std.testing.expect(!isFanoutName("AB", "objects", ".git"));
    try std.testing.expect(isLooseName("fc4c620b67d95f953a5c1c1230aaab5db5a1b0"));
    try std.testing.expect(!isLooseName("tmp_obj_abcdef"));
}
