//! The skein-next test program (wasm32-wasi; kernel-zig/test/call/build-next.sh builds it into
//! next.wasm, committed; src/runtime_test.zig drives it). One program of the app `next`
//! (role `main`), written against the raw `skein` imports and the SDK's dag-cbor codec.
//!
//! As a call (input kind "call"), by `fn`:
//!   pass        a check: {pass: {}}
//!   reject      a check: {reject: {status: 418, code: "ERR_NO", reason: "no"}}
//!   store       a check: puts {kind: "checked", n: 1}, hands the package on rewritten (payload.body
//!               replaced by that record's CID) with the block named: {pass: {request, blocks: [cid]}}
//!   principal   a check: passes a principal on (the 33-byte key in the payload body)
//!   unspent     a recheck: refuses ("already spent") when the head next/spent is set, else passes
//!   read        a read row's handler: {status: 200, body: dag-cbor {read: path}}
//! As a step (input kind "step"), by `args.fn`:
//!   handle      {status: 200, type: "application/cbor", body: dag-cbor {path, caller?, body?}};
//!               path /spend advances next/spent; path /ping emits the fact next/ping
//!   launch      launches a thread of `args.row.prog` on {fn: "child"}; awaits it unless the row's
//!               `nowait`; answers with what it launched, or (resumed) what the child finished with
//!   child       stdout "child"
//!   awaitname   awaits the fact next/ping; resumed, answers with the event's name
//!   on          on("next/ping", "main.onping"); with the row's `nofn`, on("next/ping", "")
//!   onping      advances next/pinged to the event record
//!   deadline    calls the old `deadline` import: answers with what it returned (52: unknown)
//!   emitkey     emits a message to a key: answers with the error
//!   event       an event row's handler: advances next/event to the event record
const std = @import("std");
const cbor = @import("cbor");
const Value = cbor.Value;

const sk = struct {
    extern "skein" fn input(out: [*]u8, cap: u32) i32;
    extern "skein" fn get(cid: [*]const u8, cid_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn put(data: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn head(name: [*]const u8, name_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn advance(name: [*]const u8, name_len: u32, tree: [*]const u8, tree_len: u32) i32;
    extern "skein" fn launch(prog: [*]const u8, prog_len: u32, args: [*]const u8, args_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn await(x: [*]const u8, len: u32) i32;
    extern "skein" fn emit(msg: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn on(name: [*]const u8, name_len: u32, func: [*]const u8, func_len: u32) i32;
    extern "skein" fn deadline(until: i64) i32;
    extern "skein" fn take(out: [*]u8, cap: u32) i32;
    extern "skein" fn @"error"(out: [*]u8, cap: u32) i32;
};

fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

var errbuf: [1024]u8 = undefined;

fn lastError() []const u8 {
    const n = sk.@"error"(&errbuf, errbuf.len);
    return if (n > 0) errbuf[0..@min(@as(usize, @intCast(n)), errbuf.len)] else "";
}

fn fail(what: []const u8) noreturn {
    var out: [1200]u8 = undefined;
    const line = std.fmt.bufPrint(&out, "next: {s}: {s}\n", .{ what, lastError() }) catch "next: failed\n";
    std.Io.File.stderr().writeStreamingAll(io(), line) catch {};
    std.process.exit(1);
}

fn result(a: std.mem.Allocator, n0: i32, what: []const u8) []u8 {
    if (n0 < 0) fail(what);
    const n: usize = @intCast(n0);
    const big = a.alloc(u8, n) catch fail("oom");
    if (n > 0 and sk.take(big.ptr, @intCast(n)) != n0) fail("take");
    return big;
}

var scratch: [1]u8 = undefined;

fn putValue(a: std.mem.Allocator, v: Value) []u8 {
    const b = cbor.encode(a, v) catch fail("encode");
    return result(a, sk.put(b.ptr, @intCast(b.len), &scratch, 0), "put");
}

fn getValue(a: std.mem.Allocator, c: []const u8) Value {
    const b = result(a, sk.get(c.ptr, @intCast(c.len), &scratch, 0), "get");
    return cbor.decode(a, b) catch fail("decode");
}

fn advance(name: []const u8, c: []const u8) void {
    if (sk.advance(name.ptr, @intCast(name.len), c.ptr, @intCast(c.len)) < 0) fail("advance");
}

fn hasHead(a: std.mem.Allocator, name: []const u8) bool {
    const n = sk.head(name.ptr, @intCast(name.len), &scratch, 0);
    if (n < 0) fail("head");
    _ = a;
    return n > 0;
}

fn write(a: std.mem.Allocator, v: Value) void {
    const b = cbor.encode(a, v) catch fail("encode");
    std.Io.File.stdout().writeStreamingAll(io(), b) catch {};
}

fn answer(a: std.mem.Allocator, body: Value) void {
    var m = cbor.MapBuilder.init(a);
    m.put("status", cbor.int(200)) catch fail("oom");
    m.put("type", cbor.string("application/cbor")) catch fail("oom");
    m.put("body", .{ .bytes = cbor.encode(a, body) catch fail("encode") }) catch fail("oom");
    write(a, m.value());
}

fn wrap(a: std.mem.Allocator, key: []const u8, v: Value) Value {
    var m = cbor.MapBuilder.init(a);
    m.put(key, v) catch fail("oom");
    return m.value();
}

pub fn main() u8 {
    var arena = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    const a = arena.allocator();
    const in = cbor.decode(a, result(a, sk.input(&scratch, 0), "input")) catch fail("input");
    const kind = Value.str(in.get("kind")) orelse fail("no kind");
    if (std.mem.eql(u8, kind, "call")) return call(a, in);
    const args = in.get("args") orelse fail("no args");
    const func = Value.str(args.get("fn")) orelse fail("no fn");
    const row = args.get("row") orelse Value.null;
    if (std.mem.eql(u8, func, "handle")) {
        const path = Value.str(args.get("path")) orelse "";
        if (std.mem.eql(u8, path, "/spend")) advance("next/spent", putValue(a, wrap(a, "spent", cbor.string(path))));
        if (std.mem.eql(u8, path, "/ping")) _ = result(a, sk.emit(blk: {
            const b = cbor.encode(a, wrap(a, "event", cbor.string("next/ping"))) catch fail("encode");
            break :blk b.ptr;
        }, @intCast((cbor.encode(a, wrap(a, "event", cbor.string("next/ping"))) catch fail("encode")).len), &scratch, 0), "emit");
        var m = cbor.MapBuilder.init(a);
        m.put("path", cbor.string(path)) catch fail("oom");
        if (Value.bytesOf(args.get("caller"))) |c| m.put("caller", .{ .bytes = c }) catch fail("oom");
        if (args.get("body")) |b| m.put("body", b) catch fail("oom");
        answer(a, m.value());
        return 0;
    }
    if (std.mem.eql(u8, func, "launch")) {
        if (in.get("resolved")) |rs| {
            const first = rs.array[0];
            const res = first.get("result") orelse fail("no result");
            answer(a, wrap(a, "resolved", .{ .bytes = Value.bytesOf(res.get("stdout")) orelse "" }));
            return 0;
        }
        const prog = Value.cidOf(row.get("prog")) orelse fail("the row names no prog");
        const ac = putValue(a, wrap(a, "fn", cbor.string("child")));
        const child = result(a, sk.launch(prog.ptr, @intCast(prog.len), ac.ptr, @intCast(ac.len), &scratch, 0), "launch");
        if (row.get("nowait") == null) if (sk.await(child.ptr, @intCast(child.len)) < 0) fail("await");
        answer(a, wrap(a, "launched", cbor.cidv(child)));
        return 0;
    }
    if (std.mem.eql(u8, func, "child")) {
        std.Io.File.stdout().writeStreamingAll(io(), "child") catch {};
        return 0;
    }
    if (std.mem.eql(u8, func, "awaitname")) {
        if (in.get("event")) |ev| {
            answer(a, wrap(a, "woke", ev.get("box") orelse Value.null));
            return 0;
        }
        const name = "next/ping";
        if (sk.await(name.ptr, name.len) < 0) fail("await");
        return 0;
    }
    if (std.mem.eql(u8, func, "on")) {
        const name = "next/ping";
        const f: []const u8 = if (row.get("nofn") != null) "" else "main.onping";
        if (sk.on(name.ptr, name.len, f.ptr, @intCast(f.len)) < 0) {
            answer(a, wrap(a, "error", cbor.string(lastError())));
            return 0;
        }
        answer(a, wrap(a, "on", cbor.string(name)));
        return 0;
    }
    if (std.mem.eql(u8, func, "onping")) {
        advance("next/pinged", Value.cidOf(args.get("event")) orelse fail("no event"));
        return 0;
    }
    if (std.mem.eql(u8, func, "deadline")) {
        const r = sk.deadline(1);
        answer(a, wrap(a, "deadline", cbor.int(r)));
        return 0;
    }
    if (std.mem.eql(u8, func, "emitkey")) {
        var m = cbor.MapBuilder.init(a);
        m.put("to", .{ .bytes = &([_]u8{2} ++ [_]u8{7} ** 32) }) catch fail("oom");
        m.put("box", cbor.string("x")) catch fail("oom");
        m.put("body", .{ .bytes = cbor.encode(a, wrap(a, "x", cbor.int(1))) catch fail("encode") }) catch fail("oom");
        const b = cbor.encode(a, m.value()) catch fail("encode");
        const n = sk.emit(b.ptr, @intCast(b.len), &scratch, 0);
        answer(a, wrap(a, if (n < 0) "error" else "emitted", cbor.string(if (n < 0) lastError() else "")));
        return 0;
    }
    if (std.mem.eql(u8, func, "event")) {
        advance("next/event", Value.cidOf(args.get("event")) orelse fail("no event"));
        return 0;
    }
    fail("no such fn");
}

fn call(a: std.mem.Allocator, in: Value) u8 {
    const func = Value.str(in.get("fn")) orelse fail("no fn");
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch Value.null;
    if (std.mem.eql(u8, func, "pass")) {
        write(a, wrap(a, "pass", .{ .map = &.{} }));
    } else if (std.mem.eql(u8, func, "reject")) {
        var r = cbor.MapBuilder.init(a);
        r.put("status", cbor.int(418)) catch fail("oom");
        r.put("code", cbor.string("ERR_NO")) catch fail("oom");
        r.put("reason", cbor.string("no")) catch fail("oom");
        // A refusal writes nothing, even what the check put.
        _ = putValue(a, wrap(a, "rejected-check-put", cbor.int(1)));
        write(a, wrap(a, "reject", r.value()));
    } else if (std.mem.eql(u8, func, "store")) {
        var rec = cbor.MapBuilder.init(a);
        rec.put("kind", cbor.string("checked")) catch fail("oom");
        rec.put("n", cbor.int(1)) catch fail("oom");
        const c = putValue(a, rec.value());
        const req = arg.get("request") orelse fail("no request");
        var p = cbor.MapBuilder.init(a);
        for (req.get("payload").?.map) |e| p.put(e.key, if (std.mem.eql(u8, e.key, "body")) cbor.cidv(c) else e.value) catch fail("oom");
        var q = cbor.MapBuilder.init(a);
        for (req.map) |e| q.put(e.key, if (std.mem.eql(u8, e.key, "payload")) p.value() else e.value) catch fail("oom");
        var pass = cbor.MapBuilder.init(a);
        pass.put("request", q.value()) catch fail("oom");
        pass.put("blocks", .{ .array = a.dupe(Value, &.{cbor.cidv(c)}) catch fail("oom") }) catch fail("oom");
        write(a, wrap(a, "pass", pass.value()));
    } else if (std.mem.eql(u8, func, "principal")) {
        const key = Value.bytesOf(arg.get("body")) orelse fail("no body");
        write(a, wrap(a, "pass", wrap(a, "principal", .{ .bytes = key })));
    } else if (std.mem.eql(u8, func, "unspent")) {
        if (hasHead(a, "next/spent")) {
            var r = cbor.MapBuilder.init(a);
            r.put("status", cbor.int(409)) catch fail("oom");
            r.put("code", cbor.string("ERR_SPENT")) catch fail("oom");
            r.put("reason", cbor.string("already spent")) catch fail("oom");
            write(a, wrap(a, "reject", r.value()));
        } else write(a, wrap(a, "pass", .{ .map = &.{} }));
    } else if (std.mem.eql(u8, func, "read")) {
        var m = cbor.MapBuilder.init(a);
        m.put("status", cbor.int(200)) catch fail("oom");
        m.put("body", .{ .bytes = cbor.encode(a, wrap(a, "read", arg.get("path") orelse Value.null)) catch fail("encode") }) catch fail("oom");
        write(a, m.value());
    } else fail("no such fn");
    return 0;
}
