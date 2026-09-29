//! JSON as the loop reads a tool call's arguments and writes a tool result
//! (issue #54: the loop was Go, and the text of its tool turns is part of the
//! conversation's records, so it is kept as Go's encoding/json wrote it):
//! arguments decode into a fixed set of fields — keys matched without regard
//! to ASCII case, the last one winning — with Go's messages for a syntax
//! error and for a field of the wrong type; a result is marshalled with Go's
//! escaping (HTML characters and U+2028/2029 as \u escapes); `quote` is
//! strconv.Quote.
const std = @import("std");
const cbor = @import("cbor");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;

/// A parsed JSON value; numbers keep their literal.
pub const J = union(enum) {
    null,
    bool: bool,
    number: []const u8,
    string: []const u8,
    array: []const J,
    object: []const Member,

    fn kind(j: J) []const u8 {
        return switch (j) {
            .null => "null",
            .bool => "bool",
            .number => "number",
            .string => "string",
            .array => "array",
            .object => "object",
        };
    }
};
pub const Member = struct { key: []const u8, value: J };

/// A parse, or what Go's json.Unmarshal says is wrong with the text.
pub const Parsed = union(enum) { ok: J, err: []const u8 };

pub fn parse(a: Allocator, text: []const u8) !Parsed {
    var p = Parser{ .a = a, .s = text };
    p.ws();
    const v = p.value() catch |e| return switch (e) {
        error.Syntax => .{ .err = p.msg },
        error.OutOfMemory => error.OutOfMemory,
    };
    p.ws();
    if (p.i < p.s.len) {
        return switch (p.bad("after top-level value")) {
            error.Syntax => .{ .err = p.msg },
            error.OutOfMemory => error.OutOfMemory,
        };
    }
    return .{ .ok = v };
}

const Parser = struct {
    a: Allocator,
    s: []const u8,
    i: usize = 0,
    msg: []const u8 = "",

    fn ws(p: *Parser) void {
        while (p.i < p.s.len and (p.s[p.i] == ' ' or p.s[p.i] == '\t' or p.s[p.i] == '\n' or p.s[p.i] == '\r')) p.i += 1;
    }

    fn eof(p: *Parser) error{Syntax} {
        p.msg = "unexpected end of JSON input";
        return error.Syntax;
    }

    /// "invalid character <c> <context>" for the character at i (or the end of input).
    fn bad(p: *Parser, context: []const u8) error{ Syntax, OutOfMemory } {
        if (p.i >= p.s.len) return p.eof();
        p.msg = try std.fmt.allocPrint(p.a, "invalid character {s} {s}", .{ try quoteChar(p.a, p.s[p.i..]), context });
        return error.Syntax;
    }

    fn value(p: *Parser) error{ Syntax, OutOfMemory }!J {
        if (p.i >= p.s.len) return p.eof();
        switch (p.s[p.i]) {
            '{' => return p.object(),
            '[' => return p.array(),
            '"' => return .{ .string = try p.string() },
            '-', '0'...'9' => return .{ .number = try p.number() },
            't' => return p.literal("true", .{ .bool = true }),
            'f' => return p.literal("false", .{ .bool = false }),
            'n' => return p.literal("null", .null),
            else => return p.bad("looking for beginning of value"),
        }
    }

    fn literal(p: *Parser, word: []const u8, v: J) error{ Syntax, OutOfMemory }!J {
        p.i += 1;
        for (word[1..]) |c| {
            if (p.i >= p.s.len) return p.eof();
            if (p.s[p.i] != c) return p.bad(try std.fmt.allocPrint(p.a, "in literal {s} (expecting '{c}')", .{ word, c }));
            p.i += 1;
        }
        return v;
    }

    fn digit(p: *Parser) bool {
        return p.i < p.s.len and p.s[p.i] >= '0' and p.s[p.i] <= '9';
    }

    fn needDigit(p: *Parser) error{ Syntax, OutOfMemory }!void {
        if (!p.digit()) return p.bad("in numeric literal");
    }

    fn number(p: *Parser) error{ Syntax, OutOfMemory }![]const u8 {
        const start = p.i;
        if (p.s[p.i] == '-') {
            p.i += 1;
            try p.needDigit();
        }
        if (p.s[p.i] == '0') {
            p.i += 1;
        } else {
            while (p.digit()) p.i += 1;
        }
        if (p.i < p.s.len and p.s[p.i] == '.') {
            p.i += 1;
            try p.needDigit();
            while (p.digit()) p.i += 1;
        }
        if (p.i < p.s.len and (p.s[p.i] == 'e' or p.s[p.i] == 'E')) {
            p.i += 1;
            if (p.i < p.s.len and (p.s[p.i] == '+' or p.s[p.i] == '-')) p.i += 1;
            try p.needDigit();
            while (p.digit()) p.i += 1;
        }
        return p.s[start..p.i];
    }

    fn hex4(b: []const u8) ?u21 {
        var v: u21 = 0;
        for (b) |c| v = v * 16 + (std.fmt.charToDigit(c, 16) catch return null);
        return v;
    }

    fn badEscape(p: *Parser, seq: []const u8) error{ Syntax, OutOfMemory } {
        var printable = true;
        for (seq) |c| printable = printable and c >= 0x20 and c < 0x7f and c != '`';
        p.msg = if (printable)
            try std.fmt.allocPrint(p.a, "invalid escape sequence `{s}` in string", .{seq})
        else
            try std.fmt.allocPrint(p.a, "invalid escape sequence {s} in string", .{try quote(p.a, seq)});
        return error.Syntax;
    }

    fn string(p: *Parser) error{ Syntax, OutOfMemory }![]const u8 {
        p.i += 1; // the opening quote
        var out = std.array_list.Managed(u8).init(p.a);
        while (true) {
            if (p.i >= p.s.len) return p.eof();
            const c = p.s[p.i];
            if (c == '"') {
                p.i += 1;
                return out.items;
            }
            if (c < 0x20) return p.bad("in string");
            if (c != '\\') {
                try out.append(c);
                p.i += 1;
                continue;
            }
            if (p.i + 1 >= p.s.len) return p.eof();
            const e = p.s[p.i + 1];
            switch (e) {
                '"', '\\', '/' => try out.append(e),
                'b' => try out.append(8),
                'f' => try out.append(12),
                'n' => try out.append('\n'),
                'r' => try out.append('\r'),
                't' => try out.append('\t'),
                'u' => {
                    if (p.i + 6 > p.s.len) return p.eof();
                    var r = hex4(p.s[p.i + 2 .. p.i + 6]) orelse return p.badEscape(p.s[p.i .. p.i + 6]);
                    p.i += 6;
                    if (r >= 0xd800 and r < 0xdc00) {
                        // A high surrogate: a low one must follow, else U+FFFD.
                        if (p.i + 6 <= p.s.len and p.s[p.i] == '\\' and p.s[p.i + 1] == 'u') {
                            if (hex4(p.s[p.i + 2 .. p.i + 6])) |lo| if (lo >= 0xdc00 and lo < 0xe000) {
                                r = 0x10000 + ((r - 0xd800) << 10) + (lo - 0xdc00);
                                p.i += 6;
                            };
                        }
                        if (r < 0x10000) r = 0xfffd;
                    } else if (r >= 0xdc00 and r < 0xe000) r = 0xfffd;
                    var buf: [4]u8 = undefined;
                    const n = std.unicode.utf8Encode(r, &buf) catch unreachable;
                    try out.appendSlice(buf[0..n]);
                    continue;
                },
                else => return p.badEscape(p.s[p.i .. p.i + 2]),
            }
            p.i += 2;
        }
    }

    fn array(p: *Parser) error{ Syntax, OutOfMemory }!J {
        p.i += 1;
        var items = std.array_list.Managed(J).init(p.a);
        p.ws();
        if (p.i < p.s.len and p.s[p.i] == ']') {
            p.i += 1;
            return .{ .array = items.items };
        }
        while (true) {
            p.ws();
            try items.append(try p.value());
            p.ws();
            if (p.i >= p.s.len) return p.eof();
            switch (p.s[p.i]) {
                ',' => p.i += 1,
                ']' => {
                    p.i += 1;
                    return .{ .array = items.items };
                },
                else => return p.bad("after array element"),
            }
        }
    }

    fn object(p: *Parser) error{ Syntax, OutOfMemory }!J {
        p.i += 1;
        var members = std.array_list.Managed(Member).init(p.a);
        p.ws();
        if (p.i < p.s.len and p.s[p.i] == '}') {
            p.i += 1;
            return .{ .object = members.items };
        }
        while (true) {
            p.ws();
            if (p.i >= p.s.len) return p.eof();
            if (p.s[p.i] != '"') return p.bad("looking for beginning of object key string");
            const key = try p.string();
            p.ws();
            if (p.i >= p.s.len) return p.eof();
            if (p.s[p.i] != ':') return p.bad("after object key");
            p.i += 1;
            p.ws();
            try members.append(.{ .key = key, .value = try p.value() });
            p.ws();
            if (p.i >= p.s.len) return p.eof();
            switch (p.s[p.i]) {
                ',' => p.i += 1,
                '}' => {
                    p.i += 1;
                    return .{ .object = members.items };
                },
                else => return p.bad("after object key:value pair"),
            }
        }
    }
};

// ---------------------------------------------------------------- decoding into fields

/// A field of the Go struct the arguments decode into: text, or a present's
/// blocks ([]map[string]any).
pub const Field = struct { name: []const u8, blocks: bool = false };

/// What one field got: its text, or its blocks (a null entry is a block
/// that decoded from JSON null), and whether the key was there at all.
pub const Got = struct { text: []const u8 = "", blocks: ?[]const ?Value = null };

pub const Decoded = struct { got: []Got, err: ?[]const u8 };

/// json.Unmarshal(text, &struct{…fields}): each field's value and the first
/// error (a syntax error before anything is read). `type_name` is the Go
/// struct type as its message names it.
pub fn decode(a: Allocator, text: []const u8, fields: []const Field, type_name: []const u8) !Decoded {
    const got = try a.alloc(Got, fields.len);
    for (got) |*g| g.* = .{};
    const j = switch (try parse(a, text)) {
        .ok => |v| v,
        .err => |m| return .{ .got = got, .err = m },
    };
    var first: ?[]const u8 = null;
    switch (j) {
        .null => {},
        .object => |members| for (members) |m| {
            const fi = for (fields, 0..) |f, i| {
                if (std.ascii.eqlIgnoreCase(f.name, m.key)) break i;
            } else continue;
            const f = fields[fi];
            if (m.value == .null) {
                if (f.blocks) got[fi].blocks = null;
                continue;
            }
            if (!f.blocks) {
                if (m.value == .string) {
                    got[fi].text = m.value.string;
                } else if (first == null) {
                    first = try std.fmt.allocPrint(a, "json: cannot unmarshal {s} into Go struct field .{s} of type string", .{ m.value.kind(), f.name });
                }
                continue;
            }
            if (m.value != .array) {
                if (first == null) first = try std.fmt.allocPrint(a, "json: cannot unmarshal {s} into Go struct field .{s} of type []map[string]interface {{}}", .{ m.value.kind(), f.name });
                continue;
            }
            const out = try a.alloc(?Value, m.value.array.len);
            for (m.value.array, out, 0..) |x, *o, i| {
                o.* = null;
                switch (x) {
                    .null => {},
                    .object => {
                        const path = try std.fmt.allocPrint(a, ".{s}.{d}", .{ f.name, i });
                        var bad: ?[]const u8 = null;
                        o.* = try toValue(a, x, path, &bad);
                        if (bad) |b| if (first == null) {
                            first = b;
                        };
                    },
                    else => if (first == null) {
                        first = try std.fmt.allocPrint(a, "json: cannot unmarshal {s} into .{s}.{d} of type map[string]interface {{}}", .{ x.kind(), f.name, i });
                    },
                }
            }
            got[fi].blocks = out;
        },
        else => first = try std.fmt.allocPrint(a, "json: cannot unmarshal {s} into Go value of type {s}", .{ j.kind(), type_name }),
    }
    return .{ .got = got, .err = first };
}

/// A JSON value as Go's `any` holds it, then as dag-cbor: a number is a
/// float64 made an integer when whole (the loop's normalize), an object a
/// map whose later duplicate keys win.
fn toValue(a: Allocator, j: J, path: []const u8, bad: *?[]const u8) !Value {
    switch (j) {
        .null => return .null,
        .bool => |b| return .{ .bool = b },
        .string => |s| return .{ .string = s },
        .number => |lit| {
            const f = std.fmt.parseFloat(f64, lit) catch std.math.inf(f64);
            if (std.math.isInf(f)) {
                if (bad.* == null) bad.* = try std.fmt.allocPrint(a, "json: cannot unmarshal number {s} into Go struct field {s} of type float64", .{ lit, path });
                return .null;
            }
            return whole(f);
        },
        .array => |xs| {
            const out = try a.alloc(Value, xs.len);
            for (xs, out, 0..) |x, *o, i| o.* = try toValue(a, x, try std.fmt.allocPrint(a, "{s}.{d}", .{ path, i }), bad);
            return .{ .array = out };
        },
        .object => |ms| {
            var list = std.array_list.Managed(cbor.Entry).init(a);
            for (ms) |m| {
                const v = try toValue(a, m.value, try std.fmt.allocPrint(a, "{s}.{s}", .{ path, m.key }), bad);
                for (list.items) |*e| {
                    if (std.mem.eql(u8, e.key, m.key)) {
                        e.value = v;
                        break;
                    }
                } else try list.append(.{ .key = m.key, .value = v });
            }
            return .{ .map = list.items };
        },
    }
}

/// A JSON text the program carries (a tool definition) as a dag-cbor value.
pub fn valueOf(a: Allocator, text: []const u8) !Value {
    const j = switch (try parse(a, text)) {
        .ok => |v| v,
        .err => return error.BadJson,
    };
    var bad: ?[]const u8 = null;
    return toValue(a, j, "", &bad);
}

/// Go's `if x == float64(int64(x)) { int64(x) }` on wasm (saturating conversion).
fn whole(f: f64) Value {
    const two63: f64 = 9223372036854775808.0;
    if (f == two63) return .{ .int = std.math.maxInt(i64) };
    if (@floor(f) == f and f >= -two63 and f < two63) return .{ .int = @as(i64, @intFromFloat(f)) };
    return .{ .float = f };
}

// ---------------------------------------------------------------- writing

/// A JSON string as Go's json.Marshal writes it.
pub fn writeString(out: *std.array_list.Managed(u8), s: []const u8) !void {
    const hexd = "0123456789abcdef";
    try out.append('"');
    var i: usize = 0;
    while (i < s.len) {
        const c = s[i];
        if (c < 0x80) {
            switch (c) {
                '"' => try out.appendSlice("\\\""),
                '\\' => try out.appendSlice("\\\\"),
                '\n' => try out.appendSlice("\\n"),
                '\r' => try out.appendSlice("\\r"),
                '\t' => try out.appendSlice("\\t"),
                8 => try out.appendSlice("\\b"),
                12 => try out.appendSlice("\\f"),
                '<', '>', '&', 0...7, 11, 14...0x1f => try out.appendSlice(&.{ '\\', 'u', '0', '0', hexd[c >> 4], hexd[c & 15] }),
                else => try out.append(c),
            }
            i += 1;
            continue;
        }
        const n = std.unicode.utf8ByteSequenceLength(c) catch 0;
        if (n == 0 or i + n > s.len or !std.unicode.utf8ValidateSlice(s[i .. i + n])) {
            try out.appendSlice("\\ufffd");
            i += 1;
            continue;
        }
        const r = std.unicode.utf8Decode(s[i .. i + n]) catch 0xfffd;
        if (r == 0x2028 or r == 0x2029) {
            try out.appendSlice(if (r == 0x2028) "\\u2028" else "\\u2029");
        } else try out.appendSlice(s[i .. i + n]);
        i += n;
    }
    try out.append('"');
}

// ---------------------------------------------------------------- strconv.Quote

/// unicode.IsPrint, for the code points a tool argument is likely to hold:
/// controls, format characters, separators other than the space, private use
/// and noncharacters are not printable.
fn isPrint(r: u21) bool {
    if (r < 0x20 or r == 0x7f) return false;
    if (r < 0x7f) return true;
    return switch (r) {
        0x80...0xa0, 0xad, 0x600...0x605, 0x61c, 0x6dd, 0x70f, 0x1680, 0x180e, 0x2000...0x200f, 0x2028...0x202f, 0x205f...0x206f, 0x3000, 0xd800...0xf8ff, 0xfeff, 0xfff9...0xfffb, 0xfffe, 0xffff, 0xe0001, 0xe0020...0xe007f, 0xf0000...0x10ffff => false,
        else => true,
    };
}

/// strconv.Quote: a double-quoted Go string literal.
pub fn quote(a: Allocator, s: []const u8) ![]const u8 {
    var out = std.array_list.Managed(u8).init(a);
    try out.append('"');
    try quoteInto(&out, s, '"');
    try out.append('"');
    return out.items;
}

fn quoteInto(out: *std.array_list.Managed(u8), s: []const u8, q: u8) !void {
    const hexd = "0123456789abcdef";
    var i: usize = 0;
    while (i < s.len) {
        const c = s[i];
        const n = std.unicode.utf8ByteSequenceLength(c) catch 0;
        if (n == 0 or i + n > s.len or !std.unicode.utf8ValidateSlice(s[i .. i + n])) {
            try out.appendSlice(&.{ '\\', 'x', hexd[c >> 4], hexd[c & 15] });
            i += 1;
            continue;
        }
        const r = std.unicode.utf8Decode(s[i .. i + n]) catch unreachable;
        if (r == q or r == '\\') {
            try out.appendSlice(&.{ '\\', @intCast(r) });
        } else if (isPrint(r)) {
            try out.appendSlice(s[i .. i + n]);
        } else switch (r) {
            7 => try out.appendSlice("\\a"),
            8 => try out.appendSlice("\\b"),
            12 => try out.appendSlice("\\f"),
            '\n' => try out.appendSlice("\\n"),
            '\r' => try out.appendSlice("\\r"),
            '\t' => try out.appendSlice("\\t"),
            11 => try out.appendSlice("\\v"),
            else => {
                if (r < 0x20 or r == 0x7f) {
                    try out.appendSlice(&.{ '\\', 'x', hexd[r >> 4], hexd[r & 15] });
                } else if (r < 0x10000) {
                    try out.appendSlice(&.{ '\\', 'u', hexd[r >> 12], hexd[(r >> 8) & 15], hexd[(r >> 4) & 15], hexd[r & 15] });
                } else {
                    try out.appendSlice(&.{ '\\', 'U', '0', '0', hexd[r >> 20], hexd[(r >> 16) & 15], hexd[(r >> 12) & 15], hexd[(r >> 8) & 15], hexd[(r >> 4) & 15], hexd[r & 15] });
                }
            },
        }
        i += n;
    }
}

/// encoding/json's quoteChar: the character a syntax error names, in single quotes.
fn quoteChar(a: Allocator, rest: []const u8) ![]const u8 {
    if (rest[0] == '\'') return "'\\''";
    if (rest[0] == '"') return "'\"'";
    const n = @min(rest.len, std.unicode.utf8ByteSequenceLength(rest[0]) catch 1);
    var out = std.array_list.Managed(u8).init(a);
    try out.append('\'');
    try quoteInto(&out, rest[0..n], '"');
    try out.append('\'');
    return out.items;
}

test "Go's messages and escaping" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_][2][]const u8{
        .{ "{\"a\":1,}", "invalid character '}' looking for beginning of object key string" },
        .{ "{\"a\" 1}", "invalid character '1' after object key" },
        .{ "{\"a\":1 \"b\"}", "invalid character '\"' after object key:value pair" },
        .{ "[1 2]", "invalid character '2' after array element" },
        .{ "{\"a\":\"\\x\"}", "invalid escape sequence `\\x` in string" },
        .{ "{\"a\":\"\x01\"}", "invalid character '\\x01' in string" },
        .{ "{\"a\":tru}", "invalid character '}' in literal true (expecting 'e')" },
        .{ "{\"a\":01}", "invalid character '1' after object key:value pair" },
        .{ "{\"a\":1.}", "invalid character '}' in numeric literal" },
        .{ "{\"a\":-a}", "invalid character 'a' in numeric literal" },
        .{ "  ", "unexpected end of JSON input" },
        .{ "{\"a\":'x'}", "invalid character '\\'' looking for beginning of value" },
        .{ "{\"a\":\"x\"}}", "invalid character '}' after top-level value" },
        .{ "{\"text\":é}", "invalid character 'é' looking for beginning of value" },
        .{ "{\"a\":\"\\u00\"}", "invalid escape sequence `\\u00\"}` in string" },
        .{ "{\"a\":\"a\nb\"}", "invalid character '\\n' in string" },
        .{ "nul", "unexpected end of JSON input" },
    };
    for (cases) |c| try std.testing.expectEqualStrings(c[1], (try parse(a, c[0])).err);
    const fields = [_]Field{ .{ .name = "text" }, .{ .name = "blocks", .blocks = true } };
    const d = try decode(a, "{\"blocks\":[1]}", &fields, "T");
    try std.testing.expectEqualStrings("json: cannot unmarshal number into .blocks.0 of type map[string]interface {}", d.err.?);
    const e = try decode(a, "{\"text\":5}", &fields, "T");
    try std.testing.expectEqualStrings("json: cannot unmarshal number into Go struct field .text of type string", e.err.?);
    const f = try decode(a, "[1]", &fields, "T");
    try std.testing.expectEqualStrings("json: cannot unmarshal array into Go value of type T", f.err.?);
    const g = try decode(a, "{\"TEXT\":\"hi\",\"text\":\"lo\"}", &fields, "T");
    try std.testing.expectEqualStrings("lo", g.got[0].text);
    var out = std.array_list.Managed(u8).init(a);
    try writeString(&out, "\x08\x0c\x01\x7f<é\u{2028}\u{ad}\"\\/");
    try std.testing.expectEqualStrings("\"\\b\\f\\u0001\x7f\\u003cé\\u2028\u{ad}\\\"\\\\/\"", out.items);
    try std.testing.expectEqualStrings("\"\\a\\b\\f\\n\\r\\t\\v\\x7f\\u00ad\\u0085 é\\u200b\u{1F600}\\ufeff\"", try quote(a, "\x07\x08\x0c\n\r\t\x0b\x7f\u{ad}\u{85} é\u{200b}\u{1F600}\u{feff}"));
}
