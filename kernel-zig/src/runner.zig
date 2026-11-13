// Running WASI modules: the engine, compiled modules by CID (cached for the
// life of the process, as programs.ts loadModule does), and runModule
// (shell.ts runModule): instantiate, run to exit, map traps as V8 reports them.
// A module is a preview1 core module (skein next: the WASI 0.2 component runner moved out of the
// kernel, to extras/component-runner/).
const std = @import("std");
const engine = @import("engine.zig");
const wasi = @import("wasi.zig");
const cidm = @import("cid");
const vfsm = @import("vfs.zig");
const program = @import("program.zig");
const Store = @import("store.zig").Store;

/// The reason a step that ran out of fuel records (issue #5).
pub const FUEL_EXHAUSTED = "fuel exhausted";

pub const Compiled = struct {
    /// A preview1 core module.
    mod: *engine.Module,
    prog_bindings: []wasi.Fn = &.{},
};

pub const Runner = struct {
    gpa: std.mem.Allocator,
    eng: engine.Engine,
    cache: std.StringHashMap(*Compiled),
    /// A module run in place of another (issue #34, `skein-kernel replay` with
    /// SKEIN_REPLAY_MODULE): the same log replayed with a program's other build,
    /// e.g. its component, to compare the ABIs update by update. Never in serve.
    subst: ?struct { cid: []const u8, bytes: []const u8 } = null,
    /// #158: `skein-kernel host` shares one runner among its workers — set, the cache is read and
    /// filled under `mu` (a module is compiled outside it; a second compile of the same CID by a
    /// racing worker is dropped for the first). Unset (serve, the tools, the browser): one thread.
    io: ?std.Io = null,
    mu: std.Io.Mutex = .init,

    pub fn init(gpa: std.mem.Allocator) !*Runner {
        const r = try gpa.create(Runner);
        r.* = .{ .gpa = gpa, .eng = try engine.Engine.init(), .cache = std.StringHashMap(*Compiled).init(gpa) };
        return r;
    }

    pub fn compile(r: *Runner, bytes: []const u8, err_msg: *[]const u8) !*Compiled {
        const mod = try engine.Module.compile(&r.eng, r.gpa, bytes, err_msg);
        const c = try r.gpa.create(Compiled);
        c.* = .{
            .mod = mod,
            .prog_bindings = try r.gpa.alloc(wasi.Fn, mod.imports.len),
        };
        for (mod.imports, 0..) |imp, i| c.prog_bindings[i] = wasi.bind(imp.module, imp.name, true);
        return c;
    }

    pub const LoadError = error{ NotInStore, BadHash, Compile, OutOfMemory, Store };

    /// A module from the store by CID, compiled once. `msg` gets the message on failure.
    fn cached(r: *Runner, k: []const u8) ?*Compiled {
        const io = r.io orelse return r.cache.get(k);
        r.mu.lockUncancelable(io);
        defer r.mu.unlock(io);
        return r.cache.get(k);
    }

    /// Keep `c` under `k`, or (another worker kept one first) return that one.
    fn keep(r: *Runner, k: []const u8, c: *Compiled) LoadError!*Compiled {
        if (r.io) |io| r.mu.lockUncancelable(io);
        defer if (r.io) |io| r.mu.unlock(io);
        if (r.cache.get(k)) |had| return had; // the racing compile is leaked: once per module per process at most
        r.cache.put(r.gpa.dupe(u8, k) catch return error.OutOfMemory, c) catch return error.OutOfMemory;
        return c;
    }

    pub fn load(r: *Runner, s: Store, a: std.mem.Allocator, cid: []const u8, msg: *[]const u8) LoadError!*Compiled {
        const k = cidm.format(a, cid) catch return error.OutOfMemory;
        if (r.cached(k)) |c| return c;
        if (r.subst) |sub| if (std.mem.eql(u8, sub.cid, cid)) {
            var em: []const u8 = "";
            const c = r.compile(sub.bytes, &em) catch {
                msg.* = std.fmt.allocPrint(a, "WebAssembly.compile(): {s}", .{em}) catch "compile failed";
                return error.Compile;
            };
            return r.keep(k, c);
        };
        const bytes = (s.bytes(a, cid) catch return error.Store) orelse {
            msg.* = std.fmt.allocPrint(a, "module not in store: {s}", .{k}) catch "module not in store";
            return error.NotInStore;
        };
        const raw = cidm.ofRaw(a, bytes) catch return error.OutOfMemory;
        if (!std.mem.eql(u8, raw, cid)) {
            msg.* = std.fmt.allocPrint(a, "module {s}: bytes do not match the CID", .{k}) catch "bad module";
            return error.BadHash;
        }
        var em: []const u8 = "";
        const c = r.compile(bytes, &em) catch {
            msg.* = std.fmt.allocPrint(a, "WebAssembly.compile(): {s}", .{em}) catch "compile failed";
            return error.Compile;
        };
        return r.keep(k, c);
    }

    /// Instantiate and run a program (a WASI command with the skein imports) to exit. Exit
    /// code, or Fatal with the reason in svc.state.
    pub fn runModule(r: *Runner, alloc: std.mem.Allocator, c: *Compiled, v: *vfsm.Vfs, args: []const []const u8, env: []const []const u8, stdio: [3]*wasi.Desc, svc: *wasi.Services, prog: *program.Imports) wasi.Stop!i32 {
        const p = try wasi.Process.init(alloc, v, args, env, stdio, svc);
        p.prog = prog;
        p.bindings = c.prog_bindings;
        var em: []const u8 = "";
        const outcome = c.mod.run(&r.eng, p, wasi.Process.call, &em, alloc, svc.state.meter) catch {
            return p.fail(em);
        };
        switch (outcome) {
            .returned => return 0,
            .aborted => {
                if (svc.state.parked) return error.Park;
                if (svc.state.fatal != null) return error.Fatal;
                if (p.exit_code) |code| return code;
                return p.fail("aborted");
            },
            .trapped => |t| {
                if (t == .out_of_fuel) {
                    // Not the program's trap: the step ends, whatever instance was running (issue #5).
                    svc.state.fatal = .{ .kind = .fuel, .message = FUEL_EXHAUSTED };
                    return error.Fatal;
                }
                if (t == .stack_overflow) return p.fail(t.v8Message()); // a RangeError under V8, not a RuntimeError
                const line = try std.fmt.allocPrint(alloc, "{s}: trapped: {s}\n", .{ args[0], t.v8Message() });
                wasi.writeTo(stdio[2], line);
                return 134;
            },
        }
    }
};
