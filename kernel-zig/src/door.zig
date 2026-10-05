// The door's filters (#121): what a dispatch row's `filter` setting names,
// run by the kernel on a request's package at admission, after the
// transport's middleware has verified the sender and the kernel has matched
// the row, and before the entry is written (scheduler.zig `door`). A filter
// reads the package; what it writes is blocks (content-addressed, once) and
// the package it hands back, which the entry then names instead of the one
// received. It is lossless for anything a signature covers: what it rewrites
// is reconstructible to the exact bytes (beef.zig `encode`).
//
// One filter today, `beef`: every byte string in the package (an http body,
// a libp2p message's body; walked through maps and arrays) that starts with
// a BEEF pattern (beef.zig `patterns`) is decoded; every BUMP is checked
// against the headers in the chain app's state (the head `chain/state`, read
// only); each transaction is stored as its `bitcoin-tx` block, each BUMP as
// the raw block of its bytes and the merkle nodes it reveals; and the bytes
// are replaced by a link to the pointer record (beef.zig). A BUMP that does
// not check is a refusal: the entry is still written — a refusal entry,
// naming the package with its BEEF replaced as far as it decoded — and
// nothing runs. A transaction no BUMP proves enters as unproven (SPV and
// status are the chain app's).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const mst = @import("mst");
const beef = @import("beef.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

/// The head the chain app keeps its state under (shruggr/skein-chain; skein-sdk `chain.state`).
pub const CHAIN_STATE = "chain/state";

/// The filters a row may name.
pub const filters = [_][]const u8{"beef"};

pub fn isFilter(name: []const u8) bool {
    for (filters) |f| if (std.mem.eql(u8, f, name)) return true;
    return false;
}

/// The chain app's headers, read only: {kind: "chain-state", maps: {headers: <MST root>}}, the map
/// height (u32 big-endian) → the header (a bitcoin-block link) on its best chain.
pub const Headers = struct {
    s: Store,
    root: ?[]const u8,
    forest: mst.Forest,

    fn blockGet(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const h: *Headers = @ptrCast(@alignCast(ctx));
        return h.s.bytes(a, cid);
    }

    /// The headers of the chain state as it stands; null when the instance has none (no chain app,
    /// or one that has seen no header).
    pub fn open(a: std.mem.Allocator, s: Store) !?*Headers {
        const state = (try s.headTree(a, CHAIN_STATE)) orelse return null;
        const v = s.getOpt(a, state) orelse return null;
        if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", "chain-state")) return null;
        const maps = v.get("maps") orelse return null;
        const h = try a.create(Headers);
        h.* = .{ .s = s, .root = Value.cidOf(maps.get("headers")), .forest = undefined };
        h.forest = mst.Forest.init(a, .{ .ctx = h, .get = blockGet });
        return h;
    }

    /// The header at `height`: its CID and its merkle root; null when the chain state has none there.
    pub fn at(h: *Headers, a: std.mem.Allocator, height: u32) !?struct { cid: []const u8, root: [32]u8 } {
        var key: [4]u8 = undefined;
        std.mem.writeInt(u32, &key, height, .big);
        const v = (try h.forest.get(a, h.root, &key)) orelse return null;
        const c = Value.cidOf(v) orelse return null;
        const raw = (try h.s.bytes(a, c)) orelse return null;
        if (raw.len != 80) return null;
        return .{ .cid = c, .root = raw[36..68].* };
    }
};

/// What a filter came to: the package to log (rewritten, or as received), the pointer records it
/// made, and — refused — why.
pub const Filtered = struct {
    value: Value,
    beefs: []const []const u8,
    refused: ?[]const u8 = null,
};

const Walk = struct {
    a: std.mem.Allocator,
    s: Store,
    headers: ?*Headers = null,
    opened: bool = false,
    beefs: std.ArrayList([]const u8) = .empty,
    refused: ?[]const u8 = null,

    fn refuse(w: *Walk, comptime f: []const u8, args: anytype) !void {
        if (w.refused == null) w.refused = try std.fmt.allocPrint(w.a, f, args);
    }

    fn walk(w: *Walk, v: Value) anyerror!Value {
        switch (v) {
            .bytes => |b| return w.bytes(b),
            .map => |m| {
                const out = try w.a.alloc(cbor.Entry, m.len);
                for (m, out) |e, *o| o.* = .{ .key = e.key, .value = try w.walk(e.value) };
                return .{ .map = out };
            },
            .array => |xs| {
                const out = try w.a.alloc(Value, xs.len);
                for (xs, out) |x, *o| o.* = try w.walk(x);
                return .{ .array = out };
            },
            else => return v,
        }
    }

    fn bytes(w: *Walk, b: []const u8) !Value {
        const a = w.a;
        if (beef.recognize(b) == null) return .{ .bytes = b };
        const d = beef.parse(a, b) catch {
            try w.refuse("a BEEF that does not decode (it starts with a BEEF pattern)", .{});
            return .{ .bytes = b };
        };
        if (!w.opened) {
            w.headers = try Headers.open(a, w.s);
            w.opened = true;
        }
        // Check every BUMP before anything is stored; a refusal still stores what decoded (lossless).
        const checked = try a.alloc(beef.Checked, d.bumps.len);
        var nodes: std.ArrayList(beef.Node) = .empty;
        for (d.bumps, checked, 0..) |p, *c, i| {
            c.* = .{ .block = null };
            const rev = beef.reveal(a, p) catch {
                try w.refuse("BUMP {d} (height {d}): malformed, or its nodes conflict", .{ i, p.height });
                continue;
            };
            _ = beef.proves(a, d, i) catch {
                try w.refuse("BUMP {d} (height {d}): a transaction marked with it is not in it", .{ i, p.height });
                continue;
            };
            const h = w.headers orelse {
                try w.refuse("no chain state to check the BUMPs against: the head {s} is absent (no chain app, or it has seen no header)", .{CHAIN_STATE});
                continue;
            };
            const hdr = (try h.at(a, p.height)) orelse {
                try w.refuse("BUMP {d}: no header at height {d} in {s}", .{ i, p.height, CHAIN_STATE });
                continue;
            };
            if (!std.mem.eql(u8, &hdr.root, &rev.root)) {
                try w.refuse("BUMP {d}: its merkle root is not the header's at height {d}", .{ i, p.height });
                continue;
            }
            c.block = hdr.cid;
            try nodes.appendSlice(a, rev.nodes);
        }
        if (d.bumps.len == 0 and w.headers == null) try w.refuse("no chain state: the head {s} is absent (no chain app, or it has seen no header)", .{CHAIN_STATE});
        // Each block once: a block the store holds is not written again.
        for (d.txs) |t| if (t.raw) |raw| try w.once(try beef.txCid(a, t.txid), raw);
        for (d.bumps) |p| try w.once(try cidm.ofRaw(a, p.bytes), p.bytes);
        if (w.refused == null) for (nodes.items) |n| try w.once(try beef.txCid(a, n.hash), &n.bytes);
        const rc = try w.s.put(a, try beef.record(a, d, checked));
        try w.beefs.append(a, rc);
        return cbor.cidv(rc);
    }

    fn once(w: *Walk, c: []const u8, b: []const u8) !void {
        if (try w.s.has(c)) return;
        try w.s.putBlock(c, b);
    }
};

/// The `beef` filter over a package (any dag-cbor value: a request record).
pub fn filterBeef(a: std.mem.Allocator, s: Store, v: Value) !Filtered {
    var w = Walk{ .a = a, .s = s };
    const out = try w.walk(v);
    return .{ .value = out, .beefs = w.beefs.items, .refused = w.refused };
}

/// The bytes a package's pointer links stand for, put back (the lossless rule's other half): each
/// link to a pointer record named in `beefs` replaced by the BEEF it records (beef.zig `encode`).
pub fn restore(a: std.mem.Allocator, s: Store, v: Value, beefs: []const []const u8) !Value {
    switch (v) {
        .cid => |c| {
            for (beefs) |x| if (std.mem.eql(u8, x, c)) {
                const rec = (try s.get(a, c)) orelse return error.NotFound;
                const G = struct {
                    fn get(ctx: *anyopaque, al: std.mem.Allocator, k: []const u8) anyerror!?[]const u8 {
                        const st: *const Store = @ptrCast(@alignCast(ctx));
                        return st.bytes(al, k);
                    }
                };
                var sc = s;
                return .{ .bytes = try beef.encode(a, rec, .{ .ctx = &sc, .get = G.get }) };
            };
            return v;
        },
        .map => |m| {
            const out = try a.alloc(cbor.Entry, m.len);
            for (m, out) |e, *o| o.* = .{ .key = e.key, .value = try restore(a, s, e.value, beefs) };
            return .{ .map = out };
        },
        .array => |xs| {
            const out = try a.alloc(Value, xs.len);
            for (xs, out) |x, *o| o.* = try restore(a, s, x, beefs);
            return .{ .array = out };
        },
        else => return v,
    }
}
