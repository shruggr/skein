//! Topic, lookup and collection id names (shruggr/skein#151; the Go names of
//! 1sat-stack pkg/collection, so both implementations share the discovery
//! topic):
//!
//!   tm_1sat_collection        the discovery topic: every collection mint
//!   tm_col_<txid>_<vout>      one collection, by its mint outpoint
//!   ls_collection             the lookup, beside each collection topic
//!
//! A collection id is its mint outpoint written `<txid>_<vout>` (go-sdk
//! `Outpoint.OrdinalString`): the txid 64 lowercase hex characters in display
//! order, an underscore, the index in decimal without leading zeros. An
//! item's `subTypeData.collectionId` may be relative, `_<n>`: output `n` of the
//! item's own transaction (1sat-stack pkg/parse `NormalizeRelativeOutpoint`).
const std = @import("std");

pub const discovery_topic = "tm_1sat_collection";
pub const topic_prefix = "tm_col_";
pub const service = "ls_collection";

/// The longest id text, `<64 hex>_<4294967295>`.
pub const max_id_len = 64 + 1 + 10;
pub const max_topic_len = topic_prefix.len + max_id_len;

/// An outpoint: the txid in internal byte order (as in a transaction input), and the index.
pub const Id = struct {
    txid: [32]u8,
    vout: u32,

    pub fn eql(x: Id, y: Id) bool {
        return x.vout == y.vout and std.mem.eql(u8, &x.txid, &y.txid);
    }
};

/// A txid from 64 lowercase hex characters in display order, or null.
pub fn txidOfHex(t: []const u8) ?[32]u8 {
    if (t.len != 64) return null;
    for (t) |ch| if (!(std.ascii.isDigit(ch) or (ch >= 'a' and ch <= 'f'))) return null;
    var out: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&out, t) catch return null;
    std.mem.reverse(u8, &out);
    return out;
}

/// The id `<txid>_<vout>` in canonical form, or null.
pub fn idOfText(t: []const u8) ?Id {
    if (t.len < 66 or t[64] != '_') return null;
    const v = t[65..];
    if (v.len > 1 and v[0] == '0') return null;
    for (v) |ch| if (!std.ascii.isDigit(ch)) return null;
    return .{ .txid = txidOfHex(t[0..64]) orelse return null, .vout = std.fmt.parseInt(u32, v, 10) catch return null };
}

/// The collection a topic name is: `tm_col_<id>`, or null.
pub fn idOfTopic(topic: []const u8) ?Id {
    if (!std.mem.startsWith(u8, topic, topic_prefix)) return null;
    return idOfText(topic[topic_prefix.len..]);
}

/// The id's text `<txid>_<vout>`, in `buf`.
pub fn idText(buf: *[max_id_len]u8, id: Id) []const u8 {
    var r = id.txid;
    std.mem.reverse(u8, &r);
    return std.fmt.bufPrint(buf, "{s}_{d}", .{ &std.fmt.bytesToHex(r, .lower), id.vout }) catch unreachable;
}

/// The collection's topic name `tm_col_<id>`, in `buf`.
pub fn topicName(buf: *[max_topic_len]u8, id: Id) []const u8 {
    var ib: [max_id_len]u8 = undefined;
    return std.fmt.bufPrint(buf, "{s}{s}", .{ topic_prefix, idText(&ib, id) }) catch unreachable;
}

/// An item's `collectionId` as the collection it names: `_<n>` is output `n` of the item's own
/// transaction (`txid`, internal order; Go's `strconv.ParseUint(s, 10, 32)`, leading zeros taken),
/// anything else the canonical `<txid>_<vout>`. Null when it names none.
pub fn normalize(ref: []const u8, txid: [32]u8) ?Id {
    if (ref.len > 0 and ref[0] == '_') {
        const n = ref[1..];
        if (n.len == 0) return null;
        for (n) |ch| if (!std.ascii.isDigit(ch)) return null;
        return .{ .txid = txid, .vout = std.fmt.parseInt(u32, n, 10) catch return null };
    }
    return idOfText(ref);
}
