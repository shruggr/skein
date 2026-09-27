// Frames between the kernel and its peer process (serve.zig, peer/peer.ts):
// a 4-byte big-endian length, then one dag-cbor map. Blocking IO on file
// descriptors; the reader buffers partial frames.
const std = @import("std");
const cbor = @import("cbor.zig");

pub const Reader = struct {
    fd: std.posix.fd_t,
    buf: std.array_list.Managed(u8),
    eof: bool = false,

    pub fn init(gpa: std.mem.Allocator, fd: std.posix.fd_t) Reader {
        return .{ .fd = fd, .buf = std.array_list.Managed(u8).init(gpa) };
    }

    /// Read what is available (one read call). false on EOF.
    pub fn fill(r: *Reader) !bool {
        var tmp: [65536]u8 = undefined;
        const n = std.posix.read(r.fd, &tmp) catch |err| switch (err) {
            error.WouldBlock => return true,
            else => return err,
        };
        if (n == 0) {
            r.eof = true;
            return false;
        }
        try r.buf.appendSlice(tmp[0..n]);
        return true;
    }

    /// A complete frame's payload, if buffered (copied into `a`).
    pub fn next(r: *Reader, a: std.mem.Allocator) !?[]u8 {
        if (r.buf.items.len < 4) return null;
        const len = std.mem.readInt(u32, r.buf.items[0..4], .big);
        if (r.buf.items.len < 4 + len) return null;
        const out = try a.dupe(u8, r.buf.items[4 .. 4 + len]);
        const rest = r.buf.items.len - 4 - len;
        std.mem.copyForwards(u8, r.buf.items[0..rest], r.buf.items[4 + len ..]);
        r.buf.shrinkRetainingCapacity(rest);
        return out;
    }

    /// Block until a frame is complete; null on EOF.
    pub fn read(r: *Reader, a: std.mem.Allocator) !?cbor.Value {
        while (true) {
            if (try r.next(a)) |b| return try cbor.decode(a, b);
            if (!try r.fill()) return null;
        }
    }
};

pub fn write(fd: std.posix.fd_t, a: std.mem.Allocator, v: cbor.Value) !void {
    const body = try cbor.encode(a, v);
    var h: [4]u8 = undefined;
    std.mem.writeInt(u32, &h, @intCast(body.len), .big);
    try writeAll(fd, &h);
    try writeAll(fd, body);
}

fn writeAll(fd: std.posix.fd_t, b: []const u8) !void {
    var off: usize = 0;
    while (off < b.len) off += try std.posix.write(fd, b[off..]);
}
