const std = @import("std");
pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const exe = b.addExecutable(.{ .name = "ingester", .root_module = b.createModule(.{
        .root_source_file = b.path("main.zig"), .target = t, .optimize = o, .strip = true,
        .imports = &.{ .{ .name = "cbor", .module = sdk.module("cbor") }, .{ .name = "sk", .module = sdk.module("sk") } },
    }) });
    b.installArtifact(exe);
}
