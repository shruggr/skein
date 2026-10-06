//! Who passes the front door on an http row (#135, David 2026-10-07: "The
//! security boundary is signed or validatable. Validated."): a request is
//! admitted when it is SIGNED (the sender is a key) or VALIDATED (the payload
//! proves itself); a read needs neither (the host's second door, a call).
//!
//!   signed (any x-bsv-auth-* header): verified — the session and the
//!     signature, BRC-104 §6.4 — whatever the row's sender, `*` included, and
//!     answered signed on that session;
//!   unsigned: only on an open row (sender `*`) whose `filter` validates the
//!     payload (`beef`: the kernel's door checks every BUMP against the chain
//!     state; the transactions carry their own signatures; a payload that does
//!     not check is the door's refusal entry), answered plain, the handler
//!     given no caller; any other row refuses it 401 (the stock client shakes
//!     hands and signs).
//!
//! The row's sender says only which keys may reach the route (`*`: any key
//! with a session, or no key at all where the filter validates); it has
//! nothing to do with how the wire is answered. Pure: no imports but std, so
//! `zig build test` runs it natively.
const std = @import("std");

pub const Gate = enum {
    /// verify the session and the signature; the answer is signed on the session
    verify,
    /// an unsigned request on an open route whose filter validates the payload: no caller, a plain answer
    plain,
    /// 401: the route needs a session
    refuse,
};

/// A BRC-104 header (`x-bsv-auth-*`, any case): a request carrying one is a general message, verified.
pub fn isAuthHeader(name: []const u8) bool {
    return std.ascii.startsWithIgnoreCase(name, "x-bsv-auth-");
}

/// The door filters that prove a payload (kernel-zig/src/door.zig): `beef`, every BUMP checked against the chain state.
pub const validating = [_][]const u8{"beef"};

/// Whether a row's `filter` validates the payload (null: the row names none).
pub fn validates(filter: ?[]const u8) bool {
    const f = filter orelse return false;
    for (validating) |v| if (std.mem.eql(u8, v, f)) return true;
    return false;
}

/// The gate for a request on a row the kernel matched: `open` the row's sender is `*`, `validated`
/// its filter validates the payload, `signed` the request carries x-bsv-auth-* headers.
pub fn gate(open: bool, validated: bool, signed: bool) Gate {
    if (signed) return .verify;
    if (open and validated) return .plain;
    return .refuse;
}

test "a signed request is verified and answered signed, whatever the row" {
    try std.testing.expectEqual(Gate.verify, gate(true, true, true));
    try std.testing.expectEqual(Gate.verify, gate(true, false, true));
    try std.testing.expectEqual(Gate.verify, gate(false, true, true));
    try std.testing.expectEqual(Gate.verify, gate(false, false, true));
}

test "an unsigned request on an open row whose filter validates is answered plain" {
    try std.testing.expectEqual(Gate.plain, gate(true, true, false));
}

test "an unsigned request on an open row without a validating filter is refused" {
    try std.testing.expectEqual(Gate.refuse, gate(true, false, false));
}

test "an unsigned request on a row that is not open is refused, a validating filter or not" {
    try std.testing.expectEqual(Gate.refuse, gate(false, true, false));
    try std.testing.expectEqual(Gate.refuse, gate(false, false, false));
}

test "the validating filters: beef; none, or another name, is not" {
    try std.testing.expect(validates("beef"));
    try std.testing.expect(!validates(null));
    try std.testing.expect(!validates(""));
    try std.testing.expect(!validates("BEEF"));
}

test "the BRC-104 headers, any case; others are not" {
    try std.testing.expect(isAuthHeader("x-bsv-auth-request-id"));
    try std.testing.expect(isAuthHeader("X-BSV-Auth-Signature"));
    try std.testing.expect(!isAuthHeader("x-bsv-topic"));
    try std.testing.expect(!isAuthHeader("x-topics"));
}
