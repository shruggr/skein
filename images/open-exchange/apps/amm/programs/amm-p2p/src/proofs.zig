//! Proofs by block (opldotdev/amm-poc#2), the pull half of proof sync: a
//! direct call (a libp2p stream) on `/amm/proofs/1.0.0`, request
//! `{blockHash, topic?}` → `{bump}` (the BUMP of every transaction of that
//! block this node holds a proof for, restricted to the topic when given,
//! merged into one) or `{missing: true}`; and the catch-up plan that asks
//! for it. The push half (a BUMP on `<topic>-proof`) is skein's overlay
//! engine's (skein#74); the pull half is a placeholder until #74's sync
//! walk-through (README.md).
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const MerklePath = w.merkle.MerklePath;

// ---------------------------------------------------------------- what this node holds

/// A transaction's settlement here (unknown: not held).
pub const TxStatus = enum { unknown, unproven, proven, rejected };

/// The level-0 hashes of a BUMP (the transactions it can prove, flagged or not).
pub fn leaves(a: Allocator, p: MerklePath) ![]const [32]u8 {
    if (p.path.len == 0) return &.{};
    var out: std.ArrayList([32]u8) = .empty;
    for (p.path[0]) |e| if (e.hash) |h| try out.append(a, h.bytes);
    return out.items;
}

/// The root a BUMP proves, or why it does not decode or agree with itself.
pub fn rootOf(a: Allocator, bump: []const u8) !union(enum) { root: [32]u8, bad: []const u8 } {
    const p = MerklePath.parse(a, bump) catch return .{ .bad = "BadBump" };
    const rev = w.merkle.reveal(a, p) catch |e| return .{ .bad = @errorName(e) };
    return .{ .root = rev.root };
}

// ---------------------------------------------------------------- one BUMP per block

/// What building a block's BUMP reads.
pub const Held = struct {
    ctx: *anyopaque,
    heightOfFn: *const fn (ctx: *anyopaque, hash: [32]u8) anyerror!?u32,
    /// The transactions we hold a proof for at a height (the wallet's `proofHeights`).
    provenAtFn: *const fn (ctx: *anyopaque, a: Allocator, height: u32) anyerror![]const [32]u8,
    inTopicFn: *const fn (ctx: *anyopaque, topic: []const u8, txid: [32]u8) anyerror!bool,
    /// A transaction's BUMP, rebuilt from the held tree (Wallet.proofFor).
    proofForFn: *const fn (ctx: *anyopaque, a: Allocator, txid: [32]u8) anyerror!?MerklePath,
};

pub const Built = struct { bump: []const u8, txids: []const [32]u8 };

/// The BUMP of the block at `height`: every held proof there (of `topic`'s
/// transactions, when given), merged into one. Null when there is none.
pub fn blockBumpAt(a: Allocator, held: Held, topic: ?[]const u8, height: u32) !?Built {
    var merged: ?MerklePath = null;
    var txids: std.ArrayList([32]u8) = .empty;
    for (try held.provenAtFn(held.ctx, a, height)) |t| {
        if (topic) |tp| if (!(try held.inTopicFn(held.ctx, tp, t))) continue;
        const p = (try held.proofForFn(held.ctx, a, t)) orelse continue;
        if (p.block_height != height) continue;
        if (merged) |*m| {
            m.combine(&p, a) catch continue;
        } else merged = try p.clone(a);
        try txids.append(a, t);
    }
    const m = merged orelse return null;
    return .{ .bump = try m.bytes(a), .txids = txids.items };
}

/// The same, by block hash (the direct call's request): null when the block is not on our chain or we hold nothing in it.
pub fn blockBump(a: Allocator, held: Held, topic: ?[]const u8, block_hash: [32]u8) !?Built {
    const height = (try held.heightOfFn(held.ctx, block_hash)) orelse return null;
    return blockBumpAt(a, held, topic, height);
}

// ---------------------------------------------------------------- the direct call

fn hash32(v: Value) ![32]u8 {
    if (v != .bytes or v.bytes.len != 32) return error.Malformed;
    return v.bytes[0..32].*;
}

pub const Request = struct { block_hash: [32]u8, topic: ?[]const u8 = null };

pub fn encodeRequest(a: Allocator, r: Request) ![]u8 {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.append(a, .{ .key = "blockHash", .value = .{ .bytes = try a.dupe(u8, &r.block_hash) } });
    if (r.topic) |t| try es.append(a, .{ .key = "topic", .value = .{ .text = t } });
    return cbor.encode(a, .{ .map = es.items });
}

pub fn decodeRequest(a: Allocator, bytes: []const u8) !Request {
    const v = cbor.decode(a, bytes) catch return error.Malformed;
    return .{ .block_hash = try hash32(v.get("blockHash") orelse return error.Malformed), .topic = v.getText("topic") };
}

/// The reply: `{bump}` or `{missing: true}`.
pub fn encodeReply(a: Allocator, bump: ?[]const u8) ![]u8 {
    return cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{if (bump) |b|
        .{ .key = "bump", .value = .{ .bytes = b } }
    else
        .{ .key = "missing", .value = .{ .boolean = true } }}) });
}

/// A reply's BUMP, or null for `{missing: true}`.
pub fn decodeReply(a: Allocator, bytes: []const u8) !?[]const u8 {
    const v = cbor.decode(a, bytes) catch return error.Malformed;
    if (v.getBytes("bump")) |b| return b;
    if (v.getBool("missing") orelse false) return null;
    return error.Malformed;
}

/// Answer one request.
pub fn serve(a: Allocator, held: Held, request: []const u8) ![]u8 {
    const r = decodeRequest(a, request) catch return encodeReply(a, null);
    const built = try blockBump(a, held, r.topic, r.block_hash);
    return encodeReply(a, if (built) |b| b.bump else null);
}

// ---------------------------------------------------------------- the catch-up pass

/// The heights a catch-up pass asks for: after the cursor, up to `batch`, not
/// past the tip. With no cursor yet, the pass starts `window` below the tip.
/// With nothing unsettled in the topic the cursor just follows the tip.
pub const Plan = struct { from: u32, to: u32, cursor: u32 };

pub fn catchupPlan(cursor: ?u32, tip: u32, window: u32, batch: u32, unsettled: bool) ?Plan {
    const start = if (cursor) |c| c else tip -| window;
    if (!unsettled) return if (start == tip and cursor != null) null else .{ .from = tip + 1, .to = tip, .cursor = tip };
    if (start >= tip) return null;
    const to = @min(tip, start + @max(batch, 1));
    return .{ .from = start + 1, .to = to, .cursor = to };
}
