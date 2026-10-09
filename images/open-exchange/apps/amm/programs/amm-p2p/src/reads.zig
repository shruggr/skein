//! The pages' reads and the holders' listing requests (skein-amm 0.9.0, David Case 2026-10-09).
//! Pure: over a store, the chain state and maps (main.zig wires the VM).
//!
//! - **Listing requests** (`requestListing`): a holder asks this exchange to list a token, a
//!   message `{fn: "request", args: {tokenId}}` in the box `amm/requests` from anyone; recorded
//!   under the head `amm/requests` (`{kind: "amm-requests", requests: <map: tokenId → record>}`,
//!   each record `{tokenId, from, at}`, the latest per token). Nothing else runs. The read route
//!   `/requests` (filter `requests`) lists them, newest first, less the tokens registered already
//!   (the engine's set: a registration settles a request).
//! - **Spends** (`/spends?outpoint=<txid>.<vout>`, filter `spends`): what the chain state says of
//!   an outpoint — the LP page reads its claim (spent: the validator rescinded, so Close) and
//!   follows its pool from the deploy's outpoint to the current pool output (each spender's
//!   output 0 while it is a pool) — `{outpoint, spentBy?, current?, hops, closed}`. The chain
//!   app's `chain/state` (its `spent` map), read only, as the overlay reads it.
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");
const pool = @import("pool");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const Chain = w.state.State;
const Transaction = w.bsvz.transaction.Transaction;
const eql = std.mem.eql;

pub const requests_head = "amm/requests";
pub const requests_box = "amm/requests";
pub const requests_kind = "amm-requests";

/// A token id as the pages write it: `<txid>_<vout>` (BRC-207's assetId), any form parsed.
pub fn tokenIdText(a: Allocator, text: []const u8) ![]const u8 {
    const id = mandala.name.tokenIdOfString(text) orelse return error.BadTokenId;
    return std.fmt.allocPrint(a, "{s}_{d}", .{ &w.header.toHex(id.txid), id.vout });
}

/// The requests record's map, loaded from the head's record (null: none yet).
pub fn requestsMap(a: Allocator, s: w.store.Store, rec: ?Value) !w.store.Map {
    const maps = try w.store.Maps.create(a, s);
    const root = if (rec) |r| (if (eql(u8, r.getText("kind") orelse "", requests_kind)) r.getCid("requests") else return error.BadState) else null;
    return maps.map(root);
}

/// Record a holder's request for `token_id` (any form) from `from` at `at`: → the new head record.
pub fn record(a: Allocator, s: w.store.Store, prev: ?Value, token_id: []const u8, from: []const u8, at: u64) !Value {
    var m = try requestsMap(a, s, prev);
    const id = try tokenIdText(a, token_id);
    const rc = try s.putValue(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "tokenId", .value = .{ .text = id } },
        .{ .key = "from", .value = .{ .bytes = from } },
        .{ .key = "at", .value = .{ .uint = at } },
    }) });
    try m.putLink(id, rc);
    try m.flush();
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = requests_kind } },
        .{ .key = "requests", .value = if (m.root) |r| .{ .cid = r } else .null },
    }) };
}

pub const Request = struct { token_id: []const u8, from: []const u8, at: u64 };

/// The requests, newest first, less the tokens whose topic is in `registered`.
pub fn list(a: Allocator, s: w.store.Store, rec: ?Value, registered: []const []const u8) ![]Request {
    var m = try requestsMap(a, s, rec);
    var out: std.ArrayList(Request) = .empty;
    for (try m.prefixed(&.{})) |kv| {
        if (kv.value != .cid) continue;
        const r = try s.getValue(a, kv.value.cid);
        const id = r.getText("tokenId") orelse continue;
        const topic = try std.fmt.allocPrint(a, "tm_mandala_{s}", .{id});
        const settled = for (registered) |t| {
            if (eql(u8, t, topic)) break true;
        } else false;
        if (settled) continue;
        try out.append(a, .{ .token_id = id, .from = r.getBytes("from") orelse "", .at = r.getUint("at") orelse 0 });
    }
    std.mem.sort(Request, out.items, {}, struct {
        fn f(_: void, x: Request, y: Request) bool {
            return x.at > y.at;
        }
    }.f);
    return out.items;
}

/// The `/requests` answer's JSON: `[{tokenId, from, at}]`.
pub fn requestsJson(a: Allocator, rs: []const Request) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginArray();
    for (rs) |r| {
        try jw.beginObject();
        try jw.objectField("tokenId");
        try jw.write(r.token_id);
        try jw.objectField("from");
        try jw.write(try hexOf(a, r.from));
        try jw.objectField("at");
        try jw.write(r.at);
        try jw.endObject();
    }
    try jw.endArray();
    return out.written();
}

fn hexOf(a: Allocator, b: []const u8) ![]const u8 {
    const digits = "0123456789abcdef";
    const out = try a.alloc(u8, b.len * 2);
    for (b, 0..) |x, i| {
        out[2 * i] = digits[x >> 4];
        out[2 * i + 1] = digits[x & 0xf];
    }
    return out;
}

// ---------------------------------------------------------------- spends

pub const Outpoint = struct { txid: [32]u8, vout: u32 };

/// `<txid>.<vout>` or `<txid>_<vout>`.
pub fn parseOutpoint(text: []const u8) ?Outpoint {
    if (text.len < 66 or (text[64] != '.' and text[64] != '_')) return null;
    const txid = w.header.fromHex(text[0..64]) catch return null;
    const vout = std.fmt.parseInt(u32, text[65..], 10) catch return null;
    return .{ .txid = txid, .vout = vout };
}

/// A query string's `outpoint` value.
pub fn queryOutpoint(query: []const u8) ?Outpoint {
    var it = std.mem.splitScalar(u8, std.mem.trimStart(u8, query, "?"), '&');
    while (it.next()) |kv| {
        if (std.mem.startsWith(u8, kv, "outpoint=")) return parseOutpoint(kv["outpoint=".len..]);
    }
    return null;
}

pub const Spend = struct {
    outpoint: Outpoint,
    spent_by: ?[32]u8,
    /// Following pool spends: the current pool output (the outpoint itself when unspent).
    current: ?Outpoint,
    hops: u32,
    /// A pool spent by a transaction that did not continue it (Close).
    closed: bool,
};

fn isPool(script: []const u8) bool {
    const tok = mandala.brc162.decode(script) orelse return false;
    if (tok.role != .value) return false;
    return (pool.parse(tok.lock) catch null) != null;
}

/// What the chain state says of `op`: its spender, and (when `op` is a pool output) the pool's
/// current output, followed spender to spender while each spender's output 0 is a pool.
pub fn spendOf(a: Allocator, ch: *Chain, op: Outpoint) !Spend {
    var out: Spend = .{ .outpoint = op, .spent_by = try ch.spentBy(op.txid, op.vout), .current = null, .hops = 0, .closed = false };
    const raw = (try ch.txRaw(op.txid)) orelse return out;
    const t = Transaction.parse(a, raw) catch return out;
    if (op.vout >= t.outputs.len or !isPool(t.outputs[op.vout].locking_script.bytes)) return out;
    var cur = op;
    var steps: u32 = 0;
    while (steps < 100_000) : (steps += 1) {
        const sp = (try ch.spentBy(cur.txid, cur.vout)) orelse {
            out.current = cur;
            return out;
        };
        const sraw = (try ch.txRaw(sp)) orelse return out;
        const st = Transaction.parse(a, sraw) catch return out;
        if (st.outputs.len == 0 or !isPool(st.outputs[0].locking_script.bytes)) {
            out.closed = true;
            return out;
        }
        cur = .{ .txid = sp, .vout = 0 };
        out.hops += 1;
    }
    return out;
}

/// The `/spends` answer's JSON: `{outpoint, spentBy?, current?, hops, closed}`, outpoints `<txid>.<vout>`.
pub fn spendJson(a: Allocator, s: Spend) ![]const u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    var jw: std.json.Stringify = .{ .writer = &out.writer };
    try jw.beginObject();
    try jw.objectField("outpoint");
    try jw.write(try std.fmt.allocPrint(a, "{s}.{d}", .{ &w.header.toHex(s.outpoint.txid), s.outpoint.vout }));
    if (s.spent_by) |sb| {
        try jw.objectField("spentBy");
        try jw.write(&w.header.toHex(sb));
    }
    if (s.current) |c| {
        try jw.objectField("current");
        try jw.write(try std.fmt.allocPrint(a, "{s}.{d}", .{ &w.header.toHex(c.txid), c.vout }));
    }
    try jw.objectField("hops");
    try jw.write(s.hops);
    try jw.objectField("closed");
    try jw.write(s.closed);
    try jw.endObject();
    return out.written();
}

/// An http answer `{status, type, body}`.
pub fn httpJson(a: Allocator, status: u16, body: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "status", .value = .{ .uint = status } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}
