// event-demo (skein 0.5.0, 0.5.1): a test program for the event index and routes — it emits facts,
// reads the index in its step, creates routes under its allowances, and takes what its routes
// deliver. Zig 0.16.0, wasm32-wasi, over skein-sdk 0.16.0 (its dag-cbor, `sk.events`, `sk.route`).
//
//   zig build        → zig-out/bin/event-demo.wasm (build.sh copies it to bin/, committed)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const exe = b.addExecutable(.{
        .name = "event-demo",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = t,
            .optimize = o,
            .strip = true,
            .imports = &.{ .{ .name = "cbor", .module = sdk.module("cbor") }, .{ .name = "sk", .module = sdk.module("sk") } },
        }),
    });
    b.installArtifact(exe);
}
