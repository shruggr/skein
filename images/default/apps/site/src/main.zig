//! site (shruggr/skein#125, #143): the management site as an app. One filter:
//! the kernel's door calls its fn "get" (the manifest's filter `get`) with
//! each request on a read route that lists it — the request's fields and the
//! route that matched (`match`) — and it answers the file from the app's own
//! tree — the `tree` of its app record, the root of the head `site/app` —
//! with the SDK's `files.serve` under the route's `root` (`www`), as the
//! filter answer `{answer: {status, type, headers, body}}`.
//!
//!   the app's route  {transport: "http", address: "/", prefix: true, filters: ["get"], root: "www"}
//!                    a read route (no handler): /site/… (the install's namespacing)
//!   root's route     {transport: "http", address: "/", prefix: true, filters: ["site.get"], root: "www"}
//!                    optional (the default image has it): the site at the instance's root
//!
//! A read: it puts nothing, moves no head, and nothing is logged. No head
//! `site/app` (or a root that is not an app record): every path is a 404.
//! What `files.serve` answers (index, 301 for a directory without its `/`,
//! ETag/304, 404, 405) is skein-sdk's `lib/files.zig`.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const files = @import("files");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

/// The app's name: its root head is `site/app`.
pub const NAME = "site";

pub fn main() u8 {
    return sk.main(NAME, run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const req = (try requestOf(a, in)) orelse return sk.report(why(in));
    return sk.answer(a, try filterAnswer(a, try files.serve(a, req, try treeOf(a), files.rowOptions(req))));
}

/// A read route's answer as its filter gives it (#143, skein docs/APPS.md §2 "Filters"):
/// `{answer: <the response>}` — the request ends with it, and nothing is logged.
pub fn filterAnswer(a: Allocator, response: Value) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("answer", response);
    return m.value();
}

/// The request a filter call carries (`kind: "call"`, fn "get", `arg` its dag-cbor: {transport,
/// request, match, method, path, route, query, headers, body, …}), or null.
fn requestOf(a: Allocator, in: Value) !?Value {
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "call")) return null;
    if (!eql(u8, Value.str(in.get("fn")) orelse "", "get")) return null;
    return cbor.decode(a, Value.bytesOf(in.get("arg")) orelse return null) catch null;
}

fn why(in: Value) []const u8 {
    if (!eql(u8, Value.str(in.get("kind")) orelse "", "call")) return "site is a read route's filter: it is called (fn \"get\"), never stepped";
    if (!eql(u8, Value.str(in.get("fn")) orelse "", "get")) return "unknown fn (site answers \"get\")";
    return "the argument is not dag-cbor";
}

/// The app's own git tree: the `tree` of the root record of `site/app`, or null.
fn treeOf(a: Allocator) !?[]const u8 {
    const root = (try sk.head(a, NAME ++ "/app")) orelse return null;
    return treeIn(try sk.get(a, root));
}

/// An app record's tree (`kind: "app"`), or null.
pub fn treeIn(record: Value) ?[]const u8 {
    if (!eql(u8, Value.str(record.get("kind")) orelse "", "app")) return null;
    return Value.cidOf(record.get("tree"));
}

// ---------------------------------------------------------------- tests

const t = std.testing;

fn callInput(a: Allocator, kind: []const u8, func: []const u8, arg: []const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string(kind));
    try m.put("fn", cbor.string(func));
    try m.put("arg", .{ .bytes = arg });
    return m.value();
}

test "a call to get carries the request" {
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var r = cbor.MapBuilder.init(a);
    try r.put("method", cbor.string("GET"));
    try r.put("route", cbor.string("/site/app.js"));
    const req = (try requestOf(a, try callInput(a, "call", "get", try cbor.encode(a, r.value())))).?;
    try t.expectEqualStrings("/site/app.js", Value.str(req.get("route")).?);
}

test "anything else is refused, and says why" {
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const stepped = try callInput(a, "message", "get", "");
    try t.expect((try requestOf(a, stepped)) == null);
    try t.expect(std.mem.indexOf(u8, why(stepped), "never stepped") != null);
    const other = try callInput(a, "call", "put", "");
    try t.expect((try requestOf(a, other)) == null);
    try t.expect(std.mem.indexOf(u8, why(other), "unknown fn") != null);
    const junk = try callInput(a, "call", "get", "\xff\xff");
    try t.expect((try requestOf(a, junk)) == null);
    try t.expectEqualStrings("the argument is not dag-cbor", why(junk));
}

test "the tree is the app record's" {
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cid = [_]u8{ 0x01, 0x78, 0x11, 0x14 } ++ [_]u8{0xab} ** 20;
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("app"));
    try m.put("tree", .{ .cid = &cid });
    try t.expectEqualSlices(u8, &cid, treeIn(m.value()).?);
    var n = cbor.MapBuilder.init(a);
    try n.put("kind", cbor.string("program"));
    try n.put("tree", .{ .cid = &cid });
    try t.expect(treeIn(n.value()) == null);
}

test "a filter's answer wraps the response" {
    var arena = std.heap.ArenaAllocator.init(t.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var r = cbor.MapBuilder.init(a);
    try r.put("status", cbor.int(404));
    const out = try filterAnswer(a, r.value());
    try t.expectEqual(@as(i128, 404), Value.intOf(out.get("answer").?.get("status")).?);
}

test "the paths under the app's route and root's (skein-sdk lib/files.zig)" {
    try t.expectEqualStrings("app.js", files.restOf("/site/app.js", "/site/").?);
    try t.expectEqualStrings("", files.restOf("/site/", "/site/").?);
    try t.expect(files.restOf("/sitemap.xml", "/site/") == null);
    // Root's route at the instance's root: the same files.
    try t.expectEqualStrings("app.js", files.restOf("/app.js", "/").?);
}
