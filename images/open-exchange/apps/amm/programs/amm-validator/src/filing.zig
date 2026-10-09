//! Filing the claim in the validator's wallet (skein-amm 0.9.0, David Case 2026-10-09: "the
//! validator CALLS the skein wallet program (call/launch with `{op: "internalize", …}` basket
//! insertion, skein docs/WALLET.md) to file the claim in a wallet basket, and spends it later as a
//! caller input (#93)"). The claim is locked to the pool's validator key, a key the wallet does
//! not hold as its own coin: basket insertion files it with what spends it — the BRC-43 protocol
//! (`[1, "amm pool"]`), the key ID (`<first token input>`), counterparty anyone — in
//! `customInstructions`, out of the default basket (the wallet never funds with it).
//!
//! main.zig launches the instance's genesis wallet program on `{body: <the internalize body>}` (the
//! args a message to the wallet's box carries), in the step that submits the claimed deploy.
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;

/// The wallet basket the claims are filed in, and their tag.
pub const basket = "amm-claims";
pub const tag = "amm-claim";

/// The claim's `customInstructions` (JSON text): how to spend it, and which claim it is.
pub fn customInstructions(a: std.mem.Allocator, key_id: []const u8, txid: [32]u8, vout: u32) ![]const u8 {
    return std.fmt.allocPrint(a, "{{\"protocolID\":[1,\"amm pool\"],\"keyID\":\"{s}\",\"counterparty\":\"anyone\",\"amm\":{{\"claim\":\"{s}.{d}\"}}}}", .{ key_id, &w.header.toHex(txid), vout });
}

/// The wallet's `internalize` body (skein docs/WALLET.md "The program"): the claimed deploy as
/// Atomic BEEF, its claim output inserted into `amm-claims`.
pub fn internalizeBody(a: std.mem.Allocator, atomic: []const u8, txid: [32]u8, vout: u32, key_id: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "op", .value = .{ .text = "internalize" } },
        .{ .key = "tx", .value = .{ .bytes = atomic } },
        .{ .key = "outputs", .value = .{ .array = try a.dupe(Value, &.{.{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "outputIndex", .value = .{ .uint = vout } },
            .{ .key = "protocol", .value = .{ .text = "basket insertion" } },
            .{ .key = "insertionRemittance", .value = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "basket", .value = .{ .text = basket } },
                .{ .key = "customInstructions", .value = .{ .text = try customInstructions(a, key_id, txid, vout) } },
                .{ .key = "tags", .value = .{ .array = try a.dupe(Value, &.{.{ .text = tag }}) } },
            }) } },
        }) }}) } },
        .{ .key = "description", .value = .{ .text = "AMM pool claim" } },
        .{ .key = "labels", .value = .{ .array = try a.dupe(Value, &.{.{ .text = tag }}) } },
    }) };
}

/// The genesis wallet program's record CID: the step input's `programs.wallet` (the genesis's
/// programs, skein docs/VM.md). Null when the instance has none.
pub fn walletProgram(in: Value) ?[]const u8 {
    const ps = in.get("programs") orelse return null;
    return ps.getCid("wallet");
}

/// The args record a wallet thread is launched on: `{body: <the body record>}` — what a message
/// to the wallet's box carries (the wallet reads `args.body`). Both records put in `s`. → its CID.
pub fn launchArgs(a: std.mem.Allocator, s: w.store.Store, body: Value) ![]const u8 {
    const bc = try s.putValue(a, body);
    return s.putValue(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "body", .value = .{ .cid = bc } }}) });
}
