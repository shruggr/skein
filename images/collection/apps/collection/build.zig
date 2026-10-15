// skein-collection (shruggr/skein#151): the 1Sat collection overlay for a
// skein, as an app: one topic per collection (and the discovery topic), the
// items lookup, and the engine they run in. Zig 0.16.0, wasm32-wasi, over
// skein-overlay's topic and lookup contracts and skein-1sat's parsers (both
// URL+hash dependencies; the SDK comes through skein-overlay).
//
// Module (`b.dependency("skein_collection", .{ .target = t, .optimize = o }).module("collection")`):
//
//   collection   topic names, collection ids, the mint rules, the topic's verdict   src/lib.zig
//
//   zig build         → zig-out/bin/collection-topic.wasm, collection-lookup.wasm
//   zig build bin     the same, written to bin/*.wasm (committed)
//   zig build test    the rules, the topic, the lookup and its reads, natively
const std = @import("std");

const Mods = struct { imports: [8]std.Build.Module.Import };

/// The modules a program or the tests import, for one target.
fn mods(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) Mods {
    const ov = b.dependency("skein_overlay", .{ .target = target, .optimize = optimize });
    const sdk = ov.builder.dependency("skein_sdk", .{ .target = target, .optimize = optimize });
    const onesat = b.dependency("skein_1sat", .{ .target = target, .optimize = optimize }).module("onesat");
    const chain = sdk.module("chain");
    const collection = b.createModule(.{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ .{ .name = "chain", .module = chain }, .{ .name = "onesat", .module = onesat } },
    });
    return .{ .imports = .{
        .{ .name = "collection", .module = collection },
        .{ .name = "onesat", .module = onesat },
        .{ .name = "chain", .module = chain },
        .{ .name = "topic", .module = ov.module("topic") },
        .{ .name = "lookup", .module = ov.module("lookup") },
        .{ .name = "overlay_sk", .module = ov.module("sk") },
        .{ .name = "sk", .module = sdk.module("sk") },
        .{ .name = "cbor", .module = sdk.module("cbor") },
    } };
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    // The exported module (what a dependent app imports), for the target it asks for.
    const exported = mods(b, target, optimize);
    _ = b.addModule("collection", .{
        .root_source_file = b.path("src/lib.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{ exported.imports[2], exported.imports[1] },
    });

    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wm = mods(b, wasi, .ReleaseSafe);
    const bin = b.addUpdateSourceFiles();
    for ([_][2][]const u8{ .{ "collection-topic", "src/collection_topic.zig" }, .{ "collection-lookup", "src/collection_lookup.zig" } }) |p| {
        const exe = b.addExecutable(.{
            .name = p[0],
            .root_module = b.createModule(.{
                .root_source_file = b.path(p[1]),
                .target = wasi,
                .optimize = .ReleaseSafe,
                .strip = true,
                .imports = &wm.imports,
            }),
        });
        b.installArtifact(exe);
        bin.addCopyFileToSource(exe.getEmittedBin(), b.fmt("bin/{s}.wasm", .{p[0]}));
    }
    b.step("bin", "write the programs into the tree: bin/{collection-topic,collection-lookup}.wasm").dependOn(&bin.step);

    const nm = mods(b, target, .Debug);
    const tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("test.zig"),
        .target = target,
        .optimize = .Debug,
        .imports = &nm.imports,
    }) });
    const test_step = b.step("test", "The rules, the topic, the lookup and its reads, natively");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
