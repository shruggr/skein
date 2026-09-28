// The front door (#40): Zig 0.15.2, wasm32-wasi, over the kernel's own
// dag-cbor (kernel-zig/src/cbor.zig) and the programs' shared lib (programs/lib).
//
//   zig build        → zig-out/bin/frontdoor.wasm (scripts/build-programs.sh copies it to wasm/)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const cbor = b.createModule(.{ .root_source_file = b.path("../../kernel-zig/src/cbor.zig"), .target = wasi, .optimize = .ReleaseSafe });
    const sk = b.createModule(.{ .root_source_file = b.path("../lib/sk.zig"), .target = wasi, .optimize = .ReleaseSafe, .imports = &.{.{ .name = "cbor", .module = cbor }} });
    const brc = b.createModule(.{ .root_source_file = b.path("../lib/brc104.zig"), .target = wasi, .optimize = .ReleaseSafe, .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk.zig", .module = sk } } });
    const exe = b.addExecutable(.{
        .name = "frontdoor",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = wasi,
            .optimize = .ReleaseSafe,
            .strip = true,
            .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk", .module = sk }, .{ .name = "brc104", .module = brc } },
        }),
    });
    b.installArtifact(exe);
}
