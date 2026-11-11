//! mail (#40): the skein's own mail in and out, to the persistence rules —
//! messages are state, nothing else is. A messagebox for other keys is an app
//! of its own (shruggr/skein-messagebox): this program keeps no mail for
//! anyone but this instance.
//!
//! Called by the front door (its route `/sendMessage`; a handler gets {caller,
//! body, contentType, session, …} and answers {status, type, body, admit?}):
//!   sendMessage          a message for this instance → one entry to admit: the
//!                        `mail` record {kind: "mail", op: "put", sender (the
//!                        session's identity), recipient, box, body: <cid>,
//!                        json?, session: {payload, signature, nonce,
//!                        yourNonce}} and its body — or, for a BRC-231 message
//!                        that carries `nonce` (and `subject?`), another
//!                        instance's emit (#70) delivered on its own session,
//!                        kept as the record it emitted ({…, subject?, nonce},
//!                        no session: #126 step 4), so both sides know it by
//!                        one CID. A message carrying a `signature` is refused
//!                        (the session is the proof). Nothing is written if it is
//!                        refused. Accepted when a route takes it — its box's
//!                        route (#143: by the box alone; the kernel's gate judges
//!                        the sender when it routes it), or a reply to a message
//!                        this instance sent that sender. Any other recipient:
//!                        403 ERR_ACCOUNT_REQUIRED (this skein keeps no mail for
//!                        another key).
//! Stepped:
//!   a message's delivery thread (#70: args {message, transport: "mailbox"},
//!     launched by the kernel for an emit to a mailbox recipient) → deliver.zig
//!
//! State: none of its own. The instance's own boxes keep no list: admission is
//! the acknowledgement, the log is the queue.
const std = @import("std");
const cbor = @import("cbor");
const cid = cbor.cidm;
const sk = @import("sk");
const dagjson = @import("dagjson");
const deliver = @import("deliver.zig");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("mail", run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "step")) return step(a, in);
    if (!eql(u8, kind, "call")) return sk.report("mail is called or stepped");
    const func = Value.str(in.get("fn")) orelse "";
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("the argument is not dag-cbor");
    const r: Resp = if (eql(u8, func, "sendMessage"))
        try sendMessage(a, in, arg)
    else
        return sk.report("unknown fn (mail answers sendMessage)");
    try sk.answer(a, try r.value(a));
}

// ---------------------------------------------------------------- answers (JSON or BRC-231 dag-cbor, as asked)

const Resp = struct {
    status: u64,
    cbor: bool,
    body: Value,
    admit: ?Value = null,

    fn value(r: Resp, a: Allocator) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("status", cbor.int(r.status));
        try m.put("type", cbor.string(if (r.cbor) "application/cbor" else "application/json"));
        try m.put("body", .{ .bytes = if (r.cbor) try cbor.encode(a, r.body) else try dagjson.encode(a, r.body) });
        try m.put("admit", r.admit);
        return m.value();
    }
};

fn failure(a: Allocator, is_cbor: bool, status: u64, code: []const u8, description: []const u8) !Resp {
    var m = cbor.MapBuilder.init(a);
    try m.put("status", cbor.string("error"));
    try m.put("code", cbor.string(code));
    try m.put("description", cbor.string(description));
    return .{ .status = status, .cbor = is_cbor, .body = m.value() };
}

/// The request body: dag-cbor for application/cbor (BRC-231), else JSON (kept as JSON values: strings stay strings).
fn requestBody(a: Allocator, arg: Value) !struct { cbor: bool, v: ?Value } {
    const ct = Value.str(arg.get("contentType")) orelse "";
    const raw = Value.bytesOf(arg.get("body")) orelse "";
    if (std.ascii.eqlIgnoreCase(ct, "application/cbor")) return .{ .cbor = true, .v = cbor.decode(a, raw) catch null };
    if (raw.len == 0) return .{ .cbor = false, .v = .{ .map = &.{} } };
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, raw, .{}) catch return .{ .cbor = false, .v = null };
    return .{ .cbor = false, .v = try plainJson(a, j) };
}

/// JSON as values, no DAG-JSON reading (a request's own fields).
fn plainJson(a: Allocator, j: std.json.Value) !Value {
    return switch (j) {
        .null => .null,
        .bool => |b| .{ .bool = b },
        .integer => |i| .{ .int = i },
        .float => |f| .{ .float = f },
        .number_string => |s| .{ .string = s },
        .string => |s| .{ .string = s },
        .array => |arr| blk: {
            const out = try a.alloc(Value, arr.items.len);
            for (arr.items, 0..) |x, i| out[i] = try plainJson(a, x);
            break :blk .{ .array = out };
        },
        .object => |o| blk: {
            var list: std.ArrayList(cbor.Entry) = .empty;
            var it = o.iterator();
            while (it.next()) |e| try list.append(a, .{ .key = e.key_ptr.*, .value = try plainJson(a, e.value_ptr.*) });
            break :blk .{ .map = list.items };
        },
    };
}

fn keyOf(a: Allocator, v: ?Value) ?[]const u8 {
    const x = v orelse return null;
    if (Value.bytesOf(x)) |b| return if (sk.isKey(b)) b else null;
    if (Value.str(x)) |s| {
        const b = sk.unhex(a, std.mem.trim(u8, s, " ")) orelse return null;
        return if (sk.isKey(b)) b else null;
    }
    if (x == .array and x.array.len == 1) return keyOf(a, x.array[0]);
    return null;
}

fn selfKey(in: Value) []const u8 {
    const s = in.get("self") orelse return "";
    return Value.bytesOf(s.get("identity")) orelse "";
}

/// The first `mailbox` route for the box, as the kernel routes (#77, #143: dispatch.zig forMail, by the
/// box alone): its program's CID, or "" for a kernel route (an admin box: the message is the kernel's).
fn route(in: Value, box: []const u8) ?[]const u8 {
    const rs = in.get("dispatch") orelse return null;
    if (rs != .array) return null;
    for (rs.array) |r| {
        if (!eql(u8, Value.str(r.get("transport")) orelse "", "mailbox")) continue;
        const addr = Value.str(r.get("address")) orelse continue;
        if (!eql(u8, addr, "*") and !eql(u8, addr, box)) continue;
        return Value.cidOf(r.get("program")) orelse "";
    }
    return null;
}

// ---------------------------------------------------------------- sendMessage

fn sendMessage(a: Allocator, in: Value, arg: Value) !Resp {
    const rb = try requestBody(a, arg);
    const body = rb.v orelse return failure(a, rb.cbor, 400, "ERR_BAD_BODY", "The body is not dag-cbor or JSON.");
    const m = body.get("message") orelse return failure(a, rb.cbor, 400, "ERR_MESSAGE_REQUIRED", "Please provide a valid message to send!");
    const box_raw = Value.str(m.get("messageBox")) orelse "";
    const box = std.mem.trim(u8, box_raw, " ");
    if (box.len == 0 or box[0] == ':') return failure(a, rb.cbor, 400, "ERR_INVALID_MESSAGEBOX", "Invalid message box.");
    const recipient = keyOf(a, m.get("recipient")) orelse return failure(a, rb.cbor, 400, "ERR_INVALID_RECIPIENT_KEY", "Invalid recipient key.");
    const sender = Value.bytesOf(arg.get("caller")) orelse return failure(a, rb.cbor, 401, "ERR_AUTH_REQUIRED", "sendMessage needs an authenticated sender");

    // The body as dag-cbor: the bytes of a BRC-231 request (canonical), or a JSON body read as DAG-JSON.
    const mb = m.get("body") orelse return failure(a, rb.cbor, 400, "ERR_INVALID_MESSAGE_BODY", "Invalid message body.");
    var json = false;
    const value: Value = if (rb.cbor) blk: {
        const b = Value.bytesOf(mb) orelse return failure(a, true, 400, "ERR_INVALID_MESSAGE_BODY", "A BRC-231 body is dag-cbor bytes.");
        const v = cbor.decode(a, b) catch return failure(a, true, 400, "ERR_INVALID_MESSAGE_BODY", "The body is not dag-cbor.");
        const blk2 = try cbor.block(a, v);
        if (!eql(u8, blk2.bytes, b)) return failure(a, true, 400, "ERR_INVALID_MESSAGE_BODY", "The body is not canonical dag-cbor.");
        break :blk v;
    } else blk: {
        json = true;
        if (Value.str(mb)) |text| {
            if (text.len == 0) return failure(a, false, 400, "ERR_INVALID_MESSAGE_BODY", "Invalid message body.");
            break :blk dagjson.decode(a, text) catch Value{ .string = text };
        }
        // A JSON value sent as it is: read as DAG-JSON through its text.
        break :blk dagjson.decode(a, try dagjson.encode(a, mb)) catch mb;
    };
    const blk = try cbor.block(a, value);

    // Acceptance: the skein's own mail only, in a box a route takes (or a reply).
    if (!eql(u8, recipient, selfKey(in))) return failure(a, rb.cbor, 403, "ERR_ACCOUNT_REQUIRED", "No mailbox for that recipient here.");
    const reply = isReplyTo(a, value, sender) catch false;
    if (route(in, box) == null and !reply) return failure(a, rb.cbor, 403, "ERR_NOT_SUBSCRIBED", "This instance takes no messages in that box.");

    var rec = cbor.MapBuilder.init(a);
    try rec.put("kind", cbor.string("mail"));
    try rec.put("op", cbor.string("put"));
    try rec.put("sender", .{ .bytes = sender });
    try rec.put("recipient", .{ .bytes = recipient });
    try rec.put("box", cbor.string(box));
    try rec.put("body", cbor.cidv(blk.cid));
    if (m.get("signature")) |x| if (x != .null) return failure(a, rb.cbor, 400, "ERR_SIGNED_MESSAGE", "A message carries no signature: the session proves who sends it.");
    if (rb.cbor and Value.bytesOf(m.get("nonce")) != null) {
        // #70, #126 step 4: another instance's emit, delivered on its own session — kept as the
        // record it emitted ({…, subject?, nonce}: the emit's own nonce, no session), so both
        // sides know the message by one CID. The session proves who sent it (`sender` is the
        // caller); the request entry it came in holds that proof.
        if (m.get("subject")) |s| if (s != .null) try rec.put("subject", cbor.cidv(Value.cidOf(s) orelse return failure(a, true, 400, "ERR_INVALID_SUBJECT", "The subject is not a CID.")));
        try rec.put("nonce", m.get("nonce"));
    } else {
        if (json) try rec.put("json", .{ .bool = true });
        try rec.put("session", arg.get("session"));
    }
    const id = try cbor.cidOfValue(a, rec.value());
    const id_text = try cid.format(a, id);

    var ok = cbor.MapBuilder.init(a);
    try ok.put("status", cbor.string("success"));
    if (rb.cbor) {
        try ok.put("messageId", cbor.string(id_text));
    } else {
        try ok.put("message", cbor.string("Your message has been sent to 1 recipient(s)."));
        // The stock client checks its own messageId comes back; `id` is the message's id here.
        var one = cbor.MapBuilder.init(a);
        try one.put("recipient", cbor.string(try sk.hex(a, recipient)));
        try one.put("messageId", m.get("messageId") orelse cbor.string(id_text));
        const results = try a.alloc(Value, 1);
        results[0] = one.value();
        try ok.put("results", .{ .array = results });
    }
    try ok.put("id", cbor.string(id_text));
    // Always the entry to admit: the kernel admits a message once (its `unique` map, committed with the
    // entry that admits it — scheduler.zig routeAdmits), so the same record sent again is refused there.
    // Whether the record's block is in the store says nothing: a block is kept the moment it is put,
    // also by an attempt whose entry was never committed (a kill mid-entry), and a re-run must admit.
    var e = cbor.MapBuilder.init(a);
    try e.put("mail", rec.value());
    try e.put("body", .{ .bytes = blk.bytes });
    const admit = try a.alloc(Value, 1);
    admit[0] = e.value();
    return .{ .status = 200, .cbor = rb.cbor, .body = ok.value(), .admit = .{ .array = admit } };
}

/// Whether a body is a reply to a message this instance sent `sender` (its `replyTo` names our record of it).
fn isReplyTo(a: Allocator, body: Value, sender: []const u8) !bool {
    const r = Value.cidOf(body.get("replyTo")) orelse return false;
    const rec = (try sk.getOpt(a, r)) orelse return false;
    if (!eql(u8, Value.str(rec.get("kind")) orelse "", "mail")) return false;
    return eql(u8, Value.bytesOf(rec.get("recipient")) orelse "", sender);
}

// ---------------------------------------------------------------- a step

fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    // #70: a message's delivery thread (the mailbox transport's outbound middleware).
    if (eql(u8, Value.str(args.get("transport")) orelse "", "mailbox")) return deliver.step(a, in);
    return sk.report("mail is stepped only as a message's delivery thread");
}
