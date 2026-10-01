// fetch (issue #15, #70): GET a URL by a message to the `fetch` provider, the
// body to stdout — a WASI 0.2 component (a test fixture for a component's
// `emit`), Zig 0.16.0. Built as the wallet's component build is (programs/wallet/
// build.zig, kernel-zig/README.md "Building a component handler"): a
// wasm32-wasi core module with wit-bindgen's C bindings for world
// skein:kernel/program (the SDK's wit/bindings/c) and no libc
// (the SDK's `cabi`), made a component with the preview1
// command adapter. The dag-cbor is the SDK's `cbor`.
//
//   zig build    → zig-out/bin/fetch.wasm (a component)
//
// Needs wasm-tools (-Dwasm-tools, default on PATH) and the adapter
// (-Dwasi-adapter, else $SKEIN_WASI_ADAPTER, else
// ~/.local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm).
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const opt: std.builtin.OptimizeMode = .ReleaseSafe;
    const home = b.graph.environ_map.get("HOME") orelse "/root";
    const env_adapter = b.graph.environ_map.get("SKEIN_WASI_ADAPTER");
    const adapter = b.option([]const u8, "wasi-adapter", "the preview1 command adapter (wasmtime v49.0.1)") orelse env_adapter orelse
        b.fmt("{s}/.local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm", .{home});
    const wasm_tools = b.option([]const u8, "wasm-tools", "wasm-tools (1.259.0)") orelse "wasm-tools";

    const sdk = b.dependency("skein_sdk", .{ .target = wasi, .optimize = opt, .wallet = false });
    const bindings = sdk.path("wit/bindings/c");
    const libc_headers = sdk.path("wit/zig/c");
    const cbor = sdk.module("cbor");
    const cabi = sdk.module("cabi");
    const mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = wasi,
        .optimize = opt,
        .strip = true,
        .imports = &.{
            .{ .name = "cbor", .module = cbor },
            .{ .name = "cabi", .module = cabi },
        },
    });
    mod.addIncludePath(bindings);
    mod.addIncludePath(libc_headers);
    mod.addCSourceFile(.{ .file = sdk.path("wit/bindings/c/program.c"), .flags = &.{"-O2"} });
    mod.addObjectFile(sdk.path("wit/bindings/c/program_component_type.o"));
    const core = b.addExecutable(.{ .name = "fetch-core", .root_module = mod });

    const new = b.addSystemCommand(&.{ wasm_tools, "component", "new" });
    new.addArtifactArg(core);
    new.addArg(b.fmt("--adapt=wasi_snapshot_preview1={s}", .{adapter}));
    new.addArg("-o");
    const comp = new.addOutputFileArg("fetch.wasm");
    b.getInstallStep().dependOn(&b.addInstallBinFile(comp, "fetch.wasm").step);
}
