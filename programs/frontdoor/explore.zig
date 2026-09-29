//! The explorer's read route (#40): the instance's log, threads, heads and
//! records as JSON, answered from the committed state the call sees (the
//! kernel's index maps, kernel-zig index.zig, walked as Merkle search trees
//! through `get`). A route handler: the stock routes put it at the prefix
//! `/explore` with `read: "explore"`, so only a caller the reads table allows
//! (the stock reads: the owner) gets an answer, and nothing it does is written.
//!
//!   GET /explore                       {state, log, cursor, heads: {name: cid}}
//!   GET /explore/log?before=n&limit=k  {entries: [{n, entry, record}]}  newest first (k ≤ 200, default 20)
//!   GET /explore/threads?limit=k       {threads: [{at, origin}]}  newest first
//!   GET /explore/thread/<origin>     {chain: {tip, seq, kind?}, updates: [{seq, update, record}]}
//!   GET /explore/head/<name>           {name, tree}
//!   GET /explore/record/<cid>          the record as DAG-JSON (a block in another codec: its bytes)
//! Every value is DAG-JSON: a link is {"/": "<cid>"}, bytes {"/": {"bytes": "<base64>"}}.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const dagjson = @import("dagjson");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;
const cidm = cbor.cidm;

pub const Answer = struct { status: u64, body: []const u8 };

fn json(a: Allocator, v: Value) !Answer {
    return .{ .status = 200, .body = try dagjson.encode(a, v) };
}

fn notFound(what: []const u8) Answer {
    _ = what;
    return .{ .status = 404, .body = "{\"status\":\"error\",\"code\":\"ERR_NOT_FOUND\",\"description\":\"not in this instance\"}" };
}

fn bad(msg: []const u8) Answer {
    _ = msg;
    return .{ .status = 400, .body = "{\"status\":\"error\",\"code\":\"ERR_BAD_REQUEST\",\"description\":\"bad explore path or query\"}" };
}

/// One query parameter's value from `?a=1&b=2` (no decoding: the values here are numbers).
fn param(query: []const u8, name: []const u8) ?[]const u8 {
    const q = if (std.mem.startsWith(u8, query, "?")) query[1..] else query;
    var it = std.mem.splitScalar(u8, q, '&');
    while (it.next()) |kv| {
        const i = std.mem.indexOfScalar(u8, kv, '=') orelse continue;
        if (eql(u8, kv[0..i], name)) return kv[i + 1 ..];
    }
    return null;
}

// ---------------------------------------------------------------- the maps (kernel-zig mst.zig's nodes)

/// A node: [left, [[key, value, right] …]].
const Node = struct { left: ?[]const u8, entries: []const Value };

fn node(a: Allocator, c: []const u8) !Node {
    const v = try sk.get(a, c);
    if (v != .array or v.array.len != 2 or v.array[1] != .array) return error.BadNode;
    return .{ .left = Value.cidOf(v.array[0]), .entries = v.array[1].array };
}

fn keyOf(e: Value) []const u8 {
    return Value.bytesOf(e.array[0]) orelse "";
}

fn less(x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

const KV = struct { key: []const u8, value: Value };

/// The pairs with lo ≤ key < hi (either bound optional), in key order.
fn range(a: Allocator, root: ?[]const u8, lo: ?[]const u8, hi: ?[]const u8, out: *std.ArrayList(KV)) !void {
    const c = root orelse return;
    const n = try node(a, c);
    for (n.entries, 0..) |e, i| {
        const k = keyOf(e);
        // The gap before this key holds keys below it: worth a look if the range starts below it.
        const gap = if (i == 0) n.left else Value.cidOf(n.entries[i - 1].array[2]);
        if (lo == null or less(lo.?, k)) try range(a, gap, lo, hi, out);
        if (hi != null and !less(k, hi.?)) return;
        if (lo == null or !less(k, lo.?)) try out.append(a, .{ .key = k, .value = e.array[1] });
    }
    const last = if (n.entries.len == 0) n.left else Value.cidOf(n.entries[n.entries.len - 1].array[2]);
    try range(a, last, lo, hi, out);
}

/// Up to `limit` pairs with key < hi, from the greatest down.
fn below(a: Allocator, root: ?[]const u8, hi: ?[]const u8, limit: usize, out: *std.ArrayList(KV)) !void {
    const c = root orelse return;
    if (out.items.len >= limit) return;
    const n = try node(a, c);
    var i = n.entries.len;
    while (i > 0) {
        i -= 1;
        const e = n.entries[i];
        const k = keyOf(e);
        if (hi == null or less(k, hi.?)) {
            try below(a, Value.cidOf(e.array[2]), hi, limit, out);
            if (out.items.len >= limit) return;
            try out.append(a, .{ .key = k, .value = e.array[1] });
            if (out.items.len >= limit) return;
        }
    }
    try below(a, n.left, hi, limit, out);
}

fn lookup(a: Allocator, root: ?[]const u8, key: []const u8) !?Value {
    var out: std.ArrayList(KV) = .empty;
    const hi = try std.mem.concat(a, u8, &.{ key, &.{0} });
    try range(a, root, key, hi, &out);
    for (out.items) |kv| if (eql(u8, kv.key, key)) return kv.value;
    return null;
}

/// A number as the index keys it: 8 bytes big-endian, the sign bit flipped.
fn be64(a: Allocator, n: i64) ![]u8 {
    const b = try a.alloc(u8, 8);
    std.mem.writeInt(u64, b[0..8], @as(u64, @bitCast(n)) ^ (1 << 63), .big);
    return b;
}

fn unbe64(b: []const u8) i64 {
    return @bitCast(std.mem.readInt(u64, b[0..8], .big) ^ (1 << 63));
}

/// A string as the index keys it: uvarint length, then the bytes.
fn strKey(a: Allocator, s: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    var v: u64 = s.len;
    while (v >= 0x80) : (v >>= 7) try out.append(a, @as(u8, @truncate(v)) | 0x80);
    try out.append(a, @truncate(v));
    try out.appendSlice(a, s);
    return out.items;
}

fn unStrKey(k: []const u8) []const u8 {
    var pos: usize = 0;
    _ = cidm.readUvarint(k, &pos) catch return k;
    return k[pos..];
}

// ---------------------------------------------------------------- the pages

/// The record at a CID as a value: dag-cbor decoded, any other block as its bytes.
fn record(a: Allocator, c: []const u8) !?Value {
    const bytes = sk.getBytes(a, c) catch |err| {
        if (err == error.ImportFailed and std.mem.startsWith(u8, sk.lastError(), "not found")) return null;
        return err;
    };
    if (cidm.codecOf(c) == 0x71) return cbor.decode(a, bytes) catch Value{ .bytes = bytes };
    return .{ .bytes = bytes };
}

fn index(st: Value, name: []const u8) ?[]const u8 {
    const ix = st.get("index") orelse return null;
    return Value.cidOf(ix.get(name));
}

/// The handler: the front door's argument (`route` the path under the instance) and the call's input (`state`).
pub fn explore(a: Allocator, in: Value, req: Value) !Answer {
    const route = Value.str(req.get("route")) orelse "/explore";
    const query = Value.str(req.get("query")) orelse "";
    const rest = std.mem.trimEnd(u8, if (std.mem.startsWith(u8, route, "/explore")) route["/explore".len..] else route, "/");
    const state = Value.cidOf(in.get("state")) orelse return json(a, .null);
    const st = try sk.get(a, state);

    if (rest.len == 0) {
        var heads: std.ArrayList(KV) = .empty;
        try range(a, Value.cidOf(st.get("heads")), null, null, &heads);
        var hm = cbor.MapBuilder.init(a);
        for (heads.items) |kv| try hm.put(unStrKey(kv.key), kv.value);
        var m = cbor.MapBuilder.init(a);
        try m.put("state", .{ .cid = state });
        try m.put("log", st.get("log"));
        try m.put("cursor", st.get("cursor"));
        try m.put("heads", hm.value());
        return json(a, m.value());
    }
    if (eql(u8, rest, "/log")) {
        const limit = @min(200, std.fmt.parseInt(usize, param(query, "limit") orelse "20", 10) catch return bad("limit"));
        const hi: ?[]const u8 = if (param(query, "before")) |b| try be64(a, std.fmt.parseInt(i64, b, 10) catch return bad("before")) else null;
        var kvs: std.ArrayList(KV) = .empty;
        try below(a, index(st, "log"), hi, limit, &kvs);
        const items = try a.alloc(Value, kvs.items.len);
        for (kvs.items, items) |kv, *it| {
            var m = cbor.MapBuilder.init(a);
            try m.put("n", cbor.int(unbe64(kv.key)));
            try m.put("entry", kv.value);
            if (Value.cidOf(kv.value)) |c| try m.put("record", try record(a, c));
            it.* = m.value();
        }
        var m = cbor.MapBuilder.init(a);
        try m.put("entries", .{ .array = items });
        return json(a, m.value());
    }
    if (eql(u8, rest, "/threads")) {
        // The `threads` map: at ‖ origin → null; newest first.
        const limit = @min(200, std.fmt.parseInt(usize, param(query, "limit") orelse "20", 10) catch return bad("limit"));
        var kvs: std.ArrayList(KV) = .empty;
        try below(a, index(st, "threads"), null, limit, &kvs);
        const items = try a.alloc(Value, kvs.items.len);
        for (kvs.items, items) |kv, *it| {
            var m = cbor.MapBuilder.init(a);
            try m.put("at", cbor.int(unbe64(kv.key[0..8])));
            try m.put("origin", .{ .cid = kv.key[8..] });
            it.* = m.value();
        }
        var m = cbor.MapBuilder.init(a);
        try m.put("threads", .{ .array = items });
        return json(a, m.value());
    }
    if (std.mem.startsWith(u8, rest, "/thread/")) {
        const origin = cidm.parse(a, rest["/thread/".len..]) catch return bad("cid");
        const chain = try lookup(a, index(st, "chains"), origin) orelse return notFound("thread");
        var kvs: std.ArrayList(KV) = .empty;
        const hi = try std.mem.concat(a, u8, &.{ origin, &([_]u8{0xff} ** 9) });
        try range(a, index(st, "updates"), origin, hi, &kvs);
        var ups: std.ArrayList(Value) = .empty;
        for (kvs.items) |kv| {
            if (kv.key.len != origin.len + 8 or !std.mem.startsWith(u8, kv.key, origin)) continue;
            var m = cbor.MapBuilder.init(a);
            try m.put("seq", cbor.int(unbe64(kv.key[origin.len..])));
            try m.put("update", kv.value);
            if (Value.cidOf(kv.value)) |c| try m.put("record", try record(a, c));
            try ups.append(a, m.value());
        }
        var m = cbor.MapBuilder.init(a);
        try m.put("origin", .{ .cid = origin });
        try m.put("chain", chain);
        try m.put("updates", .{ .array = ups.items });
        return json(a, m.value());
    }
    if (std.mem.startsWith(u8, rest, "/head/")) {
        const name = rest["/head/".len..];
        const tree = try lookup(a, Value.cidOf(st.get("heads")), try strKey(a, name)) orelse return notFound("head");
        var m = cbor.MapBuilder.init(a);
        try m.put("name", cbor.string(name));
        try m.put("tree", tree);
        return json(a, m.value());
    }
    if (std.mem.startsWith(u8, rest, "/record/")) {
        const c = cidm.parse(a, rest["/record/".len..]) catch return bad("cid");
        const v = try record(a, c) orelse return notFound("record");
        return json(a, v);
    }
    return notFound("page");
}
