// The host's membership declarations (#119, #126, #138; skein next, SPEC.md section 7: "The
// instance states which topics it serves; the host joins and listens"). An app's installed program
// emits them as events ({kind: "event", event, app, …}, log.zig eventRecord); the kernel checks
// their shape as they are emitted and the host folds them from the log. Nothing is delivered by
// them: there is no gossip row and no topic subscription list as a second match source in the
// kernel (one layer of route matching, dispatch.zig).
//
//   subscribe    {event: "subscribe", topic}        the app serves `topic`: the host joins it
//   unsubscribe  {event: "unsubscribe", topic}
//   beacon       {event: "beacon", topic, every, body}   below
//   liveness     {event: "liveness", topic, window}      below
const std = @import("std");
const cbor = @import("cbor");
const heads = @import("heads.zig");
const json = @import("json.zig");
const dispatch = @import("dispatch.zig");

const Store = @import("store.zig").Store;
const Value = cbor.Value;

/// Whether `name` is a topic a subscription may name: text, no space or NUL, not a `/<protocol>`.
pub fn isTopic(name: []const u8) bool {
    return name.len > 0 and name[0] != '/' and !heads.hasSpaceOrNul(name);
}

/// Why an emitted subscribe / unsubscribe is refused (the emit's error), or null: an installed
/// app's, naming a topic (membership only: no program, no function, no filter).
pub fn subscribeProblem(a: std.mem.Allocator, name: []const u8, m: Value, app: ?[]const u8) !?[]u8 {
    if (app == null) return try std.fmt.allocPrint(a, "emit: {s}: the emitting program is not installed (an app's program), so it serves no topic", .{name});
    const topic = Value.str(m.get("topic")) orelse return try std.fmt.allocPrint(a, "emit: {s} names a topic: {{event: \"{s}\", topic}}", .{ name, name });
    if (!isTopic(topic)) return try std.fmt.allocPrint(a, "emit: {s}: topic {s} is not a topic (text, no space or NUL; a /protocol is not subscribed)", .{ name, try json.quoted(a, topic) });
    for ([_][]const u8{ "program", "fn", "filter" }) |k| if (m.get(k) != null) return try std.fmt.allocPrint(a, "emit: {s}: `{s}` is gone (skein next: a subscription is membership only — the host joins the topic; nothing is delivered by it)", .{ name, k });
    return null;
}

test "subscribe (skein next): membership only — an installed app's, a topic, no program or fn" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var m = cbor.MapBuilder.init(a);
    try m.put("event", cbor.string("subscribe"));
    try m.put("topic", cbor.string("tm_ab"));
    try std.testing.expect((try subscribeProblem(a, "subscribe", m.value(), "overlay")) == null);
    try std.testing.expect((try subscribeProblem(a, "subscribe", m.value(), null)) != null);
    try m.put("fn", cbor.string("receive"));
    try std.testing.expect((try subscribeProblem(a, "subscribe", m.value(), "overlay")) != null);
    var u = cbor.MapBuilder.init(a);
    try u.put("event", cbor.string("unsubscribe"));
    try u.put("topic", cbor.string("/skein/overlay/sync/1.0.0"));
    try std.testing.expect((try subscribeProblem(a, "unsubscribe", u.value(), "overlay")) != null);
}

// ---------------------------------------------------------------- beacons (#126)
//
// A beacon is the same family as a subscription: an app's installed program
// declares it once —
//
//   beacon   {event: "beacon", topic, every: <ms>, body: bytes}
//   unbeacon {event: "unbeacon", topic}
//
// — and the kernel records it on the step's update as any event ({kind:
// "event", event, app, …}). No answer comes. The host's libp2p node
// publishes `body` on `topic` every `every` ms on its own clock (GossipSub
// signs it with the node's key) and logs nothing per beat; it does not
// subscribe the topic for it. A beacon stands until its app's unbeacon of the
// topic (keyed by (app, topic), as a subscription) or its app's uninstall;
// the host folds them from the log (src/host/p2p.ts beaconsOf). The kernel
// only checks the shape as it is emitted: nothing delivers by a beacon.

/// The shortest beat (ms).
pub const BEACON_MIN_MS: i128 = 1000;
/// The largest beacon body (bytes): one GossipSub message.
pub const BEACON_MAX_BODY: usize = 64 << 10;

/// Why a `beacon` / `unbeacon` this step emits is refused, or null.
pub fn beaconProblem(a: std.mem.Allocator, name: []const u8, m: Value, app: ?[]const u8) !?[]u8 {
    if (app == null) return try std.fmt.allocPrint(a, "emit: {s}: the emitting program is not installed (an app's program), so it has no beacons", .{name});
    const topic = Value.str(m.get("topic")) orelse return try std.fmt.allocPrint(a, "emit: {s} names a topic: {{event: \"{s}\", topic{s}}}", .{ name, name, if (std.mem.eql(u8, name, "beacon")) ", every, body" else "" });
    if (!isTopic(topic)) return try std.fmt.allocPrint(a, "emit: {s}: topic {s} is not a topic (text, no space or NUL, not a /protocol)", .{ name, try json.quoted(a, topic) });
    if (std.mem.eql(u8, name, "unbeacon")) return null;
    const every = Value.intOf(m.get("every")) orelse return try a.dupe(u8, "emit: beacon: `every` is the beat in ms (an integer)");
    if (every < BEACON_MIN_MS or every > 86_400_000) return try std.fmt.allocPrint(a, "emit: beacon: every {d} ms: from {d} ms to a day", .{ every, BEACON_MIN_MS });
    const body = Value.bytesOf(m.get("body")) orelse return try a.dupe(u8, "emit: beacon: `body` is the bytes published at each beat");
    if (body.len > BEACON_MAX_BODY) return try std.fmt.allocPrint(a, "emit: beacon: the body is {d} bytes, over {d}", .{ body.len, BEACON_MAX_BODY });
    return null;
}

test "beacons (#126): an installed app's; a topic, a beat of a second or more, a body; unbeacon names the topic" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var b = cbor.MapBuilder.init(a);
    try b.put("event", cbor.string("beacon"));
    try b.put("topic", cbor.string("amm-live"));
    try b.put("every", cbor.int(5000));
    try b.put("body", .{ .bytes = "hello" });
    try std.testing.expect((try beaconProblem(a, "beacon", b.value(), "amm")) == null);
    try std.testing.expect((try beaconProblem(a, "beacon", b.value(), null)) != null);
    var fast = cbor.MapBuilder.init(a);
    try fast.put("topic", cbor.string("amm-live"));
    try fast.put("every", cbor.int(10));
    try fast.put("body", .{ .bytes = "x" });
    try std.testing.expect((try beaconProblem(a, "beacon", fast.value(), "amm")) != null);
    var nobody = cbor.MapBuilder.init(a);
    try nobody.put("topic", cbor.string("amm-live"));
    try nobody.put("every", cbor.int(5000));
    try std.testing.expect((try beaconProblem(a, "beacon", nobody.value(), "amm")) != null);
    var proto = cbor.MapBuilder.init(a);
    try proto.put("topic", cbor.string("/amm/1"));
    try std.testing.expect((try beaconProblem(a, "unbeacon", proto.value(), "amm")) != null);
    var off = cbor.MapBuilder.init(a);
    try off.put("topic", cbor.string("amm-live"));
    try std.testing.expect((try beaconProblem(a, "unbeacon", off.value(), "amm")) == null);
}

// ---------------------------------------------------------------- liveness (#138)
//
// Liveness is the same family again: an app's installed program declares,
// once per topic,
//
//   liveness   {event: "liveness", topic, window: <ms>}
//   unliveness {event: "unliveness", topic}
//
// and the kernel records it on the step's update as any event ({kind:
// "event", event, app, topic, window?}). No answer comes; nothing is
// delivered by it. A runtime with the liveness tool (src/host/liveness.ts)
// subscribes the topic at the instance's own libp2p node WITHOUT admitting its
// messages, keeps each beacon beat (p2p.ts beaconFrame) whose instance
// signature verifies, the latest per sender newer than `window`, in memory,
// and serves them to the app's page; a runtime without it records the event
// and nothing happens. A liveness stands until its app's unliveness of the
// topic (keyed by (app, topic): an app's liveness replaces its own window in
// place) or its app's uninstall. The set per app is the fold below
// (livenessFold, topic → window); the host folds the same records
// (liveness.ts livenessOf). The kernel checks the shape as it is emitted.

/// The shortest and the longest window (ms): a second, a day.
pub const LIVENESS_MIN_MS: i128 = 1000;
pub const LIVENESS_MAX_MS: i128 = 86_400_000;

pub const Live = struct { app: []const u8, topic: []const u8, window: i64 };
pub const LiveKind = enum { liveness, unliveness };
pub const LiveEvent = struct { kind: LiveKind, live: Live };

/// Why a `liveness` / `unliveness` this step emits is refused, or null.
pub fn livenessProblem(a: std.mem.Allocator, name: []const u8, m: Value, app: ?[]const u8) !?[]u8 {
    if (app == null) return try std.fmt.allocPrint(a, "emit: {s}: the emitting program is not installed (an app's program), so it keeps no liveness", .{name});
    const topic = Value.str(m.get("topic")) orelse return try std.fmt.allocPrint(a, "emit: {s} names a topic: {{event: \"{s}\", topic{s}}}", .{ name, name, if (std.mem.eql(u8, name, "liveness")) ", window" else "" });
    if (!isTopic(topic)) return try std.fmt.allocPrint(a, "emit: {s}: topic {s} is not a topic (text, no space or NUL, not a /protocol)", .{ name, try json.quoted(a, topic) });
    if (std.mem.eql(u8, name, "unliveness")) return null;
    const window = Value.intOf(m.get("window")) orelse return try a.dupe(u8, "emit: liveness: `window` is how long a beat stays live, in ms (an integer)");
    if (window < LIVENESS_MIN_MS or window > LIVENESS_MAX_MS) return try std.fmt.allocPrint(a, "emit: liveness: window {d} ms: from {d} ms to a day", .{ window, LIVENESS_MIN_MS });
    return null;
}

/// A recorded liveness / unliveness event ({kind: "event", event, app, topic, window?}), or null.
pub fn livenessEventOf(rec: Value) ?LiveEvent {
    if (rec != .map) return null;
    if (!std.mem.eql(u8, Value.str(rec.get("kind")) orelse "", "event")) return null;
    const ev = Value.str(rec.get("event")) orelse return null;
    const kind: LiveKind = if (std.mem.eql(u8, ev, "liveness")) .liveness else if (std.mem.eql(u8, ev, "unliveness")) .unliveness else return null;
    const app = Value.str(rec.get("app")) orelse return null;
    const topic = Value.str(rec.get("topic")) orelse return null;
    if (app.len == 0 or !isTopic(topic)) return null;
    if (kind == .unliveness) return .{ .kind = kind, .live = .{ .app = app, .topic = topic, .window = 0 } };
    const w = Value.intOf(rec.get("window")) orelse return null;
    if (w < LIVENESS_MIN_MS or w > LIVENESS_MAX_MS) return null;
    return .{ .kind = kind, .live = .{ .app = app, .topic = topic, .window = @intCast(w) } };
}

/// One event applied: a liveness replaces the app's own on the topic in place, else appends; an unliveness removes it.
pub fn applyLive(list: *std.array_list.Managed(Live), e: LiveEvent) !void {
    var at: ?usize = null;
    for (list.items, 0..) |l, i| if (std.mem.eql(u8, l.app, e.live.app) and std.mem.eql(u8, l.topic, e.live.topic)) {
        at = i;
        break;
    };
    switch (e.kind) {
        .liveness => if (at) |x| {
            list.items[x] = e.live;
        } else try list.append(e.live),
        .unliveness => if (at) |x| {
            _ = list.orderedRemove(x);
        },
    }
}

/// The liveness standing as the store's log stands: every liveness / unliveness record listed in a
/// step's `emitted`, folded in log order. Read only.
pub fn livenessFold(a: std.mem.Allocator, s: Store) ![]Live {
    var out = std.array_list.Managed(Live).init(a);
    for (try collect(LiveEvent, a, s, livenessEventOf)) |e| try applyLive(&out, e);
    return out.items;
}

/// `app`'s liveness window for `topic` (ms), or null: the app keeps no liveness for it.
pub fn windowOf(lives: []const Live, app: []const u8, topic: []const u8) ?i64 {
    for (lives) |l| if (std.mem.eql(u8, l.app, app) and std.mem.eql(u8, l.topic, topic)) return l.window;
    return null;
}

test "liveness (#138): an installed app's; a topic, a window from a second to a day; unliveness names the topic" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const emit = struct {
        fn f(al: std.mem.Allocator, topic: []const u8, window: ?i64) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("topic", cbor.string(topic));
            if (window) |w| try m.put("window", cbor.int(w));
            return m.value();
        }
    }.f;
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "tm_x-live", 30_000), "amm")) == null);
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "tm_x-live", 30_000), null)) != null);
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "tm_x-live", 999), "amm")) != null);
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "tm_x-live", 86_400_001), "amm")) != null);
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "tm_x-live", 86_400_000), "amm")) == null);
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "tm_x-live", null), "amm")) != null);
    try std.testing.expect((try livenessProblem(a, "liveness", try emit(a, "/amm/1", 5000), "amm")) != null);
    try std.testing.expect((try livenessProblem(a, "unliveness", try emit(a, "tm_x-live", null), "amm")) == null);
    try std.testing.expect((try livenessProblem(a, "unliveness", try emit(a, "a b", null), "amm")) != null);
    try std.testing.expect((try livenessProblem(a, "unliveness", try emit(a, "tm_x-live", null), null)) != null);
    var nt = cbor.MapBuilder.init(a);
    try nt.put("window", cbor.int(5000));
    try std.testing.expect((try livenessProblem(a, "liveness", nt.value(), "amm")) != null);
}

test "liveness (#138): the fold — keyed by (app, topic), a liveness replaces the app's own window, an unliveness removes only its own; in log order" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const rec = struct {
        fn f(al: std.mem.Allocator, ev: []const u8, app: []const u8, topic: []const u8, window: ?i64) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("kind", cbor.string("event"));
            try m.put("event", cbor.string(ev));
            try m.put("app", cbor.string(app));
            try m.put("topic", cbor.string(topic));
            if (window) |w| try m.put("window", cbor.int(w));
            return m.value();
        }
    }.f;
    // Not liveness events: no app, a /protocol, a window out of range or missing, another event.
    try std.testing.expect(livenessEventOf(try rec(a, "liveness", "", "t", 5000)) == null);
    try std.testing.expect(livenessEventOf(try rec(a, "liveness", "x", "/p/1", 5000)) == null);
    try std.testing.expect(livenessEventOf(try rec(a, "liveness", "x", "t", 10)) == null);
    try std.testing.expect(livenessEventOf(try rec(a, "liveness", "x", "t", null)) == null);
    try std.testing.expect(livenessEventOf(try rec(a, "beacon", "x", "t", 5000)) == null);
    try std.testing.expect(livenessEventOf(try rec(a, "unliveness", "x", "t", null)) != null);

    const ss = try @import("sqlite_store.zig").SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();
    var em = cbor.MapBuilder.init(a);
    try em.put("kind", cbor.string("test-entry"));
    try em.put("n", cbor.int(1));
    const e1 = try s.put(a, em.value());
    var em2 = cbor.MapBuilder.init(a);
    try em2.put("kind", cbor.string("test-entry"));
    try em2.put("n", cbor.int(2));
    const e2 = try s.put(a, em2.value());
    var tm = cbor.MapBuilder.init(a);
    try tm.put("kind", cbor.string("thread"));
    try tm.put("name", cbor.string("one"));
    try tm.put("at", cbor.int(100));
    const t1 = try s.chainOpen(a, tm.value());
    const step = struct {
        fn f(al: std.mem.Allocator, st: Store, t: []const u8, input: []const u8, at: i64, recs: []const Value) !void {
            const cs = try al.alloc([]const u8, recs.len);
            for (recs, cs) |r, *c| c.* = try st.put(al, r);
            var m = cbor.MapBuilder.init(al);
            try m.put("state", cbor.string("finished"));
            try m.put("input", cbor.cidv(input));
            try m.put("at", cbor.int(at));
            try m.put("emitted", (try cbor.cidArray(al, cs)).?);
            try m.put("ord", cbor.int(at)); // 0.8.0: the step number, here the step's time (they run in time order)
            _ = try st.chainAppend(al, t, m.value());
        }
    }.f;
    try step(a, s, t1, e1, 100, &.{ try rec(a, "liveness", "amm", "tm_a-live", 30_000), try rec(a, "liveness", "amm", "tm_b-live", 30_000), try rec(a, "liveness", "other", "tm_a-live", 5000) });
    try step(a, s, t1, e2, 200, &.{ try rec(a, "liveness", "amm", "tm_a-live", 60_000), try rec(a, "unliveness", "amm", "tm_b-live", null), try rec(a, "unliveness", "amm", "tm_c-live", null) });
    const lives = try livenessFold(a, s);
    try std.testing.expectEqual(@as(usize, 2), lives.len);
    try std.testing.expectEqual(@as(?i64, 60_000), windowOf(lives, "amm", "tm_a-live"));
    try std.testing.expectEqual(@as(?i64, 5000), windowOf(lives, "other", "tm_a-live"));
    try std.testing.expectEqual(@as(?i64, null), windowOf(lives, "amm", "tm_b-live"));
}

/// The app record's `programs` map (`<app>/app`), or null when the app has no record.
pub fn programsOf(a: std.mem.Allocator, s: Store, app: []const u8) !?Value {
    const head = try std.fmt.allocPrint(a, "{s}/app", .{app});
    if (!heads.isHeadName(head)) return null;
    const root = (try heads.headTree(a, s, head)) orelse return null;
    const ar = s.getOpt(a, root) orelse return null;
    if (!std.mem.eql(u8, Value.str(ar.get("kind")) orelse "", "app")) return null;
    return ar.get("programs");
}

/// Where an event record stands (the fold's order, above): its update's step number, its index.
const Key = struct { ord: i128, i: usize };

fn keyBefore(x: Key, y: Key) bool {
    if (x.ord != y.ord) return x.ord < y.ord;
    return x.i < y.i;
}

/// Every event record listed in a step's `emitted` that `read` takes, in log order. Read only.
fn collect(comptime E: type, a: std.mem.Allocator, s: Store, comptime read: fn (Value) ?E) ![]E {
    const Found = struct { k: Key, e: E };
    var found = std.array_list.Managed(Found).init(a);
    for (try s.threads(a)) |t| {
        const ups = (try s.chainUpdates(a, t)) orelse continue;
        for (ups) |uc| {
            const u = s.getOpt(a, uc) orelse continue;
            const em = u.get("emitted") orelse continue;
            if (em != .array) continue;
            for (em.array, 0..) |x, i| {
                const c = Value.cidOf(x) orelse continue;
                const rec = s.getOpt(a, c) orelse continue;
                const e = read(rec) orelse continue;
                try found.append(.{ .k = .{ .ord = Value.intOf(u.get("ord")) orelse 0, .i = i }, .e = e });
            }
        }
    }
    std.sort.block(Found, found.items, {}, struct {
        fn lt(_: void, x: Found, y: Found) bool {
            return keyBefore(x.k, y.k);
        }
    }.lt);
    const out = try a.alloc(E, found.items.len);
    for (found.items, out) |f, *o| o.* = f.e;
    return out;
}
