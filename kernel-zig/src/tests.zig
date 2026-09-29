// `zig build test`: the unit tests of every module, plus the fixtures the
// TypeScript formats made (test/fixtures.json, test/fixtures.ts).
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const json = @import("json.zig");
const secp = @import("secp.zig");
const syscalls = @import("syscalls.zig");

test {
    _ = cbor;
    _ = cidm;
    _ = json;
    _ = secp;
    _ = syscalls;
    _ = @import("tree.zig");
    _ = @import("mst.zig");
    _ = @import("bitcoin.zig");
    _ = @import("index_test.zig");
    _ = @import("objects.zig");
    _ = @import("fuel_test.zig");
    _ = @import("component_test.zig");
    _ = @import("http.zig");
    _ = @import("http_test.zig");
    _ = @import("libp2p_test.zig");
    _ = @import("wasm_fuel.zig");
    _ = @import("wasm_fuel_test.zig");
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

test "anyone signatures and envelopes verify as in TS" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const f = try fixtures(a);
    for (f.object.get("signatures").?.array.items) |s| {
        const o = s.object;
        const ok = secp.verifyAnyone(o.get("identity").?.string, @intCast(o.get("level").?.integer), o.get("name").?.string, o.get("keyId").?.string, try unhex(a, o.get("data").?.string), try unhex(a, o.get("sig").?.string));
        try std.testing.expectEqual(o.get("ok").?.bool, ok);
    }
    const env = f.object.get("envelope").?.object;
    const signed = try cbor.decode(a, try unhex(a, env.get("signed").?.string));
    const envelope = @import("envelope.zig");
    try std.testing.expectEqualStrings(env.get("jcs").?.string, try envelope.canonical(a, signed));
    try std.testing.expectEqual(env.get("ok").?.bool, envelope.verify(a, signed));
    for (f.object.get("jcs").?.array.items) |c| {
        const v = try cbor.decode(a, try unhex(a, c.object.get("hex").?.string));
        var out = std.array_list.Managed(u8).init(a);
        try json.jcs(&out, v);
        try std.testing.expectEqualStrings(c.object.get("jcs").?.string, out.items);
    }
}

test "format 2 (issue #33): §7.3 envelopes verify over the dag-cbor preimage; genesis keys are bytes; entries unsigned" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const text = try std.Io.Dir.cwd().readFileAlloc(std.testing.io, "test/format2.json", a, .limited(1 << 20));
    const f = (try std.json.parseFromSliceLeaky(std.json.Value, a, text, .{})).object;
    const envelope = @import("envelope.zig");
    const logm = @import("log.zig");
    const e = f.get("envelope").?.object;
    const signed = try cbor.decode(a, try unhex(a, e.get("signed").?.string));
    const full = try cbor.decode(a, try unhex(a, e.get("full").?.string));
    try std.testing.expectEqual(envelope.Form.cbor, envelope.formOf(signed).?);
    try std.testing.expect(envelope.isSigned(signed) and !envelope.isEnvelope(signed) and envelope.isEnvelope(full));
    try std.testing.expect(envelope.verify(a, signed));
    try std.testing.expect(envelope.verify(a, full)); // the BRC-78 sender is the signer
    try std.testing.expect(envelope.hashMatches(signed, try unhex(a, e.get("body").?.string)));
    try std.testing.expect(!envelope.hashMatches(signed, "other"));
    try std.testing.expect(!envelope.verify(a, try cbor.decode(a, try unhex(a, f.get("tampered").?.string))));
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

    const programs = @import("programs.zig");
    const c = f.object.get("cids").?.object;
    try std.testing.expectEqualStrings(c.get("shell").?.string, try cidm.format(a, try programs.programCid(a, "shell")));
    try std.testing.expectEqualStrings(c.get("headMain").?.string, try cidm.format(a, try @import("heads.zig").headOrigin(a, "main")));
    try std.testing.expectEqualStrings(c.get("subscriptions").?.string, try cidm.format(a, try @import("subscriptions.zig").origin(a)));
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
