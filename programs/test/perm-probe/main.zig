// perm-probe (call permissions): one module, installed as several apps by
// kernel-zig/equiv/call-permissions.ts. What it does, by input:
//
//   a step on a message {kind: "probe", op, …} in its app's box:
//     op "call"   {prog: <cid>, fn, name?: text, arg?: map} — an in-VM call to `prog`, named (callAs)
//                 when `name` is given, else plain (call); recorded {op, ok, answer?: bytes, error?}
//     op "sign"   the raw signer (the identity-key frame); recorded {op, ok, error?}
//     op "launch" {prog: <cid>} — a thread of `prog` with args {probe: "launched"}; recorded {op, ok}
//     op "mail"   {to: bytes(33), box} — a message {kind: "probe", op: "seen"} to `to` in `box`
//     op "seen"   recorded {op: "seen", as: <its input's `as`, or null>}
//     op "rewrite" {drop?: [<field>], name?: text} — the app rewrites its own record at `<app>/app`
//                 (an app may: the head is under its name); recorded {op, ok}
//     op "putprog" a copy of its own program record, named "stray", put by the step (installed by
//                 no one); recorded {op, prog: <its cid>}
//   a launched thread (args.probe = "launched"): recorded {op: "launched", as}
//   a call:
//     fn "who"    → {as: <its input's `as`, or null>, signed: bool, error?}
//     fn "nest"   arg {prog: <cid>} → {as, inner: <prog's "who" answer, by a plain call>}
//     fn "callAs" arg {prog: <cid>, name, fn} → {ok, answer?: bytes, error?} (a named call from a call)
//
// Each record goes to the head `<app>/out`, chained by `prev`.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

extern "skein" fn callAs(prog: [*]const u8, prog_len: u32, func: [*]const u8, func_len: u32, name: [*]const u8, name_len: u32, arg: [*]const u8, arg_len: u32, out: [*]u8, cap: u32) i32;

pub fn main() u8 {
    return sk.main("perm-probe", run);
}

fn n32(n: usize) u32 {
    return @intCast(n);
}

fn named(a: Allocator, prog: []const u8, func: []const u8, name: []const u8, arg: []const u8) ![]u8 {
    return sk.result(a, callAs, .{ prog.ptr, n32(prog.len), func.ptr, n32(func.len), name.ptr, n32(name.len), arg.ptr, n32(arg.len) });
}

fn print(a: Allocator, bytes: []const u8) !void {
    _ = a;
    try std.Io.File.stdout().writeStreamingAll(sk.io(), bytes);
}

fn appOf(a: Allocator, in: Value) ![]const u8 {
    const origin = try sk.get(a, Value.cidOf(in.get("thread")) orelse return sk.report("the step names no thread"));
    const prog = try sk.get(a, Value.cidOf(origin.get("program")) orelse return sk.report("the thread names no program"));
    return Value.str(prog.get("app")) orelse sk.report("the program record names no app");
}

fn record(a: Allocator, app: []const u8, m: *cbor.MapBuilder) !void {
    const head = try std.fmt.allocPrint(a, "{s}/out", .{app});
    try m.put("prev", if (try sk.head(a, head)) |p| cbor.cidv(p) else .null);
    try sk.advance(head, try sk.put(a, m.value()));
    try print(a, "recorded\n");
}

const identity_frame = [_]u8{ 8, 0, 1, 0, 0xff, 0 };

fn signs(a: Allocator, m: *cbor.MapBuilder) !void {
    if (sk.wallet(a, &identity_frame)) |_| {
        try m.put("signed", .{ .bool = true });
    } else |_| {
        try m.put("signed", .{ .bool = false });
        try m.put("error", cbor.string(try a.dupe(u8, sk.lastError())));
    }
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "call")) return onCall(a, in);
    if (!eql(u8, kind, "step")) return sk.report("perm-probe takes steps and calls");
    // A launcher stepped again when its launched thread is done: nothing more to do.
    if (in.get("resolved") != null) return print(a, "done\n");
    const app = try appOf(a, in);
    const args = in.get("args") orelse return sk.report("no args");
    var m = cbor.MapBuilder.init(a);
    if (eql(u8, Value.str(args.get("probe")) orelse "", "launched")) {
        try m.put("op", cbor.string("launched"));
        try m.put("as", in.get("as") orelse .null);
        return record(a, app, &m);
    }
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return sk.report("not a message (no body)"));
    const op = Value.str(body.get("op")) orelse return sk.report("perm-probe: want {kind: \"probe\", op}");
    try m.put("op", cbor.string(op));
    if (eql(u8, op, "call")) {
        const prog = Value.cidOf(body.get("prog")) orelse return sk.report("call wants {prog, fn}");
        const func = Value.str(body.get("fn")) orelse return sk.report("call wants {prog, fn}");
        const arg = try cbor.encode(a, body.get("arg") orelse .{ .map = &.{} });
        const got = if (Value.str(body.get("name"))) |n| named(a, prog, func, n, arg) else sk.call(a, prog, func, arg);
        if (got) |ans| {
            try m.put("ok", .{ .bool = true });
            try m.put("answer", .{ .bytes = ans });
        } else |_| {
            try m.put("ok", .{ .bool = false });
            try m.put("error", cbor.string(try a.dupe(u8, sk.lastError())));
        }
    } else if (eql(u8, op, "sign")) {
        try signs(a, &m);
    } else if (eql(u8, op, "launch")) {
        const prog = Value.cidOf(body.get("prog")) orelse return sk.report("launch wants {prog}");
        var la = cbor.MapBuilder.init(a);
        try la.put("probe", cbor.string("launched"));
        _ = sk.launch(a, prog, try sk.put(a, la.value())) catch return sk.report(sk.lastError());
        try m.put("ok", .{ .bool = true });
    } else if (eql(u8, op, "mail")) {
        const to = Value.bytesOf(body.get("to")) orelse return sk.report("mail wants {to, box}");
        var mb = cbor.MapBuilder.init(a);
        try mb.put("kind", cbor.string("probe"));
        try mb.put("op", cbor.string("seen"));
        _ = sk.emit(a, to, Value.str(body.get("box")) orelse return sk.report("mail wants {to, box}"), mb.value(), null) catch return sk.report(sk.lastError());
        try m.put("ok", .{ .bool = true });
    } else if (eql(u8, op, "rewrite")) {
        const head = try std.fmt.allocPrint(a, "{s}/app", .{app});
        const rec = try sk.get(a, (try sk.head(a, head)) orelse return sk.report("no app record"));
        const drop = body.get("drop");
        var nm = cbor.MapBuilder.init(a);
        for (rec.map) |e| {
            var dropped = false;
            if (drop) |d| if (d == .array) for (d.array) |x| if (Value.str(x)) |k| if (eql(u8, k, e.key)) {
                dropped = true;
            };
            if (dropped) continue;
            if (eql(u8, e.key, "name")) if (body.get("name")) |n| {
                try nm.put("name", n);
                continue;
            };
            try nm.put(e.key, e.value);
        }
        try sk.advance(head, try sk.put(a, nm.value()));
        try m.put("ok", .{ .bool = true });
    } else if (eql(u8, op, "putprog")) {
        const origin = try sk.get(a, Value.cidOf(in.get("thread")) orelse return sk.report("the step names no thread"));
        const prog = try sk.get(a, Value.cidOf(origin.get("program")) orelse return sk.report("the thread names no program"));
        var pm = cbor.MapBuilder.init(a);
        for (prog.map) |e| try pm.put(e.key, if (eql(u8, e.key, "name")) cbor.string("stray") else e.value);
        try m.put("prog", cbor.cidv(try sk.put(a, pm.value())));
    } else if (eql(u8, op, "seen")) {
        try m.put("as", in.get("as") orelse .null);
    } else return sk.report("perm-probe: op is call, sign, launch, mail, seen, rewrite or putprog");
    return record(a, app, &m);
}

fn onCall(a: Allocator, in: Value) !void {
    const func = Value.str(in.get("fn")) orelse return sk.report("a call names no fn");
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch Value{ .map = &.{} };
    var m = cbor.MapBuilder.init(a);
    try m.put("as", in.get("as") orelse .null);
    if (eql(u8, func, "who")) {
        try signs(a, &m);
    } else if (eql(u8, func, "nest")) {
        const prog = Value.cidOf(arg.get("prog")) orelse return sk.report("nest wants {prog}");
        const inner = sk.call(a, prog, "who", try cbor.encode(a, .{ .map = &.{} })) catch return sk.report(sk.lastError());
        try m.put("inner", .{ .bytes = inner });
    } else if (eql(u8, func, "callAs")) {
        const prog = Value.cidOf(arg.get("prog")) orelse return sk.report("callAs wants {prog, name, fn}");
        const got = named(a, prog, Value.str(arg.get("fn")) orelse "who", Value.str(arg.get("name")) orelse "", try cbor.encode(a, arg.get("arg") orelse .{ .map = &.{} }));
        if (got) |ans| {
            try m.put("ok", .{ .bool = true });
            try m.put("answer", .{ .bytes = ans });
        } else |_| {
            try m.put("ok", .{ .bool = false });
            try m.put("error", cbor.string(try a.dupe(u8, sk.lastError())));
        }
    } else return sk.report("perm-probe: a call's fn is who, nest or callAs");
    return print(a, try cbor.encode(a, m.value()));
}
