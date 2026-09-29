//! wire-probe: a test program for the wallet wire import
//! (src/runtime/program.test.ts). One step: getPublicKey (identity) and
//! createSignature (protocol [2, "skein probe"], key "1", anyone) over the
//! bytes of its input entry's CID, both as BRC-100 wire frames through the
//! `wallet` import; puts {kind: "probe", identityKey, signature} and prints
//! the record's CID in hex. Not in the genesis.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const brc = @import("brc104");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;

pub fn main() u8 {
    return sk.main("wire-probe", run);
}

fn run(a: Allocator) !void {
    const in = try sk.input(a);
    const entry = Value.cidOf(in.get("entry")) orelse return sk.report("the input names no entry");
    const pk = brc.identityKey(a) catch |e| return sk.wrap(a, "getPublicKey", e);
    const sig = brc.createSignature(a, "skein probe", "1", .anyone, entry) catch |e| return sk.wrap(a, "createSignature", e);
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("probe"));
    try m.put("identityKey", cbor.string(try sk.hex(a, pk)));
    try m.put("signature", .{ .bytes = sig });
    const c = try sk.put(a, m.value());
    try std.Io.File.stdout().writeStreamingAll(sk.io(), try std.fmt.allocPrint(a, "{s}\n", .{try sk.hex(a, c)}));
}
