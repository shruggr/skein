// The input log (src/runtime/log.ts) and the record shapes the scheduler
// checks (records.ts): entry validation and its host signature, the genesis,
// emits, attested calls.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const secp = @import("secp.zig");
const syscalls = @import("syscalls.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub fn stampOf(v: ?Value) ?syscalls.Stamp {
    const t = v orelse return null;
    if (t != .array or t.array.len != 2) return null;
    const s = Value.intOf(t.array[0]) orelse return null;
    const n = Value.intOf(t.array[1]) orelse return null;
    return .{ .sec = @intCast(s), .nsec = @intCast(n) };
}

pub fn isOutcome(x: ?Value) bool {
    const o = x orelse return false;
    if (o != .map) return false;
    if (Value.cidOf(o.get("emit")) == null) return false;
    const st = Value.str(o.get("status")) orelse return false;
    if (!std.mem.eql(u8, st, "delivered") and !std.mem.eql(u8, st, "failed")) return false;
    if (o.get("reason")) |r| if (r != .string) return false;
    return true;
}

/// A plain entry (#29): {kind: "log", n, prev, time, box, event} — an event
/// the host admits from a feed it holds (a header, a proof, a transaction
/// status), the record `event` names, routed by `box`. No envelope, no
/// signature: it self-validates inside the program that takes it (#9
/// revised: entries are unsigned; the envelope/wake/outcome kinds keep their
/// signatures until #33 reshapes them).
pub fn isEventEntry(e: Value) bool {
    if (e != .map) return false;
    if (!std.mem.eql(u8, Value.str(e.get("kind")) orelse return false, "log")) return false;
    if (!Value.isNumber(e.get("n")) or e.get("sig") != null) return false;
    if (Value.cidOf(e.get("event")) == null) return false;
    const box = Value.str(e.get("box")) orelse return false;
    if (box.len == 0) return false;
    for ([_][]const u8{ "genesis", "envelope", "wake", "outcome", "body" }) |k| if (e.get(k) != null) return false;
    return true;
}

/// log.ts isLogEntry, and the plain (event) entries.
pub fn isLogEntry(e: Value) bool {
    if (isEventEntry(e)) return true;
    if (e != .map) return false;
    const kind = Value.str(e.get("kind")) orelse return false;
    if (!std.mem.eql(u8, kind, "log")) return false;
    if (!Value.isNumber(e.get("n"))) return false;
    if (Value.bytesOf(e.get("sig")) == null) return false;
    var count: usize = 0;
    for ([_][]const u8{ "genesis", "envelope", "wake", "outcome" }) |k| {
        if (e.get(k) != null) count += 1;
    }
    if (count != 1) return false;
    if ((e.get("envelope") == null) != (e.get("body") == null)) return false;
    if (e.get("outcome")) |o| if (!isOutcome(o)) return false;
    return true;
}

/// The signed bytes: the entry's dag-cbor without `sig`.
pub fn entryBytes(a: std.mem.Allocator, e: Value) ![]u8 {
    return cbor.encode(a, try cbor.without(a, e, "sig"));
}

/// The host's signature on an entry; a plain (event) entry has none to check.
pub fn verifyEntry(a: std.mem.Allocator, e: Value, host: []const u8) bool {
    if (isEventEntry(e)) return true;
    const sig = Value.bytesOf(e.get("sig")) orelse return false;
    const bytes = entryBytes(a, e) catch return false;
    return secp.verifyAnyone(host, 2, "skein log", "1", bytes, sig);
}

fn isCidMap(v: ?Value) bool {
    const m = v orelse return false;
    if (m != .map) return false;
    for (m.map) |e| if (e.value != .cid) return false;
    return true;
}

/// records.ts isSubscription.
fn isSubscription(x: Value) bool {
    if (x != .map) return false;
    const m = x.get("match") orelse return false;
    if (m != .map) return false;
    if (m.get("sender")) |s| if (s != .string or !secp.isIdentity(s.string)) return false;
    if (m.get("box")) |b| if (b != .string) return false;
    return Value.cidOf(x.get("handler")) != null;
}

/// records.ts isGenesis.
pub fn isGenesis(x: ?Value) bool {
    const g = x orelse return false;
    if (g != .map) return false;
    if (!std.mem.eql(u8, Value.str(g.get("kind")) orelse return false, "genesis")) return false;
    for ([_][]const u8{ "identity", "owner", "host" }) |k| {
        if (!secp.isIdentity(Value.str(g.get(k)) orelse return false)) return false;
    }
    if (Value.str(g.get("handle")) == null or Value.str(g.get("domain")) == null) return false;
    if (!isCidMap(g.get("programs"))) return false;
    const subs = g.get("subscriptions") orelse return false;
    if (subs != .array) return false;
    for (subs.array) |s| if (!isSubscription(s)) return false;
    if (g.get("peers")) |p| {
        if (p != .map) return false;
        for (p.map) |e| if (e.value != .string or !secp.isIdentity(e.value.string)) return false;
    }
    if (g.get("defaults")) |d| {
        if (d != .map) return false;
        for (d.map) |e| if (e.value != .string) return false;
    }
    if (g.get("names")) |n| {
        if (n != .map) return false;
        for (n.map) |e| {
            if (!secp.isIdentity(e.key)) return false;
            if (e.value != .map or Value.str(e.value.get("handle")) == null or Value.str(e.value.get("domain")) == null) return false;
        }
    }
    if (g.get("collect")) |c| {
        if (c != .array) return false;
        for (c.array) |b| if (b != .string or b.string.len == 0) return false;
    }
    return true;
}

/// records.ts isEmit.
pub fn isEmit(x: ?Value) bool {
    const e = x orelse return false;
    if (e != .map) return false;
    if (!std.mem.eql(u8, Value.str(e.get("kind")) orelse return false, "emit")) return false;
    if (!secp.isIdentity(Value.str(e.get("to")) orelse return false)) return false;
    const box = Value.str(e.get("box")) orelse return false;
    if (box.len == 0) return false;
    if (Value.cidOf(e.get("body")) == null) return false;
    const env = e.get("envelope") orelse return false;
    return env == .map and Value.str(env.get("content")) != null;
}

/// records.ts isAttested.
pub fn isAttested(x: ?Value) bool {
    const a = x orelse return false;
    if (a != .map) return false;
    if (!std.mem.eql(u8, Value.str(a.get("kind")) orelse return false, "attested")) return false;
    if (Value.cidOf(a.get("thread")) == null) return false;
    if (!Value.isNumber(a.get("step")) or !Value.isNumber(a.get("i"))) return false;
    const op = Value.str(a.get("op")) orelse return false;
    if (!std.mem.eql(u8, op, "wallet") and !std.mem.eql(u8, op, "resolve") and !std.mem.eql(u8, op, "http")) return false;
    return Value.bytesOf(a.get("result")) != null;
}

/// The genesis a log starts with (log.ts genesisOf).
pub fn genesisOf(a: std.mem.Allocator, s: Store) !Value {
    const first = try s.logFrom(a, 0);
    if (first.len == 0) return error.EmptyLog;
    const e = (try s.get(a, first[0])) orelse return error.NotFound;
    const gc = Value.cidOf(e.get("genesis")) orelse return error.NoGenesis;
    const g = s.getOpt(a, gc);
    if (!isGenesis(g)) return error.NoGenesis;
    return g.?;
}
