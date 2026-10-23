//! sync-demo (shruggr/skein#154): a test program standing in for the overlay
//! engine's fn `sync` (shruggr/skein-overlay#5) — a filter on the libp2p row
//! /skein/overlay/sync/1.0.0 that answers each frame at the door, nothing
//! logged. kernel-zig/test/p2p/build-sync.sh builds it into
//! kernel-zig/test/p2p/sync-demo.wasm (committed; src/host/sync.test.ts runs it).
//!
//! Called as a filter (kind "call", fn "sync"): the argument is the door's
//! {transport: "libp2p", request: {kind: "p2p-frame", protocol, from, body}, match, principal?};
//! the frame (request.body) is dag-cbor {kind, topic, txid?}. Its answers are canned, from the
//! app record at `<app>/app` (`match.app`; the manifest's config, JSON): config.sync = {locator:
//! <frame hex>, admitted: <frame hex>, tx: {<txid>: <frame hex>}} — a tx not listed: {kind: "tx", txid} (not held);
//! a kind with no answer: {kind: "error", message}. A frame of kind "refuse" is rejected (400).
//! Each answer: {answer: {status: 200, type: "application/cbor", body: <the frame>}}.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

pub fn main() u8 {
    return sk.main("sync-demo", run);
}

fn frame(a: Allocator, es: []const cbor.Entry) ![]u8 {
    return cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, es) });
}

fn answerWith(a: Allocator, body: []const u8) !void {
    var ans = cbor.MapBuilder.init(a);
    try ans.put("status", cbor.int(200));
    try ans.put("type", cbor.string("application/cbor"));
    try ans.put("body", .{ .bytes = body });
    var m = cbor.MapBuilder.init(a);
    try m.put("answer", ans.value());
    return sk.answer(a, m.value());
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "call")) return sk.report("sync-demo is only called (a filter)");
    if (!eql(u8, Value.str(in.get("fn")) orelse "", "sync")) return sk.report("unknown fn (sync)");
    const arg = try cbor.decode(a, Value.bytesOf(in.get("arg")) orelse "");
    const req = arg.get("request") orelse return sk.report("no request");
    const app = if (arg.get("match")) |m| Value.str(m.get("app")) orelse "sdemo" else "sdemo";
    const f = cbor.decode(a, Value.bytesOf(req.get("body")) orelse "") catch
        return answerWith(a, try frame(a, &.{ .{ .key = "kind", .value = cbor.string("error") }, .{ .key = "message", .value = cbor.string("not dag-cbor") } }));
    const kind = Value.str(f.get("kind")) orelse "";
    if (eql(u8, kind, "refuse")) {
        var rej = cbor.MapBuilder.init(a);
        try rej.put("status", cbor.int(400));
        try rej.put("code", cbor.string("ERR_SYNC"));
        try rej.put("reason", cbor.string("refused"));
        var m = cbor.MapBuilder.init(a);
        try m.put("reject", rej.value());
        return sk.answer(a, m.value());
    }
    const root = (try sk.head(a, try std.fmt.allocPrint(a, "{s}/app", .{app}))) orelse return sk.report("no app record");
    const rec = try sk.get(a, root);
    const answers = if (rec.get("config")) |c| c.get("sync") else null;
    if (eql(u8, kind, "tx")) {
        const txid = Value.str(f.get("txid")) orelse "";
        if (answers) |x| if (x.get("tx")) |t| if (Value.str(t.get(txid))) |h| return answerWith(a, sk.unhex(a, h) orelse return sk.report("config.sync: not hex"));
        return answerWith(a, try frame(a, &.{ .{ .key = "kind", .value = cbor.string("tx") }, .{ .key = "txid", .value = cbor.string(txid) } }));
    }
    if (answers) |x| if (Value.str(x.get(kind))) |h| return answerWith(a, sk.unhex(a, h) orelse return sk.report("config.sync: not hex"));
    return answerWith(a, try frame(a, &.{ .{ .key = "kind", .value = cbor.string("error") }, .{ .key = "message", .value = cbor.string(try std.fmt.allocPrint(a, "no request {s}", .{kind})) } }));
}
