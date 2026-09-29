//! loop: the turn loop (README.md, "Records"; docs/MESSAGES.md), launched by a
//! subscription (…, chat) → loop with the opening `chat` message as its input:
//! David's, or another agent's (the `message` tool of another instance). Its
//! sender is the thread's opener.
//!
//! The conversation is the thread's own chain: every turn is a record the step
//! keeps (sk.keep), and each step rebuilds it by walking the chain back from
//! its tip. Turns ({kind: "turn", parent?, of, role, …}), built from the
//! admitted plaintext bodies and the shell's results; `parent` is the turn
//! before (the system turn has none), so the turns are a graph of nodes keyed
//! by CID, which is what the inference peer holds (below):
//!
//!     system     {of: <tree>, role: "system", content}   (first, once: the conversation's prompt)
//!     user       {of: <chat message>, role: "user", text, tree?, model?, thinking?, annotations?}   (the opener's)
//!     assistant  {of: <completions message>, role: "assistant", content?, reasoning?, tool_calls?, model, ms?, usage?}
//!     tool       {of: <shell thread>, role: "tool", call, exitCode, stdout, stderr, tree}   (bash; outputs capped at 16 KiB)
//!     tool       {of: <their chat reply>, role: "tool", call, to, sent: <our chat message>, text}   (message)
//!     tool       {of: <entry>, role: "tool", call, to?, error}   (a message that could not be sent, or delivered)
//!     tool       {of: <say|present|annotation record>, role: "tool", call, text}   (the record's CID, as JSON)
//!     tool       {of: <entry>, role: "tool", call, error}   (a say/present/annotate call with bad arguments)
//!     error      {of: <completions message | entry>, role: "error", error}
//!
//! Kept beside the turns, not one of them: {kind: "missing", of: <completions
//! message>, missing: [<node>]} — the peer did not hold a node we named; and
//! the conversation's artefacts (issue #19; docs/MESSAGES.md, "The turn
//! stream"):
//!
//!     {kind: "say", of: <assistant turn>, call, text}
//!     {kind: "present", of: <assistant turn>, call, page, blocks?: [{id, …}]}
//!     {kind: "annotation", of: <assistant turn>, by: "model", call, present, block?, note}
//!     {kind: "annotation", of: <user turn>, by: "user", present, block?, note}   (from a chat's `annotations`)
//!
//! The infer protocol (issue #12; docs/MESSAGES.md, "The infer protocol"):
//! each `infer` carries only the turns since the last request — from the
//! latest assistant turn on, since the peer held everything up to its parent —
//! and names the node they extend (`parent`); the first carries the whole
//! conversation. `model` and `thinking` are per request: the latest user
//! turn's, else the genesis defaults. A `missing` reply (a restarted or
//! evicted peer) is kept as above and answered with the whole conversation,
//! once; a second in a row is an inference error.
//!
//! The prompt: a new conversation reads /SOUL.md from the tree it starts on
//! (the chat's tree, else `main`'s) — else the fixed one below — and appends
//! /IDENTITY.md, then /ROSTER.md (the colleagues the host says this agent
//! knows, with their addresses), after it if there are. It is kept as the system turn, so the
//! conversation keeps it however the tree moves on.
//!
//! Everything the loop sends a party is a `chat` — the same body in both
//! directions — and it rests on the reply. A chat to a party this thread
//! already has a conversation with (it opened the thread, or replied to one of
//! our messages) is a reply to that party's latest message here (latestFrom),
//! so their waiting thread resumes with it; a chat to anyone else starts a new
//! conversation (no replyTo). A conversation is pairwise; two agents talking
//! alternate on one thread each.
//!
//! Tools: `bash` (a command in the shell over the working tree) and `message`
//! ({to: "@handle@domain", text}: a `chat` to another party — the identity the
//! handle resolves to, from the peer table, or on first contact through the
//! resolve program (an in-VM call; its BRC-169 lookup is recorded) — delivered
//! by the messagebox program over http (#40), then rest on the reply as on an
//! `infer`; their reply is the tool result).
//! Calls run one at a time, in order. With `defaults.tools` in the genesis
//! naming them (a comma-separated list; default none), three more: `say`
//! ({text}), `present` ({page, blocks?}) and `annotate` ({present, block?,
//! note}) — ordinary tools the model calls when the conversation calls for
//! them. Each puts its record, keeps it (so the page lives on by CID, and the
//! call and its result reach every later prompt), sends it to the opener in
//! their `turn` box — a message, not awaited — and answers the model with the
//! record's CID (and a present's block ids).
//!
//! The turn stream: with `defaults.stream` "on", the loop also sends the opener,
//! in `turn`, the moment each happens: {kind: "thinking", of: <assistant
//! turn>, text} (a completion's reasoning), {kind: "log", of, call, name,
//! event: "started"|"finished", exitCode?, tree?, error?} (each tool call; `of`
//! the assistant turn when started, the tool turn when finished), {kind:
//! "error", of: <error turn>, error}, and the opener's own annotations as
//! kept. These are sent, not kept: the turns hold the same facts.
//!
//! The answer: a turn ends with a `chat` to the opener, {text, tree, thread,
//! replyTo: <their latest message>}, and rests on their reply; that reply is
//! the next user turn.
//!
//! Per step, by why it runs:
//!
//!     a chat (step 1, or a reply to our answer)  keep the user turn; emit `infer`; await it
//!     a completion (reply to our `infer`)        keep it; tool calls → run the first (one at
//!                                                a time); none → answer, await the reply
//!                                                (an error → keep it, answer with it, await)
//!     a reply to our `message`                   keep it as the tool result; run the next call
//!     the shell at rest                          keep the tool result; run the next call, or
//!                                                emit `infer` again when none is left
//!     a send fails (the messagebox's error:      a `message` → an error tool result, run the
//!       delivery is inside the step, #40)        next call (a transient one is tried again
//!                                                first: below); the `infer` → an error, answered
//!                                                as an inference error; the answer → an error
//!                                                turn, and the thread ends (no reply can come)
//!     woken (a retry's deadline came)            run the pending `message` call again
//!
//! Retries: a `message` whose delivery fails with a transient error (the
//! messagebox's "transient: …": no answer, 5xx, 408, 425, 429 — or the
//! resolve's) is tried again after a while: the step keeps a note beside the
//! turns, {kind: "retry", of: <entry>, call, to, attempt, error}, and rests on
//! a deadline (the kernel's `deadline` import) `defaults.sendRetryMs` ahead (default 30 s);
//! the wake runs the call again. After `defaults.sendAttempts` attempts
//! (default 3) it is an error tool result for the model, as a permanent
//! failure is at once.
//!
//! Records are built with the Go loop's field rules (#54: it was Go before):
//! text fields are left out when empty, links when absent, an exit code and
//! outputs whenever a shell ran; tool-call arguments are read, and tool
//! results written, as Go's encoding/json did (gojson.zig).
const std = @import("std");
const cbor = @import("cbor");
const sk = @import("sk");
const gojson = @import("gojson.zig");

const Value = cbor.Value;
const Allocator = std.mem.Allocator;
const eql = std.mem.eql;

const system = "You are working with David through skein. Use the bash tool to run commands over the working tree; when you are done or need David, answer in plain text; keep answers short.";

const default_model = "ripper/qwen38";

const output_cap = 16 << 10;

// A transient `message` failure: this many attempts in all, this far apart (defaults.sendAttempts, defaults.sendRetryMs).
const send_attempts = 3;
const send_retry_ms = 30_000;

// ---------------------------------------------------------------- the tools

const bash_tool =
    \\{"type":"function","function":{"name":"bash","description":"Run a shell command over the working tree","parameters":{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}}}
;

const message_tool =
    \\{"type":"function","function":{"name":"message","description":"Message a colleague — another agent — and wait for their answer. `to` is their handle, @handle@domain; `text` is what you want to tell or ask them. Their reply comes back as the result.","parameters":{"type":"object","properties":{"to":{"type":"string","description":"their handle, @handle@domain"},"text":{"type":"string","description":"what to say"}},"required":["to","text"]}}}
;

const say_tool =
    \\{"type":"function","function":{"name":"say","description":"Say a line aloud to the person you are talking with, now, while you work. Only where the conversation calls for it (a voice channel is established); your answer at the end of the turn is still your plain-text reply.","parameters":{"type":"object","properties":{"text":{"type":"string","description":"the line to say"}},"required":["text"]}}}
;

const present_tool =
    \\{"type":"function","function":{"name":"present","description":"Show the person a page (markdown or HTML) to discuss. Only when you are discussing something that is better seen than said. The page stays in the conversation by its CID (the result); give blocks ids so you and they can annotate parts of it.","parameters":{"type":"object","properties":{"page":{"type":"string","description":"the page: markdown or HTML"},"blocks":{"type":"array","description":"the page's annotatable parts, each with a unique id","items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}},"required":["page"]}}}
;

const annotate_tool =
    \\{"type":"function","function":{"name":"annotate","description":"Add a note to a page presented in this conversation, on one of its blocks.","parameters":{"type":"object","properties":{"present":{"type":"string","description":"the page's CID, as `present` returned it"},"block":{"type":"string","description":"the block's id"},"note":{"type":"string","description":"the note"}},"required":["present","note"]}}}
;

/// The optional tools (issue #19), offered in this order when defaults.tools names them.
const optional_tools = [_][2][]const u8{ .{ "say", say_tool }, .{ "present", present_tool }, .{ "annotate", annotate_tool } };

fn isOptional(name: []const u8) bool {
    for (optional_tools) |t| if (eql(u8, t[0], name)) return true;
    return false;
}

/// The Go struct an artefact call's arguments decoded into, as json.Unmarshal's messages name it.
const artefact_type = "struct { Text string \"json:\\\"text\\\"\"; Page string \"json:\\\"page\\\"\"; Blocks []map[string]interface {} \"json:\\\"blocks\\\"\"; Present string \"json:\\\"present\\\"\"; Block string \"json:\\\"block\\\"\"; Note string \"json:\\\"note\\\"\" }";

// ---------------------------------------------------------------- records

const ToolCall = struct { id: []const u8, type: []const u8, name: []const u8, arguments: []const u8 };

/// A list of tool calls {id, type, function: {name, arguments}}, as a completion or a turn holds them.
fn toolCallsOf(a: Allocator, v: ?Value) ![]const ToolCall {
    const x = v orelse return &.{};
    if (x == .null) return &.{};
    if (x != .array) return sk.report("tool_calls: not a list");
    const out = try a.alloc(ToolCall, x.array.len);
    for (x.array, out) |c, *o| {
        if (c != .map and c != .null) return sk.report("tool_calls: a call is not a map");
        const f: Value = c.get("function") orelse .null;
        if (f != .map and f != .null) return sk.report("tool_calls: function is not a map");
        o.* = .{ .id = try sk.textField(c, "id"), .type = try sk.textField(c, "type"), .name = try sk.textField(f, "name"), .arguments = try sk.textField(f, "arguments") };
    }
    return out;
}

fn toolCallsValue(a: Allocator, calls: []const ToolCall) !?Value {
    if (calls.len == 0) return null;
    const out = try a.alloc(Value, calls.len);
    for (calls, out) |c, *o| {
        var f = cbor.MapBuilder.init(a);
        try f.put("name", cbor.string(c.name));
        try f.put("arguments", cbor.string(c.arguments));
        var m = cbor.MapBuilder.init(a);
        try m.put("id", cbor.string(c.id));
        try m.put("type", cbor.string(c.type));
        try m.put("function", f.value());
        o.* = m.value();
    }
    return .{ .array = out };
}

fn optText(s: []const u8) ?Value {
    return if (s.len == 0) null else cbor.string(s);
}

fn optLink(c: ?[]const u8) ?Value {
    const x = c orelse return null;
    return if (x.len == 0) null else cbor.cidv(x);
}

fn link(c: []const u8) !Value {
    if (c.len == 0) return sk.report("skein: empty CID");
    return cbor.cidv(c);
}

/// A user note as a chat carries it, and as its user turn keeps it.
const Note = struct { present: []const u8, block: []const u8, note: []const u8 };

/// Every turn the loop keeps (and the `missing` note); `role` says which fields apply.
const Turn = struct {
    kind: []const u8 = "turn",
    parent: ?[]const u8 = null,
    of: []const u8,
    role: []const u8 = "",
    text: []const u8 = "",
    tree: ?[]const u8 = null,
    model: []const u8 = "",
    thinking: []const u8 = "",
    content: []const u8 = "",
    reasoning: []const u8 = "",
    tool_calls: []const ToolCall = &.{},
    ms: i128 = 0,
    usage: ?Value = null,
    call: []const u8 = "",
    to: []const u8 = "",
    sent: ?[]const u8 = null,
    exit_code: ?i128 = null,
    stdout: ?[]const u8 = null,
    stderr: ?[]const u8 = null,
    err: []const u8 = "",
    missing: []const Value = &.{},
    annotations: []const Note = &.{},

    fn value(t: Turn, a: Allocator) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string(t.kind));
        try m.put("parent", optLink(t.parent));
        try m.put("of", try link(t.of));
        try m.put("role", optText(t.role));
        try m.put("text", optText(t.text));
        try m.put("tree", optLink(t.tree));
        try m.put("model", optText(t.model));
        try m.put("thinking", optText(t.thinking));
        try m.put("content", optText(t.content));
        try m.put("reasoning", optText(t.reasoning));
        try m.put("tool_calls", try toolCallsValue(a, t.tool_calls));
        if (t.ms != 0) try m.put("ms", cbor.int(t.ms));
        try m.put("usage", t.usage);
        try m.put("call", optText(t.call));
        try m.put("to", optText(t.to));
        try m.put("sent", optLink(t.sent));
        if (t.exit_code) |c| try m.put("exitCode", cbor.int(c));
        if (t.stdout) |s| try m.put("stdout", cbor.string(s));
        if (t.stderr) |s| try m.put("stderr", cbor.string(s));
        try m.put("error", optText(t.err));
        if (t.missing.len > 0) try m.put("missing", .{ .array = t.missing });
        if (t.annotations.len > 0) {
            const out = try a.alloc(Value, t.annotations.len);
            for (t.annotations, out) |n, *o| {
                var x = cbor.MapBuilder.init(a);
                try x.put("present", try link(n.present));
                try x.put("block", optText(n.block));
                try x.put("note", cbor.string(n.note));
                o.* = x.value();
            }
            try m.put("annotations", .{ .array = out });
        }
        return m.value();
    }
};

/// What the loop sends on the turn stream (and, for say, present and
/// annotation, keeps); `kind` says which fields apply.
const Record = struct {
    kind: []const u8,
    of: ?[]const u8,
    by: []const u8 = "",
    call: []const u8 = "",
    name: []const u8 = "",
    event: []const u8 = "",
    text: []const u8 = "",
    page: []const u8 = "",
    blocks: []const Value = &.{},
    present: ?[]const u8 = null,
    block: []const u8 = "",
    note: []const u8 = "",
    exit_code: ?i128 = null,
    tree: ?[]const u8 = null,
    err: []const u8 = "",

    fn value(r: Record, a: Allocator) !Value {
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string(r.kind));
        try m.put("of", try link(r.of orelse ""));
        try m.put("by", optText(r.by));
        try m.put("call", optText(r.call));
        try m.put("name", optText(r.name));
        try m.put("event", optText(r.event));
        try m.put("text", optText(r.text));
        try m.put("page", optText(r.page));
        if (r.blocks.len > 0) try m.put("blocks", .{ .array = r.blocks });
        try m.put("present", optLink(r.present));
        try m.put("block", optText(r.block));
        try m.put("note", optText(r.note));
        if (r.exit_code) |c| try m.put("exitCode", cbor.int(c));
        try m.put("tree", optLink(r.tree));
        try m.put("error", optText(r.err));
        return m.value();
    }
};

// ---------------------------------------------------------------- the step

pub fn main() u8 {
    return sk.main("loop", run);
}

fn run(a: Allocator) !void {
    start(a) catch |e| return sk.plain(e);
}

fn say(a: Allocator, comptime f: []const u8, args: anytype) void {
    const line = std.fmt.allocPrint(a, f, args) catch return;
    std.Io.File.stderr().writeStreamingAll(sk.io(), line) catch {};
}

const Presented = struct { cid: []const u8, blocks: []const []const u8 };
const RetryMark = struct { call: []const u8, turns: usize };

/// One step's view: its input, the thread's args, the conversation so far
/// (its turns and their CIDs), and the kind of the last record kept.
const Loop = struct {
    a: Allocator,
    in: Value,
    message: []const u8,
    sender: []const u8,
    entry: []const u8,
    conv: std.array_list.Managed(Value),
    cids: std.array_list.Managed([]const u8),
    last: []const u8 = "",
    /// the pages presented in this thread: their CIDs and block ids
    presents: std.array_list.Managed(Presented),
    /// the retry notes kept: which call, and how many turns the conversation had then
    retries: std.array_list.Managed(RetryMark),

    fn default(l: *Loop, name: []const u8) []const u8 {
        const d = l.in.get("defaults") orelse return "";
        return Value.str(d.get(name)) orelse "";
    }

    /// enabled: whether defaults.tools names this optional tool.
    fn enabled(l: *Loop, tool: []const u8) bool {
        var it = std.mem.tokenizeAny(u8, l.default("tools"), ", ");
        while (it.next()) |t| if (eql(u8, t, tool)) return true;
        return false;
    }

    /// streaming: whether defaults.stream turns the non-model kinds on.
    fn streaming(l: *Loop) bool {
        const s = l.default("stream");
        return eql(u8, s, "on") or eql(u8, s, "true") or eql(u8, s, "1") or eql(u8, s, "yes");
    }

    /// setting: a positive integer from the genesis defaults (strconv.Atoi), else def.
    fn setting(l: *Loop, name: []const u8, def: i64) i64 {
        const s = l.default(name);
        var digits = s;
        if (digits.len > 0 and (digits[0] == '+' or digits[0] == '-')) digits = digits[1..];
        if (digits.len == 0) return def;
        for (digits) |c| if (c < '0' or c > '9') return def;
        const v = std.fmt.parseInt(i64, s, 10) catch return def;
        return if (v > 0) v else def;
    }

    fn role(t: Value) []const u8 {
        return Value.str(t.get("role")) orelse "";
    }

    // -------------------------------------------------------- keeping

    /// keep a turn: the next node of the conversation, its parent the last one; its CID.
    fn keepTurn(l: *Loop, t0: Turn) ![]const u8 {
        var t = t0;
        t.kind = "turn";
        if (l.cids.items.len > 0) t.parent = l.cids.items[l.cids.items.len - 1];
        const v = try t.value(l.a);
        const c = try l.put("turn", v);
        try l.conv.append(v);
        try l.cids.append(c);
        return c;
    }

    /// put and keep a record (a turn, a note beside the turns, an artefact).
    fn put(l: *Loop, kind: []const u8, v: Value) ![]const u8 {
        const c = sk.put(l.a, v) catch |e| return sk.wrap(l.a, try std.fmt.allocPrint(l.a, "put {s}", .{kind}), e);
        sk.keep(c) catch |e| return sk.wrap(l.a, "keep", e);
        l.last = kind;
        return c;
    }

    /// fail keeps an error turn and sends it on the turn stream.
    fn fail(l: *Loop, of: []const u8, msg: []const u8) !void {
        const c = try l.keepTurn(.{ .of = of, .role = "error", .err = msg });
        if (l.streaming()) try l.stream(.{ .kind = "error", .of = c, .err = msg });
    }

    /// result keeps a tool call's result turn and logs the call finished.
    fn result(l: *Loop, call: ToolCall, t0: Turn) !void {
        var t = t0;
        t.role = "tool";
        t.call = call.id;
        const c = try l.keepTurn(t);
        if (!l.streaming()) return;
        try l.stream(.{ .kind = "log", .of = c, .call = call.id, .name = call.name, .event = "finished", .exit_code = t.exit_code, .tree = t.tree, .err = t.err });
    }

    /// started logs a tool call started.
    fn started(l: *Loop, call: ToolCall) !void {
        if (!l.streaming()) return;
        try l.stream(.{ .kind = "log", .of = l.lastAssistantCid(), .call = call.id, .name = call.name, .event = "started" });
    }

    /// stream sends a record to the opener in their `turn` box: a message, not awaited.
    /// A record that cannot be delivered is noted on stderr and the turn goes on.
    fn stream(l: *Loop, r: Record) !void {
        const v = r.value(l.a) catch |e| {
            if (e == error.OutOfMemory) return e;
            say(l.a, "loop: turn stream: {s}\n", .{sk.errorText(e)});
            return;
        };
        _ = sk.send(l.a, l.in, l.sender, "turn", v, "", "") catch |e| {
            if (e == error.OutOfMemory) return e;
            say(l.a, "loop: turn stream: {s}\n", .{sk.errorText(e)});
        };
    }

    // -------------------------------------------------------- why the step runs

    /// chat: the opener's line (the opening one, or their reply to our answer).
    fn chat(l: *Loop, message: []const u8, body: []const u8) !void {
        const a = l.a;
        const b = try sk.readBody(a, message, body);
        if (b != .map) return sk.report("chat body: not a map");
        const text = sk.textField(b, "text") catch |e| return sk.wrap(a, "chat body", e);
        var tree = sk.linkField(b, "tree") catch |e| return sk.wrap(a, "chat body", e);
        const model = sk.textField(b, "model") catch |e| return sk.wrap(a, "chat body", e);
        const thinking = sk.textField(b, "thinking") catch |e| return sk.wrap(a, "chat body", e);
        const list = sk.listField(b, "annotations") catch |e| return sk.wrap(a, "chat body", e);
        const notes = try a.alloc(Note, list.len);
        for (list, notes) |x, *n| {
            if (x != .map and x != .null) return sk.report("chat body: annotations: not a map");
            n.* = .{
                .present = sk.linkField(x, "present") catch |e| return sk.wrap(a, "chat body", e),
                .block = sk.textField(x, "block") catch |e| return sk.wrap(a, "chat body", e),
                .note = sk.textField(x, "note") catch |e| return sk.wrap(a, "chat body", e),
            };
        }
        if (l.conv.items.len == 0) {
            // A new conversation that names no tree starts from `main`, if there is one.
            if (tree.len == 0) tree = (try sk.head(a, "main")) orelse "";
            // Its system prompt, from that tree, kept for the whole conversation.
            var of = tree;
            if (of.len == 0) {
                of = &sk.empty_tree;
                try sk.putEmptyTree();
            }
            _ = try l.keepTurn(.{ .of = of, .role = "system", .content = try prompt(a, tree) });
        }
        const user = try l.keepTurn(.{ .of = message, .role = "user", .text = text, .tree = tree, .model = model, .thinking = thinking, .annotations = notes });
        // The opener's annotations: each a record of its own, kept beside the turn
        // (which carries them into the prompt), and streamed back with its CID.
        for (notes) |n| {
            const r = Record{ .kind = "annotation", .of = user, .by = "user", .present = n.present, .block = n.block, .note = n.note };
            _ = try l.put(r.kind, try r.value(a));
            if (l.streaming()) try l.stream(r);
        }
        return l.infer(false);
    }

    /// completion: the inference peer's answer to our `infer`.
    fn completion(l: *Loop, reply: Value) !void {
        const a = l.a;
        const message = try sk.linkField(reply, "message");
        const b = try sk.readBody(a, message, try sk.linkField(reply, "body"));
        if (b != .map) return sk.report("completion body: not a map");
        const missing = sk.listField(b, "missing") catch |e| return sk.wrap(a, "completion body", e);
        for (missing) |x| if (x != .cid) return sk.report("completion body: missing: not a list of CIDs");
        var err = sk.textField(b, "error") catch |e| return sk.wrap(a, "completion body", e);
        const model = sk.textField(b, "model") catch |e| return sk.wrap(a, "completion body", e);
        const ms = sk.intField(b, "ms") catch |e| return sk.wrap(a, "completion body", e);
        const m: ?Value = if (b.get("message")) |x| (if (x == .null) null else x) else null;
        if (m) |x| if (x != .map) return sk.report("completion body: message: not a map");
        if (missing.len > 0 and err.len == 0) {
            // The peer lost the conversation (a restart, an eviction): send it
            // all, once. `missing` for a request that already carried it all —
            // the first of the conversation (no assistant turn yet), or the
            // resend itself — is an error.
            if (!eql(u8, l.last, "missing") and l.lastAssistant() != null) {
                const t = Turn{ .kind = "missing", .of = message, .missing = missing };
                _ = try l.put("missing", try t.value(a));
                return l.infer(true);
            }
            err = try std.fmt.allocPrint(a, "the inference peer is missing {d} node(s) after the whole conversation was sent", .{missing.len});
        }
        if (err.len > 0 or m == null) {
            const msg = if (err.len > 0) err else "completion has no message";
            try l.fail(message, msg);
            return l.answer(try std.fmt.allocPrint(a, "inference failed: {s}", .{msg}));
        }
        const content = sk.textField(m.?, "content") catch |e| return sk.wrap(a, "completion body", e);
        const reasoning = sk.textField(m.?, "reasoning") catch |e| return sk.wrap(a, "completion body", e);
        const calls = toolCallsOf(a, m.?.get("tool_calls")) catch |e| return sk.wrap(a, "completion body", e);
        const c = try l.keepTurn(.{ .of = message, .role = "assistant", .content = content, .reasoning = reasoning, .tool_calls = calls, .model = model, .ms = ms, .usage = b.get("usage") });
        if (l.streaming() and reasoning.len > 0) try l.stream(.{ .kind = "thinking", .of = c, .text = reasoning });
        return l.next();
    }

    /// toolDone: the shell for the first pending call came to rest.
    fn toolDone(l: *Loop, res: Value) !void {
        const a = l.a;
        const pending = try l.pendingCalls();
        if (pending.len == 0) return sk.report("a shell finished but no tool call is pending");
        const call = pending[0];
        var tree = l.workTree();
        var code: i128 = -1;
        var stdout: []const u8 = "";
        var stderr: []const u8 = "";
        const state = Value.str(res.get("state")) orelse "";
        if (eql(u8, state, "finished") and res.get("result") != null) {
            const sr = res.get("result").?;
            if (sr != .map and sr != .null) return sk.report("shell result: not a map");
            code = sk.intField(sr, "exitCode") catch |e| return sk.wrap(a, "shell result", e);
            stdout = try capText(a, bytesField(sr, "stdout") catch |e| return sk.wrap(a, "shell result", e));
            stderr = try capText(a, bytesField(sr, "stderr") catch |e| return sk.wrap(a, "shell result", e));
            const t = sk.linkField(sr, "tree") catch |e| return sk.wrap(a, "shell result", e);
            if (t.len > 0) tree = t;
        } else {
            const e: Value = res.get("error") orelse .null;
            stderr = try std.fmt.allocPrint(a, "shell {s}: {s}", .{ state, Value.str(e.get("message")) orelse "" });
        }
        try l.result(call, .{ .of = try sk.linkField(res, "thread"), .exit_code = code, .stdout = stdout, .stderr = stderr, .tree = tree });
        return l.next();
    }

    /// next: run the next pending tool call; when none is left, ask the model again
    /// if the last answer called tools, else answer with its content.
    fn next(l: *Loop) !void {
        const a = l.a;
        for (try l.pendingCalls()) |call| {
            const attempt = l.attemptOf(call.id);
            if (attempt == 1) try l.started(call);
            if (eql(u8, call.name, "message")) {
                const ma = try messageArgs(a, call);
                var msg = ma.problem;
                if (msg.len == 0) {
                    const cause = l.deliver(ma) catch |e| switch (e) {
                        error.Awaiting => return,
                        else => return e,
                    };
                    if (sk.transient(cause) and attempt < l.setting("sendAttempts", send_attempts)) return l.retry(call, ma.to, attempt, cause);
                    msg = try std.fmt.allocPrint(a, "could not deliver to {s}: {s}", .{ ma.to, cause });
                    if (attempt > 1) msg = try std.fmt.allocPrint(a, "{s} ({d} attempts)", .{ msg, attempt });
                }
                try l.result(call, .{ .of = l.entry, .to = ma.to, .err = msg });
                continue;
            }
            if (l.enabled(call.name) and isOptional(call.name)) {
                try l.artefact(call);
                continue;
            }
            const d = try gojson.decode(a, call.arguments, &.{.{ .name = "cmd" }}, "struct { Cmd string \"json:\\\"cmd\\\"\" }");
            const cmd = d.got[0].text;
            if (eql(u8, call.name, "bash") and d.err == null and cmd.len > 0) return l.launch(cmd);
            const msg = if (eql(u8, call.name, "bash")) "bash wants {\"cmd\": string}" else try std.fmt.allocPrint(a, "unknown tool {s}", .{call.name});
            try l.result(call, .{ .of = l.entry, .exit_code = 2, .stdout = "", .stderr = msg, .tree = l.workTree() });
        }
        const last = l.lastAssistant();
        if (last) |t| if ((try toolCallsOf(a, t.get("tool_calls"))).len > 0) return l.infer(false);
        const text = if (last) |t| Value.str(t.get("content")) orelse "" else "";
        return l.answer(text);
    }

    /// deliver a `message` call: resolve the handle, send the chat and rest on
    /// the reply (error.Awaiting); or why it could not be delivered.
    fn deliver(l: *Loop, ma: MessageArgs) ![]const u8 {
        const a = l.a;
        const key = sk.resolve(a, l.in, ma.handle, ma.domain) catch |e| {
            if (e == error.OutOfMemory) return e;
            return a.dupe(u8, sk.errorText(e));
        };
        const sent = l.messageTo(key, ma.handle, ma.domain, ma.text) catch |e| {
            if (e == error.OutOfMemory) return e;
            return a.dupe(u8, sk.errorText(e));
        };
        try sk.awaitRecord(sent);
        return error.Awaiting;
    }

    /// attemptOf: which attempt at tool call `id` of the latest assistant turn this is (1 + its retry notes since).
    fn attemptOf(l: *Loop, id: []const u8) i64 {
        var last: i64 = -1;
        for (l.conv.items, 0..) |r, i| if (eql(u8, role(r), "assistant")) {
            last = @intCast(i);
        };
        var n: i64 = 1;
        for (l.retries.items) |m| if (eql(u8, m.call, id) and @as(i64, @intCast(m.turns)) > last) {
            n += 1;
        };
        return n;
    }

    /// retry: a `message` delivery failed transiently: keep a note of it and rest
    /// until the retry's deadline; the wake runs the call again (next).
    fn retry(l: *Loop, call: ToolCall, to: []const u8, attempt_n: i64, cause: []const u8) !void {
        const a = l.a;
        var m = cbor.MapBuilder.init(a);
        try m.put("kind", cbor.string("retry"));
        try m.put("of", try link(l.entry));
        try m.put("call", cbor.string(call.id));
        try m.put("to", cbor.string(to));
        try m.put("attempt", cbor.int(attempt_n));
        try m.put("error", cbor.string(cause));
        _ = try l.put("retry", m.value());
        try l.retries.append(.{ .call = call.id, .turns = l.conv.items.len });
        const wait = l.setting("sendRetryMs", send_retry_ms);
        say(a, "loop: message to {s}: attempt {d} failed ({s}); again in {d} ms\n", .{ to, attempt_n, cause, wait });
        const at: i64 = @intCast(Value.intOf(l.in.get("at")) orelse 0);
        sk.deadline(at + wait) catch |e| {
            if (e == error.ImportFailed and sk.lastError().len > 0) return sk.wrap(a, "deadline", e);
            return sk.report(try std.fmt.allocPrint(a, "deadline {d} refused", .{at + wait}));
        };
    }

    /// messageTo: a `chat` to another party (the identity its handle resolved to),
    /// delivered over http by the messagebox (#40); the caller rests on the reply,
    /// as on an `infer`. If this thread already has a conversation with that
    /// identity — it opened the thread, or answered one of our messages — the chat
    /// is a reply to their latest message here, so their waiting thread resumes
    /// with it; else it starts a new conversation.
    fn messageTo(l: *Loop, key: []const u8, handle: []const u8, domain: []const u8, text: []const u8) ![]const u8 {
        const reply_to = try l.latestFrom(key);
        var b = cbor.MapBuilder.init(l.a);
        try b.put("text", cbor.string(text));
        try b.put("replyTo", optLink(reply_to));
        return sk.send(l.a, l.in, key, "chat", b.value(), handle, domain);
    }

    /// latestFrom: the latest message this thread received from identity `key` —
    /// the opener's chats (user turns) and the answers to our messages (tool turns
    /// with `sent`) — or null if it has none.
    fn latestFrom(l: *Loop, key: []const u8) !?[]const u8 {
        var latest: ?[]const u8 = null;
        for (l.conv.items) |r| {
            const rl = role(r);
            if (!eql(u8, rl, "user") and !(eql(u8, rl, "tool") and Value.cidOf(r.get("sent")) != null)) continue;
            const of = Value.cidOf(r.get("of")) orelse "";
            const m = try sk.readMessage(l.a, of);
            const from = sk.keyOf(l.a, m.get("sender")) catch |e| return sk.wrap(l.a, "message record", e);
            if (eql(u8, from orelse "", key)) latest = of;
        }
        return latest;
    }

    /// messaging: the `message` call this thread rests on, if it rests on one (the
    /// first pending call is a message; the step that emitted it awaited the answer).
    fn messaging(l: *Loop) !?ToolCall {
        const p = try l.pendingCalls();
        if (p.len == 0 or !eql(u8, p[0].name, "message")) return null;
        return p[0];
    }

    /// messageDone: the other party's reply to our message: kept as its tool result.
    fn messageDone(l: *Loop, call: ToolCall, reply: Value) !void {
        const a = l.a;
        const ma = try messageArgs(a, call);
        const message = try sk.linkField(reply, "message");
        const b = try sk.readBody(a, message, try sk.linkField(reply, "body"));
        const text = sk.textField(if (b == .map) b else Value.null, "text") catch |e| return sk.wrap(a, "message answer", e);
        if (b != .map and b != .null) return sk.report("message answer: not a map");
        try l.result(call, .{ .of = message, .to = ma.to, .sent = try sk.linkField(reply, "replyTo"), .text = text });
        return l.next();
    }

    fn launch(l: *Loop, cmd: []const u8) !void {
        const a = l.a;
        const tree = l.workTree();
        if (eql(u8, tree, &sk.empty_tree)) try sk.putEmptyTree();
        var m = cbor.MapBuilder.init(a);
        try m.put("cmd", cbor.string(cmd));
        try m.put("tree", cbor.cidv(tree));
        const ac = try sk.put(a, m.value());
        const shell = sk.program(l.in, "shell") orelse return sk.report("no shell program");
        _ = try sk.launch(a, shell, ac);
    }

    /// infer: ask the inference peer for the next completion; rest on it. The
    /// request carries the turns from the latest assistant turn on — the peer holds
    /// everything up to that turn's parent, the last node of the request it
    /// answered — or, the first time and when `all`, the whole conversation.
    /// `model` and `thinking`: the latest user turn's, else the genesis defaults.
    fn infer(l: *Loop, all: bool) !void {
        const a = l.a;
        const peers: Value = l.in.get("peers") orelse .null;
        const peer = (sk.keyOf(a, peers.get("infer")) catch |e| return sk.wrap(a, "input", e)) orelse "";
        if (peer.len == 0) return l.answer("no inference peer is configured (genesis peers.infer)");
        var model = l.default("model");
        var thinking = l.default("thinking");
        if (model.len == 0) model = default_model;
        var i = l.conv.items.len;
        while (i > 0) {
            i -= 1;
            const r = l.conv.items[i];
            if (eql(u8, role(r), "user")) {
                const m = Value.str(r.get("model")) orelse "";
                if (m.len > 0) model = m;
                const t = Value.str(r.get("thinking")) orelse "";
                if (t.len > 0) thinking = t;
                break;
            }
        }
        var from: usize = 0;
        var parent: ?[]const u8 = null;
        if (!all) {
            i = l.conv.items.len;
            while (i > 0) {
                i -= 1;
                if (eql(u8, role(l.conv.items[i]), "assistant")) {
                    from = i;
                    parent = Value.cidOf(l.conv.items[i].get("parent"));
                    break;
                }
            }
        }
        var tools = std.array_list.Managed(Value).init(a);
        try tools.append(try gojson.valueOf(a, bash_tool));
        try tools.append(try gojson.valueOf(a, message_tool));
        for (optional_tools) |t| if (l.enabled(t[0])) try tools.append(try gojson.valueOf(a, t[1]));
        const nodes = try a.alloc(Value, l.cids.items.len - from);
        for (l.cids.items[from..], nodes) |c, *n| n.* = sk.get(a, c) catch |e| return sk.wrap(a, "get turn", e);
        var body = cbor.MapBuilder.init(a);
        try body.put("model", cbor.string(model));
        try body.put("thinking", optText(thinking));
        try body.put("tools", .{ .array = tools.items });
        try body.put("parent", optLink(parent));
        try body.put("nodes", .{ .array = nodes });
        var handle: []const u8 = "";
        var domain: []const u8 = "";
        if (l.in.get("names")) |names| if (names == .array) for (names.array) |n| {
            const k = sk.keyOf(a, n.get("identityKey")) catch null;
            if (k != null and eql(u8, k.?, peer)) {
                handle = Value.str(n.get("handle")) orelse "";
                domain = Value.str(n.get("domain")) orelse "";
                break;
            }
        };
        const sent = sk.send(a, l.in, peer, "infer", body.value(), handle, domain) catch |e| {
            if (e == error.OutOfMemory) return e;
            const msg = try std.fmt.allocPrint(a, "could not deliver to the inference peer: {s}", .{sk.errorText(e)});
            try l.fail(l.entry, msg);
            return l.answer(try std.fmt.allocPrint(a, "inference failed: {s}", .{msg}));
        };
        try sk.awaitRecord(sent);
    }

    /// answer: the turn's answer to the opener — a `chat` replying to their latest
    /// message in this thread (the chat that opened the turn, or their reply to a
    /// message) — then rest on their reply, which continues the conversation.
    fn answer(l: *Loop, text: []const u8) !void {
        const a = l.a;
        const reply_to = (try l.latestFrom(l.sender)) orelse l.message;
        var b = cbor.MapBuilder.init(a);
        try b.put("text", cbor.string(text));
        try b.put("tree", optLink(l.workTree()));
        try b.put("thread", optLink(Value.cidOf(l.in.get("thread"))));
        try b.put("replyTo", optLink(reply_to));
        const sent = sk.send(a, l.in, l.sender, "chat", b.value(), "", "") catch |e| {
            if (e == error.OutOfMemory) return e;
            // The reply this turn would rest on cannot come: note it (the error
            // turn, and one line on stderr: the step's log line), and the thread
            // ends — nothing is tried again.
            const why = try a.dupe(u8, sk.errorText(e));
            say(a, "loop: could not deliver the answer: {s}\n", .{why});
            return l.fail(l.entry, try std.fmt.allocPrint(a, "could not deliver the answer: {s}", .{why}));
        };
        try sk.awaitRecord(sent);
    }

    /// lastAssistantCid: the latest assistant turn's CID (what a tool call is of).
    fn lastAssistantCid(l: *Loop) ?[]const u8 {
        var i = l.conv.items.len;
        while (i > 0) {
            i -= 1;
            if (eql(u8, role(l.conv.items[i]), "assistant")) return l.cids.items[i];
        }
        return null;
    }

    fn lastAssistant(l: *Loop) ?Value {
        var i = l.conv.items.len;
        while (i > 0) {
            i -= 1;
            if (eql(u8, role(l.conv.items[i]), "assistant")) return l.conv.items[i];
        }
        return null;
    }

    /// pendingCalls: the last answer's tool calls with no tool result yet, in order.
    fn pendingCalls(l: *Loop) ![]const ToolCall {
        var last: ?usize = null;
        for (l.conv.items, 0..) |r, i| if (eql(u8, role(r), "assistant")) {
            last = i;
        };
        const li = last orelse return &.{};
        var out = std.array_list.Managed(ToolCall).init(l.a);
        for (try toolCallsOf(l.a, l.conv.items[li].get("tool_calls"))) |c| {
            const done = for (l.conv.items[li + 1 ..]) |r| {
                if (eql(u8, role(r), "tool") and eql(u8, Value.str(r.get("call")) orelse "", c.id)) break true;
            } else false;
            if (!done) try out.append(c);
        }
        return out.items;
    }

    /// workTree: the working tree now — the latest one a chat named (the opening one: or `main`) or a tool produced; else the empty tree.
    fn workTree(l: *Loop) []const u8 {
        var t: []const u8 = &sk.empty_tree;
        for (l.conv.items) |r| {
            const rl = role(r);
            if (eql(u8, rl, "user") or eql(u8, rl, "tool")) if (Value.cidOf(r.get("tree"))) |x| {
                t = x;
            };
        }
        return t;
    }

    /// artefact runs a say, present or annotate call: put its record, keep it,
    /// send it to the opener in `turn`, and answer the model with its CID (and a
    /// present's block ids). Bad arguments are an error result, and nothing is sent.
    fn artefact(l: *Loop, call: ToolCall) !void {
        const a = l.a;
        const fields = [_]gojson.Field{ .{ .name = "text" }, .{ .name = "page" }, .{ .name = "blocks", .blocks = true }, .{ .name = "present" }, .{ .name = "block" }, .{ .name = "note" } };
        const d = try gojson.decode(a, call.arguments, &fields, artefact_type);
        const text = d.got[0].text;
        const page = d.got[1].text;
        const blocks = d.got[2].blocks orelse &.{};
        const present = d.got[3].text;
        const block = d.got[4].text;
        const note = d.got[5].text;
        var r = Record{ .kind = call.name, .of = l.lastAssistantCid(), .call = call.id };
        var problem: []const u8 = "";
        if (d.err) |e| {
            problem = try std.fmt.allocPrint(a, "{s}: arguments are not a JSON object: {s}", .{ call.name, e });
        } else if (eql(u8, call.name, "say")) {
            if (text.len == 0) problem = "say wants {\"text\": string}";
            r.text = text;
        } else if (eql(u8, call.name, "present")) {
            if (page.len == 0) {
                problem = "present wants {\"page\": string, \"blocks\"?: [{\"id\": string, …}]}";
            } else if (try checkBlocks(a, blocks)) |msg| {
                problem = try std.fmt.allocPrint(a, "present: {s}", .{msg});
            }
            r.page = page;
            if (problem.len == 0) {
                const bs = try a.alloc(Value, blocks.len);
                for (blocks, bs) |x, *o| o.* = x.?;
                r.blocks = bs;
            }
        } else annotate: {
            r.kind = "annotation";
            r.by = "model";
            r.block = block;
            r.note = note;
            if (present.len == 0 or note.len == 0) {
                problem = "annotate wants {\"present\": <cid>, \"block\"?: string, \"note\": string}";
                break :annotate;
            }
            const p = try l.presented(present) orelse {
                problem = try std.fmt.allocPrint(a, "annotate: no page {s} was presented in this conversation", .{try gojson.quote(a, present)});
                break :annotate;
            };
            if (block.len > 0 and p.blocks.len > 0) {
                const has = for (p.blocks) |x| {
                    if (eql(u8, x, block)) break true;
                } else false;
                if (!has) {
                    problem = try std.fmt.allocPrint(a, "annotate: the page has no block {s} (its blocks: {s})", .{ try gojson.quote(a, block), try std.mem.join(a, ", ", p.blocks) });
                    break :annotate;
                }
            }
            r.present = p.cid;
        }
        if (problem.len > 0) return l.result(call, .{ .of = l.entry, .err = problem });
        const c = try l.put(r.kind, try r.value(a));
        const ids = try blockIds(a, r.blocks);
        if (eql(u8, r.kind, "present")) try l.presents.append(.{ .cid = c, .blocks = ids });
        try l.stream(r);
        // The answer, as Go's json.Marshal wrote the map: keys sorted.
        var out = std.array_list.Managed(u8).init(a);
        try out.append('{');
        if (eql(u8, r.kind, "present")) {
            try out.appendSlice("\"blocks\":[");
            for (ids, 0..) |id, i| {
                if (i > 0) try out.append(',');
                try gojson.writeString(&out, id);
            }
            try out.appendSlice("],");
        }
        try gojson.writeString(&out, r.kind);
        try out.append(':');
        try gojson.writeString(&out, try cbor.cidm.format(a, c));
        try out.append('}');
        return l.result(call, .{ .of = c, .text = out.items });
    }

    /// presented: the page presented in this thread whose CID is s, or null.
    fn presented(l: *Loop, s: []const u8) !?Presented {
        const want = std.mem.trim(u8, s, " \t\n\r\x0b\x0c");
        for (l.presents.items) |p| if (eql(u8, try cbor.cidm.format(l.a, p.cid), want)) return p;
        return null;
    }
};

const MessageArgs = struct { to: []const u8 = "", handle: []const u8 = "", domain: []const u8 = "", text: []const u8 = "", problem: []const u8 = "" };

/// messageArgs: a `message` call's arguments — the handle as "@handle@domain"
/// and its parts, the text — or what is wrong with them.
fn messageArgs(a: Allocator, call: ToolCall) !MessageArgs {
    const d = try gojson.decode(a, call.arguments, &.{ .{ .name = "to" }, .{ .name = "text" } }, "struct { To string \"json:\\\"to\\\"\"; Text string \"json:\\\"text\\\"\" }");
    const to = d.got[0].text;
    const text = d.got[1].text;
    if (d.err != null or text.len == 0) return .{ .problem = "message wants {\"to\": \"@handle@domain\", \"text\": string}" };
    var h = std.mem.trim(u8, to, " \t\n\r\x0b\x0c");
    if (std.mem.startsWith(u8, h, "@")) h = h[1..];
    const at = std.mem.indexOfScalar(u8, h, '@');
    if (at == null or std.mem.indexOfScalarPos(u8, h, at.? + 1, '@') != null or at.? == 0 or at.? == h.len - 1) {
        return .{ .to = to, .problem = try std.fmt.allocPrint(a, "message: `to` must be a handle, @handle@domain, not {s}", .{try gojson.quote(a, to)}) };
    }
    const handle = h[0..at.?];
    const domain = h[at.? + 1 ..];
    return .{ .to = try std.fmt.allocPrint(a, "@{s}@{s}", .{ handle, domain }), .handle = handle, .domain = domain, .text = text };
}

/// checkBlocks: what is wrong with a present's blocks, or null.
fn checkBlocks(a: Allocator, blocks: []const ?Value) !?[]const u8 {
    var seen = std.array_list.Managed([]const u8).init(a);
    for (blocks, 0..) |b, i| {
        const id = if (b) |x| Value.str(x.get("id")) orelse "" else "";
        if (id.len == 0) return try std.fmt.allocPrint(a, "block {d} has no string id", .{i});
        for (seen.items) |s| if (eql(u8, s, id)) return try std.fmt.allocPrint(a, "two blocks have the id {s}", .{try gojson.quote(a, id)});
        try seen.append(id);
    }
    return null;
}

/// blockIds: the blocks' ids, in order.
fn blockIds(a: Allocator, blocks: []const Value) ![]const []const u8 {
    var ids = std.array_list.Managed([]const u8).init(a);
    for (blocks) |b| if (Value.str(b.get("id"))) |id| try ids.append(id);
    return ids.items;
}

/// A byte-string field of the shell's result: its bytes ("" when absent or null).
fn bytesField(v: Value, key: []const u8) ![]const u8 {
    const x = v.get(key) orelse return "";
    return switch (x) {
        .null => "",
        .bytes => |b| b,
        else => sk.report("stdout/stderr: not bytes"),
    };
}

fn capText(a: Allocator, b: []const u8) ![]const u8 {
    if (b.len <= output_cap) return b;
    return std.fmt.allocPrint(a, "{s}\n… ({d} more bytes)", .{ b[0..output_cap], b.len - output_cap });
}

/// prompt: a new conversation's system prompt, from the tree it starts on:
/// /SOUL.md (else the fixed one), then /IDENTITY.md and /ROSTER.md after it,
/// each if there is one. A tree that cannot be read counts as having none.
fn prompt(a: Allocator, tree: []const u8) ![]const u8 {
    var p: []const u8 = system;
    if (tree.len == 0) return p;
    if (sk.readFile(a, tree, "SOUL.md") catch null) |soul| p = soul;
    for ([_][]const u8{ "IDENTITY.md", "ROSTER.md" }) |name| {
        if (sk.readFile(a, tree, name) catch null) |f| p = try std.fmt.allocPrint(a, "{s}\n\n{s}", .{ std.mem.trimEnd(u8, p, "\n"), f });
    }
    return p;
}

fn start(a: Allocator) !void {
    const in = try sk.input(a);
    const args: Value = in.get("args") orelse .null;
    var l = Loop{
        .a = a,
        .in = in,
        .message = try sk.linkField(args, "message"),
        .sender = (sk.keyOf(a, args.get("sender")) catch |e| return sk.wrap(a, "args", e)) orelse "",
        .entry = Value.cidOf(in.get("entry")) orelse "",
        .conv = .init(a),
        .cids = .init(a),
        .presents = .init(a),
        .retries = .init(a),
    };
    if (Value.cidOf(in.get("tip"))) |tip| {
        const cids = sk.kept(a, tip) catch |e| return sk.wrap(a, "chain", e);
        for (cids) |c| {
            const r = try sk.get(a, c);
            const kind = Value.str(r.get("kind")) orelse "";
            l.last = kind;
            if (eql(u8, kind, "turn")) {
                try l.conv.append(r);
                try l.cids.append(c);
            } else if (eql(u8, kind, "present")) {
                const bs = sk.listField(r, "blocks") catch |e| return sk.wrap(a, "present", e);
                try l.presents.append(.{ .cid = c, .blocks = try blockIds(a, bs) });
            } else if (eql(u8, kind, "retry")) {
                try l.retries.append(.{ .call = Value.str(r.get("call")) orelse "", .turns = l.conv.items.len });
            }
        }
    }
    const reply: ?Value = if (in.get("reply")) |r| (if (r == .null) null else r) else null;
    const resolved = sk.listField(in, "resolved") catch |e| return sk.wrap(a, "input", e);
    const woke = if (in.get("woke")) |w| w == .bool and w.bool else false;
    if (reply) |r| {
        if (eql(u8, Value.str(r.get("box")) orelse "", "completions")) return l.completion(r);
        if (try l.messaging()) |call| return l.messageDone(call, r);
        return l.chat(try sk.linkField(r, "message"), try sk.linkField(r, "body"));
    }
    if (resolved.len > 0) return l.toolDone(resolved[0]);
    // A retry's deadline: the pending `message` call again.
    if (woke) return l.next();
    return l.chat(l.message, try sk.linkField(args, "body"));
}
