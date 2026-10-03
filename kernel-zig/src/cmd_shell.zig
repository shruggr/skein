// `skein-kernel shell <db> [<program>]`: the Zig side of the shell equivalence
// test (equiv/shell.ts; host-go/node/run-shell.ts is the TypeScript side). The
// shell is a program record in the store (#83): <program> its CID, else the
// shell app's (the app record at the head `shell/app`, its `programs.shell`).
// A case is {cmd, tree, cwd?, env?: [[k, v]…], stdin?: base64, time?, seed?};
// a result {exitCode, stdout, stderr (base64), tree} or {error}.
const std = @import("std");
const envm = @import("env.zig");
const cidm = @import("cid");
const cbor = @import("cbor");
const Value = cbor.Value;
const shell = @import("shell.zig");
const runner = @import("runner.zig");
const wasi = @import("wasi.zig");
const SqliteStore = @import("sqlite_store.zig").SqliteStore;

pub fn main(gpa: std.mem.Allocator, io: std.Io, db: []const u8, program: ?[]const u8) !void {
    const ss = try SqliteStore.open(gpa, io, db);
    defer ss.close();
    const s = ss.store();
    const r = try runner.Runner.init(gpa);
    var arena0 = std.heap.ArenaAllocator.init(gpa);
    const a0 = arena0.allocator();
    const pc = if (program) |p| try cidm.parse(a0, p) else blk: {
        const root = (try s.headTree(a0, "shell/app")) orelse {
            std.debug.print("no shell program: no head shell/app (install the shell app) and none named\n", .{});
            return error.NoShell;
        };
        const app = (try s.get(a0, root)) orelse return error.NotFound;
        break :blk Value.cidOf((app.get("programs") orelse return error.NoShell).get("shell")) orelse {
            std.debug.print("shell/app: its app record names no shell program\n", .{});
            return error.NoShell;
        };
    };
    const prog = (try s.get(a0, pc)) orelse {
        std.debug.print("{s}: not a record in the store\n", .{try cidm.format(a0, pc)});
        return error.NotFound;
    };
    var msg: []const u8 = "";
    const mods = shell.loadModules(r, s, a0, prog, pc, &msg) catch |e| {
        std.debug.print("{s}: {s}\n", .{ @errorName(e), msg });
        return e;
    };

    // Issue #34: SKEIN_SHELL_COMPONENTS=<dir> runs the tools found there as
    // <name>.wasm (components made with the preview1 adapter) in place of the
    // pinned modules, so equiv/shell.ts can compare the two ABIs case by case.
    if (envm.get("SKEIN_SHELL_COMPONENTS")) |dir| try useComponents(gpa, io, r, mods, dir);

    var in_buf: [4096]u8 = undefined;
    var in = std.Io.File.stdin().readerStreaming(io, &in_buf);
    const input = try in.interface.allocRemaining(gpa, .limited(1 << 30));
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
            try out.print("{{\"error\":{f}}}", .{std.json.fmt(m, .{})});
            continue;
        };
        const so = try a.alloc(u8, b64.calcSize(res.stdout.len));
        const se = try a.alloc(u8, b64.calcSize(res.stderr.len));
        try out.print("{{\"exitCode\":{d},\"stdout\":\"{s}\",\"stderr\":\"{s}\",\"tree\":\"{s}\"}}", .{
            res.exit_code, b64.encode(so, res.stdout), b64.encode(se, res.stderr), try cidm.format(a, res.tree),
        });
    }
    try out.append(']');
    try std.Io.File.stdout().writeStreamingAll(io, out.items);
}

fn useComponents(gpa: std.mem.Allocator, io: std.Io, r: *runner.Runner, mods: *shell.Modules, dir: []const u8) !void {
    var names = std.array_list.Managed([]const u8).init(gpa);
    try names.append("coreutils");
    var it = mods.extra.keyIterator();
    while (it.next()) |k| try names.append(k.*);
    // A module under two names (`node` is qjs): the component found for one serves both.
    var swapped = std.AutoHashMap(*runner.Compiled, *runner.Compiled).init(gpa);
    for (names.items) |n| {
        const path = try std.fmt.allocPrint(gpa, "{s}/{s}.wasm", .{ dir, n });
        const bytes = std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(1 << 30)) catch continue;
        var em: []const u8 = "";
        const comp = r.compile(bytes, &em) catch |e| {
            std.debug.print("{s}: {s}\n", .{ path, em });
            return e;
        };
        if (std.mem.eql(u8, n, "coreutils")) mods.coreutils = comp else {
            try swapped.put(mods.extra.get(n).?, comp);
            try mods.extra.put(n, comp);
        }
    }
    var vit = mods.extra.valueIterator();
    while (vit.next()) |v| if (swapped.get(v.*)) |c| {
        v.* = c;
    };
}
