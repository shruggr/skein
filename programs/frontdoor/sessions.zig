//! The front door's BRC-103 session table as state (#68: sessions are
//! records, not host memory). A handshake is a request like any other: the
//! front door's step on it writes the new session here and moves the head;
//! a signed request's step reads its session back. The table survives a
//! restart; like every record it is prunable later.
//!
//!   head `sessions` → {kind: "sessions", buckets: [<bucket> × 16]}
//!   bucket          → {kind: "session-bucket", sessions: [{nonce, peer: bytes(33), peerNonce, created}]}
//!
//! `nonce` is ours (what a request's `yourNonce` names), `peerNonce` the
//! client's initial nonce, `created` the handshake entry's time (ms). A
//! session lives in bucket sha256(nonce)[0] mod 16, so a request reads one
//! small record, and a handshake rewrites the buckets it changes and the
//! root. The bound is the handshake's: the expired dropped, then the oldest
//! past MAX_SESSIONS.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub const HEAD = "sessions";
const BUCKETS = 16;

pub const Session = struct { peer: []const u8, ours: []const u8, theirs: []const u8, created: i128 };

fn bucketOf(nonce: []const u8) usize {
    var h: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(nonce, &h, .{});
    return h[0] % BUCKETS;
}

pub const Table = struct {
    a: Allocator,
    cids: [BUCKETS]?[]const u8 = .{null} ** BUCKETS,
    loaded: [BUCKETS]?std.ArrayList(Session) = .{null} ** BUCKETS,
    dirty: [BUCKETS]bool = .{false} ** BUCKETS,

    /// The table as the head names it (empty if it never moved).
    pub fn load(a: Allocator) !Table {
        var t = Table{ .a = a };
        const root_cid = (try sk.head(a, HEAD)) orelse return t;
        const root = try sk.get(a, root_cid);
        const bs = root.get("buckets") orelse return error.BadSessions;
        if (bs != .array or bs.array.len != BUCKETS) return error.BadSessions;
        for (bs.array, 0..) |b, i| t.cids[i] = Value.cidOf(b) orelse return error.BadSessions;
        return t;
    }

    fn bucket(t: *Table, i: usize) !*std.ArrayList(Session) {
        if (t.loaded[i] == null) {
            var list: std.ArrayList(Session) = .empty;
            if (t.cids[i]) |c| {
                const v = try sk.get(t.a, c);
                const ss = v.get("sessions") orelse return error.BadSessions;
                if (ss != .array) return error.BadSessions;
                for (ss.array) |s| try list.append(t.a, .{
                    .ours = Value.str(s.get("nonce")) orelse return error.BadSessions,
                    .peer = Value.bytesOf(s.get("peer")) orelse return error.BadSessions,
                    .theirs = Value.str(s.get("peerNonce")) orelse return error.BadSessions,
                    .created = Value.intOf(s.get("created")) orelse 0,
                });
            }
            t.loaded[i] = list;
        }
        return &t.loaded[i].?;
    }

    /// The session whose nonce (ours) is `nonce`.
    pub fn find(t: *Table, nonce: []const u8) !?Session {
        for ((try t.bucket(bucketOf(nonce))).items) |s| if (eql(u8, s.ours, nonce)) return s;
        return null;
    }

    /// Every session held, in no order.
    pub fn all(t: *Table) ![]Session {
        var out: std.ArrayList(Session) = .empty;
        for (0..BUCKETS) |i| try out.appendSlice(t.a, (try t.bucket(i)).items);
        return out.items;
    }

    pub fn remove(t: *Table, nonce: []const u8) !void {
        const i = bucketOf(nonce);
        const b = try t.bucket(i);
        for (b.items, 0..) |s, k| if (eql(u8, s.ours, nonce)) {
            _ = b.orderedRemove(k);
            t.dirty[i] = true;
            return;
        };
    }

    pub fn add(t: *Table, s: Session) !void {
        const i = bucketOf(s.ours);
        try (try t.bucket(i)).append(t.a, s);
        t.dirty[i] = true;
    }

    /// Write the changed buckets and the root, and move the head (with this step).
    pub fn save(t: *Table) !void {
        var any = false;
        for (0..BUCKETS) |i| {
            if (!t.dirty[i] and t.cids[i] != null) continue;
            any = any or t.dirty[i];
            var list: std.ArrayList(Value) = .empty;
            for ((try t.bucket(i)).items) |s| {
                var m = cbor.MapBuilder.init(t.a);
                try m.put("nonce", cbor.string(s.ours));
                try m.put("peer", .{ .bytes = s.peer });
                try m.put("peerNonce", cbor.string(s.theirs));
                try m.put("created", cbor.int(s.created));
                try list.append(t.a, m.value());
            }
            var b = cbor.MapBuilder.init(t.a);
            try b.put("kind", cbor.string("session-bucket"));
            try b.put("sessions", .{ .array = list.items });
            t.cids[i] = try sk.put(t.a, b.value());
        }
        if (!any) return;
        const links = try t.a.alloc(Value, BUCKETS);
        for (t.cids, links) |c, *l| l.* = cbor.cidv(c.?);
        var r = cbor.MapBuilder.init(t.a);
        try r.put("kind", cbor.string("sessions"));
        try r.put("buckets", .{ .array = links });
        try sk.advance(HEAD, try sk.put(t.a, r.value()));
    }
};
