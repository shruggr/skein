// A mutable, copy-on-write view of a git-shaped tree (ported from the
// TypeScript vfs, deleted in #55, and host-go/vfs.go). Nodes load lazily from the store; a node keeps its CID
// until something under it changes, so commit() re-hashes only the changed
// spine. Inode numbers are handed out in load order, as the Node host does.
const std = @import("std");
const tree = @import("tree.zig");
const Store = @import("store.zig").Store;
const objects = @import("objects.zig");

/// `object`: a loose object in a repository's synthetic object directory
/// (`.git/objects/xx/yyyy…`, objects.zig) — a gitlink in the tree, a
/// read-only file of zlib bytes to programs, the git-raw record in the store.
pub const Kind = enum { dir, file, link, module, object };

pub const Node = struct {
    kind: Kind,
    ino: u64,
    parent: ?*Node = null,
    /// The entry name under `parent` ("" for the root).
    name: []const u8 = "",
    cid: ?[]const u8 = null,
    entries: ?*std.StringHashMap(*Node) = null,
    readonly: bool = false,
    exec: bool = false,
    /// file contents or link target; null until loaded. An object's loose
    /// (zlib) bytes, made on first read.
    data: ?[]u8 = null,
    cap: usize = 0,
    /// An object written in this run: the git object, kept until commit
    /// puts it in the store.
    raw: ?[]u8 = null,
};

/// wasi errno values used by the filesystem.
pub const E = struct {
    pub const ACCES: u16 = 2;
    pub const BADF: u16 = 8;
    pub const EXIST: u16 = 20;
    pub const INVAL: u16 = 28;
    pub const IO: u16 = 29;
    pub const ISDIR: u16 = 31;
    pub const LOOP: u16 = 32;
    pub const NAMETOOLONG: u16 = 37;
    pub const NOENT: u16 = 44;
    pub const NOSYS: u16 = 52;
    pub const NOTDIR: u16 = 54;
    pub const NOTEMPTY: u16 = 55;
    pub const NOTSUP: u16 = 58;
    pub const PERM: u16 = 63;
    pub const PIPE: u16 = 64;
    pub const ROFS: u16 = 69;
    pub const SPIPE: u16 = 70;
};

/// An error from the filesystem: a wasi errno for the program, or something
/// that ends the run (a store failure other than a missing record).
pub const FsError = error{ Errno, Fatal, OutOfMemory };

const max_links = 40;

pub const Vfs = struct {
    alloc: std.mem.Allocator,
    /// null: the one run that needs no store (the empty tree).
    store: ?Store,
    root: *Node,
    next_ino: u64 = 1,
    desc_ino: u64 = 1 << 30,
    /// The errno of the last FsError.Errno.
    errno: u16 = 0,
    /// The message of the last FsError.Fatal.
    fatal_msg: []const u8 = "",

    pub fn init(alloc: std.mem.Allocator, store: ?Store, root: []const u8) !*Vfs {
        const v = try alloc.create(Vfs);
        v.* = .{ .alloc = alloc, .store = store, .root = undefined };
        v.root = try v.newNode(.{ .kind = .dir, .ino = 0, .cid = root });
        v.root.ino = v.ino();
        if (store == null) v.root.entries = try v.newMap();
        return v;
    }

    fn ino(v: *Vfs) u64 {
        v.next_ino += 1;
        return v.next_ino - 1;
    }

    pub fn nextDescIno(v: *Vfs) u64 {
        v.desc_ino += 1;
        return v.desc_ino - 1;
    }

    fn newNode(v: *Vfs, n: Node) !*Node {
        const p = try v.alloc.create(Node);
        p.* = n;
        return p;
    }

    fn newMap(v: *Vfs) !*std.StringHashMap(*Node) {
        const m = try v.alloc.create(std.StringHashMap(*Node));
        m.* = std.StringHashMap(*Node).init(v.alloc);
        return m;
    }

    pub fn fail(v: *Vfs, errno: u16) FsError {
        v.errno = errno;
        return error.Errno;
    }

    fn fatal(v: *Vfs, msg: []const u8) FsError {
        v.fatal_msg = msg;
        return error.Fatal;
    }

    pub fn newDir(v: *Vfs, parent: *Node) !*Node {
        return v.newNode(.{ .kind = .dir, .entries = try v.newMap(), .ino = v.ino(), .parent = parent });
    }
    pub fn newFile(v: *Vfs, parent: *Node, data: []const u8, exec: bool) !*Node {
        return v.newNode(.{ .kind = .file, .exec = exec, .data = try v.alloc.dupe(u8, data), .cap = data.len, .ino = v.ino(), .parent = parent });
    }
    pub fn newLink(v: *Vfs, parent: *Node, target: []const u8) !*Node {
        return v.newNode(.{ .kind = .link, .data = try v.alloc.dupe(u8, target), .cap = target.len, .ino = v.ino(), .parent = parent });
    }

    // ------------------------------------------------------------ loading

    fn getObject(v: *Vfs, cid: []const u8) FsError![]u8 {
        const s = v.store orelse return v.fatal("no store");
        const b = s.bytes(v.alloc, cid) catch return v.fatal("store read failed");
        return b orelse v.fail(E.IO); // a record missing from the store (NotFound → EIO)
    }

    pub fn entries(v: *Vfs, d: *Node) FsError!*std.StringHashMap(*Node) {
        if (d.entries) |m| return m;
        const obj = try v.getObject(d.cid.?);
        const es = tree.parseTree(v.alloc, obj) catch return v.fatal("not a git tree");
        const m = try v.newMap();
        const fanout = isFanout(d);
        for (es) |e| {
            const n = try v.newNode(.{
                .kind = switch (e.mode) {
                    .dir => .dir,
                    .link => .link,
                    .module => if (fanout and objects.isLooseName(e.name)) .object else .module,
                    else => .file,
                },
                .exec = e.mode == .exec,
                .cid = e.cid,
                .ino = v.ino(),
                .parent = d,
                .name = e.name,
            });
            try m.put(e.name, n);
        }
        d.entries = m;
        return m;
    }

    /// A file's data or a link's target; an object's loose bytes.
    pub fn content(v: *Vfs, n: *Node) FsError![]u8 {
        if (n.data) |d| return d;
        if (n.kind == .object) {
            const raw = n.raw orelse try v.getObject(n.cid.?);
            n.data = try objects.deflate(v.alloc, raw);
            n.cap = n.data.?.len;
            return n.data.?;
        }
        if (tree.gitDigest(n.cid.?) == null) return v.fatal("not a git object cid");
        const obj = try v.getObject(n.cid.?);
        const body = tree.objectBody(obj, "blob") orelse return v.fatal("not a git blob");
        n.data = @constCast(body);
        n.cap = body.len;
        return n.data.?;
    }

    pub fn dirty(v: *Vfs, n: *Node) void {
        _ = v;
        var x: ?*Node = n;
        while (x) |y| : (x = y.parent) {
            if (y.kind != .module and y.kind != .object) y.cid = null;
        }
    }

    /// File data resized (zero-extended); grows the node's buffer geometrically.
    pub fn setSize(v: *Vfs, n: *Node, len: usize) ![]u8 {
        const data = n.data.?;
        if (len <= n.cap and data.ptr == n.data.?.ptr) {
            const buf = data.ptr[0..n.cap];
            if (len > data.len) @memset(buf[data.len..len], 0);
            n.data = buf[0..len];
        } else {
            const cap = @max(len, @min(len * 2, len + (16 << 20)), 4096);
            const buf = try v.alloc.alloc(u8, cap);
            const keep = @min(len, data.len);
            @memcpy(buf[0..keep], data[0..keep]);
            if (len > keep) @memset(buf[keep..len], 0);
            n.data = buf[0..len];
            n.cap = cap;
        }
        return n.data.?;
    }

    // ------------------------------------------------------------ paths

    pub const Parent = struct { dir: *Node, name: []const u8 };

    pub fn resolve(v: *Vfs, at: *Node, path: []const u8, follow: bool) FsError!*Node {
        return v.resolveHops(at, path, follow, 0);
    }

    fn resolveHops(v: *Vfs, at: *Node, path: []const u8, follow: bool, hops: usize) FsError!*Node {
        const p = try v.resolveParentHops(at, path, hops);
        if (p.name.len == 0 or std.mem.eql(u8, p.name, ".")) return p.dir;
        if (std.mem.eql(u8, p.name, "..")) return p.dir.parent orelse p.dir;
        const n = (try v.entries(p.dir)).get(p.name) orelse return v.fail(E.NOENT);
        if (n.kind == .link and follow) return v.followLink(p.dir, n, hops);
        return n;
    }

    fn followLink(v: *Vfs, dir: *Node, l: *Node, hops: usize) FsError!*Node {
        if (hops >= max_links) return v.fail(E.LOOP);
        const t = try v.content(l);
        return v.resolveHops(if (t.len > 0 and t[0] == '/') v.root else dir, t, true, hops + 1);
    }

    pub fn resolveParent(v: *Vfs, at: *Node, path: []const u8) FsError!Parent {
        return v.resolveParentHops(at, path, 0);
    }

    fn resolveParentHops(v: *Vfs, at: *Node, path: []const u8, hops: usize) FsError!Parent {
        if (std.mem.indexOfScalar(u8, path, 0) != null) return v.fail(E.INVAL);
        var dir = if (path.len > 0 and path[0] == '/') v.root else at;
        var parts = std.array_list.Managed([]const u8).init(v.alloc);
        defer parts.deinit();
        var it = std.mem.splitScalar(u8, path, '/');
        while (it.next()) |x| if (x.len > 0) try parts.append(x);
        const name = if (parts.items.len > 0) parts.pop().? else "";
        for (parts.items) |p| {
            if (std.mem.eql(u8, p, ".")) continue;
            if (std.mem.eql(u8, p, "..")) {
                dir = dir.parent orelse dir;
                continue;
            }
            var n = (try v.entries(dir)).get(p) orelse return v.fail(E.NOENT);
            if (n.kind == .link) n = try v.followLink(dir, n, hops);
            if (n.kind == .module) n = try v.moduleDir(n);
            if (n.kind != .dir) return v.fail(E.NOTDIR);
            dir = n;
        }
        return .{ .dir = dir, .name = name };
    }

    /// A submodule reads as an empty directory that refuses writes.
    pub fn moduleDir(v: *Vfs, m: *Node) !*Node {
        return v.newNode(.{ .kind = .dir, .entries = try v.newMap(), .ino = m.ino, .parent = m.parent, .readonly = true });
    }

    pub fn pathOf(v: *Vfs, n: *Node) ![]u8 {
        var parts = std.array_list.Managed([]const u8).init(v.alloc);
        defer parts.deinit();
        var x = n;
        while (x.parent) |p| {
            var found: ?[]const u8 = null;
            if (p.entries) |m| {
                var it = m.iterator();
                while (it.next()) |kv| if (kv.value_ptr.* == x) {
                    found = kv.key_ptr.*;
                    break;
                };
            }
            const name = found orelse break;
            try parts.insert(0, name);
            x = p;
        }
        var out = std.array_list.Managed(u8).init(v.alloc);
        try out.append('/');
        for (parts.items, 0..) |p, i| {
            if (i > 0) try out.append('/');
            try out.appendSlice(p);
        }
        return out.toOwnedSlice();
    }

    // ------------------------------------------------------------ mutation

    pub fn checkName(v: *Vfs, name: []const u8) FsError!void {
        if (name.len == 0 or std.mem.eql(u8, name, ".") or std.mem.eql(u8, name, "..") or std.mem.indexOfScalar(u8, name, '/') != null) return v.fail(E.INVAL);
        if (name.len > 255) return v.fail(E.NAMETOOLONG);
    }

    pub fn link(v: *Vfs, dir: *Node, name: []const u8, n: *Node) FsError!void {
        try v.checkName(name);
        if (dir.readonly) return v.fail(E.ROFS);
        try v.admit(dir, name, n);
        const m = try v.entries(dir);
        const key = try v.alloc.dupe(u8, name);
        try m.put(key, n);
        n.parent = dir;
        n.name = key;
        v.dirty(dir);
    }

    // ------------------------------------------------------------ the synthetic object directory

    /// A directory `xx` directly inside some `.git/objects`.
    pub fn isFanout(d: *Node) bool {
        const p = d.parent orelse return false;
        const g = p.parent orelse return false;
        return d.kind == .dir and objects.isFanoutName(d.name, p.name, g.name);
    }

    /// `.git/objects/pack`.
    pub fn isPackDir(d: *Node) bool {
        const p = d.parent orelse return false;
        const g = p.parent orelse return false;
        return d.kind == .dir and std.mem.eql(u8, d.name, "pack") and std.mem.eql(u8, p.name, "objects") and std.mem.eql(u8, g.name, ".git");
    }

    /// The sha1 a node linked as `dir/name` must have to be a loose object there.
    fn looseDigest(dir: *Node, name: []const u8) ?[20]u8 {
        if (!isFanout(dir) or !objects.isLooseName(name)) return null;
        return objects.digestOf(dir.name, name);
    }

    /// Make `n` what it is about to become as `dir/name`: a file linked under
    /// a loose-object name (git's rename or link of its tmp_obj_ file) becomes
    /// the object — inflated, hash-checked (EIO if the bytes are not that
    /// object), kept as a git-raw record; an object linked anywhere else
    /// becomes a plain file of its loose bytes. An empty file stays a file
    /// (a create; commit checks it again).
    pub fn admit(v: *Vfs, dir: *Node, name: []const u8, n: *Node) FsError!void {
        // No packfiles: a pack would hold every object a second time, as a
        // blob. Nothing new goes into `.git/objects/pack` (EPERM); git's
        // repack and gc fail there, loose objects are all it writes.
        if (isPackDir(dir)) return v.fail(E.PERM);
        const want = looseDigest(dir, name);
        switch (n.kind) {
            .file => {
                const d = want orelse return;
                const loose = try v.content(n);
                if (loose.len == 0) return;
                const raw = objects.inflate(v.alloc, loose) catch |e| switch (e) {
                    error.OutOfMemory => return error.OutOfMemory,
                    else => return v.fail(E.IO),
                };
                var got: [20]u8 = undefined;
                std.crypto.hash.Sha1.hash(raw, &got, .{});
                if (!std.mem.eql(u8, &got, &d)) return v.fail(E.IO);
                n.kind = .object;
                n.cid = try objects.cidOf(v.alloc, &d);
                n.raw = raw;
                n.exec = false; // data stays: the loose bytes as written, a valid stream of this object
            },
            .object => {
                if (want) |d| if (std.mem.eql(u8, &d, tree.gitDigest(n.cid.?).?)) return;
                const loose = try v.content(n);
                n.kind = .file;
                n.data = try v.alloc.dupe(u8, loose);
                n.cap = loose.len;
                n.cid = null;
                n.raw = null;
            },
            else => {},
        }
    }

    pub fn unlink(v: *Vfs, dir: *Node, name: []const u8) FsError!void {
        const m = try v.entries(dir);
        const kv = m.fetchRemove(name) orelse return;
        v.dirty(dir);
        kv.value.parent = null;
    }

    // ------------------------------------------------------------ commit

    pub fn commit(v: *Vfs) ![]const u8 {
        return v.hashDir(v.root);
    }

    fn put(v: *Vfs, cid: []const u8, object: []const u8) !void {
        const s = v.store orelse return;
        if (!try s.has(cid)) try s.putBlock(cid, object);
    }

    fn hashDir(v: *Vfs, d: *Node) anyerror![]const u8 {
        if (d.cid) |c| return c;
        var out = std.array_list.Managed(tree.Entry).init(v.alloc);
        const fanout = isFanout(d);
        var it = d.entries.?.iterator();
        while (it.next()) |kv| {
            const n = kv.value_ptr.*;
            // A loose object written straight to its name (not through a
            // rename): an object if its bytes are that object, else a file.
            if (fanout and n.kind == .file) v.admit(d, kv.key_ptr.*, n) catch |e| switch (e) {
                error.Errno => {},
                else => return e,
            };
            const e: tree.Entry = switch (n.kind) {
                .dir => .{ .mode = .dir, .name = kv.key_ptr.*, .cid = try v.hashDir(n) },
                .module => .{ .mode = .module, .name = kv.key_ptr.*, .cid = n.cid.? },
                .object => .{ .mode = .module, .name = kv.key_ptr.*, .cid = try v.hashObject(n) },
                .link => .{ .mode = .link, .name = kv.key_ptr.*, .cid = try v.hashLeaf(n) },
                .file => .{ .mode = if (n.exec) .exec else .file, .name = kv.key_ptr.*, .cid = try v.hashLeaf(n) },
            };
            try out.append(e);
        }
        const h = try tree.hashTree(v.alloc, out.items);
        try v.put(h.cid, h.object);
        d.cid = h.cid;
        return h.cid;
    }

    /// An object's CID; one written in this run goes to the store now, once.
    fn hashObject(v: *Vfs, n: *Node) ![]const u8 {
        if (n.raw) |raw| {
            try v.put(n.cid.?, raw);
            n.raw = null;
        }
        return n.cid.?;
    }

    fn hashLeaf(v: *Vfs, n: *Node) ![]const u8 {
        if (n.cid) |c| return c;
        const h = try tree.hashBlob(v.alloc, n.data.?);
        try v.put(h.cid, h.object);
        n.cid = h.cid;
        return h.cid;
    }
};
