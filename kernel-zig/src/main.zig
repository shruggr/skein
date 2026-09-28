// skein-kernel: the kernel in Zig (issue #32).
//
//   skein-kernel serve                         the runtime process (drop-in for bin/skein-runtime; serve.zig)
//   skein-kernel replay <source.db> <out.db>   replay a store's log into a fresh store, no wallet (replay.zig)
//   skein-kernel shell <store.db> < cases.json  run shell cases (host-go's format) and print results as JSON
//   skein-kernel dump <store.db>               the derived state read through the index, as JSON (dump.zig)
//   skein-kernel fuel <store.db> [--since n]   fuel per thread and in total, from the updates (fuel.zig, issue #5)
const std = @import("std");
const shellcmd = @import("cmd_shell.zig");
const replay = @import("replay.zig");
const serve = @import("serve.zig");

pub fn main() !void {
    var gpa_state = std.heap.GeneralPurposeAllocator(.{}){};
    const gpa = if (@import("builtin").mode == .Debug) gpa_state.allocator() else std.heap.c_allocator;
    const args = try std.process.argsAlloc(gpa);
    if (args.len < 2) return usage();
    const cmd = args[1];
    if (std.mem.eql(u8, cmd, "shell") and args.len == 3) return shellcmd.main(gpa, args[2]);
    if (std.mem.eql(u8, cmd, "replay") and args.len == 4) return std.process.exit(try replay.main(gpa, args[2], args[3]));
    if (std.mem.eql(u8, cmd, "dump") and args.len == 3) return std.process.exit(try @import("dump.zig").main(gpa, args[2]));
    if (std.mem.eql(u8, cmd, "fuel") and (args.len == 3 or (args.len == 5 and std.mem.eql(u8, args[3], "--since")))) {
        const since: i64 = if (args.len == 5) std.fmt.parseInt(i64, args[4], 10) catch return usage() else 0;
        return std.process.exit(try @import("fuel.zig").main(gpa, args[2], since));
    }
    if (std.mem.eql(u8, cmd, "serve")) return serve.main(gpa);
    return usage();
}

fn usage() void {
    std.debug.print(
        \\usage:
        \\  skein-kernel serve                         the runtime (environment as bin/skein-runtime)
        \\  skein-kernel replay <source.db> <out.db>   replay a log into a fresh store with no wallet
        \\  skein-kernel shell <store.db> < cases.json  run shell cases, print results
        \\  skein-kernel dump <store.db>               the derived state (the index) as JSON
        \\  skein-kernel fuel <store.db> [--since n]   fuel per thread and in total (steps from log entry n on)
        \\
    , .{});
    std.process.exit(2);
}
