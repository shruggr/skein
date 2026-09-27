// Running WASI modules: the engine, compiled modules by CID (cached for the
// life of the process, as programs.ts loadModule does), and runModule
// (shell.ts runModule): instantiate, run to exit, map traps as V8 reports them.
const std = @import("std");
const engine = @import("engine.zig");
const wasi = @import("wasi.zig");
const cidm = @import("cid.zig");
const vfsm = @import("vfs.zig");
const program = @import("program.zig");
const Store = @import("store.zig").Store;

pub const Compiled = struct {
    mod: *engine.Module,
    shell_bindings: []wasi.Fn,
    prog_bindings: []wasi.Fn,
};

pub const Runner = struct {
    gpa: std.mem.Allocator,
    eng: engine.Engine,
    cache: std.StringHashMap(*Compiled),

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
            .shell_bindings = try r.gpa.alloc(wasi.Fn, mod.imports.len),
            .prog_bindings = try r.gpa.alloc(wasi.Fn, mod.imports.len),
        };
        for (mod.imports, 0..) |imp, i| {
            c.shell_bindings[i] = wasi.bind(imp.module, imp.name, false);
            c.prog_bindings[i] = wasi.bind(imp.module, imp.name, true);
        }
        return c;
    }

    pub const LoadError = error{ NotInStore, BadHash, Compile, OutOfMemory, Store };

    /// A module from the store by CID, compiled once. `msg` gets the TS runtime's message on failure.
    pub fn load(r: *Runner, s: Store, a: std.mem.Allocator, cid: []const u8, msg: *[]const u8) LoadError!*Compiled {
        const k = cidm.format(a, cid) catch return error.OutOfMemory;
        if (r.cache.get(k)) |c| return c;
        const bytes = (s.bytes(a, cid) catch return error.Store) orelse {
            msg.* = std.fmt.allocPrint(a, "module not in store: {s} (skein-dev install puts it there)", .{k}) catch "module not in store";
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
        r.cache.put(r.gpa.dupe(u8, k) catch return error.OutOfMemory, c) catch return error.OutOfMemory;
        return c;
    }

    /// Instantiate and run a WASI command to exit (shell.ts runModule). Exit
    /// code, or Fatal/Park with the reason in svc.state.
    pub fn runModule(r: *Runner, alloc: std.mem.Allocator, c: *Compiled, v: *vfsm.Vfs, args: []const []const u8, env: []const []const u8, stdio: [3]*wasi.Desc, svc: *wasi.Services, prog: ?*program.Imports) wasi.Stop!i32 {
        const p = try wasi.Process.init(alloc, v, args, env, stdio, svc);
        p.prog = prog;
        p.bindings = if (prog != null) c.prog_bindings else c.shell_bindings;
        var em: []const u8 = "";
        const outcome = c.mod.run(&r.eng, p, wasi.Process.call, &em, alloc) catch {
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
                if (t == .stack_overflow) return p.fail(t.v8Message()); // a RangeError under V8, not a RuntimeError
                const line = try std.fmt.allocPrint(alloc, "{s}: trapped: {s}\n", .{ args[0], t.v8Message() });
                wasi.writeTo(stdio[2], line);
                return 134;
            },
        }
    }
};
