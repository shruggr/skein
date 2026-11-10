// perm-probe (call permissions): a test program for named in-VM calls (`callAs`), the name a callee
// reads as `as`, and the raw signer as a granted kernel service. Zig 0.16.0, wasm32-wasi, over the
// SDK 0.17.2 (its dag-cbor and the `skein` imports; `callAs` declared here until the SDK has it).
//
//   zig build        → zig-out/bin/perm-probe.wasm (build.sh copies it to bin/, committed)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const exe = b.addExecutable(.{
        .name = "perm-probe",
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
