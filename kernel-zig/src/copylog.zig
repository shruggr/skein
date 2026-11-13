// log.ts copyLog (skein next): a log's entries exactly as written into another store, with the
// records they name — what `skein-kernel replay` (replay.zig) and the browser build's replay
// (web.zig) run before a runtime with no wallet processes the log again. A replay needs no signer
// and no re-verification: each request and event entry carries its `door` (what CHECK established),
// so the records it names and the blocks its checks stored are copied beside it, and the step runs
// from them.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const logm = @import("log.zig");
const tree = @import("tree.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub fn copyLog(a: std.mem.Allocator, src: Store, dst: Store) !void {
    const g = try logm.genesisOf(a, src);
    // The system tree the genesis booted from (issue #4): pre-filled, not carried by any entry.
    if (Value.cidOf(g.get("tree"))) |t| try copyTree(a, src, dst, t);
    // #141: the records the genesis's heads name (an image's installed apps), pre-filled too: each
    // record and every record it links (program records); git trees and raw modules as above.
    if (g.get("heads")) |hs| if (hs == .map) for (hs.map) |h| if (Value.cidOf(h.value)) |c| try copyRecords(a, src, dst, c);
    for (try src.logFrom(a, 0)) |c| {
        const e = (try src.get(a, c)) orelse return error.NotFound;
        if (!logm.isLogEntry(e)) return error.BadSignature; // not a format-12 entry
        for ([_][]const u8{ "genesis", "event", "request" }) |k| if (Value.cidOf(e.get(k))) |x| {
            const b = (try src.bytes(a, x)) orelse return error.NotFound;
            try dst.putBlock(x, b);
        };
        // #156: a `chain` event names the host chain's record: it and the blocks it reaches (its map
        // nodes, its headers), as the source reads them (the host/chain exception), beside it.
        if (Value.cidOf(e.get("event"))) |x| if (src.getOpt(a, x)) |ev| if (std.mem.eql(u8, Value.str(ev.get("kind")) orelse "", "chain")) {
            if (Value.cidOf(ev.get("root"))) |root| try copyHostChain(a, src, dst, root);
        };
        // What CHECK established: the blocks the checks stored, the package as they handed it back.
        if (e.get("door")) |d| if (d == .map) {
            if (d.get("blocks")) |bs| if (bs == .array) for (bs.array) |b| if (Value.cidOf(b)) |bc| {
                const bytes = (try src.bytes(a, bc)) orelse return error.NotFound;
                try dst.putBlock(bc, bytes);
            };
            for ([_][]const u8{ "request", "event" }) |k| if (Value.cidOf(d.get(k))) |x| {
                const b = (try src.bytes(a, x)) orelse return error.NotFound;
                try dst.putBlock(x, b);
            };
        };
        switch (try dst.logAppend(a, e)) {
            .ok => |got| if (!std.mem.eql(u8, got, c)) return error.CopiedToDifferentCid,
            .rejected => return error.Rejected,
        }
    }
}

/// The host chain record `c` (#156) and every block it reaches — dag-cbor nodes and the headers
/// (bitcoin-block) they link — not already in `dst` (a subtree held is held whole).
fn copyHostChain(a: std.mem.Allocator, src: Store, dst: Store, c: []const u8) anyerror!void {
    if (try dst.has(c)) return;
    const b = (try src.bytes(a, c)) orelse return error.NotFound;
    try dst.putBlock(c, b);
    if (cidm.codecOf(c) != cidm.DAG_CBOR) return;
    try copyChainLinks(a, src, dst, cbor.decode(a, b) catch return);
}

fn copyChainLinks(a: std.mem.Allocator, src: Store, dst: Store, v: Value) anyerror!void {
    switch (v) {
        .cid => |c| try copyHostChain(a, src, dst, c),
        .array => |xs| for (xs) |x| try copyChainLinks(a, src, dst, x),
        .map => |es| for (es) |e| try copyChainLinks(a, src, dst, e.value),
        else => {},
    }
}

/// A dag-cbor record and every record it links, as the source holds them (git trees by copyTree;
/// raw blocks — modules — are the caller's to copy whole before).
fn copyRecords(a: std.mem.Allocator, src: Store, dst: Store, c: []const u8) anyerror!void {
    const codec = cidm.codecOf(c);
    if (codec == cidm.GIT_RAW) return copyTree(a, src, dst, c);
    if (codec != cidm.DAG_CBOR or try dst.has(c)) return;
    const b = (try src.bytes(a, c)) orelse return error.NotFound;
    try dst.putBlock(c, b);
    try copyLinks(a, src, dst, cbor.decode(a, b) catch return);
}

fn copyLinks(a: std.mem.Allocator, src: Store, dst: Store, v: Value) anyerror!void {
    switch (v) {
        .cid => |c| try copyRecords(a, src, dst, c),
        .array => |xs| for (xs) |x| try copyLinks(a, src, dst, x),
        .map => |es| for (es) |e| try copyLinks(a, src, dst, e.value),
        else => {},
    }
}

/// A git tree and everything under it (blobs, subtrees, gitlinked records the source holds).
fn copyTree(a: std.mem.Allocator, src: Store, dst: Store, t: []const u8) !void {
    if (try dst.has(t)) return;
    const b = (try src.bytes(a, t)) orelse return error.NotFound;
    try dst.putBlock(t, b);
    for (try tree.parseTree(a, b)) |e| switch (e.mode) {
        .dir => try copyTree(a, src, dst, e.cid),
        .module => if (try src.bytes(a, e.cid)) |x| try dst.putBlock(e.cid, x),
        else => if (!(try dst.has(e.cid))) try dst.putBlock(e.cid, (try src.bytes(a, e.cid)) orelse return error.NotFound),
    };
}
