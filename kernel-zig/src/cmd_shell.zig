// `skein-kernel shell <db>`: the Zig side of the shell equivalence test
// (equiv/shell.ts; host-go/node/run-shell.ts is the TypeScript side). A case
// is {cmd, tree, cwd?, env?: [[k, v]…], stdin?: base64, time?, seed?}; a
// result {exitCode, stdout, stderr (base64), tree} or {error}.
const std = @import("std");
const cidm = @import("cid.zig");
const shell = @import("shell.zig");
const runner = @import("runner.zig");
const wasi = @import("wasi.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;

pub fn main(gpa: std.mem.Allocator, db: []const u8) !void {
    const ss = try SqliteStore.open(gpa, db);
    defer ss.close();
    const s = ss.store();
    const r = try runner.Runner.init(gpa);
    var arena0 = std.heap.ArenaAllocator.init(gpa);
    var msg: []const u8 = "";
    const mods = shell.loadModules(r, s, arena0.allocator(), &msg) catch |e| {
        std.debug.print("{s}: {s}\n", .{ @errorName(e), msg });
        return e;
    };

    const input = try std.fs.File.stdin().readToEndAlloc(gpa, 1 << 30);
    const cases = try std.json.parseFromSliceLeaky(std.json.Value, arena0.allocator(), input, .{});
    var out = std.array_list.Managed(u8).init(gpa);
    try out.append('[');
    const b64 = std.base64.standard.Encoder;
    for (cases.array.items, 0..) |c, i| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const o = c.object;
        var env = std.array_list.Managed([2][]const u8).init(a);
        if (o.get("env")) |e| for (e.array.items) |kv| try env.append(.{ kv.array.items[0].string, kv.array.items[1].string });
        var stdin: []const u8 = "";
        if (o.get("stdin")) |x| {
            const dec = std.base64.standard.Decoder;
            const buf = try a.alloc(u8, try dec.calcSizeForSlice(x.string));
            try dec.decode(buf, x.string);
            stdin = buf;
        }
        var st = wasi.RunState{};
        var cwd_msg: []const u8 = "";
        const opts = shell.Options{
            .tree = try cidm.parse(a, o.get("tree").?.string),
            .cmd = o.get("cmd").?.string,
            .cwd = if (o.get("cwd")) |x| x.string else null,
            .env = env.items,
            .stdin = stdin,
            .time_ms = if (o.get("time")) |x| x.integer else 0,
            .seed = if (o.get("seed")) |x| @intCast(x.integer) else 0,
        };
        if (i > 0) try out.append(',');
        const res = shell.runShell(a, r, s, mods, opts, &st, &cwd_msg) catch |err| {
            const m = switch (err) {
                error.CwdNotDir => cwd_msg,
                error.Fatal => if (st.fatal) |f| f.message else "fatal",
                else => @errorName(err),
            };
            try out.writer().print("{{\"error\":{f}}}", .{std.json.fmt(m, .{})});
            continue;
        };
        const so = try a.alloc(u8, b64.calcSize(res.stdout.len));
        const se = try a.alloc(u8, b64.calcSize(res.stderr.len));
        try out.writer().print("{{\"exitCode\":{d},\"stdout\":\"{s}\",\"stderr\":\"{s}\",\"tree\":\"{s}\"}}", .{
            res.exit_code, b64.encode(so, res.stdout), b64.encode(se, res.stderr), try cidm.format(a, res.tree),
        });
    }
    try out.append(']');
    try std.fs.File.stdout().writeAll(out.items);
}
