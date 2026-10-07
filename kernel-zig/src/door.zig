// The kernel's own filters (#121, #143): what a route's `filters` may name as
// `kernel.<name>`, run by the kernel in the door on a request's package before
// anything is recorded (scheduler.zig `door`, which runs a route's filters in
// order and an app's own — `<app>.<filter>` — as calls in the deterministic
// profile). A filter reads the package and the state as it stands; what it
// writes is blocks (content-addressed, once) and the package it hands back,
// which the entry then names instead of the one received. It is lossless for
// anything a signature covers: what it rewrites is reconstructible to the
// exact bytes (beef.zig `encode`).
//
//   kernel.brc104   the BRC-104 request check (http): the request's session
//                   (the front door's table, the head `frontdoor/sessions`,
//                   found by its `yourNonce`, not expired) and its signature
//                   over the request, through the signer — passed on with the
//                   PRINCIPAL the client's key; a request with no x-bsv-auth-*
//                   headers, or one that does not check, is rejected (401: the
//                   stock client shakes hands again; 400 for a malformed one).
//   kernel.beef     every byte string in the package (an http body, a libp2p
//                   message's body; walked through maps and arrays) that starts
//                   with a BEEF pattern (beef.zig `patterns`) is decoded; every
//                   BUMP is checked against the headers in the chain app's state
//                   (the head `chain/state`, read only); each transaction is
//                   stored as its `bitcoin-tx` block, each BUMP as the raw block
//                   of its bytes and the merkle nodes it reveals; and the bytes
//                   are replaced by a link to the pointer record (beef.zig). A
//                   BUMP that does not check is a rejection (400), as is a
//                   package with no BEEF in it when no filter before it yielded
//                   a principal (#135: signed or validated — "nothing to
//                   validate"). A transaction no BUMP proves enters as unproven
//                   (SPV and status are the chain app's).
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const mst = @import("mst");
const beef = @import("beef.zig");
const authfetch = @import("authfetch.zig");
const signer = @import("signer.zig");
const secp = @import("secp");
const Store = @import("store.zig").Store;
const Value = cbor.Value;

/// The head the chain app keeps its state under (shruggr/skein-chain; skein-sdk `chain.state`).
pub const CHAIN_STATE = "chain/state";

pub const BRC104 = "kernel.brc104";
pub const BEEF = "kernel.beef";

/// The chain app's headers, read only: {kind: "chain-state", maps: {headers: <MST root>}}, the map
/// height (u32 big-endian) → the header (a bitcoin-block link) on its best chain.
pub const Headers = struct {
    s: Store,
    root: ?[]const u8,
    forest: mst.Forest,

    fn blockGet(ctx: *anyopaque, a: std.mem.Allocator, cid: []const u8) anyerror!?[]u8 {
        const h: *Headers = @ptrCast(@alignCast(ctx));
        return h.s.bytes(a, cid);
    }

    /// The headers of the chain state as it stands; null when the instance has none (no chain app,
    /// or one that has seen no header).
    pub fn open(a: std.mem.Allocator, s: Store) !?*Headers {
        const state = (try s.headTree(a, CHAIN_STATE)) orelse return null;
        const v = s.getOpt(a, state) orelse return null;
        if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse "", "chain-state")) return null;
        const maps = v.get("maps") orelse return null;
        const h = try a.create(Headers);
        h.* = .{ .s = s, .root = Value.cidOf(maps.get("headers")), .forest = undefined };
        h.forest = mst.Forest.init(a, .{ .ctx = h, .get = blockGet });
        return h;
    }

    /// The header at `height`: its CID and its merkle root; null when the chain state has none there.
    pub fn at(h: *Headers, a: std.mem.Allocator, height: u32) !?struct { cid: []const u8, root: [32]u8 } {
        var key: [4]u8 = undefined;
        std.mem.writeInt(u32, &key, height, .big);
        const v = (try h.forest.get(a, h.root, &key)) orelse return null;
        const c = Value.cidOf(v) orelse return null;
        const raw = (try h.s.bytes(a, c)) orelse return null;
        if (raw.len != 80) return null;
        return .{ .cid = c, .root = raw[36..68].* };
    }
};

/// What a filter came to: the package to log (rewritten, or as received), the pointer records it
/// made, and — refused — why.
pub const Filtered = struct {
    value: Value,
    beefs: []const []const u8,
    refused: ?[]const u8 = null,
};

const Walk = struct {
    a: std.mem.Allocator,
    s: Store,
    headers: ?*Headers = null,
    opened: bool = false,
    beefs: std.ArrayList([]const u8) = .empty,
    refused: ?[]const u8 = null,
    /// What a pass stores (#143: a rejection writes nothing — no entry names it, so nothing may be left in the store).
    pending: std.ArrayList(Pending) = .empty,

    const Pending = struct { cid: []const u8, bytes: []const u8 };

    fn refuse(w: *Walk, comptime f: []const u8, args: anytype) !void {
        if (w.refused == null) w.refused = try std.fmt.allocPrint(w.a, f, args);
    }

    fn walk(w: *Walk, v: Value) anyerror!Value {
        switch (v) {
            .bytes => |b| return w.bytes(b),
            .map => |m| {
                const out = try w.a.alloc(cbor.Entry, m.len);
                for (m, out) |e, *o| o.* = .{ .key = e.key, .value = try w.walk(e.value) };
                return .{ .map = out };
            },
            .array => |xs| {
                const out = try w.a.alloc(Value, xs.len);
                for (xs, out) |x, *o| o.* = try w.walk(x);
                return .{ .array = out };
            },
            else => return v,
        }
    }

    fn bytes(w: *Walk, b: []const u8) !Value {
        const a = w.a;
        if (beef.recognize(b) == null) return .{ .bytes = b };
        const d = beef.parse(a, b) catch {
            try w.refuse("a BEEF that does not decode (it starts with a BEEF pattern)", .{});
            return .{ .bytes = b };
        };
        if (!w.opened) {
            w.headers = try Headers.open(a, w.s);
            w.opened = true;
        }
        // Check every BUMP before anything is stored; nothing is stored unless the whole package passes (flush, #143).
        const checked = try a.alloc(beef.Checked, d.bumps.len);
        var nodes: std.ArrayList(beef.Node) = .empty;
        for (d.bumps, checked, 0..) |p, *c, i| {
            c.* = .{ .block = null };
            const rev = beef.reveal(a, p) catch {
                try w.refuse("BUMP {d} (height {d}): malformed, or its nodes conflict", .{ i, p.height });
                continue;
            };
            _ = beef.proves(a, d, i) catch {
                try w.refuse("BUMP {d} (height {d}): a transaction marked with it is not in it", .{ i, p.height });
                continue;
            };
            const h = w.headers orelse {
                try w.refuse("no chain state to check the BUMPs against: the head {s} is absent (no chain app, or it has seen no header)", .{CHAIN_STATE});
                continue;
            };
            const hdr = (try h.at(a, p.height)) orelse {
                try w.refuse("BUMP {d}: no header at height {d} in {s}", .{ i, p.height, CHAIN_STATE });
                continue;
            };
            if (!std.mem.eql(u8, &hdr.root, &rev.root)) {
                try w.refuse("BUMP {d}: its merkle root is not the header's at height {d}", .{ i, p.height });
                continue;
            }
            c.block = hdr.cid;
            try nodes.appendSlice(a, rev.nodes);
        }
        if (d.bumps.len == 0 and w.headers == null) try w.refuse("no chain state: the head {s} is absent (no chain app, or it has seen no header)", .{CHAIN_STATE});
        // Each block once: a block the store holds is not written again.
        for (d.txs) |t| if (t.raw) |raw| try w.once(try beef.txCid(a, t.txid), raw);
        for (d.bumps) |p| try w.once(try cidm.ofRaw(a, p.bytes), p.bytes);
        if (w.refused == null) for (nodes.items) |n| try w.once(try beef.txCid(a, n.hash), &n.bytes);
        const blk = try cbor.block(a, try beef.record(a, d, checked));
        try w.pending.append(a, .{ .cid = blk.cid, .bytes = blk.bytes });
        try w.beefs.append(a, blk.cid);
        return cbor.cidv(blk.cid);
    }

    fn once(w: *Walk, c: []const u8, b: []const u8) !void {
        try w.pending.append(w.a, .{ .cid = try w.a.dupe(u8, c), .bytes = try w.a.dupe(u8, b) });
    }

    /// Store what the walk decoded: once, and only when it passed.
    fn flush(w: *Walk) !void {
        if (w.refused != null) return;
        for (w.pending.items) |x| if (!(try w.s.has(x.cid))) try w.s.putBlock(x.cid, x.bytes);
    }
};

/// The rejection `kernel.beef` comes to when nothing admits the request (#135: signed or
/// validated): no filter before it yielded a principal, and the package held no BEEF to check —
/// the filter proved nothing, so the request is neither signed nor validated. With a principal it
/// passes whatever it found; its own refusal stands as it is.
pub const NOTHING_VALIDATED = "nothing to validate";

pub fn nothingValidated(principal: bool, x: Filtered) ?[]const u8 {
    if (principal or x.refused != null or x.beefs.len > 0) return null;
    return NOTHING_VALIDATED;
}

/// The `beef` filter over a package (any dag-cbor value: a request record).
pub fn filterBeef(a: std.mem.Allocator, s: Store, v: Value) !Filtered {
    var w = Walk{ .a = a, .s = s };
    const out = try w.walk(v);
    try w.flush();
    return .{ .value = out, .beefs = w.beefs.items, .refused = w.refused };
}

/// The bytes a package's pointer links stand for, put back (the lossless rule's other half): each
/// link to a pointer record named in `beefs` replaced by the BEEF it records (beef.zig `encode`).
pub fn restore(a: std.mem.Allocator, s: Store, v: Value, beefs: []const []const u8) !Value {
    switch (v) {
        .cid => |c| {
            for (beefs) |x| if (std.mem.eql(u8, x, c)) {
                const rec = (try s.get(a, c)) orelse return error.NotFound;
                const G = struct {
                    fn get(ctx: *anyopaque, al: std.mem.Allocator, k: []const u8) anyerror!?[]const u8 {
                        const st: *const Store = @ptrCast(@alignCast(ctx));
                        return st.bytes(al, k);
                    }
                };
                var sc = s;
                return .{ .bytes = try beef.encode(a, rec, .{ .ctx = &sc, .get = G.get }) };
            };
            return v;
        },
        .map => |m| {
            const out = try a.alloc(cbor.Entry, m.len);
            for (m, out) |e, *o| o.* = .{ .key = e.key, .value = try restore(a, s, e.value, beefs) };
            return .{ .map = out };
        },
        .array => |xs| {
            const out = try a.alloc(Value, xs.len);
            for (xs, out) |x, *o| o.* = try restore(a, s, x, beefs);
            return .{ .array = out };
        },
        else => return v,
    }
}

// ---------------------------------------------------------------- kernel.brc104 (#143)

/// A filter's rejection: the status the transport answers with, a code, why.
pub const Reject = struct { status: i64, code: ?[]const u8 = null, reason: []const u8 };

/// The front door's session table (programs/frontdoor/sessions.zig, written on the handshake),
/// read only: {kind: "sessions", buckets: [<bucket> × 16]}, a bucket {sessions: [{nonce, peer,
/// peerNonce, created}]}, a session in bucket sha256(nonce)[0] mod 16.
pub const SESSIONS = "frontdoor/sessions";
const BUCKETS = 16;

pub const Session = struct { peer: []const u8, ours: []const u8, theirs: []const u8, created: i128 };

/// The session whose nonce (ours) is `nonce`, or null.
pub fn sessionOf(a: std.mem.Allocator, s: Store, nonce: []const u8) !?Session {
    const root = (try s.headTree(a, SESSIONS)) orelse return null;
    const r = s.getOpt(a, root) orelse return null;
    const bs = r.get("buckets") orelse return null;
    if (bs != .array or bs.array.len != BUCKETS) return null;
    var h: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(nonce, &h, .{});
    const bc = Value.cidOf(bs.array[h[0] % BUCKETS]) orelse return null;
    const b = s.getOpt(a, bc) orelse return null;
    const ss = b.get("sessions") orelse return null;
    if (ss != .array) return null;
    for (ss.array) |x| {
        const ours = Value.str(x.get("nonce")) orelse continue;
        if (!std.mem.eql(u8, ours, nonce)) continue;
        return .{
            .ours = ours,
            .peer = Value.bytesOf(x.get("peer")) orelse return null,
            .theirs = Value.str(x.get("peerNonce")) orelse return null,
            .created = Value.intOf(x.get("created")) orelse 0,
        };
    }
    return null;
}

/// The signer, as the door asks it (not recorded: the door's outcome is what the log keeps).
pub const Signer = struct {
    ctx: *anyopaque,
    call: *const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8,
};

/// What `kernel.brc104` came to: passed on with the client's key (and the session's nonce and
/// the request id, which the front door signs the answer with), or a rejection.
pub const Brc104 = union(enum) {
    pass: struct { caller: []const u8, theirs: []const u8, request_id: []const u8 },
    reject: Reject,
};

fn headerOf(headers: ?Value, name: []const u8) ?[]const u8 {
    const hs = headers orelse return null;
    if (hs != .map) return null;
    for (hs.map) |e| if (std.ascii.eqlIgnoreCase(e.key, name)) return Value.str(e.value);
    return null;
}

/// Whether a request carries BRC-104 headers (x-bsv-auth-*): a general message.
pub fn signedRequest(req: Value) bool {
    const hs = req.get("headers") orelse return false;
    if (hs != .map) return false;
    for (hs.map) |e| if (std.ascii.startsWithIgnoreCase(e.key, "x-bsv-auth-")) return true;
    return false;
}

const UNAUTHORIZED: Reject = .{ .status = 401, .code = "UNAUTHORIZED", .reason = "Mutual-authentication failed!" };
const MALFORMED: Reject = .{ .status = 400, .code = "ERR_AUTH_MALFORMED", .reason = "The authentication request is malformed." };

fn failed(reason: []const u8) Brc104 {
    return .{ .reject = .{ .status = 401, .code = "ERR_AUTH_FAILED", .reason = reason } };
}

/// kernel.brc104: the request's BRC-104 general message checked — its session (by `yourNonce`, not
/// past `ttl` ms from its handshake at `now`, the entry's time), its identity the session's, and
/// its signature over the request (SimplifiedFetchTransport's payload) under [2, "auth message
/// signature"], key "<nonce> <ours>", counterparty the client, through the signer.
pub fn brc104(a: std.mem.Allocator, s: Store, w: ?Signer, req: Value, now: i64, ttl: i64) !Brc104 {
    if (!signedRequest(req)) return .{ .reject = UNAUTHORIZED };
    const hs = req.get("headers");
    const need = struct {
        fn f(h: ?Value, name: []const u8) ?[]const u8 {
            const v = headerOf(h, name) orelse return null;
            return if (v.len == 0) null else v;
        }
    }.f;
    const key_hex = need(hs, "x-bsv-auth-identity-key") orelse return .{ .reject = MALFORMED };
    const nonce = need(hs, "x-bsv-auth-nonce") orelse return .{ .reject = MALFORMED };
    const your = need(hs, "x-bsv-auth-your-nonce") orelse return .{ .reject = MALFORMED };
    const sig_hex = need(hs, "x-bsv-auth-signature") orelse return .{ .reject = MALFORMED };
    const request_id = need(hs, "x-bsv-auth-request-id") orelse return .{ .reject = UNAUTHORIZED };
    _ = need(hs, "x-bsv-auth-version") orelse return .{ .reject = MALFORMED };
    if (key_hex.len != 66 or sig_hex.len % 2 != 0) return .{ .reject = MALFORMED };
    const peer = try a.alloc(u8, 33);
    _ = std.fmt.hexToBytes(peer, key_hex) catch return .{ .reject = MALFORMED };
    if (!secp.isKey(peer)) return .{ .reject = MALFORMED };
    const sig = try a.alloc(u8, sig_hex.len / 2);
    _ = std.fmt.hexToBytes(sig, sig_hex) catch return .{ .reject = MALFORMED };
    const b64 = std.base64.standard.Decoder;
    const rid = try a.alloc(u8, b64.calcSizeForSlice(request_id) catch return .{ .reject = MALFORMED });
    b64.decode(rid, request_id) catch return .{ .reject = MALFORMED };
    const sess = (try sessionOf(a, s, your)) orelse return failed("Session not found for nonce (expired or unknown)");
    if (sess.created + ttl < now) return failed("Session expired");
    if (!std.mem.eql(u8, sess.peer, peer)) return failed("general identity does not match the authenticated session.");
    const payload = try authfetch.requestPayload(a, rid, Value.str(req.get("method")) orelse "GET", Value.str(req.get("path")) orelse "/", Value.str(req.get("query")) orelse "", try authfetch.headerList(a, hs), Value.bytesOf(req.get("body")) orelse "");
    const key_id = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, sess.ours });
    const sg = w orelse return failed("this host has no signer to check the signature with");
    const res = sg.call(sg.ctx, a, try signer.verifySignatureFrame(a, authfetch.AUTH_PROTOCOL, key_id, .{ .other = peer }, payload, sig)) catch return failed("Invalid signature in generalMessage");
    if (res.len == 0 or res[0] != 0) return failed("Invalid signature in generalMessage");
    return .{ .pass = .{ .caller = peer, .theirs = sess.theirs, .request_id = request_id } };
}
