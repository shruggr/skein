// Named heads (#77: one of the kernel's four tables): a chain per name,
// origin {kind: "head", name}, one update per move {tree, owner, thread,
// input, at}. `owner` is the app the name belongs to (ownerOf): the text
// before the first `/`, or the whole name (`main`, `wallet`, `peers`). A
// program may advance only the heads in its write scope (scheduler.zig
// hAdvance): an app's are `<app>/…`; a genesis-wired program's are what the
// genesis's `scopes` name; the kernel's own operations write the rest.
const std = @import("std");
const cbor = @import("cbor");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub fn isHeadName(s: []const u8) bool {
    if (s.len == 0) return false;
    return !hasSpaceOrNul(s);
}

/// JavaScript's /[\s\0]/ over the UTF-8 string.
pub fn hasSpaceOrNul(s: []const u8) bool {
    var it = std.unicode.Utf8View.initUnchecked(s).iterator();
    while (it.nextCodepoint()) |c| if (c == 0 or isJsSpace(c)) return true;
    return false;
}

/// ECMAScript WhiteSpace + LineTerminator (what \s and trim() match).
pub fn isJsSpace(c: u21) bool {
    return switch (c) {
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        0x2000...0x200a => true,
        else => false,
    };
}

fn originValue(a: std.mem.Allocator, name: []const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("head"));
    try m.put("name", cbor.string(name));
    return m.value();
}

pub fn headOrigin(a: std.mem.Allocator, name: []const u8) ![]u8 {
    return cbor.cidOfValue(a, try originValue(a, name));
}

/// The tree a head names now, or null if it never moved (the index's `heads` map).
pub fn headTree(a: std.mem.Allocator, s: Store, name: []const u8) !?[]const u8 {
    return s.headTree(a, name);
}

/// The app a head's name belongs to (#77): `<app>/<rest>` → `<app>`; a bare name is its own.
pub fn ownerOf(name: []const u8) []const u8 {
    return name[0 .. std.mem.indexOfScalar(u8, name, '/') orelse name.len];
}

/// `thread` null: moved by the genesis (a system tree, issue #4) or by a kernel operation (#77), not by a thread.
pub const By = struct { thread: ?[]const u8, input: []const u8, at: i64 };

pub fn advanceHead(a: std.mem.Allocator, s: Store, name: []const u8, tree: []const u8, by: By) ![]const u8 {
    const origin = try s.chainOpen(a, try originValue(a, name));
    const tip = (try s.chainTip(a, origin)).?;
    if (!std.mem.eql(u8, tip, origin)) {
        const u = (try s.get(a, tip)).?;
        if (Value.cidOf(u.get("tree"))) |t| if (std.mem.eql(u8, t, tree)) return tip;
    }
    var m = cbor.MapBuilder.init(a);
    try m.put("tree", cbor.cidv(tree));
    try m.put("owner", cbor.string(ownerOf(name)));
    try m.put("thread", cbor.optCid(by.thread));
    try m.put("input", cbor.cidv(by.input));
    try m.put("at", cbor.int(by.at));
    return s.chainAppend(a, origin, m.value());
}
