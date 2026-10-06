// `zig build test`: the unit tests of every module, plus the fixtures the
// TypeScript formats made (test/fixtures.json, test/fixtures.ts).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const json = @import("json.zig");
const secp = @import("secp");
const syscalls = @import("syscalls.zig");

test {
    _ = cbor;
    _ = cidm;
    _ = json;
    _ = secp;
    _ = syscalls;
    _ = @import("tree.zig");
    _ = @import("bitcoin.zig");
    _ = @import("index_test.zig");
    _ = @import("objects.zig");
    _ = @import("fuel_test.zig");
    _ = @import("component_test.zig");
    _ = @import("wasm_fuel.zig");
    _ = @import("wasm_fuel_test.zig");
    _ = @import("dispatch.zig");
    _ = @import("subscriptions.zig");
    _ = @import("log.zig");
    _ = @import("beef.zig");
    _ = @import("door_test.zig");
    _ = @import("authfetch.zig");
    _ = @import("billing.zig");
}

fn fixtures(a: std.mem.Allocator) !std.json.Value {
    const text = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/fixtures.json", a, .limited(1 << 24));
    return (try std.json.parseFromSliceLeaky(std.json.Value, a, text, .{}));
}

fn unhex(a: std.mem.Allocator, h: []const u8) ![]u8 {
    const out = try a.alloc(u8, h.len / 2);
    _ = try std.fmt.hexToBytes(out, h);
    return out;
}

test "dag-cbor: every TS encoding round-trips to the same bytes and CID" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try fixtures(a);
    for (f.object.get("cbor").?.array.items) |c| {
        const bytes = try unhex(a, c.object.get("hex").?.string);
        const v = try cbor.decode(a, bytes);
        const b = try cbor.block(a, v);
        try std.testing.expectEqualSlices(u8, bytes, b.bytes);
        try std.testing.expectEqualStrings(c.object.get("cid").?.string, try cidm.format(a, b.cid));
    }
    for (f.object.get("normalize").?.array.items) |c| {
        const v = try cbor.decode(a, try unhex(a, c.object.get("in").?.string));
        try std.testing.expectEqualSlices(u8, try unhex(a, c.object.get("out").?.string), try cbor.encode(a, v));
    }
    for (f.object.get("reject").?.array.items) |c| {
        try std.testing.expectError(error.Cbor, cbor.decode(a, try unhex(a, c.string)));
    }
}

// The envelope vectors (fixtures.json `envelope`, format2.json `envelope` and
// `tampered`) are checked by src/envelope-vectors.test.ts: the kernel has no
// envelope module (the SDK's lib/message.zig verifies messages).
test "anyone signatures and JCS as in TS" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try fixtures(a);
    for (f.object.get("signatures").?.array.items) |s| {
        const o = s.object;
        const ok = secp.verifyAnyone(o.get("identity").?.string, @intCast(o.get("level").?.integer), o.get("name").?.string, o.get("keyId").?.string, try unhex(a, o.get("data").?.string), try unhex(a, o.get("sig").?.string));
        try std.testing.expectEqual(o.get("ok").?.bool, ok);
    }
    for (f.object.get("jcs").?.array.items) |c| {
        const v = try cbor.decode(a, try unhex(a, c.object.get("hex").?.string));
        var out = std.array_list.Managed(u8).init(a);
        try json.jcs(&out, v);
        try std.testing.expectEqualStrings(c.object.get("jcs").?.string, out.items);
    }
}

test "format 2 (issue #33): genesis keys are bytes; entries unsigned" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const text = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/format2.json", a, .limited(1 << 20));
    const f = (try std.json.parseFromSliceLeaky(std.json.Value, a, text, .{})).object;
    const logm = @import("log.zig");
    try std.testing.expect(logm.isGenesis(try cbor.decode(a, try unhex(a, f.get("genesis").?.string))));
    try std.testing.expect(!logm.isGenesis(try cbor.decode(a, try unhex(a, f.get("genesisWithHost").?.string))));
    try std.testing.expect(logm.isLogEntry(try cbor.decode(a, try unhex(a, f.get("entry").?.string))));
    try std.testing.expect(!logm.isLogEntry(try cbor.decode(a, try unhex(a, f.get("entrySigned").?.string))));
}

test "entropy stream and the fixed CIDs" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try fixtures(a);
    const e = f.object.get("entropy").?.object;
    var r = syscalls.Entropy.init(try cidm.parse(a, e.get("entry").?.string), try cidm.parse(a, e.get("thread").?.string));
    var buf: [100]u8 = undefined;
    r.fill(buf[0..37]);
    r.fill(buf[37..]);
    try std.testing.expectEqualSlices(u8, try unhex(a, e.get("bytes").?.string), &buf);

    const c = f.object.get("cids").?.object;
    try std.testing.expectEqualStrings(c.get("headMain").?.string, try cidm.format(a, try @import("heads.zig").headOrigin(a, "main")));
    try std.testing.expectEqualStrings(c.get("dispatch").?.string, try cidm.format(a, try @import("dispatch.zig").origin(a)));
    try std.testing.expectEqualStrings(c.get("emptyTree").?.string, try cidm.format(a, (try @import("tree.zig").hashTree(a, &.{})).cid));
}

test "traps come back as V8 names them (modules as in README; messages read from Node 26)" {
    const engine = @import("engine.zig");
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var eng = try engine.Engine.init();
    defer eng.deinit();
    // A module exporting f: () -> () with `body`; optional 1-page memory, optional 1-entry funcref table.
    const Case = struct { body: []const u8, mem: bool = false, table: bool = false, want: []const u8 };
    const cases = [_]Case{
        .{ .body = &.{0x00}, .want = "unreachable" },
        .{ .body = &.{ 0x41, 1, 0x41, 0, 0x6d, 0x1a }, .want = "divide by zero" },
        .{ .body = &.{ 0x41, 0x80, 0x80, 0x80, 0x80, 0x78, 0x41, 0x7f, 0x6d, 0x1a }, .want = "divide result unrepresentable" },
        .{ .body = &.{ 0x41, 0x7f, 0x28, 2, 0, 0x1a }, .mem = true, .want = "memory access out of bounds" },
        .{ .body = &.{ 0x43, 0, 0, 0xc0, 0x7f, 0xa8, 0x1a }, .want = "float unrepresentable in integer range" },
        .{ .body = &.{ 0x41, 0, 0x11, 0, 0 }, .table = true, .want = "function signature mismatch" },
        .{ .body = &.{ 0x41, 5, 0x11, 0, 0 }, .table = true, .want = "table index is out of bounds" },
        .{ .body = &.{ 0x10, 0 }, .want = "Maximum call stack size exceeded" },
    };
    for (cases) |cs| {
        var m = std.array_list.Managed(u8).init(a);
        try m.appendSlice(&.{ 0, 0x61, 0x73, 0x6d, 1, 0, 0, 0 });
        try m.appendSlice(&.{ 1, 4, 1, 0x60, 0, 0 }); // type () -> ()
        try m.appendSlice(&.{ 3, 2, 1, 0 }); // one function
        if (cs.table) try m.appendSlice(&.{ 4, 4, 1, 0x70, 0, 1 });
        if (cs.mem) try m.appendSlice(&.{ 5, 3, 1, 0, 1 });
        try m.appendSlice(&.{ 7, 5, 1, 1, 'f', 0, 0 });
        const code_len: u8 = @intCast(cs.body.len + 2);
        try m.appendSlice(&.{ 10, code_len + 2, 1, code_len, 0 });
        try m.appendSlice(cs.body);
        try m.append(0x0b);
        var em: []const u8 = "";
        const mod = engine.Module.compile(&eng, a, m.items, &em) catch |err| {
            std.debug.print("compile: {s}\n", .{em});
            return err;
        };
        mod.entry = "f";
        var dummy: u8 = 0;
        const out = try mod.run(&eng, &dummy, struct {
            fn f(_: *anyopaque, _: usize, _: []const i64, _: []u8) engine.Ret {
                return .{ .value = 0 };
            }
        }.f, &em, a, null);
        try std.testing.expect(out == .trapped);
        try std.testing.expectEqualStrings(cs.want, out.trapped.v8Message());
    }
}

// ---------------------------------------------------------------- the dispatch table's cases (#115)

const dispatch = @import("dispatch.zig");

/// A fixture value as the kernel holds it: "$<name>" a key, "$cid" the CID, "$bytes32" 32 bytes.
fn caseValue(a: std.mem.Allocator, f: std.json.Value, j: std.json.Value) !cbor.Value {
    return switch (j) {
        .null => .null,
        .bool => |b| .{ .bool = b },
        .integer => |i| cbor.int(i),
        .string => |s| blk: {
            if (std.mem.eql(u8, s, "$cid")) break :blk cbor.cidv(try cidm.parse(a, f.object.get("cid").?.string));
            if (std.mem.eql(u8, s, "$bytes32")) break :blk .{ .bytes = try a.alloc(u8, 32) };
            if (s.len > 1 and s[0] == '$') if (f.object.get("keys").?.object.get(s[1..])) |k| break :blk .{ .bytes = try unhex(a, k.string) };
            break :blk cbor.string(s);
        },
        .array => |xs| blk: {
            const out = try a.alloc(cbor.Value, xs.items.len);
            for (xs.items, out) |x, *o| o.* = try caseValue(a, f, x);
            break :blk .{ .array = out };
        },
        .object => |o| blk: {
            var m = cbor.MapBuilder.init(a);
            var it = o.iterator();
            while (it.next()) |e| try m.put(e.key_ptr.*, try caseValue(a, f, e.value_ptr.*));
            break :blk m.value();
        },
        else => error.BadFixture,
    };
}

fn caseKey(a: std.mem.Allocator, f: std.json.Value, name: ?std.json.Value) !?[]const u8 {
    const n = name orelse return null;
    return try unhex(a, f.object.get("keys").?.object.get(n.string).?.string);
}

fn idOf(r: ?dispatch.Row) ?[]const u8 {
    const x = r orelse return null;
    return cbor.Value.str(x.value.get("id"));
}

test "the dispatch table: fold and match, the cases dispatch.ts is checked against (test/dispatch-cases.json)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const text = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/dispatch-cases.json", a, .limited(1 << 20));
    const f = try std.json.parseFromSliceLeaky(std.json.Value, a, text, .{});
    for (f.object.get("tables").?.array.items) |t| {
        const name = t.object.get("name").?.string;
        const ups = t.object.get("updates").?.array.items;
        const vals = try a.alloc(cbor.Value, ups.len);
        for (ups, vals) |u, *v| v.* = try caseValue(a, f, u);
        const rows = try dispatch.fold(a, vals);
        const want_fold = t.object.get("fold").?.array.items;
        std.testing.expectEqual(want_fold.len, rows.len) catch |e| {
            std.debug.print("{s}: fold\n", .{name});
            return e;
        };
        for (want_fold, rows) |w, r| try std.testing.expectEqualStrings(w.string, idOf(r).?);
        const reads: ?cbor.Value = if (t.object.get("reads")) |r| try caseValue(a, f, r) else null;
        for (t.object.get("cases").?.array.items, 0..) |c, i| {
            const kind = c.object.get("kind").?.string;
            const want = c.object.get("want").?;
            const who: dispatch.Who = if (c.object.get("who")) |w| .{
                .key = try caseKey(a, f, w.object.get("key")),
                .reads = reads,
            } else .{};
            var got: ?[]const u8 = null;
            var refused: ?[]const u8 = null;
            if (std.mem.eql(u8, kind, "mail")) {
                got = idOf(dispatch.forMail(rows, (try caseKey(a, f, c.object.get("sender"))).?, c.object.get("box").?.string));
            } else if (std.mem.eql(u8, kind, "event")) {
                got = idOf(dispatch.forEvent(rows, c.object.get("box").?.string));
            } else if (std.mem.eql(u8, kind, "http")) {
                switch (dispatch.forHttp(rows, c.object.get("path").?.string, who)) {
                    .row => |r| got = idOf(r),
                    .refused => |why| refused = why.text(),
                }
            } else if (std.mem.eql(u8, kind, "libp2p")) {
                got = idOf(dispatch.forLibp2p(rows, c.object.get("name").?.string, who));
            } else return error.BadFixture;
            const ok = switch (want) {
                .null => got == null and refused == null,
                .string => |s| got != null and std.mem.eql(u8, got.?, s),
                .object => |o| refused != null and std.mem.eql(u8, refused.?, o.get("refused").?.string),
                else => false,
            };
            if (!ok) {
                std.debug.print("{s}: case {d} ({s}): got {?s} refused {?s}\n", .{ name, i, kind, got, refused });
                return error.TestUnexpectedResult;
            }
        }
    }
}
