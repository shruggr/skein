//! The validator's keys, through the instance's signer: the `wallet`
//! import (BRC-100 wire frames, skein-sdk `wallet` module's `wire`). No key
//! enters the runtime; the signer sees a key reference and a 32-byte hash.
//!
//! The validator's rotating signing key is BRC-43 security level 1,
//! protocol `amm pool`, key ID `<txid display hex>_<vout>`, counterparty
//! `anyone` (src/pool.zig, `validator_protocol` and
//! `keyId`): the child of the instance's root identity key, which is the
//! pool's ValidatorIdentity.
const std = @import("std");
const wire = @import("wallet").wire;

const protocol = @import("pool").validator_protocol;

pub const Oracle = struct {
    ptr: *anyopaque,
    /// A request frame → its result frame (the `wallet` import in the VM).
    callFn: *const fn (ptr: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8,

    fn call(self: Oracle, a: std.mem.Allocator, frame: []const u8) ![]const u8 {
        return self.callFn(self.ptr, a, frame);
    }

    /// The root identity key.
    pub fn identity(self: Oracle, a: std.mem.Allocator) ![33]u8 {
        return wire.publicKeyResult(try self.call(a, try wire.identityKeyFrame(a)));
    }

    /// The validator signing key for `key_id` (forSelf: the key we sign with).
    pub fn publicKey(self: Oracle, a: std.mem.Allocator, key_id: []const u8) ![33]u8 {
        return wire.publicKeyResult(try self.call(a, try wire.getPublicKeyFrameFor(a, protocol.security_level, protocol.name, key_id, .anyone, true)));
    }

    /// A DER signature of `hash` (signed as is) by the key for `key_id`.
    pub fn sign(self: Oracle, a: std.mem.Allocator, key_id: []const u8, hash: [32]u8) ![]const u8 {
        return wire.signatureResult(try self.call(a, try wire.createSignatureFrame(a, protocol.security_level, protocol.name, key_id, .anyone, hash)));
    }
};
