//! wallet: the handler program for the `wallet` box (issues #29, #79), a
//! wasm32-wasi command stepped with the `skein` imports (kernel-zig
//! program.zig). One run is one step over one input: an owner's message
//! (args.body), or — for a thread resting on the chain app — the chain app's
//! answer to its `ingest` (input.reply).
//!
//! **The wallet keeps its own records, the chain is the chain app's** (#79):
//! its state is the head `wallet/state` (the name rule: an app writes only
//! heads under its own name), a `wallet-state` record whose maps are
//!
//!   actions    txid → action record                     our transactions
//!   outputs    txid ‖ vout (u32 BE) → output record      our coins (output records: basket, derivation, `tx`)
//!   byBasket   len ‖ basket ‖ outpoint → null            our coins by basket
//!   spent      txid ‖ vout → spending txid (bytes)       the inputs our own actions consumed
//!   drafts     draft CID → null                          signable drafts (signAndProcess: false)
//!
//! It holds no headers, proofs, spends or settlement, and never broadcasts.
//! The chain state — headers, transactions, proofs, spends, settlement,
//! broadcasts — is the chain app's (shruggr/skein-chain, the head
//! `chain/state`), which the wallet reads by CID (`head` + `get`, the SDK's
//! `chain.state.State`, read only). What it computes from it, at read time,
//! never stored: a coin's status (its transaction proven, unproven or
//! rejected), whether it is spent (by one of our actions not rejected, or
//! by any held, non-rejected spender the chain state knows), whether it is
//! live (its transaction not rejected: a rejected transaction's coins
//! vanish, the inputs it consumed are spendable again).
//!
//! A transaction goes to the chain app as a message (#79): the wallet emits
//! `{fn: "ingest", args: {beef}}` to the instance itself (the host's
//! loopback) in box `chain`, which the chain app takes from `$self`, and
//! ends its step awaiting the message. The chain app records it (SPV against
//! the instance's headers), broadcasts it if it is unproven (it is the only
//! broadcaster), and answers on each change: `accepted` (the first status
//! that is not a rejection), `proven`, `rejected` (a status, a double spend,
//! abandonment) — each answer steps this thread again (`op: "callback"`);
//! `accepted` waits on, `proven` and `rejected` end it.
//!
//! Body operations (dag-cbor; docs/WALLET.md):
//!   {op: "internalize", tx, outputs, description, labels?}   BRC-100 internalizeAction (Atomic BEEF)
//!   {op: "createAction", description, outputs, labels?, options?: {signAndProcess?, noSend?}}   BRC-100 createAction
//!   {op: "signAction", reference}                BRC-100 signAction for a draft (signAndProcess: false)
//!   {op: "list", basket?, includeSpent?}        our outputs in a basket (default "default")
//!
//! A route's function (#144): fn `internalize` on the route of the box BRC-169 deliveries come
//! in (`metanet_inbox`): the message must be a BRC-169 envelope's (its record names the signed
//! part, `envelope`) and its plaintext a BRC-232 transaction delivery (deliveryOf); its `wallet
//! payment` outputs are internalized. No other operation is reached that way.
//!
//! Billing (#130), one more:
//!   args {pay: {to, x, checkpoint}}   the kernel's pay step — a thread the kernel launches itself
//!                                     when the allocation is consumed (its origin's launchedBy is
//!                                     the entry it processes; anything else is refused): pay the host
//!                                     `to` (a BRC-29 key derived for it, counterparty the host) X sats,
//!                                     or all we have if less, in one transaction whose other output,
//!                                     0 sats, is `OP_FALSE OP_RETURN <checkpoint>` (the state record
//!                                     CID); emit it as the event `payment` {txid, tx (Atomic BEEF),
//!                                     outputIndex, amount, to, remittance, checkpoint} — the host's to
//!                                     take — and ingest it at the chain app as any other. Nothing to
//!                                     pay: no event (the kernel puts the instance to sleep).
//!
//! Recorded calls: the signer over the `wallet` import (getPublicKey,
//! createSignature: no key is ever here). Every step stores a result record,
//! keeps it in the thread, and prints its CID (hex) on stdout; the result
//! names the transactions it is about as `refs` with rel `mentions`.
const std = @import("std");
const w = @import("wallet");

const cbor = w.cbor;
const Value = cbor.Value;
const Store = w.store.Store;
const Map = w.store.Map;
const ChainState = w.chainstate.State;
const Transaction = w.bsvz.transaction.Transaction;
const eql = std.mem.eql;

/// The skein calls: the preview1 `skein` imports, or (the component build, issue
/// #34) the same calls over the WIT interface skein:kernel/skein (the SDK's `skein_wit`).
const component = @import("build_options").component;
const sk = if (component) @import("skein_wit") else struct {
    extern "skein" fn input(out: [*]u8, cap: u32) i32;
    extern "skein" fn get(cid: [*]const u8, cid_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn put(data: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn putblock(cid: [*]const u8, cid_len: u32, data: [*]const u8, len: u32) i32;
    extern "skein" fn keep(cid: [*]const u8, cid_len: u32) i32;
    extern "skein" fn head(name: [*]const u8, name_len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn advance(name: [*]const u8, name_len: u32, tree: [*]const u8, tree_len: u32) i32;
    extern "skein" fn wallet(frame: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn emit(msg: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
    extern "skein" fn @"await"(cid: [*]const u8, cid_len: u32) i32;
    extern "skein" fn take(out: [*]u8, cap: u32) i32;
    extern "skein" fn @"error"(out: [*]u8, cap: u32) i32;
    extern "skein" fn edges(to: [*]const u8, to_len: u32, rel: [*]const u8, rel_len: u32, out: [*]u8, cap: u32) i32;
};

var last_error: [1024]u8 = undefined;
var last_error_len: usize = 0;

fn failed() error{ImportFailed} {
    const n = sk.@"error"(&last_error, last_error.len);
    last_error_len = if (n < 0) 0 else @min(@as(usize, @intCast(n)), last_error.len);
    return error.ImportFailed;
}

/// Run an import that writes (out, cap), taking the held result when it did not fit.
fn result(arena: std.mem.Allocator, call: anytype, args: anytype) ![]u8 {
    var buf = try arena.alloc(u8, 4096);
    const n = @call(.auto, call, args ++ .{ buf.ptr, @as(u32, @intCast(buf.len)) });
    if (n < 0) return failed();
    const len: usize = @intCast(n);
    if (len <= buf.len) return buf[0..len];
    buf = try arena.alloc(u8, len);
    if (sk.take(buf.ptr, @intCast(len)) != n) return failed();
    return buf;
}

const VmStore = struct {
    fn getImpl(_: *anyopaque, arena: std.mem.Allocator, cid: []const u8) anyerror![]const u8 {
        return result(arena, sk.get, .{ cid.ptr, @as(u32, @intCast(cid.len)) });
    }
    fn putImpl(_: *anyopaque, arena: std.mem.Allocator, bytes: []const u8) anyerror![]const u8 {
        return result(arena, sk.put, .{ bytes.ptr, @as(u32, @intCast(bytes.len)) });
    }
    fn putBlockImpl(_: *anyopaque, cid: []const u8, bytes: []const u8) anyerror!void {
        if (sk.putblock(cid.ptr, @intCast(cid.len), bytes.ptr, @intCast(bytes.len)) < 0) return failed();
    }
    fn keepImpl(_: *anyopaque, cid: []const u8) anyerror!void {
        if (sk.keep(cid.ptr, @intCast(cid.len)) < 0) return failed();
    }
    fn edgesImpl(_: *anyopaque, arena: std.mem.Allocator, to: []const u8, rel: ?[]const u8) anyerror![]const w.store.Edge {
        const r = rel orelse "";
        return w.store.decodeEdges(arena, try result(arena, sk.edges, .{ to.ptr, @as(u32, @intCast(to.len)), r.ptr, @as(u32, @intCast(r.len)) }));
    }
    var dummy: u8 = 0;
    fn store() Store {
        return .{ .ptr = &dummy, .getFn = getImpl, .putFn = putImpl, .putBlockFn = putBlockImpl, .keepFn = keepImpl, .edgesFn = edgesImpl };
    }
};

/// The signer over the `wallet` import (getPublicKey, createSignature).
const VmSigner = struct {
    var dummy: u8 = 0;
    fn derive(_: *anyopaque, arena: std.mem.Allocator, key_id: []const u8, sender: [33]u8) anyerror![33]u8 {
        const frame = try w.wire.getPublicKeyFrame(arena, w.brc29.security_level, w.brc29.protocol_name, key_id, sender, true);
        const res = try result(arena, sk.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
        return w.wire.publicKeyResult(res) catch |e| {
            if (w.wire.errorMessage(res)) |m| std.log.err("oracle: {s}", .{m});
            return e;
        };
    }
    /// A wire frame to the signer and its result frame (getPublicKey, createSignature: attested).
    fn call(_: *anyopaque, arena: std.mem.Allocator, frame: []const u8) anyerror![]const u8 {
        const res = try result(arena, sk.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
        if (w.wire.errorMessage(res)) |m| std.log.err("oracle: {s}", .{m});
        return res;
    }
};

/// The wallet's head (#79: under its own name) and the chain app's, which it reads.
const head_name = "wallet/state";
const chain_head = "chain/state";
/// The chain app's box: an `ingest` goes there, to the instance itself.
const chain_box = "chain";

pub fn main() u8 {
    var arena_state = std.heap.ArenaAllocator.init(std.heap.wasm_allocator);
    defer arena_state.deinit();
    run(arena_state.allocator()) catch |e| {
        var buf: [1400]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "wallet: {s}{s}{s}\n", .{ @errorName(e), if (last_error_len > 0) ": " else "", last_error[0..last_error_len] }) catch "wallet: error\n";
        std.Io.File.stderr().writeStreamingAll(io(), msg) catch {};
        return 1;
    };
    return 0;
}

/// The program's Io: one single-threaded WASI process, no concurrency.
fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

/// The thread's random: the kernel's random_get, keyed by the entry, so a replay draws the same.
fn threadRandom(out: []u8) void {
    io().randomSecure(out) catch @panic("random_get failed");
}

fn hexAlloc(arena: std.mem.Allocator, b: []const u8) ![]u8 {
    const out = try arena.alloc(u8, b.len * 2);
    for (b, 0..) |x, i| _ = std.fmt.bufPrint(out[2 * i ..][0..2], "{x:0>2}", .{x}) catch unreachable;
    return out;
}

fn field(v: Value, key: []const u8) !Value {
    return v.get(key) orelse {
        std.log.err("body: missing {s}", .{key});
        return error.BadBody;
    };
}

fn textList(arena: std.mem.Allocator, v: ?Value) ![]const []const u8 {
    const items = if (v) |x| (if (x == .array) x.array else return error.BadBody) else return &.{};
    const out = try arena.alloc([]const u8, items.len);
    for (items, out) |it, *o| o.* = if (it == .text) it.text else return error.BadBody;
    return out;
}

fn headOf(a: std.mem.Allocator, name: []const u8) !?[]const u8 {
    const c = try result(a, sk.head, .{ name.ptr, @as(u32, @intCast(name.len)) });
    return if (c.len > 0) c else null;
}

// ---------------------------------------------------------------- the wallet's records, over the chain state

const map_names = [_][]const u8{ "actions", "outputs", "byBasket", "spent", "drafts" };

/// How a transaction stands, as the wallet sees it: the chain state's word when it holds it, else
/// `unproven` (not yet ingested: our own, on its way to the chain app).
const Status = enum { proven, unproven, rejected };

const Wallet = struct {
    a: std.mem.Allocator,
    s: Store,
    network: w.chain.Network,
    m: [map_names.len]Map,
    /// The chain app's state, read only (null: no chain app yet).
    chain: ?ChainState,
    chain_cid: ?[]const u8,

    fn load(a: std.mem.Allocator, s: Store, state: ?[]const u8, chain_cid: ?[]const u8, net_default: w.chain.Network) !Wallet {
        const maps = try w.store.Maps.create(a, s);
        var network = net_default;
        var chain: ?ChainState = null;
        if (chain_cid) |c| {
            const rec = try s.getValue(a, c);
            network = w.chain.Network.parse(rec.getText("network") orelse "") orelse return error.BadChainState;
            chain = try ChainState.load(a, s, c, network);
        }
        var roots: ?Value = null;
        if (state) |c| {
            const v = try s.getValue(a, c);
            if (!eql(u8, v.getText("kind") orelse "", "wallet-state")) return error.BadState;
            if (!eql(u8, v.getText("network") orelse "", @tagName(network))) return error.NetworkMismatch;
            roots = v.get("maps") orelse return error.BadState;
        }
        var self = Wallet{ .a = a, .s = s, .network = network, .m = undefined, .chain = chain, .chain_cid = chain_cid };
        for (map_names, 0..) |n, i| self.m[i] = maps.map(if (roots) |r| r.getCid(n) else null);
        return self;
    }

    fn map(self: *Wallet, comptime name: []const u8) *Map {
        inline for (map_names, 0..) |n, i| if (comptime eql(u8, n, name)) return &self.m[i];
        @compileError("no map " ++ name);
    }

    fn chainOrFail(self: *Wallet) !*ChainState {
        if (self.chain) |*c| return c;
        std.log.err("no chain state (head {s}): install the chain app (shruggr/skein-chain)", .{chain_head});
        return error.NoChainState;
    }

    /// Flush the maps and put a state record naming their roots (and the chain state it was read against).
    fn save(self: *Wallet) ![]const u8 {
        const es = try self.a.alloc(cbor.Entry, map_names.len);
        for (map_names, &self.m, es) |n, *mp, *e| {
            try mp.flush();
            e.* = .{ .key = n, .value = if (mp.root) |r| .{ .cid = r } else .null };
        }
        return self.s.putValue(self.a, .{ .map = try self.a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "wallet-state" } },
            .{ .key = "network", .value = .{ .text = @tagName(self.network) } },
            .{ .key = "chain", .value = if (self.chain_cid) |c| .{ .cid = c } else .null },
            .{ .key = "maps", .value = .{ .map = es } },
        }) });
    }

    fn record(self: *Wallet, cid: []const u8) !Value {
        return self.s.getValue(self.a, cid);
    }

    /// A transaction's bytes: the chain state's, else the store's (our own, put when we built it).
    fn txRaw(self: *Wallet, txid: [32]u8) !?[]const u8 {
        if (self.chain) |*c| if (try c.txRaw(txid)) |r| return r;
        return self.s.tryGet(self.a, &w.store.hashCid(.tx, txid));
    }

    fn status(self: *Wallet, txid: [32]u8) !Status {
        const c = if (self.chain) |*x| x else return .unproven;
        if (!(try c.holds(txid))) return .unproven;
        return switch (try c.status(txid)) {
            .proven => .proven,
            .unproven => .unproven,
            .rejected => .rejected,
        };
    }

    /// Spent: by an action of ours not rejected, or by a held, non-rejected spender the chain state knows.
    fn isSpent(self: *Wallet, op: [36]u8) !bool {
        if (try self.map("spent").get(&op)) |v| {
            if (v == .bytes and v.bytes.len == 32 and (try self.status(v.bytes[0..32].*)) != .rejected) return true;
        }
        if (self.chain) |*c| if ((try c.spentBy(op[0..32].*, std.mem.readInt(u32, op[32..36], .big))) != null) return true;
        return false;
    }

    /// An output record of ours, in its basket.
    fn putOutput(self: *Wallet, txid: [32]u8, vout: u32, rec: Value) !void {
        const op = w.store.outpointKey(txid, vout);
        try self.map("outputs").putLink(&op, try self.s.putValue(self.a, rec));
        const basket = rec.getText("basket") orelse return error.BadRecord;
        try self.map("byBasket").add(try w.store.nameKey(self.a, basket, &.{&op}));
    }

    /// An action (a transaction of ours), unless we already hold one for the txid.
    fn putAction(self: *Wallet, txid: [32]u8, tx_cid: []const u8, description: []const u8, labels: []const []const u8, extra: ?[]const cbor.Entry) !void {
        if (try self.map("actions").has(&txid)) return;
        const a = self.a;
        var fields: std.ArrayList(cbor.Entry) = .empty;
        try fields.appendSlice(a, &.{
            .{ .key = "kind", .value = .{ .text = "action" } },
            .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(txid)) } },
            .{ .key = "tx", .value = .{ .cid = tx_cid } },
            .{ .key = "description", .value = .{ .text = description } },
            .{ .key = "labels", .value = .{ .array = try w.wallet.textArray(a, labels) } },
        });
        if (extra) |x| try fields.appendSlice(a, x);
        try self.map("actions").putLink(&txid, try self.s.putValue(a, .{ .map = fields.items }));
    }

    const OutputView = struct { txid: [32]u8, vout: u32, satoshis: u64, locking_script: []const u8, spendable: bool, status: Status, record: Value };

    /// A basket's live outputs (their transactions not rejected), spendable ones only unless
    /// `include_spent`. The order is the one the wallet always listed in: the spendable ones first,
    /// then (with `include_spent`) the spent ones, each in outpoint order (the `byBasket` map's key
    /// order). Spent-ness is read from the chain state now, not a key prefix, so it takes two passes;
    /// in one pass the order would follow the txids alone, which differ from run to run (a change key
    /// is drawn from the thread's random).
    fn listOutputs(self: *Wallet, basket: []const u8, include_spent: bool) ![]OutputView {
        const a = self.a;
        var out: std.ArrayList(OutputView) = .empty;
        const prefix = try w.store.nameKey(a, basket, &.{});
        const kvs = try self.map("byBasket").prefixed(prefix);
        for ([_]bool{ false, true }) |pass_spent| for (kvs) |kv| {
            if (pass_spent and !include_spent) break;
            const o = try w.store.outpointOf(kv.key[prefix.len..]);
            const st = try self.status(o.txid);
            if (st == .rejected) continue;
            const op = w.store.outpointKey(o.txid, o.vout);
            const spent = try self.isSpent(op);
            if (spent != pass_spent) continue;
            const raw = (try self.txRaw(o.txid)) orelse return error.BadRecord;
            const tx = try Transaction.parse(a, raw);
            if (o.vout >= tx.outputs.len) return error.BadRecord;
            const rc = (try self.map("outputs").link(&op)) orelse return error.BadRecord;
            try out.append(a, .{
                .txid = o.txid,
                .vout = o.vout,
                .satoshis = @intCast(tx.outputs[o.vout].satoshis),
                .locking_script = tx.outputs[o.vout].locking_script.bytes,
                .spendable = !spent,
                .status = st,
                .record = try self.record(rc),
            });
        };
        return out.items;
    }

    /// The BRC-29 key an output of ours is locked to: a payment's or our change's; null for anything else.
    fn keyOf(self: *Wallet, rec: Value) !?w.builder.Key {
        const protocol = rec.getText("protocol") orelse return null;
        const key_id = try w.brc29.keyId(self.a, rec.getText("derivationPrefix") orelse return null, rec.getText("derivationSuffix") orelse return null);
        if (eql(u8, protocol, "wallet change")) return .{ .key_id = key_id, .counterparty = .self };
        if (!eql(u8, protocol, "wallet payment")) return null;
        const hex = rec.getText("senderIdentityKey") orelse return error.BadRecord;
        var k: [33]u8 = undefined;
        if (hex.len != 66) return error.BadRecord;
        _ = std.fmt.hexToBytes(&k, hex) catch return error.BadRecord;
        return .{ .key_id = key_id, .counterparty = .{ .other = k } };
    }

    /// Our spendable outputs we hold keys for (the `default` basket), largest first.
    fn spendableInputs(self: *Wallet) ![]w.builder.Input {
        var out: std.ArrayList(w.builder.Input) = .empty;
        for (try self.listOutputs("default", false)) |o| {
            const key = (try self.keyOf(o.record)) orelse continue;
            try out.append(self.a, .{ .source_txid = o.txid, .vout = o.vout, .satoshis = o.satoshis, .locking_script = o.locking_script, .key = key });
        }
        std.mem.sort(w.builder.Input, out.items, {}, struct {
            fn lt(_: void, x: w.builder.Input, y: w.builder.Input) bool {
                if (x.satoshis != y.satoshis) return x.satoshis > y.satoshis;
                const kx = w.store.outpointKey(x.source_txid, x.vout);
                const ky = w.store.outpointKey(y.source_txid, y.vout);
                return std.mem.order(u8, &kx, &ky) == .lt;
            }
        }.lt);
        return out.items;
    }

    fn selectInputs(self: *Wallet, outputs: []const w.builder.Output, sats_per_kb: u64) ![]w.builder.Input {
        const all = try self.spendableInputs();
        var need: u64 = 0;
        for (outputs) |o| need += o.satoshis;
        var have: u64 = 0;
        for (all, 1..) |in, n| {
            have += in.satoshis;
            if (have >= need + try w.builder.estimateFee(self.a, n, outputs, 25, sats_per_kb)) return all[0..n];
        }
        return error.InsufficientFunds;
    }

    const CreateArgs = struct {
        description: []const u8,
        outputs: []const w.wallet.Wallet.CreateOutput,
        labels: []const []const u8 = &.{},
        sign_and_process: bool = true,
        no_send: bool = false,
    };
    const Created = struct { txid: [32]u8, beef: []const u8, reference: ?[]const u8 = null, no_send: bool = false };

    fn createAction(self: *Wallet, args: CreateArgs, signer: w.builder.Signer, change_prefix: []const u8, change_suffix: []const u8, sats_per_kb: u64) !Created {
        const a = self.a;
        if (args.outputs.len == 0) return error.NoOutputs;
        const outs = try a.alloc(w.builder.Output, args.outputs.len);
        for (args.outputs, outs) |o, *x| {
            if (o.locking_script.len == 0) return error.BadOutput;
            if (o.basket) |b| if (b.len == 0 or eql(u8, b, "default")) return error.BadBasket;
            x.* = .{ .satoshis = o.satoshis, .locking_script = o.locking_script };
        }
        const inputs = try self.selectInputs(outs, sats_per_kb);
        const change_key = w.builder.Key{ .key_id = try w.brc29.keyId(a, change_prefix, change_suffix), .counterparty = .self };
        const built = try w.builder.build(a, signer, inputs, outs, change_key, sats_per_kb, args.sign_and_process);
        if (args.sign_and_process) return self.recordSigned(built, args, change_prefix, change_suffix);
        // A draft: what signAction needs to build the same transaction again, signed.
        const ops = try a.alloc(Value, inputs.len);
        for (inputs, ops) |in, *o| o.* = .{ .bytes = try a.dupe(u8, &w.store.outpointKey(in.source_txid, in.vout)) };
        const draft = try self.s.putValue(a, .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "kind", .value = .{ .text = "draft" } },
            .{ .key = "description", .value = .{ .text = args.description } },
            .{ .key = "labels", .value = .{ .array = try w.wallet.textArray(a, args.labels) } },
            .{ .key = "outputs", .value = .{ .array = try encodeOutputs(a, args.outputs) } },
            .{ .key = "inputs", .value = .{ .array = ops } },
            .{ .key = "derivationPrefix", .value = .{ .text = change_prefix } },
            .{ .key = "derivationSuffix", .value = .{ .text = change_suffix } },
            .{ .key = "satsPerKb", .value = .{ .uint = sats_per_kb } },
            .{ .key = "noSend", .value = .{ .boolean = args.no_send } },
        }) });
        try self.map("drafts").add(draft);
        return .{ .txid = built.txid, .beef = try self.atomicBeef(built.txid, built.raw, built.tx), .reference = draft, .no_send = args.no_send };
    }

    /// signAction for a draft of ours: the same inputs (still live and unspent), now signed and recorded.
    fn signAction(self: *Wallet, reference: []const u8, signer: w.builder.Signer) !Created {
        const a = self.a;
        const d = self.record(reference) catch return error.UnknownReference;
        if (!eql(u8, d.getText("kind") orelse "", "draft")) return error.UnknownReference;
        if (!(try self.map("drafts").has(reference))) return error.UnknownReference;
        const outputs = try w.wallet.decodeOutputs(a, d.getArray("outputs") orelse return error.BadRecord);
        const ops = d.getArray("inputs") orelse return error.BadRecord;
        const inputs = try a.alloc(w.builder.Input, ops.len);
        for (ops, inputs) |o, *in| {
            if (o != .bytes or o.bytes.len != 36) return error.BadRecord;
            const op = try w.store.outpointOf(o.bytes);
            if ((try self.status(op.txid)) == .rejected) return error.DraftRejected;
            if (try self.isSpent(o.bytes[0..36].*)) return error.InputSpent;
            const rc = (try self.map("outputs").link(o.bytes)) orelse return error.BadRecord;
            const raw = (try self.txRaw(op.txid)) orelse return error.BadRecord;
            const src = try Transaction.parse(a, raw);
            in.* = .{
                .source_txid = op.txid,
                .vout = op.vout,
                .satoshis = @intCast(src.outputs[op.vout].satoshis),
                .locking_script = src.outputs[op.vout].locking_script.bytes,
                .key = (try self.keyOf(try self.record(rc))) orelse return error.BadRecord,
            };
        }
        const outs = try a.alloc(w.builder.Output, outputs.len);
        for (outputs, outs) |o, *x| x.* = .{ .satoshis = o.satoshis, .locking_script = o.locking_script };
        const prefix = d.getText("derivationPrefix") orelse return error.BadRecord;
        const suffix = d.getText("derivationSuffix") orelse return error.BadRecord;
        const change_key = w.builder.Key{ .key_id = try w.brc29.keyId(a, prefix, suffix), .counterparty = .self };
        const built = try w.builder.build(a, signer, inputs, outs, change_key, d.getUint("satsPerKb") orelse return error.BadRecord, true);
        _ = try self.map("drafts").remove(reference);
        return self.recordSigned(built, .{
            .description = d.getText("description") orelse "",
            .outputs = outputs,
            .labels = try w.wallet.textsOf(a, d.getArray("labels") orelse &.{}),
            .no_send = d.getBool("noSend") orelse false,
        }, prefix, suffix);
    }

    /// A signed transaction of ours: its block (put and kept), the action, our change and the basket
    /// outputs, and its inputs as spent by it.
    fn recordSigned(self: *Wallet, built: w.builder.Built, args: CreateArgs, change_prefix: []const u8, change_suffix: []const u8) !Created {
        const a = self.a;
        const tx_cid = try self.s.putBitcoin(a, .tx, built.raw);
        try self.putAction(built.txid, tx_cid, args.description, args.labels, &.{.{ .key = "noSend", .value = .{ .boolean = args.no_send } }});
        const txid_hex = try a.dupe(u8, &w.header.toHex(built.txid));
        for (built.tx.inputs) |in| try self.map("spent").put(&w.store.outpointKey(in.previous_outpoint.txid.bytes, in.previous_outpoint.index), .{ .bytes = try a.dupe(u8, &built.txid) });
        if (built.change) |c| {
            try self.putOutput(built.txid, c.vout, .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "kind", .value = .{ .text = "output" } },
                .{ .key = "txid", .value = .{ .text = txid_hex } },
                .{ .key = "vout", .value = .{ .uint = c.vout } },
                .{ .key = "tx", .value = .{ .cid = tx_cid } },
                .{ .key = "basket", .value = .{ .text = "default" } },
                .{ .key = "protocol", .value = .{ .text = "wallet change" } },
                .{ .key = "derivationPrefix", .value = .{ .text = change_prefix } },
                .{ .key = "derivationSuffix", .value = .{ .text = change_suffix } },
            }) });
        }
        for (args.outputs, 0..) |o, i| {
            const basket = o.basket orelse continue;
            var fields: std.ArrayList(cbor.Entry) = .empty;
            try fields.appendSlice(a, &.{
                .{ .key = "kind", .value = .{ .text = "output" } },
                .{ .key = "txid", .value = .{ .text = txid_hex } },
                .{ .key = "vout", .value = .{ .uint = i } },
                .{ .key = "tx", .value = .{ .cid = tx_cid } },
                .{ .key = "basket", .value = .{ .text = basket } },
                .{ .key = "protocol", .value = .{ .text = "basket insertion" } },
                .{ .key = "tags", .value = .{ .array = try w.wallet.textArray(a, o.tags) } },
            });
            if (o.custom_instructions) |ci| try fields.append(a, .{ .key = "customInstructions", .value = .{ .text = ci } });
            try self.putOutput(built.txid, @intCast(i), .{ .map = fields.items });
        }
        return .{ .txid = built.txid, .beef = try self.atomicBeef(built.txid, built.raw, built.tx), .no_send = args.no_send };
    }

    pub const SpvCtx = struct {
        wal: *Wallet,
        fn rootAt(ptr: *anyopaque, height: u32) anyerror!?[32]u8 {
            const self: *SpvCtx = @ptrCast(@alignCast(ptr));
            return (try self.wal.chainOrFail()).chain().rootAt(height);
        }
        fn knownRaw(ptr: *anyopaque, arena: std.mem.Allocator, txid: [32]u8) anyerror!?[]const u8 {
            _ = arena;
            const self: *SpvCtx = @ptrCast(@alignCast(ptr));
            return self.wal.txRaw(txid);
        }
    };

    const Internalized = struct { txid: [32]u8, status: Status, outputs: u32 };

    /// BRC-100 internalizeAction, payee side: SPV against the chain state's headers (read only), each
    /// claimed output checked as ours, then the transaction's block, the action and the outputs
    /// recorded. The chain app records the transaction itself (the step's `ingest`).
    fn internalize(self: *Wallet, tx_beef: []const u8, specs: []const w.wallet.InternalizeOutput, description: []const u8, labels: []const []const u8) !Internalized {
        const a = self.a;
        const chain = try self.chainOrFail();
        const b = w.beef.parse(a, tx_beef) catch return error.InvalidBeef;
        const subject = b.atomic orelse return error.NotAtomicBeef;
        const entry = b.find(subject).?;
        const tx = entry.tx orelse return error.InvalidBeef;
        var ctx = SpvCtx{ .wal = self };
        const checked = try w.spv.verify(a, b, .{ .ptr = &ctx, .rootAtFn = SpvCtx.rootAt, .knownRawFn = SpvCtx.knownRaw });
        if (specs.len == 0) return error.NoOutputs;
        if ((try chain.holds(subject)) and (try chain.status(subject)) == .rejected) return error.TransactionRejected;
        const recs = try a.alloc(Value, specs.len);
        for (specs, recs, 0..) |o, *rec, i| {
            for (specs[0..i]) |prev| if (prev.output_index == o.output_index) return error.DuplicateOutput;
            if (o.output_index >= tx.outputs.len) return error.BadOutputIndex;
            const script = tx.outputs[o.output_index].locking_script.bytes;
            var fields: std.ArrayList(cbor.Entry) = .empty;
            try fields.appendSlice(a, &.{
                .{ .key = "kind", .value = .{ .text = "output" } },
                .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(subject)) } },
                .{ .key = "vout", .value = .{ .uint = o.output_index } },
            });
            if (o.payment) |p| {
                if (o.insertion != null) return error.BadOutputSpec;
                const key_id = try w.brc29.keyId(a, p.derivation_prefix, p.derivation_suffix);
                const key = try VmSigner.derive(undefined, a, key_id, p.sender_identity_key);
                if (!w.brc29.pays(script, key)) return error.NotOurPayment;
                try fields.appendSlice(a, &.{
                    .{ .key = "basket", .value = .{ .text = "default" } },
                    .{ .key = "protocol", .value = .{ .text = "wallet payment" } },
                    .{ .key = "derivationPrefix", .value = .{ .text = p.derivation_prefix } },
                    .{ .key = "derivationSuffix", .value = .{ .text = p.derivation_suffix } },
                    .{ .key = "senderIdentityKey", .value = .{ .text = try a.dupe(u8, &std.fmt.bytesToHex(p.sender_identity_key, .lower)) } },
                });
            } else if (o.insertion) |ins| {
                if (ins.basket.len == 0 or eql(u8, ins.basket, "default")) return error.BadBasket;
                try fields.appendSlice(a, &.{
                    .{ .key = "basket", .value = .{ .text = ins.basket } },
                    .{ .key = "protocol", .value = .{ .text = "basket insertion" } },
                    .{ .key = "tags", .value = .{ .array = try w.wallet.textArray(a, ins.tags) } },
                });
                if (ins.custom_instructions) |ci| try fields.append(a, .{ .key = "customInstructions", .value = .{ .text = ci } });
            } else return error.BadOutputSpec;
            rec.* = .{ .map = fields.items };
        }
        var proven = false;
        for (b.entries, checked.proven) |e, p| if (eql(u8, &e.txid, &subject)) {
            proven = p;
        };
        const tx_cid = try self.s.putBitcoin(a, .tx, entry.raw.?);
        try self.putAction(subject, tx_cid, description, labels, null);
        for (recs) |rec| {
            var fields = try a.dupe(cbor.Entry, rec.map);
            fields = try a.realloc(fields, fields.len + 1);
            fields[fields.len - 1] = .{ .key = "tx", .value = .{ .cid = tx_cid } };
            try self.putOutput(subject, @intCast(rec.getUint("vout").?), .{ .map = fields });
        }
        return .{ .txid = subject, .status = if (proven) .proven else try self.status(subject), .outputs = @intCast(specs.len) };
    }

    /// The Atomic BEEF of a transaction: its ancestry back to proven transactions (their BUMPs from
    /// the chain state, merged per block), parents first, then the transaction.
    fn atomicBeef(self: *Wallet, txid: [32]u8, raw: []const u8, tx: Transaction) ![]const u8 {
        var acc = BeefAcc{ .wal = self };
        for (tx.inputs) |in| try acc.visit(in.previous_outpoint.txid.bytes);
        try acc.entries.append(self.a, .{ .txid = txid, .format = .raw, .raw = raw, .tx = tx });
        acc.flagLeaves();
        return w.beef.serialize(self.a, .{ .version = w.beef.V2, .atomic = txid, .bumps = acc.bumps.items, .entries = acc.entries.items });
    }

    const BeefAcc = struct {
        wal: *Wallet,
        entries: std.ArrayList(w.beef.Entry) = .empty,
        bumps: std.ArrayList(w.bsvz.spv.MerklePath) = .empty,

        fn visit(acc: *BeefAcc, txid: [32]u8) anyerror!void {
            const a = acc.wal.a;
            for (acc.entries.items) |e| if (eql(u8, &e.txid, &txid)) return;
            const raw = (try acc.wal.txRaw(txid)) orelse return error.MissingAncestor;
            const tx = try Transaction.parse(a, raw);
            if ((try acc.wal.status(txid)) == .proven) {
                const p = (try acc.wal.chain.?.proofFor(txid)) orelse return error.MissingProof;
                const idx = for (acc.bumps.items, 0..) |*bp, i| {
                    if (bp.block_height != p.block_height) continue;
                    bp.combine(&p, a) catch continue;
                    break i;
                } else blk: {
                    try acc.bumps.append(a, p);
                    break :blk acc.bumps.items.len - 1;
                };
                try acc.entries.append(a, .{ .txid = txid, .format = .raw_with_bump, .bump = idx, .raw = raw, .tx = tx });
                return;
            }
            for (tx.inputs) |in| try acc.visit(in.previous_outpoint.txid.bytes);
            try acc.entries.append(a, .{ .txid = txid, .format = .raw, .raw = raw, .tx = tx });
        }

        fn flagLeaves(acc: *BeefAcc) void {
            for (acc.entries.items) |e| {
                const bi = e.bump orelse continue;
                for (acc.bumps.items[bi].path[0]) |*l| if (l.hash) |h| if (eql(u8, &h.bytes, &e.txid)) {
                    l.txid = true;
                };
            }
        }
    };
};

fn encodeOutputs(a: std.mem.Allocator, outputs: []const w.wallet.Wallet.CreateOutput) ![]Value {
    const out = try a.alloc(Value, outputs.len);
    for (outputs, out) |o, *v| {
        var fields: std.ArrayList(cbor.Entry) = .empty;
        try fields.appendSlice(a, &.{
            .{ .key = "satoshis", .value = .{ .uint = o.satoshis } },
            .{ .key = "lockingScript", .value = .{ .bytes = o.locking_script } },
            .{ .key = "outputDescription", .value = .{ .text = o.description } },
            .{ .key = "tags", .value = .{ .array = try w.wallet.textArray(a, o.tags) } },
        });
        if (o.basket) |b| try fields.append(a, .{ .key = "basket", .value = .{ .text = b } });
        if (o.custom_instructions) |ci| try fields.append(a, .{ .key = "customInstructions", .value = .{ .text = ci } });
        v.* = .{ .map = fields.items };
    }
    return out;
}

/// Ask the chain app to take a transaction (#79): `{fn: "ingest", args: {beef}}` to the instance
/// itself in box `chain` (the host's loopback; the chain app's row from `$self`). → the message's CID,
/// which the step then awaits: each of the chain app's answers names it as `replyTo`.
fn ingest(a: std.mem.Allocator, me: []const u8, beef: []const u8) ![]const u8 {
    const c = try emitIngest(a, me, beef);
    if (sk.@"await"(c.ptr, @intCast(c.len)) < 0) return failed();
    return c;
}

/// The `ingest` message to the chain app, emitted (not awaited) → its CID.
fn emitIngest(a: std.mem.Allocator, me: []const u8, beef: []const u8) ![]const u8 {
    const body = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = "ingest" } },
        .{ .key = "args", .value = .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "beef", .value = .{ .bytes = beef } }}) } },
    }) });
    const msg = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "to", .value = .{ .bytes = me } },
        .{ .key = "box", .value = .{ .text = chain_box } },
        .{ .key = "body", .value = .{ .bytes = body } },
    }) });
    return try result(a, sk.emit, .{ msg.ptr, @as(u32, @intCast(msg.len)) });
}

fn run(a: std.mem.Allocator) !void {
    const s = VmStore.store();
    const input_bytes = try result(a, sk.input, .{});
    const step = cbor.decode(a, input_bytes) catch |e| {
        std.log.err("input record ({d} bytes): {s}", .{ input_bytes.len, @errorName(e) });
        return e;
    };
    const args = step.get("args") orelse return error.BadInput;
    const me = (step.get("self") orelse return error.BadInput).getBytes("identity") orelse return error.BadInput;
    const reply = step.get("reply");
    var body: Value = .null;
    var op: []const u8 = undefined;
    if (reply != null and reply.? == .map) {
        op = "callback";
        body = try s.getValue(a, reply.?.getCid("body") orelse return error.BadInput);
    } else if (args.get("pay")) |p| {
        // #130: the kernel's pay step.
        op = "pay";
        body = p;
    } else if (args.getCid("body")) |bc| {
        body = try s.getValue(a, bc);
        if (args.getText("fn")) |f| {
            // #144: the route names the function. `internalize`: a BRC-169 delivery message — nothing else.
            if (!eql(u8, f, "internalize")) {
                std.log.err("fn {s}: the wallet's route function is `internalize` (a BRC-169 delivery message)", .{f});
                return error.BadInput;
            }
            op = "delivery";
        } else op = body.getText("op") orelse return error.BadBody;
    } else return error.BadInput;

    const net_name = if (step.get("defaults")) |d| d.getText("walletNetwork") orelse "main" else "main";
    const net_default = w.chain.Network.parse(net_name) orelse {
        std.log.err("defaults.walletNetwork: {s} is not main, test or regtest", .{net_name});
        return error.BadConfig;
    };
    const rate_text = if (step.get("defaults")) |d| d.getText("walletFeeRate") orelse "100" else "100";
    const fee_rate = std.fmt.parseInt(u64, rate_text, 10) catch return error.BadConfig;
    const state_cid = try headOf(a, head_name);
    var wal = try Wallet.load(a, s, state_cid, try headOf(a, chain_head), net_default);

    var out: std.ArrayList(cbor.Entry) = .empty;
    try out.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "wallet-result" } },
        .{ .key = "op", .value = .{ .text = op } },
    });
    var mutates = true;
    // A transaction to hand the chain app after the step's writes (its BEEF), and await.
    var to_ingest: ?[]const u8 = null;

    if (eql(u8, op, "internalize")) {
        const tx = try field(body, "tx");
        const outs = try field(body, "outputs");
        if (tx != .bytes or outs != .array) return error.BadBody;
        const specs = try a.alloc(w.wallet.InternalizeOutput, outs.array.len);
        for (outs.array, specs) |o, *spec| {
            const idx = o.getUint("outputIndex") orelse return error.BadBody;
            const protocol = o.getText("protocol") orelse return error.BadBody;
            spec.* = .{ .output_index = @intCast(idx) };
            if (eql(u8, protocol, "wallet payment")) {
                const r = o.get("paymentRemittance") orelse return error.BadBody;
                const sender_hex = r.getText("senderIdentityKey") orelse return error.BadBody;
                var sender: [33]u8 = undefined;
                if (sender_hex.len != 66) return error.BadBody;
                _ = std.fmt.hexToBytes(&sender, sender_hex) catch return error.BadBody;
                spec.payment = .{
                    .derivation_prefix = r.getText("derivationPrefix") orelse return error.BadBody,
                    .derivation_suffix = r.getText("derivationSuffix") orelse return error.BadBody,
                    .sender_identity_key = sender,
                };
            } else if (eql(u8, protocol, "basket insertion")) {
                const r = o.get("insertionRemittance") orelse return error.BadBody;
                spec.insertion = .{
                    .basket = r.getText("basket") orelse return error.BadBody,
                    .custom_instructions = r.getText("customInstructions"),
                    .tags = try textList(a, r.get("tags")),
                };
            } else return error.BadBody;
        }
        const res = try wal.internalize(tx.bytes, specs, body.getText("description") orelse "", try textList(a, body.get("labels")));
        try out.appendSlice(a, &.{
            .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(res.txid)) } },
            .{ .key = "status", .value = .{ .text = @tagName(res.status) } },
            .{ .key = "outputs", .value = .{ .uint = res.outputs } },
        });
        to_ingest = tx.bytes;
    } else if (eql(u8, op, "delivery")) {
        // #144: funding by a BRC-169 delivery message (BRC-232): the message the door opened (its
        // record names the envelope's signed part), its plaintext a MIME entity of the transaction
        // content type, whose DAG-CBOR body names the transaction, its BEEF and the outputs to take.
        const mc = args.getCid("message") orelse return error.BadInput;
        const msg = try s.getValue(a, mc);
        if (msg.getCid("envelope") == null) {
            std.log.err("internalize: the message is no BRC-169 envelope's (its record names no `envelope`)", .{});
            return error.NotADelivery;
        }
        if (body != .bytes) return error.BadBody;
        const d = try deliveryOf(a, body.bytes);
        const res = try wal.internalize(d.beef, d.specs, d.memo orelse "BRC-169 delivery", &.{});
        try out.appendSlice(a, &.{
            .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(res.txid)) } },
            .{ .key = "status", .value = .{ .text = @tagName(res.status) } },
            .{ .key = "outputs", .value = .{ .uint = res.outputs } },
            .{ .key = "message", .value = .{ .cid = mc } },
        });
        to_ingest = d.beef;
    } else if (eql(u8, op, "createAction") or eql(u8, op, "signAction")) {
        var ws = w.builder.WireSigner{ .ctx = &VmSigner.dummy, .call = VmSigner.call };
        const created = if (eql(u8, op, "createAction")) blk: {
            const opts = body.get("options");
            // The change key: a fresh BRC-29 derivation of our own, drawn from the thread's random (replayable).
            var rnd: [24]u8 = undefined;
            threadRandom(&rnd);
            const enc = std.base64.standard.Encoder;
            const prefix = try a.alloc(u8, enc.calcSize(12));
            const suffix = try a.alloc(u8, enc.calcSize(12));
            _ = enc.encode(prefix, rnd[0..12]);
            _ = enc.encode(suffix, rnd[12..24]);
            break :blk try wal.createAction(.{
                .description = body.getText("description") orelse "",
                .outputs = try w.wallet.decodeOutputs(a, (try field(body, "outputs")).array),
                .labels = try textList(a, body.get("labels")),
                .sign_and_process = if (opts) |o| o.getBool("signAndProcess") orelse true else true,
                .no_send = if (opts) |o| o.getBool("noSend") orelse false else false,
            }, ws.signer(), prefix, suffix, fee_rate);
        } else try wal.signAction(body.getCid("reference") orelse return error.BadBody, ws.signer());
        try out.appendSlice(a, &.{
            .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(created.txid)) } },
            .{ .key = "tx", .value = .{ .bytes = created.beef } },
        });
        if (created.reference) |r| try out.append(a, .{ .key = "reference", .value = .{ .cid = r } });
        // To the chain app (it broadcasts it), unless a draft or noSend.
        if (created.reference == null and !created.no_send) to_ingest = created.beef;
    } else if (eql(u8, op, "pay")) {
        try kernelLaunched(a, s, step);
        const to_b = body.getBytes("to") orelse return error.BadInput;
        if (to_b.len != 33) return error.BadInput;
        const x = body.getUint("x") orelse return error.BadInput;
        const checkpoint = body.getCid("checkpoint") orelse return error.BadInput;
        var ws = w.builder.WireSigner{ .ctx = &VmSigner.dummy, .call = VmSigner.call };
        // Coins whose ancestry the chain state cannot prove yet (a funding the chain app has not
        // ingested) make no BEEF: then only the coins whose transactions it holds.
        const paid = payHost(a, &wal, ws.signer(), to_b[0..33].*, x, checkpoint, fee_rate, false) catch |e| switch (e) {
            error.MissingAncestor, error.MissingProof => blk: {
                wal = try Wallet.load(a, s, state_cid, try headOf(a, chain_head), net_default);
                break :blk try payHost(a, &wal, ws.signer(), to_b[0..33].*, x, checkpoint, fee_rate, true);
            },
            else => return e,
        };
        if (paid) |p| {
            try emitPayment(a, p, to_b, me, checkpoint);
            try out.appendSlice(a, &.{
                .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(p.txid)) } },
                .{ .key = "amount", .value = .{ .uint = p.amount } },
                .{ .key = "checkpoint", .value = .{ .cid = checkpoint } },
            });
            to_ingest = p.beef;
        } else {
            mutates = false;
            try out.appendSlice(a, &.{
                .{ .key = "amount", .value = .{ .uint = 0 } },
                .{ .key = "reason", .value = .{ .text = "nothing to pay with: no coins, or none that covers the fee" } },
            });
        }
    } else if (eql(u8, op, "callback")) {
        // The chain app's answer to our `ingest`: accepted (wait on), proven or rejected (done), or an error.
        const r = reply.?;
        const asked = r.getCid("replyTo") orelse return error.BadInput;
        try out.append(a, .{ .key = "ingest", .value = .{ .cid = asked } });
        if (body.get("error")) |e| {
            try out.appendSlice(a, &.{
                .{ .key = "outcome", .value = .{ .text = "error" } },
                .{ .key = "error", .value = .{ .text = e.getText("message") orelse "" } },
            });
        } else {
            const res = body.get("result") orelse return error.BadInput;
            const chain_state = res.getText("state") orelse "";
            if (res.getText("txid")) |t| try out.append(a, .{ .key = "txid", .value = .{ .text = t } });
            try out.append(a, .{ .key = "outcome", .value = .{ .text = chain_state } });
            if (res.getText("txStatus")) |ts| try out.append(a, .{ .key = "txStatus", .value = .{ .text = ts } });
            if (res.getText("reason")) |rs| try out.append(a, .{ .key = "reason", .value = .{ .text = rs } });
            if (eql(u8, chain_state, "accepted") or eql(u8, chain_state, "unproven")) {
                if (sk.@"await"(asked.ptr, @intCast(asked.len)) < 0) return failed();
                try out.append(a, .{ .key = "awaiting", .value = .{ .boolean = true } });
            }
        }
        // Nothing of ours changes: a rejected transaction's coins vanish at read time (the chain state says so).
        mutates = false;
    } else if (eql(u8, op, "list")) {
        mutates = false;
        const basket = body.getText("basket") orelse "default";
        const views = try wal.listOutputs(basket, body.getBool("includeSpent") orelse false);
        const items = try a.alloc(Value, views.len);
        var total: u64 = 0;
        for (views, items) |v, *it| {
            if (v.spendable) total += v.satoshis;
            it.* = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "txid", .value = .{ .text = try a.dupe(u8, &w.header.toHex(v.txid)) } },
                .{ .key = "vout", .value = .{ .uint = v.vout } },
                .{ .key = "satoshis", .value = .{ .uint = v.satoshis } },
                .{ .key = "lockingScript", .value = .{ .bytes = v.locking_script } },
                .{ .key = "spendable", .value = .{ .boolean = v.spendable } },
                .{ .key = "status", .value = .{ .text = @tagName(v.status) } },
            }) };
        }
        try out.appendSlice(a, &.{
            .{ .key = "basket", .value = .{ .text = basket } },
            .{ .key = "outputs", .value = .{ .array = items } },
            .{ .key = "total", .value = .{ .uint = total } },
        });
    } else if (eql(u8, op, "headers") or eql(u8, op, "proof")) {
        std.log.err("{s}: headers and proofs are the chain app's (#79: its box `chain`), not the wallet's", .{op});
        return error.BadBody;
    } else {
        std.log.err("unknown op {s}", .{op});
        return error.BadBody;
    }

    if (mutates) {
        const new_state = try wal.save();
        if (sk.advance(head_name.ptr, head_name.len, new_state.ptr, @intCast(new_state.len)) < 0) return failed();
        try out.append(a, .{ .key = "state", .value = .{ .cid = new_state } });
    } else if (state_cid) |c| {
        try out.append(a, .{ .key = "state", .value = .{ .cid = c } });
    }
    if (to_ingest) |beef| {
        const m = try ingest(a, me, beef);
        try out.appendSlice(a, &.{
            .{ .key = "ingest", .value = .{ .cid = m } },
            .{ .key = "outcome", .value = .{ .text = "pending" } },
            .{ .key = "awaiting", .value = .{ .boolean = true } },
        });
    }
    // The transactions this result is about, as `mentions` (kernel edges from the thread).
    {
        var named: std.ArrayList([32]u8) = .empty;
        for (out.items) |e| if (eql(u8, e.key, "txid") and e.value == .text) {
            const t = w.header.fromHex(e.value.text) catch continue;
            for (named.items) |x| {
                if (eql(u8, &x, &t)) break;
            } else try named.append(a, t);
        };
        if (named.items.len > 0) {
            const refs = try a.alloc(Value, named.items.len);
            for (named.items, refs) |t, *r| r.* = .{ .map = try a.dupe(cbor.Entry, &.{
                .{ .key = "to", .value = .{ .cid = try a.dupe(u8, &w.store.hashCid(.tx, t)) } },
                .{ .key = "rel", .value = .{ .text = "mentions" } },
            }) };
            try out.append(a, .{ .key = "refs", .value = .{ .array = refs } });
        }
    }
    const res_cid = try s.putValue(a, .{ .map = try dedupe(a, out.items) });
    if (sk.keep(res_cid.ptr, @intCast(res_cid.len)) < 0) return failed();
    var line = try hexAlloc(a, res_cid);
    line = try std.mem.concat(a, u8, &.{ line, "\n" });
    try std.Io.File.stdout().writeStreamingAll(io(), line);
}

// ---------------------------------------------------------------- a BRC-169 delivery (#144)

/// BRC-232's content type: a DAG-CBOR transaction-delivery body.
const TRANSACTION_CBOR = "application/vnd.metanet.transaction+cbor";

const Delivery = struct { beef: []const u8, specs: []const w.wallet.InternalizeOutput, memo: ?[]const u8 };

/// A delivery message's plaintext — an RFC 2045 MIME entity (a header block, CRLF CRLF, the body;
/// `Content-Type` required) of BRC-232's type, its body {memo?, txid: bytes(32), beef, outputs:
/// [{outputIndex, protocol: "wallet payment", derivationPrefix, derivationSuffix,
/// senderIdentityKey: bytes(33)}]} — as internalizeAction's arguments: the BEEF made Atomic for
/// `txid` (its transactions as they came), each entry a BRC-29 payment remittance. A `basket
/// insertion` entry is refused: which basket a skein files it in is not decided.
fn deliveryOf(a: std.mem.Allocator, plain: []const u8) !Delivery {
    const end = std.mem.indexOf(u8, plain, "\r\n\r\n") orelse return error.NotATransactionDelivery;
    var media: ?[]const u8 = null;
    var lines = std.mem.splitSequence(u8, plain[0..end], "\r\n");
    while (lines.next()) |line| {
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        if (!std.ascii.eqlIgnoreCase(std.mem.trim(u8, line[0..colon], " \t"), "content-type")) continue;
        const v = std.mem.trim(u8, line[colon + 1 ..], " \t");
        media = std.mem.trim(u8, v[0 .. std.mem.indexOfScalar(u8, v, ';') orelse v.len], " \t");
    }
    const m = media orelse return error.NotATransactionDelivery;
    if (!std.ascii.eqlIgnoreCase(m, TRANSACTION_CBOR)) {
        std.log.err("internalize: content type {s}, not {s}", .{ m, TRANSACTION_CBOR });
        return error.NotATransactionDelivery;
    }
    const d = try cbor.decode(a, plain[end + 4 ..]);
    const txid_b = d.getBytes("txid") orelse return error.BadBody;
    if (txid_b.len != 32) return error.BadBody;
    // BRC-232's txid is in display order (as its hex is written); the BEEF's are internal.
    var txid: [32]u8 = txid_b[0..32].*;
    std.mem.reverse(u8, &txid);
    var b = w.beef.parse(a, d.getBytes("beef") orelse return error.BadBody) catch return error.InvalidBeef;
    if (b.find(txid) == null) {
        std.log.err("internalize: the BEEF does not hold {s}", .{w.header.toHex(txid)});
        return error.InvalidBeef;
    }
    b.atomic = txid;
    b.vout = null;
    const outs = d.getArray("outputs") orelse return error.BadBody;
    const specs = try a.alloc(w.wallet.InternalizeOutput, outs.len);
    for (outs, specs) |o, *spec| {
        const protocol = o.getText("protocol") orelse return error.BadBody;
        if (!eql(u8, protocol, "wallet payment")) {
            std.log.err("internalize: a `{s}` output: only `wallet payment` is taken from a delivery", .{protocol});
            return error.BadOutputSpec;
        }
        const sender = o.getBytes("senderIdentityKey") orelse return error.BadBody;
        if (sender.len != 33) return error.BadBody;
        spec.* = .{ .output_index = @intCast(o.getUint("outputIndex") orelse return error.BadBody), .payment = .{
            .derivation_prefix = o.getText("derivationPrefix") orelse return error.BadBody,
            .derivation_suffix = o.getText("derivationSuffix") orelse return error.BadBody,
            .sender_identity_key = sender[0..33].*,
        } };
    }
    return .{ .beef = try w.beef.serialize(a, b), .specs = specs, .memo = d.getText("memo") };
}

// ---------------------------------------------------------------- billing (#130)

/// The pay step is the kernel's alone: its thread was launched by the entry it processes (a thread a
/// program launches is launched by that program's thread), so an app that launches this program with
/// `pay` gets nothing built or spent.
fn kernelLaunched(a: std.mem.Allocator, s: Store, step: Value) !void {
    const o = try s.getValue(a, step.getCid("thread") orelse return error.BadInput);
    const by = o.getCid("launchedBy") orelse return error.NotThePayStep;
    if (!eql(u8, by, o.getCid("input") orelse return error.NotThePayStep)) return error.NotThePayStep;
    const e = try s.getValue(a, by);
    if (!eql(u8, e.getText("kind") orelse "", "log")) return error.NotThePayStep;
}

const Paid = struct { txid: [32]u8, tx_cid: []const u8, amount: u64, beef: []const u8, prefix: []const u8, suffix: []const u8 };

fn b64(a: std.mem.Allocator, b: []const u8) ![]u8 {
    const enc = std.base64.standard.Encoder;
    const out = try a.alloc(u8, enc.calcSize(b.len));
    _ = enc.encode(out, b);
    return out;
}

/// Pay the host `to` the next block (#130 decided 5): X when our coins cover it and the fee (with
/// change), else all of them less the fee (no change). The payment's key is BRC-29's — a fresh
/// derivation (prefix and suffix from the thread's random), counterparty the host, so only the host
/// can spend it; the second output commits the checkpoint. Null: nothing to pay with.
fn payHost(a: std.mem.Allocator, wal: *Wallet, signer: w.builder.Signer, to: [33]u8, x: u64, checkpoint: []const u8, rate: u64, held_only: bool) !?Paid {
    var rnd: [48]u8 = undefined;
    threadRandom(&rnd);
    const prefix = try b64(a, rnd[0..12]);
    const suffix = try b64(a, rnd[12..24]);
    const change_prefix = try b64(a, rnd[24..36]);
    const change_suffix = try b64(a, rnd[36..48]);
    var inputs = try wal.spendableInputs();
    if (held_only) {
        const c = try wal.chainOrFail();
        var held: std.ArrayList(w.builder.Input) = .empty;
        for (inputs) |in| if (try c.holds(in.source_txid)) try held.append(a, in);
        inputs = held.items;
    }
    if (inputs.len == 0) return null;
    const frame = try w.wire.getPublicKeyFrameFor(a, w.brc29.security_level, w.brc29.protocol_name, try w.brc29.keyId(a, prefix, suffix), .{ .other = to }, false);
    const payee = try w.wire.publicKeyResult(try VmSigner.call(undefined, a, frame));
    const pay_script = try a.dupe(u8, &w.brc29.p2pkh(payee));
    var cp: std.ArrayList(u8) = .empty;
    try cp.appendSlice(a, &.{ 0x00, 0x6a, @intCast(checkpoint.len) });
    try cp.appendSlice(a, checkpoint);
    var outs = [2]w.builder.Output{ .{ .satoshis = x, .locking_script = pay_script }, .{ .satoshis = 0, .locking_script = cp.items } };
    var n: ?usize = null;
    var have: u64 = 0;
    for (inputs, 1..) |in, k| {
        have += in.satoshis;
        if (have >= x + try w.builder.estimateFee(a, k, &outs, 25, rate)) {
            n = k;
            break;
        }
    }
    const use = if (n) |k| inputs[0..k] else inputs;
    if (n == null) {
        const fee = try w.builder.estimateFee(a, inputs.len, &outs, 25, rate);
        if (have <= fee) return null;
        outs[0].satoshis = have - fee;
    }
    const change_key = w.builder.Key{ .key_id = try w.brc29.keyId(a, change_prefix, change_suffix), .counterparty = .self };
    const built = try w.builder.build(a, signer, use, &outs, change_key, rate, true);
    const cos = [_]w.wallet.Wallet.CreateOutput{
        .{ .satoshis = outs[0].satoshis, .locking_script = outs[0].locking_script, .description = "hosting" },
        .{ .satoshis = 0, .locking_script = outs[1].locking_script, .description = "checkpoint" },
    };
    const created = try wal.recordSigned(built, .{ .description = "hosting", .outputs = &cos, .labels = &.{"hosting"} }, change_prefix, change_suffix);
    return .{ .txid = built.txid, .tx_cid = try a.dupe(u8, &w.store.hashCid(.tx, built.txid)), .amount = outs[0].satoshis, .beef = created.beef, .prefix = prefix, .suffix = suffix };
}

/// The payment as an event (#130 decided 6): the host's to take (its wiring: keep it, broadcast it).
/// `remittance` is BRC-29's, so the host can derive the key it pays.
fn emitPayment(a: std.mem.Allocator, p: Paid, to: []const u8, me: []const u8, checkpoint: []const u8) !void {
    const msg = try cbor.encode(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "event", .value = .{ .text = "payment" } },
        .{ .key = "txid", .value = .{ .cid = p.tx_cid } },
        .{ .key = "tx", .value = .{ .bytes = p.beef } },
        .{ .key = "outputIndex", .value = .{ .uint = 0 } },
        .{ .key = "amount", .value = .{ .uint = p.amount } },
        .{ .key = "to", .value = .{ .bytes = to } },
        .{ .key = "remittance", .value = .{ .map = try a.dupe(cbor.Entry, &.{
            .{ .key = "derivationPrefix", .value = .{ .text = p.prefix } },
            .{ .key = "derivationSuffix", .value = .{ .text = p.suffix } },
            .{ .key = "senderIdentityKey", .value = .{ .text = try hexAlloc(a, me) } },
        }) } },
        .{ .key = "checkpoint", .value = .{ .cid = checkpoint } },
    }) });
    _ = try result(a, sk.emit, .{ msg.ptr, @as(u32, @intCast(msg.len)) });
}

/// Later entries win (a result may name its txid twice).
fn dedupe(a: std.mem.Allocator, es: []const cbor.Entry) ![]const cbor.Entry {
    var out: std.ArrayList(cbor.Entry) = .empty;
    for (es, 0..) |e, i| {
        var later = false;
        for (es[i + 1 ..]) |x| later = later or eql(u8, x.key, e.key);
        if (!later) try out.append(a, e);
    }
    return out.items;
}
