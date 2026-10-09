// skein-amm (shruggr/skein#120): the AMM as a skein overlay app over the Mandala components.
// Zig 0.16.0, wasm32-wasi. The app's tree carries the overlay engine and the Mandala topic
// manager and lookup service, copied from their tagged builds (URL+hash dependencies; nothing is
// built on the skein), and this repo's own programs:
//
//   amm-lookup      ls_amm: the pool liquidity lookup over every token topic served   programs/amm-lookup
//   amm-validator   the validator: swap, addLiquidity, deploy (libp2p direct calls)       programs/amm-validator
//   amm-p2p         the relay (amm.swap/1, amm.pool/1,               programs/amm-p2p
//                   amm.liquidity/1), the app's box and its pages (www/, files.serve)
//
// over the pool library (src/pool.zig: the Pool contract as the overlay sees it, over the
// `mandala` module's parser and rules) and its generated fixtures (src/fixtures, gen/).
//
//   zig build              → zig-out/bin/{amm-lookup,amm-validator,amm-p2p}.wasm
//   zig build bin          the three, written to bin/, with bin/overlay.wasm (skein-overlay v0.9.2)
//                          and bin/mandala-{topic,lookup}.wasm (skein-mandala v0.7.5) copied beside
//   zig build test         the pool library and the three programs' tests, natively
//
// The Mandala pages (skein-mandala v0.7.5's www/) are copied into www/mandala/ by
// scripts/mandala-pages.sh (the tag's tarball by URL and sha256): they are not in the Zig package.
// The AMM pages are built from web/ui into www/ (scripts/www.sh runs both).
const std = @import("std");

/// The modules a program or a test imports, for one target.
const Mods = struct {
    chain: *std.Build.Module,
    wallet: *std.Build.Module,
    message: *std.Build.Module,
    cbor: *std.Build.Module,
    sk: *std.Build.Module,
    app: *std.Build.Module,
    files: *std.Build.Module,
    dagjson: *std.Build.Module,
    topic: *std.Build.Module,
    lookup: *std.Build.Module,
    overlay_sk: *std.Build.Module,
    mandala: *std.Build.Module,
    pool: *std.Build.Module,
    /// skein-overlay's engine sources (src/state.zig, src/submit.zig, src/engine_vm.zig, …), which
    /// it does not export as modules: the validator submits through the engine's own
    /// `submit.route` and reads its state, as amm-poc did with skein-overlay 0.2.0.
    engine: *std.Build.Module,
};

fn mods(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.OptimizeMode) Mods {
    const ov = b.dependency("skein_overlay", .{ .target = target, .optimize = optimize });
    const sdk = ov.builder.dependency("skein_sdk", .{ .target = target, .optimize = optimize });
    const md = b.dependency("skein_mandala", .{ .target = target, .optimize = optimize });
    const chain = sdk.module("chain");
    const mandala = md.module("mandala");
    const wf = b.addWriteFiles();
    _ = wf.addCopyDirectory(ov.path("src"), "skein_overlay", .{});
    const engine = b.createModule(.{
        .root_source_file = wf.add("skein_overlay/lib.zig",
            \\pub const state = @import("state.zig");
            \\pub const submit = @import("submit.zig");
            \\pub const calls = @import("calls.zig");
            \\pub const config = @import("config.zig");
            \\pub const topics = @import("topics.zig");
            \\pub const engine_vm = @import("engine_vm.zig");
            \\
        ),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "chain", .module = chain },
            .{ .name = "topic", .module = ov.module("topic") },
            .{ .name = "sk", .module = ov.module("sk") },
        },
    });
    return .{
        .chain = chain,
        .wallet = sdk.module("wallet"),
        .message = sdk.module("message"),
        .cbor = sdk.module("cbor"),
        .sk = sdk.module("sk"),
        .app = sdk.module("app"),
        .files = sdk.module("files"),
        .dagjson = sdk.module("dagjson"),
        .topic = ov.module("topic"),
        .lookup = ov.module("lookup"),
        .overlay_sk = ov.module("sk"),
        .mandala = mandala,
        .pool = b.createModule(.{
            .root_source_file = b.path("src/pool.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{ .{ .name = "chain", .module = chain }, .{ .name = "mandala", .module = mandala } },
        }),
        .engine = engine,
    };
}

/// One program's (or its tests') imports.
fn imports(b: *std.Build, m: Mods, program: []const u8) []const std.Build.Module.Import {
    const common = [_]std.Build.Module.Import{
        .{ .name = "chain", .module = m.chain },
        .{ .name = "mandala", .module = m.mandala },
        .{ .name = "pool", .module = m.pool },
    };
    const more: []const std.Build.Module.Import = if (std.mem.eql(u8, program, "amm-lookup")) &.{
        .{ .name = "lookup", .module = m.lookup },
    } else if (std.mem.eql(u8, program, "amm-validator")) &.{
        .{ .name = "wallet", .module = m.wallet },
        .{ .name = "message", .module = m.message },
        .{ .name = "sdk_cbor", .module = m.cbor },
        .{ .name = "topic", .module = m.topic },
        .{ .name = "overlay_sk", .module = m.overlay_sk },
        .{ .name = "skein_overlay", .module = m.engine },
    } else &.{
        .{ .name = "wallet", .module = m.wallet },
        .{ .name = "message", .module = m.message },
        .{ .name = "sdk_cbor", .module = m.cbor },
        .{ .name = "sk", .module = m.sk },
        .{ .name = "app", .module = m.app },
        .{ .name = "files", .module = m.files },
        .{ .name = "dagjson", .module = m.dagjson },
        .{ .name = "overlay_sk", .module = m.overlay_sk },
        .{ .name = "skein_overlay", .module = m.engine },
    };
    return std.mem.concat(b.allocator, std.Build.Module.Import, &.{ &common, more }) catch @panic("OOM");
}

const programs = [_][]const u8{ "amm-lookup", "amm-validator", "amm-p2p" };

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    _ = optimize;

    const wasi = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wm = mods(b, wasi, .ReleaseSafe);
    const bin = b.addUpdateSourceFiles();
    for (programs) |p| {
        const exe = b.addExecutable(.{
            .name = p,
            .root_module = b.createModule(.{
                .root_source_file = b.path(b.fmt("programs/{s}/src/main.zig", .{p})),
                .target = wasi,
                .optimize = .ReleaseSafe,
                .strip = true,
                .imports = imports(b, wm, p),
            }),
        });
        b.installArtifact(exe);
        bin.addCopyFileToSource(exe.getEmittedBin(), b.fmt("bin/{s}.wasm", .{p}));
    }
    // The engine and the Mandala components, as their tags built them (not rebuilt here).
    const ov = b.dependency("skein_overlay", .{ .target = wasi, .optimize = .ReleaseSafe });
    const md = b.dependency("skein_mandala", .{ .target = wasi, .optimize = .ReleaseSafe });
    bin.addCopyFileToSource(ov.path("bin/overlay.wasm"), "bin/overlay.wasm");
    bin.addCopyFileToSource(md.path("bin/mandala-topic.wasm"), "bin/mandala-topic.wasm");
    bin.addCopyFileToSource(md.path("bin/mandala-lookup.wasm"), "bin/mandala-lookup.wasm");
    b.step("bin", "write the app's modules into bin/: this repo's three, and the engine and the Mandala components copied from their tags").dependOn(&bin.step);

    const nm = mods(b, target, .Debug);
    const test_step = b.step("test", "The pool library and the three programs' tests, natively");
    const roots = [_][2][]const u8{
        .{ "pool", "test.zig" },
        .{ "amm-lookup", "programs/amm-lookup/test.zig" },
        .{ "amm-validator", "programs/amm-validator/test.zig" },
        .{ "amm-p2p", "programs/amm-p2p/test.zig" },
    };
    for (roots) |r| {
        const m = b.createModule(.{
            .root_source_file = b.path(r[1]),
            .target = target,
            .optimize = .Debug,
            .imports = imports(b, nm, r[0]),
        });
        m.addImport("vectors", b.createModule(.{ .root_source_file = b.path("src/fixtures/vectors.zig"), .target = target, .optimize = .Debug }));
        m.addImport("add_liquidity", b.createModule(.{ .root_source_file = b.path("src/fixtures/add_liquidity.zig"), .target = target, .optimize = .Debug }));
        // The manifest, for the dispatch tests: the functions' declarations as an installed app's are read.
        const wf = b.addWriteFiles();
        _ = wf.addCopyFile(b.path("etc/app.json"), "app.json");
        m.addImport("app_manifest", b.createModule(.{
            .root_source_file = wf.add("app_manifest.zig", "pub const json = @embedFile(\"app.json\");\n"),
            .target = target,
            .optimize = .Debug,
        }));
        const t = b.addTest(.{ .root_module = m, .name = r[0] });
        const run = b.addRunArtifact(t);
        test_step.dependOn(&run.step);
        b.step(b.fmt("test-{s}", .{r[0]}), b.fmt("{s}'s tests alone", .{r[0]})).dependOn(&run.step);
    }
}
