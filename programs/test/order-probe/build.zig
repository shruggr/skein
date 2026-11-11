// order-probe (skein 0.8.0): facts under one name raised in one entry by threads of different step counts (kernel-zig/equiv/event-order.ts).
// Zig 0.16.0, wasm32-wasi, over the SDK 0.17.2 (its dag-cbor and the `skein` imports: sk.events, sk.on).
//
//   zig build        → zig-out/bin/order-probe.wasm (build.sh copies it to bin/, committed)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const exe = b.addExecutable(.{
        .name = "order-probe",
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
