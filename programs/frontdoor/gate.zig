//! Who passes the front door on an http row (decided 2026-10-07, the rule as
//! it was always stated): a signed request gets a signed answer.
//!
//!   signed (any x-bsv-auth-* header): verified — the session and the
//!     signature, BRC-104 §6.4 — whatever the row's sender, `*` included, and
//!     answered signed on that session;
//!   unsigned: only on an open row (sender `*`), answered plain, the handler
//!     given no caller; any other row refuses it 401 (the stock client shakes
//!     hands and signs).
//!
//! The row's sender says only which keys may reach the route (`*`: any key
//! with a session, or no key at all); it has nothing to do with how the wire
//! is answered. Pure: no imports but std, so `zig build test` runs it natively.
const std = @import("std");

pub const Gate = enum {
    /// verify the session and the signature; the answer is signed on the session
    verify,
    /// an unsigned request on an open route: no caller, a plain answer
    plain,
    /// 401: the route needs a session
    refuse,
};

/// A BRC-104 header (`x-bsv-auth-*`, any case): a request carrying one is a general message, verified.
pub fn isAuthHeader(name: []const u8) bool {
    return std.ascii.startsWithIgnoreCase(name, "x-bsv-auth-");
}

/// The gate for a request on a row the kernel matched: `open` the row's sender is `*`, `signed` the request carries x-bsv-auth-* headers.
pub fn gate(open: bool, signed: bool) Gate {
    if (signed) return .verify;
    if (open) return .plain;
    return .refuse;
}

test "a signed request on an open row is verified and answered signed" {
    try std.testing.expectEqual(Gate.verify, gate(true, true));
}

test "an unsigned request on an open row is answered plain" {
    try std.testing.expectEqual(Gate.plain, gate(true, false));
}

test "a row that is not open: a signed request verified, an unsigned one refused" {
    try std.testing.expectEqual(Gate.verify, gate(false, true));
    try std.testing.expectEqual(Gate.refuse, gate(false, false));
}

test "the BRC-104 headers, any case; others are not" {
    try std.testing.expect(isAuthHeader("x-bsv-auth-request-id"));
    try std.testing.expect(isAuthHeader("X-BSV-Auth-Signature"));
    try std.testing.expect(!isAuthHeader("x-bsv-topic"));
    try std.testing.expect(!isAuthHeader("x-topics"));
}
