// The programs a runtime starts with and the pinned modules
// (src/runtime/programs.ts). Kept in sync by hand; a test checks every CID
// against the TypeScript's (test/fixtures.json).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const Value = cbor.Value;

pub const Module = struct { name: []const u8, cid: []const u8 };

/// MODULES, in declaration order (install order). Since #71 skein's own
/// sources build only the messagebox, the front door, resolve and the wallet
/// (programs/, over the SDK, shruggr/skein-sdk, #75); the install handlers
/// (objects, head, subscribe) went with #77: those are the kernel's own
/// operations on admin messages (scheduler.zig kernelOp). Since #83 nothing
/// else is pinned: the shell (its modules: brush, coreutils, the toolset),
/// `run` and the chat loop are apps — shruggr/skein-shell and
/// shruggr/skein-chat — installed like any other (a tree carries its
/// modules), as are static (shruggr/skein-static) and the overlay engine
/// (shruggr/skein-overlay).
pub const modules = [_]Module{
    // The wallet's state inside the VM (issue #29): installed, not in a genesis by default.
    .{ .name = "wallet", .cid = "bafkreihjdj7o75mnffyk362rzabszndywo4yoyjq4r7yvtmu3cv4ff3qhq" },
    // The messagebox's records in the instance (issue #33): Zig, wasm32-wasi (programs/messagebox).
    .{ .name = "messagebox", .cid = "bafkreidnkfjixe64ik3usfgyb65gjhlbuvrjedovo7pipj5f6kqkikzdgq" },
    // The front door (#40): the instance as an HTTP server — BRC-103/104, routes, handlers (programs/frontdoor).
    .{ .name = "frontdoor", .cid = "bafkreickxyn5kefdelapxhzb5ygwjuauiy6wlmzwcjf7tq5tnjb3ocyd34" },
    // BRC-169 resolve (#40, #87): its records under `resolve/…`, never the address book; `register` claims only where an application wires them (programs/resolve).
    .{ .name = "resolve", .cid = "bafkreidpvi7hm4u6r4v6xhhj25dq4jcsme3qduarlgmyqhvzq7fa4optby" },
};

pub fn moduleText(name: []const u8) []const u8 {
    for (modules) |m| if (std.mem.eql(u8, m.name, name)) return m.cid;
    unreachable;
}

pub fn moduleCid(alloc: std.mem.Allocator, name: []const u8) ![]u8 {
    return cidm.parse(alloc, moduleText(name));
}

const handler_inputs = [_]cbor.Entry{
    .{ .key = "message", .value = .{ .string = "cid" } },
    .{ .key = "body", .value = .{ .string = "cid" } },
    .{ .key = "box", .value = .{ .string = "string" } },
    .{ .key = "sender", .value = .{ .string = "identity" } },
};


const call_inputs = [_]cbor.Entry{
    .{ .key = "event", .value = .{ .string = "cid?" } },
    .{ .key = "box", .value = .{ .string = "string?" } },
};

const Handler = struct { name: []const u8, services: []const []const u8, description: []const u8, inputs: []const cbor.Entry = &handler_inputs };

const handlers = [_]Handler{
    .{ .name = "messagebox", .services = &.{}, .inputs = &call_inputs, .description = "The BRC-33 messagebox (#40): the front door's sendMessage (one `mail` entry), listMessages (a read), acknowledgeMessage (an `ack` event); stepped, keeps the mail a subscription routes to it (head `mailbox`); called from a step, `send` delivers over http (recorded) on a BRC-104 session with the peer." },
    .{ .name = "resolve", .services = &.{}, .description = "BRC-169 discovery (#40, #70): launched with {handle, domain, key?}, the lookup is a thread (each GET an emit to the fetch provider) that keeps the handle's record under its own head (`resolve/peers`, #87) and finishes with the record's CID; the messagebox's delivery reads it for a key the address book does not name. A `register` box, where an application wires one, takes a claim {handle, domain} and records it if it resolves to the sender. The address book is written only by the kernel's `peers` operation, on an owner-signed message (#77, #87)." },
    .{ .name = "frontdoor", .services = &.{}, .inputs = &.{}, .description = "The front door (#68): the instance's middleware, stepped on every request a transport carries in (http: BRC-103/104 against its session records, head frontdoor/sessions; libp2p: the GossipSub signature; local: a provider's signed message), routed by the kernel's dispatch rows for its transport, the handler an in-VM call, the answer signed on the session. Called (fn read) for a route whose answer is a read of live state." },
};

/// The program names a genesis lists (PROGRAMS), in order.
pub const program_names = [_][]const u8{ "messagebox", "frontdoor", "resolve" };

/// A program record as a value.
pub fn program(alloc: std.mem.Allocator, name: []const u8) !Value {
    var m = cbor.MapBuilder.init(alloc);
    try m.put("kind", cbor.string("program"));
    try m.put("name", cbor.string(name));
    for (handlers) |h| if (std.mem.eql(u8, h.name, name)) {
        var code = cbor.MapBuilder.init(alloc);
        try code.put("wasm", cbor.cidv(try moduleCid(alloc, name)));
        try m.put("code", code.value());
        try m.put("inputs", .{ .map = h.inputs });
        const sv = try alloc.alloc(Value, h.services.len);
        for (h.services, 0..) |s, i| sv[i] = cbor.string(s);
        try m.put("services", .{ .array = sv });
        try m.put("description", cbor.string(h.description));
        return m.value();
    };
    return error.UnknownProgram;
}

pub fn programCid(alloc: std.mem.Allocator, name: []const u8) ![]u8 {
    return cbor.cidOfValue(alloc, try program(alloc, name));
}

/// records.ts isProgram. A program the kernel runs itself has `code: {ts:
/// "shell"}` (#83: the shell app's shell program, its record written by that
/// app's install; shell.zig loadModules reads its `modules` and `support`).
pub fn isProgram(x: ?Value) bool {
    const v = x orelse return false;
    if (v != .map) return false;
    if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse return false, "program")) return false;
    const name = Value.str(v.get("name")) orelse return false;
    if (name.len == 0) return false;
    const code = v.get("code") orelse return false;
    if (code != .map) return false;
    const has_ts = Value.str(code.get("ts")) != null;
    const has_wasm = Value.cidOf(code.get("wasm")) != null;
    if (has_ts == has_wasm) return false;
    if (v.get("inputs") == null) return false;
    const services = v.get("services") orelse return false;
    if (services != .array) return false;
    for (services.array) |s| if (s != .string) return false;
    return Value.str(v.get("description")) != null;
}

pub fn wasmOf(p: Value) ?[]const u8 {
    const code = p.get("code") orelse return null;
    return Value.cidOf(code.get("wasm"));
}

pub fn hasService(p: Value, s: []const u8) bool {
    const services = p.get("services") orelse return false;
    if (services != .array) return false;
    for (services.array) |x| if (x == .string and std.mem.eql(u8, x.string, s)) return true;
    return false;
}
