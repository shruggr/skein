//! What the validator reads of its own overlay: the transactions it holds,
//! which inputs spend outputs live in a topic (BRC-22 previousCoins), and
//! who spent an admitted output. `View` is the interface the checks use;
//! `OverlayView` answers it from the instance's state — the app's overlay
//! state (`<app>/state`, skein-overlay's `State`, which the engine writes)
//! over the chain app's (`chain/state`, read only) — and the tests answer it
//! from memory.
const std = @import("std");
const w = @import("chain");
const mandala = @import("mandala");
const ov = @import("skein_overlay");

const bsvz = w.bsvz;
const Transaction = bsvz.transaction.Transaction;
const bsv21 = mandala.bsv21;

/// An outpoint; its text form is BRC-162's `<txid display hex>_<vout>`,
/// the same string as the validator key ID.
pub const Outpoint = struct {
    /// Internal byte order.
    txid: [32]u8,
    vout: u32,

    pub fn parse(text: []const u8) ?Outpoint {
        if (text.len < 66 or text[64] != '_') return null;
        const txid = w.header.fromHex(text[0..64]) catch return null;
        for (text[0..64]) |c| if (!std.ascii.isDigit(c) and !(c >= 'a' and c <= 'f')) return null;
        const digits = text[65..];
        if (digits.len == 0 or digits.len > 10 or (digits.len > 1 and digits[0] == '0')) return null;
        const vout = std.fmt.parseInt(u32, digits, 10) catch return null;
        return .{ .txid = txid, .vout = vout };
    }

    pub fn format(self: Outpoint, a: std.mem.Allocator) ![]u8 {
        return std.fmt.allocPrint(a, "{s}_{d}", .{ &w.header.toHex(self.txid), self.vout });
    }

    pub fn eql(self: Outpoint, o: Outpoint) bool {
        return self.vout == o.vout and std.mem.eql(u8, &self.txid, &o.txid);
    }
};

pub const View = struct {
    ptr: *anyopaque,
    rawTxFn: *const fn (ptr: *anyopaque, a: std.mem.Allocator, txid: [32]u8) anyerror!?[]const u8,
    previousCoinsFn: *const fn (ptr: *anyopaque, a: std.mem.Allocator, topic: []const u8, tx: Transaction) anyerror![]const u32,
    spenderFn: *const fn (ptr: *anyopaque, a: std.mem.Allocator, topic: []const u8, op: Outpoint) anyerror!?[32]u8,
    spendersFn: *const fn (ptr: *anyopaque, a: std.mem.Allocator, op: Outpoint) anyerror![]const [32]u8,

    /// A transaction the overlay holds.
    pub fn rawTx(self: View, a: std.mem.Allocator, txid: [32]u8) !?[]const u8 {
        return self.rawTxFn(self.ptr, a, txid);
    }

    /// A held transaction, parsed.
    pub fn tx(self: View, a: std.mem.Allocator, txid: [32]u8) !?Transaction {
        const raw = (try self.rawTx(a, txid)) orelse return null;
        return Transaction.parse(a, raw) catch null;
    }

    /// The output at an outpoint of a held transaction.
    pub fn output(self: View, a: std.mem.Allocator, op: Outpoint) !?bsv21.Output {
        const t = (try self.tx(a, op.txid)) orelse return null;
        if (op.vout >= t.outputs.len) return null;
        const o = t.outputs[op.vout];
        return .{ .script = o.locking_script.bytes, .satoshis = @intCast(o.satoshis) };
    }

    /// The inputs of `tx` spending outputs live in `topic`.
    pub fn previousCoins(self: View, a: std.mem.Allocator, topic: []const u8, t: Transaction) ![]const u32 {
        return self.previousCoinsFn(self.ptr, a, topic, t);
    }

    /// The held transaction (not rejected) spending an output admitted in `topic`, if any.
    pub fn spender(self: View, a: std.mem.Allocator, topic: []const u8, op: Outpoint) !?[32]u8 {
        return self.spenderFn(self.ptr, a, topic, op);
    }

    /// Every held transaction spending `op`, whatever its settlement
    /// (pending, admitted or rejected): how the answer after the step finds
    /// the signed transaction again (messages.zig `answerFromState`).
    pub fn spenders(self: View, a: std.mem.Allocator, op: Outpoint) ![]const [32]u8 {
        return self.spendersFn(self.ptr, a, op);
    }
};

/// The view over the app's overlay state and the chain state under it
/// (skein-overlay's `State`: the same maps the engine records its topics'
/// judgements in, and the chain app's records, read by CID).
pub const OverlayView = struct {
    st: *ov.state.State,

    fn rawTxImpl(ptr: *anyopaque, _: std.mem.Allocator, txid: [32]u8) anyerror!?[]const u8 {
        const self: *OverlayView = @ptrCast(@alignCast(ptr));
        return self.st.ch.txRaw(txid);
    }
    fn previousCoinsImpl(ptr: *anyopaque, _: std.mem.Allocator, topic: []const u8, t: Transaction) anyerror![]const u32 {
        const self: *OverlayView = @ptrCast(@alignCast(ptr));
        return self.st.previousCoins(topic, t);
    }
    fn spenderImpl(ptr: *anyopaque, _: std.mem.Allocator, topic: []const u8, op: Outpoint) anyerror!?[32]u8 {
        const self: *OverlayView = @ptrCast(@alignCast(ptr));
        const s = (try self.st.spender(topic, op.txid, op.vout)) orelse return null;
        return s.txid;
    }
    fn spendersImpl(ptr: *anyopaque, _: std.mem.Allocator, op: Outpoint) anyerror![]const [32]u8 {
        const self: *OverlayView = @ptrCast(@alignCast(ptr));
        return self.st.ch.spendersOf(w.store.outpointKey(op.txid, op.vout));
    }
    pub fn view(self: *OverlayView) View {
        return .{ .ptr = self, .rawTxFn = rawTxImpl, .previousCoinsFn = previousCoinsImpl, .spenderFn = spenderImpl, .spendersFn = spendersImpl };
    }
};
