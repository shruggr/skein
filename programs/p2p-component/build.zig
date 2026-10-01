// p2p-component (#51, #70): a test fixture publishing from a WASI 0.2 component by `emit`, built as
// programs/fetch is: a wasm32-wasi core module with
// wit-bindgen's C bindings for world skein:kernel/program (../../wit/bindings/c)
// and no libc (../../wallet-zig/src/cabi.zig), made a component with the
// preview1 command adapter.
//
//   zig build    → zig-out/bin/p2p.wasm (a component)
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const opt: std.builtin.OptimizeMode = .ReleaseSafe;
    const home = b.graph.environ_map.get("HOME") orelse "/root";
    const env_adapter = b.graph.environ_map.get("SKEIN_WASI_ADAPTER");
    const adapter = b.option([]const u8, "wasi-adapter", "the preview1 command adapter (wasmtime v49.0.1)") orelse env_adapter orelse
        b.fmt("{s}/.local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm", .{home});
    const wasm_tools = b.option([]const u8, "wasm-tools", "wasm-tools (1.259.0)") orelse "wasm-tools";

    const bindings = b.path("../../wit/bindings/c");
    const libc_headers = b.path("../../wallet-zig/src/c");
    const cabi = b.createModule(.{ .root_source_file = b.path("../../wallet-zig/src/cabi.zig"), .target = wasi, .optimize = opt });
    const cbor = b.createModule(.{ .root_source_file = b.path("../../kernel-zig/src/cbor.zig"), .target = wasi, .optimize = opt });
    const mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = wasi,
        .optimize = opt,
        .strip = true,
        .imports = &.{ .{ .name = "cabi", .module = cabi }, .{ .name = "cbor", .module = cbor } },
    });
    mod.addIncludePath(bindings);
    mod.addIncludePath(libc_headers);
    mod.addCSourceFile(.{ .file = b.path("../../wit/bindings/c/program.c"), .flags = &.{"-O2"} });
    mod.addObjectFile(b.path("../../wit/bindings/c/program_component_type.o"));
    const core = b.addExecutable(.{ .name = "p2p-core", .root_module = mod });

    const new = b.addSystemCommand(&.{ wasm_tools, "component", "new" });
    new.addArtifactArg(core);
    new.addArg(b.fmt("--adapt=wasi_snapshot_preview1={s}", .{adapter}));
    new.addArg("-o");
    const comp = new.addOutputFileArg("p2p.wasm");
    b.getInstallStep().dependOn(&b.addInstallBinFile(comp, "p2p.wasm").step);
}
