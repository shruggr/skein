//! amm-p2p natively: the relay naming its validator (dialled, or this node's
//! own, called in-VM), the handler's answer; the proofs-by-block direct
//! call and the catch-up plan; the names, the cron provider's tick and the
//! libp2p provider's bodies and answers — over an in-memory store. The VM wiring (main.zig) is wasm32-wasi only.
const std = @import("std");
const w = @import("chain");
const wire = @import("wallet").wire;
const names = @import("src/names.zig");
const libp2p = @import("src/libp2p.zig");
const schedule = @import("src/schedule.zig");
const proofs = @import("src/proofs.zig");
/// js-libp2p's peer ID of the generator point's key (skein src/host/p2p.ts `peerIdOf` of the private key 1).
const PEER_ID_OF_G = "16Uiu2HAm3cuhhRL2msUuLF62KRSfneFDx94RsuouyW25Ho42cFMq";
const views = @import("src/views.zig");

const bsvz = w.bsvz;
const cbor = w.cbor;
const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const testing = std.testing;
const eql = std.mem.eql;

comptime {
    _ = &views.held;
    _ = &views.status;
}

fn expectTag(o: anytype, comptime tag: []const u8, reason: ?[]const u8) !void {
    if (!std.mem.eql(u8, @tagName(o), tag)) {
        std.debug.print("expected {s}, got {any}\n", .{ tag, o });
        return error.TestUnexpectedResult;
    }
    if (comptime std.mem.eql(u8, tag, "accept")) return;
    if (reason) |r| {
        const got = @field(o, tag);
        if (!std.mem.eql(u8, got, r)) {
            std.debug.print("expected {s} {s}, got {s}\n", .{ tag, r, got });
            return error.TestUnexpectedResult;
        }
    }
}

/// A value as the host stores it and a program reads it back (dag-cbor).
fn readBack(a: Allocator, v: Value) Value {
    return cbor.decode(a, cbor.encode(a, v) catch @panic("OOM")) catch @panic("bad cbor");
}

// ================================================================ proofs by block

fn parent(l: [32]u8, r: [32]u8) [32]u8 {
    return w.store.dblSha256(&(l ++ r));
}

const PE = std.meta.Elem(std.meta.Elem(@FieldType(w.merkle.MerklePath, "path")));

/// The BUMP of a four-transaction block (t0..t3) for the leaves `which`.
fn bump4(a: Allocator, height: u32, t: [4][32]u8, which: []const usize) ![]const u8 {
    var merged: ?w.merkle.MerklePath = null;
    for (which) |i| {
        const sib = i ^ 1;
        const l0 = try a.alloc(PE, 2);
        const me: PE = .{ .offset = i, .hash = .{ .bytes = t[i] }, .txid = true };
        const other: PE = .{ .offset = sib, .hash = .{ .bytes = t[sib] } };
        l0[0] = if (i < sib) me else other;
        l0[1] = if (i < sib) other else me;
        const up = if (i < 2) parent(t[2], t[3]) else parent(t[0], t[1]);
        const l1 = try a.dupe(PE, &.{.{ .offset = (i >> 1) ^ 1, .hash = .{ .bytes = up } }});
        const levels = try a.dupe([]PE, &.{ l0, l1 });
        const p: w.merkle.MerklePath = .{ .block_height = height, .path = levels };
        if (merged) |*m| try m.combine(&p, a) else merged = p;
    }
    return merged.?.bytes(a);
}

const FakeChain = struct {
    hash: [32]u8,
    root: [32]u8,
    height: u32,
    topic: std.AutoHashMap([32]u8, void),
    paths: std.AutoHashMap([32]u8, w.merkle.MerklePath),

    fn self(ctx: *anyopaque) *FakeChain {
        return @ptrCast(@alignCast(ctx));
    }
    fn heightOf(ctx: *anyopaque, h: [32]u8) anyerror!?u32 {
        return if (std.mem.eql(u8, &h, &self(ctx).hash)) self(ctx).height else null;
    }
    fn inTopic(ctx: *anyopaque, _: []const u8, t: [32]u8) anyerror!bool {
        return self(ctx).topic.contains(t);
    }
    fn provenAt(ctx: *anyopaque, a: Allocator, h: u32) anyerror![]const [32]u8 {
        if (h != self(ctx).height) return &.{};
        var out: std.ArrayList([32]u8) = .empty;
        var it = self(ctx).paths.keyIterator();
        while (it.next()) |k| try out.append(a, k.*);
        std.mem.sort([32]u8, out.items, {}, struct {
            fn lt(_: void, x: [32]u8, y: [32]u8) bool {
                return std.mem.order(u8, &x, &y) == .lt;
            }
        }.lt);
        return out.items;
    }
    fn proofFor(ctx: *anyopaque, _: Allocator, t: [32]u8) anyerror!?w.merkle.MerklePath {
        return self(ctx).paths.get(t);
    }
    fn held(f: *FakeChain) proofs.Held {
        return .{ .ctx = f, .heightOfFn = heightOf, .provenAtFn = provenAt, .inTopicFn = inTopic, .proofForFn = proofFor };
    }
};

test "proofs by block: the direct call's request and reply; one BUMP per block" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const t: [4][32]u8 = .{ .{1} ** 32, .{2} ** 32, .{3} ** 32, .{4} ** 32 };
    const root = parent(parent(t[0], t[1]), parent(t[2], t[3]));
    var f: FakeChain = .{ .hash = .{0xbb} ** 32, .root = root, .height = 100, .topic = .init(a), .paths = .init(a) };
    for ([_]usize{ 1, 2 }) |i| try f.paths.put(t[i], try w.merkle.MerklePath.parse(a, try bump4(a, 100, t, &.{i})));
    try f.topic.put(t[1], {});

    // The whole block (no topic): both paths merged into one BUMP proving both.
    const reply = try proofs.serve(a, f.held(), try proofs.encodeRequest(a, .{ .block_hash = f.hash }));
    const b = (try proofs.decodeReply(a, reply)).?;
    const p = try w.merkle.MerklePath.parse(a, b);
    for ([_]usize{ 1, 2 }) |i| try testing.expectEqualSlices(u8, &root, &(w.beef.rootFor(a, p, t[i]).?));
    try testing.expectEqualSlices(u8, &root, &(switch (try proofs.rootOf(a, b)) {
        .root => |r| r,
        .bad => return error.TestUnexpectedResult,
    }));

    // Restricted to the topic: only t1.
    const rt = (try proofs.decodeReply(a, try proofs.serve(a, f.held(), try proofs.encodeRequest(a, .{ .block_hash = f.hash, .topic = "tm_mandala_" ++ "ab" ** 32 ++ "_0" })))).?;
    const pt = try w.merkle.MerklePath.parse(a, rt);
    try testing.expect(w.beef.bumpHas(pt, t[1]));
    try testing.expect(!w.beef.bumpHas(pt, t[3]));

    // An unknown block, or a malformed request: missing.
    try testing.expect((try proofs.decodeReply(a, try proofs.serve(a, f.held(), try proofs.encodeRequest(a, .{ .block_hash = .{0xcc} ** 32 })))) == null);
    try testing.expect((try proofs.decodeReply(a, try proofs.serve(a, f.held(), "junk"))) == null);
}

test "catch-up plan" {
    // Nothing unsettled: the cursor follows the tip, nothing asked.
    const idle = proofs.catchupPlan(90, 100, 12, 6, false).?;
    try testing.expect(idle.from > idle.to);
    try testing.expectEqual(@as(u32, 100), idle.cursor);
    try testing.expect(proofs.catchupPlan(100, 100, 12, 6, false) == null);
    // Unsettled: after the cursor, a batch at a time, not past the tip.
    const p = proofs.catchupPlan(90, 100, 12, 6, true).?;
    try testing.expectEqual(@as(u32, 91), p.from);
    try testing.expectEqual(@as(u32, 96), p.to);
    try testing.expectEqual(@as(u32, 96), p.cursor);
    const q = proofs.catchupPlan(96, 100, 12, 6, true).?;
    try testing.expectEqual(@as(u32, 100), q.to);
    try testing.expect(proofs.catchupPlan(100, 100, 12, 6, true) == null);
    // No cursor yet: a window below the tip.
    try testing.expectEqual(@as(u32, 89), proofs.catchupPlan(null, 100, 12, 6, true).?.from);

}

test "names: tm_mandala_<txid>_0 and tm_mandala_<txid>_0-live (BRC-207), parsed here" {
    const o = "tm_mandala_" ++ "ab" ** 32 ++ "_0";
    const t = names.parse(o).?;
    try testing.expectEqual(names.Kind.overlay, t.kind);
    try testing.expectEqualSlices(u8, &([_]u8{0xab} ** 32), &t.id);
    const l = names.parse(o ++ "-live").?;
    try testing.expectEqual(names.Kind.live, l.kind);
    try testing.expectEqualStrings(o, l.overlay);
    var buf: [96]u8 = undefined;
    var fba = std.heap.FixedBufferAllocator.init(&buf);
    try testing.expectEqualStrings(o ++ "-live", try names.live(fba.allocator(), o));
    // Not ours: the engine's own suffixes, the old names, upper case, a suffix, a short id.
    try testing.expect(names.parse(o ++ "-proof") == null);
    try testing.expect(names.parse(o ++ "-admit") == null);
    try testing.expect(names.parse("tm_amm_" ++ "ab" ** 32) == null);
    try testing.expect(names.parse(o ++ "_live") == null);
    try testing.expect(names.parse("tm_mandala_" ++ "AB" ** 32 ++ "_0") == null);
    try testing.expect(names.parse(o ++ "_0") == null);
    // The old `tm_<txid>_0` is no topic (skein-mandala 0.9.0: no alias), nor its `-live`; nor the
    // discovery topic, nor the bare `tm_<txid>`.
    try testing.expect(names.parse("tm_" ++ "ab" ** 32 ++ "_0") == null);
    try testing.expect(names.parse("tm_" ++ "ab" ** 32 ++ "_0-live") == null);
    try testing.expect(names.parse("tm_mandala") == null);
    try testing.expect(names.parse("tm_mandala_" ++ "ab" ** 32) == null);
    try testing.expect(names.parse("tm_" ++ "ab" ** 32) == null);
    try testing.expect(names.parse("tm_" ++ "ab" ** 32 ++ "-live") == null);
    try testing.expect(names.parse("tm_abcd-live") == null);
    try testing.expectEqualStrings("/amm/proofs/1.0.0", names.proofs_protocol);
}

test "the catch-up tick (skein#69, a utility since 0.6.0): the cron provider's tick read back; no heartbeat job" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // A tick as the provider sends it: {...body, kind, name, due}.
    const tick: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "kind", .value = .{ .text = "amm-p2p-tick" } },
        .{ .key = "job", .value = .{ .text = "catchup" } },
        .{ .key = "name", .value = .{ .text = "amm-p2p-catchup" } },
        .{ .key = "due", .value = .{ .uint = 1_790_000_000_000 } },
    }) };
    try testing.expectEqual(schedule.Job.catchup, try schedule.jobOf(tick));
    try testing.expectError(error.NotATick, schedule.jobOf(.{ .map = &.{} }));
    for ([_][]const u8{ "proofs", "heartbeat" }) |job| {
        const bad: Value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "amm-p2p-tick" } },
            .{ .key = "job", .value = .{ .text = job } },
        }) };
        try testing.expectError(error.BadTick, schedule.jobOf(bad));
    }
    try testing.expectEqualStrings("amm/amm-p2p", names.own_box);
}

// selfPeerId (main.zig) asks the signer for [2, "skein instance"] / `libp2p:<handle>` / self and
// takes this multihash of it; the host derives its node's key the same way from the instance's root
// (skein 387e057, src/host/signer.ts `peerKey`), so this is the node's peer ID (the relay's `isSelf`).
test "the peer ID of a compressed secp256k1 key: the identity multihash of its protobuf PublicKey (js-libp2p's, 16Uiu2…)" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var k: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&k, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const id = try libp2p.peerIdOf(a, k);
    try testing.expectEqual(@as(usize, 39), id.len);
    try testing.expectEqualSlices(u8, &.{ 0x00, 0x25, 0x08, 0x02, 0x12, 0x21 }, id[0..6]);
    try testing.expectEqualSlices(u8, &k, id[6..]);
    try testing.expectEqualStrings(PEER_ID_OF_G, try libp2p.peerIdText(a, id));
}

test "libp2p adapter: the handler's argument, answers with admit entries, the direct call's answer, the provider's bodies and answers" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const pid = "\x00\x25\x08\x02\x12\x21\x02" ++ "\x55" ** 32;
    // What the front door passes a route's handler.
    const arg: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "transport", .value = .{ .text = "libp2p" } },
        .{ .key = "topic", .value = .{ .text = "tm_x-live" } },
        .{ .key = "from", .value = .{ .bytes = pid } },
        .{ .key = "key", .value = .{ .bytes = pid[6..] } },
        .{ .key = "seqno", .value = .{ .bytes = "\x00\x00\x00\x00\x00\x00\x00\x07" } },
        .{ .key = "signature", .value = .{ .bytes = "sig" } },
        .{ .key = "body", .value = .{ .bytes = "body" } },
    }) };
    const in = try libp2p.inbound(arg);
    try testing.expectEqualSlices(u8, pid, in.from);
    try testing.expectEqualStrings("tm_x-live", in.topic.?);
    try testing.expectError(error.NotLibp2p, libp2p.inbound(.{ .map = &.{} }));

    // Accept carries the entries to admit ({event, box}); reject/ignore a reason only.
    const ev0: Value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "kind", .value = .{ .text = "x" } }}) };
    const ok = readBack(a, try libp2p.answer(a, .{ .accept = &.{.{ .box = "b", .event = ev0 }} }));
    try testing.expectEqualStrings("accept", ok.getText("verdict").?);
    try testing.expectEqualStrings("b", ok.getArray("admit").?[0].getText("box").?);
    const rej = try libp2p.answer(a, .{ .reject = "Why" });
    try testing.expectEqualStrings("reject", rej.getText("verdict").?);
    try testing.expectEqualStrings("Why", rej.getText("reason").?);
    try testing.expect(rej.get("admit") == null);
    const da = readBack(a, try libp2p.directAnswer(a, "reply"));
    try testing.expectEqualSlices(u8, "reply", da.getBytes("body").?);

    // Outbound: the provider's boxes and bodies; `dial` takes the peer as text.
    const p = try libp2p.publish(a, "tm_x-live", "b");
    try testing.expectEqualStrings("publish", p.box);
    try testing.expectEqualStrings("tm_x-live", readBack(a, p.body).getText("topic").?);
    const text = try libp2p.peerIdText(a, pid);
    try testing.expectEqualSlices(u8, pid, try libp2p.peerIdBytes(a, .{ .text = text }));
    const d = try libp2p.dial(a, text, names.proofs_protocol);
    try testing.expectEqualStrings("dial", d.box);
    try testing.expectEqualStrings(text, readBack(a, d.body).getText("peer").?);
    try testing.expectEqual(@as(u64, 3), readBack(a, (try libp2p.send(a, 3, "q")).body).getUint("stream").?);
    try testing.expectEqualStrings("close", (try libp2p.close(a, 3)).box);

    // The dial's answers: {stream} (box dial), a frame, its end, an error.
    const m = struct {
        fn of(al: Allocator, es: []const cbor.Entry) Value {
            return .{ .map = al.dupe(cbor.Entry, es) catch @panic("OOM") };
        }
    };
    try testing.expectEqual(@as(u64, 7), (try libp2p.dialAnswer("dial", m.of(a, &.{.{ .key = "stream", .value = .{ .uint = 7 } }}))).opened);
    try testing.expectEqualSlices(u8, "r", (try libp2p.dialAnswer("frame", m.of(a, &.{ .{ .key = "stream", .value = .{ .uint = 7 } }, .{ .key = "body", .value = .{ .bytes = "r" } } }))).frame);
    try testing.expect((try libp2p.dialAnswer("frame", m.of(a, &.{ .{ .key = "stream", .value = .{ .uint = 7 } }, .{ .key = "closed", .value = .{ .boolean = true } } }))) == .closed);
    try testing.expectEqualStrings("refused", (try libp2p.dialAnswer("dial", m.of(a, &.{.{ .key = "error", .value = .{ .text = "refused" } }}))).closed);
    try testing.expectError(error.BadAnswer, libp2p.dialAnswer("send", m.of(a, &.{})));
}

// ================================================================ the marketplace relay (amm.swap/1)

const relay = @import("src/relay.zig");
const app = @import("app");
const sk = @import("sk");
const scbor = @import("sdk_cbor");
const dagjson = @import("dagjson");
const message = @import("message");
const manifest_json = @import("app_manifest").json;
const mandala = @import("mandala");
const pool_lib = @import("pool");
const vec = @import("vectors");
const Transaction = bsvz.transaction.Transaction;
const Script = bsvz.script.Script;

fn unhex(a: Allocator, h: []const u8) []u8 {
    const out = a.alloc(u8, h.len / 2) catch @panic("OOM");
    _ = std.fmt.hexToBytes(out, h) catch @panic("bad hex");
    return out;
}

/// The fixtures' taker (gen/main.go `key(30)`), who owns fund:1.
const taker_priv: [32]u8 = .{30} ** 32;
/// The relay's commission key hash: the fixtures' relay (gen/main.go `key(50)`, vectors' commission_pkh).
const commission_pkh: [20]u8 = blk: {
    @setEvalBranchQuota(10_000);
    var k: [20]u8 = undefined;
    _ = std.fmt.hexToBytes(&k, vec.commission_pkh) catch unreachable;
    break :blk k;
};
const relay_priv: [32]u8 = .{0x44} ** 32;

fn p2pkhScript(a: Allocator, pkh: []const u8) ![]u8 {
    return std.mem.concat(a, u8, &.{ &.{ 0x76, 0xa9, 0x14 }, pkh, &.{ 0x88, 0xac } });
}

fn pushData(a: Allocator, data: []const u8) ![]u8 {
    if (data.len == 0) return a.dupe(u8, &.{0});
    if (data.len <= 0x4b) return std.mem.concat(a, u8, &.{ &.{@intCast(data.len)}, data });
    if (data.len <= 0xff) return std.mem.concat(a, u8, &.{ &.{ 0x4c, @intCast(data.len) }, data });
    var n: [2]u8 = undefined;
    std.mem.writeInt(u16, &n, @intCast(data.len), .little);
    return std.mem.concat(a, u8, &.{ &.{0x4d}, &n, data });
}

/// A minimal script number push (Rúnar's): OP_0, OP_1..OP_16, else little-endian with a sign byte when needed.
fn pushNum(a: Allocator, n: u64) ![]u8 {
    if (n == 0) return a.dupe(u8, &.{0});
    if (n <= 16) return a.dupe(u8, &.{@intCast(0x50 + n)});
    var b: [9]u8 = undefined;
    var len: usize = 0;
    var x = n;
    while (x > 0) : (x >>= 8) {
        b[len] = @intCast(x & 0xff);
        len += 1;
    }
    if (b[len - 1] & 0x80 != 0) {
        b[len] = 0;
        len += 1;
    }
    return pushData(a, b[0..len]);
}

fn hash160(b: []const u8) [20]u8 {
    return bsvz.crypto.hash.hash160(b).bytes;
}

/// Sign input `i` (P2PKH, ALL|FORKID) as go-sdk's p2pkh.Unlock does: `<DER ‖ 0x41> <pubkey>`.
fn signP2pkh(a: Allocator, tx: *Transaction, i: usize, src: []const u8, sats: u64, priv: [32]u8) !void {
    const k = try bsvz.primitives.ec.PrivateKey.fromBytes(priv);
    const pre = try bsvz.transaction.sighash.formatPreimage(a, tx, i, Script.init(src), @intCast(sats), 0x41);
    const sig = try k.signDigest(bsvz.crypto.hash.hash256(pre).bytes);
    const pubkey = (try k.publicKey()).toCompressedSec1();
    const ins = try a.dupe(bsvz.transaction.Input, tx.inputs);
    ins[i].unlocking_script = Script.init(try std.mem.concat(a, u8, &.{ try pushData(a, try std.mem.concat(a, u8, &.{ sig.asSlice(), &.{0x41} })), try pushData(a, &pubkey) }));
    tx.inputs = ins;
}

/// A pair as the page builds it (docs/notes.md 2026-10-02, "Swap funding and
/// signing"), derived from the fixtures: the funding transaction spends the
/// taker's fund:1 and pays one exact output (the swap's input: amount in +
/// miner fee) to the taker, plus change; the swap is `swap_bsv_in` with its
/// other input replaced by that output, no change (`_changeAmount = 0`), its
/// commission (output 4, the pool's 10 bps of 20,000: 20 sats) and the call's
/// commissionPkh both paying `commission` (default: the relay's), the
/// preimage the pool call pushes recomputed, the validator's slot empty, and
/// the funding input signed by the taker. `fee` is the swap's miner fee (a
/// different fee makes a different swap). The fixtures carry no funding
/// parent of this shape (their swap spends fund:1 directly), so it is built
/// here.
const Pair = struct { funding: []const u8, swap: []const u8, pool: []const u8, validator: [33]u8 };

const PairOpts = struct { commission: [20]u8 = commission_pkh, sign_funding: bool = true, fee: u64 = 500 };

fn buildPair(a: Allocator) !Pair {
    return buildPairWith(a, .{});
}

fn buildPairWith(a: Allocator, o: PairOpts) !Pair {
    const fund = try Transaction.parse(a, unhex(a, vec.fund));
    const pd_raw = unhex(a, vec.pool_deploy);
    const pd = try Transaction.parse(a, pd_raw);
    const base = try Transaction.parse(a, unhex(a, vec.swap_bsv_in));
    const taker_pkh = hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(taker_priv)).publicKey()).toCompressedSec1());
    const taker_lock = try p2pkhScript(a, &taker_pkh);

    // The swap's outputs: continuation, payout, LP fee, validator fee, commission (the fixture's, to `commission`).
    const outs = try a.dupe(bsvz.transaction.Output, base.outputs[0..5]);
    try std.testing.expectEqualSlices(u8, try p2pkhScript(a, &commission_pkh), outs[4].locking_script.bytes);
    outs[4].locking_script = Script.init(try p2pkhScript(a, &o.commission));
    var out_sum: u64 = 0;
    for (outs) |x| out_sum += @intCast(x.satoshis);
    const pool_sats: u64 = @intCast(pd.outputs[0].satoshis);
    const exact = out_sum - pool_sats + o.fee;

    // The funding transaction: fund:1 (500,000, the taker's) → exact, change.
    var f = fund;
    f.inputs = try a.dupe(bsvz.transaction.Input, &.{.{
        .previous_outpoint = .{ .txid = .{ .bytes = w.beef.txidOf(unhex(a, vec.fund)) }, .index = 1 },
        .unlocking_script = Script.empty(),
        .sequence = 0xffffffff,
    }});
    f.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = Script.init(taker_lock) },
        .{ .satoshis = @intCast(500_000 - exact - 300), .locking_script = Script.init(taker_lock) },
    });
    if (o.sign_funding) try signP2pkh(a, &f, 0, fund.outputs[1].locking_script.bytes, @intCast(fund.outputs[1].satoshis), taker_priv);
    const f_raw = try f.serialize(a);

    // The swap: the pool, then the funding output.
    var s = base;
    const sins = try a.dupe(bsvz.transaction.Input, &.{ base.inputs[0], .{
        .previous_outpoint = .{ .txid = .{ .bytes = w.beef.txidOf(f_raw) }, .index = 0 },
        .unlocking_script = Script.empty(),
        .sequence = 0xffffffff,
    } });
    s.inputs = sins;
    s.outputs = outs;
    const lock = mandala.brc162.decode(pd.outputs[0].locking_script.bytes).?.lock;
    const pre = try bsvz.transaction.sighash.formatPreimage(a, &s, 0, Script.init(lock[2..]), @intCast(pool_sats), 0x41);
    // The pool call, push by push (_codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
    // commissionPkh, _changePKH, _changeAmount, txPreimage, methodIndex): the slot empty, the commission's pkh,
    // no change, the new preimage.
    const u = base.inputs[0].unlocking_script.bytes;
    var pos: usize = 0;
    var i: usize = 0;
    var script: std.ArrayList(u8) = .empty;
    while (pos < u.len) : (i += 1) {
        const p = mandala.brc162.readPush(u, pos).?;
        const raw = u[pos..p.next];
        try script.appendSlice(a, switch (i) {
            1 => &.{0}, // validatorSig: the slot, empty
            6 => try pushData(a, &o.commission),
            8 => &.{0}, // _changeAmount = 0
            9 => try pushData(a, pre),
            else => raw,
        });
        pos = p.next;
    }
    try std.testing.expectEqual(@as(usize, relay.swap_pushes), i);
    sins[0].unlocking_script = Script.init(script.items);
    try signP2pkh(a, &s, 1, taker_lock, exact, taker_priv);
    const pool_text = try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(w.beef.txidOf(pd_raw))});
    var validator: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&validator, vec.identity);
    return .{ .funding = f_raw, .swap = try s.serialize(a), .pool = pool_text, .validator = validator };
}

fn expectRefusal(c: relay.Checked, reason: []const u8) !void {
    switch (c) {
        .ok => {
            std.debug.print("expected {s}, got ok\n", .{reason});
            return error.TestExpectedRefusal;
        },
        .refused => |r| {
            if (!eql(u8, r.reason, reason)) std.debug.print("expected {s}, got {s} ({s})\n", .{ reason, r.reason, r.detail orelse "" });
            try testing.expectEqualStrings(reason, r.reason);
        },
    }
}

const ours: relay.Commission = .{ .pkh = commission_pkh };
const t_now: u64 = 1_700_000_000_000;
const t_expires: u64 = t_now + 60_000;

test "relay: a pair from the fixtures (the funding transaction pays the swap's input exactly; the swap spends it, its commission paying us) is checked; each refusal" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try buildPair(a);

    const ok = try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_expires, t_now, ours);
    try testing.expect(ok == .ok);
    try testing.expectEqual(@as(u64, 20_000), ok.ok.call.amount_in);
    try testing.expect(ok.ok.call.bsv_in);
    try testing.expectEqualSlices(u8, &commission_pkh, ok.ok.call.commission_pkh);
    try testing.expectEqual(@as(u64, 0), ok.ok.call.change);
    try testing.expectEqual(@as(i64, vec.lp_fee_bps), ok.ok.continuation.lp_fee_bps);
    try testing.expectEqual(@as(i64, vec.commission_bps), ok.ok.continuation.commission_bps);
    // Without a commission pkh configured, any commission payee passes.
    try testing.expect(try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_expires, t_now, .{}) == .ok);
    const other = try buildPairWith(a, .{ .commission = .{0x22} ** 20 });
    try testing.expect(try relay.checkPair(a, other.funding, other.swap, other.pool, &other.validator, t_expires, t_now, .{}) == .ok);

    // Our commission: another's.
    try expectRefusal(try relay.checkPair(a, other.funding, other.swap, other.pool, &other.validator, t_expires, t_now, ours), "commission_missing");
    // A pool charging no commission has no commission output: our check passes.
    {
        var s = try Transaction.parse(a, other.swap);
        const lock = mandala.brc162.decode(s.outputs[0].locking_script.bytes).?.lock;
        // CommissionBps (template offset 626) sits at 627 in the lock (the pool test of the slot, test.zig), as OP_10.
        const at = s.outputs[0].locking_script.bytes.len - lock.len + 627;
        try testing.expectEqual(@as(u8, 0x5a), s.outputs[0].locking_script.bytes[at]);
        const outs = try a.dupe(bsvz.transaction.Output, s.outputs[0..4]);
        const zero = try a.dupe(u8, s.outputs[0].locking_script.bytes);
        zero[at] = 0x00;
        outs[0].locking_script = Script.init(zero);
        s.outputs = outs;
        const c = try relay.checkPair(a, other.funding, try s.serialize(a), other.pool, &other.validator, t_expires, t_now, ours);
        try testing.expect(c == .ok);
        try testing.expectEqual(@as(i64, 0), c.ok.continuation.commission_bps);
    }

    // The pair itself.
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_now, t_now, ours), "expired");
    try expectRefusal(try relay.checkPair(a, "junk", p.swap, p.pool, &p.validator, t_expires, t_now, ours), "bad_funding");
    try expectRefusal(try relay.checkPair(a, p.funding, "junk", p.pool, &p.validator, t_expires, t_now, ours), "bad_swap");
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, "nope", &p.validator, t_expires, t_now, ours), "bad_pool");
    const wrong_pool = try std.fmt.allocPrint(a, "{s}_1", .{p.pool[0..64]});
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, wrong_pool, &p.validator, t_expires, t_now, ours), "pool_not_input_0");
    try expectRefusal(try relay.checkPair(a, unhex(a, vec.fund), p.swap, p.pool, &p.validator, t_expires, t_now, ours), "funding_not_spent");
    var other_key = p.validator;
    other_key[5] ^= 1;
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, p.pool, &other_key, t_expires, t_now, ours), "wrong_validator");
    try expectRefusal(try relay.checkPair(a, p.funding, p.swap, p.pool, p.validator[0..32], t_expires, t_now, ours), "bad_validator");

    // Unsigned: the funding transaction's input, the swap's funding input.
    {
        const u = try buildPairWith(a, .{ .sign_funding = false });
        try expectRefusal(try relay.checkPair(a, u.funding, u.swap, u.pool, &u.validator, t_expires, t_now, ours), "funding_unsigned");
        var s = try Transaction.parse(a, p.swap);
        const ins = try a.dupe(bsvz.transaction.Input, s.inputs);
        ins[1].unlocking_script = Script.empty();
        s.inputs = ins;
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "swap_unsigned");
    }
    // The fixture's own swap: signed by the validator already, and spending fund:1, not a funding output.
    try expectRefusal(try relay.checkPair(a, unhex(a, vec.fund), unhex(a, vec.swap_bsv_in), p.pool, &p.validator, t_expires, t_now, .{}), "signature_slot_not_empty");
    // An output past the contract's (a change output the call does not name).
    {
        var s = try Transaction.parse(a, p.swap);
        s.outputs = try std.mem.concat(a, bsvz.transaction.Output, &.{ s.outputs, &.{s.outputs[4]} });
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        // The commission output dropped while the pool charges one.
        s.outputs = s.outputs[0..4];
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        // The commission one sat short; paying another than the call names.
        const short = try a.dupe(bsvz.transaction.Output, (try Transaction.parse(a, p.swap)).outputs);
        short[4].satoshis -= 1;
        s.outputs = short;
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
        const elsewhere = try a.dupe(bsvz.transaction.Output, (try Transaction.parse(a, p.swap)).outputs);
        elsewhere[4].locking_script = Script.init(try p2pkhScript(a, &(.{0x22} ** 20)));
        s.outputs = elsewhere;
        try expectRefusal(try relay.checkPair(a, p.funding, try s.serialize(a), p.pool, &p.validator, t_expires, t_now, ours), "bad_outputs");
    }
    // Not a swap: the Close fixture's pool input (0.9.0: the LP's alone).
    try expectRefusal(try relay.checkPair(a, unhex(a, vec.fund), unhex(a, vec.close), try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(w.beef.txidOf(unhex(a, vec.swap_tokens_in)))}), &p.validator, t_expires, t_now, .{}), "not_a_swap");
}

fn keySigner(a: Allocator, priv: [32]u8) !relay.Signer {
    const k = try a.create([32]u8);
    k.* = priv;
    return .{ .ctx = k, .identityFn = struct {
        fn f(ctx: *anyopaque, _: Allocator) anyerror![33]u8 {
            const p: *[32]u8 = @ptrCast(@alignCast(ctx));
            const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(p.*));
            return (try kd.identityKey()).toCompressedSec1();
        }
    }.f, .signFn = struct {
        fn f(ctx: *anyopaque, al: Allocator, hash: [32]u8) anyerror![]const u8 {
            const p: *[32]u8 = @ptrCast(@alignCast(ctx));
            const kd = bsvz.primitives.key_deriver.KeyDeriver.init(try bsvz.primitives.ec.PrivateKey.fromBytes(p.*));
            const child = try kd.derivePrivateKey(al, .{ .security_level = 2, .name = relay.envelope_protocol }, relay.envelope_key_id, .{ .type_ = .anyone });
            const sig = try child.signDigest(hash);
            return al.dupe(u8, sig.asSlice());
        }
    }.f };
}

test "relay: the one BEEF (the funding transaction's ancestry, the funding transaction, the swap) and the signed package the validator opens" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const p = try buildPair(a);
    const pair = (try relay.checkPair(a, p.funding, p.swap, p.pool, &p.validator, t_expires, t_now, ours)).ok;

    // A raw funding transaction: [funding, swap].
    const b1 = try w.beef.parse(a, try relay.requestBeef(a, pair));
    try testing.expectEqual(@as(usize, 2), b1.entries.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.funding), &b1.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &b1.subject().?);

    // The funding as a BEEF (createAction's): its parent fund comes along, an unrelated entry does not.
    const fund_raw = unhex(a, vec.fund);
    const fbeef = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{
        .{ .txid = w.beef.txidOf(unhex(a, vec.token_deploy)), .format = .raw, .raw = unhex(a, vec.token_deploy) },
        .{ .txid = w.beef.txidOf(fund_raw), .format = .raw, .raw = fund_raw },
        .{ .txid = w.beef.txidOf(p.funding), .format = .raw, .raw = p.funding },
    }) });
    const pair2 = (try relay.checkPair(a, fbeef, p.swap, p.pool, &p.validator, t_expires, t_now, ours)).ok;
    const b2 = try w.beef.parse(a, try relay.requestBeef(a, pair2));
    try testing.expectEqual(@as(usize, 3), b2.entries.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(fund_raw), &b2.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.funding), &b2.entries[1].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &b2.subject().?);

    // The package: a mail record signed by this instance (BRC-169), recipient the validator, box `swap`.
    const rec: relay.Record = .{ .id = relay.idOf(p.swap), .funding = fbeef, .swap = p.swap, .pool = p.pool, .validator = p.validator, .expires = t_expires, .created = t_now, .updated = t_now };
    const signer = try keySigner(a, relay_priv);
    const frame = try relay.packageFor(a, signer, rec);
    const pkg = try scbor.decode(a, frame);
    const m = pkg.get("message").?;
    const body = scbor.Value.bytesOf(pkg.get("body")).?;
    try testing.expect((try message.problem(a, m, body)) == null);
    try testing.expectEqualSlices(u8, &p.validator, scbor.Value.bytesOf(m.get("recipient")).?);
    try testing.expectEqualStrings("swap", scbor.Value.str(m.get("box")).?);
    try testing.expectEqualSlices(u8, &(try signer.identityFn(signer.ctx, a)), scbor.Value.bytesOf(m.get("sender")).?);
    const req = try cbor.decode(a, body);
    try testing.expectEqualStrings(p.pool, req.getText("pool").?);
    const sent = try w.beef.parse(a, req.getBytes("tx").?);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(p.swap), &sent.subject().?);
    // Another swap, another nonce (the record is unique to the swap).
    try testing.expect(!eql(u8, &relay.nonceOf(rec.id), &relay.nonceOf(relay.idOf(p.funding))));
}

fn frameOf(a: Allocator, v: Value) ![]const u8 {
    return cbor.encode(a, v);
}

test "relay: the record's lifecycle over the libp2p provider's answers — accepted, refused (with the pool's state), timeout, failed — kept in the app's state" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const p = try buildPair(a);
    const fresh: relay.Record = .{ .id = relay.idOf(p.swap), .funding = p.funding, .swap = p.swap, .pool = p.pool, .validator = p.validator, .expires = t_expires, .created = t_now, .updated = t_now, .peer = "16Uiu2HAmL3ee25zUdPHFTUVToTuzBgBjt8yoxAd952pYyvfbmDT9" };

    // pending → dial → opened (send the package) → the frame {ok: true} → accepted, the stream closed.
    {
        var r = fresh;
        const start = try relay.advance(a, &r, .start, t_now, null);
        try testing.expect(start.rest and !start.done);
        try testing.expectEqual(@as(?usize, 0), start.dial);
        try testing.expectEqualStrings("dial", start.emits[0].box);
        try testing.expectEqualStrings(relay.swap_protocol, start.emits[0].body.getText("protocol").?);
        try testing.expectEqualStrings(fresh.peer.?, start.emits[0].body.getText("peer").?);
        const opened = try relay.advance(a, &r, .{ .answer = .{ .opened = 7 } }, t_now + 10, "the package");
        try testing.expect(opened.rest and !opened.done);
        try testing.expectEqualStrings("send", opened.emits[0].box);
        try testing.expectEqualStrings("the package", opened.emits[0].body.getBytes("body").?);
        try testing.expectEqual(@as(?u64, 7), r.stream);
        const signed = "the signed swap";
        const done = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = &.{
            .{ .key = "ok", .value = .{ .boolean = true } },
            .{ .key = "tx", .value = .{ .bytes = signed } },
            .{ .key = "txid", .value = .{ .text = "ab" ** 32 } },
        } }) } }, t_now + 20, null);
        try testing.expect(done.done);
        try testing.expectEqualStrings("close", done.emits[0].box);
        try testing.expectEqual(relay.Status.accepted, r.status);
        try testing.expectEqualStrings(signed, r.tx.?);
        try testing.expectEqual(t_now + 20, r.updated);
        // Settled: nothing more happens to it.
        try testing.expect((try relay.advance(a, &r, .woke, t_expires + 1, null)).done);
        try testing.expectEqual(relay.Status.accepted, r.status);

        // Kept under the app's state, read back as stored; the answer leaves out the relay's own fields.
        var book = try relay.Book.load(a, ms.store(), null);
        r.dial = &w.store.hashCid(.tx, .{1} ** 32);
        r.thread = &w.store.hashCid(.tx, .{2} ** 32);
        r.request = .{ .message = &w.store.hashCid(.tx, .{3} ** 32), .sender = &p.validator };
        try book.put(a, r);
        const st = readBack(a, try book.state(a));
        try testing.expectEqualStrings(relay.state_kind, st.getText("kind").?);
        var again = try relay.Book.load(a, ms.store(), st);
        const back = (try again.get(a, r.id)).?;
        try testing.expectEqual(relay.Status.accepted, back.status);
        try testing.expectEqualSlices(u8, p.funding, back.funding);
        try testing.expectEqual(@as(?u64, 7), back.stream);
        try testing.expectEqualSlices(u8, r.thread.?, back.thread.?);
        try testing.expectEqualSlices(u8, &p.validator, back.request.?.sender);
        const ans = readBack(a, try back.answer(a));
        try testing.expectEqualStrings("accepted", ans.getText("status").?);
        try testing.expectEqualStrings(&relay.idText(r.id), ans.getText("id").?);
        try testing.expectEqualStrings(signed, ans.getBytes("tx").?);
        try testing.expect(ans.get("thread") == null and ans.get("dial") == null and ans.get("request") == null and ans.get("peer") == null);
        try testing.expect((try again.get(a, relay.idOf(p.funding))) == null);
    }

    // The validator refuses: refused, with its reason and the pool's newest state.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 8 } }, t_now, "pkg");
        const fx = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = &.{
            .{ .key = "ok", .value = .{ .boolean = false } },
            .{ .key = "reason", .value = .{ .text = "pool_spent" } },
            .{ .key = "pool", .value = .{ .map = &.{
                .{ .key = "outpoint", .value = .{ .text = "cd" ** 32 ++ "_0" } },
                .{ .key = "bsvReserve", .value = .{ .uint = 1_019_930 } },
            } } },
        } }) } }, t_now + 5, null);
        try testing.expect(fx.done);
        try testing.expectEqual(relay.Status.refused, r.status);
        try testing.expectEqualStrings("pool_spent", r.reason.?);
        const ans = readBack(a, try r.answer(a));
        try testing.expectEqual(@as(u64, 1_019_930), ans.get("poolState").?.getUint("bsvReserve").?);
    }

    // No answer by `expires`: woken early it rests again; at `expires`, timeout, the stream closed.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 9 } }, t_now, "pkg");
        const early = try relay.advance(a, &r, .woke, t_expires - 1, null);
        try testing.expect(early.rest and !early.done);
        try testing.expectEqual(relay.Status.pending, r.status);
        const late = try relay.advance(a, &r, .woke, t_expires, null);
        try testing.expect(late.done);
        try testing.expectEqual(relay.Status.timeout, r.status);
        try testing.expectEqualStrings("close", late.emits[0].box);
        try testing.expect(relay.Status.timeout.retryable());
        // Launched after it expired: no dial at all.
        var r2 = fresh;
        const fx = try relay.advance(a, &r2, .start, t_expires, null);
        try testing.expect(fx.done and fx.emits.len == 0);
        try testing.expectEqual(relay.Status.timeout, r2.status);
    }

    // The dial fails, or the stream ends without a frame: failed (retryable). A garbled frame: failed.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        try testing.expect((try relay.advance(a, &r, .{ .answer = .{ .closed = "dial failed: no route" } }, t_now, null)).done);
        try testing.expectEqual(relay.Status.failed, r.status);
        try testing.expectEqualStrings("unreachable", r.reason.?);
        var r2 = fresh;
        _ = try relay.advance(a, &r2, .start, t_now, null);
        _ = try relay.advance(a, &r2, .{ .answer = .{ .opened = 1 } }, t_now, "pkg");
        _ = try relay.advance(a, &r2, .{ .answer = .{ .frame = "\xff" } }, t_now, null);
        try testing.expectEqual(relay.Status.failed, r2.status);
        try testing.expectEqualStrings("bad_reply", r2.reason.?);
    }
}

test "relay: the validator named (0.4.0) — submit dials the peer given; this node's own peer is handed to its own validator program in-VM: wait, called again, answered; failed; timeout" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var book = try relay.Book.load(a, ms.store(), null);
    test_env = .{ .book = &book };
    const p = try buildPair(a);
    var dummy: u8 = 0;
    const args = try fromSdk(a, try submitArgs(a, p, null));

    // Another node's peer named: recorded as given, not local; the relay dials it.
    test_env.self_peer = "16Uiu2HAmL3ee25zUdPHFTUVToTuzBgBjt8yoxAd952pYyvfbmDT9";
    const env: relay.Env = .{ .book = &book, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = test_env.self_peer, .launchFn = testLaunch };
    var r = (try relay.submit(a, env, args)).launched;
    try testing.expectEqualStrings(named_peer, r.peer.?);
    try testing.expect(!r.local);
    const start = try relay.advance(a, &r, .start, t_now, null);
    try testing.expectEqualStrings("dial", start.emits[0].box);
    try testing.expectEqualStrings(named_peer, start.emits[0].body.getText("peer").?);
    try testing.expectEqualStrings(relay.swap_protocol, start.emits[0].body.getText("protocol").?);
    // Unknown self (no handle): never local.
    try testing.expect(!relay.isSelf(.{ .book = &book, .now = t_now, .commission = ours, .ctx = &dummy, .launchFn = testLaunch }, named_peer));

    // This node's own peer named: local, kept so in the stored record (not in the answer).
    var book2 = try relay.Book.load(a, ms.store(), null);
    const self_env: relay.Env = .{ .book = &book2, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = named_peer, .launchFn = testLaunch };
    const fresh = (try relay.submit(a, self_env, args)).launched;
    try testing.expect(fresh.local);
    try testing.expectEqualStrings(named_peer, fresh.peer.?);
    const back = (try book2.get(a, fresh.id)).?;
    try testing.expect(back.local);
    try testing.expect((readBack(a, try back.answer(a))).get("local") == null);

    // Launched: call the validator (no dial, nothing emitted). It awaited its submission: rest.
    {
        var l = fresh;
        const fx = relay.advanceLocal(&l, .start, t_now);
        try testing.expect(fx.call and !fx.done and fx.emits.len == 0 and fx.dial == null);
        const waiting = relay.localAnswer(a, &l, readBack(a, .{ .map = &.{.{ .key = "wait", .value = .{ .boolean = true } }} }), "");
        try testing.expect(waiting.rest and !waiting.done);
        try testing.expectEqual(relay.Status.pending, l.status);
        // Stepped by the engine's answer: called again; the handler answers the reply frame.
        const again = relay.advanceLocal(&l, .again, t_now + 10);
        try testing.expect(again.call);
        const signed = "the signed swap";
        const done = relay.localAnswer(a, &l, readBack(a, .{ .map = &.{
            .{ .key = "verdict", .value = .{ .text = "accept" } },
            .{ .key = "body", .value = .{ .bytes = try frameOf(a, .{ .map = &.{
                .{ .key = "ok", .value = .{ .boolean = true } },
                .{ .key = "tx", .value = .{ .bytes = signed } },
                .{ .key = "txid", .value = .{ .text = "ab" ** 32 } },
            } }) } },
        } }), "");
        try testing.expect(done.done and done.emits.len == 0);
        try testing.expectEqual(relay.Status.accepted, l.status);
        try testing.expectEqualStrings(signed, l.tx.?);
        // Settled: nothing more.
        try testing.expect(relay.advanceLocal(&l, .again, t_now + 20).done);
    }
    // A refusal at once: refused with the reason.
    {
        var l = fresh;
        _ = relay.advanceLocal(&l, .start, t_now);
        const fx = relay.localAnswer(a, &l, readBack(a, .{ .map = &.{
            .{ .key = "verdict", .value = .{ .text = "accept" } },
            .{ .key = "body", .value = .{ .bytes = try frameOf(a, .{ .map = &.{
                .{ .key = "ok", .value = .{ .boolean = false } },
                .{ .key = "reason", .value = .{ .text = "not_validating" } },
            } }) } },
        } }), "");
        try testing.expect(fx.done);
        try testing.expectEqual(relay.Status.refused, l.status);
        try testing.expectEqualStrings("not_validating", l.reason.?);
    }
    // The call fails (no validator program, the handler errors): failed, retryable; no body: failed.
    {
        var l = fresh;
        _ = relay.advanceLocal(&l, .start, t_now);
        try testing.expect(relay.localAnswer(a, &l, null, "NoValidatorProgram").done);
        try testing.expectEqual(relay.Status.failed, l.status);
        try testing.expectEqualStrings("validator_failed", l.reason.?);
        try testing.expectEqualStrings("NoValidatorProgram", l.detail.?);
        try testing.expect(l.status.retryable());
        var l2 = fresh;
        _ = relay.localAnswer(a, &l2, readBack(a, .{ .map = &.{.{ .key = "verdict", .value = .{ .text = "accept" } }} }), "");
        try testing.expectEqualStrings("bad_reply", l2.reason.?);
    }
    // Woken before `expires`: rest; at `expires`: timeout. Launched after it: timeout, no call.
    {
        var l = fresh;
        _ = relay.advanceLocal(&l, .start, t_now);
        try testing.expect(relay.advanceLocal(&l, .woke, t_expires - 1).rest);
        const late = relay.advanceLocal(&l, .woke, t_expires);
        try testing.expect(late.done and !late.call);
        try testing.expectEqual(relay.Status.timeout, l.status);
        var l2 = fresh;
        const fx = relay.advanceLocal(&l2, .start, t_expires);
        try testing.expect(fx.done and !fx.call);
        try testing.expectEqual(relay.Status.timeout, l2.status);
    }
}

// --- the dispatch, by the app's manifest (app/etc/app.json), with the functions over memory ---

const TestEnv = struct {
    book: *relay.Book,
    /// This node's own peer ID, as main.zig's `selfPeerText` gives it (null: unknown).
    self_peer: ?[]const u8 = null,
    launched: usize = 0,
    commission: relay.Commission = ours,
    seen_writes: ?bool = null,
    launched_kind: ?relay.Kind = null,
};
var test_env: TestEnv = undefined;

/// The validator's peer ID as the page names it (taken from the runtime's liveness read).
const named_peer = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";

/// `args` with `peerId` set to `peer`, or removed (null).
fn withPeer(a: Allocator, args: scbor.Value, peer: ?[]const u8) !scbor.Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    for ((try fromSdk(a, args)).map) |e| if (!eql(u8, e.key, "peerId")) try es.append(a, e);
    if (peer) |x| try es.append(a, .{ .key = "peerId", .value = .{ .text = x } });
    return toSdk(a, .{ .map = es.items });
}
fn testLaunch(_: *anyopaque, _: Allocator, kind: relay.Kind, _: [32]u8) anyerror![]const u8 {
    test_env.launched += 1;
    test_env.launched_kind = kind;
    return &w.store.hashCid(.tx, .{9} ** 32);
}
fn fromSdk(a: Allocator, v: scbor.Value) !Value {
    return cbor.decode(a, try scbor.encode(a, v));
}
fn toSdk(a: Allocator, v: Value) !scbor.Value {
    return scbor.decode(a, try cbor.encode(a, v));
}
fn testSubmit(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    var dummy: u8 = 0;
    const env: relay.Env = .{ .book = test_env.book, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = test_env.self_peer, .launchFn = testLaunch };
    return switch (try relay.submit(c.a, env, try fromSdk(c.a, c.args))) {
        .refused => |r| sk.report(try relay.refusalText(c.a, r)),
        .launched, .pending, .settled => |r| toSdk(c.a, try r.answer(c.a)),
    };
}
fn testStatus(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    return switch (try relay.status(c.a, test_env.book, try fromSdk(c.a, c.args))) {
        .found => |r| toSdk(c.a, try r.answer(c.a)),
        .not_found => sk.report("not_found"),
        .bad_id => sk.report("bad_id"),
    };
}
fn testTerms(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    return toSdk(c.a, try relay.terms(c.a, test_env.commission));
}
const test_fns = [_]app.Function{
    .{ .name = relay.fn_submit, .run = testSubmit },
    .{ .name = relay.fn_status, .run = testStatus },
    .{ .name = relay.fn_terms, .run = testTerms },
};

fn submitArgs(a: Allocator, p: Pair, extra: ?cbor.Entry) !scbor.Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "funding", .value = .{ .bytes = p.funding } },
        .{ .key = "swap", .value = .{ .bytes = p.swap } },
        .{ .key = "pool", .value = .{ .text = p.pool } },
        .{ .key = "validator", .value = .{ .bytes = &p.validator } },
        .{ .key = "peerId", .value = .{ .text = named_peer } },
        .{ .key = "expires", .value = .{ .uint = t_expires } },
    });
    if (extra) |e| try es.append(a, e);
    return toSdk(a, .{ .map = es.items });
}

fn expectErr(o: app.Outcome, code: app.Code, msg_prefix: []const u8) !void {
    switch (o) {
        .ok => return error.TestExpectedError,
        .err => |f| {
            if (f.code != code or !std.mem.startsWith(u8, f.message, msg_prefix)) std.debug.print("expected {s} {s}, got {s} {s}\n", .{ @tagName(code), msg_prefix, @tagName(f.code), f.message });
            try testing.expectEqual(code, f.code);
            try testing.expect(std.mem.startsWith(u8, f.message, msg_prefix));
        },
    }
}

test "relay: dispatch by the manifest (app/etc/app.json, amm.swap/1) — submit records and launches, the same swap again answers its record, status reads it; shapes and writes as declared" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var book = try relay.Book.load(a, ms.store(), null);
    test_env = .{ .book = &book };
    const m = try dagjson.decode(a, manifest_json);
    const in: scbor.Value = .{ .map = &.{} };
    const p = try buildPair(a);

    // The declarations.
    try testing.expect((try app.declOf(a, m, relay.fn_submit)).?.get("writes").?.bool);
    try testing.expect(!(try app.declOf(a, m, relay.fn_status)).?.get("writes").?.bool);

    // submit: recorded pending, the relay launched once; the answer is the record.
    const r1 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, null), null);
    try testing.expect(r1 == .ok);
    try testing.expectEqual(@as(?bool, true), test_env.seen_writes);
    const rec = try fromSdk(a, r1.ok);
    try testing.expectEqualStrings("pending", rec.getText("status").?);
    try testing.expectEqualStrings(&relay.idText(relay.idOf(p.swap)), rec.getText("id").?);
    try testing.expectEqual(@as(usize, 1), test_env.launched);
    // The same swap again: its record, no second relay.
    const r2 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, null), null);
    try testing.expect(r2 == .ok);
    try testing.expectEqual(@as(usize, 1), test_env.launched);

    // status: the record; an unknown id, not_found; read-only as declared.
    var sargs = scbor.MapBuilder.init(a);
    try sargs.put("id", scbor.string(rec.getText("id").?));
    const s1 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_status, sargs.value(), null);
    try testing.expect(s1 == .ok);
    try testing.expectEqual(@as(?bool, false), test_env.seen_writes);
    try testing.expectEqualStrings("pending", (try fromSdk(a, s1.ok)).getText("status").?);
    var unknown = scbor.MapBuilder.init(a);
    try unknown.put("id", scbor.string("00" ** 32));
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_status, unknown.value(), null), .failed, "not_found");

    // The declared shapes: a missing arg, an extra one, a wrong type.
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_status, .{ .map = &.{} }, null), .@"bad-args", "args.id: missing");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, .{ .key = "fee", .value = .{ .uint = 1 } }), null), .@"bad-args", "args.fee: not in the shape");
    const bad = try a.dupe(cbor.Entry, (try fromSdk(a, try submitArgs(a, p, null))).map);
    for (bad) |*e| if (eql(u8, e.key, "pool")) {
        e.value = .{ .uint = 0 };
    };
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try toSdk(a, .{ .map = bad }), null), .@"bad-args", "args.pool: want string");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, "amm.swap.cancel", .{ .map = &.{} }, null), .@"unknown-fn", "amm.swap.cancel");

    // A refusal is the function's error, and nothing is recorded or launched.
    const none = try buildPairWith(a, .{ .commission = .{0x22} ** 20 });
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, none, null), null), .failed, "commission_missing");
    // 0.4.0: the caller names the validator's peer; no liveness is looked at. No peerId: the
    // declared shape refuses it; one that is no peer ID text: bad_peer. Nothing recorded or launched.
    const other = try buildPairWith(a, .{ .fee = 600 });
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try withPeer(a, try submitArgs(a, other, null), null), null), .@"bad-args", "args.peerId: missing");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try withPeer(a, try submitArgs(a, other, null), ""), null), .failed, "bad_peer");
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try withPeer(a, try submitArgs(a, other, null), "/ip4/1.2.3.4/tcp/1"), null), .failed, "bad_peer");
    try testing.expectEqual(@as(usize, 1), test_env.launched);
    try testing.expect((try book.get(a, relay.idOf(other.swap))) == null);
    // The record dials the peer named, not this node's own.
    const named = (try book.get(a, relay.idOf(p.swap))).?;
    try testing.expectEqualStrings(named_peer, named.peer.?);
    try testing.expect(!named.local);

    // terms: the relay's commission pkh, read-only as declared; none configured, null; no args taken.
    try testing.expect(!(try app.declOf(a, m, relay.fn_terms)).?.get("writes").?.bool);
    const t1 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, .{ .map = &.{} }, null);
    try testing.expect(t1 == .ok);
    try testing.expectEqual(@as(?bool, false), test_env.seen_writes);
    try testing.expectEqualSlices(u8, &commission_pkh, (try fromSdk(a, t1.ok)).getBytes("commissionPkh").?);
    test_env.commission = .{};
    const t2 = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, null, null);
    try testing.expect(t2 == .ok);
    try testing.expect((try fromSdk(a, t2.ok)).get("commissionPkh").? == .null);
    test_env.commission = ours;
    var targs = scbor.MapBuilder.init(a);
    try targs.put("pool", scbor.string(p.pool));
    try expectErr(try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_terms, targs.value(), null), .@"bad-args", "args.pool: not in the shape");

    // A swap that timed out is relayed again.
    var r = (try book.get(a, relay.idOf(p.swap))).?;
    r.status = .timeout;
    try book.put(a, r);
    _ = try app.run(a, in, relay.app_name, m, &test_fns, relay.fn_submit, try submitArgs(a, p, null), null);
    try testing.expectEqual(@as(usize, 2), test_env.launched);
    try testing.expectEqual(relay.Status.pending, (try book.get(a, relay.idOf(p.swap))).?.status);
}

test "the relay's head is the app's root head <app>/app (skein-sdk 0.3.0 app.headOf)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectEqualStrings(try app.headOf(arena.allocator(), relay.app_name), relay.app_head);
}

test "this program's state head is under the app's name, amm/p2p (#77: an app advances only <app>/…)" {
    try std.testing.expectEqualStrings("amm/p2p", relay.p2p_head);
    try std.testing.expect(std.mem.startsWith(u8, relay.p2p_head, relay.app_name ++ "/"));
}

// ================================================================ the pool deploy through the relay (amm.pool/1)

/// The fixtures' LP (gen/main.go `key(10)`), who owns pool_deploy:2 (4,949,999 tokens) and fund:3 (100,000 sats).
const lp_priv: [32]u8 = .{10} ** 32;

const DeployFx = struct {
    /// The funding transaction (raw) and its BEEF (fund, the funding transaction).
    funding: []const u8,
    funding_beef: []const u8,
    /// The deploy (raw) and its BEEF as the page sends it (its ancestry: pool_deploy, the funding transaction; the deploy).
    deploy: []const u8,
    deploy_beef: []const u8,
    validator: [33]u8,
    pool_deploy: []const u8,
};

const DeployOpts = struct {
    sign_funding: bool = true,
    sign_deploy: bool = true,
    /// The token input keying ValidatorPubKey (pool_deploy:<key_vout>): 2 is the deploy's first token input.
    key_vout: u32 = 2,
    /// Carry the token input's source (pool_deploy) and the funding transaction in the deploy's BEEF.
    with_parent: bool = true,
    with_funding: bool = true,
    /// Spend the token input at all.
    token_input: bool = true,
    /// The deploy's miner fee (another fee, another deploy).
    fee: u64 = 400,
};

fn lpPkh() ![20]u8 {
    return hash160(&(try (try bsvz.primitives.ec.PrivateKey.fromBytes(lp_priv)).publicKey()).toCompressedSec1());
}

/// A pool output: the fixture pool's code and fees, its state replaced (reserve, ValidatorPubKey), the prefix rewritten to match.
fn poolScript(a: Allocator, fixture: []const u8, reserve: u64, validator_key: [33]u8) ![]u8 {
    const tok = mandala.brc162.decode(fixture).?;
    const lock = try a.dupe(u8, tok.lock);
    const st = lock[lock.len - pool_lib.state_len ..];
    std.mem.writeInt(u64, st[0..8], reserve, .little);
    @memcpy(st[8 + 33 ..][0..33], &validator_key);
    var ib: [37]u8 = undefined;
    var ab: [10]u8 = undefined;
    return std.mem.concat(a, u8, &.{ mandala.brc162.pushId(&ib, tok.id.?), mandala.brc162.pushAmount(&ab, reserve), &.{0x6d}, lock });
}

fn rawEntry(raw: []const u8) w.beef.Entry {
    return .{ .txid = w.beef.txidOf(raw), .format = .raw, .raw = raw };
}

/// An LP's pool deploy as the page builds it (web/ui src/lp/poolDeploy.ts),
/// derived from the fixtures: the funding transaction spends the LP's fund:3
/// and pays one exact output (the pool's sats + the miner fee) to the LP; the
/// deploy spends pool_deploy:2 (the first token input) and that output, and
/// writes the pool (50,000 sats / 1,000,000 tokens, ValidatorIdentity the
/// fixtures' validator, ValidatorPubKey its child for pool_deploy:2) and the
/// 3,949,998 token change to the LP, one unit left for the validator's claim
/// (0.9.0); no sats change.
fn buildDeploy(a: Allocator, o: DeployOpts) !DeployFx {
    const fund_raw = unhex(a, vec.fund);
    const fund = try Transaction.parse(a, fund_raw);
    const pd_raw = unhex(a, vec.pool_deploy);
    const pd = try Transaction.parse(a, pd_raw);
    const pd_txid = w.beef.txidOf(pd_raw);
    const lp = try lpPkh();
    const lp_lock = try p2pkhScript(a, &lp);
    var validator: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&validator, vec.identity);
    const fee = o.fee;
    const pool_sats: u64 = 50_000;
    const exact = pool_sats + fee; // + the change's 1 sat - the token input's 1 sat

    var f = fund;
    f.inputs = try a.dupe(bsvz.transaction.Input, &.{.{ .previous_outpoint = .{ .txid = .{ .bytes = w.beef.txidOf(fund_raw) }, .index = 3 }, .unlocking_script = Script.empty(), .sequence = 0xffffffff }});
    f.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(exact), .locking_script = Script.init(lp_lock) },
        .{ .satoshis = @intCast(100_000 - exact - 300), .locking_script = Script.init(lp_lock) },
    });
    if (o.sign_funding) try signP2pkh(a, &f, 0, fund.outputs[3].locking_script.bytes, @intCast(fund.outputs[3].satoshis), lp_priv);
    const f_raw = try f.serialize(a);

    const asset_id = w.beef.txidOf(unhex(a, vec.token_deploy));
    const vkey = try pool_lib.validatorKey(a, validator, pd_txid, o.key_vout);
    var d = pd;
    const token_in: bsvz.transaction.Input = .{ .previous_outpoint = .{ .txid = .{ .bytes = pd_txid }, .index = 2 }, .unlocking_script = Script.empty(), .sequence = 0xffffffff };
    const funding_in: bsvz.transaction.Input = .{ .previous_outpoint = .{ .txid = .{ .bytes = w.beef.txidOf(f_raw) }, .index = 0 }, .unlocking_script = Script.empty(), .sequence = 0xffffffff };
    d.inputs = if (o.token_input) try a.dupe(bsvz.transaction.Input, &.{ token_in, funding_in }) else try a.dupe(bsvz.transaction.Input, &.{funding_in});
    d.outputs = try a.dupe(bsvz.transaction.Output, &.{
        .{ .satoshis = @intCast(pool_sats), .locking_script = Script.init(try poolScript(a, pd.outputs[0].locking_script.bytes, 1_000_000, vkey)) },
        .{ .satoshis = 1, .locking_script = Script.init(try pool_lib.payoutScript(a, asset_id, 3_949_998, lp, false)) },
    });
    if (o.sign_deploy) {
        if (o.token_input) try signP2pkh(a, &d, 0, pd.outputs[2].locking_script.bytes, 1, lp_priv);
        try signP2pkh(a, &d, d.inputs.len - 1, lp_lock, exact, lp_priv);
    }
    const d_raw = try d.serialize(a);

    var des: std.ArrayList(w.beef.Entry) = .empty;
    if (o.with_parent) try des.append(a, rawEntry(pd_raw));
    if (o.with_funding) try des.append(a, rawEntry(f_raw));
    try des.append(a, rawEntry(d_raw));
    return .{
        .funding = f_raw,
        .funding_beef = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{ rawEntry(fund_raw), rawEntry(f_raw) }) }),
        .deploy = d_raw,
        .deploy_beef = try w.beef.serialize(a, .{ .version = w.beef.V2, .atomic = w.beef.txidOf(d_raw), .bumps = &.{}, .entries = des.items }),
        .validator = validator,
        .pool_deploy = pd_raw,
    };
}

fn expectDeployRefusal(c: relay.DeployChecked, reason: []const u8) !void {
    switch (c) {
        .ok => {
            std.debug.print("expected {s}, got ok\n", .{reason});
            return error.TestExpectedRefusal;
        },
        .refused => |r| {
            if (!eql(u8, r.reason, reason)) std.debug.print("expected {s}, got {s} ({s})\n", .{ reason, r.reason, r.detail orelse "" });
            try testing.expectEqualStrings(reason, r.reason);
        },
    }
}

test "pool relay: a deploy from the fixtures (the funding pays the pool's sats exactly; the deploy spends it and the LP's token output) is checked; each refusal" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const d = try buildDeploy(a, .{});

    const ok = try relay.checkDeploy(a, d.funding_beef, d.deploy_beef, &d.validator, t_expires, t_now);
    try testing.expect(ok == .ok);
    try testing.expectEqual(@as(u64, 1_000_000), ok.ok.continuation.token_reserve);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(d.pool_deploy), &ok.ok.key_input.txid);
    try testing.expectEqual(@as(u32, 2), ok.ok.key_input.vout);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(d.deploy), &ok.ok.deploy.txid);
    // The funding as a raw transaction passes too.
    try testing.expect(try relay.checkDeploy(a, d.funding, d.deploy_beef, &d.validator, t_expires, t_now) == .ok);

    try expectDeployRefusal(try relay.checkDeploy(a, d.funding_beef, d.deploy_beef, d.validator[0..32], t_expires, t_now), "bad_validator");
    try expectDeployRefusal(try relay.checkDeploy(a, d.funding_beef, d.deploy_beef, &d.validator, t_now, t_now), "expired");
    try expectDeployRefusal(try relay.checkDeploy(a, "junk", d.deploy_beef, &d.validator, t_expires, t_now), "bad_funding");
    try expectDeployRefusal(try relay.checkDeploy(a, d.funding_beef, "junk", &d.validator, t_expires, t_now), "bad_deploy");
    // The raw deploy: no BEEF, no parents.
    try expectDeployRefusal(try relay.checkDeploy(a, d.funding_beef, d.deploy, &d.validator, t_expires, t_now), "bad_deploy");
    // Output 0 not a pool: the fixture's own token deploy as the "deploy".
    {
        const td = unhex(a, vec.token_deploy);
        const b = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{rawEntry(td)}) });
        try expectDeployRefusal(try relay.checkDeploy(a, d.funding_beef, b, &d.validator, t_expires, t_now), "not_a_pool");
    }
    var other = d.validator;
    other[5] ^= 1;
    try expectDeployRefusal(try relay.checkDeploy(a, d.funding_beef, d.deploy_beef, &other, t_expires, t_now), "wrong_validator");
    try expectDeployRefusal(try relay.checkDeploy(a, unhex(a, vec.fund), d.deploy_beef, &d.validator, t_expires, t_now), "funding_not_spent");
    {
        const u = try buildDeploy(a, .{ .sign_funding = false });
        try expectDeployRefusal(try relay.checkDeploy(a, u.funding_beef, u.deploy_beef, &u.validator, t_expires, t_now), "funding_unsigned");
        const v = try buildDeploy(a, .{ .sign_deploy = false });
        try expectDeployRefusal(try relay.checkDeploy(a, v.funding_beef, v.deploy_beef, &v.validator, t_expires, t_now), "deploy_unsigned");
    }
    {
        const m = try buildDeploy(a, .{ .with_parent = false });
        const r = try relay.checkDeploy(a, m.funding_beef, m.deploy_beef, &m.validator, t_expires, t_now);
        try expectDeployRefusal(r, "missing_parent");
        try testing.expect(std.mem.startsWith(u8, r.refused.detail.?, "input 0: "));
    }
    // ValidatorPubKey the identity's child for another outpoint (pool_deploy:1): refused before dialling.
    try expectDeployRefusal(try relay.checkDeploy(a, (try buildDeploy(a, .{ .key_vout = 1 })).funding_beef, (try buildDeploy(a, .{ .key_vout = 1 })).deploy_beef, &d.validator, t_expires, t_now), "wrong_validator_key");
    // No token input at all.
    {
        const n = try buildDeploy(a, .{ .token_input = false, .with_parent = false });
        try expectDeployRefusal(try relay.checkDeploy(a, n.funding_beef, n.deploy_beef, &n.validator, t_expires, t_now), "no_token_input");
    }
    // A malformed pool: the prefix amount not the TokenReserve.
    {
        var t = try Transaction.parse(a, d.deploy);
        const outs = try a.dupe(bsvz.transaction.Output, t.outputs);
        const tok = mandala.brc162.decode(outs[0].locking_script.bytes).?;
        var ib: [37]u8 = undefined;
        var ab: [10]u8 = undefined;
        outs[0].locking_script = Script.init(try std.mem.concat(a, u8, &.{ mandala.brc162.pushId(&ib, tok.id.?), mandala.brc162.pushAmount(&ab, 999), &.{0x6d}, tok.lock }));
        t.outputs = outs;
        const raw = try t.serialize(a);
        const b = try w.beef.serialize(a, .{ .version = w.beef.V2, .bumps = &.{}, .entries = try a.dupe(w.beef.Entry, &.{ rawEntry(d.pool_deploy), rawEntry(d.funding), rawEntry(raw) }) });
        const r = try relay.checkDeploy(a, d.funding_beef, b, &d.validator, t_expires, t_now);
        try expectDeployRefusal(r, "not_a_pool");
        try testing.expectEqualStrings("output 0: the prefix amount is not the TokenReserve", r.refused.detail.?);
    }
}

test "pool relay: the one BEEF (the deploy's as received, the funding merged in when it is not there) and the package on the validator's deploy call" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const d = try buildDeploy(a, .{});
    const pair = (try relay.checkDeploy(a, d.funding_beef, d.deploy_beef, &d.validator, t_expires, t_now)).ok;

    // The deploy's BEEF carries the funding: as received (pool_deploy, the funding, the deploy last), V2.
    const b1 = try w.beef.parse(a, try relay.deployBeef(a, pair.funding, pair.deploy));
    try testing.expectEqual(@as(usize, 3), b1.entries.len);
    try testing.expect(b1.atomic == null);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(d.pool_deploy), &b1.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(d.funding), &b1.entries[1].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(d.deploy), &b1.subject().?);

    // It does not: the funding's BEEF (fund, the funding transaction) first, then the deploy's.
    const nf = try buildDeploy(a, .{ .with_funding = false });
    const p2 = (try relay.checkDeploy(a, nf.funding_beef, nf.deploy_beef, &nf.validator, t_expires, t_now)).ok;
    const b2 = try w.beef.parse(a, try relay.deployBeef(a, p2.funding, p2.deploy));
    try testing.expectEqual(@as(usize, 4), b2.entries.len);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(unhex(a, vec.fund)), &b2.entries[0].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(nf.funding), &b2.entries[1].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(nf.pool_deploy), &b2.entries[2].txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(nf.deploy), &b2.subject().?);
    try testing.expect(w.beef.parentsFirst(b2));

    // The package: box `deploy`, body {tx: <the BEEF>, pool: 0}, a nonce of its own kind.
    const id = relay.deployId(a, d.deploy_beef).?;
    try testing.expectEqualSlices(u8, &relay.idOf(d.deploy), &id);
    const rec: relay.Record = .{ .kind = .pool, .id = id, .funding = d.funding_beef, .swap = d.deploy_beef, .pool = "x", .validator = d.validator, .expires = t_expires, .created = t_now, .updated = t_now };
    const signer = try keySigner(a, relay_priv);
    const pkg = try scbor.decode(a, try relay.packageFor(a, signer, rec));
    const m = pkg.get("message").?;
    const body = scbor.Value.bytesOf(pkg.get("body")).?;
    try testing.expect((try message.problem(a, m, body)) == null);
    try testing.expectEqualStrings("deploy", scbor.Value.str(m.get("box")).?);
    try testing.expectEqualSlices(u8, &d.validator, scbor.Value.bytesOf(m.get("recipient")).?);
    const req = try cbor.decode(a, body);
    try testing.expectEqual(@as(u64, 0), req.getUint("pool").?);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(d.deploy), &(try w.beef.parse(a, req.getBytes("tx").?)).subject().?);
    try testing.expect(!eql(u8, &relay.nonceFor(.pool, id), &relay.nonceFor(.swap, id)));
}

/// The deploy with a claim appended (any one more output: the relay checks the shape, the validator the claim).
fn claimed(a: Allocator, deploy: []const u8) ![]const u8 {
    var t = try Transaction.parse(a, deploy);
    const outs = try a.alloc(bsvz.transaction.Output, t.outputs.len + 1);
    @memcpy(outs[0..t.outputs.len], t.outputs);
    outs[t.outputs.len] = t.outputs[1];
    t.outputs = outs;
    return t.serialize(a);
}

test "pool relay (0.9.0): claimedOf — the delivered deploy with one output appended, nothing else changed" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const d = try buildDeploy(a, .{});
    const c = try claimed(a, d.deploy);
    try testing.expect(relay.claimedOf(a, d.deploy, c));
    try testing.expect(relay.claimedOf(a, unhex(a, vec.pool_deploy_delivered), unhex(a, vec.pool_deploy)));
    try testing.expect(!relay.claimedOf(a, d.deploy, d.deploy)); // nothing appended
    try testing.expect(!relay.claimedOf(a, d.deploy, try claimed(a, c))); // two appended
    try testing.expect(!relay.claimedOf(a, unhex(a, vec.pool_deploy_delivered), unhex(a, vec.pool_deploy_wrong_key))); // another pool
    var t = try Transaction.parse(a, c);
    const ins = try a.dupe(bsvz.transaction.Input, t.inputs);
    ins[1].unlocking_script = Script.empty();
    t.inputs = ins;
    try testing.expect(!relay.claimedOf(a, d.deploy, try t.serialize(a))); // an input changed
}

test "pool relay: the record's lifecycle — dial /amm-validator/1/deploy; accepted is the deploy with the validator's claim appended (0.9.0; anything else fails); refused; kept in the app's state beside the swaps" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const d = try buildDeploy(a, .{});
    const txid_hex = w.header.toHex(w.beef.txidOf(d.deploy));
    const fresh: relay.Record = .{ .kind = .pool, .id = relay.idOf(d.deploy), .funding = d.funding_beef, .swap = d.deploy_beef, .pool = "p_0", .validator = d.validator, .expires = t_expires, .created = t_now, .updated = t_now, .peer = "16Uiu2HAmL3ee25zUdPHFTUVToTuzBgBjt8yoxAd952pYyvfbmDT9" };

    {
        var r = fresh;
        const start = try relay.advance(a, &r, .start, t_now, null);
        try testing.expectEqualStrings(relay.deploy_protocol, start.emits[0].body.getText("protocol").?);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 3 } }, t_now, "pkg");
        const c = try claimed(a, d.deploy);
        const c_hex = w.header.toHex(w.beef.txidOf(c));
        const done = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = &.{
            .{ .key = "ok", .value = .{ .boolean = true } },
            .{ .key = "tx", .value = .{ .bytes = c } },
            .{ .key = "txid", .value = .{ .text = &c_hex } },
        } }) } }, t_now + 9, null);
        try testing.expect(done.done);
        try testing.expectEqual(relay.Status.accepted, r.status);
        try testing.expectEqualSlices(u8, c, r.tx.?);
        try testing.expectEqualStrings(&c_hex, r.txid.?);
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{&c_hex}), r.pool);
        _ = txid_hex;

        // Kept under `pools`, not `swaps`; the answer names `deploy`.
        var book = try relay.Book.load(a, ms.store(), null);
        try book.put(a, r);
        const st = readBack(a, try book.state(a));
        try testing.expect(st.getCid("pools") != null);
        try testing.expect(st.get("swaps").? == .null);
        var again = try relay.Book.load(a, ms.store(), st);
        try testing.expect((try again.get(a, r.id)) == null);
        const back = (try again.getKind(a, .pool, r.id)).?;
        try testing.expectEqual(relay.Kind.pool, back.kind);
        const ans = readBack(a, try back.answer(a));
        try testing.expectEqualSlices(u8, d.deploy_beef, ans.getBytes("deploy").?);
        try testing.expect(ans.get("swap") == null);
        try testing.expectEqualSlices(u8, try claimed(a, d.deploy), ans.getBytes("tx").?);
        try testing.expectEqualStrings("accepted", ans.getText("status").?);
    }
    // An accept without the claimed deploy, with the deploy unclaimed, or naming another txid: failed, not accepted.
    for ([_]?[]const u8{ null, d.deploy, try claimed(a, d.deploy) }, [_]?[]const u8{ null, null, "ab" ** 32 }) |tx, txid| {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 4 } }, t_now, "pkg");
        var es: std.ArrayList(cbor.Entry) = .empty;
        try es.append(a, .{ .key = "ok", .value = .{ .boolean = true } });
        if (tx) |t| try es.append(a, .{ .key = "tx", .value = .{ .bytes = t } });
        if (txid) |t| try es.append(a, .{ .key = "txid", .value = .{ .text = t } });
        _ = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = es.items }) } }, t_now, null);
        try testing.expectEqual(relay.Status.failed, r.status);
        try testing.expectEqualStrings("bad_reply", r.reason.?);
    }
    // Refused by the validator.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .{ .answer = .{ .opened = 5 } }, t_now, "pkg");
        _ = try relay.advance(a, &r, .{ .answer = .{ .frame = try frameOf(a, .{ .map = &.{
            .{ .key = "ok", .value = .{ .boolean = false } },
            .{ .key = "reason", .value = .{ .text = "fees_unacceptable" } },
            .{ .key = "detail", .value = .{ .text = "commissionBps" } },
        } }) } }, t_now, null);
        try testing.expectEqual(relay.Status.refused, r.status);
        try testing.expectEqualStrings("fees_unacceptable", r.reason.?);
        try testing.expectEqualStrings("commissionBps", r.detail.?);
    }
    // Timeout as the swap's.
    {
        var r = fresh;
        _ = try relay.advance(a, &r, .start, t_now, null);
        _ = try relay.advance(a, &r, .woke, t_expires, null);
        try testing.expectEqual(relay.Status.timeout, r.status);
    }
}

fn testPoolSubmit(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    var dummy: u8 = 0;
    const env: relay.Env = .{ .book = test_env.book, .now = t_now, .commission = ours, .ctx = &dummy, .self_peer = test_env.self_peer, .launchFn = testLaunch };
    return switch (try relay.submitDeploy(c.a, env, try fromSdk(c.a, c.args))) {
        .refused => |r| sk.report(try relay.refusalText(c.a, r)),
        .launched, .pending, .settled => |r| toSdk(c.a, try r.answer(c.a)),
    };
}
fn testPoolStatus(c: *app.Call) anyerror!scbor.Value {
    test_env.seen_writes = c.writes;
    return switch (try relay.statusOf(c.a, test_env.book, .pool, try fromSdk(c.a, c.args))) {
        .found => |r| toSdk(c.a, try r.answer(c.a)),
        .not_found => sk.report("not_found"),
        .bad_id => sk.report("bad_id"),
    };
}
const pool_fns = [_]app.Function{
    .{ .name = relay.fn_submit, .run = testSubmit },
    .{ .name = relay.fn_status, .run = testStatus },
    .{ .name = relay.fn_terms, .run = testTerms },
    .{ .name = relay.fn_pool_submit, .run = testPoolSubmit },
    .{ .name = relay.fn_pool_status, .run = testPoolStatus },
};

fn poolArgs(a: Allocator, d: DeployFx, extra: ?cbor.Entry) !scbor.Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "funding", .value = .{ .bytes = d.funding_beef } },
        .{ .key = "deploy", .value = .{ .bytes = d.deploy_beef } },
        .{ .key = "validator", .value = .{ .bytes = &d.validator } },
        .{ .key = "peerId", .value = .{ .text = named_peer } },
        .{ .key = "expires", .value = .{ .uint = t_expires } },
    });
    if (extra) |e| try es.append(a, e);
    return toSdk(a, .{ .map = es.items });
}

test "pool relay: dispatch by the manifest (app/etc/app.json, amm.pool/1) — submit records and launches the deploy relay, again answers its record, status reads it (not a swap's); refusals write nothing" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var book = try relay.Book.load(a, ms.store(), null);
    test_env = .{ .book = &book };
    const m = try dagjson.decode(a, manifest_json);
    const in: scbor.Value = .{ .map = &.{} };
    const d = try buildDeploy(a, .{});

    try testing.expect((try app.declOf(a, m, relay.fn_pool_submit)).?.get("writes").?.bool);
    try testing.expect(!(try app.declOf(a, m, relay.fn_pool_status)).?.get("writes").?.bool);

    const r1 = try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try poolArgs(a, d, null), null);
    try testing.expect(r1 == .ok);
    try testing.expectEqual(@as(?bool, true), test_env.seen_writes);
    try testing.expectEqual(@as(usize, 1), test_env.launched);
    try testing.expectEqual(@as(?relay.Kind, .pool), test_env.launched_kind);
    const rec = try fromSdk(a, r1.ok);
    try testing.expectEqualStrings("pending", rec.getText("status").?);
    try testing.expectEqualStrings(&relay.idText(relay.idOf(d.deploy)), rec.getText("id").?);
    try testing.expectEqualStrings(try std.fmt.allocPrint(a, "{s}_0", .{&w.header.toHex(w.beef.txidOf(d.deploy))}), rec.getText("pool").?);
    // Again: its record, no second relay.
    _ = try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try poolArgs(a, d, null), null);
    try testing.expectEqual(@as(usize, 1), test_env.launched);

    // status: the deploy's record; the swap's status does not find it.
    var sargs = scbor.MapBuilder.init(a);
    try sargs.put("id", scbor.string(rec.getText("id").?));
    const s1 = try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_status, sargs.value(), null);
    try testing.expect(s1 == .ok);
    try testing.expectEqual(@as(?bool, false), test_env.seen_writes);
    try testing.expectEqualStrings("pending", (try fromSdk(a, s1.ok)).getText("status").?);
    try expectErr(try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_status, sargs.value(), null), .failed, "not_found");

    // The declared shape: a swap's arg is not a deploy's.
    try expectErr(try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try poolArgs(a, d, .{ .key = "swap", .value = .{ .bytes = "x" } }), null), .@"bad-args", "args.swap: not in the shape");

    // Refusals: the function's error, nothing recorded or launched.
    const wrong = try buildDeploy(a, .{ .key_vout = 1 });
    try expectErr(try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try poolArgs(a, wrong, null), null), .failed, "wrong_validator_key");
    const unsigned = try buildDeploy(a, .{ .sign_deploy = false });
    try expectErr(try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try poolArgs(a, unsigned, null), null), .failed, "deploy_unsigned");
    const nf = try buildDeploy(a, .{ .with_funding = false, .fee = 500 });
    try expectErr(try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try withPeer(a, try poolArgs(a, nf, null), null), null), .@"bad-args", "args.peerId: missing");
    try expectErr(try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try withPeer(a, try poolArgs(a, nf, null), "a peer"), null), .failed, "bad_peer");
    try testing.expectEqual(@as(usize, 1), test_env.launched);
    try testing.expect((try book.getKind(a, .pool, relay.idOf(wrong.deploy))) == null);
    try testing.expect((try book.getKind(a, .pool, relay.idOf(nf.deploy))) == null);

    // Failed in transport: relayed again.
    var r = (try book.getKind(a, .pool, relay.idOf(d.deploy))).?;
    r.status = .failed;
    try book.put(a, r);
    // Relayed again to this node's own validator: the peer named is this node's (local).
    test_env.self_peer = named_peer;
    _ = try app.run(a, in, relay.app_name, m, &pool_fns, relay.fn_pool_submit, try poolArgs(a, d, null), null);
    try testing.expectEqual(@as(usize, 2), test_env.launched);
    try testing.expect((try book.getKind(a, .pool, relay.idOf(d.deploy))).?.local);
}

test "market and validator are the engine's (0.6.0, shruggr/skein#120), root's switch (0.6.2, David 2026-10-07): no validate route, no start or stop, no config.amm.ammP2p.market; config.overlay.market / .validator absent, both off until root turns one on" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try dagjson.decode(a, manifest_json);
    for (m.get("routes").?.array) |row| {
        try testing.expect(!std.mem.eql(u8, scbor.Value.str(row.get("address")) orelse "", "validate"));
    }
    try testing.expect(m.get("start") == null and m.get("stop") == null);
    const config = m.get("config").?;
    if (config.get("amm").?.get("ammP2p")) |p2p| {
        try testing.expect(p2p.get("market") == null and p2p.get("heartbeatSeconds") == null and p2p.get("offlineSeconds") == null);
    }
    // "this shouldn't have been a config in the manifest. This should be a setting that the user is
    // configuring": root turns a role on at install (--config) or by the engine's switch.
    const ov_cfg = config.get("overlay").?;
    try testing.expect(ov_cfg.get("market") == null and ov_cfg.get("validator") == null);
}

test "the routes, filters and roles (shruggr/skein#143, 0.7.0): no dispatch, reads or senders; the box amm is the engine's (derived), amm-p2p's box amm/amm-p2p; register root's; the reads read routes" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const m = try dagjson.decode(a, manifest_json);
    try testing.expect(m.get("dispatch") == null and m.get("reads") == null);
    const gated = m.get("roles").?.get("root").?.array;
    // register, registerLookup, deregisterLookup (skein-overlay 0.11.0); no market / validator
    // (0.8.1, skein-overlay 0.12.0: always both, no switch); rescind, the validator's (0.9.0).
    try testing.expectEqual(@as(usize, 4), gated.len);
    for ([_][]const u8{ "register", "registerLookup", "deregisterLookup", "rescind" }, gated) |x, g| try testing.expectEqualStrings(x, scbor.Value.str(g).?);
    const filters = m.get("filters").?;
    try testing.expectEqualStrings("amm-p2p.serve", scbor.Value.str(filters.get("page")).?);
    try testing.expectEqualStrings("mandala-lookup.tokens", scbor.Value.str(filters.get("tokens")).?);
    try testing.expectEqualStrings("amm-p2p.requests", scbor.Value.str(filters.get("requests")).?);
    try testing.expectEqualStrings("amm-p2p.spends", scbor.Value.str(filters.get("spends")).?);
    var seen: u8 = 0;
    for (m.get("routes").?.array) |r| {
        try testing.expect(r.get("sender") == null and r.get("program") == null);
        const t = scbor.Value.str(r.get("transport")) orelse "mailbox";
        const addr = scbor.Value.str(r.get("address")).?;
        const h = scbor.Value.str(r.get("handler"));
        // No route of the app's own on its box `amm` ("" or "amm"): the engine's, derived.
        if (std.mem.eql(u8, t, "mailbox")) try testing.expect(addr.len > 0 and !std.mem.eql(u8, addr, "amm"));
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "amm-p2p")) {
            try testing.expectEqualStrings("amm-p2p", h.?);
            seen |= 1;
        }
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "register")) {
            try testing.expectEqualStrings("overlay.register", h.?);
            seen |= 2;
        }
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/call")) {
            try testing.expectEqualStrings("amm-p2p.call", h.?);
            try testing.expectEqualStrings("kernel.brc104", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen |= 4;
        }
        if (std.mem.eql(u8, t, "http") and std.mem.eql(u8, addr, "/")) {
            try testing.expect(h == null);
            try testing.expectEqualStrings("page", scbor.Value.str(r.get("filters").?.array[0]).?);
            seen |= 8;
        }
        // 0.9.0: the validator's box (root's rescind), the holders' requests, and two reads.
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "validator")) {
            try testing.expectEqualStrings("amm-validator", h.?);
            seen |= 16;
        }
        if (std.mem.eql(u8, t, "mailbox") and std.mem.eql(u8, addr, "requests")) {
            try testing.expectEqualStrings("amm-p2p", h.?);
            seen |= 32;
        }
        if (std.mem.eql(u8, t, "http") and (std.mem.eql(u8, addr, "/requests") or std.mem.eql(u8, addr, "/spends"))) {
            try testing.expect(h == null);
            seen |= if (std.mem.eql(u8, addr, "/requests")) 64 else 128;
        }
        // No addLiquidity (0.9.0).
        try testing.expect(!std.mem.eql(u8, addr, "/amm-validator/1/addLiquidity"));
    }
    try testing.expectEqual(@as(u8, 255), seen);
    try testing.expectEqualStrings("amm/amm-p2p", names.own_box);
}

// ================================================================ the reads and the listing requests (0.9.0)

const reads = @import("src/reads.zig");

test "listing requests (0.9.0): a holder's request is recorded (the latest per token, any id form), listed newest first, less the tokens registered" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    const s = ms.store();
    const t1 = "01" ** 32;
    const t2 = "02" ** 32;
    const holder: [33]u8 = .{0x02} ++ .{0x11} ** 32;
    const other: [33]u8 = .{0x03} ++ .{0x22} ** 32;
    var rec = try reads.record(a, s, null, t1 ++ "_0", &holder, 100);
    rec = try reads.record(a, s, rec, t2 ++ ".0", &other, 200);
    rec = try reads.record(a, s, rec, t1, &other, 300); // the same token again: the latest kept
    try testing.expectError(error.BadTokenId, reads.record(a, s, rec, "abc", &holder, 400));
    const all = try reads.list(a, s, rec, &.{});
    try testing.expectEqual(@as(usize, 2), all.len);
    try testing.expectEqualStrings(t1 ++ "_0", all[0].token_id);
    try testing.expectEqual(@as(u64, 300), all[0].at);
    try testing.expectEqualSlices(u8, &other, all[0].from);
    try testing.expectEqualStrings(t2 ++ "_0", all[1].token_id);
    // Registered: settled, not listed.
    const left = try reads.list(a, s, rec, &.{"tm_mandala_" ++ t1 ++ "_0"});
    try testing.expectEqual(@as(usize, 1), left.len);
    try testing.expectEqualStrings(t2 ++ "_0", left[0].token_id);
    const json = try reads.requestsJson(a, left);
    try testing.expect(std.mem.indexOf(u8, json, "\"tokenId\":\"" ++ t2 ++ "_0\"") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"from\":\"03" ++ "22" ** 32 ++ "\"") != null);
    try testing.expectEqualStrings(reads.requests_box, reads.requests_head);
}

test "spends (0.9.0): the chain state of an outpoint — the claim spent (the rescind); a pool followed from the deploy to its current output; closed by Close; unspent" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var ms = w.store.MemStore.init(testing.allocator);
    defer ms.deinit();
    var ch = try w.state.State.load(a, ms.store(), null, .regtest);
    for ([_][]const u8{ vec.fund, vec.token_deploy, vec.pool_deploy, vec.swap_bsv_in, vec.swap_tokens_in }) |h| {
        const raw = unhex(a, h);
        _ = try ch.putTx(w.beef.txidOf(raw), raw);
    }
    const pd = w.beef.txidOf(unhex(a, vec.pool_deploy));
    const s2 = w.beef.txidOf(unhex(a, vec.swap_tokens_in));
    // Followed: two swaps.
    const at_deploy = try reads.spendOf(a, &ch, .{ .txid = pd, .vout = 0 });
    try testing.expectEqual(@as(u32, 2), at_deploy.hops);
    try testing.expect(!at_deploy.closed);
    try testing.expectEqualSlices(u8, &s2, &at_deploy.current.?.txid);
    try testing.expectEqualSlices(u8, &w.beef.txidOf(unhex(a, vec.swap_bsv_in)), &at_deploy.spent_by.?);
    // The claim: unspent, then spent by the rescind.
    try testing.expect((try reads.spendOf(a, &ch, .{ .txid = pd, .vout = vec.claim_vout })).spent_by == null);
    const rs = unhex(a, vec.rescind);
    _ = try ch.putTx(w.beef.txidOf(rs), rs);
    const claim = try reads.spendOf(a, &ch, .{ .txid = pd, .vout = vec.claim_vout });
    try testing.expectEqualSlices(u8, &w.beef.txidOf(rs), &claim.spent_by.?);
    try testing.expect(claim.current == null); // not a pool
    // Closed: the pool's last output spent by Close.
    const cl = unhex(a, vec.close);
    _ = try ch.putTx(w.beef.txidOf(cl), cl);
    const after = try reads.spendOf(a, &ch, .{ .txid = pd, .vout = 0 });
    try testing.expect(after.closed);
    try testing.expect(after.current == null);
    const json = try reads.spendJson(a, after);
    try testing.expect(std.mem.indexOf(u8, json, "\"closed\":true") != null);
    try testing.expect(std.mem.indexOf(u8, json, "\"hops\":2") != null);
    // The query.
    const q = reads.queryOutpoint("outpoint=" ++ "ab" ** 32 ++ ".4").?;
    try testing.expectEqual(@as(u32, 4), q.vout);
    try testing.expect(reads.queryOutpoint("x=1") == null);
}
