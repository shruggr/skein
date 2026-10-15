//! Collection and item mints, read as 1sat-stack pkg/collection reads them
//! (`IsCollectionMintOutput`, `DecodeMapFields`), with the checks of
//! shruggr/skein#151:
//!
//! - A mint output holds exactly one satoshi and an `ord` inscription
//!   envelope (skein-1sat `inscription.decode`).
//! - Its MAP is the first MAP protocol of its Bitcom tape that decodes
//!   (skein-1sat `map.find`); `subTypeData` is JSON whose `collectionId`
//!   (a string), `mintNumber` and `rank` are read each on its own, keys
//!   matched without regard to case as Go's `json.Unmarshal` matches them, the
//!   last one winning. A number is a JSON integer or a string of decimal
//!   digits (on-chain items write `"mintNumber":"42"`; Go's `*int` fails the
//!   whole decode on it and reads no `collectionId`); a value of another type
//!   is absent. Text that is not a JSON object: none of the three.
//! - A **collection mint**: MAP `type=ord`, `subType=collection`, and a SIGMA
//!   that verifies (skein-1sat `sigma.firstValid`, 1sat-sdk's rule); its
//!   signer is that SIGMA's address, the collection's issuer.
//! - An **item mint** of a collection: MAP `subType=collectionItem`,
//!   `subTypeData.collectionId` naming the collection (name.zig `normalize`:
//!   a relative `_<n>` is output `n` of the item's own transaction), and a
//!   SIGMA that verifies and is the collection's signer's (any of the
//!   output's SIGMAs; the Go code takes the first valid one of any signer).
const std = @import("std");
const c = @import("chain");
const onesat = @import("onesat");
const name = @import("name.zig");

const Allocator = std.mem.Allocator;
const Transaction = c.bsvz.transaction.Transaction;
const eql = std.mem.eql;

pub const sub_type_collection = "collection";
pub const sub_type_item = "collectionItem";

/// The MAP fields a collection or item mint is read by.
pub const Fields = struct {
    map: onesat.map.Map,
    type: ?[]const u8 = null,
    sub_type: ?[]const u8 = null,
    name: ?[]const u8 = null,
    sub_type_data: ?[]const u8 = null,
    collection_id: ?[]const u8 = null,
    mint_number: ?i64 = null,
    rank: ?i64 = null,
};

/// The MAP fields of a locking script, or null when its tape carries no MAP.
pub fn fieldsOf(a: Allocator, lock: []const u8) !?Fields {
    const tape = onesat.bitcom.decode(lock) orelse return null;
    const m = (try onesat.map.find(a, tape)) orelse return null;
    var f: Fields = .{
        .map = m,
        .type = m.get("type"),
        .sub_type = m.get("subType"),
        .name = m.get("name"),
        .sub_type_data = m.get("subTypeData"),
    };
    if (f.sub_type_data) |d| if (d.len > 0) subTypeData(a, d, &f);
    return f;
}

fn subTypeData(a: Allocator, text: []const u8, f: *Fields) void {
    const j = std.json.parseFromSliceLeaky(std.json.Value, a, text, .{}) catch return;
    if (j != .object) return;
    var it = j.object.iterator();
    while (it.next()) |e| {
        const k = e.key_ptr.*;
        const v = e.value_ptr.*;
        if (std.ascii.eqlIgnoreCase(k, "collectionId")) {
            f.collection_id = if (v == .string) v.string else null;
        } else if (std.ascii.eqlIgnoreCase(k, "mintNumber")) {
            f.mint_number = intOf(v);
        } else if (std.ascii.eqlIgnoreCase(k, "rank")) {
            f.rank = intOf(v);
        }
    }
}

fn intOf(v: std.json.Value) ?i64 {
    return switch (v) {
        .integer => |n| n,
        .string => |s| if (s.len > 0 and std.ascii.isDigit(s[0])) std.fmt.parseInt(i64, s, 10) catch null else null,
        else => null,
    };
}

/// Whether an output can be a mint: exactly one satoshi and an inscription envelope.
pub fn isMintOutput(o: c.bsvz.transaction.Output) bool {
    return o.satoshis == 1 and onesat.inscription.decode(o.locking_script.bytes) != null;
}

/// Output `vout` of `tx` as a collection mint: its signer's address, or null when it is none.
pub fn collectionSigner(a: Allocator, tx: *const Transaction, vout: u32) !?[]const u8 {
    if (vout >= tx.outputs.len or !isMintOutput(tx.outputs[vout])) return null;
    const f = (try fieldsOf(a, tx.outputs[vout].locking_script.bytes)) orelse return null;
    if (!eql(u8, f.type orelse "", "ord") or !eql(u8, f.sub_type orelse "", sub_type_collection)) return null;
    const s = (try onesat.sigma.firstValid(a, tx, vout)) orelse return null;
    return s.address;
}

/// The collection output `vout` of `tx` (`txid`, internal order) claims to be an item of: a 1-sat
/// inscription with MAP `subType=collectionItem` and a `collectionId` naming one. Null otherwise.
pub fn claimedCollection(a: Allocator, tx: *const Transaction, txid: [32]u8, vout: u32) !?name.Id {
    if (vout >= tx.outputs.len or !isMintOutput(tx.outputs[vout])) return null;
    const f = (try fieldsOf(a, tx.outputs[vout].locking_script.bytes)) orelse return null;
    if (!eql(u8, f.sub_type orelse "", sub_type_item)) return null;
    return name.normalize(f.collection_id orelse return null, txid);
}

/// Whether output `vout` of `tx` carries a SIGMA that verifies and is `signer`'s.
pub fn signedBy(a: Allocator, tx: *const Transaction, vout: u32, signer: []const u8) !bool {
    const tape = onesat.bitcom.decode(tx.outputs[vout].locking_script.bytes) orelse return false;
    var it = onesat.sigma.iterate(tape);
    while (it.next()) |s| {
        if (!eql(u8, s.address, signer) or s.signature.len == 0) continue;
        if (try onesat.sigma.verify(a, s, tx, vout)) return true;
    }
    return false;
}

/// Whether output `vout` of `tx` is an item mint of collection `id`, whose signer is `signer`.
pub fn isItemOf(a: Allocator, tx: *const Transaction, txid: [32]u8, vout: u32, id: name.Id, signer: []const u8) !bool {
    const claimed = (try claimedCollection(a, tx, txid, vout)) orelse return false;
    if (!claimed.eql(id)) return false;
    return signedBy(a, tx, vout, signer);
}
