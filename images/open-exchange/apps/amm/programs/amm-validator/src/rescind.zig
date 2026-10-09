//! The validator's rescind (skein-amm 0.9.0, David Case 2026-10-09: "The validator rescinds by
//! SPENDING the claim output"; burning its one unit). The claim is a caller input of the
//! instance's wallet (skein#93, merged: skein 2231398, skein-sdk 0.10.0+): `createAction` with the
//! claim as an input whose unlocking script is the validator's (only its length now), the claim's
//! source in `inputBEEF`, one `OP_FALSE OP_RETURN` output (the wallet takes no action without an
//! output; the unit is burned: no token output) and `noSend` — the wallet funds the fee and change
//! and answers a draft (`reference`); the validator signs the claim input through the signer (the
//! pool's validator key, `[1, "amm pool"]`, key ID the deploy's first token input, anyone) over the
//! draft's sighash; `signAction {reference, spends: {"<i>": {unlockingScript}}}` finishes it; the
//! validator submits it to its own overlay (the topic marks the claim spent, and amm-lookup lists
//! the pool no more). Root's message `{fn: "rescind", args: {pool: "<deploy txid>.0"}}` in the box
//! `amm/validator` (main.zig); each wallet call is a thread of the genesis wallet program
//! (filing.zig `launchArgs`).
//!
//! Pure: the bodies and the signature, over a View and an Oracle; tested with a mocked wallet.
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");
const pool = @import("pool");
const unlock = @import("unlock.zig");
const validator = @import("validator.zig");
const View = @import("view.zig").View;
const Oracle = @import("oracle.zig").Oracle;

const cbor = w.cbor;
const Value = cbor.Value;
const beef = w.beef;
const bsvz = w.bsvz;
const Transaction = bsvz.transaction.Transaction;
const Outpoint = validator.Outpoint;

/// The claim input's unlocking script length the wallet's fee is paid for: P2PKH, a 72-byte DER
/// signature at most and its sighash byte, a 33-byte key, two push bytes.
pub const unlock_len = 1 + 73 + 1 + 33;
/// The rescind's one output: `OP_FALSE OP_RETURN`, 0 sats.
pub const burn_script = [_]u8{ 0x00, 0x6a };

/// A deploy's claim, as this validator rescinds it.
pub const Claim = struct {
    deploy: [32]u8,
    vout: u32,
    /// The validator key's ID: the deploy's first token input (its input 0, validator.zig `deploy`).
    key_op: Outpoint,
    asset_id: [32]u8,
    key: [33]u8,
};

pub const Found = union(enum) { ok: Claim, refused: []const u8 };

/// The claim of the deploy `deploy` (held by this overlay): a pool of ours at output 0 and its
/// claim, verified. Refused (why) otherwise.
pub fn claimOf(a: std.mem.Allocator, v: View, identity: [33]u8, deploy: [32]u8) !Found {
    const t = (try v.tx(a, deploy)) orelse return .{ .refused = "the deploy is not held" };
    if (t.outputs.len == 0 or t.inputs.len == 0) return .{ .refused = "not a pool deploy" };
    const ps = t.outputs[0].locking_script.bytes;
    const tok = mandala.brc162.decode(ps) orelse return .{ .refused = "not a pool deploy" };
    const p = (pool.parse(tok.lock) catch null) orelse return .{ .refused = "not a pool deploy" };
    if (!std.mem.eql(u8, &p.identity, &identity)) return .{ .refused = "not our pool" };
    const first = t.inputs[0].previous_outpoint;
    const vout = (try pool.verifiedClaim(a, t.outputs, p, ps, first.txid.bytes, first.index)) orelse return .{ .refused = "the deploy carries no claim of ours" };
    return .{ .ok = .{ .deploy = deploy, .vout = vout, .key_op = .{ .txid = first.txid.bytes, .vout = first.index }, .asset_id = p.asset_id, .key = p.validator } };
}

fn keyId(a: std.mem.Allocator, op: Outpoint) ![]const u8 {
    const buf = try a.create([64 + 1 + 10]u8);
    return pool.keyId(buf, op.txid, op.vout);
}

/// The wallet's `createAction` body: the claim as a caller input (its unlocking script to come),
/// `input_beef` its source's BEEF, one burn output, noSend.
pub fn createBody(a: std.mem.Allocator, c: Claim, input_beef: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "op", .value = .{ .text = "createAction" } },
        .{ .key = "description", .value = .{ .text = "AMM claim rescinded" } },
        .{ .key = "inputs", .value = .{ .array = try a.dupe(Value, &.{.{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "outpoint", .value = .{ .text = try std.fmt.allocPrint(a, "{s}.{d}", .{ &w.header.toHex(c.deploy), c.vout }) } },
            .{ .key = "unlockingScriptLength", .value = .{ .uint = unlock_len } },
            .{ .key = "inputDescription", .value = .{ .text = "the AMM claim" } },
        }) }}) } },
        .{ .key = "inputBEEF", .value = .{ .bytes = input_beef } },
        .{ .key = "outputs", .value = .{ .array = try a.dupe(Value, &.{.{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "lockingScript", .value = .{ .bytes = &burn_script } },
            .{ .key = "satoshis", .value = .{ .uint = 0 } },
            .{ .key = "outputDescription", .value = .{ .text = "the claim's unit, burned" } },
        }) }}) } },
        .{ .key = "labels", .value = .{ .array = try a.dupe(Value, &.{.{ .text = "amm-rescind" }}) } },
        .{ .key = "options", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "noSend", .value = .{ .boolean = true } }}) } },
    }) };
}

/// The transaction an Atomic BEEF is about, and the BEEF.
fn subjectOf(a: std.mem.Allocator, bytes: []const u8) !struct { tx: Transaction, b: beef.Beef } {
    const b = try beef.parse(a, bytes);
    const s = b.subject() orelse return error.InvalidBeef;
    const e = b.find(s) orelse return error.InvalidBeef;
    return .{ .tx = try Transaction.parse(a, e.raw orelse return error.InvalidBeef), .b = b };
}

/// The claim input of a draft (the wallet's `createAction` answer, Atomic BEEF): the input whose
/// source, in the draft's BEEF, is a claim of ours; its index, the claim and the source output.
pub const Located = struct { index: usize, claim: Claim, script: []const u8, satoshis: u64, tx: Transaction };

pub fn locate(a: std.mem.Allocator, identity: [33]u8, draft: []const u8) !?Located {
    const d = try subjectOf(a, draft);
    for (d.tx.inputs, 0..) |in, i| {
        const e = d.b.find(in.previous_outpoint.txid.bytes) orelse continue;
        const st = Transaction.parse(a, e.raw orelse continue) catch continue;
        if (st.outputs.len == 0 or st.inputs.len == 0) continue;
        const ps = st.outputs[0].locking_script.bytes;
        const tok = mandala.brc162.decode(ps) orelse continue;
        const p = (pool.parse(tok.lock) catch null) orelse continue;
        if (!std.mem.eql(u8, &p.identity, &identity)) continue;
        const first = st.inputs[0].previous_outpoint;
        const vout = (try pool.verifiedClaim(a, st.outputs, p, ps, first.txid.bytes, first.index)) orelse continue;
        if (vout != in.previous_outpoint.index) continue;
        return .{
            .index = i,
            .claim = .{ .deploy = in.previous_outpoint.txid.bytes, .vout = vout, .key_op = .{ .txid = first.txid.bytes, .vout = first.index }, .asset_id = p.asset_id, .key = p.validator },
            .script = st.outputs[vout].locking_script.bytes,
            .satoshis = @intCast(st.outputs[vout].satoshis),
            .tx = d.tx,
        };
    }
    return null;
}

/// The claim input's unlocking script: the validator key's signature (through the signer) over
/// the draft's BIP-143 sighash (ALL|FORKID), and the key — P2PKH.
pub fn unlockClaim(a: std.mem.Allocator, l: Located, oracle: Oracle) ![]const u8 {
    const pre = try unlock.preimage(a, &l.tx, l.index, l.script, l.satoshis, unlock.sighash_all_forkid);
    const der = try oracle.sign(a, try keyId(a, l.claim.key_op), unlock.sha256d(pre));
    const sig = try std.mem.concat(a, u8, &.{ der, &.{@as(u8, unlock.sighash_all_forkid)} });
    if (!unlock.verify(sig, &l.claim.key, unlock.sha256d(pre), unlock.sighash_all_forkid)) return error.NotTheClaimKey;
    return std.mem.concat(a, u8, &.{ try unlock.pushData(a, sig), try unlock.pushData(a, &l.claim.key) });
}

/// The wallet's `signAction` body for a draft: `{reference, spends: {"<i>": {unlockingScript}}}`.
pub fn signBody(a: std.mem.Allocator, reference: []const u8, l: Located, oracle: Oracle) !Value {
    const u = try unlockClaim(a, l, oracle);
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "op", .value = .{ .text = "signAction" } },
        .{ .key = "reference", .value = .{ .cid = reference } },
        .{ .key = "spends", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = try std.fmt.allocPrint(a, "{d}", .{l.index}), .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "unlockingScript", .value = .{ .bytes = u } },
        }) } }}) } },
    }) };
}

/// Where a rescind is, from the wallet thread a step was stepped by (its `resolved`): the wallet's
/// result record (`wallet-result`, op `createAction` or `signAction`).
pub const Stage = union(enum) {
    /// The draft: `reference` and the draft's Atomic BEEF.
    draft: struct { reference: []const u8, tx: []const u8 },
    /// Signed: the final transaction, Atomic BEEF (noSend: the overlay's submission broadcasts it).
    signed: []const u8,
    failed: []const u8,
};

pub fn stageOf(result: Value) Stage {
    if (!std.mem.eql(u8, result.getText("kind") orelse "", "wallet-result")) return .{ .failed = "not a wallet result" };
    const op = result.getText("op") orelse "";
    const tx = result.getBytes("tx") orelse return .{ .failed = "the wallet answered no transaction" };
    if (std.mem.eql(u8, op, "createAction")) return .{ .draft = .{ .reference = result.getCid("reference") orelse return .{ .failed = "no draft: the wallet signed the claim input itself" }, .tx = tx } };
    if (std.mem.eql(u8, op, "signAction")) return .{ .signed = tx };
    return .{ .failed = "not a createAction or signAction result" };
}

/// The result record's CID a resolved thread printed: its update's `result` is `{exitCode, stdout,
/// stderr}` and a program's stdout the CID of the record it kept, hex (skein `vm.finish`).
pub fn resultCid(a: std.mem.Allocator, result: Value) !?[]const u8 {
    const out = result.getBytes("stdout") orelse return null;
    const hex = std.mem.trim(u8, out, " \r\n\t");
    if (hex.len == 0 or hex.len % 2 != 0) return null;
    const bytes = try a.alloc(u8, hex.len / 2);
    _ = std.fmt.hexToBytes(bytes, hex) catch return null;
    return bytes;
}

/// The topic the rescind is submitted for: the claim's token's.
pub fn topicOf(a: std.mem.Allocator, c: Claim) ![]u8 {
    return validator.topicOf(a, c.asset_id);
}
