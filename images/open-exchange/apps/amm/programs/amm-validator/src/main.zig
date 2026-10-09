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

const Settings = struct {
    minValidatorFeeBps: i64 = 0,
    maxLpFeeBps: i64 = 10_000,
    maxCommissionBps: ?i64 = null,
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
    if (!std.mem.eql(u8, raw_in.getText("kind") orelse "", "call")) return error.NotARouteCall;
    const op = validator.Op.parse(raw_in.getText("fn") orelse "") orelse return error.UnknownFunction;
    const arg = try vm.callArg(a, raw_in);
    // The configuration as the engine reads it: the app this program was installed in (the
    // matched row's program record names it), its `config.overlay`, its roles.
    const in = try ov.engine_vm.configured(a, raw_in, arg);
    return directCall(a, in, arg, op);
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

/// fn `swap`, `addLiquidity`, `deploy`: a frame of a direct call, or the relay's local call (above).
fn directCall(a: std.mem.Allocator, in: Value, arg: Value, op: validator.Op) !void {
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
    // Called again (#66): the submission's thread this frame waited on (a resubmission's) has come to rest.
    if (arg.get("resolved") != null) return answerBody(a, try messages.answerFromState(a, st, ovv.view(), op, body));

    const s = try settings(a, in);
    const now: i64 = if (in.getUint("now")) |n| @intCast(n) else 0;
    const served = try messages.respond(a, op, body, .{
        .config = .{ .identity = identity, .min_validator_fee_bps = s.minValidatorFeeBps, .max_lp_fee_bps = s.maxLpFeeBps, .max_commission_bps = s.maxCommissionBps, .now_ms = now, .validated = try validatedSet(a, in) },
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

pub fn main() u8 {
    return vm.main(program_name, run);
}
