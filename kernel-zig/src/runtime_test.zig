// The runtime driven directly (skein next, SPEC.md sections 2-5): an instance born from a genesis
// over an in-memory store, the test program (test/call/next.wasm, the app `next`) its only app, and
// arrivals put through CHECK then COMMIT. What each test names is a spec line.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const secp = @import("secp");
const index = @import("index.zig");
const runner = @import("runner.zig");
const scheduler = @import("scheduler.zig");
const doorm = @import("door.zig");
const grants = @import("grants.zig");
const logm = @import("log.zig");
const copylog = @import("copylog.zig");
const authfetch = @import("authfetch.zig");
const Value = cbor.Value;
const Secp = std.crypto.ecc.Secp256k1;

const testing = std.testing;

// ---------------------------------------------------------------- an in-memory backend

const Mem = struct {
    gpa: std.mem.Allocator,
    blocks: std.StringHashMap([]u8),
    ptr: ?[]u8 = null,

    fn init(gpa: std.mem.Allocator) Mem {
        return .{ .gpa = gpa, .blocks = std.StringHashMap([]u8).init(gpa) };
    }
    fn deinit(m: *Mem) void {
        var it = m.blocks.iterator();
        while (it.next()) |e| {
            m.gpa.free(e.key_ptr.*);
            m.gpa.free(e.value_ptr.*);
        }
        m.blocks.deinit();
        if (m.ptr) |p| m.gpa.free(p);
    }
    fn self(ctx: *anyopaque) *Mem {
        return @ptrCast(@alignCast(ctx));
    }
    fn get(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const b = self(ctx).blocks.get(cid) orelse return null;
        return try a.dupe(u8, b);
    }
    fn has(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        return self(ctx).blocks.contains(cid);
    }
    fn put(ctx: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
        const m = self(ctx);
        if (m.blocks.contains(cid)) return;
        try m.blocks.put(try m.gpa.dupe(u8, cid), try m.gpa.dupe(u8, bytes));
    }
    fn nop(_: *anyopaque) anyerror!void {}
    fn nop2(_: *anyopaque) void {}
    fn pointer(ctx: *anyopaque, a: std.mem.Allocator, _: []const u8) anyerror!?[]u8 {
        const p = self(ctx).ptr orelse return null;
        return try a.dupe(u8, p);
    }
    fn setPointer(ctx: *anyopaque, _: []const u8, cid: []const u8) anyerror!void {
        const m = self(ctx);
        if (m.ptr) |p| m.gpa.free(p);
        m.ptr = try m.gpa.dupe(u8, cid);
    }
    const vt = index.Backend.VT{ .get = get, .has = has, .put = put, .begin = nop, .commit = nop, .rollback = nop2, .pointer = pointer, .setPointer = setPointer };
    fn backend(m: *Mem) index.Backend {
        return .{ .ctx = m, .vt = &vt };
    }
};

// ---------------------------------------------------------------- keys and signatures

const Key = struct {
    secret: [32]u8,
    public: [33]u8,

    fn of(seed: u8) Key {
        var s = [_]u8{0} ** 32;
        s[31] = seed;
        s[0] = 0x11;
        const p = Secp.basePoint.mul(s, .big) catch unreachable;
        return .{ .secret = s, .public = p.toCompressedSec1() };
    }

    /// A signature by this key's BRC-42 "anyone" child for [level, protocol], keyID (BRC-169's
    /// message signing): the child's secret is the key's plus HMAC(invoice, the shared point — the
    /// key itself, the counterparty's secret being 1).
    fn signAnyone(k: Key, buf: []u8, protocol: []const u8, key_id: []const u8, data: []const u8) ![]u8 {
        var inv: [256]u8 = undefined;
        const invoice = try std.fmt.bufPrint(&inv, "2-{s}-{s}", .{ protocol, key_id });
        var h: [32]u8 = undefined;
        std.crypto.auth.hmac.sha2.HmacSha256.create(&h, invoice, &k.public);
        var wide: [48]u8 = [_]u8{0} ** 48;
        @memcpy(wide[16..], &h);
        const t = Secp.scalar.reduce48(wide, .big);
        const child = try Secp.scalar.add(k.secret, t, .big);
        const E = std.crypto.sign.ecdsa.EcdsaSecp256k1Sha256;
        const kp = try E.KeyPair.fromSecretKey(try E.SecretKey.fromBytes(child));
        const sig = try kp.sign(data, null);
        var der: [E.Signature.der_encoded_length_max]u8 = undefined;
        const d = sig.toDer(&der);
        @memcpy(buf[0..d.len], d);
        return buf[0..d.len];
    }
};

/// The test's keys, made at run time (a point multiplication is too much for comptime).
const Keys = struct { instance: Key, root: Key, admin: Key, stranger: Key, hostsvc: Key };
var the_keys: ?Keys = null;
fn kk() *const Keys {
    if (the_keys == null) the_keys = .{ .instance = Key.of(1), .root = Key.of(2), .admin = Key.of(3), .stranger = Key.of(4), .hostsvc = Key.of(5) };
    return &the_keys.?;
}

// ---------------------------------------------------------------- the test signer (brc104)

/// The instance's wallet as the brc104 scheme asks it: verifyHmac (14) passes for the HMAC
/// 0xAA × 32, verifySignature (16) for the signature "GOOD" over a payload naming the right key id.
/// Every call is counted (a replay asks none).
const Wallet = struct {
    calls: usize = 0,
    /// KF1: when set, a signature verifies only over a payload holding this path (as the client signed it).
    want_path: ?[]const u8 = null,
    last_key_id: [128]u8 = undefined,
    last_key_len: usize = 0,

    fn call(ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8 {
        const w: *Wallet = @ptrCast(@alignCast(ctx));
        w.calls += 1;
        if (frame.len == 0) return error.Bad;
        if (frame[0] == 14) {
            if (std.mem.indexOf(u8, frame, &([_]u8{0xAA} ** 32)) == null) return error.HmacNotValid;
            return a.dupe(u8, &.{0});
        }
        if (frame[0] == 16) {
            if (std.mem.indexOf(u8, frame, "GOOD") == null) return error.SignatureNotValid;
            if (std.mem.indexOf(u8, frame, "client-nonce ") == null) return error.WrongKeyId;
            if (w.want_path) |p| if (std.mem.indexOf(u8, frame, p) == null) return error.SignatureNotValid;
            return a.dupe(u8, &.{0});
        }
        return error.Unexpected;
    }
};

/// The host side of a brc104 request: the server nonce the host made (16 bytes ‖ the HMAC, base64).
fn serverNonce(a: std.mem.Allocator, hmac_byte: u8) ![]u8 {
    var raw: [48]u8 = undefined;
    @memset(raw[0..16], 0x42);
    @memset(raw[16..48], hmac_byte);
    const enc = std.base64.standard.Encoder;
    const out = try a.alloc(u8, enc.calcSize(48));
    _ = enc.encode(out, &raw);
    return out;
}

// ---------------------------------------------------------------- the instance

const Answered = struct { thread: []u8, entry: []u8 };

const World = struct {
    gpa: std.mem.Allocator,
    arena: std.heap.ArenaAllocator,
    mem: Mem,
    ix: *index.Index,
    run: *runner.Runner,
    rt: *scheduler.Runtime,
    wallet: Wallet = .{},
    prog: []const u8 = "",
    answered: std.array_list.Managed(Answered),
    lines: std.array_list.Managed([]u8),
    n: i64 = 1,

    fn a(w: *World) std.mem.Allocator {
        return w.arena.allocator();
    }

    fn onAnswer(ctx: *anyopaque, thread: []const u8, entry: []const u8) void {
        const w: *World = @ptrCast(@alignCast(ctx));
        w.answered.append(.{ .thread = w.a().dupe(u8, thread) catch return, .entry = w.a().dupe(u8, entry) catch return }) catch {};
    }
    fn say(ctx: *anyopaque, line: []const u8) void {
        const w: *World = @ptrCast(@alignCast(ctx));
        w.lines.append(w.a().dupe(u8, line) catch return) catch {};
    }
    fn wallet_(ctx: *anyopaque, al: std.mem.Allocator, frame: []const u8) anyerror![]u8 {
        const w: *World = @ptrCast(@alignCast(ctx));
        return Wallet.call(&w.wallet, al, frame);
    }

    /// A world over its own store; `rows` the genesis's starting rows (each given its settings),
    /// `with_root`: root granted to kk().root and next.admin to kk().admin at birth (else: an unclaimed image).
    fn init(gpa: std.mem.Allocator, rows: []const Value, with_root: bool) !*World {
        const w = try gpa.create(World);
        w.* = .{ .gpa = gpa, .arena = std.heap.ArenaAllocator.init(gpa), .mem = Mem.init(gpa), .ix = undefined, .run = undefined, .rt = undefined, .answered = .init(gpa), .lines = .init(gpa) };
        w.ix = try index.Index.init(gpa, w.mem.backend(), false);
        w.run = try sharedRunner();
        const s = w.ix.store();
        const a_ = w.a();
        // The app: the test program, its record at next/app.
        const wasm = try std.Io.Dir.cwd().readFileAlloc(testing.io, "test/call/next.wasm", a_, .limited(1 << 22));
        const mc = try cidm.ofRaw(a_, wasm);
        try s.putBlock(mc, wasm);
        var code = cbor.MapBuilder.init(a_);
        try code.put("wasm", cbor.cidv(mc));
        var p = cbor.MapBuilder.init(a_);
        try p.put("kind", cbor.string("program"));
        try p.put("name", cbor.string("next"));
        try p.put("app", cbor.string("next"));
        try p.put("code", code.value());
        try p.put("inputs", .{ .map = &.{} });
        try p.put("services", .{ .array = &.{} });
        try p.put("description", cbor.string("the skein-next test program"));
        w.prog = try s.put(a_, p.value());
        var ps = cbor.MapBuilder.init(a_);
        try ps.put("main", cbor.cidv(w.prog));
        var app = cbor.MapBuilder.init(a_);
        try app.put("kind", cbor.string("app"));
        try app.put("name", cbor.string("next"));
        try app.put("programs", ps.value());
        const ac = try s.put(a_, app.value());
        var hs = cbor.MapBuilder.init(a_);
        try hs.put("next/app", cbor.cidv(ac));
        // The rows, each carrying the program's CID as a handler setting (`prog`: what `launch` runs).
        const rs = try a_.alloc(Value, rows.len);
        for (rows, rs) |r, *o| {
            var m = cbor.MapBuilder.init(a_);
            for (r.map) |e| try m.put(e.key, e.value);
            try m.put("prog", cbor.cidv(w.prog));
            o.* = m.value();
        }
        var g = cbor.MapBuilder.init(a_);
        try g.put("kind", cbor.string("genesis"));
        try g.put("identity", .{ .bytes = &kk().instance.public });
        try g.put("handle", cbor.string("t"));
        try g.put("domain", cbor.string("localhost"));
        try g.put("routes", .{ .array = rs });
        if (with_root) {
            var gs = cbor.MapBuilder.init(a_);
            try gs.put("root", .{ .array = try a_.dupe(Value, &.{.{ .bytes = &kk().root.public }}) });
            try gs.put("next.admin", .{ .array = try a_.dupe(Value, &.{.{ .bytes = &kk().admin.public }}) });
            try g.put("grants", gs.value());
        }
        try g.put("heads", hs.value());
        try testing.expect(logm.isGenesis(g.value()));
        const gc = try s.put(a_, g.value());
        w.rt = try scheduler.Runtime.init(gpa, s, w.run, .{ .ctx = w, .wallet = wallet_, .on_answer = onAnswer, .say = say });
        var e = cbor.MapBuilder.init(a_);
        try e.put("kind", cbor.string("log"));
        try e.put("prev", .null);
        try e.put("n", cbor.int(0));
        try e.put("time", try stamp(a_, 0));
        try e.put("genesis", cbor.cidv(gc));
        try testing.expect((try w.rt.appendGenesis(a_, e.value())) == .ok);
        try w.rt.start();
        w.rt.kick();
        return w;
    }

    fn deinit(w: *World) void {
        w.rt.deinit();
        w.ix.deinit();
        w.mem.deinit();
        w.answered.deinit();
        w.lines.deinit();
        w.arena.deinit();
        w.gpa.destroy(w);
    }

    fn store(w: *World) @import("store.zig").Store {
        return w.ix.store();
    }

    fn tip(w: *World) ![]u8 {
        return (try w.store().logTip(w.a())).?;
    }

    fn arrival(w: *World, rec: Value) !Value {
        var m = cbor.MapBuilder.init(w.a());
        try m.put("request", rec);
        try m.put("time", try stamp(w.a(), w.n));
        w.n += 1;
        return m.value();
    }

    fn check(w: *World, rec: Value) !scheduler.Runtime.CheckOut {
        return w.rt.check(w.a(), try w.arrival(rec));
    }

    fn commit(w: *World, ready: Value) !scheduler.Runtime.CommitOut {
        return w.rt.commit(w.a(), ready);
    }

    /// CHECK then COMMIT: the committed outcome (the test fails on a refusal).
    fn arrive(w: *World, rec: Value) !@FieldType(scheduler.Runtime.CommitOut, "committed") {
        const c = try w.check(rec);
        if (c != .ready) {
            if (c == .refused) std.debug.print("refused: {d} {s}\n", .{ c.refused.status, c.refused.reason });
            return error.NotReady;
        }
        const out = try w.commit(c.ready);
        if (out != .committed) {
            if (out == .refused) std.debug.print("commit refused: {s}\n", .{out.refused.reason});
            if (out == .invalid) std.debug.print("commit invalid: {s}\n", .{out.invalid});
            return error.NotCommitted;
        }
        return out.committed;
    }

    fn head(w: *World, name: []const u8) !?[]u8 {
        return w.store().headTree(w.a(), name);
    }
};

/// One runner for every test (its module cache lives as long as the process, as a host's does).
var the_runner: ?*runner.Runner = null;
fn sharedRunner() !*runner.Runner {
    if (the_runner == null) the_runner = try runner.Runner.init(std.heap.page_allocator);
    return the_runner.?;
}

fn stamp(a: std.mem.Allocator, n: i64) !Value {
    return .{ .array = try a.dupe(Value, &.{ cbor.int(1_800_000_000 + n), cbor.int(0) }) };
}

fn row(a: std.mem.Allocator, fields: []const struct { []const u8, Value }) !Value {
    var m = cbor.MapBuilder.init(a);
    for (fields) |f| try m.put(f[0], f[1]);
    return m.value();
}

fn strs(a: std.mem.Allocator, xs: []const []const u8) !Value {
    const out = try a.alloc(Value, xs.len);
    for (xs, out) |x, *o| o.* = cbor.string(x);
    return .{ .array = out };
}

fn payload(a: std.mem.Allocator, path: []const u8, body: []const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("method", cbor.string("POST"));
    try m.put("path", cbor.string(path));
    try m.put("query", cbor.string(""));
    try m.put("headers", .{ .map = &.{} });
    try m.put("body", .{ .bytes = body });
    return m.value();
}

/// An unsigned request record (a content-proven arrival).
fn plain(a: std.mem.Allocator, path: []const u8, body: []const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("request"));
    try m.put("payload", try payload(a, path, body));
    return m.value();
}

/// A request signed by `k` under the `signed` scheme (BRC-169's message signing over {sender,
/// recipient, nonce, payload}).
fn signedBy(a: std.mem.Allocator, k: Key, path: []const u8, body: []const u8, nonce: []const u8) !Value {
    const p = try payload(a, path, body);
    const pre = try doorm.signedPreimage(a, &k.public, &kk().instance.public, nonce, p);
    const sigbuf = try a.alloc(u8, 80);
    const der = try k.signAnyone(sigbuf, logm.MESSAGE_PROTOCOL, logm.MESSAGE_KEY_ID, pre);
    var sig = cbor.MapBuilder.init(a);
    try sig.put("scheme", cbor.string("signed"));
    try sig.put("sender", .{ .bytes = try a.dupe(u8, &k.public) });
    try sig.put("recipient", .{ .bytes = &kk().instance.public });
    try sig.put("nonce", .{ .bytes = nonce });
    try sig.put("signature", .{ .bytes = der });
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("request"));
    try m.put("payload", p);
    try m.put("signature", sig.value());
    return m.value();
}

/// A brc104 request from `k` as the host gathers it: x-bsv-auth-* into the signature.
fn brc104By(a: std.mem.Allocator, k: Key, path: []const u8, hmac_byte: u8, sig: []const u8) !Value {
    var s = cbor.MapBuilder.init(a);
    try s.put("scheme", cbor.string("brc104"));
    try s.put("version", cbor.string("0.1"));
    try s.put("identityKey", .{ .bytes = try a.dupe(u8, &k.public) });
    try s.put("nonce", cbor.string("client-nonce"));
    try s.put("yourNonce", cbor.string(try serverNonce(a, hmac_byte)));
    try s.put("requestId", cbor.string("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="));
    try s.put("signature", .{ .bytes = sig });
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("request"));
    try m.put("payload", try payload(a, path, ""));
    try m.put("signature", s.value());
    return m.value();
}

fn bodyOf(a: std.mem.Allocator, ans: ?scheduler.Answer) !Value {
    return cbor.decode(a, (ans orelse return error.NoAnswer).body);
}

const S = cbor.string;

/// The rows every test's instance starts with.
fn startRows(a: std.mem.Allocator) ![]const Value {
    const T = Value{ .bool = true };
    return a.dupe(Value, &.{
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/user") }, .{ "role", S("user") }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/root") }, .{ "role", S("root") }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/admin") }, .{ "role", S("next.admin") }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/proven") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{"next.main.pass"}) }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/refused") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{ "next.main.pass", "next.main.reject" }) }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/stored") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{"next.main.store"}) }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/spend") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{"next.main.pass"}) }, .{ "recheck", S("next.main.unspent") }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/vouched") }, .{ "role", S("anyone") }, .{ "checks", try strs(a, &.{"next.main.principal"}) }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("read") }, .{ "path", S("/read/") }, .{ "prefix", T }, .{ "role", S("anyone") }, .{ "handler", S("next.main.read") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/launch") }, .{ "role", S("user") }, .{ "handler", S("next.main.launch") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/launch-nowait") }, .{ "role", S("user") }, .{ "handler", S("next.main.launch") }, .{ "nowait", T } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/awaitname") }, .{ "role", S("user") }, .{ "handler", S("next.main.awaitname") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/ping") }, .{ "role", S("user") }, .{ "handler", S("next.main.handle") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/on") }, .{ "role", S("user") }, .{ "handler", S("next.main.on") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/on-nofn") }, .{ "role", S("user") }, .{ "handler", S("next.main.on") }, .{ "nofn", T } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/deadline") }, .{ "role", S("user") }, .{ "handler", S("next.main.deadline") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/emitkey") }, .{ "role", S("user") }, .{ "handler", S("next.main.emitkey") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/kernel/route") }, .{ "role", S("root") }, .{ "handler", S("kernel.route") } }),
        try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/kernel/grant") }, .{ "role", S("root") }, .{ "handler", S("kernel.grant") } }),
        try row(a, &.{ .{ "kind", S("event") }, .{ "name", S("next/ev") }, .{ "checks", try strs(a, &.{"next.main.pass"}) }, .{ "handler", S("next.main.event") } }),
    });
}

fn world(with_root: bool) !*World {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    return World.init(testing.allocator, try startRows(arena.allocator()), with_root);
}

// ---------------------------------------------------------------- the two request kinds

test "skein next: a signed request (signed scheme) is admitted, its sender the principal; the handler runs directly and answers" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const before = try w.tip();
    const c = try w.arrive(try signedBy(a, kk().stranger, "/user", "hi", "n1"));
    try testing.expectEqualStrings("finished", c.state);
    try testing.expectEqual(@as(i128, 200), c.answer.?.status);
    const b = try bodyOf(a, c.answer);
    try testing.expectEqualSlices(u8, &kk().stranger.public, Value.bytesOf(b.get("caller")).?);
    try testing.expectEqualStrings("/user", Value.str(b.get("path")).?);
    // The entry: {request, door: {principal, scheme, row, checks}}, after the tip.
    const e = (try w.store().get(a, c.entry)).?;
    try testing.expect(logm.isLogEntry(e));
    try testing.expectEqualSlices(u8, before, Value.cidOf(e.get("prev")).?);
    const d = e.get("door").?;
    try testing.expectEqualSlices(u8, &kk().stranger.public, Value.bytesOf(d.get("principal")).?);
    try testing.expectEqualStrings("signed", Value.str(d.get("scheme")).?);
    try testing.expectEqualStrings("/user", Value.str(d.get("row").?.get("path")).?);
    // A bad signature: refused, nothing written.
    const good = try signedBy(a, kk().stranger, "/user", "hi", "n2");
    var tm = cbor.MapBuilder.init(a);
    try tm.put("kind", S("request"));
    try tm.put("payload", try payload(a, "/user", "changed"));
    try tm.put("signature", good.get("signature").?);
    const tampered = tm.value();
    const r = try w.check(tampered);
    try testing.expect(r == .refused);
    try testing.expectEqual(@as(i128, 401), r.refused.status);
    try testing.expectEqualSlices(u8, c.entry, try w.tip());
}

test "skein next: a brc104 request — the server nonce and the signature checked through the signer, no session table" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.arrive(try brc104By(a, kk().admin, "/admin", 0xAA, "GOOD"));
    try testing.expectEqualStrings("finished", c.state);
    const e = (try w.store().get(a, c.entry)).?;
    try testing.expectEqualStrings("brc104", Value.str(e.get("door").?.get("scheme")).?);
    try testing.expectEqualSlices(u8, &kk().admin.public, Value.bytesOf(e.get("door").?.get("principal")).?);
    try testing.expectEqual(@as(usize, 2), w.wallet.calls); // verifyHmac, verifySignature
    // A nonce this instance did not make: 401, nothing written.
    const tip = try w.tip();
    const r1 = try w.check(try brc104By(a, kk().admin, "/admin", 0xBB, "GOOD"));
    try testing.expect(r1 == .refused and r1.refused.status == 401);
    // A signature that does not verify: 401.
    const r2 = try w.check(try brc104By(a, kk().admin, "/admin", 0xAA, "BAD!"));
    try testing.expect(r2 == .refused and r2.refused.status == 401);
    try testing.expectEqualSlices(u8, tip, try w.tip());
}

test "skein next: a content-proven arrival — no signature, a row naming anyone and a check; the check's principal handed on" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.arrive(try plain(a, "/proven", "beef"));
    try testing.expectEqualStrings("finished", c.state);
    const e = (try w.store().get(a, c.entry)).?;
    const d = e.get("door").?;
    try testing.expect(d.get("principal") == null);
    try testing.expectEqualStrings("next.main.pass", Value.str(d.get("checks").?.array[0]).?);
    // A check may pass a principal on: the handler's caller.
    const v = try w.arrive(try plain(a, "/vouched", &kk().hostsvc.public));
    try testing.expectEqualSlices(u8, &kk().hostsvc.public, Value.bytesOf((try bodyOf(a, v.answer)).get("caller")).?);
    // An unsigned request at a row needing a sender: 401.
    const r = try w.check(try plain(a, "/user", ""));
    try testing.expect(r == .refused and r.refused.status == 401);
}

test "skein next (KF1): the path as signed — /@<own handle>/x matches the row /x and verifies over the signed path; /@other/x refused; bare /x matches" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    w.wallet.want_path = "/@t/admin";
    const c = try w.arrive(try brc104By(a, kk().admin, "/@t/admin", 0xAA, "GOOD"));
    try testing.expectEqualStrings("finished", c.state);
    try testing.expectEqualStrings("/admin", Value.str((try bodyOf(a, c.answer)).get("path")).?);
    const e = (try w.store().get(a, c.entry)).?;
    try testing.expectEqualStrings("/admin", Value.str(e.get("door").?.get("row").?.get("path")).?);
    // The signature is over the signed path: a request whose payload path differs does not verify.
    const bad = try w.check(try brc104By(a, kk().admin, "/admin", 0xAA, "GOOD"));
    try testing.expect(bad == .refused and bad.refused.status == 401);
    w.wallet.want_path = null;
    const other = try w.check(try brc104By(a, kk().admin, "/@other/admin", 0xAA, "GOOD"));
    try testing.expect(other == .refused and other.refused.status == 404);
    const prefix = try w.check(try brc104By(a, kk().admin, "/@tt/admin", 0xAA, "GOOD"));
    try testing.expect(prefix == .refused and prefix.refused.status == 404);
    _ = try w.arrive(try brc104By(a, kk().admin, "/admin", 0xAA, "GOOD"));
    // A content-proven request follows the same rule.
    _ = try w.arrive(try plain(a, "/@t/proven", "x"));
    try testing.expect((try w.check(try plain(a, "/@other/proven", "x"))) == .refused);
}

// ---------------------------------------------------------------- refusals, roles

test "skein next: a refusal writes nothing — no entry, no block the check put" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const tip = try w.tip();
    const blocks = w.mem.blocks.count();
    const r = try w.check(try plain(a, "/refused", "x"));
    try testing.expect(r == .refused);
    try testing.expectEqual(@as(i128, 418), r.refused.status);
    try testing.expectEqualStrings("ERR_NO", r.refused.code.?);
    try testing.expectEqualSlices(u8, tip, try w.tip());
    try testing.expectEqual(blocks, w.mem.blocks.count());
    // No row for the path: 404, nothing written.
    const nf = try w.check(try plain(a, "/nowhere", ""));
    try testing.expect(nf == .refused and nf.refused.status == 404);
    try testing.expectEqual(blocks, w.mem.blocks.count());
}

test "skein next: the role gate on the row — anyone, user, root and <app>.<role>, no root bypass" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    // user: any proven sender.
    _ = try w.arrive(try signedBy(a, kk().stranger, "/user", "", "u1"));
    // root: its holders only.
    _ = try w.arrive(try signedBy(a, kk().root, "/root", "", "r1"));
    const r1 = try w.check(try signedBy(a, kk().stranger, "/root", "", "r2"));
    try testing.expect(r1 == .refused and r1.refused.status == 403);
    // <app>.<role>: its holders; root is just a role and does not pass it.
    _ = try w.arrive(try signedBy(a, kk().admin, "/admin", "", "a1"));
    const r2 = try w.check(try signedBy(a, kk().root, "/admin", "", "a2"));
    try testing.expect(r2 == .refused and r2.refused.status == 403);
    // anyone: no sender at all (its check proves it).
    _ = try w.arrive(try plain(a, "/proven", ""));
}

// ---------------------------------------------------------------- CHECK then COMMIT

test "skein next: CHECK then COMMIT with a recheck that refuses — the second spend of two checked together writes nothing" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c1 = try w.check(try plain(a, "/spend", "one"));
    const c2 = try w.check(try plain(a, "/spend", "two"));
    try testing.expect(c1 == .ready and c2 == .ready);
    const o1 = try w.commit(c1.ready);
    try testing.expect(o1 == .committed);
    try testing.expect((try w.head("next/spent")) != null);
    const tip = try w.tip();
    const o2 = try w.commit(c2.ready);
    try testing.expect(o2 == .refused);
    try testing.expectEqualStrings("already spent", o2.refused.reason);
    try testing.expectEqualSlices(u8, tip, try w.tip());
}

test "skein next (KF2): COMMIT refuses a READY whose row changed or went since CHECK, nothing written" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.check(try signedBy(a, kk().stranger, "/user", "", "kf2a"));
    try testing.expect(c == .ready);
    // Root removes the row between the check and the commit.
    var body = cbor.MapBuilder.init(a);
    try body.put("op", S("remove"));
    try body.put("row", c.ready.get("row").?);
    _ = try w.arrive(try signedBy(a, kk().root, "/kernel/route", try cbor.encode(a, body.value()), "kf2b"));
    const tip = try w.tip();
    const o = try w.commit(c.ready);
    try testing.expect(o == .refused);
    try testing.expectEqualStrings("ERR_ROUTE_CHANGED", o.refused.code.?);
    try testing.expectEqualSlices(u8, tip, try w.tip());
    // Changed in place (same key, another row record): refused too.
    const c2 = try w.check(try signedBy(a, kk().admin, "/admin", "", "kf2c"));
    var b2 = cbor.MapBuilder.init(a);
    try b2.put("op", S("add"));
    try b2.put("row", try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/admin") }, .{ "role", S("root") }, .{ "handler", S("next.main.handle") } }));
    _ = try w.arrive(try signedBy(a, kk().root, "/kernel/route", try cbor.encode(a, b2.value()), "kf2d"));
    const o2 = try w.commit(c2.ready);
    try testing.expect(o2 == .refused and std.mem.eql(u8, o2.refused.code.?, "ERR_ROUTE_CHANGED"));
}

test "skein next: blocks a check names are carried in READY and written only at COMMIT; the handler sees the package as handed back" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.check(try plain(a, "/stored", "raw"));
    try testing.expect(c == .ready);
    const bs = c.ready.get("blocks").?.array;
    try testing.expectEqual(@as(usize, 1), bs.len);
    const bc = Value.cidOf(bs[0].get("cid")).?;
    try testing.expect(Value.bytesOf(bs[0].get("bytes")) != null);
    try testing.expect(!(try w.store().has(bc)));
    const o = try w.commit(c.ready);
    try testing.expect(o == .committed);
    try testing.expect(try w.store().has(bc));
    const e = (try w.store().get(a, o.committed.entry)).?;
    const d = e.get("door").?;
    try testing.expectEqualSlices(u8, bc, Value.cidOf(d.get("blocks").?.array[0]).?);
    // The package as the check handed it back: its own record, named by the door; the handler got its body.
    const handed = (try w.store().get(a, Value.cidOf(d.get("request")).?)).?;
    try testing.expectEqualSlices(u8, bc, Value.cidOf(handed.get("payload").?.get("body")).?);
    try testing.expectEqualSlices(u8, bc, Value.cidOf((try bodyOf(a, o.committed.answer)).get("body")).?);
    // The record as received is stored too: the entry names it.
    try testing.expect(try w.store().has(Value.cidOf(e.get("request")).?));
}

test "skein next: a read row answers from CHECK; nothing is written" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const tip = try w.tip();
    const blocks = w.mem.blocks.count();
    const r = try w.check(try plain(a, "/read/x", ""));
    try testing.expect(r == .read);
    try testing.expectEqualStrings("/read/x", Value.str((try cbor.decode(a, r.read.answer.body)).get("read")).?);
    try testing.expectEqualSlices(u8, tip, try w.tip());
    try testing.expectEqual(blocks, w.mem.blocks.count());
}

test "skein next: an event checked and committed; its row's handler runs" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    var ev = cbor.MapBuilder.init(a);
    try ev.put("kind", S("chain"));
    try ev.put("height", cbor.int(7));
    var arr = cbor.MapBuilder.init(a);
    try arr.put("event", ev.value());
    try arr.put("name", S("next/ev"));
    try arr.put("time", try stamp(a, 99));
    const c = try w.rt.check(a, arr.value());
    try testing.expect(c == .ready);
    const o = try w.commit(c.ready);
    try testing.expect(o == .committed);
    const e = (try w.store().get(a, o.committed.entry)).?;
    try testing.expectEqualStrings("next/ev", Value.str(e.get("name")).?);
    try testing.expectEqualSlices(u8, Value.cidOf(e.get("event")).?, (try w.head("next/event")).?);
    // An event with no row: refused, nothing written.
    var arr2 = cbor.MapBuilder.init(a);
    try arr2.put("event", ev.value());
    try arr2.put("name", S("other"));
    try arr2.put("time", try stamp(a, 100));
    try testing.expect((try w.rt.check(a, arr2.value())) == .refused);
}

// ---------------------------------------------------------------- replay

test "skein next: an identical signed request is refused (the unique map), at CHECK and at COMMIT" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const rec = try signedBy(a, kk().stranger, "/user", "once", "same");
    const early = try w.check(rec);
    try testing.expect(early == .ready);
    _ = try w.arrive(rec);
    const again = try w.check(rec);
    try testing.expect(again == .refused);
    try testing.expectEqual(@as(i128, 409), again.refused.status);
    const late = try w.commit(early.ready);
    try testing.expect(late == .refused);
    // A content-proven arrival may come again (its checks judge it).
    _ = try w.arrive(try plain(a, "/proven", "same"));
    _ = try w.arrive(try plain(a, "/proven", "same"));
}

test "skein next: a replay of the log reproduces the same state without a signer" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    _ = try w.arrive(try brc104By(a, kk().admin, "/admin", 0xAA, "GOOD"));
    _ = try w.arrive(try signedBy(a, kk().stranger, "/user", "x", "r1"));
    _ = try w.arrive(try plain(a, "/stored", "raw"));
    _ = try w.arrive(try plain(a, "/spend", "s"));
    _ = try w.arrive(try signedBy(a, kk().stranger, "/launch", "", "r2"));
    try w.store().commit();
    const want = try w.ix.stateCid(a);
    const calls = w.wallet.calls;
    // A fresh store: the modules (raw blocks) first, then the log copied; a runtime with no wallet.
    var mem2 = Mem.init(testing.allocator);
    defer mem2.deinit();
    const ix2 = try index.Index.init(testing.allocator, mem2.backend(), false);
    defer ix2.deinit();
    var it = w.mem.blocks.iterator();
    while (it.next()) |e| if (cidm.codecOf(e.key_ptr.*) == cidm.RAW) try ix2.store().putBlock(e.key_ptr.*, e.value_ptr.*);
    try copylog.copyLog(a, w.store(), ix2.store());
    const rt2 = try scheduler.Runtime.init(testing.allocator, ix2.store(), w.run, .{ .ctx = w });
    defer rt2.deinit();
    rt2.witness = try scheduler.Witness.from(testing.allocator, w.store());
    defer {
        rt2.witness.?.map.deinit();
        rt2.witness.?.arena.deinit();
        testing.allocator.destroy(rt2.witness.?);
    }
    try rt2.start();
    rt2.kick();
    try ix2.store().commit();
    try testing.expectEqualSlices(u8, want, try ix2.stateCid(a));
    try testing.expectEqual(calls, w.wallet.calls); // the signer was not asked
}

// ---------------------------------------------------------------- kernel operations, claim

test "skein next: kernel operations return data — done, or refused with the reason" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    var body = cbor.MapBuilder.init(a);
    try body.put("op", S("add"));
    try body.put("row", try row(a, &.{ .{ "kind", S("request") }, .{ "path", S("/added") }, .{ "role", S("user") }, .{ "handler", S("next.main.handle") } }));
    const c = try w.arrive(try signedBy(a, kk().root, "/kernel/route", try cbor.encode(a, body.value()), "k1"));
    try testing.expectEqualStrings("kernel", c.state);
    try testing.expectEqual(@as(i128, 200), c.answer.?.status);
    const done = (try bodyOf(a, c.answer)).get("done").?;
    try testing.expect(done.get("changed").?.bool);
    // The row is there: a request to it is checked.
    try testing.expect((try w.check(try signedBy(a, kk().stranger, "/added", "", "k2"))) == .ready);
    // Refused with the reason: the entry is written, nothing done.
    var bad = cbor.MapBuilder.init(a);
    try bad.put("op", S("add"));
    try bad.put("role", S("user"));
    try bad.put("principal", .{ .bytes = &kk().stranger.public });
    const r = try w.arrive(try signedBy(a, kk().root, "/kernel/grant", try cbor.encode(a, bad.value()), "k3"));
    try testing.expectEqual(@as(i128, 400), r.answer.?.status);
    try testing.expect(Value.str((try bodyOf(a, r.answer)).get("refused")) != null);
}

test "skein next: claim — root to the claimant's key and the claim row removed, in one step" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const al = arena.allocator();
    var rs = std.array_list.Managed(Value).init(al);
    try rs.appendSlice(try startRows(al));
    try rs.append(try row(al, &.{ .{ "kind", S("request") }, .{ "path", S("/claim") }, .{ "role", S("user") }, .{ "handler", S("kernel.claim") } }));
    const w = try World.init(testing.allocator, rs.items, false);
    defer w.deinit();
    const a = w.a();
    try testing.expect(!grants.hasRoot(try grants.load(a, w.store())));
    const c = try w.arrive(try signedBy(a, kk().stranger, "/claim", "", "c1"));
    try testing.expectEqualSlices(u8, &kk().stranger.public, Value.bytesOf((try bodyOf(a, c.answer)).get("done").?.get("root")).?);
    try testing.expect(grants.holds(try grants.load(a, w.store()), grants.ROOT, &kk().stranger.public));
    // The row is gone: a second claim finds none.
    const again = try w.check(try signedBy(a, kk().root, "/claim", "", "c2"));
    try testing.expect(again == .refused and again.refused.status == 404);
    // The claimant holds root: a root row passes it.
    _ = try w.arrive(try signedBy(a, kk().stranger, "/root", "", "c3"));
}

// ---------------------------------------------------------------- later work: launch, await, on

test "skein next: launch does not put the launcher into waiting" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.arrive(try signedBy(a, kk().stranger, "/launch-nowait", "", "l1"));
    try testing.expectEqualStrings("finished", c.state);
    const child = Value.cidOf((try bodyOf(a, c.answer)).get("launched")).?;
    const r = try w.rt.answerOf(a, child);
    try testing.expectEqualStrings("finished", r.state);
}

test "skein next: await on a thread — the launcher awaits the thread it launched and resumes once with its result" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.arrive(try signedBy(a, kk().stranger, "/launch", "", "l2"));
    // The child ran after the step and came to rest; the launcher resumed within the same COMMIT.
    try testing.expectEqualStrings("finished", c.state);
    try testing.expectEqualStrings("child", Value.bytesOf((try bodyOf(a, c.answer)).get("resolved")).?);
}

test "skein next: await on a fact's name — the thread resumes once when the fact lands; the host is told (answered)" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const c = try w.arrive(try signedBy(a, kk().stranger, "/awaitname", "", "w1"));
    try testing.expectEqualStrings("waiting", c.state);
    try testing.expect(c.answer == null);
    _ = try w.arrive(try signedBy(a, kk().stranger, "/ping", "", "w2"));
    const r = try w.rt.answerOf(a, c.thread.?);
    try testing.expectEqualStrings("finished", r.state);
    try testing.expectEqualStrings("next/ping", Value.str((try bodyOf(a, r.answer)).get("woke")).?);
    try testing.expectEqual(@as(usize, 1), w.answered.items.len);
    try testing.expectEqualSlices(u8, c.thread.?, w.answered.items[0].thread);
    try testing.expectEqualSlices(u8, c.entry, w.answered.items[0].entry);
    // Once: a second fact wakes nothing more.
    _ = try w.arrive(try signedBy(a, kk().stranger, "/ping", "", "w3"));
    try testing.expectEqual(@as(usize, 1), w.answered.items.len);
}

test "skein next: on(name, fn) runs the app's function on each fact; on with no fn is refused" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    _ = try w.arrive(try signedBy(a, kk().stranger, "/on", "", "o1"));
    try testing.expect((try w.head("next/pinged")) == null);
    _ = try w.arrive(try signedBy(a, kk().stranger, "/ping", "", "o2"));
    try testing.expect((try w.head("next/pinged")) != null);
    const r = try w.arrive(try signedBy(a, kk().stranger, "/on-nofn", "", "o3"));
    try testing.expect(std.mem.indexOf(u8, Value.str((try bodyOf(a, r.answer)).get("error")).?, "await") != null);
}

test "skein next: a module importing the old deadline still links, and the call answers 52; an emit to a key is refused" {
    const w = try world(true);
    defer w.deinit();
    const a = w.a();
    const d = try w.arrive(try signedBy(a, kk().stranger, "/deadline", "", "d1"));
    try testing.expectEqual(@as(i128, 52), Value.intOf((try bodyOf(a, d.answer)).get("deadline")).?);
    const e = try w.arrive(try signedBy(a, kk().stranger, "/emitkey", "", "d2"));
    try testing.expect(std.mem.indexOf(u8, Value.str((try bodyOf(a, e.answer)).get("error")).?, "out of this cut") != null);
}
