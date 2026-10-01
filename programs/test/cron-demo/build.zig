// cron-demo (#60, #69): a small test program for the cron provider — it asks
// the cron provider (its address book's role `cron`) for ticks into a box and rests on
// a deadline at each tick. Zig 0.16.0, wasm32-wasi, over the SDK
// (skein-sdk: its dag-cbor, CIDs and the `skein` imports).
//
//   zig build        → zig-out/bin/cron-demo.wasm (build.sh copies it here as cron-demo.wasm, committed)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const cbor = sdk.module("cbor");
    const sk = sdk.module("sk");
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
