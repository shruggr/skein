//! head-handler: the handler program for the `head` box — the owner moving a
//! named head (docs/VM.md, "Heads").
//!
//! The admitted body is {name, tree}: the head is advanced to the tree; the
//! kernel writes the head's update when the step ends (the tree must be in the
//! store).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;

pub fn main() u8 {
    return sk.main("head-handler", run);
}

fn run(a: Allocator) !void {
    step(a) catch |e| return sk.plain(e);
}

fn step(a: Allocator) !void {
    const in = try sk.input(a);
    const args: Value = in.get("args") orelse .null;
    const b = try sk.readBody(a, try sk.linkField(args, "message"), try sk.linkField(args, "body"));
    const name = sk.textField(b, "name") catch |e| return sk.wrap(a, "body", e);
    const tree = sk.linkField(b, "tree") catch |e| return sk.wrap(a, "body", e);
    if (name.len == 0 or tree.len == 0) return sk.report("body: want {name, tree}");
    try sk.advance(name, tree);
}
