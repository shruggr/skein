// The address book (#70): who an instance can reach, and how. The head
// `peers` names
//
//   {kind: "peers", peers: [{key, peer: <cid>}]}            sorted by key
//   peer  {kind: "peer", key: bytes(33), transport: "mailbox" | "libp2p" | "local", address,
//          role?, handle?, domain?, since, source}
//
// `transport` and `address` say how a message to `key` goes out: `mailbox`, a
// messagebox URL reached over BRC-103/104 by the instance's own sessions (the
// mailbox transport's middleware, the messagebox program, delivers it
// through the HTTP provider); `libp2p`, a peer ID or `topic:<name>` (the
// host's libp2p node carries it); `local`, the name of a provider on this
// host (handed to it directly). `role` is the provider role the entry plays
// for the instance (`fetch`, `libp2p`, `waker`, `broadcast`): how a program
// finds a provider (`deadline` finds the waker). One of the kernel's four
// tables (#77): written by the genesis (`addressBook`: the host's providers,
// the owner's mailbox; source "genesis") and by the kernel's `peers`
// operation on an admin message from the owner or a key the owner added as a
// sender on the `peers` row (source "admin"; `write` below). No program
// writes it, the resolve program included (#87: it keeps what it finds under
// its own name, `resolve/…`). The kernel reads it for `emit`.
const std = @import("std");
const cbor = @import("cbor");
const heads = @import("heads.zig");
const logm = @import("log.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub const HEAD = "peers";

/// The address of the host's loopback (#79): a message to the instance's own
/// identity, with no entry of its own, goes out as transport `local` to `self`.
pub const SELF = "self";

pub const Entry = struct { key: []const u8, transport: []const u8, address: []const u8, role: ?[]const u8 = null };

/// The peer records the address book `root` (the head's record) names, in key order.
pub fn entries(a: std.mem.Allocator, s: Store, root: ?[]const u8) ![]Value {
    const r = root orelse return &.{};
    const t = (try s.get(a, r)) orelse return &.{};
    const list = t.get("peers") orelse return &.{};
    if (list != .array) return &.{};
    var out = std.array_list.Managed(Value).init(a);
    for (list.array) |x| {
        const pc = Value.cidOf(x.get("peer")) orelse continue;
        const p = (try s.get(a, pc)) orelse continue;
        try out.append(p);
    }
    return out.items;
}

fn entryOf(p: Value) ?Entry {
    if (!logm.isAddress(p)) return null;
    return .{ .key = Value.bytesOf(p.get("key")).?, .transport = Value.str(p.get("transport")).?, .address = Value.str(p.get("address")).?, .role = Value.str(p.get("role")) };
}

/// How to reach `key`: its entry in the address book `root`, or null ("no route").
pub fn lookup(a: std.mem.Allocator, s: Store, root: ?[]const u8, key: []const u8) !?Entry {
    for (try entries(a, s, root)) |p| {
        const e = entryOf(p) orelse continue;
        if (std.mem.eql(u8, e.key, key)) return e;
    }
    return null;
}

/// The entry playing `role` (a provider's), or null.
pub fn byRole(a: std.mem.Allocator, s: Store, root: ?[]const u8, role: []const u8) !?Entry {
    for (try entries(a, s, root)) |p| {
        const e = entryOf(p) orelse continue;
        if (e.role) |r| if (std.mem.eql(u8, r, role)) return e;
    }
    return null;
}

/// Write (or replace) the peer record for `key` (#77: the kernel's `peers`
/// operation); a null `address`
/// removes it. The head `peers` moves under `by`.
pub fn write(a: std.mem.Allocator, s: Store, key: []const u8, transport: []const u8, address: ?[]const u8, role: ?[]const u8, handle: ?[]const u8, domain: ?[]const u8, source: []const u8, by: heads.By) !void {
    var list = std.array_list.Managed(Value).init(a);
    if (try s.headTree(a, HEAD)) |root| if (try s.get(a, root)) |r| if (r.get("peers")) |ps| if (ps == .array) for (ps.array) |x| {
        if (!std.mem.eql(u8, Value.bytesOf(x.get("key")) orelse "", key)) try list.append(x);
    };
    if (address) |u| {
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("peer"));
        try rec.put("key", .{ .bytes = key });
        try rec.put("transport", cbor.string(transport));
        try rec.put("address", cbor.string(u));
        try rec.put("role", cbor.optStr(role));
        try rec.put("handle", cbor.optStr(handle));
        try rec.put("domain", cbor.optStr(domain));
        try rec.put("since", cbor.int(by.at));
        try rec.put("source", cbor.string(source));
        var e = cbor.MapBuilder.init(a);
        try e.put("key", .{ .bytes = key });
        try e.put("peer", cbor.cidv(try s.put(a, rec.value())));
        try list.append(e.value());
    }
    std.mem.sort(Value, list.items, {}, struct {
        fn lt(_: void, x: Value, y: Value) bool {
            return std.mem.order(u8, Value.bytesOf(x.get("key")) orelse "", Value.bytesOf(y.get("key")) orelse "") == .lt;
        }
    }.lt);
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("peers"));
    try root.put("peers", .{ .array = list.items });
    _ = try heads.advanceHead(a, s, HEAD, try s.put(a, root.value()), by);
}

/// The genesis's seed (#70): each `addressBook` entry written as a peer
/// record (source "genesis"), the head `peers` moved to the list. Nothing
/// when the genesis names none.
pub fn seed(a: std.mem.Allocator, s: Store, g: Value, by: heads.By) !void {
    const ab = g.get("addressBook") orelse return;
    if (ab != .array or ab.array.len == 0) return;
    var list = std.array_list.Managed(Value).init(a);
    for (ab.array) |e| {
        var rec = cbor.MapBuilder.init(a);
        try rec.put("kind", cbor.string("peer"));
        try rec.put("key", e.get("key"));
        try rec.put("transport", e.get("transport"));
        try rec.put("address", e.get("address"));
        for ([_][]const u8{ "role", "handle", "domain" }) |k| if (Value.str(e.get(k))) |v| try rec.put(k, cbor.string(v));
        try rec.put("since", cbor.int(by.at));
        try rec.put("source", cbor.string("genesis"));
        const key = Value.bytesOf(e.get("key")).?;
        var item = cbor.MapBuilder.init(a);
        try item.put("key", .{ .bytes = key });
        try item.put("peer", cbor.cidv(try s.put(a, rec.value())));
        // A later entry for the same key replaces an earlier one.
        var i: usize = 0;
        while (i < list.items.len) : (i += 1) if (std.mem.eql(u8, Value.bytesOf(list.items[i].get("key")).?, key)) {
            _ = list.orderedRemove(i);
            break;
        };
        try list.append(item.value());
    }
    std.mem.sort(Value, list.items, {}, struct {
        fn lt(_: void, x: Value, y: Value) bool {
            return std.mem.order(u8, Value.bytesOf(x.get("key")).?, Value.bytesOf(y.get("key")).?) == .lt;
        }
    }.lt);
    var root = cbor.MapBuilder.init(a);
    try root.put("kind", cbor.string("peers"));
    try root.put("peers", .{ .array = list.items });
    _ = try heads.advanceHead(a, s, HEAD, try s.put(a, root.value()), by);
}
