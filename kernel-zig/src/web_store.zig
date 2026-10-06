// The browser build's store backend (issue #35): the key→bytes map and the
// `state` pointer (issue #30) kept by the JS shim — over IndexedDB for an
// instance, in memory for tests (kernel-zig/web/store.js). The index
// (index.zig) is the same as over SQLite; only the backend differs, the way
// sqlite_store.zig is the native one. Transactions are the shim's: begin
// buffers, commit makes the batch durable (write-behind to IndexedDB, in
// order), rollback drops it.
const std = @import("std");
const storem = @import("store.zig");
const index = @import("index.zig");

// The shim's stores (`skein_store`), by id.
const shim = struct {
    /// The block's length, or -1 if absent; its bytes then come from take.
    extern "skein_store" fn get(store: u32, cid: [*]const u8, cid_len: usize) i32;
    extern "skein_store" fn take(ptr: [*]u8) void;
    extern "skein_store" fn has(store: u32, cid: [*]const u8, cid_len: usize) i32;
    /// 1 stored (created), 0 held already; < 0 refused (a read-only store).
    extern "skein_store" fn put(store: u32, cid: [*]const u8, cid_len: usize, bytes: [*]const u8, len: usize) i32;
    extern "skein_store" fn begin(store: u32) void;
    extern "skein_store" fn commit(store: u32) i32;
    extern "skein_store" fn rollback(store: u32) void;
    extern "skein_store" fn pointer_get(store: u32, name: [*]const u8, name_len: usize) i32;
    extern "skein_store" fn pointer_set(store: u32, name: [*]const u8, name_len: usize, cid: [*]const u8, cid_len: usize) i32;
};

pub const WebStore = struct {
    id: u32,
    alloc: std.mem.Allocator,
    ix: *index.Index,
    read_only: bool,

    /// The shim's store `id`, its index loaded from the state pointer if there is one.
    pub fn open(alloc: std.mem.Allocator, id: u32, read_only: bool) !*WebStore {
        const s = try alloc.create(WebStore);
        errdefer alloc.destroy(s);
        s.* = .{ .id = id, .alloc = alloc, .ix = undefined, .read_only = read_only };
        s.ix = try index.Index.init(alloc, s.backend(), read_only);
        _ = try s.ix.load();
        return s;
    }

    /// Holds a log in an older format than this kernel's (sqlite_store.zig predatesFuel).
    pub fn predatesFuel(s: *WebStore) bool {
        return s.ix.loaded_format < index.FORMAT and s.ix.work.tip.get() != null;
    }

    pub fn close(s: *WebStore) void {
        if (!s.read_only) s.ix.commitAll() catch {};
        s.ix.deinit();
        s.alloc.destroy(s);
    }

    pub fn store(s: *WebStore) storem.Store {
        return s.ix.store();
    }

    fn backend(s: *WebStore) index.Backend {
        return .{ .ctx = s, .vt = &vt };
    }

    const vt = index.Backend.VT{
        .get = getFn,
        .has = hasFn,
        .put = putFn,
        .begin = beginFn,
        .commit = commitFn,
        .rollback = rollbackFn,
        .pointer = pointerFn,
        .setPointer = setPointerFn,
    };

    fn self(ctx: *anyopaque) *WebStore {
        return @ptrCast(@alignCast(ctx));
    }

    fn getFn(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const n = shim.get(self(ctx).id, cid.ptr, cid.len);
        if (n < 0) return null;
        const b = try a.alloc(u8, @intCast(n));
        shim.take(b.ptr);
        return b;
    }

    fn hasFn(ctx: *anyopaque, cid: []const u8) anyerror!bool {
        return shim.has(self(ctx).id, cid.ptr, cid.len) != 0;
    }

    fn putFn(ctx: *anyopaque, cid: []const u8, b: []const u8) anyerror!bool {
        if (self(ctx).read_only) return error.ReadOnly;
        const r = shim.put(self(ctx).id, cid.ptr, cid.len, b.ptr, b.len);
        if (r < 0) return error.Store;
        return r > 0;
    }

    fn beginFn(ctx: *anyopaque) anyerror!void {
        shim.begin(self(ctx).id);
    }
    fn commitFn(ctx: *anyopaque) anyerror!void {
        if (shim.commit(self(ctx).id) < 0) return error.Store;
    }
    fn rollbackFn(ctx: *anyopaque) void {
        shim.rollback(self(ctx).id);
    }

    fn pointerFn(ctx: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const n = shim.pointer_get(self(ctx).id, name.ptr, name.len);
        if (n < 0) return null;
        const b = try a.alloc(u8, @intCast(n));
        shim.take(b.ptr);
        return b;
    }

    fn setPointerFn(ctx: *anyopaque, name: []const u8, cid: []const u8) anyerror!void {
        if (shim.pointer_set(self(ctx).id, name.ptr, name.len, cid.ptr, cid.len) < 0) return error.Store;
    }
};
