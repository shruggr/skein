// Subscriptions (#119): how an app takes a libp2p topic at run time. An
// app's installed program emits
//
//   subscribe   {event: "subscribe", topic, program: <role>, fn, filter?}
//   unsubscribe {event: "unsubscribe", topic}
//
// and the kernel records each as an event on the step's update ({kind:
// "event", event, app, topic, …}, log.zig eventRecord; `app` the emitting
// program's, set by the kernel). A subscription IS the delivery record: an
// inbound libp2p message on the topic runs that app's program (`program`, a
// role in the app's record at `<app>/app`) at `fn`, through the door exactly
// as a dispatch row's handler would (the scheduler's matchOf hands the front
// door a row made of it: `rowValue`). No dispatch row is needed or consulted
// for it — except that a `libp2p` row at the same topic wins (a manifest's
// topic, OpNS style).
//
// The set is derived, never written: it is the fold, in log order, of every
// subscribe / unsubscribe record the steps' updates list in `emitted` (`fold`).
// A subscription is keyed by (app, topic): an app's subscribe replaces its own
// in place; another app's subscribe of the same topic is that app's own and
// does not take the topic (the first standing subscription delivers); an
// unsubscribe removes only the emitting app's. The kernel keeps the fold in
// memory (the scheduler's `subscriptions`), computed again after a step that
// subscribed or unsubscribed; the host reads the same fold from the log to
// know which topics to subscribe (src/host/p2p.ts subscriptionsOf).
//
// Log order is the one the host folds by too: the processed entry's `n`, the
// update's `at`, the thread's `at`, the thread's CID, the step's place in its
// thread, the event's place in `emitted`.
const std = @import("std");
const cbor = @import("cbor");
const heads = @import("heads.zig");
const json = @import("json.zig");
const doorm = @import("door.zig");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

pub const Sub = struct {
    app: []const u8,
    topic: []const u8,
    /// A role in the app's record (`<app>/app` programs).
    program: []const u8,
    func: []const u8,
    filter: ?[]const u8 = null,
};

pub const Kind = enum { subscribe, unsubscribe };
pub const Event = struct { kind: Kind, sub: Sub };

/// Whether `name` is a topic a subscription may name: text, no space or NUL, not a `/<protocol>`.
pub fn isTopic(name: []const u8) bool {
    return name.len > 0 and name[0] != '/' and !heads.hasSpaceOrNul(name);
}

/// A recorded subscribe / unsubscribe event ({kind: "event", event, app, topic, program?, fn?, filter?}), or null.
pub fn eventOf(rec: Value) ?Event {
    if (rec != .map) return null;
    if (!std.mem.eql(u8, Value.str(rec.get("kind")) orelse "", "event")) return null;
    const ev = Value.str(rec.get("event")) orelse return null;
    const kind: Kind = if (std.mem.eql(u8, ev, "subscribe")) .subscribe else if (std.mem.eql(u8, ev, "unsubscribe")) .unsubscribe else return null;
    const app = Value.str(rec.get("app")) orelse return null;
    const topic = Value.str(rec.get("topic")) orelse return null;
    if (app.len == 0 or !isTopic(topic)) return null;
    if (kind == .unsubscribe) return .{ .kind = kind, .sub = .{ .app = app, .topic = topic, .program = "", .func = "" } };
    const program = Value.str(rec.get("program")) orelse return null;
    const func = Value.str(rec.get("fn")) orelse return null;
    if (program.len == 0 or func.len == 0) return null;
    return .{ .kind = kind, .sub = .{ .app = app, .topic = topic, .program = program, .func = func, .filter = Value.str(rec.get("filter")) } };
}

fn index(subs: []const Sub, app: []const u8, topic: []const u8) ?usize {
    for (subs, 0..) |s, i| if (std.mem.eql(u8, s.app, app) and std.mem.eql(u8, s.topic, topic)) return i;
    return null;
}

/// One event applied: a subscribe replaces the app's own subscription to the topic in place, else appends; an unsubscribe removes it.
pub fn apply(list: *std.array_list.Managed(Sub), e: Event) !void {
    const i = index(list.items, e.sub.app, e.sub.topic);
    switch (e.kind) {
        .subscribe => if (i) |x| {
            list.items[x] = e.sub;
        } else try list.append(e.sub),
        .unsubscribe => if (i) |x| {
            _ = list.orderedRemove(x);
        },
    }
}

/// Whether `app` has a subscription to `topic`.
pub fn has(subs: []const Sub, app: []const u8, topic: []const u8) bool {
    return index(subs, app, topic) != null;
}

/// The subscription that delivers `topic`: the first standing one.
pub fn forTopic(subs: []const Sub, topic: []const u8) ?Sub {
    for (subs) |s| if (std.mem.eql(u8, s.topic, topic)) return s;
    return null;
}

/// Why an emitted subscribe / unsubscribe is refused (the emit's error), or null. `app` is the
/// emitting program's (null: its record is not installed); `programs` the app record's `programs`
/// map (null: the app has no record at `<app>/app`); `now` the subscriptions as the step sees them.
pub fn problem(a: std.mem.Allocator, kind: Kind, m: Value, app: ?[]const u8, programs: ?Value, now: []const Sub) !?[]u8 {
    const name = @tagName(kind);
    const who = app orelse return try std.fmt.allocPrint(a, "emit: {s}: the emitting program is not installed (an app's program), so it has no subscriptions", .{name});
    const topic = Value.str(m.get("topic")) orelse return try std.fmt.allocPrint(a, "emit: {s} names a topic: {{event: \"{s}\", topic{s}}}", .{ name, name, if (kind == .subscribe) ", program, fn" else "" });
    if (!isTopic(topic)) return try std.fmt.allocPrint(a, "emit: {s}: topic {s} is not a topic (text, no space or NUL; a /protocol is not subscribed)", .{ name, try json.quoted(a, topic) });
    if (kind == .unsubscribe) {
        if (!has(now, who, topic)) return try std.fmt.allocPrint(a, "emit: unsubscribe: app {s} has no subscription to {s} (an app unsubscribes only its own)", .{ who, topic });
        return null;
    }
    const prog = Value.str(m.get("program")) orelse "";
    if (prog.len == 0) return try a.dupe(u8, "emit: subscribe names its program: a role in the app's record (`program`, text)");
    const ps = programs orelse return try std.fmt.allocPrint(a, "emit: subscribe: app {s} has no record at {s}/app, so no program of it is named", .{ who, who });
    if (ps != .map or Value.cidOf(ps.get(prog)) == null) return try std.fmt.allocPrint(a, "emit: subscribe: {s} is not a program of app {s} (its record at {s}/app)", .{ try json.quoted(a, prog), who, who });
    const func = Value.str(m.get("fn")) orelse "";
    if (func.len == 0) return try a.dupe(u8, "emit: subscribe names the function delivered to (`fn`, text, not empty)");
    if (m.get("filter")) |f| if (f != .null) {
        const fname = Value.str(f) orelse return try a.dupe(u8, "emit: subscribe: `filter` is a filter's name");
        if (!doorm.isFilter(fname)) return try std.fmt.allocPrint(a, "emit: subscribe: filter {s}: this kernel has no such filter", .{try json.quoted(a, fname)});
    };
    return null;
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
    // The subscriptions' fold reads none of them.
    try std.testing.expectEqual(@as(usize, 0), (try fold(a, s)).len);
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

/// The dispatch row a subscription stands for, handed to the front door as `match` (the scheduler's
/// matchOf): {transport: "libp2p", address: topic, sender: "*", program: <the role's CID, now>, fn,
/// app, filter?} — an installed row's shape. Null when the app's record no longer names the role (an
/// uninstall): nothing delivers.
pub fn rowValue(a: std.mem.Allocator, s: Store, sub: Sub) !?Value {
    const ps = (try programsOf(a, s, sub.app)) orelse return null;
    if (ps != .map) return null;
    const c = Value.cidOf(ps.get(sub.program)) orelse return null;
    var m = cbor.MapBuilder.init(a);
    try m.put("transport", cbor.string("libp2p"));
    try m.put("address", cbor.string(sub.topic));
    try m.put("sender", cbor.string("*"));
    try m.put("program", cbor.cidv(c));
    try m.put("fn", cbor.string(sub.func));
    try m.put("app", cbor.string(sub.app));
    if (sub.filter) |f| try m.put("filter", cbor.string(f));
    return m.value();
}

/// Where an event record stands in the log (the fold's order, above).
const Key = struct { n: i128, at: i128, tat: i128, thread: []const u8, seq: usize, i: usize };

fn keyBefore(x: Key, y: Key) bool {
    if (x.n != y.n) return x.n < y.n;
    if (x.at != y.at) return x.at < y.at;
    if (x.tat != y.tat) return x.tat < y.tat;
    switch (std.mem.order(u8, x.thread, y.thread)) {
        .lt => return true,
        .gt => return false,
        .eq => {},
    }
    if (x.seq != y.seq) return x.seq < y.seq;
    return x.i < y.i;
}

/// Every event record listed in a step's `emitted` that `read` takes, in log order. Read only.
fn collect(comptime E: type, a: std.mem.Allocator, s: Store, comptime read: fn (Value) ?E) ![]E {
    const Found = struct { k: Key, e: E };
    var found = std.array_list.Managed(Found).init(a);
    var ns = std.StringHashMap(i128).init(a);
    for (try s.threads(a)) |t| {
        const o = s.getOpt(a, t) orelse continue;
        const tat = Value.intOf(o.get("at")) orelse 0;
        const ups = (try s.chainUpdates(a, t)) orelse continue;
        for (ups, 1..) |uc, seq| {
            const u = s.getOpt(a, uc) orelse continue;
            const em = u.get("emitted") orelse continue;
            if (em != .array) continue;
            for (em.array, 0..) |x, i| {
                const c = Value.cidOf(x) orelse continue;
                const rec = s.getOpt(a, c) orelse continue;
                const e = read(rec) orelse continue;
                var n: i128 = -1;
                if (Value.cidOf(u.get("input"))) |ic| {
                    if (ns.get(ic)) |v| n = v else {
                        if (s.getOpt(a, ic)) |ev| n = Value.intOf(ev.get("n")) orelse -1;
                        try ns.put(ic, n);
                    }
                }
                try found.append(.{ .k = .{ .n = n, .at = Value.intOf(u.get("at")) orelse 0, .tat = tat, .thread = t, .seq = seq, .i = i }, .e = e });
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

/// The subscriptions as the store's log stands: every subscribe / unsubscribe record listed in a
/// step's `emitted`, folded in log order (above). Read only.
pub fn fold(a: std.mem.Allocator, s: Store) ![]Sub {
    var out = std.array_list.Managed(Sub).init(a);
    for (try collect(Event, a, s, eventOf)) |e| try apply(&out, e);
    return out.items;
}

/// A copy of `subs` in `a` (the scheduler keeps the fold in its long-lived arena).
pub fn dupe(a: std.mem.Allocator, subs: []const Sub) ![]Sub {
    const out = try a.alloc(Sub, subs.len);
    for (subs, out) |x, *o| o.* = .{
        .app = try a.dupe(u8, x.app),
        .topic = try a.dupe(u8, x.topic),
        .program = try a.dupe(u8, x.program),
        .func = try a.dupe(u8, x.func),
        .filter = if (x.filter) |f| try a.dupe(u8, f) else null,
    };
    return out;
}

// ---------------------------------------------------------------- tests

fn eventRec(a: std.mem.Allocator, ev: []const u8, app: []const u8, topic: []const u8, program: ?[]const u8, func: ?[]const u8) !Value {
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("event"));
    try m.put("event", cbor.string(ev));
    try m.put("app", cbor.string(app));
    try m.put("topic", cbor.string(topic));
    if (program) |p| try m.put("program", cbor.string(p));
    if (func) |f| try m.put("fn", cbor.string(f));
    return m.value();
}

test "subscriptions: keyed by (app, topic); the first standing one delivers; an unsubscribe removes only the app's own" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var l = std.array_list.Managed(Sub).init(a);
    const ev = struct {
        fn f(al: std.mem.Allocator, kind: []const u8, app: []const u8, topic: []const u8, func: ?[]const u8) !Event {
            return eventOf(try eventRec(al, kind, app, topic, if (func != null) "main" else null, func)).?;
        }
    }.f;
    try apply(&l, try ev(a, "subscribe", "x", "tm_a", "submit"));
    try apply(&l, try ev(a, "subscribe", "y", "tm_a", "other"));
    try std.testing.expectEqualStrings("x", forTopic(l.items, "tm_a").?.app);
    // The same app again: in place, its fn replaced; still first.
    try apply(&l, try ev(a, "subscribe", "x", "tm_a", "peerAdmit"));
    try std.testing.expectEqual(@as(usize, 2), l.items.len);
    try std.testing.expectEqualStrings("peerAdmit", forTopic(l.items, "tm_a").?.func);
    // y's unsubscribe leaves x's; x's then leaves y's to deliver.
    try apply(&l, try ev(a, "unsubscribe", "y", "tm_a", null));
    try std.testing.expectEqualStrings("x", forTopic(l.items, "tm_a").?.app);
    try apply(&l, try ev(a, "subscribe", "y", "tm_a", "other"));
    try apply(&l, try ev(a, "unsubscribe", "x", "tm_a", null));
    try std.testing.expectEqualStrings("y", forTopic(l.items, "tm_a").?.app);
    try std.testing.expect(forTopic(l.items, "tm_b") == null);
    // Not subscriptions: no app, a /protocol, a subscribe with no program or fn, another event.
    var bare = cbor.MapBuilder.init(a);
    try bare.put("kind", cbor.string("event"));
    try bare.put("event", cbor.string("subscribe"));
    try bare.put("topic", cbor.string("tm_a"));
    try std.testing.expect(eventOf(bare.value()) == null);
    try std.testing.expect(eventOf(try eventRec(a, "subscribe", "x", "/p/1", "main", "f")) == null);
    try std.testing.expect(eventOf(try eventRec(a, "subscribe", "x", "tm_a", null, null)) == null);
    try std.testing.expect(eventOf(try eventRec(a, "subscribe", "x", "tm_a", "main", "")) == null);
    try std.testing.expect(eventOf(try eventRec(a, "made-up", "x", "tm_a", "main", "f")) == null);
}

test "subscriptions: validation — an installed app's program and a fn; a topic, not a /protocol; unsubscribe only its own" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cid1 = try @import("cid").parse(a, "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    var pm = cbor.MapBuilder.init(a);
    try pm.put("engine", cbor.cidv(cid1));
    const programs = pm.value();
    const emit = struct {
        fn f(al: std.mem.Allocator, ev: []const u8, topic: []const u8, program: ?[]const u8, func: ?[]const u8) !Value {
            var m = cbor.MapBuilder.init(al);
            try m.put("event", cbor.string(ev));
            try m.put("topic", cbor.string(topic));
            if (program) |p| try m.put("program", cbor.string(p));
            if (func) |x| try m.put("fn", cbor.string(x));
            return m.value();
        }
    }.f;
    const now = [_]Sub{.{ .app = "ov", .topic = "tm_a", .program = "engine", .func = "submit" }};
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", "engine", "submit"), "ov", programs, &now)) == null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", "engine", "submit"), null, programs, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", "engine", "submit"), "ov", null, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", "other", "submit"), "ov", programs, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", "engine", null), "ov", programs, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", "engine", ""), "ov", programs, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "tm_b", null, "submit"), "ov", programs, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "/p/1", "engine", "submit"), "ov", programs, &now)) != null);
    try std.testing.expect((try problem(a, .subscribe, try emit(a, "subscribe", "a b", "engine", "submit"), "ov", programs, &now)) != null);
    try std.testing.expect((try problem(a, .unsubscribe, try emit(a, "unsubscribe", "tm_a", null, null), "ov", programs, &now)) == null);
    try std.testing.expect((try problem(a, .unsubscribe, try emit(a, "unsubscribe", "tm_a", null, null), "other", null, &now)) != null);
    try std.testing.expect((try problem(a, .unsubscribe, try emit(a, "unsubscribe", "tm_b", null, null), "ov", programs, &now)) != null);
    var f = cbor.MapBuilder.init(a);
    try f.put("event", cbor.string("subscribe"));
    try f.put("topic", cbor.string("tm_b"));
    try f.put("program", cbor.string("engine"));
    try f.put("fn", cbor.string("submit"));
    try f.put("filter", cbor.string("nope"));
    try std.testing.expect((try problem(a, .subscribe, f.value(), "ov", programs, &now)) != null);
}

test "subscriptions: the fold reads the steps' emitted events in log order; the row a subscription stands for" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ss = try @import("sqlite_store.zig").SqliteStore.open(std.testing.allocator, std.testing.io, ":memory:");
    defer ss.close();
    const s = ss.store();
    const cid1 = try @import("cid").parse(a, "bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy");
    // Two entries, two threads; the later thread's events come first in the store's thread order
    // (an earlier `at`) but its entry is later.
    const entry = struct {
        fn f(al: std.mem.Allocator, st: Store, n: i64) ![]u8 {
            var m = cbor.MapBuilder.init(al);
            try m.put("kind", cbor.string("test-entry"));
            try m.put("n", cbor.int(n));
            return st.put(al, m.value());
        }
    }.f;
    const thread = struct {
        fn f(al: std.mem.Allocator, st: Store, at: i64, name: []const u8) ![]u8 {
            var m = cbor.MapBuilder.init(al);
            try m.put("kind", cbor.string("thread"));
            try m.put("name", cbor.string(name));
            try m.put("at", cbor.int(at));
            return st.chainOpen(al, m.value());
        }
    }.f;
    const step = struct {
        fn f(al: std.mem.Allocator, st: Store, t: []const u8, input: []const u8, at: i64, recs: []const Value) !void {
            const cs = try al.alloc([]const u8, recs.len);
            for (recs, cs) |r, *c| c.* = try st.put(al, r);
            var m = cbor.MapBuilder.init(al);
            try m.put("state", cbor.string("finished"));
            try m.put("input", cbor.cidv(input));
            try m.put("at", cbor.int(at));
            try m.put("emitted", (try cbor.cidArray(al, cs)).?);
            _ = try st.chainAppend(al, t, m.value());
        }
    }.f;
    const e1 = try entry(a, s, 1);
    const e2 = try entry(a, s, 2);
    const t1 = try thread(a, s, 100, "one");
    const t2 = try thread(a, s, 50, "two");
    try step(a, s, t1, e1, 100, &.{ try eventRec(a, "subscribe", "ov", "tm_a", "engine", "submit"), try eventRec(a, "subscribe", "ov", "tm_b", "engine", "submit") });
    try step(a, s, t2, e2, 200, &.{try eventRec(a, "unsubscribe", "ov", "tm_a", null, null)});
    try step(a, s, t1, e2, 200, &.{try eventRec(a, "subscribe", "other", "tm_b", "main", "f")});
    const subs = try fold(a, s);
    try std.testing.expectEqual(@as(usize, 2), subs.len);
    try std.testing.expectEqualStrings("tm_b", subs[0].topic);
    try std.testing.expectEqualStrings("ov", subs[0].app);
    try std.testing.expectEqualStrings("other", subs[1].app);
    try std.testing.expect(forTopic(subs, "tm_a") == null);
    // The row: the role resolved through <app>/app; none once the app has no record.
    try std.testing.expect((try rowValue(a, s, subs[0])) == null);
    var ar = cbor.MapBuilder.init(a);
    try ar.put("kind", cbor.string("app"));
    var ps = cbor.MapBuilder.init(a);
    try ps.put("engine", cbor.cidv(cid1));
    try ar.put("programs", ps.value());
    const root = try s.put(a, ar.value());
    _ = try heads.advanceHead(a, s, "ov/app", root, .{ .thread = null, .input = root, .at = 0 });
    const row = (try rowValue(a, s, subs[0])).?;
    try std.testing.expectEqualSlices(u8, cid1, Value.cidOf(row.get("program")).?);
    try std.testing.expectEqualStrings("submit", Value.str(row.get("fn")).?);
    try std.testing.expectEqualStrings("tm_b", Value.str(row.get("address")).?);
    try std.testing.expectEqualStrings("ov", Value.str(row.get("app")).?);
}
