// Outgoing HTTP (issue #15): the one recorded-call shape both ABIs use.
//
// A preview1 program's `skein.http` import hands the kernel this request as
// dag-cbor itself; a component's `wasi:http/outgoing-handler.handle`
// (component.zig) is serialized into it here. Either way the request goes to
// program.Host.http (the scheduler's hHttp: the host answers it, request and
// response are recorded on the step's update, replay reads the answer back),
// so there is one shape and one host handler:
//
//   request  {method, url, headers?, body?, options?}
//            method   "GET", "POST", … (a wasi:http `other` method as given)
//            url      scheme "://" authority path-with-query (scheme default
//                     https, path default "/")
//            headers  {name: value}: text; a name given more than once is one
//                     entry, its values joined with ", " (names keep the case
//                     the program wrote; grouping ignores case)
//            body     bytes, when the program wrote any (buffered whole)
//            options  {connectTimeout?, firstByteTimeout?, betweenBytesTimeout?}
//                     in nanoseconds, only when a request-options set one;
//                     recorded with the request, applied by the host
//   response {status, headers, body}
//            headers  {name: text} (a text array is taken as repeated values)
//            body     bytes (text is taken as its UTF-8)
const std = @import("std");
const cbor = @import("cbor.zig");

const Value = cbor.Value;

pub const Field = struct { name: []const u8, value: []const u8 };

/// A wasi:http `fields`: ordered (name, value) pairs; names compare without case.
pub const Fields = struct {
    list: std.array_list.Managed(Field),

    pub fn init(alloc: std.mem.Allocator) Fields {
        return .{ .list = std.array_list.Managed(Field).init(alloc) };
    }

    pub fn clone(f: *const Fields, alloc: std.mem.Allocator) !*Fields {
        const out = try alloc.create(Fields);
        out.* = init(alloc);
        try out.list.appendSlice(f.list.items);
        return out;
    }

    pub fn append(f: *Fields, name: []const u8, value: []const u8) !void {
        const a = f.list.allocator;
        try f.list.append(.{ .name = try a.dupe(u8, name), .value = try a.dupe(u8, value) });
    }

    pub fn delete(f: *Fields, name: []const u8) void {
        var i: usize = 0;
        while (i < f.list.items.len) {
            if (std.ascii.eqlIgnoreCase(f.list.items[i].name, name)) _ = f.list.orderedRemove(i) else i += 1;
        }
    }

    pub fn has(f: *const Fields, name: []const u8) bool {
        for (f.list.items) |e| if (std.ascii.eqlIgnoreCase(e.name, name)) return true;
        return false;
    }
};

/// RFC 9110's token: a field name.
pub fn validName(n: []const u8) bool {
    if (n.len == 0) return false;
    for (n) |ch| {
        const ok = std.ascii.isAlphanumeric(ch) or std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", ch) != null;
        if (!ok) return false;
    }
    return true;
}

/// A field value: no CR, LF or NUL.
pub fn validValue(v: []const u8) bool {
    for (v) |ch| if (ch == '\r' or ch == '\n' or ch == 0) return false;
    return true;
}

/// wasi:http's request-options, in nanoseconds.
pub const Options = struct {
    connect: ?u64 = null,
    first_byte: ?u64 = null,
    between_bytes: ?u64 = null,
};

pub const Request = struct {
    method: []const u8,
    scheme: []const u8,
    authority: []const u8,
    path: []const u8,
    headers: []const Field,
    body: ?[]const u8,
    options: Options = .{},
};

/// The recorded-call request's bytes (dag-cbor, canonical).
pub fn encodeRequest(alloc: std.mem.Allocator, r: Request) ![]u8 {
    var m = cbor.MapBuilder.init(alloc);
    try m.put("method", cbor.string(r.method));
    try m.put("url", cbor.string(try std.mem.concat(alloc, u8, &.{ r.scheme, "://", r.authority, r.path })));
    if (r.headers.len > 0) {
        var names = std.array_list.Managed([]const u8).init(alloc);
        var values = std.array_list.Managed(std.array_list.Managed(u8)).init(alloc);
        for (r.headers) |h| {
            const at = for (names.items, 0..) |n, i| {
                if (std.ascii.eqlIgnoreCase(n, h.name)) break i;
            } else blk: {
                try names.append(h.name);
                try values.append(std.array_list.Managed(u8).init(alloc));
                break :blk names.items.len - 1;
            };
            const v = &values.items[at];
            if (v.items.len > 0) try v.appendSlice(", ");
            try v.appendSlice(h.value);
        }
        var hm = cbor.MapBuilder.init(alloc);
        for (names.items, values.items) |n, v| try hm.put(n, cbor.string(try cbor.utf8Fix(alloc, v.items)));
        try m.put("headers", hm.value());
    }
    if (r.body) |b| if (b.len > 0) try m.put("body", .{ .bytes = b });
    const o = r.options;
    if (o.connect != null or o.first_byte != null or o.between_bytes != null) {
        var om = cbor.MapBuilder.init(alloc);
        if (o.connect) |x| try om.put("connectTimeout", cbor.int(x));
        if (o.first_byte) |x| try om.put("firstByteTimeout", cbor.int(x));
        if (o.between_bytes) |x| try om.put("betweenBytesTimeout", cbor.int(x));
        try m.put("options", om.value());
    }
    return cbor.encode(alloc, m.value());
}

pub const Response = struct { status: u16, headers: []const Field, body: []const u8 };

/// The recorded-call response; null if it is not {status, headers?, body?}.
pub fn decodeResponse(alloc: std.mem.Allocator, bytes: []const u8) !?Response {
    const v = cbor.decode(alloc, bytes) catch return null;
    if (v != .map) return null;
    const st = Value.intOf(v.get("status")) orelse return null;
    if (st < 100 or st > 999) return null;
    var hs = std.array_list.Managed(Field).init(alloc);
    if (v.get("headers")) |h| {
        if (h != .map) return null;
        for (h.map) |e| switch (e.value) {
            .string => |s| try hs.append(.{ .name = e.key, .value = s }),
            .array => |xs| for (xs) |x| {
                try hs.append(.{ .name = e.key, .value = Value.str(x) orelse return null });
            },
            else => return null,
        };
    }
    const body: []const u8 = if (v.get("body")) |b| switch (b) {
        .bytes => |x| x,
        .string => |x| x,
        .null => "",
        else => return null,
    } else "";
    return .{ .status = @intCast(st), .headers = hs.items, .body = body };
}

test "http: the recorded-call request — the pre-#15 shape, canonical" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const req = try encodeRequest(a, .{
        .method = "POST",
        .scheme = "https",
        .authority = "arc.test",
        .path = "/v1/tx",
        .headers = &.{ .{ .name = "Content-Type", .value = "application/octet-stream" }, .{ .name = "Accept", .value = "application/json" }, .{ .name = "accept", .value = "text/plain" } },
        .body = "beef",
    });
    // The same request made as the preview1 wallet makes it, keys in any order.
    var hm = cbor.MapBuilder.init(a);
    try hm.put("Accept", cbor.string("application/json, text/plain"));
    try hm.put("Content-Type", cbor.string("application/octet-stream"));
    var m = cbor.MapBuilder.init(a);
    try m.put("url", cbor.string("https://arc.test/v1/tx"));
    try m.put("body", .{ .bytes = "beef" });
    try m.put("headers", hm.value());
    try m.put("method", cbor.string("POST"));
    try std.testing.expectEqualSlices(u8, try cbor.encode(a, m.value()), req);

    // No headers, no body, options in ns.
    const get = try encodeRequest(a, .{ .method = "GET", .scheme = "http", .authority = "h:8080", .path = "/?q=1", .headers = &.{}, .body = "", .options = .{ .first_byte = 5_000_000_000 } });
    const v = try cbor.decode(a, get);
    try std.testing.expectEqualStrings("http://h:8080/?q=1", Value.str(v.get("url")).?);
    try std.testing.expect(v.get("headers") == null and v.get("body") == null);
    try std.testing.expectEqual(@as(i128, 5_000_000_000), Value.intOf(v.get("options").?.get("firstByteTimeout")).?);

    var rm = cbor.MapBuilder.init(a);
    try rm.put("status", cbor.int(200));
    var rh = cbor.MapBuilder.init(a);
    try rh.put("content-type", cbor.string("text/plain"));
    try rm.put("headers", rh.value());
    try rm.put("body", .{ .bytes = "hello" });
    const r = (try decodeResponse(a, try cbor.encode(a, rm.value()))).?;
    try std.testing.expectEqual(@as(u16, 200), r.status);
    try std.testing.expectEqualStrings("hello", r.body);
    try std.testing.expectEqualStrings("content-type", r.headers[0].name);
    try std.testing.expect((try decodeResponse(a, "\xa0")) == null);
}
