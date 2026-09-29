//! objects-handler: the handler program for the `objects` box.
//!
//! The admitted body is a dag-cbor bundle {records: [{cid, bytes}], root?} of
//! at most 1 MiB; the client chunks larger sets across messages. Each record is
//! stored under its CID with putblock (the kernel checks the hash: git-raw/sha1,
//! raw or dag-cbor/sha2-256). A bundle naming a root (the client names it on the
//! last one) makes that tree the `main` head if the instance has none yet.
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;

pub fn main() u8 {
    return sk.main("objects-handler", run);
}

fn run(a: Allocator) !void {
    step(a) catch |e| return sk.plain(e);
}

fn step(a: Allocator) !void {
    const in = try sk.input(a);
    const args: Value = in.get("args") orelse .null;
    const b = try sk.readBody(a, try sk.linkField(args, "message"), try sk.linkField(args, "body"));
    const records = sk.listField(b, "records") catch |e| return sk.wrap(a, "bundle", e);
    const root = sk.linkField(b, "root") catch |e| return sk.wrap(a, "bundle", e);
    for (records, 0..) |r, i| {
        const c = sk.linkField(r, "cid") catch |e| return sk.wrap(a, "bundle", e);
        const bytes: []const u8 = switch (r.get("bytes") orelse Value.null) {
            .null => "",
            .bytes => |x| x,
            else => return sk.report("bundle: bytes: not bytes"),
        };
        sk.putBlock(c, bytes) catch |e| return sk.wrap(a, try std.fmt.allocPrint(a, "record {d}", .{i}), e);
    }
    if (root.len == 0) return;
    if (try sk.head(a, "main") != null) return;
    try sk.advance("main", root);
}
