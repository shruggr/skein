// BRC-104's HTTP framing (#126, #157): the payloads a request and a response
// sign — @bsv/sdk's SimplifiedFetchTransport's, as the front door's server side
// (skein-sdk lib/brc104.zig) — which the door checks: kernel.brc104 a request's
// signature, door.zig deliveryAnswer the answer to a `deliver` intention.
// Before #157 this file was also the kernel's in-step BRC-103/104 client (the
// `authfetch` import); that is gone: the host carries a delivery's exchange
// (a step never waits on the outside world), and a log that made an authfetch
// replays it from its witness (scheduler.zig hAuthfetch).
const std = @import("std");
const cbor = @import("cbor");
const Value = cbor.Value;

pub const AUTH_PROTOCOL = "auth message signature";
pub const NONCE_PROTOCOL = "server hmac";
pub const WELL_KNOWN = "/.well-known/auth";
pub const VERSION = "0.1";

pub const Header = struct { name: []const u8, value: []const u8 };

// ---------------------------------------------------------------- the HTTP framing (SimplifiedFetchTransport)

fn varint(w: *std.array_list.Managed(u8), v: u64) !void {
    if (v < 0xfd) {
        try w.append(@intCast(v));
    } else if (v <= 0xffff) {
        try w.append(0xfd);
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, @intCast(v), .little);
        try w.appendSlice(&b);
    } else if (v <= 0xffff_ffff) {
        try w.append(0xfe);
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @intCast(v), .little);
        try w.appendSlice(&b);
    } else {
        try w.append(0xff);
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, v, .little);
        try w.appendSlice(&b);
    }
}

fn writeField(w: *std.array_list.Managed(u8), s: []const u8) !void {
    if (s.len == 0) return varint(w, std.math.maxInt(u64)); // -1: absent
    try varint(w, s.len);
    try w.appendSlice(s);
}

pub fn lessHeader(_: void, x: Header, y: Header) bool {
    return std.mem.order(u8, x.name, y.name) == .lt;
}

/// The headers a request signs: x-bsv-* (not x-bsv-auth*), content-type (its media type only) and authorization; lower-cased, sorted.
fn signedRequestHeaders(a: std.mem.Allocator, headers: []const Header) ![]Header {
    var out = std.array_list.Managed(Header).init(a);
    for (headers) |h| {
        const k = try std.ascii.allocLowerString(a, h.name);
        var v = h.value;
        if (std.mem.eql(u8, k, "content-type")) v = std.mem.trim(u8, v[0 .. std.mem.indexOfScalar(u8, v, ';') orelse v.len], " ");
        if ((std.mem.startsWith(u8, k, "x-bsv-") or std.mem.eql(u8, k, "content-type") or std.mem.eql(u8, k, "authorization")) and !std.mem.startsWith(u8, k, "x-bsv-auth")) try out.append(.{ .name = k, .value = v });
    }
    std.mem.sort(Header, out.items, {}, lessHeader);
    return out.items;
}

/// The payload a request signs: requestId (32 bytes), method, path, query, the signed headers, the body.
pub fn requestPayload(a: std.mem.Allocator, request_id: []const u8, method: []const u8, path: []const u8, query: []const u8, headers: []const Header, body: []const u8) ![]u8 {
    var w = std.array_list.Managed(u8).init(a);
    try w.appendSlice(request_id);
    try varint(&w, method.len);
    try w.appendSlice(method);
    try writeField(&w, path);
    try writeField(&w, query);
    const signed = try signedRequestHeaders(a, headers);
    try varint(&w, signed.len);
    for (signed) |h| {
        try varint(&w, h.name.len);
        try w.appendSlice(h.name);
        try varint(&w, h.value.len);
        try w.appendSlice(h.value);
    }
    try writeField(&w, body);
    return w.toOwnedSlice();
}

/// The payload a response signs: requestId, status, the signed headers, the body.
pub fn responsePayload(a: std.mem.Allocator, request_id: []const u8, status: u64, headers: []const Header, body: []const u8) ![]u8 {
    var w = std.array_list.Managed(u8).init(a);
    try w.appendSlice(request_id);
    try varint(&w, status);
    try varint(&w, headers.len);
    for (headers) |h| {
        try varint(&w, h.name.len);
        try w.appendSlice(h.name);
        try varint(&w, h.value.len);
        try w.appendSlice(h.value);
    }
    try writeField(&w, body);
    return w.toOwnedSlice();
}

pub fn headerOf(hs: []const Header, name: []const u8) ?[]const u8 {
    for (hs) |h| if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
    return null;
}





/// A header map ({name: text}) as a list.
pub fn headerList(a: std.mem.Allocator, v: ?Value) ![]Header {
    const m = v orelse return &.{};
    if (m != .map) return &.{};
    var out = std.array_list.Managed(Header).init(a);
    for (m.map) |e| if (Value.str(e.value)) |s| try out.append(.{ .name = e.key, .value = s });
    return out.items;
}

test "authfetch: the request payload is SimplifiedFetchTransport's (lower-cased signed headers, sorted; an absent field is -1)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rid = [_]u8{7} ** 32;
    const p = try requestPayload(a, &rid, "POST", "/a/sendMessage", "", &.{
        .{ .name = "Content-Type", .value = "application/cbor; charset=x" },
        .{ .name = "x-bsv-topic", .value = "t" },
        .{ .name = "x-bsv-auth-nonce", .value = "skipped" },
        .{ .name = "accept", .value = "skipped" },
    }, "hi");
    var want_ = std.array_list.Managed(u8).init(a);
    try want_.appendSlice(&rid);
    try want_.appendSlice(&.{4});
    try want_.appendSlice("POST");
    try want_.appendSlice(&.{14});
    try want_.appendSlice("/a/sendMessage");
    try want_.appendSlice(&.{ 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff }); // no query: -1
    try want_.appendSlice(&.{2});
    try want_.appendSlice(&.{12});
    try want_.appendSlice("content-type");
    try want_.appendSlice(&.{16});
    try want_.appendSlice("application/cbor");
    try want_.appendSlice(&.{11});
    try want_.appendSlice("x-bsv-topic");
    try want_.appendSlice(&.{1});
    try want_.appendSlice("t");
    try want_.appendSlice(&.{2});
    try want_.appendSlice("hi");
    try std.testing.expectEqualSlices(u8, want_.items, p);
}
