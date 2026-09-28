// The messagebox program (issue #33): Zig 0.15.2, wasm32-wasi, over the
// kernel's own dag-cbor (kernel-zig/src/cbor.zig, cid.zig).
//
//   zig build        → zig-out/bin/messagebox.wasm (scripts/build-programs.sh copies it to wasm/)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const cbor = b.createModule(.{ .root_source_file = b.path("../../kernel-zig/src/cbor.zig"), .target = wasi, .optimize = .ReleaseSafe });
    const exe = b.addExecutable(.{
        .name = "messagebox",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = wasi,
            .optimize = .ReleaseSafe,
            .strip = true,
            .imports = &.{.{ .name = "cbor", .module = cbor }},
        }),
    });
    b.installArtifact(exe);
}
