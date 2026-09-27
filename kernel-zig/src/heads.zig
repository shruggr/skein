// Named heads (src/runtime/heads.ts): a chain per name, origin {kind: "head",
// name}, one update per move {tree, thread, input, at}.
const std = @import("std");
const cbor = @import("cbor.zig");
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

/// The tree a head names now, or null if it never moved.
pub fn headTree(a: std.mem.Allocator, s: Store, name: []const u8) !?[]const u8 {
    const origin = try headOrigin(a, name);
    const tip = (try s.chainTip(a, origin)) orelse return null;
    if (std.mem.eql(u8, tip, origin)) return null;
    const u = (try s.get(a, tip)) orelse return error.NotFound;
    return Value.cidOf(u.get("tree"));
}

pub const By = struct { thread: []const u8, input: []const u8, at: i64 };

pub fn advanceHead(a: std.mem.Allocator, s: Store, name: []const u8, tree: []const u8, by: By) ![]const u8 {
    const origin = try s.chainOpen(a, try originValue(a, name));
    const tip = (try s.chainTip(a, origin)).?;
    if (!std.mem.eql(u8, tip, origin)) {
        const u = (try s.get(a, tip)).?;
        if (Value.cidOf(u.get("tree"))) |t| if (std.mem.eql(u8, t, tree)) return tip;
    }
    var m = cbor.MapBuilder.init(a);
    try m.put("tree", cbor.cidv(tree));
    try m.put("thread", cbor.cidv(by.thread));
    try m.put("input", cbor.cidv(by.input));
    try m.put("at", cbor.int(by.at));
    return s.chainAppend(a, origin, m.value());
}
