// The messagebox program (#40): Zig 0.15.2, wasm32-wasi, over the kernel's own
// dag-cbor and CIDs (kernel-zig/src) and the programs' shared lib (programs/lib).
//
//   zig build        → zig-out/bin/messagebox.wasm (scripts/build-programs.sh copies it to wasm/)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const cbor = b.createModule(.{ .root_source_file = b.path("../../kernel-zig/src/cbor.zig"), .target = t, .optimize = o });
    const sk = b.createModule(.{ .root_source_file = b.path("../lib/sk.zig"), .target = t, .optimize = o, .imports = &.{.{ .name = "cbor", .module = cbor }} });
    const brc = b.createModule(.{ .root_source_file = b.path("../lib/brc104.zig"), .target = t, .optimize = o, .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk.zig", .module = sk } } });
    const dagjson = b.createModule(.{ .root_source_file = b.path("../lib/dagjson.zig"), .target = t, .optimize = o, .imports = &.{ .{ .name = "cbor", .module = cbor } } });
    const exe = b.addExecutable(.{
        .name = "messagebox",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = t,
            .optimize = o,
            .strip = true,
            .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk", .module = sk }, .{ .name = "brc104", .module = brc }, .{ .name = "dagjson", .module = dagjson } },
        }),
    });
    b.installArtifact(exe);
}
