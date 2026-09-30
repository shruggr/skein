// The static file handler (#52): Zig 0.16.0, wasm32-wasi, over the kernel's
// own dag-cbor and CIDs (kernel-zig/src) and the programs' shared lib (programs/lib).
//
//   zig build        → zig-out/bin/static.wasm (scripts/build-programs.sh copies it to wasm/)
//   zig build test   content types, paths, escapes refused, If-None-Match — natively
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const exe = b.addExecutable(.{ .name = "static", .root_module = module(b, wasi, .ReleaseSafe, true) });
    b.installArtifact(exe);

    const tests = b.addTest(.{ .root_module = module(b, b.standardTargetOptions(.{}), .Debug, false) });
    const test_step = b.step("test", "Content types, paths, escapes refused, If-None-Match");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}

fn module(b: *std.Build, t: std.Build.ResolvedTarget, o: std.builtin.OptimizeMode, strip: bool) *std.Build.Module {
    const cbor = b.createModule(.{ .root_source_file = b.path("../../kernel-zig/src/cbor.zig"), .target = t, .optimize = o });
    const sk = b.createModule(.{ .root_source_file = b.path("../lib/sk.zig"), .target = t, .optimize = o, .imports = &.{.{ .name = "cbor", .module = cbor }} });
    return b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = t,
        .optimize = o,
        .strip = strip,
        .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk", .module = sk } },
    });
}
