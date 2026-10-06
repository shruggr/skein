// Billing (#130): a hosted skein meters itself and prepays its host from its
// own wallet. The kernel's part: the meter, the state, and the pay step it
// fires whenever the allocation is consumed (no program can stop it; any app
// may also pay the host, scheduler.zig).
//
// The terms are the owner's (#130 decided 1): the **host row**, a kernel row
// the owner writes with an ordinary `dispatch` admin message —
//
//   {transport: "mailbox", address: <a box, "billing" by convention>, sender: <the host's key>,
//    program: "kernel", fn: "billing", x: <sats>, rates?: {fuel, storage, served, fetch, authfetch, publish}}
//
// — the first such row in table order is the host's; with none, nothing is
// billed and nothing here runs. `x` is the block the instance prepays at a
// time; the rates (integers, a missing one is 0, free):
//
//   fuel       sats per 10^9 fuel: every step's (a request's thread, a handler, a shell
//              segment, the pay step itself, a step resumed at a restart), and the host's
//              read and door calls (on its attestation)
//   storage    sats per 10^6 bytes held for a day: the bytes the kernel stored (index.zig
//              `kept`, counted as blocks are created), charged on every entry for the time
//              since the last charge
//   served     sats per 10^6 bytes the host served for the instance (on its attestation)
//   fetch      sats per `fetch` intention a step recorded (#126)
//   authfetch  sats per authfetch exchange (#126: one recorded call each)
//   publish    sats per libp2p publish: a message to the libp2p provider in box `publish`, or
//              to a `libp2p` recipient at `topic:<name>`
//
// Other events (`deadline`, `subscribe`, `beacon`, …) are not metered.
//
// The host calls in two ways, neither periodic (#130, the walk of the build):
//
//   the wake         a message from the host's key at the host row: {kind: "wake", allowance:
//                    <sats>, received: <sats>}. The first from this host starts the billing state
//                    (its allowance, the host's free allowance for this skein); a later one is a
//                    call-in like any other — the host sends it when it has computed that what is
//                    outstanding reaches the allocation, so the kernel evaluates its billing then,
//                    or when a payment it took was rejected. `received` is what the host has taken
//                    from this skein and not seen rejected: the kernel's `paid` becomes it, so a
//                    payment the host did not get is no longer counted (the pay step fires again)
//                    and one an app made is (no second payment for the same block).
//   the attestation  on any entry the host appends, when it has external cost not yet reported:
//                    the entry's `attest: {fuel, served, log: <cid>, signature}` — its read and
//                    door calls' fuel and the bytes it served since its last attestation, and the
//                    CID of its log record for that period — signed by the host's key ([2, "skein
//                    billing"], key "attestation", counterparty anyone) over the dag-cbor of
//                    {kind: "attestation", instance: <this skein's identity>, fuel, served, log}.
//
// The state is a head of its own, `billing`, written by the kernel alone (an
// owner's `head` message and every program's `advance` are refused it):
//
//   {kind: "billing", host: bytes(33), allowance: <sats>, paid: <sats>, tally: <nanosats>,
//    lastCharge: <ms, the entry time storage was last charged to>, bytes: <bytes kept>,
//    payments, asleep: bool}
//
// Allocation = (allowance + paid) sats; consumed = the tally. The kernel
// evaluates after every entry (scheduler.zig billingAfter): its steps' fuel and
// billable events, the entry's attestation, and storage — `bytes` held × the
// time since `lastCharge` — onto the tally; then, while the tally has reached
// the allocation, the pay step. A wake from another key (the owner moved hosts)
// starts a new state (the bytes kept carry over).
// Amounts are nanosatoshis inside (the tally), satoshis on the wire.
const std = @import("std");
const cbor = @import("cbor");
const secp = @import("secp");
const dispatch = @import("dispatch.zig");
const Value = cbor.Value;

/// The kernel's head (bare name: its owner is `billing`, a reserved app name).
pub const HEAD = "billing";
/// The host row's kernel operation: the host's call-in (its wake).
pub const OP = "billing";
/// The event the pay step emits (the wallet's; any app may emit one too).
pub const PAYMENT = "payment";
/// Nanosatoshis per satoshi: the tally's unit.
pub const NSAT: i128 = 1_000_000_000;
/// How many payments one entry may make (each pays the next block; the rest at the next entry).
pub const MAX_PAYS: usize = 16;
/// The attestation's signature: BRC-43 [2, "skein billing"], key "attestation", counterparty anyone.
pub const ATTEST_LEVEL: u8 = 2;
pub const ATTEST_PROTOCOL = "skein billing";
pub const ATTEST_KEY_ID = "attestation";

pub const Rates = struct {
    fuel: u64 = 0,
    storage: u64 = 0,
    served: u64 = 0,
    fetch: u64 = 0,
    authfetch: u64 = 0,
    publish: u64 = 0,
};

pub const rate_names = [_][]const u8{ "fuel", "storage", "served", "fetch", "authfetch", "publish" };

/// The host row's terms: the host's key, X, the rates, and the box its wakes come in.
pub const Terms = struct { host: []const u8, x: u64, rates: Rates, address: []const u8 };

fn uint(v: ?Value) ?u64 {
    const i = Value.intOf(v) orelse return null;
    if (i < 0 or i > std.math.maxInt(u64)) return null;
    return @intCast(i);
}

/// Why a row whose `fn` is `billing` is not a host row (null: it is one): its sender
/// is the host's key, `x` a whole number of sats ≥ 1, `rates` (if any) a map of
/// whole numbers ≥ 0 by the names above.
pub fn rowProblem(a: std.mem.Allocator, v: Value) !?[]u8 {
    const s = v.get("sender") orelse return try a.dupe(u8, "a host row's sender is the host's key");
    const k = Value.bytesOf(s) orelse return try a.dupe(u8, "a host row's sender is the host's key (33 bytes), not a symbol");
    if (!secp.isKey(k)) return try a.dupe(u8, "a host row's sender is the host's key (33 bytes)");
    const x = uint(v.get("x")) orelse return try a.dupe(u8, "a host row names x: the sats the instance prepays at a time (a whole number ≥ 1)");
    if (x == 0) return try a.dupe(u8, "x: at least 1 sat");
    if (v.get("rates")) |r| if (r != .null) {
        if (r != .map) return try a.dupe(u8, "rates: a map {fuel, storage, served, fetch, authfetch, publish} of whole numbers of sats");
        for (r.map) |e| {
            var known = false;
            for (rate_names) |n| known = known or std.mem.eql(u8, n, e.key);
            if (!known) return try std.fmt.allocPrint(a, "rates: no rate {s} (fuel, storage, served, fetch, authfetch, publish)", .{e.key});
            if (uint(e.value) == null) return try std.fmt.allocPrint(a, "rates.{s}: a whole number of sats ≥ 0", .{e.key});
        }
    };
    return null;
}

/// Whether a row is a host row (a kernel row whose operation is `billing`).
pub fn isHostRow(r: dispatch.Row) bool {
    const op = r.op orelse return false;
    return r.program == null and std.mem.eql(u8, op, OP);
}

/// The terms of the host row: the first kernel `billing` row in table order whose
/// settings hold (a malformed one a log holds counts as none). Null: no host
/// row — nothing is billed.
pub fn termsOf(rows: []const dispatch.Row) ?Terms {
    for (rows) |r| {
        if (!isHostRow(r)) continue;
        const key = switch (r.sender) {
            .key => |k| k,
            else => return null,
        };
        var t = Terms{ .host = key, .x = uint(r.value.get("x")) orelse return null, .rates = .{}, .address = r.address };
        if (r.value.get("rates")) |rv| if (rv == .map) inline for (@typeInfo(Rates).@"struct".fields) |f| {
            if (uint(rv.get(f.name))) |n| @field(t.rates, f.name) = n;
        };
        return t;
    }
    return null;
}

/// What was used since the last evaluation (#130 decided 2): steps' fuel and the billable events.
pub const Usage = struct {
    fuel: u64 = 0,
    fetch: u64 = 0,
    authfetch: u64 = 0,
    publish: u64 = 0,

    pub fn add(u: *Usage, o: Usage) void {
        u.fuel +|= o.fuel;
        u.fetch +|= o.fetch;
        u.authfetch +|= o.authfetch;
        u.publish +|= o.publish;
    }
};

/// What usage costs at these rates (nanosats): fuel × rate (sats per 10^9 fuel = nanosats per
/// fuel), and each billable event at its rate (sats).
pub fn priceUsage(r: Rates, u: Usage) i128 {
    return @as(i128, u.fuel) * r.fuel +
        (@as(i128, u.fetch) * r.fetch + @as(i128, u.authfetch) * r.authfetch + @as(i128, u.publish) * r.publish) * NSAT;
}

/// Storage for `ms` (nanosats): `bytes` held at `storage` sats per 10^6 bytes a day —
/// bytes × ms × rate × 10^9 / (10^6 × 86 400 000) = bytes × ms × rate / 86 400, rounded down.
pub fn priceStorage(r: Rates, bytes: u64, ms: i64) i128 {
    if (ms <= 0) return 0;
    return @divFloor(@as(i128, bytes) * ms * r.storage, 86_400);
}

/// What the host attests (nanosats): its calls' fuel at the fuel rate, and the bytes it served at
/// `served` sats per 10^6 bytes (= 1 000 nanosats per byte).
pub fn priceHost(r: Rates, fuel: u64, served: u64) i128 {
    return @as(i128, fuel) * r.fuel + @as(i128, served) * r.served * 1_000;
}

/// The billing state (the head `billing`'s record).
pub const State = struct {
    host: []const u8,
    allowance: u64,
    paid: u64 = 0,
    tally: i128 = 0,
    /// The entry time (ms) storage was last charged to.
    last_charge: i64,
    /// The bytes the kernel has kept (stored, counted) since billing started.
    bytes: u64 = 0,
    payments: u64 = 0,
    asleep: bool = false,

    /// What the instance may consume (nanosats): the free allowance and every payment made.
    pub fn allocation(s: State) i128 {
        return (@as(i128, s.allowance) + s.paid) * NSAT;
    }

    pub fn value(s: State, a: std.mem.Allocator) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("billing"));
        try m.put("host", .{ .bytes = s.host });
        try m.put("allowance", cbor.int(s.allowance));
        try m.put("paid", cbor.int(s.paid));
        try m.put("tally", cbor.int(s.tally));
        try m.put("lastCharge", cbor.int(s.last_charge));
        try m.put("bytes", cbor.int(s.bytes));
        try m.put("payments", cbor.int(s.payments));
        try m.put("asleep", .{ .bool = s.asleep });
        return m.value();
    }

    pub fn of(v: Value) ?State {
        if (v != .map or !std.mem.eql(u8, Value.str(v.get("kind")) orelse "", "billing")) return null;
        const tally = Value.intOf(v.get("tally")) orelse return null;
        const last = Value.intOf(v.get("lastCharge")) orelse return null;
        const asleep = v.get("asleep") orelse return null;
        if (asleep != .bool) return null;
        return .{
            .host = Value.bytesOf(v.get("host")) orelse return null,
            .allowance = uint(v.get("allowance")) orelse return null,
            .paid = uint(v.get("paid")) orelse return null,
            .tally = tally,
            .last_charge = std.math.cast(i64, last) orelse return null,
            .bytes = uint(v.get("bytes")) orelse return null,
            .payments = uint(v.get("payments")) orelse return null,
            .asleep = asleep.bool,
        };
    }
};

/// The host's wake (its call-in at the host row, signed as every message is): {kind: "wake",
/// allowance: <sats>, received: <sats>}. The allowance is taken when the wake starts the state
/// (the first from this host), and only then; `received` at every wake.
pub const Wake = struct { allowance: u64, received: u64 };
pub const WakeParse = union(enum) { ok: Wake, bad: []const u8 };

pub fn wakeOf(body: Value) WakeParse {
    const want = "a host's wake is {kind: \"wake\", allowance: sats, received: sats}";
    if (body != .map or !std.mem.eql(u8, Value.str(body.get("kind")) orelse "", "wake")) return .{ .bad = want };
    return .{ .ok = .{
        .allowance = uint(body.get("allowance")) orelse return .{ .bad = "allowance: a whole number of sats" },
        .received = uint(body.get("received")) orelse return .{ .bad = "received: a whole number of sats (what the host has taken from this skein and not seen rejected)" },
    } };
}

/// The host's attestation on an entry (`attest`): its external cost since its last one.
pub const Attestation = struct { fuel: u64, served: u64, log: []const u8, signature: []const u8 };

/// An entry's `attest` in its form (null: not one): {fuel, served, log: <cid>, signature: bytes}.
pub fn attestationOf(v: ?Value) ?Attestation {
    const x = v orelse return null;
    if (x != .map) return null;
    return .{
        .fuel = uint(x.get("fuel")) orelse return null,
        .served = uint(x.get("served")) orelse return null,
        .log = Value.cidOf(x.get("log")) orelse return null,
        .signature = Value.bytesOf(x.get("signature")) orelse return null,
    };
}

/// What the attestation's signature covers: the dag-cbor of {kind: "attestation", instance, fuel,
/// served, log} — the skein it is for, so it is good for that skein only.
pub fn attestationPreimage(a: std.mem.Allocator, instance: []const u8, t: Attestation) ![]u8 {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("attestation"));
    try m.put("instance", .{ .bytes = instance });
    try m.put("fuel", cbor.int(t.fuel));
    try m.put("served", cbor.int(t.served));
    try m.put("log", cbor.cidv(t.log));
    return cbor.encode(a, m.value());
}

/// Whether the host `host` signed this attestation for `instance`.
pub fn attestedBy(a: std.mem.Allocator, host: []const u8, instance: []const u8, t: Attestation) !bool {
    const pre = try attestationPreimage(a, instance, t);
    return secp.verifyAnyoneKey(host, ATTEST_LEVEL, ATTEST_PROTOCOL, ATTEST_KEY_ID, pre, t.signature);
}

/// The checkpoint a payment carries (#130 decided, "Checkpoint"): `OP_FALSE OP_RETURN <the state
/// record's CID, binary>`, an output of 0 sats.
pub fn checkpointScript(a: std.mem.Allocator, cid: []const u8) ![]u8 {
    var out = std.array_list.Managed(u8).init(a);
    try out.appendSlice(&.{ 0x00, 0x6a });
    if (cid.len < 0x4c) try out.append(@intCast(cid.len)) else {
        try out.append(0x4c);
        try out.append(@intCast(cid.len));
    }
    try out.appendSlice(cid);
    return out.items;
}

test "billing: prices in nanosats — fuel, events, storage by the day, the host's amounts" {
    const r = Rates{ .fuel = 2, .storage = 1, .served = 3, .fetch = 1, .authfetch = 2, .publish = 5 };
    try std.testing.expectEqual(@as(i128, 2_000_000_000), priceUsage(r, .{ .fuel = 1_000_000_000 }));
    try std.testing.expectEqual(@as(i128, (1 + 2 * 2 + 3 * 5) * NSAT + 20), priceUsage(r, .{ .fuel = 10, .fetch = 1, .authfetch = 2, .publish = 3 }));
    // 10^6 bytes for a day at 1 sat per MB·day: one sat.
    try std.testing.expectEqual(NSAT, priceStorage(r, 1_000_000, 86_400_000));
    try std.testing.expectEqual(@as(i128, 0), priceStorage(r, 1_000_000, -5));
    try std.testing.expectEqual(@as(i128, 0), priceStorage(.{}, 1_000_000, 86_400_000));
    // Charged entry by entry or at once: the same, to the nanosat the rounding drops at each.
    var parts: i128 = 0;
    for (0..10) |_| parts += priceStorage(r, 1_000_000, 8_640_000);
    try std.testing.expectEqual(priceStorage(r, 1_000_000, 86_400_000), parts);
    // 10^6 bytes served at 3 sats per MB: three sats; 10^9 read fuel at 2: two sats.
    try std.testing.expectEqual(3 * NSAT, priceHost(r, 0, 1_000_000));
    try std.testing.expectEqual(2 * NSAT, priceHost(r, 1_000_000_000, 0));
}

test "billing: the host row — the first billing row's terms; its settings checked" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const k1 = [_]u8{2} ++ [_]u8{1} ** 32;
    const k2 = [_]u8{3} ++ [_]u8{2} ** 32;
    const row = struct {
        fn f(al: std.mem.Allocator, key: []const u8, x: ?i64, rates: ?Value) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("transport", cbor.string("mailbox"));
            try m.put("address", cbor.string("billing"));
            try m.put("sender", .{ .bytes = key });
            try m.put("program", cbor.string("kernel"));
            try m.put("fn", cbor.string(OP));
            if (x) |n| try m.put("x", cbor.int(n));
            try m.put("rates", rates);
            return m.value();
        }
    }.f;
    var rm = cbor.MapBuilder.init(a);
    try rm.put("fuel", cbor.int(1));
    try rm.put("publish", cbor.int(4));
    const good = try row(a, &k1, 500, rm.value());
    try std.testing.expect((try rowProblem(a, good)) == null);
    try std.testing.expect((try dispatch.problem(a, good)) == null);
    try std.testing.expect((try rowProblem(a, try row(a, &k1, null, null))) != null);
    try std.testing.expect((try rowProblem(a, try row(a, &k1, 0, null))) != null);
    var bad = cbor.MapBuilder.init(a);
    try bad.put("fuels", cbor.int(1));
    try std.testing.expect((try rowProblem(a, try row(a, &k1, 5, bad.value()))) != null);
    try std.testing.expect((try dispatch.problem(a, try row(a, &k1, 5, bad.value()))) != null);
    var star = cbor.MapBuilder.init(a);
    for ((try row(a, &k1, 5, null)).map) |e| try star.put(e.key, if (std.mem.eql(u8, e.key, "sender")) cbor.string("*") else e.value);
    try std.testing.expect((try dispatch.problem(a, star.value())) != null);

    var up1 = cbor.MapBuilder.init(a);
    try up1.put("op", cbor.string("add"));
    try up1.put("row", good);
    var up2 = cbor.MapBuilder.init(a);
    try up2.put("op", cbor.string("add"));
    try up2.put("row", try row(a, &k2, 9, null));
    const rows = try dispatch.fold(a, &.{ up1.value(), up2.value() });
    const t = termsOf(rows).?;
    try std.testing.expectEqualSlices(u8, &k1, t.host);
    try std.testing.expectEqual(@as(u64, 500), t.x);
    try std.testing.expectEqual(@as(u64, 1), t.rates.fuel);
    try std.testing.expectEqual(@as(u64, 4), t.rates.publish);
    try std.testing.expectEqual(@as(u64, 0), t.rates.storage);
    try std.testing.expect(termsOf(rows[1..]) != null);
    try std.testing.expect(termsOf(&.{}) == null);
}

test "billing: the state record round-trips; allocation = allowance + paid; a wake's body" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const k1 = [_]u8{2} ++ [_]u8{1} ** 32;
    const e = try cbor.cidOfValue(a, cbor.string("an entry"));
    const s = State{ .host = &k1, .allowance = 100, .paid = 50, .tally = 149 * NSAT + 7, .last_charge = 1_700_000_000_000, .bytes = 4096, .payments = 1 };
    const back = State.of(try cbor.decode(a, try cbor.encode(a, try s.value(a)))).?;
    try std.testing.expectEqualSlices(u8, &k1, back.host);
    try std.testing.expectEqual(s.tally, back.tally);
    try std.testing.expectEqual(s.last_charge, back.last_charge);
    try std.testing.expectEqual(@as(u64, 4096), back.bytes);
    try std.testing.expectEqual(@as(i128, 150) * NSAT, back.allocation());
    try std.testing.expect(back.tally < back.allocation());
    try std.testing.expect(!back.asleep);

    var w = cbor.MapBuilder.init(a);
    try w.put("kind", cbor.string("wake"));
    try w.put("allowance", cbor.int(10));
    try w.put("received", cbor.int(300));
    try std.testing.expectEqual(@as(u64, 10), wakeOf(w.value()).ok.allowance);
    try std.testing.expectEqual(@as(u64, 300), wakeOf(w.value()).ok.received);
    try std.testing.expect(wakeOf(cbor.string("wake")) == .bad);
    var tick = cbor.MapBuilder.init(a);
    try tick.put("kind", cbor.string("tick"));
    try tick.put("allowance", cbor.int(10));
    try std.testing.expect(wakeOf(tick.value()) == .bad);
    var no = cbor.MapBuilder.init(a);
    try no.put("kind", cbor.string("wake"));
    try no.put("allowance", cbor.int(10));
    try std.testing.expect(wakeOf(no.value()) == .bad);
    // The checkpoint: OP_FALSE OP_RETURN <the CID>.
    const sc = try checkpointScript(a, e);
    try std.testing.expectEqualSlices(u8, &.{ 0x00, 0x6a, @intCast(e.len) }, sc[0..3]);
    try std.testing.expectEqualSlices(u8, e, sc[3..]);
}

test "billing: the host's attestation — its form, signed by the host for this skein only (a fixture @bsv/sdk signed)" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // ProtoWallet(0x11…11).createSignature([2, "skein billing"], "attestation", anyone) over
    // dag-cbor {kind: "attestation", instance: <0x22…22's public key>, fuel: 5, served: 7, log}.
    var host: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&host, "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa");
    var inst: [33]u8 = undefined;
    _ = try std.fmt.hexToBytes(&inst, "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");
    var log: [36]u8 = undefined;
    _ = try std.fmt.hexToBytes(&log, "017112205d4fb1da1bcac84abd10fec47c73513adeb4f44e21ab8ae4809f04bf127a8b85");
    var sig: [70]u8 = undefined;
    _ = try std.fmt.hexToBytes(&sig, "30440220128e144088e24ea88340155e1d56128a8c6a891ea76c2c18338bfdfe2876339602207631f125ee36cc7818a83d190583f22cd0018443f70f7e8764948bb1e951841d");
    var pre: [121]u8 = undefined;
    _ = try std.fmt.hexToBytes(&pre, "a5636c6f67d82a582500017112205d4fb1da1bcac84abd10fec47c73513adeb4f44e21ab8ae4809f04bf127a8b85646675656c05646b696e646b6174746573746174696f6e667365727665640768696e7374616e6365582102466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27");

    var m = cbor.MapBuilder.init(a);
    try m.put("fuel", cbor.int(5));
    try m.put("served", cbor.int(7));
    try m.put("log", cbor.cidv(&log));
    try m.put("signature", .{ .bytes = &sig });
    const t = attestationOf(m.value()).?;
    try std.testing.expectEqualSlices(u8, &pre, try attestationPreimage(a, &inst, t));
    try std.testing.expect(try attestedBy(a, &host, &inst, t));
    // Another skein, another amount, another key: not the host's attestation.
    var other = inst;
    other[5] ^= 1;
    try std.testing.expect(!(try attestedBy(a, &host, &other, t)));
    var more = t;
    more.served = 8;
    try std.testing.expect(!(try attestedBy(a, &host, &inst, more)));
    try std.testing.expect(!(try attestedBy(a, &inst, &inst, t)));
    // The form: every field, `log` a CID.
    try std.testing.expect(attestationOf(cbor.string("x")) == null);
    try std.testing.expect(attestationOf(null) == null);
    var nolog = cbor.MapBuilder.init(a);
    try nolog.put("fuel", cbor.int(5));
    try nolog.put("served", cbor.int(7));
    try nolog.put("signature", .{ .bytes = &sig });
    try std.testing.expect(attestationOf(nolog.value()) == null);
}
