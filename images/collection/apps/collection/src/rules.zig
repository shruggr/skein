//! The topics' verdict on one transaction (shruggr/skein#151, "The admitted
//! set"), over a call that reads like skein-overlay's `topic.Call`: its `tx`,
//! `txid`, `previous_coins`, `sourceOutput(i)` (the output input `i` spends)
//! and `transaction(txid)` (a transaction the call can read: in the
//! submitted BEEF, or held).
//!
//! `tm_1sat_collection` admits every collection mint (rule 1) and nothing
//! else, and retains nothing.
//!
//! `tm_col_<txid>_<vout>` admits
//!
//!  1. the collection's own mint, output `<vout>` of `<txid>`, when it is a
//!     collection mint (mint.zig);
//!  2. every item mint of the collection: its `collectionId` names it and it
//!     carries a valid SIGMA from the collection's signer, read from the
//!     collection's mint (this transaction, or one the call can read; when it
//!     cannot, no item of the transaction is admitted);
//!  3. every output the satoshi of a topic coin the transaction spends lands
//!     in, by the ordinal position rule over the call's source outputs
//!     (skein-1sat `ordinal.output`: absorbed into a multi-sat output, or
//!     paid as fee, it is gone), whatever its locking script;
//!
//! retains every topic coin it spends, and names as ancillary (4) the source
//! transactions of the inputs before each such coin that are not topic
//! coins themselves: the funding parents that fix the satoshi's offset, so a
//! peer can recompute the landing. A source output the rule needs and the
//! call cannot read is `error.MissingSourceOutput` (the engine pauses a
//! submission missing a parent before it asks the topic).
const std = @import("std");
const c = @import("chain");
const onesat = @import("onesat");
const name = @import("name.zig");
const mint = @import("mint.zig");

const Allocator = std.mem.Allocator;

pub const Verdict = struct {
    outputs_to_admit: []const u32 = &.{},
    coins_to_retain: []const u32 = &.{},
    ancillary_txids: []const [32]u8 = &.{},
};

/// Which topic a name is.
pub const Topic = union(enum) {
    discovery,
    collection: name.Id,

    pub fn of(t: []const u8) ?Topic {
        if (std.mem.eql(u8, t, name.discovery_topic)) return .discovery;
        return .{ .collection = name.idOfTopic(t) orelse return null };
    }
};

pub fn judge(a: Allocator, topic: Topic, call: anytype) !Verdict {
    return switch (topic) {
        .discovery => judgeDiscovery(a, call),
        .collection => |id| judgeCollection(a, id, call),
    };
}

/// tm_1sat_collection: every collection mint of the transaction.
pub fn judgeDiscovery(a: Allocator, call: anytype) !Verdict {
    var admit: std.ArrayList(u32) = .empty;
    for (0..call.tx.outputs.len) |vout| {
        if ((try mint.collectionSigner(a, &call.tx, @intCast(vout))) != null) try admit.append(a, @intCast(vout));
    }
    return .{ .outputs_to_admit = admit.items };
}

/// The collection's signer: its mint's, in this transaction or one the call reads. Null when the
/// mint is not readable or is no collection mint.
fn signerOf(a: Allocator, id: name.Id, call: anytype) !?[]const u8 {
    if (std.mem.eql(u8, &id.txid, &call.txid)) return mint.collectionSigner(a, &call.tx, id.vout);
    const tx = call.transaction(id.txid) orelse return null;
    return mint.collectionSigner(a, &tx, id.vout);
}

fn contains(xs: []const u32, x: u32) bool {
    return std.mem.indexOfScalar(u32, xs, x) != null;
}

/// tm_col_<id>: rules 1 to 4.
pub fn judgeCollection(a: Allocator, id: name.Id, call: anytype) !Verdict {
    const tx = &call.tx;
    var admit: std.ArrayList(u32) = .empty;

    // 1. The collection's own mint.
    if (std.mem.eql(u8, &id.txid, &call.txid) and (try mint.collectionSigner(a, tx, id.vout)) != null) try admit.append(a, id.vout);

    // 2. Item mints, signed by the collection's signer.
    var signer: ?[]const u8 = null;
    var signer_read = false;
    for (0..tx.outputs.len) |i| {
        const vout: u32 = @intCast(i);
        const claimed = (try mint.claimedCollection(a, tx, call.txid, vout)) orelse continue;
        if (!claimed.eql(id)) continue;
        if (!signer_read) {
            signer = try signerOf(a, id, call);
            signer_read = true;
        }
        const s = signer orelse break;
        if (try mint.signedBy(a, tx, vout, s)) try admit.append(a, vout);
    }

    // 3. Where each topic coin's satoshi lands; 4. the funding parents that fix it.
    var ancillary: std.ArrayList([32]u8) = .empty;
    for (call.previous_coins) |vin| {
        if (try onesat.ordinal.output(tx, vin, call)) |vout| {
            if (!contains(admit.items, vout)) try admit.append(a, vout);
        }
        for (0..vin) |i| {
            if (contains(call.previous_coins, @intCast(i))) continue;
            const src = tx.inputs[i].previous_outpoint.txid.bytes;
            for (ancillary.items) |x| {
                if (std.mem.eql(u8, &x, &src)) break;
            } else try ancillary.append(a, src);
        }
    }

    std.mem.sort(u32, admit.items, {}, std.sort.asc(u32));
    return .{ .outputs_to_admit = admit.items, .coins_to_retain = call.previous_coins, .ancillary_txids = ancillary.items };
}
