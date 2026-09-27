// Time and randomness inside the machine (src/runtime/syscalls.ts): both
// derive from the log entry a thread is being driven by, so replay reproduces
// them. A thread's clock reads the entry's stamp first, then +1 ns per read;
// random bytes are SHA-256(key ‖ counter as u64 BE) blocks, key =
// SHA-256(entry CID ‖ thread CID).
const std = @import("std");

pub const Stamp = struct {
    sec: i64,
    nsec: i64,
    pub fn ns(s: Stamp) i128 {
        return @as(i128, s.sec) * 1_000_000_000 + s.nsec;
    }
    /// The `at` (ms) of records written while processing this entry (log.ts stampMs).
    pub fn ms(s: Stamp) i64 {
        return s.sec * 1000 + @divFloor(s.nsec, 1_000_000);
    }
};

pub const ThreadClock = struct {
    base: i128 = 0,
    last: ?i128 = null,

    pub fn drive(c: *ThreadClock, ns: i128) void {
        if (ns > c.base) c.base = ns;
    }
    pub fn read(c: *ThreadClock) i128 {
        c.last = if (c.last == null or c.base > c.last.?) c.base else c.last.? + 1;
        return c.last.?;
    }
    pub fn peek(c: *const ThreadClock) i128 {
        return if (c.last == null or c.base > c.last.?) c.base else c.last.?;
    }
};

pub const Entropy = struct {
    key: [32]u8,
    counter: u64 = 0,
    buf: [32]u8 = undefined,
    off: usize = 32,

    pub fn init(entry: []const u8, thread: []const u8) Entropy {
        var h = std.crypto.hash.sha2.Sha256.init(.{});
        h.update(entry);
        h.update(thread);
        return .{ .key = h.finalResult() };
    }

    pub fn fill(e: *Entropy, out: []u8) void {
        var i: usize = 0;
        while (i < out.len) {
            if (e.off == 32) {
                var h = std.crypto.hash.sha2.Sha256.init(.{});
                h.update(&e.key);
                var c: [8]u8 = undefined;
                std.mem.writeInt(u64, &c, e.counter, .big);
                e.counter += 1;
                h.update(&c);
                e.buf = h.finalResult();
                e.off = 0;
            }
            const take = @min(out.len - i, 32 - e.off);
            @memcpy(out[i .. i + take], e.buf[e.off .. e.off + take]);
            i += take;
            e.off += take;
        }
    }
};

/// splitmix32 (shell.ts prng): a run outside a thread.
pub const SplitMix = struct {
    s: u32,
    pub fn fill(p: *SplitMix, out: []u8) void {
        for (out) |*b| {
            p.s +%= 0x9e3779b9;
            var z = p.s;
            z = (z ^ (z >> 16)) *% 0x85ebca6b;
            z = (z ^ (z >> 13)) *% 0xc2b2ae35;
            b.* = @truncate(z ^ (z >> 16));
        }
    }
};

test "clock" {
    var c = ThreadClock{};
    c.drive(100);
    try std.testing.expectEqual(@as(i128, 100), c.read());
    try std.testing.expectEqual(@as(i128, 101), c.read());
    c.drive(50);
    try std.testing.expectEqual(@as(i128, 102), c.read());
    c.drive(200);
    try std.testing.expectEqual(@as(i128, 200), c.peek());
    try std.testing.expectEqual(@as(i128, 200), c.read());
}
