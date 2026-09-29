// `skein-kernel fuel <store.db> [--since n]`: billing as a query over the log
// (issue #5). Every step's update carries the fuel the step burnt; this sums
// it per thread and in total, over the steps whose input is log entry n or
// later (all of them by default). Read only; anyone holding the log can
// replay it and get the same numbers.
//
//   fuel<TAB>steps<TAB>thread<TAB>program      one line per thread that burnt fuel, in thread order
//   total<TAB>fuel<TAB>steps<TAB>threads       the sum
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const programs = @import("programs.zig");
const dump = @import("dump.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;
const Value = cbor.Value;

pub const Burn = struct { fuel: u64 = 0, steps: u64 = 0 };

pub const Totals = struct {
    /// (origin, burn) in thread order: threads that burnt fuel in range.
    threads: []const struct { origin: []const u8, burn: Burn },
    total: Burn,
};

/// Fuel per thread from the updates whose input entry is `since` or later.
pub fn totals(a: std.mem.Allocator, ss: *SqliteStore, since: i64) !Totals {
    const ix = ss.ix;
    const s = ss.store();
    var entry_n = std.StringHashMap(i64).init(a);
    for (try ix.all(a, .log)) |kv| try entry_n.put(kv.value.cid, dump.num(kv.key));
    var burns = std.StringHashMap(Burn).init(a);
    var total = Burn{};
    for (try ix.all(a, .updates)) |kv| {
        const u = (try s.get(a, kv.value.cid)) orelse continue;
        const f = Value.intOf(u.get("fuel")) orelse continue;
        const input = Value.cidOf(u.get("input")) orelse continue;
        const n = entry_n.get(input) orelse continue;
        if (n < since) continue;
        const origin = kv.key[0..dump.cidLen(kv.key)];
        const g = try burns.getOrPut(origin);
        if (!g.found_existing) g.value_ptr.* = .{};
        g.value_ptr.fuel += @intCast(f);
        g.value_ptr.steps += 1;
        total.fuel += @intCast(f);
        total.steps += 1;
    }
    const T = @typeInfo(@FieldType(Totals, "threads")).pointer.child;
    var list = std.array_list.Managed(T).init(a);
    for (try ix.all(a, .threads)) |kv| {
        const origin = kv.key[8..];
        if (burns.get(origin)) |b| try list.append(.{ .origin = origin, .burn = b });
    }
    return .{ .threads = list.items, .total = total };
}

fn programName(a: std.mem.Allocator, ss: *SqliteStore, origin: []const u8) []const u8 {
    const s = ss.store();
    const o = (s.get(a, origin) catch null) orelse return "?";
    const pc = Value.cidOf(o.get("program")) orelse return "?";
    const p = s.getOpt(a, pc);
    if (programs.isProgram(p)) if (Value.str(p.?.get("name"))) |n| return n;
    return "?";
}

pub fn main(gpa: std.mem.Allocator, io: std.Io, path: []const u8, since: i64) !u8 {
    const ss = try SqliteStore.openReadOnly(gpa, path);
    defer ss.close();
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const t = try totals(a, ss, since);
    var out = std.array_list.Managed(u8).init(gpa);
    defer out.deinit();
    const w = &out;
    try w.appendSlice("fuel\tsteps\tthread\tprogram\n");
    for (t.threads) |x| try w.print("{d}\t{d}\t{s}\t{s}\n", .{ x.burn.fuel, x.burn.steps, try cidm.format(a, x.origin), programName(a, ss, x.origin) });
    try w.print("total\t{d}\t{d} steps\t{d} threads{s}\n", .{ t.total.fuel, t.total.steps, t.threads.len, if (since > 0) try std.fmt.allocPrint(a, "\tsince #{d}", .{since}) else "" });
    try std.Io.File.stdout().writeStreamingAll(io, out.items);
    return 0;
}
