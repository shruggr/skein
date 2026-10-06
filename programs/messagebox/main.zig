//! messagebox (#40): the BRC-33 messagebox inside the instance, to the
//! persistence rules — messages are state, nothing else is.
//!
//! Called by the front door (its routes; a handler gets {caller, body,
//! contentType, session, …} and answers {status, type, body, admit?}):
//!   sendMessage          a message for this instance or for the identity it
//!                        keeps a mailbox for → one entry to admit: the `mail`
//!                        record {kind: "mail", op: "put", sender (the
//!                        session's identity), recipient, box, body: <cid>,
//!                        json?, session: {payload, signature, nonce,
//!                        yourNonce}} and its body — or, for a BRC-231 message
//!                        that carries `nonce` (and `subject?`), another
//!                        instance's emit (#70) delivered on its own session,
//!                        kept as the record it emitted ({…, subject?, nonce},
//!                        no session: #126 step 4), so both sides know it by
//!                        one CID. A message carrying a `signature` is refused
//!                        (the session is the proof). Nothing is written if it is
//!                        refused. Accepted when a subscription takes it —
//!                        (sender, box) for this instance's own boxes, or a
//!                        reply to a message this instance sent that sender;
//!                        a subscription to this program for its owner's (a
//!                        mailbox exists only where one is subscribed)
//!   listMessages         a read of the caller's mailbox: nothing is written
//!                        (CBOR: each with `message`, its mail record as kept)
//!   acknowledgeMessage   one entry moving the reader's pointer (an `ack`
//!                        event in `:ack`); the records stay in the log
//! Stepped:
//!   a message's delivery thread (#70: args {message, transport: "mailbox"},
//!     launched by the kernel for an emit to a mailbox recipient) → deliver.zig
//!   a `mail` message routed here by a subscription → kept in the mailbox
//!   an `ack` event (box `:ack`) → the reader's pointer moves
//!
//! State: the head `mailbox` names {kind: "mailbox", lists: [{recipient, box,
//! list: <cid>}]} (sorted), each {kind: "mail-list", recipient, box, acked:
//! <count>, messages: [{id: <mail cid>, at}]} — the messages not yet
//! acknowledged, in arrival order. The message records themselves are the
//! log's and stay there. An instance's own subscribed boxes keep no list:
//! admission is the acknowledgement, the log is the queue.
const std = @import("std");
const cbor = @import("cbor");
const cid = cbor.cidm;
const sk = @import("sk");
const dagjson = @import("dagjson");
const deliver = @import("deliver.zig");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const ACK_BOX = ":ack";
const MAILBOX = "mailbox";

pub fn main() u8 {
    return sk.main("messagebox", run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const kind = Value.str(in.get("kind")) orelse "";
    if (eql(u8, kind, "step")) return step(a, in);
    if (!eql(u8, kind, "call")) return sk.report("the messagebox is called or stepped");
    const func = Value.str(in.get("fn")) orelse "";
    const arg = cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "") catch return sk.report("the argument is not dag-cbor");
    const r: Resp = if (eql(u8, func, "sendMessage"))
        try sendMessage(a, in, arg)
    else if (eql(u8, func, "listMessages"))
        try listMessages(a, in, arg)
    else if (eql(u8, func, "acknowledgeMessage"))
        try acknowledgeMessage(a, in, arg)
    else
        return sk.report("unknown fn");
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

fn ownerKey(in: Value) []const u8 {
    return Value.bytesOf(in.get("owner")) orelse "";
}

/// The first `mailbox` dispatch row for (sender, box), as the kernel routes (#77, dispatch.zig forMail):
/// its program's CID, or null for a kernel row (an admin box: the message is taken, by the kernel).
fn route(in: Value, sender: []const u8, box: []const u8) ?[]const u8 {
    const rs = in.get("dispatch") orelse return null;
    if (rs != .array) return null;
    for (rs.array) |r| {
        if (!eql(u8, Value.str(r.get("transport")) orelse "", "mailbox")) continue;
        const addr = Value.str(r.get("address")) orelse continue;
        if (!eql(u8, addr, "*") and !eql(u8, addr, box)) continue;
        const s = r.get("sender") orelse continue;
        if (Value.str(s)) |t| {
            if (!eql(u8, t, "*")) continue;
        } else if (!eql(u8, Value.bytesOf(s) orelse "", sender)) continue;
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

    // Acceptance: a mailbox exists only where a subscription takes the message.
    const me = selfKey(in);
    const mine = eql(u8, recipient, me);
    if (mine) {
        const reply = isReplyTo(a, value, sender) catch false;
        if (route(in, sender, box) == null and !reply) return failure(a, rb.cbor, 403, "ERR_NOT_SUBSCRIBED", "This instance takes no messages from you in that box.");
    } else {
        const keeper = sk.program(in, "messagebox") orelse "";
        const h = route(in, sender, box) orelse "";
        if (!eql(u8, recipient, ownerKey(in)) or !eql(u8, h, keeper)) return failure(a, rb.cbor, 403, "ERR_ACCOUNT_REQUIRED", "No mailbox for that recipient here.");
    }

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
    // A replayed request is the same record: nothing to admit again.
    if (try sk.getOpt(a, id) != null) return .{ .status = 200, .cbor = rb.cbor, .body = ok.value() };
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

// ---------------------------------------------------------------- the mailbox

const List = struct { recipient: []const u8, box: []const u8, cid: []const u8 };

fn lists(a: Allocator) ![]List {
    const root = (try sk.head(a, MAILBOX)) orelse return &.{};
    const r = try sk.get(a, root);
    var out: std.ArrayList(List) = .empty;
    if (r.get("lists")) |ls| if (ls == .array) for (ls.array) |x| try out.append(a, .{
        .recipient = Value.bytesOf(x.get("recipient")) orelse continue,
        .box = Value.str(x.get("box")) orelse continue,
        .cid = Value.cidOf(x.get("list")) orelse continue,
    });
    return out.items;
}

fn listMessages(a: Allocator, _: Value, arg: Value) !Resp {
    const rb = try requestBody(a, arg);
    const body = rb.v orelse return failure(a, rb.cbor, 400, "ERR_BAD_BODY", "The body is not dag-cbor or JSON.");
    const box = Value.str(body.get("messageBox")) orelse return failure(a, rb.cbor, 400, "ERR_MESSAGEBOX_REQUIRED", "Please provide the name of a valid MessageBox!");
    // A caller lists only what is addressed to its own key.
    const caller = Value.bytesOf(arg.get("caller")) orelse return failure(a, rb.cbor, 401, "ERR_AUTH_REQUIRED", "listMessages needs an authenticated caller");
    var out: std.ArrayList(Value) = .empty;
    for (try lists(a)) |l| {
        if (!eql(u8, l.recipient, caller) or !eql(u8, l.box, box)) continue;
        const list = try sk.get(a, l.cid);
        const ms = list.get("messages") orelse continue;
        if (ms != .array) continue;
        for (ms.array) |x| {
            const id = Value.cidOf(x.get("id")) orelse continue;
            const rec = try sk.get(a, id);
            const bc = Value.cidOf(rec.get("body")) orelse continue;
            const bytes = try sk.getBytes(a, bc);
            const sender = Value.bytesOf(rec.get("sender")) orelse continue;
            var m = cbor.MapBuilder.init(a);
            try m.put("messageId", cbor.string(try cid.format(a, id)));
            if (rb.cbor) {
                try m.put("body", .{ .bytes = bytes });
                try m.put("sender", .{ .bytes = sender });
                // The message itself, its record as kept (its id is that record's CID).
                try m.put("message", rec);
            } else {
                // {message: <the body as DAG-JSON>}, as text: the stock client unwraps `message`.
                var w = cbor.MapBuilder.init(a);
                try w.put("message", try cbor.decode(a, bytes));
                try m.put("body", cbor.string(try dagjson.encode(a, w.value())));
                try m.put("sender", cbor.string(try sk.hex(a, sender)));
                const at = try isoTime(a, Value.intOf(x.get("at")) orelse 0);
                try m.put("createdAt", cbor.string(at));
                try m.put("updatedAt", cbor.string(at));
            }
            try out.append(a, m.value());
        }
    }
    var r = cbor.MapBuilder.init(a);
    try r.put("status", cbor.string("success"));
    try r.put("messages", .{ .array = out.items });
    return .{ .status = 200, .cbor = rb.cbor, .body = r.value() };
}

fn acknowledgeMessage(a: Allocator, _: Value, arg: Value) !Resp {
    const rb = try requestBody(a, arg);
    const body = rb.v orelse return failure(a, rb.cbor, 400, "ERR_BAD_BODY", "The body is not dag-cbor or JSON.");
    const caller = Value.bytesOf(arg.get("caller")) orelse return failure(a, rb.cbor, 401, "ERR_AUTH_REQUIRED", "acknowledgeMessage needs an authenticated caller");
    const ids = body.get("messageIds") orelse return failure(a, rb.cbor, 400, "ERR_INVALID_MESSAGE_ID", "Message IDs must be formatted as an array of strings!");
    if (ids != .array or ids.array.len == 0) return failure(a, rb.cbor, 400, "ERR_INVALID_MESSAGE_ID", "Message IDs must be formatted as an array of strings!");
    // Only ids in the caller's own lists, not yet acknowledged.
    var mine: std.ArrayList([]const u8) = .empty;
    for (try lists(a)) |l| {
        if (!eql(u8, l.recipient, caller)) continue;
        const list = try sk.get(a, l.cid);
        if (list.get("messages")) |ms| if (ms == .array) for (ms.array) |x| if (Value.cidOf(x.get("id"))) |c| try mine.append(a, c);
    }
    var found: std.ArrayList(Value) = .empty;
    for (ids.array) |x| {
        const s = Value.str(x) orelse return failure(a, rb.cbor, 400, "ERR_INVALID_MESSAGE_ID", "Message IDs must be formatted as an array of strings!");
        const c = cid.parse(a, s) catch continue;
        for (mine.items) |m| if (eql(u8, m, c)) {
            try found.append(a, cbor.cidv(c));
            break;
        };
    }
    if (found.items.len == 0) return failure(a, rb.cbor, 400, "ERR_INVALID_ACKNOWLEDGMENT", "Message not found!");
    var ev = cbor.MapBuilder.init(a);
    try ev.put("kind", cbor.string("ack"));
    try ev.put("reader", .{ .bytes = caller });
    try ev.put("ids", .{ .array = found.items });
    try ev.put("session", arg.get("session"));
    var e = cbor.MapBuilder.init(a);
    try e.put("event", ev.value());
    try e.put("box", cbor.string(ACK_BOX));
    const admit = try a.alloc(Value, 1);
    admit[0] = e.value();
    var ok = cbor.MapBuilder.init(a);
    try ok.put("status", cbor.string("success"));
    return .{ .status = 200, .cbor = rb.cbor, .body = ok.value(), .admit = .{ .array = admit } };
}

fn isoTime(a: Allocator, ms: i128) ![]const u8 {
    const secs: u64 = @intCast(@max(0, @divFloor(ms, 1000)));
    const es = std.time.epoch.EpochSeconds{ .secs = secs };
    const day = es.getEpochDay().calculateYearDay();
    const md = day.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.allocPrint(a, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{ day.year, md.month.numeric(), md.day_index + 1, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute(), @as(u64, @intCast(@mod(ms, 1000))) });
}

// ---------------------------------------------------------------- the writes (a step)

fn step(a: Allocator, in: Value) !void {
    const args = in.get("args") orelse return sk.report("no args");
    // #70: a message's delivery thread (the mailbox transport's outbound middleware).
    if (eql(u8, Value.str(args.get("transport")) orelse "", "mailbox")) return deliver.step(a, in);
    const at = Value.intOf(in.get("at")) orelse 0;
    var ls = std.ArrayList(List).fromOwnedSlice(try a.dupe(List, try lists(a)));
    if (Value.cidOf(args.get("message"))) |id| {
        // A message routed here: kept for its recipient, in its box.
        const rec = try sk.get(a, id);
        const recipient = Value.bytesOf(rec.get("recipient")) orelse return sk.report("not a message record");
        const box = Value.str(rec.get("box")) orelse return sk.report("not a message record");
        var idx: ?usize = null;
        for (ls.items, 0..) |l, i| if (eql(u8, l.recipient, recipient) and eql(u8, l.box, box)) {
            idx = i;
        };
        var messages: std.ArrayList(Value) = .empty;
        var acked: i128 = 0;
        if (idx) |i| {
            const list = try sk.get(a, ls.items[i].cid);
            acked = Value.intOf(list.get("acked")) orelse 0;
            if (list.get("messages")) |ms| if (ms == .array) for (ms.array) |x| {
                if (eql(u8, Value.cidOf(x.get("id")) orelse "", id)) return; // already kept
                try messages.append(a, x);
            };
        }
        var m = cbor.MapBuilder.init(a);
        try m.put("id", cbor.cidv(id));
        try m.put("at", cbor.int(at));
        try messages.append(a, m.value());
        const c = try saveList(a, recipient, box, acked, messages.items);
        if (idx) |i| ls.items[i].cid = c else try ls.append(a, .{ .recipient = recipient, .box = box, .cid = c });
        return saveRoot(a, ls.items);
    }
    const ev = Value.cidOf(args.get("event")) orelse return sk.report("the messagebox is stepped on a message or an `:ack` event");
    const rec = try sk.get(a, ev);
    if (!eql(u8, Value.str(rec.get("kind")) orelse "", "ack")) return sk.report("not an ack record");
    const reader = Value.bytesOf(rec.get("reader")) orelse return sk.report("not an ack record");
    const ids = rec.get("ids") orelse return sk.report("not an ack record");
    var changed = false;
    for (ls.items) |*l| {
        if (!eql(u8, l.recipient, reader)) continue;
        const list = try sk.get(a, l.cid);
        var acked = Value.intOf(list.get("acked")) orelse 0;
        var kept: std.ArrayList(Value) = .empty;
        if (list.get("messages")) |ms| if (ms == .array) for (ms.array) |x| {
            const id = Value.cidOf(x.get("id")) orelse "";
            var gone = false;
            for (ids.array) |i| if (i == .cid and eql(u8, i.cid, id)) {
                gone = true;
            };
            if (gone) acked += 1 else try kept.append(a, x);
        };
        if (kept.items.len == (if (list.get("messages")) |ms| ms.array.len else 0)) continue;
        l.cid = try saveList(a, l.recipient, l.box, acked, kept.items);
        changed = true;
    }
    if (changed) try saveRoot(a, ls.items);
}

fn saveList(a: Allocator, recipient: []const u8, box: []const u8, acked: i128, messages: []const Value) ![]const u8 {
    var l = cbor.MapBuilder.init(a);
    try l.put("kind", cbor.string("mail-list"));
    try l.put("recipient", .{ .bytes = recipient });
    try l.put("box", cbor.string(box));
    try l.put("acked", cbor.int(acked));
    try l.put("messages", .{ .array = messages });
    return sk.put(a, l.value());
}

fn saveRoot(a: Allocator, ls: []List) !void {
    std.mem.sort(List, ls, {}, struct {
        fn lt(_: void, x: List, y: List) bool {
            return switch (std.mem.order(u8, x.recipient, y.recipient)) {
                .lt => true,
                .gt => false,
                .eq => std.mem.order(u8, x.box, y.box) == .lt,
            };
        }
    }.lt);
    const arr = try a.alloc(Value, ls.len);
    for (ls, 0..) |l, i| {
        var e = cbor.MapBuilder.init(a);
        try e.put("recipient", .{ .bytes = l.recipient });
        try e.put("box", cbor.string(l.box));
        try e.put("list", cbor.cidv(l.cid));
        arr[i] = e.value();
    }
    var r = cbor.MapBuilder.init(a);
    try r.put("kind", cbor.string("mailbox"));
    try r.put("lists", .{ .array = arr });
    try sk.advance(MAILBOX, try sk.put(a, r.value()));
}
