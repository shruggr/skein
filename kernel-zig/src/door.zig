// What the kernel checks before an entry is written (skein next, SPEC.md sections 2 and 4): a
// request's signature, by scheme (`verify`: brc104, signed). The scheduler's CHECK calls it, then
// matches the row, gates it and runs the row's checks (scheduler.zig).
//
// The BEEF walk below (Headers, Walk, filterBeef, restore) is the format-11 kernel.beef, no longer
// reached from the scheduler: it moves to skein-sdk chain/ (the chain app's `chain.beef` check),
// and leaves this file with that step.
const std = @import("std");
const cbor = @import("cbor");
const cidm = @import("cid");
const mst = @import("mst");
const beef = @import("beef.zig");
const bitcoin = @import("bitcoin.zig");
const authfetch = @import("authfetch.zig");
const signer = @import("signer.zig");
const secp = @import("secp");
const Store = @import("store.zig").Store;
const Value = cbor.Value;
/// skein-sdk's chain module (build.zig `chainImport`): its BEEF parser and SPV verifier.
const chain = @import("chainlib");

/// The head the chain app keeps its state under (shruggr/skein-chain; skein-sdk `chain.state`).
pub const CHAIN_STATE = "chain/state";

pub const BEEF = "kernel.beef";

/// The chain app's headers, read only: {kind: "chain-state", maps: {headers: <MST root>}}, the map
/// height (u32 big-endian) → the header (a bitcoin-block link) on its best chain.
pub const Headers = struct {
    s: Store,
    root: ?[]const u8,
    /// The chain state's `txs` (txid → its bitcoin-tx block) and `rejected` (txid → its settlement
    /// record) maps: what the instance HOLDS, the one thing a BEEF may name by txid alone.
    txs: ?[]const u8 = null,
    rejected: ?[]const u8 = null,
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
        h.* = .{ .s = s, .root = Value.cidOf(maps.get("headers")), .txs = Value.cidOf(maps.get("txs")), .rejected = Value.cidOf(maps.get("rejected")), .forest = undefined };
        h.forest = mst.Forest.init(a, .{ .ctx = h, .get = blockGet });
        return h;
    }

    /// A transaction the instance holds — the chain state holds it (proven, or unproven) and it is not
    /// rejected — its raw bytes; null otherwise. The door's `knownRaw` (2026-11-07): a BEEF may name
    /// such a transaction by txid alone; the instance proved it when it entered.
    pub fn held(h: *Headers, a: std.mem.Allocator, txid: [32]u8) !?[]const u8 {
        const v = (try h.forest.get(a, h.txs, &txid)) orelse return null;
        if ((try h.forest.get(a, h.rejected, &txid)) != null) return null;
        const c = Value.cidOf(v) orelse return null;
        return (try h.s.bytes(a, c)) orelse null;
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
        const h = w.headers orelse {
            try w.refuse("no chain state: the head {s} is absent (no chain app, or it has seen no header)", .{CHAIN_STATE});
            return .{ .bytes = b };
        };
        // The BEEF proven, always (#121): skein-sdk's verifier over it alone — every BUMP's root the
        // header's at its height in chain/state, every transaction no BUMP proves spending only
        // transactions before it in the BEEF or held with its scripts verified, a txid-only entry
        // only for a held transaction. Any error is the refusal, named.
        const proven = spv(a, h, b, d) catch |e| switch (e) {
            error.OutOfMemory => return error.OutOfMemory,
            else => {
                try w.refuse("{s}: {s}", .{ @errorName(e), spvWhy(e) });
                return .{ .bytes = b };
            },
        };
        // What block storage needs: each BUMP's nodes and the header it gives the root of (its
        // `block`); nothing is stored unless the whole package passes (flush, #143).
        const checked = try a.alloc(beef.Checked, d.bumps.len);
        var nodes: std.ArrayList(beef.Node) = .empty;
        for (d.bumps, checked, 0..) |p, *c, i| {
            const rev = beef.reveal(a, p) catch {
                try w.refuse("BUMP {d} (height {d}): malformed, or its nodes conflict", .{ i, p.height });
                c.* = .{ .block = null, .proves = &.{} };
                continue;
            };
            var ps: std.ArrayList(usize) = .empty;
            for (d.txs, proven, 0..) |t, ok, k| if (ok) switch (t.mark) {
                .bump => |j| if (j == i) try ps.append(a, k),
                .none => if (beef.holds(p, t.txid, true)) try ps.append(a, k),
                .txid => {},
            };
            c.* = .{ .block = null, .proves = ps.items };
            const hdr = (try h.at(a, p.height)) orelse continue;
            if (!std.mem.eql(u8, &hdr.root, &rev.root)) continue; // a BUMP proving nothing here (the verifier's "harmless")
            c.block = hdr.cid;
            try nodes.appendSlice(a, rev.nodes);
        }
        // Each block once: a block the store holds is not written again.
        for (d.txs) |t| if (t.raw) |raw| try w.once(try beef.txCid(a, t.txid), raw);
        for (d.bumps) |p| try w.once(try cidm.ofRaw(a, p.bytes), p.bytes);
        for (nodes.items) |n| try w.once(try beef.txCid(a, n.hash), &n.bytes);
        const blk = try cbor.block(a, try beef.record(a, d, checked));
        try w.pending.append(a, .{ .cid = blk.cid, .bytes = blk.bytes });
        try w.beefs.append(a, blk.cid);
        return beef.envelope(a, d, blk.cid);
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

/// skein-sdk's SPV (chain/src/spv.zig `verify`) over the BEEF `b` (the kernel's parse `d` beside it):
/// `rootAt` the merkle root of chain/state's header at a height, `knownRaw` the transactions the
/// instance holds (`Headers.held`: in chain/state's `txs`, not rejected) — a BEEF may name those by
/// txid alone, and nothing else beside it. Per transaction (wire order), whether a BUMP checked against the header proves it.
/// error.Disagree: the SDK's parse is not the kernel's (another transaction list or marks).
fn spv(a: std.mem.Allocator, h: *Headers, b: []const u8, d: beef.Beef) ![]bool {
    const sb = chain.beef.parse(a, b) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        error.InvalidBeef => return error.InvalidBeef,
    };
    if (sb.entries.len != d.txs.len or sb.bumps.len != d.bumps.len) return error.Disagree;
    for (sb.entries, d.txs) |e, t| {
        if (!std.mem.eql(u8, &e.txid, &t.txid)) return error.Disagree;
        const same = switch (t.mark) {
            .none => e.format == .raw,
            .bump => |i| e.format == .raw_with_bump and e.bump == i,
            .txid => e.format == .txid_only,
        };
        if (!same) return error.Disagree;
    }
    const Ctx = struct {
        h: *Headers,
        a: std.mem.Allocator,
        fn rootAt(ptr: *anyopaque, height: u32) anyerror!?[32]u8 {
            const c: *@This() = @ptrCast(@alignCast(ptr));
            return if (try c.h.at(c.a, height)) |x| x.root else null;
        }
        fn knownRaw(ptr: *anyopaque, _: std.mem.Allocator, txid: [32]u8) anyerror!?[]const u8 {
            const c: *@This() = @ptrCast(@alignCast(ptr));
            return c.h.held(c.a, txid);
        }
    };
    var ctx = Ctx{ .h = h, .a = a };
    const r = try chain.spv.verify(a, sb, .{ .ptr = &ctx, .rootAtFn = Ctx.rootAt, .knownRawFn = Ctx.knownRaw });
    return r.proven;
}

/// What each of the verifier's errors means, for the refusal's reason (its name first).
fn spvWhy(e: anyerror) []const u8 {
    return switch (e) {
        error.InvalidBeef => "skein-sdk's BEEF parser refuses it",
        error.Disagree => "skein-sdk's parse of it is not the kernel's (the transactions or their marks differ)",
        error.UnknownHeader => "a BUMP's height has no header in chain/state",
        error.RootMismatch => "a BUMP's merkle root is not the header's at its height in chain/state",
        error.NotInBump => "a transaction marked with a BUMP is not in it",
        error.MissingInput => "a transaction no BUMP proves spends an output of a transaction neither before it in the BEEF nor held here",
        error.UnknownTxidOnly => "a txid-only entry for a transaction this instance does not hold (only a held one may be named by txid alone)",
        error.ScriptFailed => "an unlocking script of a transaction no BUMP proves does not verify",
        error.NotParentsFirst => "its transactions spend in a cycle: no order puts parents first",
        else => "the BEEF's check failed",
    };
}

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

/// The bytes a package's envelopes stand for, put back (the lossless rule's other half): each
/// envelope whose pointer record is named in `beefs` replaced by the bytes it and its record give
/// (beef.zig `wire`).
pub fn restore(a: std.mem.Allocator, s: Store, v: Value, beefs: []const []const u8) !Value {
    switch (v) {
        .map => |m| {
            if (beef.pointerOf(v)) |c| for (beefs) |x| if (std.mem.eql(u8, x, c)) {
                return .{ .bytes = try wireOf(a, s, v) };
            };
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

// ---------------------------------------------------------------- the signature schemes (SPEC 2)

/// A refusal at the check: the status the host answers with, a code, why. Nothing is written.
pub const Reject = struct { status: i64, code: ?[]const u8 = null, reason: []const u8 };

/// The signer, as the check asks it (not recorded: the entry's `door` is what the log keeps).
pub const Signer = struct {
    ctx: *anyopaque,
    call: *const fn (ctx: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]u8,
};

/// What a request's signature came to: its sender (the principal) under a scheme, or a refusal.
pub const Verified = union(enum) {
    ok: struct { principal: []const u8, scheme: []const u8 },
    refused: Reject,
};

pub const BRC104 = "brc104";
pub const SIGNED = "signed";

fn refused(status: i64, code: []const u8, reason: []const u8) Verified {
    return .{ .refused = .{ .status = status, .code = code, .reason = reason } };
}

/// A request record's signature checked (log.zig isRequest; the record has one): `brc104` — a wallet
/// over HTTP, the host's one handshake — or `signed` — a host service, or the host's root key,
/// handing a request in. `identity` is this instance's key; `w` the instance's signer (brc104 needs
/// it: the server nonce and the signature are this instance's to check).
pub fn verify(a: std.mem.Allocator, w: ?Signer, identity: []const u8, rec: Value) !Verified {
    const sig = rec.get("signature").?;
    const payload = rec.get("payload").?;
    const scheme = Value.str(sig.get("scheme")) orelse return refused(400, "ERR_AUTH_MALFORMED", "signature: no scheme");
    if (std.mem.eql(u8, scheme, BRC104)) return brc104(a, w, sig, payload);
    if (std.mem.eql(u8, scheme, SIGNED)) return signed(a, identity, sig, payload);
    return refused(401, "ERR_AUTH_SCHEME", try std.fmt.allocPrint(a, "signature scheme {s}: want brc104 or signed", .{scheme}));
}

/// `brc104` (SPEC 2, review points 3, 33): the host answered the one BRC-103 handshake with the
/// standard @bsv/sdk self-checking nonce (createNonce: 16 random bytes ‖ HMAC [2, "server hmac"],
/// key ID their UTF-8 reading, counterparty self, base64) and gathered the request's x-bsv-auth-*
/// headers into the signature: {identityKey: bytes(33), nonce, yourNonce, requestId (base64 of 32
/// bytes), signature: bytes, version}. Checked here through the signer, nothing stored: `yourNonce`
/// verifies as this instance's (verifyNonce: verifyHmac), and the signature verifies for
/// `identityKey` under [2, "auth message signature"], key "<nonce> <yourNonce>", over BRC-104's
/// request serialization of the payload. No session table, no expiry (this cut).
fn brc104(a: std.mem.Allocator, w: ?Signer, sig: Value, payload: Value) !Verified {
    const MALFORMED = "ERR_AUTH_MALFORMED";
    const peer = Value.bytesOf(sig.get("identityKey")) orelse return refused(400, MALFORMED, "brc104: identityKey: want 33 bytes");
    if (!secp.isKey(peer)) return refused(400, MALFORMED, "brc104: identityKey is not a key");
    const nonce = Value.str(sig.get("nonce")) orelse return refused(400, MALFORMED, "brc104: no nonce");
    const your = Value.str(sig.get("yourNonce")) orelse return refused(400, MALFORMED, "brc104: no yourNonce");
    const rid_text = Value.str(sig.get("requestId")) orelse return refused(400, MALFORMED, "brc104: no requestId");
    const der = Value.bytesOf(sig.get("signature")) orelse return refused(400, MALFORMED, "brc104: no signature");
    if (nonce.len == 0 or your.len == 0) return refused(400, MALFORMED, "brc104: an empty nonce");
    const b64 = std.base64.standard.Decoder;
    const rid = try a.alloc(u8, b64.calcSizeForSlice(rid_text) catch return refused(400, MALFORMED, "brc104: requestId is not base64"));
    b64.decode(rid, rid_text) catch return refused(400, MALFORMED, "brc104: requestId is not base64");
    const sg = w orelse return refused(401, "ERR_AUTH_FAILED", "brc104: this host has no signer to check the request with");
    // The server nonce: ours, by its HMAC (@bsv/sdk verifyNonce).
    const nb = try a.alloc(u8, b64.calcSizeForSlice(your) catch return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's"));
    b64.decode(nb, your) catch return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's");
    if (nb.len != 48) return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's");
    const key_id = try cbor.utf8Fix(a, nb[0..16]);
    const hm = sg.call(sg.ctx, a, try signer.verifyHmacFrame(a, authfetch.NONCE_PROTOCOL, key_id, .self, nb[0..16], nb[16..48])) catch return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's (expired or unknown: shake hands again)");
    if (hm.len == 0 or hm[0] != 0) return refused(401, "ERR_AUTH_FAILED", "brc104: yourNonce is not this instance's (expired or unknown: shake hands again)");
    // The request's signature, the client's.
    const body = Value.bytesOf(payload.get("body")) orelse "";
    const bytes = try authfetch.requestPayload(a, rid, Value.str(payload.get("method")).?, Value.str(payload.get("path")).?, Value.str(payload.get("query")).?, try authfetch.headerList(a, payload.get("headers")), body);
    const sk = try std.fmt.allocPrint(a, "{s} {s}", .{ nonce, your });
    const res = sg.call(sg.ctx, a, try signer.verifySignatureFrame(a, authfetch.AUTH_PROTOCOL, sk, .{ .other = peer }, bytes, der)) catch return refused(401, "ERR_AUTH_FAILED", "brc104: the request's signature does not verify");
    if (res.len == 0 or res[0] != 0) return refused(401, "ERR_AUTH_FAILED", "brc104: the request's signature does not verify");
    return .{ .ok = .{ .principal = peer, .scheme = BRC104 } };
}

/// What the `signed` scheme signs: dag-cbor {sender, recipient, nonce, payload} — the request
/// without its signature, the signature's own fields beside the payload.
pub fn signedPreimage(a: std.mem.Allocator, sender: []const u8, recipient: []const u8, nonce: []const u8, payload: Value) ![]u8 {
    var m = cbor.MapBuilder.init(a);
    try m.put("sender", .{ .bytes = sender });
    try m.put("recipient", .{ .bytes = recipient });
    try m.put("nonce", .{ .bytes = nonce });
    try m.put("payload", payload);
    return cbor.encode(a, m.value());
}

/// `signed` (SPEC 2 [P]): BRC-169's message signing — [2, "metanet handles envelope"], key "send",
/// counterparty anyone — by `sender` over signedPreimage; `recipient` is this instance. Anyone can
/// check it; no signer needed.
fn signed(a: std.mem.Allocator, identity: []const u8, sig: Value, payload: Value) !Verified {
    const MALFORMED = "ERR_AUTH_MALFORMED";
    const sender = Value.bytesOf(sig.get("sender")) orelse return refused(400, MALFORMED, "signed: sender: want 33 bytes");
    if (!secp.isKey(sender)) return refused(400, MALFORMED, "signed: sender is not a key");
    const recipient = Value.bytesOf(sig.get("recipient")) orelse return refused(400, MALFORMED, "signed: recipient: want 33 bytes");
    const nonce = Value.bytesOf(sig.get("nonce")) orelse return refused(400, MALFORMED, "signed: nonce: want bytes");
    const der = Value.bytesOf(sig.get("signature")) orelse return refused(400, MALFORMED, "signed: no signature");
    if (!std.mem.eql(u8, recipient, identity)) return refused(401, "ERR_AUTH_FAILED", "signed: the request is addressed to another key");
    const pre = try signedPreimage(a, sender, recipient, nonce, payload);
    if (!secp.verifyAnyoneKey(sender, 2, MESSAGE_PROTOCOL, MESSAGE_KEY_ID, pre, der)) return refused(401, "ERR_AUTH_FAILED", "signed: the signature does not verify");
    return .{ .ok = .{ .principal = sender, .scheme = SIGNED } };
}

pub const MESSAGE_PROTOCOL = "metanet handles envelope";
pub const MESSAGE_KEY_ID = "send";

/// The bytes an envelope stands for (beef.zig `wire`), its pointer record and blocks from the store.
fn wireOf(a: std.mem.Allocator, s: Store, env: Value) ![]u8 {
    const c = beef.pointerOf(env) orelse return error.Malformed;
    const rec = (try s.get(a, c)) orelse return error.NotFound;
    const G = struct {
        fn get(ctx: *anyopaque, al: std.mem.Allocator, k: []const u8) anyerror!?[]const u8 {
            const st: *const Store = @ptrCast(@alignCast(ctx));
            return st.bytes(al, k);
        }
    };
    var sc = s;
    return beef.wire(a, env, rec, .{ .ctx = &sc, .get = G.get });
}
