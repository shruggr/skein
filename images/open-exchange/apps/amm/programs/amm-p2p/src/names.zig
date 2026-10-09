//! Topic, protocol, box and schedule names. One overlay topic per token,
//! `tm_mandala_<assetId>` (BRC-207; David Case, 2026-10-08): a Mandala
//! token's `tm_mandala_<txid>_0` (the deploy txid, 64 lowercase hex
//! characters in display order, then `_0`: the asset id is the token id
//! `<txid>_<vout>`, `_0` included); skein's overlay engine runs `<topic>`,
//! `<topic>-admit` and `<topic>-proof` (skein#74). This program adds, in the
//! same suffix style:
//!
//!   tm_mandala_<txid>_0-live   GossipSub: validator heartbeats (the overlay engine's beacon, skein-overlay 0.9.0)
//!   /amm/proofs/1.0.0      a direct call (a libp2p stream): proofs by block hash (a utility since
//!                          0.2.0: no row routes it)
//!
//! The names are parsed here, not by amm-topic.
const std = @import("std");

pub const live_suffix = "-live";
pub const proofs_protocol = "/amm/proofs/1.0.0";

/// This program's own box, as the kernel's table holds it (the manifest's `"amm-p2p"`, relative to
/// the app: shruggr/skein#128): the cron provider's ticks.
pub const own_box = "amm/amm-p2p";

pub const Kind = enum { overlay, live };

/// A topic name of ours: the overlay topic it belongs to and what it is.
pub const Topic = struct { overlay: []const u8, id: [32]u8, kind: Kind };

/// A token's overlay topic: `tm_mandala_` and its asset id (BRC-207, skein-mandala 0.9.0).
pub const topic_prefix = "tm_mandala_";

/// The deploy txid (display order) of a Mandala token's overlay topic `tm_mandala_<txid>_0`, or
/// null (the old `tm_<txid>_0` included: no topic since skein-mandala 0.9.0, no alias).
pub fn txidOf(name: []const u8) ?[32]u8 {
    if (name.len != topic_prefix.len + 64 + 2 or !std.mem.startsWith(u8, name, topic_prefix) or !std.mem.endsWith(u8, name, "_0")) return null;
    const hex = name[topic_prefix.len .. topic_prefix.len + 64];
    for (hex) |c| if (!((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f'))) return null;
    var id: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&id, hex) catch return null;
    return id;
}

pub fn parse(name: []const u8) ?Topic {
    if (std.mem.endsWith(u8, name, live_suffix)) {
        const o = name[0 .. name.len - live_suffix.len];
        if (txidOf(o)) |id| return .{ .overlay = o, .id = id, .kind = .live };
        return null;
    }
    const id = txidOf(name) orelse return null;
    return .{ .overlay = name, .id = id, .kind = .overlay };
}

pub fn live(a: std.mem.Allocator, overlay: []const u8) ![]u8 {
    return std.mem.concat(a, u8, &.{ overlay, live_suffix });
}
