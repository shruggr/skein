// The process environment, for the native kernel's switches (SKEIN_*): libc's
// getenv (the native build links libc), as std.posix.getenv read it before
// Zig 0.16. Not for the browser build.
const std = @import("std");

pub fn get(name: [:0]const u8) ?[]const u8 {
    const v = std.c.getenv(name) orelse return null;
    return std.mem.span(v);
}
