//! subscribe-handler: the handler program for the `subscribe` box — changing
//! the instance's subscriptions (docs/VM.md, "Subscriptions").
//!
//! The admitted body is {op, sender?, box, handler}: op "add" appends the rule
//! (sender, box) → handler, "remove" deletes it; no sender is any sender (the
//! sender is an identity key's 33 bytes, or hex from a JSON-era client). The
//! handler must be a program record in the store (for a wasm program, with its
//! module: `objects` delivers both). The kernel writes the change when the
//! step ends. Whoever is subscribed to this box may change the subscriptions:
//! the genesis subscribes the owner; delegating is subscribing another sender.
//! No reply.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("subscribe-handler", run);
}

fn run(a: Allocator) !void {
    step(a) catch |e| return sk.plain(e);
}

fn step(a: Allocator) !void {
    const in = try sk.input(a);
    const args: Value = in.get("args") orelse .null;
    const b = try sk.readBody(a, try sk.linkField(args, "message"), try sk.linkField(args, "body"));
    const op = sk.textField(b, "op") catch |e| return sk.wrap(a, "body", e);
    const box = sk.textField(b, "box") catch |e| return sk.wrap(a, "body", e);
    const handler = sk.linkField(b, "handler") catch |e| return sk.wrap(a, "body", e);
    const sender = sk.keyOf(a, b.get("sender")) catch |e| return sk.wrap(a, "body", e);
    if ((!eql(u8, op, "add") and !eql(u8, op, "remove")) or box.len == 0 or handler.len == 0) {
        return sk.report("body: want {op: add|remove, sender?, box, handler}");
    }
    const rec = sk.getBytes(a, handler) catch |e| {
        return sk.wrap(a, try std.fmt.allocPrint(a, "handler {s}: not in the store", .{try sk.hex(a, handler)}), e);
    };
    const p = cbor.decode(a, rec) catch return sk.report("handler: not a program record");
    if (!eql(u8, Value.str(p.get("kind")) orelse "", "program")) return sk.report("handler: not a program record");
    try sk.subscribe(op, if (sender) |s| (if (s.len == 0) null else s) else null, box, handler);
}
