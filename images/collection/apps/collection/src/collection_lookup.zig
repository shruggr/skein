//! collection-lookup: the 1Sat collection lookup (shruggr/skein#151),
//! `ls_collection`. It indexes what the collection topics `tm_col_<id>`
//! admit, through the skein-overlay lookup hooks (once per admitted
//! transaction and topic), in one index, the head `<app>/ls_collection`
//! (`spec.index`). A hook for any other topic does nothing.
//!
//! Keys: `coll` and `op` are an outpoint's txid in display order ‖ its index
//! (u32 big-endian), so key order is outpoint order (txid hex, then index);
//! `origin` is an item's mint outpoint, its key the same way.
//!
//!   items      coll ‖ origin → {current: op | null, owner, steps, name?, mintNumber?, rank?, contentType?, map}
//!   outputs    op → {coll, origin, step, kind, owner, listing?: {price, seller, payout}, spender?}
//!   history    origin ‖ step (u32 BE) → {outpoint: op, kind}
//!   listings   coll ‖ op → null                       unspent OrdLock v2 listings
//!   sales      coll ‖ spending txid ‖ op → {type, price, seller, payout, origin}
//!
//! `admitted`: an admitted output an item's satoshi landed in (a retained
//! coin's, by the ordinal rule over the store's source outputs) is the item's
//! next step, classified: out of a listing by its purchase branch `sale`, by
//! its cancel branch `cancel`; else into a listing `listing`; else
//! `transfer`. Any other admitted output that is an item mint of the topic's
//! collection is a new item, step 0, `mint` (the topic checked its signer).
//! The collection's own mint is not an item. `spent` names the coin's
//! spender; a spent listing leaves `listings`, and its spend, classified
//! purchase or cancel (skein-1sat `ordlock.classify`), goes in `sales`; an
//! item whose satoshi did not land in an admitted output has no current
//! outpoint (gone). `rejected` drops the transaction's outputs (and an item
//! it minted) and gives back the coins it spent.
//!
//! An owner is the output's P2PKH address (the inscription's 1SAT_P2PKH, or a
//! bare P2PKH lock), `listed` for an OrdLock v2 listing, else null. Addresses
//! are mainnet's. A listing's `seller` is the cancel key's address, `price`
//! the pay output's satoshis, `payout` its locking script's address when it
//! is P2PKH (else null) and `payoutScript` the script in hex.
//!
//! The four reads, as BRC-24 queries to `ls_collection` and as read routes
//! (`/<app>/collection/<find>`, the query string or a JSON body):
//!
//!   {find: "items", collection, limit?, skip?}      the collection's items, in origin order
//!   {find: "history", origin, limit?, skip?}        one item's chain of custody, mint first
//!   {find: "listings", collection, limit?, skip?}   open listings, in outpoint order
//!   {find: "sales", collection, limit?, skip?}      listing spends, newest first
//!
//! `collection` and `origin` are ids `<txid>_<vout>`; `limit` 1 to 100
//! (default 100), `skip` 0 to 100000 (default 0); any other key, or a value
//! out of shape, is refused. A BRC-24 answer is an output-list, each output
//! with its row as JSON in `context` (an item's output is its current
//! outpoint, else its origin; a history step's its outpoint; a listing's its
//! outpoint; a sale's the listing it spent); a read route answers the rows as
//! a JSON array.
const std = @import("std");
const c = @import("chain");
const lookup = @import("lookup");
const onesat = @import("onesat");
const collection = @import("collection");

const name = collection.name;
const mint = collection.mint;
const ordlock = onesat.ordlock;

const Value = c.cbor.Value;
const CEntry = c.cbor.Entry;
/// An index record (the maps' values).
const MValue = c.store.MValue;
const MEntry = c.store.mst.codec.Entry;
const Allocator = std.mem.Allocator;
const Service = lookup.Service;
const Transaction = c.bsvz.transaction.Transaction;
const eql = std.mem.eql;

pub const service_name = name.service;
/// The index every name of the program reads and writes: `<app>/ls_collection`.
pub const index_name = name.service;

pub const spec: lookup.Spec = .{
    .maps = &.{ "items", "outputs", "history", "listings", "sales" },
    .index = index_name,
    .answer = answer,
    .admitted = admitted,
    .spent = spent,
    .rejected = rejected,
};

pub const max_limit = 100;
pub const max_skip = 100_000;

fn display(txid: [32]u8) [32]u8 {
    var r = txid;
    std.mem.reverse(u8, &r);
    return r;
}

/// An outpoint's key: its txid (internal order) in display order ‖ vout (BE).
pub fn key(txid: [32]u8, vout: u32) [36]u8 {
    return display(txid) ++ c.store.be32(vout);
}

fn keyOf(id: name.Id) [36]u8 {
    return key(id.txid, id.vout);
}

fn outputOf(k: []const u8) lookup.Output {
    return .{ .txid = display(k[0..32].*), .vout = std.mem.readInt(u32, k[32..36], .big) };
}

/// An outpoint key as its id text `<txid>_<vout>`.
fn opText(a: Allocator, k: []const u8) ![]const u8 {
    return std.fmt.allocPrint(a, "{s}_{d}", .{ &std.fmt.bytesToHex(k[0..32].*, .lower), std.mem.readInt(u32, k[32..36], .big) });
}

fn cat(a: Allocator, parts: []const []const u8) ![]u8 {
    return std.mem.concat(a, u8, parts);
}

// ---------------------------------------------------------------- records

/// `m` with `k` set to `v` (added when absent).
fn with(a: Allocator, m: MValue, k: []const u8, v: MValue) !MValue {
    var es: std.ArrayList(MEntry) = .empty;
    var set = false;
    for (m.map) |e| {
        if (eql(u8, e.key, k)) {
            try es.append(a, .{ .key = e.key, .value = v });
            set = true;
        } else try es.append(a, e);
    }
    if (!set) try es.append(a, .{ .key = k, .value = v });
    return .{ .map = es.items };
}

/// `m` without `k`.
fn without(a: Allocator, m: MValue, k: []const u8) !MValue {
    var es: std.ArrayList(MEntry) = .empty;
    for (m.map) |e| if (!eql(u8, e.key, k)) try es.append(a, e);
    return .{ .map = es.items };
}

fn intValue(n: i64) MValue {
    return .{ .int = n };
}

fn intOf(v: ?MValue) ?i64 {
    const n = MValue.intOf(v) orelse return null;
    return std.math.cast(i64, n);
}

fn optText(v: ?[]const u8) MValue {
    return if (v) |t| .{ .string = t } else .null;
}

fn textOf(v: ?MValue) ?[]const u8 {
    const x = v orelse return null;
    return if (x == .string) x.string else null;
}

fn bytesOf(v: ?MValue) ?[]const u8 {
    const x = v orelse return null;
    return if (x == .bytes) x.bytes else null;
}

fn address(a: Allocator, pkh: [20]u8) ![]const u8 {
    return c.bsvz.compat.address.encodeP2pkh(a, .mainnet, .{ .bytes = pkh });
}

/// An output's owner: `listed` for an OrdLock v2 listing, else its P2PKH address, else null.
pub fn ownerOf(a: Allocator, lock: []const u8) !?[]const u8 {
    if (ordlock.decode(lock) != null) return "listed";
    if (onesat.inscription.decode(lock)) |i| if (i.owner) |pkh| return try address(a, pkh);
    if (onesat.script.p2pkh(lock)) |pkh| return try address(a, pkh);
    return null;
}

/// An OrdLock v2 listing's record `{price, seller, payout}` (payout: the pay output's script), or null.
fn listingOf(a: Allocator, lock: []const u8) !?MValue {
    const l = ordlock.decode(lock) orelse return null;
    return .{ .map = try a.dupe(MEntry, &.{
        .{ .key = "price", .value = .{ .int = l.price } },
        .{ .key = "seller", .value = .{ .string = try address(a, l.seller) } },
        .{ .key = "payout", .value = .{ .bytes = l.pay_script } },
    }) };
}

/// The `outputs` record for output `vout` of `tx` as step `step` of item `origin`.
fn outputRecord(a: Allocator, coll: []const u8, origin: []const u8, step: u32, kind: []const u8, lock: []const u8) !MValue {
    var es: std.ArrayList(MEntry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "coll", .value = .{ .bytes = coll } },
        .{ .key = "origin", .value = .{ .bytes = origin } },
        .{ .key = "step", .value = .{ .int = step } },
        .{ .key = "kind", .value = .{ .string = kind } },
        .{ .key = "owner", .value = optText(try ownerOf(a, lock)) },
    });
    if (try listingOf(a, lock)) |l| try es.append(a, .{ .key = "listing", .value = l });
    return .{ .map = es.items };
}

fn historyKey(a: Allocator, origin: []const u8, step: u32) ![]u8 {
    return cat(a, &.{ origin, &c.store.be32(step) });
}

/// The source outputs of a transaction's inputs, read from the store (the topic read them in the
/// submission; the engine holds them: admitted, retained, or ancillary).
const StoreSources = struct {
    a: Allocator,
    s: c.store.Store,
    tx: *const Transaction,

    pub fn sourceOutput(self: StoreSources, i: usize) ?c.bsvz.transaction.Output {
        if (i >= self.tx.inputs.len) return null;
        const prev = self.tx.inputs[i].previous_outpoint;
        const raw = self.s.tryGet(self.a, &c.store.hashCid(.tx, prev.txid.bytes)) orelse return null;
        const src = Transaction.parse(self.a, raw) catch return null;
        if (prev.index >= src.outputs.len) return null;
        return src.outputs[prev.index];
    }
};

// ---------------------------------------------------------------- hooks

fn admitted(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx, outputs_to_admit: []const u32, coins_retained: []const u32) anyerror!void {
    const id = name.idOfTopic(topic) orelse return;
    const ck = keyOf(id);
    var done: std.ArrayList(u32) = .empty;
    const sources: StoreSources = .{ .a = a, .s = svc.store, .tx = &tx.tx };
    for (coins_retained) |vin| {
        if (vin >= tx.tx.inputs.len) return error.BadArgs;
        const prev = tx.tx.inputs[vin].previous_outpoint;
        const pk = key(prev.txid.bytes, prev.index);
        const pe = (try svc.map("outputs").get(&pk)) orelse continue;
        if (!eql(u8, bytesOf(pe.get("coll")) orelse "", &ck)) continue;
        const vout = (try onesat.ordinal.output(&tx.tx, vin, sources)) orelse continue;
        if (std.mem.indexOfScalar(u32, outputs_to_admit, vout) == null) continue;
        try advance(a, svc, &ck, pe, tx, vin, vout);
        try done.append(a, vout);
    }
    for (outputs_to_admit) |vout| {
        if (vout >= tx.tx.outputs.len) return error.BadArgs;
        if (std.mem.indexOfScalar(u32, done.items, vout) != null) continue;
        const claimed = (try mint.claimedCollection(a, &tx.tx, tx.txid, vout)) orelse continue;
        if (!claimed.eql(id)) continue;
        try newItem(a, svc, &ck, tx, vout);
    }
}

fn newItem(a: Allocator, svc: *Service, ck: []const u8, tx: lookup.Tx, vout: u32) !void {
    const lock = tx.tx.outputs[vout].locking_script.bytes;
    const f = (try mint.fieldsOf(a, lock)) orelse return;
    const origin = key(tx.txid, vout);
    const pairs = try a.alloc(MEntry, f.map.pairs.len);
    var n: usize = 0;
    for (f.map.pairs) |p| {
        // The last value of a key wins (MAP `get`).
        for (pairs[0..n]) |*e| {
            if (eql(u8, e.key, p.key)) {
                e.value = .{ .string = p.value };
                break;
            }
        } else {
            pairs[n] = .{ .key = p.key, .value = .{ .string = p.value } };
            n += 1;
        }
    }
    var es: std.ArrayList(MEntry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "current", .value = .{ .bytes = &origin } },
        .{ .key = "owner", .value = optText(try ownerOf(a, lock)) },
        .{ .key = "steps", .value = .{ .int = 1 } },
        .{ .key = "map", .value = .{ .map = pairs[0..n] } },
    });
    if (f.name) |x| try es.append(a, .{ .key = "name", .value = .{ .string = x } });
    if (f.mint_number) |x| try es.append(a, .{ .key = "mintNumber", .value = intValue(x) });
    if (f.rank) |x| try es.append(a, .{ .key = "rank", .value = intValue(x) });
    if (onesat.inscription.decode(lock)) |i| if (i.content_type) |ct| try es.append(a, .{ .key = "contentType", .value = .{ .string = ct } });
    try svc.map("items").put(try cat(a, &.{ ck, &origin }), .{ .map = es.items });
    try svc.map("outputs").put(&origin, try outputRecord(a, ck, &origin, 0, "mint", lock));
    try svc.map("history").put(try historyKey(a, &origin, 0), try historyRecord(a, &origin, "mint"));
    if (ordlock.decode(lock) != null) try svc.map("listings").add(try cat(a, &.{ ck, &origin }));
}

fn historyRecord(a: Allocator, op: []const u8, kind: []const u8) !MValue {
    return .{ .map = try a.dupe(MEntry, &.{
        .{ .key = "outpoint", .value = .{ .bytes = try a.dupe(u8, op) } },
        .{ .key = "kind", .value = .{ .string = kind } },
    }) };
}

/// The item whose coin `pe` is moved by input `vin` into output `vout`: its next step.
fn advance(a: Allocator, svc: *Service, ck: []const u8, pe: MValue, tx: lookup.Tx, vin: u32, vout: u32) !void {
    const origin = bytesOf(pe.get("origin")) orelse return error.BadIndex;
    const ik = try cat(a, &.{ ck, origin });
    const item = (try svc.map("items").get(ik)) orelse return;
    const lock = tx.tx.outputs[vout].locking_script.bytes;
    const from_listing = pe.get("listing") != null;
    const kind: []const u8 = if (from_listing and ordlock.classify(tx.tx.inputs[vin].unlocking_script.bytes) == .purchase)
        "sale"
    else if (from_listing and ordlock.classify(tx.tx.inputs[vin].unlocking_script.bytes) == .cancel)
        "cancel"
    else if (ordlock.decode(lock) != null)
        "listing"
    else
        "transfer";
    const n: u32 = @intCast(intOf(item.get("steps")) orelse return error.BadIndex);
    const op = key(tx.txid, vout);
    try svc.map("history").put(try historyKey(a, origin, n), try historyRecord(a, &op, kind));
    const rec = try outputRecord(a, ck, origin, n, kind, lock);
    try svc.map("outputs").put(&op, rec);
    if (rec.get("listing") != null) try svc.map("listings").add(try cat(a, &.{ ck, &op }));
    var it = try with(a, item, "current", .{ .bytes = try a.dupe(u8, &op) });
    it = try with(a, it, "owner", rec.get("owner").?);
    try svc.map("items").put(ik, try with(a, it, "steps", .{ .int = n + 1 }));
}

fn spent(a: Allocator, svc: *Service, topic: []const u8, outpoint: lookup.Outpoint, spending: lookup.Tx) anyerror!void {
    _ = name.idOfTopic(topic) orelse return;
    const op = key(outpoint.txid, outpoint.vout);
    const v = (try svc.map("outputs").get(&op)) orelse return;
    if (v.get("spender") != null) return;
    try svc.map("outputs").put(&op, try with(a, v, "spender", .{ .bytes = try a.dupe(u8, &spending.txid) }));
    const coll = bytesOf(v.get("coll")) orelse return error.BadIndex;
    const origin = bytesOf(v.get("origin")) orelse return error.BadIndex;
    if (v.get("listing")) |l| {
        _ = try svc.map("listings").remove(try cat(a, &.{ coll, &op }));
        const vin = for (spending.tx.inputs, 0..) |in, i| {
            if (in.previous_outpoint.index == outpoint.vout and eql(u8, &in.previous_outpoint.txid.bytes, &outpoint.txid)) break i;
        } else return error.BadArgs;
        if (ordlock.classify(spending.tx.inputs[vin].unlocking_script.bytes)) |kind| {
            try svc.map("sales").put(try cat(a, &.{ coll, &spending.txid, &op }), .{ .map = try a.dupe(MEntry, &.{
                .{ .key = "type", .value = .{ .string = @tagName(kind) } },
                .{ .key = "price", .value = l.get("price").? },
                .{ .key = "seller", .value = l.get("seller").? },
                .{ .key = "payout", .value = l.get("payout").? },
                .{ .key = "origin", .value = .{ .bytes = origin } },
            }) });
        }
    }
    const ik = try cat(a, &.{ coll, origin });
    const item = (try svc.map("items").get(ik)) orelse return;
    if (!eql(u8, bytesOf(item.get("current")) orelse "", &op)) return;
    // Its satoshi landed in no admitted output: gone.
    try svc.map("items").put(ik, try with(a, try with(a, item, "current", .null), "owner", .null));
}

fn rejected(a: Allocator, svc: *Service, topic: []const u8, tx: lookup.Tx) anyerror!void {
    _ = name.idOfTopic(topic) orelse return;
    // Its outputs vanish, and the items it minted.
    for (0..tx.tx.outputs.len) |vout| {
        const op = key(tx.txid, @intCast(vout));
        const v = (try svc.map("outputs").get(&op)) orelse continue;
        const coll = bytesOf(v.get("coll")) orelse return error.BadIndex;
        const origin = bytesOf(v.get("origin")) orelse return error.BadIndex;
        const n: u32 = @intCast(intOf(v.get("step")) orelse return error.BadIndex);
        _ = try svc.map("listings").remove(try cat(a, &.{ coll, &op }));
        _ = try svc.map("history").remove(try historyKey(a, origin, n));
        _ = try svc.map("outputs").remove(&op);
        const ik = try cat(a, &.{ coll, origin });
        if (n == 0) {
            _ = try svc.map("items").remove(ik);
            continue;
        }
        const item = (try svc.map("items").get(ik)) orelse continue;
        try svc.map("items").put(ik, try with(a, try with(a, try with(a, item, "current", .null), "owner", .null), "steps", .{ .int = n }));
    }
    // What it spent is unspent again.
    for (tx.tx.inputs) |in| {
        const op = key(in.previous_outpoint.txid.bytes, in.previous_outpoint.index);
        const v = (try svc.map("outputs").get(&op)) orelse continue;
        if (!eql(u8, bytesOf(v.get("spender")) orelse "", &tx.txid)) continue;
        try svc.map("outputs").put(&op, try without(a, v, "spender"));
        const coll = bytesOf(v.get("coll")) orelse return error.BadIndex;
        const origin = bytesOf(v.get("origin")) orelse return error.BadIndex;
        if (v.get("listing") != null) {
            try svc.map("listings").add(try cat(a, &.{ coll, &op }));
            _ = try svc.map("sales").remove(try cat(a, &.{ coll, &tx.txid, &op }));
        }
        const ik = try cat(a, &.{ coll, origin });
        const item = (try svc.map("items").get(ik)) orelse continue;
        const n = intOf(v.get("step")) orelse return error.BadIndex;
        var it = try with(a, item, "current", .{ .bytes = try a.dupe(u8, &op) });
        it = try with(a, it, "owner", v.get("owner") orelse .null);
        try svc.map("items").put(ik, try with(a, it, "steps", .{ .int = n + 1 }));
    }
}

// ---------------------------------------------------------------- the reads

pub const Find = enum { items, history, listings, sales };

/// A read, checked: `collection` for items, listings and sales; `origin` for history.
pub const Query = struct {
    find: Find,
    collection: ?name.Id = null,
    origin: ?name.Id = null,
    limit: u64 = max_limit,
    skip: u64 = 0,
};

const QueryError = error{BadQuery};

fn setField(q: *Query, k: []const u8, text: ?[]const u8, n: ?u64) QueryError!void {
    if (eql(u8, k, "collection") or eql(u8, k, "origin")) {
        const id = name.idOfText(text orelse return error.BadQuery) orelse return error.BadQuery;
        if (eql(u8, k, "collection")) q.collection = id else q.origin = id;
    } else if (eql(u8, k, "limit")) {
        const x = n orelse return error.BadQuery;
        if (x < 1 or x > max_limit) return error.BadQuery;
        q.limit = x;
    } else if (eql(u8, k, "skip")) {
        const x = n orelse return error.BadQuery;
        if (x > max_skip) return error.BadQuery;
        q.skip = x;
    } else return error.BadQuery;
}

fn checked(q: Query) QueryError!Query {
    switch (q.find) {
        .history => if (q.origin == null or q.collection != null) return error.BadQuery,
        else => if (q.collection == null or q.origin != null) return error.BadQuery,
    }
    return q;
}

/// A BRC-24 query (the client's JSON as dag-cbor): `{find, collection | origin, limit?, skip?}`.
pub fn parseQuery(v: Value) QueryError!Query {
    if (v != .map) return error.BadQuery;
    const f = v.getText("find") orelse return error.BadQuery;
    var q: Query = .{ .find = std.meta.stringToEnum(Find, f) orelse return error.BadQuery };
    for (v.map) |e| {
        if (eql(u8, e.key, "find")) continue;
        try setField(&q, e.key, if (e.value == .text) e.value.text else null, if (e.value == .uint) e.value.uint else null);
    }
    return checked(q);
}

/// A read route's query: the query string's fields (`limit` / `skip` decimal), then a JSON object
/// body's (its `limit` / `skip` integers).
pub fn parseRequest(a: Allocator, find: Find, query: []const u8, body: []const u8) !Query {
    var q: Query = .{ .find = find };
    var it = std.mem.splitScalar(u8, if (std.mem.startsWith(u8, query, "?")) query[1..] else query, '&');
    while (it.next()) |kv| {
        if (kv.len == 0) continue;
        const i = std.mem.indexOfScalar(u8, kv, '=') orelse return error.BadQuery;
        const v = kv[i + 1 ..];
        try setField(&q, kv[0..i], v, std.fmt.parseInt(u64, v, 10) catch null);
    }
    if (std.mem.trim(u8, body, " \t\r\n").len > 0) {
        const j = std.json.parseFromSliceLeaky(std.json.Value, a, body, .{}) catch return error.BadQuery;
        if (j != .object) return error.BadQuery;
        var jt = j.object.iterator();
        while (jt.next()) |e| {
            const v = e.value_ptr.*;
            try setField(&q, e.key_ptr.*, if (v == .string) v.string else null, if (v == .integer and v.integer >= 0) @intCast(v.integer) else null);
        }
    }
    return checked(q);
}

/// One answer row: the output BRC-24 answers it with, and its JSON.
pub const Row = struct { output: lookup.Output, json: []const u8 };

pub const Item = struct {
    origin: []const u8,
    outpoint: ?[]const u8,
    owner: ?[]const u8,
    name: ?[]const u8,
    mintNumber: ?i64,
    rank: ?i64,
    contentType: ?[]const u8,
    map: std.json.Value,
};

pub const Step = struct { outpoint: []const u8, kind: []const u8 };

pub const Listing = struct {
    outpoint: []const u8,
    origin: []const u8,
    price: u64,
    seller: []const u8,
    payout: ?[]const u8,
    payoutScript: []const u8,
};

pub const Sale = struct {
    outpoint: []const u8,
    origin: []const u8,
    type: []const u8,
    price: u64,
    seller: []const u8,
    payout: ?[]const u8,
    payoutScript: []const u8,
    txid: []const u8,
    height: ?u32,
    time: ?u32,
};

fn json(a: Allocator, v: anytype) ![]const u8 {
    var w: std.Io.Writer.Allocating = .init(a);
    try std.json.Stringify.value(v, .{}, &w.writer);
    return w.written();
}

fn page(comptime T: type, xs: []const T, q: Query) []const T {
    const from: usize = @intCast(@min(q.skip, xs.len));
    return xs[from..@min(xs.len, from + @as(usize, @intCast(q.limit)))];
}

fn payoutOf(a: Allocator, script: []const u8) !?[]const u8 {
    return if (onesat.script.p2pkh(script)) |pkh| try address(a, pkh) else null;
}

fn itemOf(a: Allocator, origin: []const u8, v: MValue) !Item {
    var m: std.json.ObjectMap = .empty;
    if (v.get("map")) |mv| if (mv == .map) for (mv.map) |e| try m.put(a, e.key, .{ .string = textOf(e.value) orelse "" });
    const cur = bytesOf(v.get("current"));
    return .{
        .origin = try opText(a, origin),
        .outpoint = if (cur) |x| try opText(a, x) else null,
        .owner = textOf(v.get("owner")),
        .name = textOf(v.get("name")),
        .mintNumber = intOf(v.get("mintNumber")),
        .rank = intOf(v.get("rank")),
        .contentType = textOf(v.get("contentType")),
        .map = .{ .object = m },
    };
}

/// Where a transaction stands for "newest first": its block height and position from the chain
/// state's proof (null: not mined, the newest), then its key.
pub const Age = struct { key: []const u8, height: ?u32 = null, offset: u64 = 0, time: ?u32 = null };

pub fn newerFirst(_: void, x: Age, y: Age) bool {
    if (x.height == null and y.height != null) return true;
    if (y.height == null and x.height != null) return false;
    if (x.height) |hx| if (hx != y.height.?) return hx > y.height.?;
    if (x.height != null and x.offset != y.offset) return x.offset > y.offset;
    return std.mem.order(u8, x.key, y.key) == .gt;
}

fn ageOf(ch: *lookup.Chain, k: []const u8, txid: [32]u8) !Age {
    const r = (try ch.proofRecord(txid)) orelse return .{ .key = k };
    const block = c.store.bitcoinHash(r.block) orelse return error.BadIndex;
    const h = (try ch.chain().heightOf(block)) orelse return .{ .key = k };
    const hdr = (try ch.chain().at(h)) orelse return .{ .key = k };
    return .{ .key = k, .height = h, .offset = r.pos.offset, .time = std.mem.readInt(u32, hdr.raw[68..72], .little) };
}

/// The rows a read answers, in its order, paged.
pub fn rows(a: Allocator, svc: *Service, ch: *lookup.Chain, q: Query) ![]const Row {
    var out: std.ArrayList(Row) = .empty;
    switch (q.find) {
        .items => {
            const ck = keyOf(q.collection.?);
            for (page(c.store.mst.KV, try svc.map("items").prefixed(&ck), q)) |kv| {
                if (kv.key.len != 72) return error.BadIndex;
                const origin = kv.key[36..72];
                const cur = bytesOf(kv.value.get("current")) orelse origin;
                try out.append(a, .{ .output = outputOf(cur), .json = try json(a, try itemOf(a, origin, kv.value)) });
            }
        },
        .history => {
            const ok = keyOf(q.origin.?);
            for (page(c.store.mst.KV, try svc.map("history").prefixed(&ok), q)) |kv| {
                const op = bytesOf(kv.value.get("outpoint")) orelse return error.BadIndex;
                try out.append(a, .{ .output = outputOf(op), .json = try json(a, Step{ .outpoint = try opText(a, op), .kind = textOf(kv.value.get("kind")) orelse "" }) });
            }
        },
        .listings => {
            const ck = keyOf(q.collection.?);
            for (page(c.store.mst.KV, try svc.map("listings").prefixed(&ck), q)) |kv| {
                if (kv.key.len != 72) return error.BadIndex;
                const op = kv.key[36..72];
                const v = (try svc.map("outputs").get(op)) orelse return error.BadIndex;
                const l = v.get("listing") orelse return error.BadIndex;
                const pay = bytesOf(l.get("payout")) orelse "";
                try out.append(a, .{ .output = outputOf(op), .json = try json(a, Listing{
                    .outpoint = try opText(a, op),
                    .origin = try opText(a, bytesOf(v.get("origin")) orelse return error.BadIndex),
                    .price = @intCast(intOf(l.get("price")) orelse 0),
                    .seller = textOf(l.get("seller")) orelse "",
                    .payout = try payoutOf(a, pay),
                    .payoutScript = try hexOf(a, pay),
                }) });
            }
        },
        .sales => {
            const ck = keyOf(q.collection.?);
            const all = try svc.map("sales").prefixed(&ck);
            const ages = try a.alloc(Age, all.len);
            for (all, ages) |kv, *x| {
                if (kv.key.len != 104) return error.BadIndex;
                x.* = try ageOf(ch, kv.key, kv.key[36..68].*);
            }
            std.mem.sort(Age, ages, {}, newerFirst);
            for (page(Age, ages, q)) |x| {
                const v = (try svc.map("sales").get(x.key)) orelse return error.BadIndex;
                const op = x.key[68..104];
                const pay = bytesOf(v.get("payout")) orelse "";
                try out.append(a, .{ .output = outputOf(op), .json = try json(a, Sale{
                    .outpoint = try opText(a, op),
                    .origin = try opText(a, bytesOf(v.get("origin")) orelse return error.BadIndex),
                    .type = textOf(v.get("type")) orelse "",
                    .price = @intCast(intOf(v.get("price")) orelse 0),
                    .seller = textOf(v.get("seller")) orelse "",
                    .payout = try payoutOf(a, pay),
                    .payoutScript = try hexOf(a, pay),
                    .txid = &std.fmt.bytesToHex(display(x.key[36..68].*), .lower),
                    .height = x.height,
                    .time = x.time,
                }) });
            }
        },
    }
    return out.items;
}

fn hexOf(a: Allocator, b: []const u8) ![]const u8 {
    const out = try a.alloc(u8, b.len * 2);
    for (b, 0..) |x, i| _ = std.fmt.bufPrint(out[i * 2 ..][0..2], "{x:0>2}", .{x}) catch unreachable;
    return out;
}

pub fn answer(a: Allocator, svc: *Service, ch: *lookup.Chain, query: Value) anyerror!lookup.Answer {
    if (!eql(u8, svc.name, service_name)) return error.UnknownService;
    const rs = try rows(a, svc, ch, try parseQuery(query));
    const outs = try a.alloc(lookup.Output, rs.len);
    for (rs, outs) |r, *o| o.* = .{ .txid = r.output.txid, .vout = r.output.vout, .context = r.json };
    return .{ .output_list = outs };
}

pub const version = "0.1.0";

pub fn metadata(_: Allocator, _: []const u8) anyerror!lookup.Metadata {
    return .{
        .name = "1Sat Collections",
        .short_description = "1Sat collection items: every item of a collection, an item's chain of custody, open OrdLock listings, and sales.",
        .version = version,
        .information_url = "https://github.com/shruggr/skein-collection",
    };
}

pub fn documentation(_: Allocator, _: []const u8) anyerror![]const u8 {
    return
    \\# 1Sat collection lookup (ls_collection)
    \\
    \\Indexes what the collection topics `tm_col_<txid>_<vout>` admit. A collection id and an
    \\item's origin are outpoints `<txid>_<vout>` (the txid in display order, lowercase).
    \\
    \\## Queries
    \\
    \\- `{find: "items", collection, limit?, skip?}`: the collection's items, in origin order:
    \\  `{origin, outpoint, owner, name, mintNumber, rank, contentType, map}`. `outpoint` is
    \\  where the item is now (null once its satoshi is gone), `owner` its P2PKH address or
    \\  `listed`, `map` its mint's MAP fields.
    \\- `{find: "history", origin, limit?, skip?}`: one item's chain of custody, mint first:
    \\  `{outpoint, kind}`, kind `mint`, `transfer`, `listing`, `sale` or `cancel`.
    \\- `{find: "listings", collection, limit?, skip?}`: items in an unspent OrdLock v2 listing:
    \\  `{outpoint, origin, price, seller, payout, payoutScript}`.
    \\- `{find: "sales", collection, limit?, skip?}`: listing spends, newest first:
    \\  `{outpoint, origin, type, price, seller, payout, payoutScript, txid, height, time}`,
    \\  type `purchase` or `cancel` (the unlocking script's branch).
    \\
    \\`limit` is 1 to 100 (default 100), `skip` 0 to 100000 (default 0); anything else is
    \\refused. Answers are output-lists, each output with its transaction's BEEF and its row
    \\as JSON in `context`. The same reads answer JSON arrays at `/<app>/collection/items`,
    \\`/history`, `/listings` and `/sales` (the query string or a JSON body).
    \\
    ;
}

// ---------------------------------------------------------------- the read routes

fn respond(a: Allocator, status: u64, body: []const u8) !Value {
    return .{ .map = try a.dupe(CEntry, &.{
        .{ .key = "status", .value = .{ .uint = status } },
        .{ .key = "type", .value = .{ .text = "application/json" } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) };
}

/// A read route (the route handler contract, any method): the rows as a JSON array, 200; or 400
/// `{status: "error", message}`. `state` is the index's record (the head `<app>/ls_collection`),
/// `chain_state` the head `chain/state`'s.
pub fn route(a: Allocator, s: c.store.Store, find: Find, state: ?[]const u8, chain_state: ?[]const u8, req: Value) !Value {
    const q = parseRequest(a, find, req.getText("query") orelse "", req.getBytes("body") orelse "") catch
        return respond(a, 400, "{\"status\":\"error\",\"message\":\"the query is {collection | origin: <txid>_<vout>, limit?: 1..100, skip?: 0..100000}, in the query string or a JSON body\"}");
    var svc = try Service.loadIndex(a, s, service_name, index_name, spec.maps, state);
    var net: c.chain.Network = .main;
    if (chain_state) |r| net = c.chain.Network.parse((try s.getValue(a, r)).getText("network") orelse "") orelse return error.BadChainState;
    var ch = try lookup.Chain.load(a, s, chain_state, net);
    var w: std.Io.Writer.Allocating = .init(a);
    try w.writer.writeByte('[');
    for (try rows(a, &svc, &ch, q), 0..) |r, i| {
        if (i > 0) try w.writer.writeByte(',');
        try w.writer.writeAll(r.json);
    }
    try w.writer.writeByte(']');
    return respond(a, 200, w.written());
}

/// The app a read's call names: the read route's `app`, else its program record's, else "collection".
fn appOfRead(a: Allocator, s: c.store.Store, req: Value) ![]const u8 {
    const m = req.get("match") orelse return "collection";
    if (m.getText("app")) |x| return x;
    const p = m.getCid("program") orelse return "collection";
    return (try s.getValue(a, p)).getText("app") orelse "collection";
}

/// Whether this call is a filter's: the input's `filter: true` (skein docs/APPS.md §2 "Filters").
pub fn isFilter(in: Value) bool {
    const f = in.get("filter") orelse return false;
    return f == .boolean and f.boolean;
}

const sk = @import("overlay_sk");
var delegate = false;

fn run(a: Allocator) anyerror!void {
    const in = try sk.input(a);
    const find = std.meta.stringToEnum(Find, in.getText("fn") orelse "") orelse {
        delegate = true;
        return;
    };
    const req = try sk.callArg(a, in);
    const s = sk.store();
    const app = try appOfRead(a, s, req);
    const out = try route(a, s, find, try sk.head(a, try lookup.headName(a, app, index_name)), try sk.head(a, lookup.chain_head), req);
    // A read route's filter (shruggr/skein#143): the http answer as the filter's `{answer: …}`.
    try sk.answer(a, if (isFilter(in)) Value{ .map = try a.dupe(CEntry, &.{.{ .key = "answer", .value = out }}) } else out);
}

/// A call: fn "items" / "history" / "listings" / "sales" (the reads), else the lookup contract's
/// (fn "lookup", the hooks, "metadata", "documentation").
pub fn main() u8 {
    const rc = sk.main("collection-lookup", run);
    if (delegate) return lookup.main(spec);
    return rc;
}
