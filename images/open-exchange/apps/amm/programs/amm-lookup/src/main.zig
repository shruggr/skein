//! amm-lookup: `ls_amm`, the AMM pool liquidity lookup service (skein-overlay's
//! lookup contract, the `lookup` module), over every Mandala token topic the
//! overlay serves. Its metadata and documentation answer the overlay's listing and
//! documentation routes (skein-overlay#2). See README.md.
const std = @import("std");
const idx = @import("index.zig");
const lookup = @import("lookup");

pub const version = "0.1.0";

pub fn metadata(_: std.mem.Allocator, _: []const u8) anyerror!lookup.Metadata {
    return .{
        .short_description = "AMM pools (the Pool contract over Mandala tokens): the live pools of a token, one pool or its newest continuation, a validator's pools.",
        .version = version,
        .information_url = "https://github.com/shruggr/skein-amm",
    };
}

pub fn documentation(_: std.mem.Allocator, _: []const u8) anyerror![]const u8 {
    return
    \\# AMM pools (ls_amm)
    \\
    \\The live pools of the AMM's Pool contract, over every Mandala token topic this
    \\overlay serves (`tm_mandala_<txid>_<vout>`). A pool is a BRC-162 value output at output 0 whose
    \\lock is the compiled Pool code followed by its state; it is listed when its
    \\prefix agrees with the asset id and the TokenReserve its code and state carry.
    \\
    \\Every query names its token, `tokenId` (`<txid>`, `<txid>_<vout>` or `<txid>.<vout>`,
    \\the deploy outpoint):
    \\
    \\- `{tokenId}`: every live pool of the token, as
    \\  `{outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps,
    \\  commissionBps, validatorIdentityKey, lastSeen?}` (freeform);
    \\- `{tokenId, outpoint}`: that pool, or its newest continuation,
    \\  `{current, hops}` (freeform); with `beef: true`, the pool output and its
    \\  transaction's BEEF (output-list);
    \\- `{tokenId, validatorIdentityKey}`: that validator's live pools of the token.
    \\
    ;
}

pub fn main() u8 {
    return lookup.main(idx.spec);
}
