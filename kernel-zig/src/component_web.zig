// The browser build's component host (issue #35): none yet. The browser runs
// preview1 modules only; a WASI 0.2 component (issue #34) is told apart by
// its preamble as natively and refused at compile time with a clear message,
// so the step errors instead of misreading the bytes as a core module.
const std = @import("std");
const engine = @import("engine.zig");
const wasi = @import("wasi.zig");

pub fn isComponent(bytes: []const u8) bool {
    return bytes.len >= 8 and std.mem.eql(u8, bytes[0..4], "\x00asm") and std.mem.eql(u8, bytes[4..8], "\x0d\x00\x01\x00");
}

pub const Component = struct {
    pub fn compile(_: *engine.Engine, _: std.mem.Allocator, _: []const u8, err_msg: *[]const u8) !*Component {
        err_msg.* = "a WASI 0.2 component: the browser build runs preview1 modules only";
        return error.Compile;
    }

    pub fn run(_: *Component, _: *engine.Engine, _: *wasi.Process, _: *[]const u8, _: std.mem.Allocator, _: ?*engine.Meter) !engine.Outcome {
        unreachable;
    }
};
