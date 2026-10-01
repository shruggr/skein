// The frontdoor program (#40): Zig 0.16.0, wasm32-wasi, over the SDK
// (skein-sdk: its dag-cbor, CIDs and the `skein` imports).
//
//   zig build        → zig-out/bin/frontdoor.wasm (scripts/build-programs.sh copies it to wasm/)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const t = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const o = std.builtin.OptimizeMode.ReleaseSafe;
    const sdk = b.dependency("skein_sdk", .{ .target = t, .optimize = o, .wallet = false });
    const cbor = sdk.module("cbor");
    const sk = sdk.module("sk");
    const brc = sdk.module("brc104");
    const dagjson = sdk.module("dagjson");
    const message = sdk.module("message");
    const exe = b.addExecutable(.{
        .name = "frontdoor",
        .root_module = b.createModule(.{
            .root_source_file = b.path("main.zig"),
            .target = t,
            .optimize = o,
            .strip = true,
            .imports = &.{ .{ .name = "cbor", .module = cbor }, .{ .name = "sk", .module = sk }, .{ .name = "brc104", .module = brc }, .{ .name = "dagjson", .module = dagjson }, .{ .name = "message", .module = message } },
        }),
    });
    b.installArtifact(exe);
}
