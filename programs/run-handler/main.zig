//! run-handler: the handler program for the `run` box (docs/MESSAGES.md).
//!
//! Step 1 (input: the admitted message and its body record): decode the body
//! {cmd, tree?, cwd?, env?} (no tree: the `main` head's, else the empty tree),
//! put the shell's arguments {cmd, tree, cwd?, env?} as a record and launch
//! the shell with it. The step ends; the thread waits on the shell.
//!
//! Step 2 (input: the shell at rest): send the result to the sender in box
//! `results` (an emit, #70: delivered by its transport): {exitCode, stdout, stderr, tree,
//! replyTo: <message>} (or {error, replyTo} if the shell errored).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("run-handler", run);
}

fn run(a: Allocator) !void {
    step(a) catch |e| return sk.plain(e);
}

fn step(a: Allocator) !void {
    const in = try sk.input(a);
    const args: Value = in.get("args") orelse .null;
    const resolved = sk.listField(in, "resolved") catch |e| return sk.wrap(a, "input", e);
    if (resolved.len == 0) return first(a, in, args);
    return second(a, args, resolved[0]);
}

fn first(a: Allocator, in: Value, args: Value) !void {
    const b = try sk.readBody(a, try sk.linkField(args, "message"), try sk.linkField(args, "body"));
    const cmd = sk.textField(b, "cmd") catch |e| return sk.wrap(a, "body", e);
    var tree = sk.linkField(b, "tree") catch |e| return sk.wrap(a, "body", e);
    const cwd = sk.textField(b, "cwd") catch |e| return sk.wrap(a, "body", e);
    // env: text to text; none (or an empty one) is left out.
    var env: ?Value = null;
    if (b.get("env")) |e| switch (e) {
        .null => {},
        .map => |m| {
            for (m) |x| if (x.value != .string and x.value != .null) return sk.report("body: env: not a map of strings");
            if (m.len > 0) {
                const out = try a.alloc(cbor.Entry, m.len);
                for (m, out) |x, *o| o.* = .{ .key = x.key, .value = if (x.value == .null) cbor.string("") else x.value };
                env = .{ .map = out };
            }
        },
        else => return sk.report("body: env: not a map of strings"),
    };
    if (cmd.len == 0) return sk.report("body: want {cmd, tree?, cwd?, env?}");
    if (tree.len == 0) tree = try sk.startTree(a);
    var sa = cbor.MapBuilder.init(a);
    try sa.put("cmd", cbor.string(cmd));
    try sa.put("tree", cbor.cidv(tree));
    if (cwd.len > 0) try sa.put("cwd", cbor.string(cwd));
    try sa.put("env", env);
    const rc = sk.put(a, sa.value()) catch |e| return sk.wrap(a, "put shell args", e);
    const shell = sk.program(in, "shell") orelse return sk.report("no shell program");
    _ = sk.launch(a, shell, rc) catch |e| return sk.wrap(a, "launch", e);
}

/// A byte-string field as the Go handler read it: bytes, or null when absent or null.
fn bytesField(v: Value, key: []const u8) !Value {
    const x = v.get(key) orelse return .null;
    return switch (x) {
        .null, .bytes => x,
        else => sk.report("shell result: stdout/stderr not bytes"),
    };
}

fn second(a: Allocator, args: Value, r: Value) !void {
    const sender = (try sk.keyOf(a, args.get("sender"))) orelse "";
    const message = try sk.linkField(args, "message");
    const state = try sk.textField(r, "state");
    const res = r.get("result");
    var body = cbor.MapBuilder.init(a);
    if (!eql(u8, state, "finished") or res == null) {
        var msg = state;
        if (r.get("error")) |e| if (Value.str(e.get("message"))) |m| if (m.len > 0) {
            msg = m;
        };
        try body.put("error", cbor.string(msg));
    } else {
        const sr = res.?;
        if (sr != .map and sr != .null) return sk.report("shell result: not a map");
        const tree = sk.linkField(sr, "tree") catch |e| return sk.wrap(a, "shell result", e);
        if (tree.len == 0) return sk.report("skein: empty CID");
        try body.put("exitCode", cbor.int(sk.intField(sr, "exitCode") catch |e| return sk.wrap(a, "shell result", e)));
        try body.put("stdout", try bytesField(sr, "stdout"));
        try body.put("stderr", try bytesField(sr, "stderr"));
        try body.put("tree", cbor.cidv(tree));
    }
    if (message.len == 0) return sk.report("skein: empty CID");
    try body.put("replyTo", cbor.cidv(message));
    _ = try sk.send(a, sender, "results", body.value());
}
