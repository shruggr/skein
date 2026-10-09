//! Getting a signed transaction into this instance's own overlay: the
//! validator only adds its signature; the submission is the overlay engine's
//! (skein-overlay 0.7.5 docs/OVERLAY.md "Submitting", shruggr/skein#112). A
//! submission is a message: the validator sends `{fn: "submit", args: {beef,
//! topics: [tm_mandala_<txid>_0]}}` from this instance to itself, in the submissions
//! box `<app>/submit` (the manifest's row `submit` from `*` takes it to the
//! engine; shruggr/skein#128: one box per function class), with the
//! signed BEEF — the request's BEEF (the taker's ancestry and BUMPs) with its
//! subject replaced by the signed transaction (`submissionBeef`). The engine
//! routes it in its step on the message (decoded, checked against the chain
//! app's headers and SPV, judged by the topic's program; lacking a parent,
//! paused until one comes) and answers the sender, in the box it wrote to,
//! by message: `{fn: "submit", request, replyTo, result}` — `admitted`
//! (status `pending`, the STEAK) once the chain app accepts it, then each
//! `proven`, or `rejected` — or `error` for a body not that shape.
//!
//! main.zig awaits the message and answers the direct call `{wait: true}`;
//! called again with the engine's first answer (`reply`), it answers from
//! that (messages.zig `answerFromSubmit`).
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;
const beef = w.beef;

/// The box a submission goes to: `<app>/submit` (the manifest's mailbox address `submit`).
pub fn box(a: std.mem.Allocator, app: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "{s}/submit", .{app});
}

/// The submission message's body: `{fn: "submit", args: {beef: <bytes>, topics: [topic]}}`.
pub fn body(a: std.mem.Allocator, signed_beef: []const u8, topic: []const u8) !Value {
    return .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = "submit" } },
        .{ .key = "args", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "beef", .value = .{ .bytes = signed_beef } },
            .{ .key = "topics", .value = .{ .array = try a.dupe(Value, &.{.{ .text = topic }}) } },
        }) } },
    }) };
}

/// The signed BEEF, what a submission carries: the request's with its
/// subject replaced by the signed transaction (same place, parents first,
/// its BUMPs kept), or a V1 BEEF of the signed transaction alone (a raw
/// request), which an overlay accepts only if it holds every parent
/// (docs/OVERLAY.md: "every other transaction's inputs come from a
/// transaction decoded before it or held").
pub fn submissionBeef(a: std.mem.Allocator, signed: []const u8, ancestry: ?beef.Beef) ![]u8 {
    const txid = beef.txidOf(signed);
    const parsed = try w.bsvz.transaction.Transaction.parse(a, signed);
    const b = ancestry orelse return beef.serialize(a, .{
        .version = beef.V1,
        .bumps = &.{},
        .entries = try a.dupe(beef.Entry, &.{.{ .txid = txid, .format = .raw, .raw = signed, .tx = parsed }}),
    });
    const subject = b.subject() orelse return error.InvalidBeef;
    const entries = try a.dupe(beef.Entry, b.entries);
    const i = b.indexOf(subject) orelse return error.InvalidBeef;
    entries[i] = .{ .txid = txid, .format = .raw, .raw = signed, .tx = parsed };
    var out = b;
    out.entries = entries;
    if (out.atomic != null) out.atomic = txid;
    return beef.serialize(a, out);
}

/// The transaction as Atomic BEEF (BRC-95), what the wallet's `internalize` takes: its ancestry
/// (the request's BEEF, the subject replaced) with `signed` as the atomic subject, or the
/// transaction alone when the request was raw.
pub fn atomicBeef(a: std.mem.Allocator, signed: []const u8, ancestry: ?beef.Beef) ![]u8 {
    const txid = beef.txidOf(signed);
    const parsed = try w.bsvz.transaction.Transaction.parse(a, signed);
    const entry: beef.Entry = .{ .txid = txid, .format = .raw, .raw = signed, .tx = parsed };
    const b = ancestry orelse return beef.serialize(a, .{ .version = beef.V2, .atomic = txid, .bumps = &.{}, .entries = try a.dupe(beef.Entry, &.{entry}) });
    const subject = b.subject() orelse return error.InvalidBeef;
    const entries = try a.dupe(beef.Entry, b.entries);
    const i = b.indexOf(subject) orelse return error.InvalidBeef;
    entries[i] = entry;
    var out = b;
    out.entries = entries;
    out.version = beef.V2;
    out.atomic = txid;
    out.form = .atomic;
    out.vout = null;
    return beef.serialize(a, out);
}
