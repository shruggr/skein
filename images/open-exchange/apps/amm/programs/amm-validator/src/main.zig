//! amm-validator: the AMM validator as a skein program (wasm32-wasi). The
//! thin VM adapter around messages.zig and validator.zig; the decisions are
//! there.
//!
//! **A direct call** (what libp2p calls a stream, skein#51). The app asks
//! for three routes (docs/APPS.md §2: libp2p protocols are routes
//! `libp2p:<protocol>`, not namespaced): `libp2p:/amm-validator/1/swap` →
//! fn `swap`, `.../addLiquidity` → fn `addLiquidity`, `.../deploy` → fn
//! `deploy`. Each frame on one of them is a `p2p-frame` request the front
//! door steps on, and calls the handler with in its step (skein docs/MESSAGES.md,
//! "libp2p (#51)", "Streams"; "Route handlers: the program-facing contract
//! (#68, #66)"): `arg` is `{transport: "libp2p", protocol, from, key, body,
//! request, resolved?, …}`.
//!
//! The frame's body is a signed-message package `{message, body}` (MESSAGES
//! "Signed messages (#70)"): the taker (or LP) authenticates by its wallet
//! identity, the package checked with the SDK's verifier (messages.zig
//! `open`). Then the checks and the oracle's signature (validator.zig), and
//! the signed BEEF submitted to this instance's own overlay by message
//! (submit.zig; skein-overlay 0.7.2+: a submission is a message, answered to
//! the sender's box). The handler answers:
//!
//! - `{verdict: "accept", body: <reply>}` at once: a refusal; a transaction
//!   judged or rejected before (from the state);
//! - `{wait: true}` for a signed spend or a consented deploy, after sending
//!   `{fn: "submit", args: {beef, topics: [tm_mandala_<txid>_0]}}` to this instance,
//!   box `<app>/submit`, and `await`ing that message — or, for a resubmission while
//!   the first one is with the chain app, after `await`ing that submission's
//!   thread (the overlay's `pending` record names it: the engine answers a
//!   resubmission with nothing);
//! - called again with `reply`, the engine's first answer to the message
//!   (`admitted`, `proven` or `rejected`, or an error): `{verdict: "accept",
//!   body: <reply>}` (messages.zig `answerFromSubmit`); or with `resolved`,
//!   the awaited thread at rest: read from the state (`answerFromState`). The
//!   front door writes that body back on the stream as the frame's answer
//!   ("Streams": "the frame's answer is written back when the request's
//!   thread comes to rest"). Later answers (each proof) find nothing
//!   awaiting them.
//!
//! **Local** (0.4.0): when a taker names this node as the validator to its own relay, amm-p2p
//! cannot dial itself; its relay thread calls this program's fn in-VM, from its step, with the
//! argument the front door gives a frame's handler (`transport: "local"`, `protocol`, `body`: the
//! same package, `match`, and `reply` / `resolved` when called again). Everything else is as above:
//! the `{wait: true}` and its `await` are the relay thread's.
//!
//! The validator role (0.6.0, shruggr/skein#120, David 2026-10-06 evening; 0.8.1, skein-overlay
//! 0.12.0, David 2026-10-09: "every skein is marketplace AND validator from install, always" — the
//! owner's switch of 0.6.2 is gone): a swap, addLiquidity or deploy is signed only when the token's
//! topic `tm_mandala_<txid>_0` is in the engine's registered set (the head `<app>/topics`, written by the
//! owner's `register` / `deregister`); else refused `not_validating`. "The validator program signs
//! for any registered token." (0.3.2–0.5.0: amm-p2p's validated set,
//! `validate` / `unvalidate` in box `amm/validate`; gone.)
//!
//! Config: the app record's `config.amm.ammValidator` (`{"minValidatorFeeBps": n,
//! "maxLpFeeBps": n, "maxCommissionBps": n?}`; maxCommissionBps optional:
//! absent or null, any commission), else genesis `defaults.ammValidator` (the
//! same as JSON text); the overlay's own configuration as the engine reads it
//! from the app record (skein-overlay `engine_vm.configured`: the served
//! topics, the ones registered with the engine (`<app>/topics`) among them, the app's roles,
//! `app`; the submission goes to the box `<app>/submit`).
const std = @import("std");
const w = @import("chain");
const ov = @import("skein_overlay");
const vm = @import("overlay_sk");
const wire = @import("wallet").wire;
const validator = @import("validator.zig");
const messages = @import("messages.zig");
const submit = @import("submit.zig");
const view_mod = @import("view.zig");
const filing = @import("filing.zig");
const rescind = @import("rescind.zig");
const Oracle = @import("oracle.zig").Oracle;

const cbor = w.cbor;
const Value = cbor.Value;

pub const program_name = "amm-validator";

const imports = struct {
    extern "skein" fn wallet(frame: [*]const u8, len: u32, out: [*]u8, cap: u32) i32;
};

var oracle_dummy: u8 = 0;
fn oracleCall(_: *anyopaque, a: std.mem.Allocator, frame: []const u8) anyerror![]const u8 {
    const res = try vm.result(a, imports.wallet, .{ frame.ptr, @as(u32, @intCast(frame.len)) });
    if (wire.errorMessage(res)) |m| std.log.err("signer: {s}", .{m});
    return res;
}

/// The validator's terms (0.9.0, David Case 2026-10-09: "Fees are the validator's"): `{lpFeeBps,
/// validatorFeeBps, commissionBps}`, each a pool's fee exactly; the defaults 30, 5 and 0.
const Settings = struct {
    lpFeeBps: i64 = 30,
    validatorFeeBps: i64 = 5,
    commissionBps: i64 = 0,

    fn terms(self: Settings) validator.Terms {
        return .{ .lp_fee_bps = self.lpFeeBps, .validator_fee_bps = self.validatorFeeBps, .commission_bps = self.commissionBps };
    }
};

/// The validator's terms: the app record's `config.amm.ammValidator`, else genesis
/// `defaults.ammValidator` (JSON text), else the defaults.
fn settings(a: std.mem.Allocator, in: Value) !Settings {
    const text: []const u8 = blk: {
        const app = in.getText("app") orelse "";
        if (app.len > 0) if (try vm.head(a, try std.fmt.allocPrint(a, "{s}/app", .{app}))) |rc| {
            const rec = try vm.store().getValue(a, rc);
            if (std.mem.eql(u8, rec.getText("kind") orelse "", "app")) if (rec.get("config")) |cf| if (cf.get("amm")) |amm| if (amm.get("ammValidator")) |v|
                break :blk try ov.config.json(a, v);
        };
        const d = in.get("defaults") orelse return .{};
        break :blk d.getText("ammValidator") orelse return .{};
    };
    return std.json.parseFromSliceLeaky(Settings, a, text, .{ .ignore_unknown_fields = true }) catch error.BadConfig;
}

/// The topics this instance signs for (0.6.0, shruggr/skein#120; 0.8.1, David 2026-10-09: every
/// skein is a validator, always): every topic in the engine's registered set, the head
/// `<app>/topics`; any other refused `not_validating`.
fn validatedSet(a: std.mem.Allocator, in: Value) ![]const []const u8 {
    const c = (try vm.head(a, try ov.topics.headName(a, ov.calls.appOf(in)))) orelse return &.{};
    const rec = try vm.store().getValue(a, c);
    const entries = try ov.topics.entriesOf(a, rec);
    const out = try a.alloc([]const u8, entries.len);
    for (entries, out) |e, *o| o.* = e.topic;
    return out;
}

/// The app's overlay state (`<app>/state`) over the chain app's (`chain/state`), as the step sees them.
fn overlayState(a: std.mem.Allocator, in: Value) !*ov.state.State {
    const st = try a.create(ov.state.State);
    st.* = (try ov.engine_vm.load(a, in)).st;
    st.now = @intCast(in.getUint("now") orelse 0);
    return st;
}

fn identityOf(a: std.mem.Allocator, in: Value, oracle: Oracle) ![33]u8 {
    const k = (if (in.get("self")) |me| me.getBytes("identity") else null) orelse return oracle.identity(a);
    return if (k.len == 33) k[0..33].* else error.BadInput;
}

fn run(a: std.mem.Allocator) anyerror!void {
    const raw_in = try vm.input(a);
    // A step: root's message in the box `<app>/validator` (the rescind, 0.9.0), and its thread's
    // later steps (the wallet threads it launched at rest, the engine's answer).
    if (!std.mem.eql(u8, raw_in.getText("kind") orelse "", "call")) return rescindStep(a, raw_in);
    const op = validator.Op.parse(raw_in.getText("fn") orelse "") orelse return error.UnknownFunction;
    const arg = try vm.callArg(a, raw_in);
    // The configuration as the engine reads it: the app this program was installed in (the
    // matched row's program record names it), its `config.overlay`, its roles.
    const in = try ov.engine_vm.configured(a, raw_in, arg);
    return directCall(a, in, arg, op, raw_in);
}

/// Launch the genesis wallet program on `body` (filing.zig `launchArgs`): a thread of its own,
/// which this step's thread is then waiting on beside whatever it awaits.
fn launchWallet(a: std.mem.Allocator, raw_in: Value, body: Value) !void {
    const prog = filing.walletProgram(raw_in) orelse return error.NoWalletProgram;
    _ = try vm.launch(a, prog, try filing.launchArgs(a, vm.store(), body));
}

fn answerBody(a: std.mem.Allocator, r: validator.Reply) !void {
    try vm.answer(a, .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "verdict", .value = .{ .text = "accept" } },
        .{ .key = "body", .value = .{ .bytes = try cbor.encode(a, try messages.replyValue(a, r)) } },
    }) });
}

fn answerWait(a: std.mem.Allocator) !void {
    try vm.answer(a, .{ .map = try a.dupe(cbor.Entry, &.{.{ .key = "wait", .value = .{ .boolean = true } }}) });
}

/// fn `swap`, `deploy`: a frame of a direct call, or the relay's local call (above).
fn directCall(a: std.mem.Allocator, in: Value, arg: Value, op: validator.Op, raw_in: Value) !void {
    // A frame on a direct call (the front door's), or (0.4.0) the same package handed in-VM by this
    // instance's own relay when the validator the caller named is this node (amm-p2p `callValidator`).
    const transport = arg.getText("transport") orelse "";
    if (!std.mem.eql(u8, transport, "libp2p") and !std.mem.eql(u8, transport, "local")) return error.NotADirectCall;
    const oracle: Oracle = .{ .ptr = &oracle_dummy, .callFn = oracleCall };
    const identity = try identityOf(a, in, oracle);
    const body = switch (try messages.open(a, arg.getBytes("body") orelse "", identity, op)) {
        .refused => |r| return answerBody(a, r),
        .ok => |o| o.body,
    };

    const st = try overlayState(a, in);
    const ovv = try a.create(view_mod.OverlayView);
    ovv.* = .{ .st = st };

    // Called again (#66): the engine's answer to the submission this frame awaited.
    if (arg.get("reply")) |r| if (r == .map) {
        const ans = try vm.store().getValue(a, r.getCid("body") orelse return error.BadInput);
        return answerBody(a, try messages.answerFromSubmit(a, st, ovv.view(), op, body, ans));
    };
    // Called again (#66): the submission's thread this frame waited on (a resubmission's) has come
    // to rest — or (0.9.0) the wallet thread filing a deploy's claim did, before the engine
    // answered: while the deploy is still with the chain app, wait on its submission's thread.
    if (arg.get("resolved") != null) {
        if (op == .deploy) if (messages.parseDeploy(body)) |req| if (validator.subjectOf(a, req.tx)) |sub| if (try validator.claimedHeld(a, ovv.view(), sub)) |held| {
            if (try st.isPending(held.txid)) if (!(try st.isPaused(held.txid))) if (try st.pendingRecord(held.txid)) |rec| if (rec.getCid("thread")) |thread| {
                if (vm.awaitRecord(thread)) |_| return answerWait(a) else |_| {}
            };
        };
        return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));
    }

    const s = try settings(a, in);
    const now: i64 = if (in.getUint("now")) |n| @intCast(n) else 0;
    const served = try messages.respond(a, op, body, .{
        .config = .{ .identity = identity, .terms = s.terms(), .now_ms = now, .validated = try validatedSet(a, in) },
        .view = ovv.view(),
        .oracle = oracle,
        .st = st,
    });
    switch (served.next) {
        .answer => return answerBody(a, served.reply),
        .from_state => return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body)),
        .submit => |sub| {
            // A submission is a message (skein-overlay 0.7.2+): to this instance, in the submissions
            // box `<app>/submit`, which the row `submit` from `*` takes to the engine (0.7.5, #128). The engine hands the BEEF to the chain
            // app, which registers and broadcasts every unproven transaction in it, the taker's nosend
            // funding parent with the swap (shruggr/skein-chain docs/CHAIN.md "Ingest a BEEF";
            // `served.broadcast` names them), and answers this message when it is admitted or rejected.
            const m = try vm.send(a, &identity, try submit.box(a, ov.calls.appOf(in)), try submit.body(a, sub.beef, sub.topic));
            try vm.awaitRecord(m);
            // A deploy's claim (0.9.0): filed in this instance's wallet, basket `amm-claims`, by a
            // wallet thread of its own (filing.zig), so the rescind can spend it later.
            if (served.file) |f| launchWallet(a, raw_in, try filing.internalizeBody(a, f.atomic, f.txid, f.vout, f.key_id)) catch |e|
                std.log.err("the claim {s}.{d} is not filed in the wallet: {s}", .{ &w.header.toHex(f.txid), f.vout, @errorName(e) });
            return answerWait(a);
        },
        .wait_on => |txid| {
            // Resubmitted while the first submission's thread awaits the chain app: wait on that thread.
            const rec = (try st.pendingRecord(txid)) orelse return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));
            const thread = rec.getCid("thread") orelse return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));
            vm.awaitRecord(thread) catch return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body)); // at rest already
            return answerWait(a);
        },
    }
}

// ---------------------------------------------------------------- the rescind (0.9.0)

fn resultRecord(a: std.mem.Allocator, stage: []const u8, fields: []const cbor.Entry) !Value {
    var es: std.ArrayList(cbor.Entry) = .empty;
    try es.appendSlice(a, &.{
        .{ .key = "kind", .value = .{ .text = "amm-rescind" } },
        .{ .key = "stage", .value = .{ .text = stage } },
    });
    try es.appendSlice(a, fields);
    return .{ .map = es.items };
}

/// Answer root's message: `{fn: "rescind", request: <the message>, result | error}` to its sender,
/// in the box it wrote to; then the thread ends.
fn rescindAnswer(a: std.mem.Allocator, args: Value, field: []const u8, v: Value) !void {
    const answer: Value = .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "fn", .value = .{ .text = "rescind" } },
        .{ .key = "request", .value = if (args.getCid("message")) |m| .{ .cid = m } else .null },
        .{ .key = field, .value = v },
    }) };
    if (args.getBytes("sender")) |sender| if (args.getText("box")) |box| {
        _ = vm.send(a, sender, box, answer) catch |e| std.log.err("rescind: the answer is not sent: {s}", .{@errorName(e)});
    };
    _ = try vm.finish(a, vm.store(), try resultRecord(a, "answered", &.{.{ .key = "answer", .value = answer }}));
}

fn rescindError(a: std.mem.Allocator, args: Value, why: []const u8) !void {
    return rescindAnswer(a, args, "error", .{ .map = try a.dupe(cbor.Entry, &.{
        .{ .key = "code", .value = .{ .text = "refused" } },
        .{ .key = "message", .value = .{ .text = why } },
    }) });
}

/// One step of a rescind's thread (rescind.zig): root's message `{fn: "rescind", args: {pool:
/// "<deploy txid>.0"}}` launches the wallet's createAction (the claim a caller input); its draft
/// at rest, the claim input is signed and the wallet's signAction launched; signed, the rescind is
/// submitted to this overlay by message; the engine's answer is root's answer.
fn rescindStep(a: std.mem.Allocator, raw_in: Value) !void {
    const args = raw_in.get("args") orelse return error.BadInput;
    const in = try ov.engine_vm.configured(a, raw_in, null);
    const oracle: Oracle = .{ .ptr = &oracle_dummy, .callFn = oracleCall };
    const identity = try identityOf(a, in, oracle);
    const s = vm.store();

    // The engine's answer to the submission: root's answer.
    if (raw_in.get("reply")) |r| if (r == .map) {
        const ans = try s.getValue(a, r.getCid("body") orelse return error.BadInput);
        if (ans.get("error")) |e| return rescindError(a, args, e.getText("message") orelse "the overlay refused the rescind");
        return rescindAnswer(a, args, "result", ans.get("result") orelse .null);
    };
    // A wallet thread at rest: the draft, or the signed rescind.
    if (raw_in.get("resolved")) |rs| {
        const items = if (rs == .array) rs.array else return error.BadInput;
        if (items.len == 0) return error.BadInput;
        const res = items[items.len - 1];
        if (!std.mem.eql(u8, res.getText("state") orelse "", "finished")) return rescindError(a, args, "the wallet errored");
        const rc = (try rescind.resultCid(a, res.get("result") orelse .null)) orelse return rescindError(a, args, "the wallet answered nothing");
        switch (rescind.stageOf(try s.getValue(a, rc))) {
            .failed => |why| return rescindError(a, args, why),
            .draft => |d| {
                const l = (try rescind.locate(a, identity, d.tx)) orelse return rescindError(a, args, "the draft spends no claim of ours");
                try launchWallet(a, raw_in, try rescind.signBody(a, d.reference, l, oracle));
                _ = try vm.finish(a, s, try resultRecord(a, "signing", &.{}));
                return;
            },
            .signed => |tx| {
                const l = (try rescind.locate(a, identity, tx)) orelse return rescindError(a, args, "the rescind spends no claim of ours");
                const m = try vm.send(a, &identity, try submit.box(a, ov.calls.appOf(in)), try submit.body(a, tx, try rescind.topicOf(a, l.claim)));
                try vm.awaitRecord(m);
                _ = try vm.finish(a, s, try resultRecord(a, "submitted", &.{}));
                return;
            },
        }
    }
    // Root's message.
    const bc = args.getCid("body") orelse return error.BadInput;
    const body = try s.getValue(a, bc);
    if (!std.mem.eql(u8, body.getText("fn") orelse "", "rescind")) return rescindError(a, args, "want {fn: \"rescind\", args: {pool: \"<deploy txid>.0\"}}");
    const text = (body.get("args") orelse return rescindError(a, args, "want args {pool}")).getText("pool") orelse return rescindError(a, args, "want args {pool}");
    const norm = try a.dupe(u8, text);
    if (std.mem.indexOfScalar(u8, norm, '.')) |i| norm[i] = '_';
    const op = view_mod.Outpoint.parse(norm) orelse return rescindError(a, args, "pool: <txid>.<vout>");
    const st = try overlayState(a, in);
    const ovv = try a.create(view_mod.OverlayView);
    ovv.* = .{ .st = st };
    const c = switch (try rescind.claimOf(a, ovv.view(), identity, op.txid)) {
        .refused => |why| return rescindError(a, args, why),
        .ok => |c| c,
    };
    const input_beef = (try st.ch.beefOf(c.deploy)) orelse return rescindError(a, args, "the chain state has no BEEF of the deploy");
    try launchWallet(a, raw_in, try rescind.createBody(a, c, input_beef));
    _ = try vm.finish(a, s, try resultRecord(a, "drafting", &.{}));
}

pub fn main() u8 {
    return vm.main(program_name, run);
}
