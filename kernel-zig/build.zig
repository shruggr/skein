// The skein kernel in Zig (issue #32). `zig build` → zig-out/bin/skein-kernel;
// `zig build test` runs the unit tests (fixtures under test/).
//
// wasmtime: the C API release, not vendored. Its directory comes from
// -Dwasmtime=<dir> or $WASMTIME_C_API, default
// ~/.local/wasmtime-c-api/wasmtime-v49.0.1-aarch64-linux-c-api. The static
// libwasmtime.a is linked, so the binary needs nothing of it at run time.
// SQLite: the system libsqlite3 (JSON1 is built in since 3.38).
// LMDB (#96, the shared host store, lmdb_store.zig): vendored, compiled in —
// OpenLDAP's liblmdb at the tag LMDB_0.9.36 (commit 028f61b6), vendor/lmdb/
// (mdb.c, midl.c, lmdb.h, midl.h; its LICENSE and COPYRIGHT: the OpenLDAP
// Public License 2.8). No system dependency, so the -Dcpu=baseline build for the
// rack needs nothing new there. Not in the browser build.
// RocksDB (#158, the one-process kernel's store, rocksdb_store.zig): the system
// librocksdb through its C API (rocksdb/c.h), linked as sqlite3 is (jr: 11.1.1;
// the rack: 10.1.3 — the rack's binary is built on the rack, README). Not in
// the browser build.
// The codecs (cid, cbor, mst, secp) are the SDK's (shruggr/skein-sdk, a Zig
// package dependency by URL+hash in build.zig.zon, #75; with -Dwallet=false).
// Both builds also take the SDK's `chain` module (as `chainlib`: the door's
// BEEF parser and SPV verifier, door.zig, #121; natively also the host
// chain's tracker, host_chain.zig, #156), which brings bsvz (the SDK's lazy
// dependency, fetched by URL+hash). scripts/sdk-local.sh overrides it with
// a sibling checkout for development.
//
// The browser build (issue #35): `zig build web`, or any wasm target
// (`zig build -Dtarget=wasm32-freestanding`) → zig-out/web/skein-kernel.wasm,
// the same kernel with the engine and the store behind the JS shim
// (src/web.zig; kernel-zig/web/). Needs neither wasmtime nor SQLite.
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const web_target = if (target.result.cpu.arch.isWasm()) target else b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding });
    const web = webKernel(b, web_target, optimize);
    sdkImports(b, web.artifact.root_module, web_target, optimize);
    chainImport(b, web.artifact.root_module, web_target, optimize);
    b.step("web", "the browser build: zig-out/web/skein-kernel.wasm").dependOn(&web.step);
    if (target.result.cpu.arch.isWasm()) {
        b.getInstallStep().dependOn(&web.step);
        return;
    }

    const home = b.graph.environ_map.get("HOME") orelse "/root";
    const default_wt = b.fmt("{s}/.local/wasmtime-c-api/wasmtime-v49.0.1-aarch64-linux-c-api", .{home});
    const env_wt = b.graph.environ_map.get("WASMTIME_C_API");
    const wt = b.option([]const u8, "wasmtime", "wasmtime C API directory (include/, lib/)") orelse env_wt orelse default_wt;

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    link(b, mod, wt);
    sdkImports(b, mod, target, optimize);
    chainImport(b, mod, target, optimize);

    // LLVM and LLD in every mode: Zig's own x86_64 backend and linker (its Debug default there)
    // leave every symbol of the static libwasmtime.a undefined.
    const exe = b.addExecutable(.{ .name = "skein-kernel", .root_module = mod, .use_llvm = true, .use_lld = true });
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    if (b.args) |args| run.addArgs(args);
    b.step("run", "run skein-kernel").dependOn(&run.step);

    const tmod = b.createModule(.{
        .root_source_file = b.path("src/tests.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    link(b, tmod, wt);
    sdkImports(b, tmod, target, optimize);
    chainImport(b, tmod, target, optimize);
    const tests = b.addTest(.{ .root_module = tmod, .use_llvm = true, .use_lld = true });
    const trun = b.addRunArtifact(tests);
    trun.setCwd(b.path("."));
    b.step("test", "run the unit tests").dependOn(&trun.step);
}

fn webKernel(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) *std.Build.Step.InstallArtifact {
    const mod = b.createModule(.{
        .root_source_file = b.path("src/web.zig"),
        .target = target,
        .optimize = optimize,
        .single_threaded = true,
        // No DWARF in what the page downloads (4.2 → 2.7 MB); panics still report their message.
        .strip = true,
    });
    // LLVM and LLD in every mode: Zig's own x86_64 backend and linker (its Debug default there)
    // leave every symbol of the static libwasmtime.a undefined.
    const exe = b.addExecutable(.{ .name = "skein-kernel", .root_module = mod, .use_llvm = true, .use_lld = true });
    exe.entry = .disabled;
    exe.rdynamic = true;
    // The kernel's own stack (its shadow stack in linear memory): deep enough for the scheduler's recursion.
    exe.stack_size = 8 << 20;
    return b.addInstallArtifact(exe, .{ .dest_dir = .{ .override = .{ .custom = "web" } } });
}

/// The SDK's codecs, as the modules the kernel imports by name.
fn sdkImports(b: *std.Build, m: *std.Build.Module, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) void {
    const sdk = b.dependency("skein_sdk", .{ .target = target, .optimize = optimize, .wallet = false });
    for ([_][]const u8{ "cid", "cbor", "mst", "secp" }) |name| m.addImport(name, sdk.module(name));
}

/// The SDK's chain module, as `chainlib`: the door's BEEF verifier (door.zig, #121) in both builds,
/// and natively the host chain's tracker (host_chain.zig, #156). It brings bsvz (the SDK's lazy
/// dependency).
fn chainImport(b: *std.Build, m: *std.Build.Module, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) void {
    const sdk = b.dependency("skein_sdk", .{ .target = target, .optimize = optimize, .wallet = false });
    m.addImport("chainlib", sdk.module("chain"));
}

fn link(b: *std.Build, m: *std.Build.Module, wt: []const u8) void {
    m.addIncludePath(.{ .cwd_relative = b.fmt("{s}/include", .{wt}) });
    m.addObjectFile(.{ .cwd_relative = b.fmt("{s}/lib/libwasmtime.a", .{wt}) });
    m.linkSystemLibrary("sqlite3", .{});
    m.linkSystemLibrary("rocksdb", .{});
    m.addIncludePath(b.path("vendor/lmdb"));
    // UBSan off for LMDB's C (Zig turns it on in Debug and ReleaseSafe): its page arithmetic is its own.
    m.addCSourceFiles(.{ .root = b.path("vendor/lmdb"), .files = &.{ "mdb.c", "midl.c" }, .flags = &.{ "-pthread", "-fno-sanitize=undefined", "-Wno-unused-parameter" } });
    m.linkSystemLibrary("pthread", .{});
    m.linkSystemLibrary("dl", .{});
    m.linkSystemLibrary("m", .{});
    m.linkSystemLibrary("gcc_s", .{});
}
