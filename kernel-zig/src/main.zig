// skein-kernel: the kernel in Zig (issue #32).
//
//   skein-kernel serve                         the runtime process the router spawns (serve.zig)
//   skein-kernel replay <source.db> <out.db>   replay a store's log into a fresh store, no wallet (replay.zig)
//   skein-kernel shell <store.db> [<program>] < cases.json  run shell cases (host-go's format) and print results as JSON
//   skein-kernel dump <store.db>               the derived state read through the index, as JSON (dump.zig)
//   skein-kernel fuel <store.db> [--since n]   fuel per thread and in total, from the updates (fuel.zig, issue #5)
//   skein-kernel migrate --from <runtime.db> --into <env dir> --set <handle>   a SQLite store into a set of an LMDB environment (migrate.zig, #96)
// A store is a SQLite file's path or lmdb:<env dir>#<set> (any_store.zig, #96); `serve` takes SKEIN_STORE.
const std = @import("std");
const shellcmd = @import("cmd_shell.zig");
const replay = @import("replay.zig");
const serve = @import("serve.zig");

pub fn main(init: std.process.Init) !void {
    // The debug allocator in Debug builds, libc's malloc otherwise (std's choice when libc is linked).
    const gpa = init.gpa;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len < 2) return usage();
    const cmd = args[1];
    if (std.mem.eql(u8, cmd, "shell") and (args.len == 3 or args.len == 4)) return shellcmd.main(gpa, io, args[2], if (args.len == 4) args[3] else null);
    if (std.mem.eql(u8, cmd, "replay") and args.len == 4) return std.process.exit(try replay.main(gpa, io, args[2], args[3]));
    if (std.mem.eql(u8, cmd, "dump") and args.len == 3) return std.process.exit(try @import("dump.zig").main(gpa, io, args[2]));
    if (std.mem.eql(u8, cmd, "fuel") and (args.len == 3 or (args.len == 5 and std.mem.eql(u8, args[3], "--since")))) {
        const since: i64 = if (args.len == 5) std.fmt.parseInt(i64, args[4], 10) catch return usage() else 0;
        return std.process.exit(try @import("fuel.zig").main(gpa, io, args[2], since));
    }
    if (std.mem.eql(u8, cmd, "migrate") and args.len == 8) {
        var from: ?[]const u8 = null;
        var into: ?[]const u8 = null;
        var set: ?[]const u8 = null;
        var i: usize = 2;
        while (i + 1 < args.len) : (i += 2) {
            if (std.mem.eql(u8, args[i], "--from")) from = args[i + 1] else if (std.mem.eql(u8, args[i], "--into")) into = args[i + 1] else if (std.mem.eql(u8, args[i], "--set")) set = args[i + 1] else return usage();
        }
        if (from == null or into == null or set == null) return usage();
        return std.process.exit(try @import("migrate.zig").main(gpa, io, from.?, into.?, set.?));
    }
    if (std.mem.eql(u8, cmd, "serve")) return serve.main(gpa, io);
    return usage();
}

fn usage() void {
    std.debug.print(
        \\usage:
        \\  skein-kernel serve                         the runtime process (the router spawns it)
        \\  skein-kernel replay <source.db> <out.db>   replay a log into a fresh store with no wallet
        \\  skein-kernel shell <store.db> [<program>] < cases.json  run shell cases (the shell app's shell, or <program>), print results
        \\  skein-kernel dump <store.db>               the derived state (the index) as JSON
        \\  skein-kernel fuel <store.db> [--since n]   fuel per thread and in total (steps from log entry n on)
        \\  skein-kernel migrate --from <runtime.db> --into <env dir> --set <handle>   a SQLite store into a set of an LMDB environment
        \\a store is a SQLite file's path or lmdb:<env dir>#<set>; serve takes SKEIN_STORE=<env dir> (the set: its handle)
        \\
    , .{});
    std.process.exit(2);
}
