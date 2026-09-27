// The skein kernel in Zig (issue #32). `zig build` → zig-out/bin/skein-kernel;
// `zig build test` runs the unit tests (fixtures under test/).
//
// wasmtime: the C API release, not vendored. Its directory comes from
// -Dwasmtime=<dir> or $WASMTIME_C_API, default
// ~/.local/wasmtime-c-api/wasmtime-v49.0.1-aarch64-linux-c-api. The static
// libwasmtime.a is linked, so the binary needs nothing of it at run time.
// SQLite: the system libsqlite3 (JSON1 is built in since 3.38).
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{ .preferred_optimize_mode = .ReleaseSafe });

    const home = std.process.getEnvVarOwned(b.allocator, "HOME") catch "/root";
    const default_wt = b.fmt("{s}/.local/wasmtime-c-api/wasmtime-v49.0.1-aarch64-linux-c-api", .{home});
    const env_wt = std.process.getEnvVarOwned(b.allocator, "WASMTIME_C_API") catch null;
    const wt = b.option([]const u8, "wasmtime", "wasmtime C API directory (include/, lib/)") orelse env_wt orelse default_wt;

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    link(b, mod, wt);

    const exe = b.addExecutable(.{ .name = "skein-kernel", .root_module = mod });
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
    const tests = b.addTest(.{ .root_module = tmod });
    const trun = b.addRunArtifact(tests);
    trun.setCwd(b.path("."));
    b.step("test", "run the unit tests").dependOn(&trun.step);
}

fn link(b: *std.Build, m: *std.Build.Module, wt: []const u8) void {
    m.addIncludePath(.{ .cwd_relative = b.fmt("{s}/include", .{wt}) });
    m.addObjectFile(.{ .cwd_relative = b.fmt("{s}/lib/libwasmtime.a", .{wt}) });
    m.linkSystemLibrary("sqlite3", .{});
    m.linkSystemLibrary("pthread", .{});
    m.linkSystemLibrary("dl", .{});
    m.linkSystemLibrary("m", .{});
    m.linkSystemLibrary("gcc_s", .{});
}
