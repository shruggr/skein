//! messagebox: the BRC-33 messagebox's records inside the instance (issue #33),
//! a wasm32-wasi command stepped with the `skein` imports. The router
//! terminates transport and BRC-104 auth and admits each state change as a
//! `mail` log entry; the genesis subscribes this program to the reserved box
//! `:mail`, so each such entry is one step here:
//!
//!   {op: "put", recipient: bytes(33), box, sender: bytes(33), messageId, body: bytes, json?: true}
//!       a message for a hosted identity (the body as submitted: dag-cbor bytes,
//!       or a JSON body's UTF-8 text with `json`)
//!   {op: "ack", recipient: bytes(33), messageIds: [text]}
//!       the recipient acknowledged these: they are deleted
//!
//! State is the head `mailbox`, naming
//!   {kind: "mailbox", recipients: [{identity: bytes(33), mail: <cid>}]}   (sorted by identity)
//! and each recipient's
//!   {kind: "mail", identity: bytes(33), messages: [{messageId, box, sender, body, json?, at}]}
//! in admission order: listMessages for a hosted identity is a read of its
//! record, in log order (the router reads it through the kernel). A message id
//! already kept for that recipient is not kept twice. Each step moves the head.
const std = @import("std");
const cbor = @import("cbor");

const Value = cbor.Value;

const sk = struct {
    extern "skein" fn input(out: [*]u8, cap: u32) i32;
    extern "skein" fn get(cid: [*]const u8, cid_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn put(data: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn head(name: [*]const u8, name_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn advance(name: [*]const u8, name_len: u32, tree: [*]const u8, tree_len: u32) i32;
    extern "skein" fn take(out: [*]u8, cap: u32) i32;
    extern "skein" fn @"error"(out: [*]u8, cap: u32) i32;
};

var last_error: [1024]u8 = undefined;
var last_error_len: usize = 0;

fn failed() error{ImportFailed} {
    const n = sk.@"error"(&last_error, last_error.len);
    last_error_len = if (n < 0) 0 else @min(@as(usize, @intCast(n)), last_error.len);
    return error.ImportFailed;
}

/// Run an import that writes (out, cap), taking the held result when it did not fit.
fn result(a: std.mem.Allocator, call: anytype, args: anytype) ![]u8 {
    var buf = try a.alloc(u8, 4096);
    const n = @call(.auto, call, args ++ .{ buf.ptr, @as(u32, @intCast(buf.len)) });
    if (n < 0) return failed();
    const len: usize = @intCast(n);
    if (len <= buf.len) return buf[0..len];
    buf = try a.alloc(u8, len);
    if (sk.take(buf.ptr, @intCast(len)) != n) return failed();
    return buf;
}

fn getValue(a: std.mem.Allocator, c: []const u8) !Value {
    return cbor.decode(a, try result(a, sk.get, .{ c.ptr, @as(u32, @intCast(c.len)) }));
}

fn putValue(a: std.mem.Allocator, v: Value) ![]u8 {
    const bytes = try cbor.encode(a, v);
    return result(a, sk.put, .{ bytes.ptr, @as(u32, @intCast(bytes.len)) });
}

const head_name = "mailbox";

pub fn main() u8 {
    var arena = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    defer arena.deinit();
    run(arena.allocator()) catch |e| {
        var buf: [1400]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "messagebox: {s}{s}{s}\n", .{ @errorName(e), if (last_error_len > 0) ": " else "", last_error[0..last_error_len] }) catch "messagebox: error\n";
        std.fs.File.stderr().writeAll(msg) catch {};
        return 1;
    };
    return 0;
}

fn isKey(b: ?[]const u8) bool {
    const k = b orelse return false;
    return k.len == 33 and (k[0] == 2 or k[0] == 3);
}

fn run(a: std.mem.Allocator) !void {
    const step = try cbor.decode(a, try result(a, sk.input, .{}));
    const args = step.get("args") orelse return error.BadInput;
    const op = Value.str(args.get("op")) orelse return error.BadOp;
    const recipient = Value.bytesOf(args.get("recipient")) orelse return error.BadRecipient;
    if (!isKey(recipient)) return error.BadRecipient;
    const at = Value.intOf(step.get("at")) orelse 0;

    // The state: the root record and this recipient's list.
    const root_cid = try result(a, sk.head, .{ head_name.ptr, @as(u32, head_name.len) });
    var recipients = std.ArrayList(Value).empty;
    var mine: ?Value = null;
    if (root_cid.len > 0) {
        const root = try getValue(a, root_cid);
        if (root.get("recipients")) |rs| if (rs == .array) for (rs.array) |r| {
            if (std.mem.eql(u8, Value.bytesOf(r.get("identity")) orelse "", recipient)) {
                mine = try getValue(a, Value.cidOf(r.get("mail")) orelse return error.BadState);
            } else try recipients.append(a, r);
        };
    }
    var messages = std.ArrayList(Value).empty;
    if (mine) |m| if (m.get("messages")) |ms| if (ms == .array) try messages.appendSlice(a, ms.array);

    if (std.mem.eql(u8, op, "put")) {
        const box = Value.str(args.get("box")) orelse return error.BadBox;
        const sender = Value.bytesOf(args.get("sender")) orelse return error.BadSender;
        if (!isKey(sender)) return error.BadSender;
        const id = Value.str(args.get("messageId")) orelse return error.BadMessageId;
        const body = Value.bytesOf(args.get("body")) orelse return error.BadBody;
        for (messages.items) |x| if (std.mem.eql(u8, Value.str(x.get("messageId")) orelse "", id)) return; // already kept
        var m = cbor.MapBuilder.init(a);
        try m.put("messageId", cbor.string(id));
        try m.put("box", cbor.string(box));
        try m.put("sender", .{ .bytes = sender });
        try m.put("body", .{ .bytes = body });
        if (args.get("json")) |j| if (j == .bool and j.bool) try m.put("json", .{ .bool = true });
        try m.put("at", cbor.int(at));
        try messages.append(a, m.value());
    } else if (std.mem.eql(u8, op, "ack")) {
        const ids = args.get("messageIds") orelse return error.BadMessageIds;
        if (ids != .array) return error.BadMessageIds;
        var kept = std.ArrayList(Value).empty;
        for (messages.items) |x| {
            const id = Value.str(x.get("messageId")) orelse "";
            var gone = false;
            for (ids.array) |i| if (i == .string and std.mem.eql(u8, i.string, id)) {
                gone = true;
            };
            if (!gone) try kept.append(a, x);
        }
        messages = kept;
    } else return error.BadOp;

    // Save: this recipient's list (none when empty), then the root, sorted by identity; move the head.
    if (messages.items.len > 0) {
        var l = cbor.MapBuilder.init(a);
        try l.put("kind", cbor.string("mail"));
        try l.put("identity", .{ .bytes = recipient });
        try l.put("messages", .{ .array = messages.items });
        const lc = try putValue(a, l.value());
        var r = cbor.MapBuilder.init(a);
        try r.put("identity", .{ .bytes = recipient });
        try r.put("mail", cbor.cidv(lc));
        try recipients.append(a, r.value());
    }
    std.mem.sort(Value, recipients.items, {}, struct {
        fn lt(_: void, x: Value, y: Value) bool {
            return std.mem.order(u8, Value.bytesOf(x.get("identity")) orelse "", Value.bytesOf(y.get("identity")) orelse "") == .lt;
        }
    }.lt);
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("mailbox"));
    try root.put("recipients", .{ .array = recipients.items });
    const rc = try putValue(a, root.value());
    if (sk.advance(head_name.ptr, head_name.len, rc.ptr, @intCast(rc.len)) < 0) return failed();
}
