// The wallet's handler program (issue #29): Zig 0.16.0, wasm32-wasi, over the
// SDK's wallet library (skein-sdk `wallet`: its records, index maps, chain,
// SPV, BEEF, BRC-29; over bsvz, the SDK's lazy URL dependency).
//
//   zig build              → zig-out/bin/wallet.wasm (scripts/build-programs.sh copies it to wasm/)
//   zig build component    the same program as a WASI 0.2 component (#34) → zig-out/bin/wallet.component.wasm
const std = @import("std");

pub fn build(b: *std.Build) void {
    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });

    // The handler program.
    const install_prog = b.addInstallArtifact(programExe(b, wasi, false), .{});
    b.getInstallStep().dependOn(&install_prog.step);
    b.step("program", "Build the wallet handler program (wasm32-wasi)").dependOn(&install_prog.step);

    // The same program as a WASI 0.2 component (issue #34): the skein calls
    // through the WIT (the SDK's wit/skein.wit, world `program`) and
    // wit-bindgen's C bindings (the SDK's `skein_wit` module compiles them in),
    // WASI through the preview1 command adapter.
    // Needs wasm-tools (-Dwasm-tools, default on PATH) and the adapter
    // (-Dwasi-adapter, else $SKEIN_WASI_ADAPTER, else
    // ~/.local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm).
    const home = b.graph.environ_map.get("HOME") orelse "/root";
    const env_adapter = b.graph.environ_map.get("SKEIN_WASI_ADAPTER");
    const adapter = b.option([]const u8, "wasi-adapter", "the preview1 command adapter (wasmtime v49.0.1)") orelse env_adapter orelse
        b.fmt("{s}/.local/wasi-adapter-v49.0.1/wasi_snapshot_preview1.command.wasm", .{home});
    const wasm_tools = b.option([]const u8, "wasm-tools", "wasm-tools (1.259.0)") orelse "wasm-tools";
    const core = programExe(b, wasi, true);
    // The core module carries the world (program_component_type.o, from wit-bindgen).
    const new = b.addSystemCommand(&.{ wasm_tools, "component", "new" });
    new.addArtifactArg(core);
    new.addArg(b.fmt("--adapt=wasi_snapshot_preview1={s}", .{adapter}));
    new.addArg("-o");
    const comp = new.addOutputFileArg("wallet.component.wasm");
    const install_comp = b.addInstallBinFile(comp, "wallet.component.wasm");
    b.step("component", "Build the wallet handler program as a WASI 0.2 component").dependOn(&install_comp.step);
}

/// The handler program, for preview1 (the `skein` imports) or as the core of
/// the component (the SDK's `skein_wit`: the WIT's C bindings, no libc).
fn programExe(b: *std.Build, wasi: std.Build.ResolvedTarget, component: bool) *std.Build.Step.Compile {
    const sdk = b.dependency("skein_sdk", .{ .target = wasi, .optimize = .ReleaseSafe });
    const opts = b.addOptions();
    opts.addOption(bool, "component", component);
    const mod = b.createModule(.{
        .root_source_file = b.path("main.zig"),
        .target = wasi,
        .optimize = .ReleaseSafe,
        .strip = true,
        .imports = &.{
            .{ .name = "wallet", .module = sdk.module("wallet") },
            // #130: the BEEF pointer record's encoder (chain.record.beefOf), for a funding the door decoded.
            .{ .name = "chain", .module = sdk.module("chain") },
            .{ .name = "build_options", .module = opts.createModule() },
        },
    });
    if (component) mod.addImport("skein_wit", sdk.module("skein_wit"));
    return b.addExecutable(.{ .name = if (component) "wallet-core" else "wallet", .root_module = mod });
}
