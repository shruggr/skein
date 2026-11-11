//! A test caller (kernel-zig/equiv/chain-proof-events.ts, chain-bundle.ts; not shipped): a message in box `ingester` {beef} (the door's envelope)
//! → an in-VM call of the chain app's `ingest` in this step; the answer (or the error) kept.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const Value = cbor.Value;

pub fn main() u8 {
    return sk.main("ingester", run);
}

fn run(a: std.mem.Allocator) !void {
    const in = try sk.input(a);
    const args = in.get("args") orelse return error.BadInput;
    const body = try sk.get(a, Value.cidOf(args.get("body")) orelse return error.BadInput);
    const app = try sk.get(a, (try sk.head(a, "chain/app")) orelse return error.NoChainApp);
    const prog = Value.cidOf(app.get("programs").?.get("chain")) orelse return error.NoChainProgram;
    var m = cbor.MapBuilder.init(a);
    try m.put("kind", cbor.string("ingester-result"));
    if (sk.callValue(a, prog, "ingest", .{ .map = &.{.{ .key = "beef", .value = body.get("beef").? }} })) |ans| {
        try m.put("answer", ans);
    } else |_| {
        try m.put("error", cbor.string(sk.lastError()));
    }
    const c = try sk.put(a, m.value());
    try sk.keep(c);
    try std.Io.File.stdout().writeStreamingAll(sk.io(), try std.mem.concat(a, u8, &.{ try sk.hex(a, c), "\n" }));
}
