// cron-demo (#60): a small test program for jobs — a handler of a job's box
// that takes the router's cron event as its start signal and rests on a
// deadline. Zig 0.16.0, wasm32-wasi, over the kernel's dag-cbor
// (kernel-zig/src) and the programs' shared lib (programs/lib).
//
//   zig build        → zig-out/bin/cron-demo.wasm (build.sh copies it here as cron-demo.wasm, committed)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const cbor = b.createModule(.{ .root_source_file = b.path("../../kernel-zig/src/cbor.zig"), .target = t, .optimize = o });
    const sk = b.createModule(.{ .root_source_file = b.path("../lib/sk.zig"), .target = t, .optimize = o, .imports = &.{.{ .name = "cbor", .module = cbor }} });
    const exe = b.addExecutable(.{
        .name = "cron-demo",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = t,
            .optimize = o,
            .strip = true,
            .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk", .module = sk } },
        }),
    });
    b.installArtifact(exe);
}
