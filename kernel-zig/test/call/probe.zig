//! A probe for the kernel's `call` (#40), wasm32-wasi: kernel-zig/test/call/build.sh
//! builds it into probe.wasm (committed; src/host/call.test.ts runs it).
//!
//! Called (input kind "call"), by `fn`:
//!   echo      stdout = arg
//!   input     stdout = the whole call input (dag-cbor)
//!   put       put(arg as dag-cbor), get it back: stdout = the CID ‖ the bytes read back
//!   head      stdout = the tree CID the head named `arg` points at ("" if none)
//!   advance   advance head "probe" to a put record {kind: "probe", arg}: fails in a kernel call
//!   spin      loops until the fuel runs out
//!   nest      arg = the probe's own CID: calls itself with fn "echo" and "nested", stdout = its answer
//!   fail      exits 1 with "probe: asked to fail"
//! As a step (input kind "step", a subscription's handler): calls itself
//! (the program CID in args.event's record `probe`) with fn "advance", so the
//! in-VM call's head move is the step's.
const std = @import("std");

const sk = struct {
    extern "skein" fn input(out: [*]u8, cap: u32) i32;
    extern "skein" fn get(cid: [*]const u8, cid_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn put(data: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn head(name: [*]const u8, name_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn advance(name: [*]const u8, name_len: u32, tree: [*]const u8, tree_len: u32) i32;
    extern "skein" fn call(prog: [*]const u8, prog_len: u32, func: [*]const u8, func_len: u32, arg: [*]const u8, arg_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn take(out: [*]u8, cap: u32) i32;
    extern "skein" fn @"error"(out: [*]u8, cap: u32) i32;
};

/// The program's Io: one single-threaded WASI process, no concurrency.
fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

var errbuf: [1024]u8 = undefined;

fn fail(what: []const u8) noreturn {
    const n = sk.@"error"(&errbuf, errbuf.len);
    const m = if (n > 0) errbuf[0..@min(@as(usize, @intCast(n)), errbuf.len)] else "";
    var out: [1200]u8 = undefined;
    const line = std.fmt.bufPrint(&out, "probe: {s}: {s}\n", .{ what, m }) catch "probe: failed\n";
    std.Io.File.stderr().writeStreamingAll(io(), line) catch {};
    std.process.exit(1);
}

fn result(a: std.mem.Allocator, n0: i32, buf: []u8, what: []const u8) []u8 {
    if (n0 < 0) fail(what);
    const n: usize = @intCast(n0);
    if (n <= buf.len) return buf[0..n];
    const big = a.alloc(u8, n) catch fail("oom");
    if (sk.take(big.ptr, @intCast(n)) != n0) fail("take");
    return big;
}

/// A dag-cbor map's text or bytes value by key: enough CBOR for the probe's own input.
fn field(b: []const u8, key: []const u8) ?[]const u8 {
    var i: usize = 0;
    while (i + key.len + 1 < b.len) : (i += 1) {
        const hdr = b[i];
        if (hdr >> 5 != 3 or (hdr & 31) != key.len) continue;
        if (!std.mem.eql(u8, b[i + 1 .. i + 1 + key.len], key)) continue;
        var j = i + 1 + key.len;
        const h = b[j];
        const major = h >> 5;
        if (major != 2 and major != 3 and major != 6) continue;
        var ai = h & 31;
        j += 1;
        if (major == 6) { // tag 42: a CID, 0x00 ‖ bytes
            if (ai != 24 or b[j] != 42) continue;
            j += 1;
            ai = b[j] & 31;
            j += 1;
        }
        var len: usize = ai;
        if (ai == 24) {
            len = b[j];
            j += 1;
        } else if (ai == 25) {
            len = std.mem.readInt(u16, b[j..][0..2], .big);
            j += 2;
        } else if (ai == 26) {
            len = std.mem.readInt(u32, b[j..][0..4], .big);
            j += 4;
        }
        const v = b[j .. j + len];
        return if (major == 6) v[1..] else v;
    }
    return null;
}

pub fn main() u8 {
    var arena = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    const a = arena.allocator();
    var buf: [65536]u8 = undefined;
    const in = a.dupe(u8, result(a, sk.input(&buf, buf.len), &buf, "input")) catch fail("oom");
    const kind = field(in, "kind") orelse fail("no kind");
    const out = std.Io.File.stdout();
    if (std.mem.eql(u8, kind, "step")) {
        // A subscription's handler: the event record names the probe's own CID.
        const ev = field(in, "event") orelse fail("step: no event");
        const rec = result(a, sk.get(ev.ptr, @intCast(ev.len), &buf, buf.len), &buf, "get event");
        const self = a.dupe(u8, field(rec, "probe") orelse fail("the event names no probe")) catch fail("oom");
        const r = result(a, sk.call(self.ptr, @intCast(self.len), "advance", 7, "from a step", 11, &buf, buf.len), &buf, "call advance");
        out.writeStreamingAll(io(), r) catch {};
        return 0;
    }
    const func = field(in, "fn") orelse fail("no fn");
    const arg = field(in, "arg") orelse "";
    if (std.mem.eql(u8, func, "echo")) {
        out.writeStreamingAll(io(), arg) catch {};
    } else if (std.mem.eql(u8, func, "input")) {
        out.writeStreamingAll(io(), in) catch {};
    } else if (std.mem.eql(u8, func, "put")) {
        var cb: [128]u8 = undefined;
        const c = a.dupe(u8, result(a, sk.put(arg.ptr, @intCast(arg.len), &cb, cb.len), &cb, "put")) catch fail("oom");
        const back = result(a, sk.get(c.ptr, @intCast(c.len), &buf, buf.len), &buf, "get");
        out.writeStreamingAll(io(), c) catch {};
        out.writeStreamingAll(io(), back) catch {};
    } else if (std.mem.eql(u8, func, "head")) {
        out.writeStreamingAll(io(), result(a, sk.head(arg.ptr, @intCast(arg.len), &buf, buf.len), &buf, "head")) catch {};
    } else if (std.mem.eql(u8, func, "advance")) {
        // {kind: "probe", arg}
        var rec = std.array_list.Managed(u8).init(a);
        rec.appendSlice(&.{ 0xa2, 0x63, 'a', 'r', 'g' }) catch fail("oom");
        if (arg.len < 24) {
            rec.append(0x60 | @as(u8, @intCast(arg.len))) catch fail("oom");
        } else {
            rec.append(0x78) catch fail("oom");
            rec.append(@intCast(arg.len)) catch fail("oom");
        }
        rec.appendSlice(arg) catch fail("oom");
        rec.appendSlice(&.{ 0x64, 'k', 'i', 'n', 'd', 0x65, 'p', 'r', 'o', 'b', 'e' }) catch fail("oom");
        var cb: [128]u8 = undefined;
        const c = result(a, sk.put(rec.items.ptr, @intCast(rec.items.len), &cb, cb.len), &cb, "put");
        if (sk.advance("probe", 5, c.ptr, @intCast(c.len)) < 0) fail("advance");
        out.writeStreamingAll(io(), c) catch {};
    } else if (std.mem.eql(u8, func, "spin")) {
        var x: u64 = 0;
        while (true) {
            x +%= 1;
            std.mem.doNotOptimizeAway(x);
        }
    } else if (std.mem.eql(u8, func, "nest")) {
        const r = result(a, sk.call(arg.ptr, @intCast(arg.len), "echo", 4, "nested", 6, &buf, buf.len), &buf, "call");
        out.writeStreamingAll(io(), r) catch {};
    } else if (std.mem.eql(u8, func, "whoami")) {
        // A front-door handler (#40): {status: 200, type: "application/octet-stream", body: <the caller's key>}.
        const caller = field(in, "caller") orelse "";
        var r = std.array_list.Managed(u8).init(a);
        r.appendSlice(&.{ 0xa3, 0x64, 'b', 'o', 'd', 'y' }) catch fail("oom");
        if (caller.len < 24) r.append(0x40 | @as(u8, @intCast(caller.len))) catch fail("oom") else r.appendSlice(&.{ 0x58, @intCast(caller.len) }) catch fail("oom");
        r.appendSlice(caller) catch fail("oom");
        r.appendSlice(&.{ 0x64, 't', 'y', 'p', 'e', 0x78, 24 }) catch fail("oom");
        r.appendSlice("application/octet-stream") catch fail("oom");
        r.appendSlice(&.{ 0x66, 's', 't', 'a', 't', 'u', 's', 0x18, 200 }) catch fail("oom");
        out.writeStreamingAll(io(), r.items) catch {};
    } else if (std.mem.eql(u8, func, "fail")) {
        std.Io.File.stderr().writeStreamingAll(io(), "probe: asked to fail\n") catch {};
        return 1;
    } else fail("unknown fn");
    return 0;
}
