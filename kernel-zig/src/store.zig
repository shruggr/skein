// The store interface the kernel sees (src/runtime/store.ts): blocks, chains,
// the input log, the live worklist. One implementation today, SQLite
// (sqlite_store.zig, the same file format as src/runtime/sqlite.ts, so the
// explorer reads it unchanged); a browser build would bring its own behind
// the same table of functions. Everything returned is allocated from the
// caller's allocator.
const std = @import("std");
const cbor = @import("cbor.zig");
const Value = cbor.Value;

pub const Rejected = enum {
    bad_signature,
    duplicate_seq,
    duplicate_envelope,
    duplicate_outcome,
    out_of_order,
    pub fn text(r: Rejected) []const u8 {
        return switch (r) {
            .bad_signature => "bad-signature",
            .duplicate_seq => "duplicate-seq",
            .duplicate_envelope => "duplicate-envelope",
            .duplicate_outcome => "duplicate-outcome",
            .out_of_order => "out-of-order",
        };
    }
};

pub const AppendResult = union(enum) { ok: []u8, rejected: struct { reason: Rejected, message: []u8 } };

pub const VTable = struct {
    bytes: *const fn (ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8,
    has: *const fn (ctx: *anyopaque, cid: []const u8) anyerror!bool,
    putBlock: *const fn (ctx: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void,
    chainOpen: *const fn (ctx: *anyopaque, a: std.mem.Allocator, origin: Value) anyerror![]u8,
    chainAppend: *const fn (ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8, body: Value) anyerror![]u8,
    /// null: no such chain (NotFound).
    chainTip: *const fn (ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8) anyerror!?[]u8,
    /// Updates only, in seq order (without the origin). null: no such chain.
    chainUpdates: *const fn (ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8) anyerror!?[][]u8,
    logAppend: *const fn (ctx: *anyopaque, a: std.mem.Allocator, entry: Value) anyerror!AppendResult,
    logTip: *const fn (ctx: *anyopaque, a: std.mem.Allocator) anyerror!?[]u8,
    logFrom: *const fn (ctx: *anyopaque, a: std.mem.Allocator, from: i64) anyerror![][]u8,
    /// The entry whose unique column is `cid` (an envelope, or an outcome's emit).
    logByUnique: *const fn (ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8,
    resting: *const fn (ctx: *anyopaque, a: std.mem.Allocator) anyerror![][]u8,
    awaiting: *const fn (ctx: *anyopaque, a: std.mem.Allocator, envelope: []const u8) anyerror![][]u8,
    threads: *const fn (ctx: *anyopaque, a: std.mem.Allocator) anyerror![][]u8,
    cursorGet: *const fn (ctx: *anyopaque) anyerror!i64,
    cursorSet: *const fn (ctx: *anyopaque, n: i64) anyerror!void,
};

pub const Store = struct {
    ctx: *anyopaque,
    vt: *const VTable,

    pub fn bytes(s: Store, a: std.mem.Allocator, cid: []const u8) !?[]u8 {
        return s.vt.bytes(s.ctx, a, cid);
    }
    /// The decoded record, or null if absent. A block that is not dag-cbor fails.
    pub fn get(s: Store, a: std.mem.Allocator, cid: []const u8) !?Value {
        const b = (try s.bytes(a, cid)) orelse return null;
        return try cbor.decode(a, b);
    }
    /// store.get(c).catch(() => undefined): null for absent or undecodable.
    pub fn getOpt(s: Store, a: std.mem.Allocator, cid: []const u8) ?Value {
        return s.get(a, cid) catch null;
    }
    pub fn has(s: Store, cid: []const u8) !bool {
        return s.vt.has(s.ctx, cid);
    }
    pub fn putBlock(s: Store, cid: []const u8, b: []const u8) !void {
        return s.vt.putBlock(s.ctx, cid, b);
    }
    pub fn put(s: Store, a: std.mem.Allocator, v: Value) ![]u8 {
        const blk = try cbor.block(a, v);
        try s.putBlock(blk.cid, blk.bytes);
        return blk.cid;
    }
    pub fn chainOpen(s: Store, a: std.mem.Allocator, origin: Value) ![]u8 {
        return s.vt.chainOpen(s.ctx, a, origin);
    }
    pub fn chainAppend(s: Store, a: std.mem.Allocator, origin: []const u8, body: Value) ![]u8 {
        return s.vt.chainAppend(s.ctx, a, origin, body);
    }
    pub fn chainTip(s: Store, a: std.mem.Allocator, origin: []const u8) !?[]u8 {
        return s.vt.chainTip(s.ctx, a, origin);
    }
    pub fn chainUpdates(s: Store, a: std.mem.Allocator, origin: []const u8) !?[][]u8 {
        return s.vt.chainUpdates(s.ctx, a, origin);
    }
    pub fn logAppend(s: Store, a: std.mem.Allocator, entry: Value) !AppendResult {
        return s.vt.logAppend(s.ctx, a, entry);
    }
    pub fn logTip(s: Store, a: std.mem.Allocator) !?[]u8 {
        return s.vt.logTip(s.ctx, a);
    }
    pub fn logFrom(s: Store, a: std.mem.Allocator, from: i64) ![][]u8 {
        return s.vt.logFrom(s.ctx, a, from);
    }
    pub fn byEnvelope(s: Store, a: std.mem.Allocator, envelope: []const u8) !?[]u8 {
        const c = (try s.vt.logByUnique(s.ctx, a, envelope)) orelse return null;
        const e = (try s.get(a, c)) orelse return null;
        return if (e.get("envelope") != null) c else null;
    }
    pub fn outcomeOf(s: Store, a: std.mem.Allocator, emit: []const u8) !?[]u8 {
        const c = (try s.vt.logByUnique(s.ctx, a, emit)) orelse return null;
        const e = (try s.get(a, c)) orelse return null;
        return if (e.get("outcome") != null) c else null;
    }
    pub fn resting(s: Store, a: std.mem.Allocator) ![][]u8 {
        return s.vt.resting(s.ctx, a);
    }
    pub fn awaiting(s: Store, a: std.mem.Allocator, envelope: []const u8) ![][]u8 {
        return s.vt.awaiting(s.ctx, a, envelope);
    }
    pub fn threads(s: Store, a: std.mem.Allocator) ![][]u8 {
        return s.vt.threads(s.ctx, a);
    }
    pub fn cursorGet(s: Store) !i64 {
        return s.vt.cursorGet(s.ctx);
    }
    pub fn cursorSet(s: Store, n: i64) !void {
        return s.vt.cursorSet(s.ctx, n);
    }
};
