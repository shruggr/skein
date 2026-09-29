// The `skein` import namespace for handler programs (src/runtime/wasi/skein-imports.ts)
// and running one step of a program (src/runtime/program.ts).
//
// ABI: pointers and lengths are i32, CIDs binary. An import returning bytes
// is f(…, out, cap) → n: n >= 0 is the full length, written only if n <= cap;
// the result is held for take(out, cap). n < 0 is an error; error(out, cap)
// returns its message.
//
// Here only (not in the TS runtime), for the wallet (#29):
//   http(req, len, out, cap) → n   a dag-cbor request {method, url, headers?, body?}
//                                  → the response {status, headers, body}, answered
//                                  by the host and recorded (op "http"); kept for
//                                  preview1 programs — a component's standard
//                                  wasi:http becomes this same request (http.zig)
//   libp2p(req, len, out, cap) → n (#51) a dag-cbor request {op, …} → its result:
//                                  publish {topic, body} → {seqno, recipients};
//                                  dial {peer, protocol} → {stream}; send {stream,
//                                  body} → {}; receive {stream} → {body} | {pending}
//                                  | {closed}; close {stream} → {}. Answered by the
//                                  host's libp2p host and recorded (op "libp2p");
//                                  {error} is a failure (n < 0), recorded as well
//   deadline(until_ms) → 0         a step that ends waiting rests until then at most
//   call(prog, fn, arg, out, cap) → n   an in-VM call (#40): run a program as a function
//                                  (input kind "call"), its stdout the result
//   edges(to, len, rel, rel_len, out, cap) → n   (#42) the edges into `to` (a binary CID)
//                                  from the kernel's index, `rel` only if rel_len > 0:
//                                  dag-cbor [{from, seq, rel, locator}] in key order
//                                  (from, seq, ord) — who spent txid:vout is `spends`
//                                  into the tx's CID with locator = vout. A read: a pure
//                                  function of the log, plus the links of the bitcoin
//                                  blocks this step kept so far (exactly the edges its
//                                  update will add); other kept records' refs appear
//                                  from the next step on.
// putblock also takes bitcoin-tx / bitcoin-block (dbl-sha2-256) CIDs, and
// await also takes a record in the store: the subject of a plain entry to come.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const wasi = @import("wasi.zig");
const runner = @import("runner.zig");
const vfsm = @import("vfs.zig");
const tree = @import("tree.zig");
const storem = @import("store.zig");
const bitcoin = @import("bitcoin.zig");
const Value = cbor.Value;

/// Host answers. Failed: the message is in `imp.last_error` (set with imp.failWith).
/// Fatal: ends the run (a diverged replay, a missing witness).
pub const Err = error{ Failed, Fatal, OutOfMemory };

pub const Host = struct {
    ctx: *anyopaque,
    input: *const fn (imp: *Imports) []const u8,
    get: *const fn (imp: *Imports, c: []const u8) Err![]const u8,
    put: *const fn (imp: *Imports, bytes: []const u8) Err![]const u8,
    putBlock: *const fn (imp: *Imports, c: []const u8, bytes: []const u8) Err!void,
    keep: *const fn (imp: *Imports, c: []const u8) Err!void,
    launch: *const fn (imp: *Imports, prog: []const u8, args: []const u8) Err![]const u8,
    awaitReply: *const fn (imp: *Imports, c: []const u8) Err!void,
    head: *const fn (imp: *Imports, name: []const u8) Err!?[]const u8,
    advance: *const fn (imp: *Imports, name: []const u8, tree: []const u8) Err!void,
    subscribe: *const fn (imp: *Imports, op: []const u8, sender: ?[]const u8, box: []const u8, handler: []const u8) Err!void,
    wallet: *const fn (imp: *Imports, frame: []const u8) Err![]const u8,
    /// One HTTP request (dag-cbor {method, url, headers?, body?, options?}) → the
    /// response (dag-cbor {status, headers, body}), answered by the host and
    /// recorded: the preview1 `http` import (#29) and a component's wasi:http
    /// (#15, component.zig through http.zig) both come here.
    http: *const fn (imp: *Imports, request: []const u8) Err![]const u8,
    /// If this step ends waiting, rest no later than `until` (ms): a wake entry then steps it.
    deadline: *const fn (imp: *Imports, until: i64) Err!void,
    /// One libp2p request (#51, dag-cbor {op: "publish" | "dial" | "send" |
    /// "receive" | "close", …}) → its result (dag-cbor), answered by the host's
    /// libp2p host and recorded like `http`; a result {error} is the call's
    /// failure (recorded: replay fails the same way).
    libp2p: *const fn (imp: *Imports, request: []const u8) Err![]const u8 = noLibp2p,
    /// An in-VM call (#40): run `prog` (a program record) as a function — its
    /// entry with `input()` = {kind: "call", fn, arg, …} — and return what it
    /// wrote to stdout. From a step it is part of the step (its recorded calls,
    /// head moves and records are the step's); from a kernel `call` it reads
    /// only (no entry, no writes, nothing recorded).
    call: *const fn (imp: *Imports, prog: []const u8, func: []const u8, arg: []const u8) Err![]const u8,
    /// The edges into `to` (#42): dag-cbor [{from, seq, rel, locator}] (edgesRead).
    edges: *const fn (imp: *Imports, to: []const u8, rel: ?[]const u8) Err![]const u8 = noEdges,
};

fn noEdges(imp: *Imports, _: []const u8, _: ?[]const u8) Err![]const u8 {
    return imp.failWith("edges: this host keeps no index");
}

fn noLibp2p(imp: *Imports, _: []const u8) Err![]const u8 {
    return imp.failWith("libp2p: this host answers no libp2p");
}

/// The answer of `edges` (#42): the index's edges into `to` (with `rel`
/// only, if given), plus those of the bitcoin blocks in `kept` (the step's
/// keeps so far, not yet in the index: from the block at seq 0, as the
/// update will write them), without duplicates, in key order (from, seq,
/// ord), as dag-cbor [{from, seq, rel, locator}].
pub fn edgesRead(a: std.mem.Allocator, s: storem.Store, to: []const u8, rel: ?[]const u8, kept: []const []const u8) ![]u8 {
    var rows = std.array_list.Managed(storem.Edge).init(a);
    try rows.appendSlice(try s.edges(a, to, rel));
    for (kept, 0..) |k, i| {
        if (!bitcoin.isBitcoin(k)) continue;
        var dup = false;
        for (kept[0..i]) |x| dup = dup or std.mem.eql(u8, x, k);
        if (dup) continue;
        const b = (try s.bytes(a, k)) orelse continue;
        for (try bitcoin.linksOf(a, k, b), 0..) |l, ord| {
            if (!std.mem.eql(u8, l.to, to)) continue;
            if (rel) |want| if (!std.mem.eql(u8, want, l.rel)) continue;
            var have = false;
            for (rows.items) |r| have = have or (r.seq == 0 and r.ord == @as(i64, @intCast(ord)) and std.mem.eql(u8, r.from, k));
            if (have) continue;
            try rows.append(.{ .from = try a.dupe(u8, k), .seq = 0, .ord = @intCast(ord), .rel = try a.dupe(u8, l.rel), .locator = if (l.locator) |n| cbor.int(n) else null });
        }
    }
    std.mem.sort(storem.Edge, rows.items, {}, struct {
        fn lt(_: void, x: storem.Edge, y: storem.Edge) bool {
            return switch (std.mem.order(u8, x.from, y.from)) {
                .lt => true,
                .gt => false,
                .eq => x.seq < y.seq or (x.seq == y.seq and x.ord < y.ord),
            };
        }
    }.lt);
    const out = try a.alloc(Value, rows.items.len);
    for (rows.items, out) |r, *o| {
        var m = cbor.MapBuilder.init(a);
        try m.put("from", .{ .cid = r.from });
        try m.put("seq", cbor.int(r.seq));
        try m.put("rel", cbor.string(r.rel));
        try m.put("locator", r.locator orelse .null);
        o.* = m.value();
    }
    return cbor.encode(a, .{ .array = out });
}

pub const Imports = struct {
    host: *const Host,
    alloc: std.mem.Allocator,
    held: []const u8 = "",
    last_error: []const u8 = "",
    fatal: ?wasi.Fatal = null,

    pub fn failWith(imp: *Imports, msg: []const u8) Err {
        imp.last_error = msg;
        return error.Failed;
    }
    pub fn failFmt(imp: *Imports, comptime f: []const u8, args: anytype) Err {
        imp.last_error = std.fmt.allocPrint(imp.alloc, f, args) catch "out of memory";
        return error.Failed;
    }
    pub fn fatalWith(imp: *Imports, kind: @TypeOf(@as(wasi.Fatal, undefined).kind), msg: []const u8) Err {
        imp.fatal = .{ .kind = kind, .message = msg };
        return error.Fatal;
    }

    fn cidAt(imp: *Imports, p: *wasi.Process, ptr: i64, n: i64) Err![]const u8 {
        const b = p.slice(ptr, n) catch return error.OutOfMemory;
        _ = cidm.parts(b) catch return imp.failWith(cidDecodeMessage(b));
        return b;
    }

    fn strAt(imp: *Imports, p: *wasi.Process, ptr: i64, n: i64) Err![]const u8 {
        const b = p.slice(ptr, n) catch return error.OutOfMemory;
        return cbor.utf8Fix(imp.alloc, b) catch error.OutOfMemory;
    }

    /// Write r to (out, cap) if it fits; hold it either way; its length.
    fn out(imp: *Imports, p: *wasi.Process, r: []const u8, ptr: i64, cap: i64) Err!i64 {
        imp.held = r;
        if (@as(i64, @intCast(r.len)) <= cap) {
            p.set(ptr, r) catch return imp.failWith("offset is out of bounds");
        }
        return @intCast(r.len);
    }

    /// The dispatch for the program half of the skein namespace.
    pub fn call(imp: *Imports, p: *wasi.Process, f: wasi.Fn, a: []const i64) wasi.Stop!i64 {
        const r = imp.dispatch(p, f, a) catch |err| switch (err) {
            error.Failed => return -1,
            error.Fatal => {
                p.svc.state.fatal = imp.fatal;
                return error.Fatal;
            },
            error.OutOfMemory => return error.OutOfMemory,
            error.RangeError => return p.fail("offset is out of bounds"),
        };
        return r;
    }

    fn dispatch(imp: *Imports, p: *wasi.Process, f: wasi.Fn, a: []const i64) (Err || error{RangeError})!i64 {
        const h = imp.host;
        switch (f) {
            .input => return imp.out(p, h.input(imp), a[0], a[1]),
            .get => return imp.out(p, try h.get(imp, try imp.cidAt(p, a[0], a[1])), a[2], a[3]),
            .put => return imp.out(p, try h.put(imp, p.slice(a[0], a[1]) catch return error.OutOfMemory), a[2], a[3]),
            .putblock => {
                try h.putBlock(imp, try imp.cidAt(p, a[0], a[1]), p.slice(a[2], a[3]) catch return error.OutOfMemory);
                return 0;
            },
            .keep => {
                try h.keep(imp, try imp.cidAt(p, a[0], a[1]));
                return 0;
            },
            .launch => return imp.out(p, try h.launch(imp, try imp.cidAt(p, a[0], a[1]), try imp.cidAt(p, a[2], a[3])), a[4], a[5]),
            .@"await" => {
                try h.awaitReply(imp, try imp.cidAt(p, a[0], a[1]));
                return 0;
            },
            .head => return imp.out(p, (try h.head(imp, try imp.strAt(p, a[0], a[1]))) orelse "", a[2], a[3]),
            .advance => {
                const name = try imp.strAt(p, a[0], a[1]);
                try h.advance(imp, name, try imp.cidAt(p, a[2], a[3]));
                return 0;
            },
            .subscribe => {
                const op = try imp.strAt(p, a[0], a[1]);
                // The sender is an identity key's 33 bytes (format 2, #33), not text.
                const sender: ?[]const u8 = if (a[3] != 0) try imp.alloc.dupe(u8, p.slice(a[2], a[3]) catch return error.OutOfMemory) else null;
                const box = try imp.strAt(p, a[4], a[5]);
                try h.subscribe(imp, op, sender, box, try imp.cidAt(p, a[6], a[7]));
                return 0;
            },
            .wallet => return imp.out(p, try h.wallet(imp, p.slice(a[0], a[1]) catch return error.OutOfMemory), a[2], a[3]),
            .http => return imp.out(p, try h.http(imp, p.slice(a[0], a[1]) catch return error.OutOfMemory), a[2], a[3]),
            .libp2p => return imp.out(p, try h.libp2p(imp, p.slice(a[0], a[1]) catch return error.OutOfMemory), a[2], a[3]),
            .deadline => {
                try h.deadline(imp, a[0]);
                return 0;
            },
            .call => {
                const prog = try imp.alloc.dupe(u8, try imp.cidAt(p, a[0], a[1]));
                const func = try imp.strAt(p, a[2], a[3]);
                const arg = try imp.alloc.dupe(u8, p.slice(a[4], a[5]) catch return error.OutOfMemory);
                return imp.out(p, try h.call(imp, prog, func, arg), a[6], a[7]);
            },
            .edges => {
                const to = try imp.alloc.dupe(u8, try imp.cidAt(p, a[0], a[1]));
                const rel: ?[]const u8 = if (a[3] > 0) try imp.strAt(p, a[2], a[3]) else null;
                return imp.out(p, try h.edges(imp, to, rel), a[4], a[5]);
            },
            .take => {
                if (@as(i64, @intCast(imp.held.len)) > a[1]) return imp.failWith("take: buffer too small");
                p.set(a[0], imp.held) catch return imp.failWith("offset is out of bounds");
                return @intCast(imp.held.len);
            },
            .@"error" => {
                const b = imp.last_error;
                const cap: usize = @intCast(@max(0, a[1]));
                p.set(a[0], b[0..@min(cap, b.len)]) catch return error.RangeError;
                return @intCast(b.len);
            },
            else => return 52,
        }
    }
};

/// A CID argument as the preview1 imports check it (component.zig: the same
/// check and message for the WIT interface).
pub fn checkCid(imp: *Imports, b: []const u8) Err![]const u8 {
    _ = cidm.parts(b) catch return imp.failWith(cidDecodeMessage(b));
    return b;
}

/// multiformats' CID.decode messages, for the cases a program can reach.
fn cidDecodeMessage(b: []const u8) []const u8 {
    if (b.len == 0) return "Unexpected end of data";
    return "Invalid CID";
}

pub const StepOutput = struct { exit_code: i32, stdout: []u8, stderr: []u8 };

pub const RunError = error{ Fatal, OutOfMemory };

/// One step: a plain WASI command with the skein imports, over an empty tree,
/// stdin null, stdout/stderr captured (1 MiB each), the thread's clock and random.
pub fn runProgram(alloc: std.mem.Allocator, r: *runner.Runner, mod: *runner.Compiled, name: []const u8, host: *const Host, svc: *wasi.Services) RunError!StepOutput {
    return runProgramLimit(alloc, r, mod, name, host, svc, 1 << 20);
}

/// runProgram with stdout/stderr captured up to `limit` bytes each (an in-VM call's result is its stdout, #40).
pub fn runProgramLimit(alloc: std.mem.Allocator, r: *runner.Runner, mod: *runner.Compiled, name: []const u8, host: *const Host, svc: *wasi.Services, limit: usize) RunError!StepOutput {
    const empty = (tree.hashTree(alloc, &.{}) catch return error.OutOfMemory).cid;
    const v = vfsm.Vfs.init(alloc, null, empty) catch return error.OutOfMemory;
    const stdout = try wasi.Pipe.init(alloc, limit, "");
    const stderr = try wasi.Pipe.init(alloc, limit, "");
    const stdio = [3]*wasi.Desc{ try wasi.nullDesc(alloc, v), try wasi.pipeDesc(alloc, v, stdout, true), try wasi.pipeDesc(alloc, v, stderr, true) };
    var imp = Imports{ .host = host, .alloc = alloc };
    const args = try alloc.alloc([]const u8, 1);
    args[0] = name;
    const code = r.runModule(alloc, mod, v, args, &.{}, stdio, svc, &imp) catch |err| switch (err) {
        error.Park => unreachable, // no sleep service for programs
        error.Fatal => return error.Fatal,
        error.OutOfMemory => return error.OutOfMemory,
    };
    return .{ .exit_code = code, .stdout = try stdout.drain(alloc), .stderr = try stderr.drain(alloc) };
}
