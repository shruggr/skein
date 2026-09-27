// JavaScript's JSON as the TypeScript kernel writes it: JSON.stringify of a
// string (error messages quote names with it), Number::toString, and RFC 8785
// (JCS) canonical JSON over a dag-cbor value (envelope.ts `jcs`).
const std = @import("std");
const cbor = @import("cbor.zig");

const Out = std.array_list.Managed(u8);

/// JSON.stringify(s) for a well-formed string.
pub fn quote(out: *Out, s: []const u8) !void {
    try out.append('"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice("\\\""),
            '\\' => try out.appendSlice("\\\\"),
            0x08 => try out.appendSlice("\\b"),
            0x0c => try out.appendSlice("\\f"),
            '\n' => try out.appendSlice("\\n"),
            '\r' => try out.appendSlice("\\r"),
            '\t' => try out.appendSlice("\\t"),
            0...0x07, 0x0b, 0x0e...0x1f => {
                const hex = "0123456789abcdef";
                try out.appendSlice(&.{ '\\', 'u', '0', '0', hex[c >> 4], hex[c & 15] });
            },
            else => try out.append(c),
        }
    }
    try out.append('"');
}

pub fn quoted(alloc: std.mem.Allocator, s: []const u8) ![]u8 {
    var out = Out.init(alloc);
    try quote(&out, s);
    return out.toOwnedSlice();
}

/// ECMAScript Number::toString(10).
pub fn number(out: *Out, f: f64) !void {
    if (f == 0) return out.append('0');
    if (std.math.isNan(f)) return out.appendSlice("NaN");
    if (std.math.isInf(f)) return out.appendSlice(if (f < 0) "-Infinity" else "Infinity");
    const fl = std.fmt.float;
    const d = fl.binaryToDecimal(u64, @as(u64, @bitCast(f)), std.math.floatMantissaBits(f64), std.math.floatExponentBits(f64), false, &fl.Backend64_TablesFull);
    var m = d.mantissa;
    var e = d.exponent;
    while (m != 0 and m % 10 == 0) {
        m /= 10;
        e += 1;
    }
    var digits_buf: [24]u8 = undefined;
    const digits = std.fmt.bufPrint(&digits_buf, "{d}", .{m}) catch unreachable;
    const k: i32 = @intCast(digits.len);
    const n: i32 = e + k;
    if (d.sign) try out.append('-');
    if (k <= n and n <= 21) {
        try out.appendSlice(digits);
        var i: i32 = 0;
        while (i < n - k) : (i += 1) try out.append('0');
    } else if (0 < n and n <= 21) {
        try out.appendSlice(digits[0..@intCast(n)]);
        try out.append('.');
        try out.appendSlice(digits[@intCast(n)..]);
    } else if (-6 < n and n <= 0) {
        try out.appendSlice("0.");
        var i: i32 = 0;
        while (i < -n) : (i += 1) try out.append('0');
        try out.appendSlice(digits);
    } else {
        try out.append(digits[0]);
        if (k > 1) {
            try out.append('.');
            try out.appendSlice(digits[1..]);
        }
        try out.append('e');
        const x = n - 1;
        try out.append(if (x < 0) '-' else '+');
        var b: [12]u8 = undefined;
        try out.appendSlice(std.fmt.bufPrint(&b, "{d}", .{@abs(x)}) catch unreachable);
    }
}

fn utf16Less(_: void, a: cbor.Entry, b: cbor.Entry) bool {
    return utf16Order(a.key, b.key) == .lt;
}

/// Order strings by UTF-16 code units, as JavaScript's default sort does.
pub fn utf16Order(a: []const u8, b: []const u8) std.math.Order {
    var ia = std.unicode.Utf8View.initUnchecked(a).iterator();
    var ib = std.unicode.Utf8View.initUnchecked(b).iterator();
    while (true) {
        const ca = ia.nextCodepoint();
        const cb = ib.nextCodepoint();
        if (ca == null and cb == null) return .eq;
        if (ca == null) return .lt;
        if (cb == null) return .gt;
        if (ca.? == cb.?) continue;
        const ua = unit(ca.?);
        const ub = unit(cb.?);
        if (ua != ub) return std.math.order(ua, ub);
        return std.math.order(ca.?, cb.?);
    }
}

fn unit(c: u21) u32 {
    return if (c >= 0x10000) 0xD800 + ((c - 0x10000) >> 10) else c;
}

/// RFC 8785 over a value; bytes and CIDs are not JSON.
pub fn jcs(out: *Out, v: cbor.Value) !void {
    switch (v) {
        .null => try out.appendSlice("null"),
        .bool => |b| try out.appendSlice(if (b) "true" else "false"),
        .int => |i| {
            var b: [48]u8 = undefined;
            if (i >= -cbor.max_safe and i <= cbor.max_safe) {
                try out.appendSlice(std.fmt.bufPrint(&b, "{d}", .{i}) catch unreachable);
            } else {
                try number(out, @floatFromInt(i));
            }
        },
        .float => |f| try number(out, f),
        .string => |s| try quote(out, s),
        .array => |a| {
            try out.append('[');
            for (a, 0..) |x, i| {
                if (i > 0) try out.append(',');
                try jcs(out, x);
            }
            try out.append(']');
        },
        .map => |m| {
            const sorted = try out.allocator.dupe(cbor.Entry, m);
            defer out.allocator.free(sorted);
            std.mem.sort(cbor.Entry, sorted, {}, utf16Less);
            try out.append('{');
            for (sorted, 0..) |e, i| {
                if (i > 0) try out.append(',');
                try quote(out, e.key);
                try out.append(':');
                try jcs(out, e.value);
            }
            try out.append('}');
        },
        .bytes, .cid => return error.NotJson,
    }
}

test "number formatting" {
    var out = Out.init(std.testing.allocator);
    defer out.deinit();
    const cases = [_]struct { f64, []const u8 }{
        .{ 1.5, "1.5" },       .{ 0.1, "0.1" },        .{ 1e21, "1e+21" }, .{ 1e20, "100000000000000000000" },
        .{ 1.5e-7, "1.5e-7" }, .{ 0.000001, "0.000001" }, .{ -2.25, "-2.25" }, .{ 123456.789, "123456.789" },
    };
    for (cases) |c| {
        out.clearRetainingCapacity();
        try number(&out, c[0]);
        try std.testing.expectEqualStrings(c[1], out.items);
    }
}
