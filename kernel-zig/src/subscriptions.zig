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

const Found = struct { n: i128, at: i128, tat: i128, thread: []const u8, seq: usize, i: usize, e: Event };

fn before(_: void, x: Found, y: Found) bool {
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

/// The subscriptions as the store's log stands: every subscribe / unsubscribe record listed in a
/// step's `emitted`, folded in log order (above). Read only.
pub fn fold(a: std.mem.Allocator, s: Store) ![]Sub {
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
                const e = eventOf(rec) orelse continue;
                var n: i128 = -1;
                if (Value.cidOf(u.get("input"))) |ic| {
                    if (ns.get(ic)) |v| n = v else {
                        if (s.getOpt(a, ic)) |ev| n = Value.intOf(ev.get("n")) orelse -1;
                        try ns.put(ic, n);
                    }
                }
                try found.append(.{ .n = n, .at = Value.intOf(u.get("at")) orelse 0, .tat = tat, .thread = t, .seq = seq, .i = i, .e = e });
            }
        }
    }
    std.sort.block(Found, found.items, {}, before);
    var out = std.array_list.Managed(Sub).init(a);
    for (found.items) |f| try apply(&out, f.e);
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
