// skein-onboard (shruggr/skein#90): the onboarding app, installed in the host
// skein. Zig 0.16.0, wasm32-wasi, over the SDK (skein-sdk: `cbor`, `sk`, `secp`,
// `app`, `dagjson`).
//
//   zig build        → zig-out/bin/onboard.wasm
//   zig build bin    the same, written to bin/onboard.wasm (the app tree's module; committed)
//   zig build test   the body's checks, the policy, the answers — natively
//
// The build is reproducible: bin/onboard.wasm is what `zig build bin` writes.
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const exe = b.addExecutable(.{ .name = "onboard", .root_module = module(b, wasi, .ReleaseSafe, true) });
    b.installArtifact(exe);

    const bin = b.addUpdateSourceFiles();
    bin.addCopyFileToSource(exe.getEmittedBin(), "bin/onboard.wasm");
    b.step("bin", "write the module into the app tree: bin/onboard.wasm").dependOn(&bin.step);

    const tests = b.addTest(.{ .root_module = module(b, b.standardTargetOptions(.{}), .Debug, false) });
    const test_step = b.step("test", "The body's checks, the policy, the answers");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}

fn module(b: *std.Build, t: std.Build.ResolvedTarget, o: std.builtin.OptimizeMode, strip: bool) *std.Build.Module {
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    return b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = t,
        .optimize = o,
        .strip = strip,
        .imports = &.{
            .{ .name = "cbor", .module = sdk.module("cbor") },
            .{ .name = "sk", .module = sdk.module("sk") },
            .{ .name = "app", .module = sdk.module("app") },
            .{ .name = "dagjson", .module = sdk.module("dagjson") },
            .{ .name = "secp", .module = sdk.module("secp") },
        },
    });
}
