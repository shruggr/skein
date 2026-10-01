// The kernel's index as IPLD maps in the store (issue #30): what SQLite's
// chains/updates/edges/entries tables were, now Merkle search trees
// (mst.zig) whose nodes are blocks beside every other record, and one state
// record naming their roots:
//
//   {kind: "skein-state", format: 2, log: <log tip>|null, cursor: <entries processed>,
//    heads: <root>|null, index: {<map>: <root>|null, …}}
//
// `format` says what the records the maps reach look like: 1 = every step's
// update carries its `fuel` (issue #5); 2 = log entries are unsigned and
// identity keys, hashes and signatures are byte strings in every record,
// envelopes kept in the encoding they were made in (issue #33). A store with
// a log in an older format is refused for running (sqlite_store.zig).
//
// The state record's CID is the instance's one mutable pointer (the backend
// keeps it under the name "state"); everything else is an immutable block.
// Each query shape the scheduler asks is its own map, keyed so that the
// question is a lookup, a range or a prefix (numbers are 8-byte big-endian
// with the sign bit flipped, so they order as numbers; CIDs are prefix-free
// in binary, so concatenations of them split unambiguously; strings are
// uvarint-length-prefixed):
//
//   log       n                          → entry CID           (log.ts entries by n)
//   unique    message CID                → entry CID           (a message's entry: admitted once, #40; and a
//                                                              libp2p `p2p` event record's: a redelivered
//                                                              GossipSub message is refused, #51/#42)
//   chains    origin                     → {tip, seq, kind?}   (every chain's tip)
//   updates   origin ‖ seq               → update CID          (a chain's history)
//   threads   at ‖ origin                → null                (thread chains, by origin.at)
//   resting   at ‖ origin                → null                (threads not finished: what start resumes)
//   sleepers  until ‖ origin             → null                (threads waiting with a deadline)
//   awaits    record ‖ at ‖ origin       → null                (threads awaiting a reply to a message, or an event's subject)
//   edges     to ‖ from ‖ seq ‖ ord      → [rel, locator?]     (pointers out of chains, by target;
//                                                              an update's own, then its kept records' `refs`;
//                                                              and a kept bitcoin transaction's inputs, from the
//                                                              block at seq 0 (#42, bitcoin.zig): `spends`
//                                                              (locator = vout); headers and merkle nodes: none)
//   heads     name                       → tree CID            (named heads)
//
// Every map is a function of the chains and the log (the derivation is
// sqlite.ts's, key for key), and the trees are canonical, so the state
// record is a function of the log: two runtimes that consumed the same log
// have the same state CID, and a store rebuilt from its blocks and log has
// the same roots as the one kept up to date entry by entry.
//
// Writes go to a working state in memory; nodes are written, and the state
// record with them, at commit points: after each log append (the log maps
// only — the entry is durable before the provider hears back) and after each
// entry is processed (everything, with the cursor). A crash in between loses
// only the unprocessed entry's derived changes, which reprocessing makes
// again.
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const mst = @import("mst.zig");
const storem = @import("store.zig");
const bitcoin = @import("bitcoin.zig");
const Value = cbor.Value;

/// What the index needs of a store: blocks by CID, and one named pointer.
pub const Backend = struct {
    ctx: *anyopaque,
    vt: *const VT,

    pub const VT = struct {
        get: *const fn (ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8,
        has: *const fn (ctx: *anyopaque, cid: []const u8) anyerror!bool,
        put: *const fn (ctx: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void,
        begin: *const fn (ctx: *anyopaque) anyerror!void,
        commit: *const fn (ctx: *anyopaque) anyerror!void,
        rollback: *const fn (ctx: *anyopaque) void,
        pointer: *const fn (ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8,
        setPointer: *const fn (ctx: *anyopaque, name: []const u8, cid: []const u8) anyerror!void,
    };
};

pub const Map = enum(u8) { log, unique, chains, updates, threads, resting, sleepers, awaits, edges, heads };
const map_count = @typeInfo(Map).@"enum".fields.len;

pub const STATE_KIND = "skein-state";
/// The store format this kernel writes (see the header): 2 = unsigned entries, keys as bytes (#33);
/// 3 = messages as `mail` records, no envelopes, emits or outcomes (#40);
/// 4 = recorded `http`/`libp2p` calls carry the host's attestation, the genesis its `attest` key (#62);
/// 5 = every package a transport carries in is a `request` entry, the middleware stepped on it; sessions
/// are records (head `sessions`); a message or event a middleware routes is unique by the `unique` map (#68);
/// 6 = one outbound primitive, `emit` (#70, #67): a step's update lists the signed messages it emitted
/// (`emitted`), no recorded `http`/`libp2p` calls and no attestations; the oracle's answers are `oracle`
/// records; the address book (head `peers`) names each recipient's transport; the genesis names no `attest` key.
pub const FORMAT: i64 = 6;
pub const POINTER = "state";

/// A CID held by value (roots outlive the forest's arena).
pub const Root = struct {
    buf: [64]u8 = undefined,
    len: u8 = 0,

    fn of(c: ?[]const u8) Root {
        var r = Root{};
        if (c) |x| {
            @memcpy(r.buf[0..x.len], x);
            r.len = @intCast(x.len);
        }
        return r;
    }
    pub fn get(r: *const Root) ?[]const u8 {
        return if (r.len == 0) null else r.buf[0..r.len];
    }
};

pub const State = struct {
    roots: [map_count]Root = [_]Root{.{}} ** map_count,
    tip: Root = .{},
    cursor: i64 = 0,
    format: i64 = FORMAT,
};

pub const Stats = struct { commits: usize, nodes: usize, node_bytes: usize, states: usize };

pub const Index = struct {
    gpa: std.mem.Allocator,
    backend: Backend,
    forest: mst.Forest,
    read_only: bool,
    work: State = .{},
    committed: State = .{},
    has_state: bool = false,
    /// The format of the state record the store held when opened: 0 = before fuel,
    /// or no state record (an older file's tables, imported).
    loaded_format: i64 = 0,
    commits: usize = 0,
    states: usize = 0,

    pub fn init(gpa: std.mem.Allocator, backend: Backend, read_only: bool) !*Index {
        const ix = try gpa.create(Index);
        ix.* = .{
            .gpa = gpa,
            .backend = backend,
            .forest = mst.Forest.init(gpa, .{ .ctx = ix, .get = blockGet }),
            .read_only = read_only,
        };
        return ix;
    }

    pub fn deinit(ix: *Index) void {
        ix.forest.deinit();
        ix.gpa.destroy(ix);
    }

    fn blockGet(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const ix: *Index = @ptrCast(@alignCast(ctx));
        return ix.backend.vt.get(ix.backend.ctx, a, cid);
    }

    fn root(ix: *Index, m: Map) ?[]const u8 {
        return ix.work.roots[@intFromEnum(m)].get();
    }
    fn setRoot(ix: *Index, m: Map, r: ?[]const u8) void {
        ix.work.roots[@intFromEnum(m)] = Root.of(r);
    }

    pub fn stats(ix: *Index) Stats {
        return .{ .commits = ix.commits, .nodes = ix.forest.flushed_nodes, .node_bytes = ix.forest.flushed_bytes, .states = ix.states };
    }

    // ------------------------------------------------------------ the state record

    /// Load the state the pointer names; false if there is none.
    pub fn load(ix: *Index) !bool {
        var arena = std.heap.ArenaAllocator.init(ix.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const c = (try ix.backend.vt.pointer(ix.backend.ctx, a, POINTER)) orelse return false;
        const bytes = (try ix.backend.vt.get(ix.backend.ctx, a, c)) orelse return error.MissingState;
        const v = try cbor.decode(a, bytes);
        if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", STATE_KIND)) return error.BadState;
        var s = State{};
        s.tip = Root.of(Value.cidOf(v.get("log")));
        s.cursor = @intCast(Value.intOf(v.get("cursor")) orelse 0);
        s.format = @intCast(Value.intOf(v.get("format")) orelse 0);
        const idx = v.get("index") orelse return error.BadState;
        inline for (@typeInfo(Map).@"enum".fields) |fld| {
            const m: Map = @enumFromInt(fld.value);
            const r = if (m == .heads) v.get("heads") else idx.get(fld.name);
            s.roots[fld.value] = Root.of(Value.cidOf(r));
        }
        ix.loaded_format = s.format;
        ix.committed = s;
        if (!ix.read_only) s.format = FORMAT; // written in this kernel's format from here on
        ix.work = s;
        ix.has_state = true;
        return true;
    }

    fn stateValue(a: std.mem.Allocator, s: *const State) !Value {
        var idx = cbor.MapBuilder.init(a);
        inline for (@typeInfo(Map).@"enum".fields) |fld| {
            if (fld.value != @intFromEnum(Map.heads)) try idx.put(fld.name, link(s.roots[fld.value].get()));
        }
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string(STATE_KIND));
        try m.put("format", cbor.int(s.format));
        try m.put("log", link(s.tip.get()));
        try m.put("cursor", cbor.int(s.cursor));
        try m.put("heads", link(s.roots[@intFromEnum(Map.heads)].get()));
        try m.put("index", idx.value());
        return m.value();
    }

    fn link(c: ?[]const u8) Value {
        return if (c) |x| .{ .cid = x } else .null;
    }

    /// The state record the working state would be, and its CID.
    pub fn stateCid(ix: *Index, a: std.mem.Allocator) ![]u8 {
        return cbor.cidOfValue(a, try stateValue(a, &ix.work));
    }

    fn sinkPut(ctx: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
        const ix: *Index = @ptrCast(@alignCast(ctx));
        return ix.backend.vt.put(ix.backend.ctx, cid, bytes);
    }

    fn writeState(ix: *Index, s: *const State, maps: []const Map) !void {
        var arena = std.heap.ArenaAllocator.init(ix.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const blk = try cbor.block(a, try stateValue(a, s));
        const b = ix.backend;
        try b.vt.begin(b.ctx);
        errdefer b.vt.rollback(b.ctx);
        const sink = mst.Forest.Sink{ .ctx = ix, .put = sinkPut };
        for (maps) |m| try ix.forest.flush(s.roots[@intFromEnum(m)].get(), sink);
        try b.vt.put(b.ctx, blk.cid, blk.bytes);
        try b.vt.setPointer(b.ctx, POINTER, blk.cid);
        try b.vt.commit(b.ctx);
        ix.commits += 1;
        ix.states += 1;
        ix.has_state = true;
    }

    fn same(x: *const State, y: *const State) bool {
        if (x.cursor != y.cursor or x.format != y.format or !optEq(x.tip.get(), y.tip.get())) return false;
        for (x.roots, y.roots) |p, q| if (!optEq(p.get(), q.get())) return false;
        return true;
    }

    /// Write every map's new nodes and the state record; the pointer moves to it.
    pub fn commitAll(ix: *Index) !void {
        if (ix.read_only) return;
        if (!(ix.has_state and same(&ix.work, &ix.committed))) {
            const every = comptime blk: {
                var ms: [map_count]Map = undefined;
                for (&ms, 0..) |*m, i| m.* = @enumFromInt(i);
                break :blk ms;
            };
            try ix.writeState(&ix.work, &every);
            ix.committed = ix.work;
        }
        ix.forest.reset(true);
    }

    /// After a log append: the log maps' nodes and a state record with them,
    /// the other maps as last committed (their changes belong to an entry
    /// still being processed).
    fn commitLog(ix: *Index) !void {
        if (ix.read_only) return;
        var s = ix.committed;
        s.tip = ix.work.tip;
        s.format = ix.work.format;
        s.roots[@intFromEnum(Map.log)] = ix.work.roots[@intFromEnum(Map.log)];
        s.roots[@intFromEnum(Map.unique)] = ix.work.roots[@intFromEnum(Map.unique)];
        try ix.writeState(&s, &.{ .log, .unique });
        ix.committed = s;
    }

    // ------------------------------------------------------------ keys

    fn be64(out: *std.array_list.Managed(u8), n: i64) !void {
        var b: [8]u8 = undefined;
        std.mem.writeInt(u64, &b, @as(u64, @bitCast(n)) ^ (1 << 63), .big);
        try out.appendSlice(&b);
    }

    fn strKey(out: *std.array_list.Managed(u8), s: []const u8) !void {
        var v: u64 = s.len;
        while (v >= 0x80) : (v >>= 7) try out.append(@as(u8, @truncate(v)) | 0x80);
        try out.append(@truncate(v));
        try out.appendSlice(s);
    }

    /// A number as SQLite would hold it for ordering: ints as is, floats floored, else the least.
    fn numOf(v: ?Value) i64 {
        const x = v orelse return std.math.minInt(i64);
        return switch (x) {
            .int => |i| @intCast(std.math.clamp(i, std.math.minInt(i64), std.math.maxInt(i64))),
            .float => |f| @intFromFloat(@floor(std.math.clamp(f, -9.2e18, 9.2e18))),
            else => std.math.minInt(i64),
        };
    }

    fn cat(a: std.mem.Allocator, parts: anytype) ![]u8 {
        var out = std.array_list.Managed(u8).init(a);
        inline for (parts) |p| {
            switch (@TypeOf(p)) {
                i64 => try be64(&out, p),
                else => try out.appendSlice(p),
            }
        }
        return out.items;
    }

    // ------------------------------------------------------------ map helpers

    fn mapGet(ix: *Index, a: std.mem.Allocator, m: Map, key: []const u8) !?Value {
        return ix.forest.get(a, ix.root(m), key);
    }
    fn mapPut(ix: *Index, m: Map, key: []const u8, v: Value) !void {
        ix.setRoot(m, try ix.forest.put(ix.root(m), key, v));
    }
    fn mapDel(ix: *Index, m: Map, key: []const u8) !void {
        ix.setRoot(m, try ix.forest.delete(ix.root(m), key));
    }
    fn scan(ix: *Index, a: std.mem.Allocator, m: Map, lo: ?[]const u8, hi: ?[]const u8) ![]mst.KV {
        var out = std.array_list.Managed(mst.KV).init(a);
        try ix.forest.range(a, ix.root(m), lo, hi, &out);
        return out.items;
    }
    fn scanPrefix(ix: *Index, a: std.mem.Allocator, m: Map, prefix: []const u8) ![]mst.KV {
        var out = std.array_list.Managed(mst.KV).init(a);
        try ix.forest.prefixed(a, ix.root(m), prefix, &out);
        return out.items;
    }

    fn blockValue(ix: *Index, a: std.mem.Allocator, c: []const u8) !Value {
        const b = (try ix.backend.vt.get(ix.backend.ctx, a, c)) orelse return error.NotFound;
        return cbor.decode(a, b);
    }

    fn putValue(ix: *Index, a: std.mem.Allocator, v: Value) ![]u8 {
        const blk = try cbor.block(a, v);
        try ix.backend.vt.put(ix.backend.ctx, blk.cid, blk.bytes);
        return blk.cid;
    }

    // ------------------------------------------------------------ derivation (sqlite.ts)

    const EdgeRow = struct { to: []const u8, rel: []const u8, locator: ?Value };

    fn edge(a: std.mem.Allocator, out: *std.array_list.Managed(EdgeRow), to: ?Value, rel: []const u8, locator: ?Value) !void {
        const t = to orelse return;
        const loc: ?Value = if (locator) |l| (if (l == .string) l else null) else null;
        switch (t) {
            .cid => |c| try out.append(.{ .to = try cidm.format(a, c), .rel = rel, .locator = loc }),
            .string => |x| try out.append(.{ .to = x, .rel = rel, .locator = loc }),
            else => {},
        }
    }

    fn originEdges(a: std.mem.Allocator, b: Value) ![]EdgeRow {
        var out = std.array_list.Managed(EdgeRow).init(a);
        if (b.get("refs")) |refs| if (refs == .array) {
            for (refs.array) |r| {
                if (r != .map) continue;
                const rel = Value.str(r.get("rel")) orelse continue;
                try edge(a, &out, r.get("to"), rel, r.get("locator"));
            }
        };
        try edge(a, &out, b.get("launchedBy"), "launched-by", null);
        return out.items;
    }

    fn updateEdges(a: std.mem.Allocator, u: Value) ![]EdgeRow {
        var out = std.array_list.Managed(EdgeRow).init(a);
        const rest: ?Value = if (u.get("rest")) |r| (if (r == .map) r else null) else null;
        const ws = [_]?Value{ u.get("waitingOn"), if (rest) |r| r.get("waitingOn") else null };
        for (ws) |w| if (w) |x| if (x == .array) {
            for (x.array) |t| try edge(a, &out, t, "depends-on", null);
        };
        try edge(a, &out, u.get("resolution"), "resolves", null);
        if (u.get("emit")) |e| if (e == .map) {
            if (Value.str(e.get("type"))) |ty| if (std.mem.eql(u8, ty, "launched")) try edge(a, &out, e.get("thread"), "launched", null);
        };
        return out.items;
    }

    /// The update's edges, then those its kept records declare: a kept record
    /// with `refs: [{to, rel, locator?}]` (the shape an origin's refs have)
    /// gives an edge from the thread at this seq with the record's own `rel`
    /// — how a program says what a record it keeps stands on (#37: `spends`,
    /// `admits`, `derives-from` propagate a rejection; `mentions` does not).
    /// A kept block that is not a dag-cbor map (a transaction, a tree) has none.
    fn updateEdgesWithKept(ix: *Index, a: std.mem.Allocator, u: Value) ![]EdgeRow {
        var out = std.array_list.Managed(EdgeRow).init(a);
        try out.appendSlice(try updateEdges(a, u));
        const kept = u.get("kept") orelse return out.items;
        if (kept != .array) return out.items;
        for (kept.array) |k| {
            const c = Value.cidOf(k) orelse continue;
            const bytes = (try ix.backend.vt.get(ix.backend.ctx, a, c)) orelse continue;
            const r = cbor.decode(a, bytes) catch continue;
            if (r != .map) continue;
            const refs = r.get("refs") orelse continue;
            if (refs != .array) continue;
            for (refs.array) |x| {
                if (x != .map) continue;
                const rel = Value.str(x.get("rel")) orelse continue;
                try edge(a, &out, x.get("to"), rel, x.get("locator"));
            }
        }
        return out.items;
    }

    fn writeEdges(ix: *Index, a: std.mem.Allocator, from: []const u8, seq: i64, edges: []const EdgeRow) !void {
        for (edges, 0..) |e, i| {
            var k = std.array_list.Managed(u8).init(a);
            try strKey(&k, e.to);
            try k.appendSlice(from);
            try be64(&k, seq);
            try be64(&k, @intCast(i));
            // INSERT OR IGNORE: the first row at (from, seq, ord) stays.
            if (try ix.mapGet(a, .edges, k.items) != null) continue;
            const v = try a.alloc(Value, 2);
            v[0] = cbor.string(e.rel);
            v[1] = e.locator orelse .null;
            try ix.mapPut(.edges, k.items, .{ .array = v });
        }
    }

    /// The edges of a kept bitcoin block (#42, bitcoin.zig `edgesOf`: a
    /// transaction's inputs only) as edge rows: from the block itself at seq 0
    /// (like an origin's own), so a block kept again, by any thread, adds
    /// nothing. A header, a merkle node, not a bitcoin block, or malformed: none.
    pub fn bitcoinEdges(a: std.mem.Allocator, c: []const u8, bytes: []const u8) ![]EdgeRow {
        const ls = try bitcoin.edgesOf(a, c, bytes);
        const out = try a.alloc(EdgeRow, ls.len);
        for (ls, out) |l, *r| r.* = .{
            .to = try cidm.format(a, l.to),
            .rel = l.rel,
            .locator = if (l.locator) |n| cbor.int(n) else null,
        };
        return out;
    }

    /// The edges of the bitcoin blocks an update keeps (`kept`).
    fn writeKeptBitcoin(ix: *Index, a: std.mem.Allocator, u: Value) !void {
        const kept = u.get("kept") orelse return;
        if (kept != .array) return;
        for (kept.array) |k| {
            const c = Value.cidOf(k) orelse continue;
            if (!bitcoin.isBitcoin(c)) continue;
            const bytes = (try ix.backend.vt.get(ix.backend.ctx, a, c)) orelse continue;
            try ix.writeEdges(a, c, 0, try bitcoinEdges(a, c, bytes));
        }
    }

    /// The length of the binary CID at the front of `b` (binary CIDs are prefix-free).
    fn cidLen(b: []const u8) ?usize {
        if (b.len >= 34 and b[0] == 0x12 and b[1] == 0x20) return 34;
        var pos: usize = 0;
        for (0..3) |_| _ = cidm.readUvarint(b, &pos) catch return null;
        const n = cidm.readUvarint(b, &pos) catch return null;
        if (n > b.len - pos) return null;
        return pos + @as(usize, @intCast(n));
    }

    /// The edges into `to` (binary), `rel` only if given, in key order.
    pub fn edgesTo(ix: *Index, a: std.mem.Allocator, to: []const u8, rel: ?[]const u8) ![]storem.Edge {
        const s = ix.scratch();
        var prefix = std.array_list.Managed(u8).init(s);
        try strKey(&prefix, try cidm.format(s, to));
        var out = std.array_list.Managed(storem.Edge).init(a);
        for (try ix.scanPrefix(s, .edges, prefix.items)) |kv| {
            const rest = kv.key[prefix.items.len..];
            const n = cidLen(rest) orelse return error.BadIndex;
            if (rest.len != n + 16 or kv.value != .array or kv.value.array.len != 2) return error.BadIndex;
            const r = Value.str(kv.value.array[0]) orelse return error.BadIndex;
            if (rel) |want| if (!std.mem.eql(u8, want, r)) continue;
            const loc = kv.value.array[1];
            try out.append(.{
                .from = try a.dupe(u8, rest[0..n]),
                .seq = readBe64(rest[n..][0..8]),
                .ord = readBe64(rest[n + 8 ..][0..8]),
                .rel = try a.dupe(u8, r),
                .locator = switch (loc) {
                    .null => null,
                    .int => loc,
                    .string => |x| .{ .string = try a.dupe(u8, x) },
                    else => return error.BadIndex,
                },
            });
        }
        return out.items;
    }

    fn readBe64(b: *const [8]u8) i64 {
        return @bitCast(std.mem.readInt(u64, b, .big) ^ (1 << 63));
    }

    fn isKind(v: Value, k: []const u8) bool {
        return std.mem.eql(u8, Value.str(v.get("kind")) orelse return false, k);
    }

    /// The keys a thread holds in resting/sleepers/awaits, given its origin and tip (null: no updates).
    const ThreadKeys = struct { resting: ?[]u8, sleeper: ?[]u8, awaits: [][]u8 };

    fn threadKeys(a: std.mem.Allocator, origin: []const u8, o: Value, t: ?Value) !ThreadKeys {
        const at = numOf(o.get("at"));
        const state: ?[]const u8 = if (t) |x| Value.str(x.get("state")) else null;
        const finished = state != null and std.mem.eql(u8, state.?, "finished");
        var keys = ThreadKeys{ .resting = null, .sleeper = null, .awaits = &.{} };
        if (!finished) keys.resting = try cat(a, .{ at, origin });
        if (t) |x| {
            if (state != null and std.mem.eql(u8, state.?, "waiting")) {
                if (x.get("until")) |u| if (u == .int or u == .float) {
                    keys.sleeper = try cat(a, .{ numOf(u), origin });
                };
            }
            if (x.get("awaits")) |aw| if (aw == .array) {
                var list = std.array_list.Managed([]u8).init(a);
                for (aw.array) |c| if (c == .cid) try list.append(try cat(a, .{ c.cid, at, origin }));
                keys.awaits = list.items;
            };
        }
        return keys;
    }

    fn optEq(x: ?[]const u8, y: ?[]const u8) bool {
        if (x == null or y == null) return x == null and y == null;
        return std.mem.eql(u8, x.?, y.?);
    }

    fn inList(list: []const []u8, k: []const u8) bool {
        for (list) |x| if (std.mem.eql(u8, x, k)) return true;
        return false;
    }

    /// A thread's keys from its tip `old` to its tip `new` (null: the origin);
    /// `fresh`: it held none before (registered just now).
    fn moveThread(ix: *Index, a: std.mem.Allocator, origin: []const u8, o: Value, fresh: bool, old: ?Value, new: ?Value) !void {
        const was: ThreadKeys = if (fresh) .{ .resting = null, .sleeper = null, .awaits = &.{} } else try threadKeys(a, origin, o, old);
        const now = try threadKeys(a, origin, o, new);
        if (!optEq(was.resting, now.resting)) {
            if (was.resting) |k| try ix.mapDel(.resting, k);
            if (now.resting) |k| try ix.mapPut(.resting, k, .null);
        }
        if (!optEq(was.sleeper, now.sleeper)) {
            if (was.sleeper) |k| try ix.mapDel(.sleepers, k);
            if (now.sleeper) |k| try ix.mapPut(.sleepers, k, .null);
        }
        for (was.awaits) |k| if (!inList(now.awaits, k)) try ix.mapDel(.awaits, k);
        for (now.awaits) |k| if (!inList(was.awaits, k)) try ix.mapPut(.awaits, k, .null);
    }

    fn headKey(a: std.mem.Allocator, name: []const u8) ![]u8 {
        var k = std.array_list.Managed(u8).init(a);
        try strKey(&k, name);
        return k.items;
    }

    fn moveHead(ix: *Index, a: std.mem.Allocator, o: Value, tip: Value) !void {
        const name = Value.str(o.get("name")) orelse return;
        const k = try headKey(a, name);
        if (Value.cidOf(tip.get("tree"))) |t| try ix.mapPut(.heads, k, .{ .cid = t }) else try ix.mapDel(.heads, k);
    }

    fn chainValue(a: std.mem.Allocator, tip: []const u8, seq: i64, kind: ?[]const u8) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("tip", .{ .cid = tip });
        try m.put("seq", cbor.int(seq));
        try m.put("kind", cbor.optStr(kind));
        return m.value();
    }

    /// register(): the chain at its origin, its origin's edges. false if already there.
    fn register(ix: *Index, a: std.mem.Allocator, cid: []const u8, o: Value) !bool {
        if (try ix.mapGet(a, .chains, cid) != null) return false;
        try ix.mapPut(.chains, cid, try chainValue(a, cid, 0, Value.str(o.get("kind"))));
        try ix.writeEdges(a, cid, 0, try originEdges(a, o));
        if (isKind(o, "thread")) {
            try ix.mapPut(.threads, try cat(a, .{ numOf(o.get("at")), cid }), .null);
            try ix.moveThread(a, cid, o, true, null, null);
        }
        return true;
    }

    /// One update of a chain, recorded (not yet the tip).
    fn recordUpdate(ix: *Index, a: std.mem.Allocator, origin: []const u8, seq: i64, cid: []const u8, u: Value) !void {
        try ix.mapPut(.updates, try cat(a, .{ origin, seq }), .{ .cid = cid });
        try ix.writeEdges(a, origin, seq, try ix.updateEdgesWithKept(a, u));
        try ix.writeKeptBitcoin(a, u);
    }

    /// move(): the chain's tip is now `tip` (at `seq`); the maps that follow tips follow.
    fn move(ix: *Index, a: std.mem.Allocator, origin: []const u8, o: Value, old_tip: []const u8, tip: []const u8, seq: i64) !void {
        const kind = Value.str(o.get("kind"));
        try ix.mapPut(.chains, origin, try chainValue(a, tip, seq, kind));
        if (std.mem.eql(u8, old_tip, tip)) return;
        const t = try ix.blockValue(a, tip);
        if (isKind(o, "thread")) {
            const old: ?Value = if (std.mem.eql(u8, old_tip, origin)) null else try ix.blockValue(a, old_tip);
            try ix.moveThread(a, origin, o, false, old, t);
        } else if (isKind(o, "head")) try ix.moveHead(a, o, t);
    }

    // ------------------------------------------------------------ rebuild

    /// A chain as a store without the state record holds it: its origin, its
    /// updates in seq order, its tip. The maps come out as the incremental path
    /// makes them (the trees are canonical).
    pub fn importChain(ix: *Index, origin: []const u8, updates: []const []const u8, tip: []const u8, seq: i64) !void {
        const a = ix.forest.arena.allocator();
        const o = try ix.blockValue(a, origin);
        _ = try ix.register(a, origin, o);
        for (updates, 1..) |u, i| try ix.recordUpdate(a, origin, @intCast(i), u, try ix.blockValue(a, u));
        try ix.move(a, origin, o, origin, tip, seq);
    }

    /// A log entry at n (and the record it is unique by, if any).
    pub fn importEntry(ix: *Index, n: i64, cid: []const u8, uniq: ?[]const u8) !void {
        const a = ix.forest.arena.allocator();
        try ix.mapPut(.log, try cat(a, .{n}), .{ .cid = cid });
        if (uniq) |u| try ix.mapPut(.unique, u, .{ .cid = cid });
        ix.work.tip = Root.of(cid);
    }

    pub fn setCursor(ix: *Index, n: i64) void {
        ix.work.cursor = n;
    }

    // ------------------------------------------------------------ the Store

    pub fn store(ix: *Index) storem.Store {
        return .{ .ctx = ix, .vt = &vtable };
    }

    const vtable = storem.VTable{
        .bytes = bytesFn,
        .has = hasFn,
        .putBlock = putBlockFn,
        .chainOpen = chainOpenFn,
        .chainAppend = chainAppendFn,
        .chainTip = chainTipFn,
        .chainUpdates = chainUpdatesFn,
        .logAppend = logAppendFn,
        .logTip = logTipFn,
        .logFrom = logFromFn,
        .logByUnique = logByUniqueFn,
        .markUnique = markUniqueFn,
        .resting = restingFn,
        .awaiting = awaitingFn,
        .threads = threadsFn,
        .headTree = headTreeFn,
        .cursorGet = cursorGetFn,
        .cursorSet = cursorSetFn,
        .commit = commitFn,
        .state = stateFn,
        .edges = edgesFn,
    };

    fn edgesFn(ctx: *anyopaque, a: std.mem.Allocator, to: []const u8, rel: ?[]const u8) anyerror![]storem.Edge {
        return self(ctx).edgesTo(a, to, rel);
    }

    fn stateFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror!?[]u8 {
        const ix = self(ctx);
        return ix.backend.vt.pointer(ix.backend.ctx, a, POINTER);
    }

    fn self(ctx: *anyopaque) *Index {
        return @ptrCast(@alignCast(ctx));
    }

    /// Scratch for one operation (reset with the forest at the next commitAll).
    fn scratch(ix: *Index) std.mem.Allocator {
        return ix.forest.arena.allocator();
    }

    fn bytesFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const ix = self(ctx);
        return ix.backend.vt.get(ix.backend.ctx, a, cid);
    }
    fn hasFn(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        const ix = self(ctx);
        return ix.backend.vt.has(ix.backend.ctx, cid);
    }
    fn putBlockFn(ctx: *anyopaque, cid: []const u8, b: []const u8) anyerror!void {
        const ix = self(ctx);
        return ix.backend.vt.put(ix.backend.ctx, cid, b);
    }

    fn chainOpenFn(ctx: *anyopaque, a: std.mem.Allocator, origin: Value) anyerror![]u8 {
        const ix = self(ctx);
        const cid = try ix.putValue(a, origin);
        _ = try ix.register(ix.scratch(), cid, origin);
        return cid;
    }

    fn chainAppendFn(ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8, body: Value) anyerror![]u8 {
        const ix = self(ctx);
        const s = ix.scratch();
        const row = (try ix.mapGet(s, .chains, origin)) orelse return error.NotFound;
        const tip = Value.cidOf(row.get("tip")).?;
        const seq: i64 = @intCast((Value.intOf(row.get("seq")) orelse 0) + 1);
        if (!Value.isNumber(body.get("at"))) return error.NoAt;
        var m = cbor.MapBuilder.init(a);
        for (body.map) |e| try m.put(e.key, e.value);
        try m.put("origin", .{ .cid = origin });
        try m.put("prev", .{ .cid = tip });
        try m.put("seq", .{ .int = seq });
        const update = m.value();
        const cid = try ix.putValue(a, update);
        try ix.recordUpdate(s, origin, seq, cid, update);
        try ix.move(s, origin, try ix.blockValue(s, origin), tip, cid, seq);
        return cid;
    }

    fn chainTipFn(ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8) anyerror!?[]u8 {
        const ix = self(ctx);
        const row = (try ix.mapGet(ix.scratch(), .chains, origin)) orelse return null;
        return try a.dupe(u8, Value.cidOf(row.get("tip")).?);
    }

    fn chainUpdatesFn(ctx: *anyopaque, a: std.mem.Allocator, origin: []const u8) anyerror!?[][]u8 {
        const ix = self(ctx);
        if ((try ix.mapGet(ix.scratch(), .chains, origin)) == null) return null;
        const kvs = try ix.scanPrefix(ix.scratch(), .updates, origin);
        const out = try a.alloc([]u8, kvs.len);
        for (kvs, out) |kv, *o| o.* = try a.dupe(u8, kv.value.cid);
        return out;
    }

    /// The record an entry is unique by: its mail record (#40), or a libp2p
    /// `p2p` event record (#51, #42 decided 2026-09-30: the record is
    /// content-addressed — topic, from, seqno, signature, body — so a
    /// redelivered GossipSub message is the same record). Other events
    /// (feeds: a header, a status) may recur, and are not unique; so may a
    /// request (#68: every package is appended as received — what a
    /// middleware routes out of one is marked unique then, markUnique).
    fn uniqueOf(ix: *Index, a: std.mem.Allocator, entry: Value) !?[]const u8 {
        if (Value.cidOf(entry.get("mail"))) |m| return m;
        const ev = Value.cidOf(entry.get("event")) orelse return null;
        const b = (try ix.backend.vt.get(ix.backend.ctx, a, ev)) orelse return null;
        const rec = cbor.decode(a, b) catch return null;
        const kind = Value.str(rec.get("kind")) orelse return null;
        return if (std.mem.eql(u8, kind, "p2p")) ev else null;
    }

    fn logAppendFn(ctx: *anyopaque, a: std.mem.Allocator, entry: Value) anyerror!storem.AppendResult {
        const ix = self(ctx);
        // A message is admitted once (#40: its record's CID is its id; a replayed request is the same
        // record), and so is a libp2p message (its `p2p` event record): refused here, nothing written.
        const mail = try ix.uniqueOf(a, entry);
        if (mail) |e| if (try logByUniqueFn(ctx, a, e) != null) {
            const what = if (entry.get("mail") != null) "message" else "libp2p message";
            return .{ .rejected = .{ .reason = .duplicate_envelope, .message = try std.fmt.allocPrint(a, "log: {s} {s} is already admitted", .{ what, try cidm.format(a, e) }) } };
        };
        const n = Value.intOf(entry.get("n")) orelse -1;
        var ok_prev: bool = undefined;
        var ok_n: bool = undefined;
        var ok_time = true;
        const prev = entry.get("prev");
        if (ix.work.tip.get()) |t| {
            ok_prev = prev != null and prev.? == .cid and std.mem.eql(u8, prev.?.cid, t);
            const tip = try ix.blockValue(a, t);
            ok_n = n == (Value.intOf(tip.get("n")) orelse -2) + 1;
            ok_time = stampNs(entry.get("time")) >= stampNs(tip.get("time"));
        } else {
            ok_prev = prev != null and prev.? == .null;
            ok_n = n == 0;
        }
        if (!ok_prev or !ok_n or !ok_time) {
            return .{ .rejected = .{ .reason = .out_of_order, .message = try std.fmt.allocPrint(a, "log: entry #{d} does not extend the tip{s}", .{ n, if (ok_time) "" else " (stamped before it)" }) } };
        }
        const cid = try ix.putValue(a, entry);
        try ix.importEntry(@intCast(n), cid, mail);
        try ix.commitLog();
        return .{ .ok = cid };
    }

    fn stampNs(v: ?Value) i128 {
        const t = v orelse return -1;
        if (t != .array or t.array.len != 2) return -1;
        const sec = Value.intOf(t.array[0]) orelse return -1;
        const ns = Value.intOf(t.array[1]) orelse return -1;
        return sec * 1_000_000_000 + ns;
    }

    fn logTipFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror!?[]u8 {
        const ix = self(ctx);
        return if (ix.work.tip.get()) |t| try a.dupe(u8, t) else null;
    }

    fn logFromFn(ctx: *anyopaque, a: std.mem.Allocator, from: i64) anyerror![][]u8 {
        const ix = self(ctx);
        const kvs = try ix.scan(ix.scratch(), .log, try cat(ix.scratch(), .{from}), null);
        const out = try a.alloc([]u8, kvs.len);
        for (kvs, out) |kv, *o| o.* = try a.dupe(u8, kv.value.cid);
        return out;
    }

    fn logByUniqueFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const ix = self(ctx);
        const v = (try ix.mapGet(ix.scratch(), .unique, cid)) orelse return null;
        return try a.dupe(u8, v.cid);
    }

    /// A record a middleware routed while `entry` was processed (#68: a
    /// message, a libp2p `p2p` event) is admitted once: false if it was
    /// before (by an entry of its own, or routed from another request).
    fn markUniqueFn(ctx: *anyopaque, cid: []const u8, entry: []const u8) anyerror!bool {
        const ix = self(ctx);
        if ((try ix.mapGet(ix.scratch(), .unique, cid)) != null) return false;
        try ix.mapPut(.unique, cid, .{ .cid = entry });
        return true;
    }

    /// The origin at the end of an `… ‖ origin` key.
    fn tailCid(a: std.mem.Allocator, key: []const u8, skip: usize) ![]u8 {
        return a.dupe(u8, key[skip..]);
    }

    fn restingFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror![][]u8 {
        const ix = self(ctx);
        const kvs = try ix.scan(ix.scratch(), .resting, null, null);
        const out = try a.alloc([]u8, kvs.len);
        for (kvs, out) |kv, *o| o.* = try tailCid(a, kv.key, 8);
        return out;
    }

    fn awaitingFn(ctx: *anyopaque, a: std.mem.Allocator, envelope: []const u8) anyerror![][]u8 {
        const ix = self(ctx);
        const kvs = try ix.scanPrefix(ix.scratch(), .awaits, envelope);
        const out = try a.alloc([]u8, kvs.len);
        for (kvs, out) |kv, *o| o.* = try tailCid(a, kv.key, envelope.len + 8);
        return out;
    }

    fn threadsFn(ctx: *anyopaque, a: std.mem.Allocator) anyerror![][]u8 {
        const ix = self(ctx);
        const kvs = try ix.scan(ix.scratch(), .threads, null, null);
        const out = try a.alloc([]u8, kvs.len);
        for (kvs, 0..) |kv, i| out[kvs.len - 1 - i] = try tailCid(a, kv.key, 8); // at DESC, origin DESC
        return out;
    }

    fn headTreeFn(ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const ix = self(ctx);
        const s = ix.scratch();
        const v = (try ix.mapGet(s, .heads, try headKey(s, name))) orelse return null;
        return try a.dupe(u8, v.cid);
    }

    fn cursorGetFn(ctx: *anyopaque) anyerror!i64 {
        return self(ctx).work.cursor;
    }

    fn cursorSetFn(ctx: *anyopaque, n: i64) anyerror!void {
        const ix = self(ctx);
        ix.work.cursor = n;
        try ix.commitAll();
    }

    fn commitFn(ctx: *anyopaque) anyerror!void {
        return self(ctx).commitAll();
    }

    // ------------------------------------------------------------ reading it all (dump)

    pub const Scan = struct { map: Map, kvs: []mst.KV };

    pub fn all(ix: *Index, a: std.mem.Allocator, m: Map) ![]mst.KV {
        return ix.scan(a, m, null, null);
    }
};
