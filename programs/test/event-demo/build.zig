// event-demo (skein 0.5.0, 0.5.2): a test program for the event index — it emits facts, reads the index
// in its step, subscribes (on / off) and takes the facts its subscriptions deliver. Zig 0.16.0,
// wasm32-wasi, over the SDK 0.17.2 (its dag-cbor and the `skein` imports: sk.events, sk.on (and on(name) resting, 0.5.4), sk.off).
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
