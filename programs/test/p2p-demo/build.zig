// p2p-demo (#51): a small test program for libp2p — a box handler that
// publishes and runs a stream round trip, and front-door handlers for a
// topic and a protocol. Zig 0.16.0, wasm32-wasi, over the SDK
// (skein-sdk: its dag-cbor, CIDs and the `skein` imports).
//
//   zig build        → zig-out/bin/p2p-demo.wasm (build.sh copies it to kernel-zig/test/p2p/, committed)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const cbor = sdk.module("cbor");
    const sk = sdk.module("sk");
    const exe = b.addExecutable(.{
        .name = "p2p-demo",
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
