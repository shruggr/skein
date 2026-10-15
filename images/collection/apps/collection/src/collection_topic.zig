//! collection-topic: the 1Sat collection topic manager (shruggr/skein#151),
//! two topics by name:
//!
//!   tm_1sat_collection      every collection mint (the discovery topic)
//!   tm_col_<txid>_<vout>    one collection: its mint, its items' mints, and every
//!                           later output holding an item's satoshi
//!
//! `identify` (the skein-overlay topic contract, `topic.Call`) answers the
//! verdict of rules.zig; `metadata` and `documentation` answer the overlay's
//! listing and documentation routes. The topics served are the engine's: root
//! registers each, `register {topic, program: "collection-topic"}` (the app's
//! manifest declares none).
const std = @import("std");
const topic = @import("topic");
const collection = @import("collection");

const rules = collection.rules;
const name = collection.name;

const Allocator = std.mem.Allocator;

pub fn identify(a: Allocator, call: topic.Call) anyerror!topic.Instructions {
    const t = rules.Topic.of(call.topic) orelse return error.UnknownTopic;
    const v = try rules.judge(a, t, call);
    return .{ .outputs_to_admit = v.outputs_to_admit, .coins_to_retain = v.coins_to_retain, .ancillary_txids = v.ancillary_txids };
}

pub const version = "0.1.0";
const information_url = "https://github.com/shruggr/skein-collection";

pub fn metadata(a: Allocator, t: []const u8) anyerror!topic.Metadata {
    const which = rules.Topic.of(t) orelse return .{ .short_description = "Not a 1Sat collection topic." };
    return switch (which) {
        .discovery => .{
            .name = "1Sat Collection Discovery",
            .short_description = "Every 1Sat collection mint: a 1-sat inscription, MAP type=ord subType=collection, a valid SIGMA.",
            .version = version,
            .information_url = information_url,
        },
        .collection => |id| blk: {
            var b: [name.max_id_len]u8 = undefined;
            break :blk .{
                .short_description = try std.fmt.allocPrint(a, "1Sat collection {s}: its mint, its items' mints signed by its issuer, and every output holding an item's satoshi.", .{name.idText(&b, id)}),
                .version = version,
                .information_url = information_url,
            };
        },
    };
}

pub fn documentation(_: Allocator, t: []const u8) anyerror![]const u8 {
    if (std.mem.eql(u8, t, name.discovery_topic)) return
    \\# 1Sat collection discovery (tm_1sat_collection)
    \\
    \\Every collection mint, of every collection: an output holding exactly one satoshi,
    \\an `ord` inscription, MAP `type=ord` and `subType=collection`, and a SIGMA that
    \\verifies (the signed message as 1sat-sdk signs it). Nothing else is admitted and no
    \\spent coin is retained.
    \\
    ;
    return
    \\# 1Sat collection topic (tm_col_<txid>_<vout>)
    \\
    \\One collection, by its mint outpoint `<txid>_<vout>` (the txid in display order,
    \\lowercase). It admits:
    \\
    \\1. the collection's own mint: output `<vout>` of `<txid>`, a 1-sat inscription with
    \\   MAP `type=ord subType=collection` and a valid SIGMA, whose signer is the issuer;
    \\2. each item mint: a 1-sat inscription with MAP `subType=collectionItem`, its
    \\   `subTypeData.collectionId` naming this collection (`_<n>`: output `n` of the
    \\   item's own transaction), and a valid SIGMA from the issuer;
    \\3. every later output holding an admitted output's satoshi, by the ordinal position
    \\   rule (the offset is the sum of the source satoshis of the inputs before it;
    \\   absorbed into a multi-sat output, or paid as fee, it is gone), whatever its
    \\   locking script: a P2PKH transfer, an OrdLock listing.
    \\
    \\Every spent topic coin is retained. A transfer names as ancillary the source
    \\transactions of the inputs before the ordinal's that are not topic coins, so a peer
    \\can recompute where the satoshi landed.
    \\
    ;
}

pub fn main() u8 {
    return topic.main(identify);
}
