// `skein-kernel replay <source.db> <out.db>`: the log alone into a fresh store (either backend: a
// path, or rocksdb:<db dir>#<set>, any_store.zig), a runtime with no wallet, the signer's answers
// served from the source's records (review point 24: run by hand and by tests, not by the host).
// The fresh store first gets every module (raw block) the source holds, so the log runs the
// handlers it ran; each entry's `door` says what CHECK established, so nothing is verified again
// (copylog.zig). Prints {lines, state, index} as JSON: the runtime's log lines, the log tip, and the
// index's costs and final state record (#30).
const std = @import("std");
const envm = @import("env.zig");
const cidm = @import("cid");
const copylog = @import("copylog.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const AnyStore = @import("any_store.zig").AnyStore;

const Capture = struct {
    gpa: std.mem.Allocator,
    lines: std.array_list.Managed([]u8),
    echo: bool,

    fn say(ctx: *anyopaque, line: []const u8) void {
        const c: *Capture = @ptrCast(@alignCast(ctx));
        c.lines.append(c.gpa.dupe(u8, line) catch return) catch return;
        if (c.echo) std.debug.print("{s}\n", .{line});
    }
};

/// The log copied (copylog.zig), the records it names beside it.
pub fn copyLog(a: std.mem.Allocator, from: AnyStore, to: AnyStore) !void {
    return copylog.copyLog(a, from.store(), to.store());
}

pub fn main(gpa: std.mem.Allocator, io: std.Io, source: []const u8, out: []const u8) !u8 {
    const src = try AnyStore.openReadOnly(gpa, io, source);
    defer src.close();
    const dst = try AnyStore.open(gpa, io, out);
    defer dst.close();
    var arena = std.heap.ArenaAllocator.init(gpa);
    defer arena.deinit();
    const a = arena.allocator();

    for (try src.blocksOfCodec(a, cidm.RAW)) |b| try dst.store().putBlock(b[0], b[1]);
    try copyLog(a, src, dst);

    const r = try runner.Runner.init(gpa);
    // SKEIN_REPLAY_MODULE=<cid>=<file>: run <file> wherever the log runs module
    // <cid> (issue #34: a program's component build against its preview1 log).
    if (envm.get("SKEIN_REPLAY_MODULE")) |spec| {
        const eq = std.mem.indexOfScalar(u8, spec, '=') orelse return error.BadReplayModule;
        r.subst = .{ .cid = try cidm.parse(a, spec[0..eq]), .bytes = try std.Io.Dir.cwd().readFileAlloc(io, spec[eq + 1 ..], a, .limited(1 << 30)) };
    }
    var cap = Capture{ .gpa = gpa, .lines = .init(gpa), .echo = envm.get("SKEIN_REPLAY_ECHO") != null };
    const rt = try scheduler.Runtime.init(gpa, dst.store(), r, .{ .ctx = &cap, .say = Capture.say });
    rt.witness = try scheduler.Witness.from(gpa, src.store());
    try rt.start();
    rt.kick();
    rt.stop();

    const tip = (try dst.store().logTip(a)) orelse "";
    var o = std.array_list.Managed(u8).init(gpa);
    const w = &o;
    try w.appendSlice("{\"lines\":[");
    for (cap.lines.items, 0..) |l, i| try w.print("{s}{f}", .{ if (i > 0) "," else "", std.json.fmt(l, .{}) });
    try dst.store().commit();
    const st = dst.ix().stats();
    try w.print("],\"state\":\"{s}\",\"index\":{{\"states\":{d},\"commits\":{d},\"nodes\":{d},\"bytes\":{d},\"record\":\"{s}\"}}}}\n", .{
        if (tip.len > 0) try cidm.format(a, tip) else "", st.states, st.commits, st.nodes, st.node_bytes, try cidm.format(a, try dst.ix().stateCid(a)),
    });
    try std.Io.File.stdout().writeStreamingAll(io, o.items);
    return 0;
}
