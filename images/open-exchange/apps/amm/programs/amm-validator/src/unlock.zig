//! The pool input's unlocking script as Rúnar writes a call (see
//! pool/pool_test.go `run` and gen/vectors `unlockPool`), the
//! BIP-143 preimage the pool's signatures are over, and the checks of other
//! inputs' P2PKH signatures. Pure: bsvz only.
//!
//! A call is pushes only:
//!
//!   _codePart  arg0 .. argN-1  _changePKH  _changeAmount  txPreimage  methodIndex
//!
//! `_codePart` is the pool's code (the lock after the BRC-162 prefix, up to
//! the `OP_RETURN` before the state). The preimage is BIP-143 with
//! ALL|FORKID over the pool input, whose scriptCode is the lock after
//! Rúnar's leading `OP_NOP OP_CODESEPARATOR` (so neither the token prefix
//! nor those two bytes). The signatures a pool method checks (the
//! validator's for Swap, the LP's for Close) are over sha256d of that
//! preimage.
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");

const bsvz = w.bsvz;
const brc162 = mandala.brc162;
const pool = @import("pool");
const Transaction = bsvz.transaction.Transaction;
const Script = bsvz.script.Script;

pub const sighash_all_forkid: u32 = 0x41;

/// Where a validator-signed method keeps what the validator checks, as
/// argument indices (pool/Pool.runar.go's parameter order).
pub const Layout = struct {
    args: usize,
    validator_sig: usize,
    next_validator: usize,
};

/// Swap(validatorSig, nextValidatorPubKey, amountIn, bsvIn, userPkh,
/// commissionPkh). Close is the LP's alone: no layout (0.9.0).
pub fn layoutOf(m: pool.Method) ?Layout {
    return switch (m) {
        .swap => .{ .args = 6, .validator_sig = 0, .next_validator = 1 },
        .close => null,
    };
}

pub const Push = struct { start: usize, p: brc162.Push };

/// A pool call, parsed.
pub const Call = struct {
    script: []const u8,
    pushes: []const Push,
    layout: Layout,

    pub fn code(self: Call) []const u8 {
        return self.pushes[0].p.data;
    }
    pub fn arg(self: Call, i: usize) brc162.Push {
        return self.pushes[1 + i].p;
    }
    pub fn preimage(self: Call) []const u8 {
        return self.pushes[self.pushes.len - 2].p.data;
    }
    /// Rúnar's `_changePKH` and `_changeAmount`, after the method's args.
    pub fn changePkh(self: Call) []const u8 {
        return self.arg(self.layout.args).data;
    }
    pub fn changeAmount(self: Call) brc162.Push {
        return self.arg(self.layout.args + 1);
    }
};

/// The call an unlocking script makes to `method`, or null when it is not
/// pushes only, or has the wrong number of them.
pub fn parseCall(a: std.mem.Allocator, script: []const u8, method: pool.Method) !?Call {
    const layout = layoutOf(method) orelse return null;
    var pushes: std.ArrayList(Push) = .empty;
    var pos: usize = 0;
    while (pos < script.len) {
        const p = brc162.readPush(script, pos) orelse return null;
        try pushes.append(a, .{ .start = pos, .p = p });
        pos = p.next;
    }
    if (pushes.items.len != 1 + layout.args + 4) return null;
    return .{ .script = script, .pushes = pushes.items, .layout = layout };
}

/// A push of `data`: `OP_0` when empty, else the shortest length prefix
/// (what Rúnar's EncodePushData writes for a signature).
pub fn pushData(a: std.mem.Allocator, data: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    const n = data.len;
    if (n == 0) {
        try out.append(a, 0x00);
    } else if (n <= 0x4b) {
        try out.append(a, @intCast(n));
    } else if (n <= 0xff) {
        try out.appendSlice(a, &.{ brc162.OP_PUSHDATA1, @intCast(n) });
    } else if (n <= 0xffff) {
        try out.append(a, brc162.OP_PUSHDATA2);
        var b: [2]u8 = undefined;
        std.mem.writeInt(u16, &b, @intCast(n), .little);
        try out.appendSlice(a, &b);
    } else {
        try out.append(a, brc162.OP_PUSHDATA4);
        var b: [4]u8 = undefined;
        std.mem.writeInt(u32, &b, @intCast(n), .little);
        try out.appendSlice(a, &b);
    }
    try out.appendSlice(a, data);
    return out.items;
}

/// The call's script with argument `i` replaced by a push of `data`; every
/// other push byte for byte as it was.
pub fn withArg(a: std.mem.Allocator, c: Call, i: usize, data: []const u8) ![]u8 {
    const at = c.pushes[1 + i];
    return std.mem.concat(a, u8, &.{ c.script[0..at.start], try pushData(a, data), c.script[at.p.next..] });
}

/// The pool's scriptCode: its lock (after the token prefix) without Rúnar's
/// leading `OP_NOP OP_CODESEPARATOR`. Null when the lock does not start so.
pub fn poolScriptCode(lock: []const u8) ?[]const u8 {
    if (lock.len < 2 or lock[0] != 0x61 or lock[1] != 0xab) return null;
    return lock[2..];
}

/// The pool's code, as `_codePart` pushes it: the lock without `OP_RETURN` and the state.
pub fn poolCode(lock: []const u8) ?[]const u8 {
    if (lock.len < 1 + pool.state_len) return null;
    return lock[0 .. lock.len - 1 - pool.state_len];
}

/// The BIP-143 preimage of input `index` under `scope` (bsvz).
pub fn preimage(a: std.mem.Allocator, tx: *const Transaction, index: usize, script_code: []const u8, satoshis: u64, scope: u32) ![]u8 {
    return bsvz.transaction.sighash.formatPreimage(a, tx, index, Script.init(script_code), @intCast(satoshis), scope);
}

pub fn sha256d(b: []const u8) [32]u8 {
    return bsvz.crypto.hash.hash256(b).bytes;
}

/// Whether `checksig` (DER ‖ sighash byte) is `key`'s signature of `digest`
/// with sighash `scope`.
pub fn verify(checksig: []const u8, key: []const u8, digest: [32]u8, scope: u32) bool {
    if (checksig.len < 9 or checksig[checksig.len - 1] != scope) return false;
    const der = bsvz.crypto.DerSignature.fromDer(checksig[0 .. checksig.len - 1]) catch return false;
    const pk = bsvz.primitives.ec.PublicKey.fromSec1(key) catch return false;
    return pk.verifyDigest(digest, der) catch false;
}

/// The key hash of a plain P2PKH lock.
pub fn p2pkhHash(lock: []const u8) ?[20]u8 {
    if (lock.len != 25 or lock[0] != 0x76 or lock[1] != 0xa9 or lock[2] != 0x14 or lock[23] != 0x88 or lock[24] != 0xac) return null;
    return lock[3..23].*;
}

pub const InputCheck = enum {
    /// A P2PKH input (plain, or a BRC-162 token under P2PKH) whose signature verifies.
    verified,
    /// Signed (a non-empty unlocking script), but not a lock checked here, or its source is unknown.
    present,
    missing,
    bad,
};

/// Check input `index`'s signature against the output it spends, when known.
/// A P2PKH lock (under a token prefix or not) is verified in full: two
/// pushes, the key hashing to the lock's, and an ECDSA signature over the
/// input's BIP-143 digest (FORKID, whatever base type it names), the
/// scriptCode being the whole locking script (it has no separator). Other
/// locks are only required to carry an unlocking script: bsvz's interpreter
/// is not run here.
pub fn checkInput(a: std.mem.Allocator, tx: *const Transaction, index: usize, source_script: ?[]const u8, satoshis: u64) !InputCheck {
    const u = tx.inputs[index].unlocking_script.bytes;
    if (u.len == 0) return .missing;
    const src = source_script orelse return .present;
    const lock = if (brc162.decode(src)) |tok| tok.lock else src;
    const pkh = p2pkhHash(lock) orelse return .present;

    const sig = brc162.readPush(u, 0) orelse return .bad;
    const key = brc162.readPush(u, sig.next) orelse return .bad;
    if (key.next != u.len or key.data.len != 33 or sig.data.len < 9) return .bad;
    if (!std.mem.eql(u8, &bsvz.crypto.hash.hash160(key.data).bytes, &pkh)) return .bad;
    const scope: u32 = sig.data[sig.data.len - 1];
    if (scope & 0x40 == 0) return .bad; // FORKID
    const pre = try preimage(a, tx, index, src, satoshis, scope);
    return if (verify(sig.data, key.data, sha256d(pre), scope)) .verified else .bad;
}
