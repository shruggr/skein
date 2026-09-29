// The programs a runtime starts with and the pinned modules
// (src/runtime/programs.ts). Kept in sync by hand; a test checks every CID
// against the TypeScript's (test/fixtures.json).
const std = @import("std");
const cbor = @import("cbor.zig");
const cidm = @import("cid.zig");
const Value = cbor.Value;

pub const Module = struct { name: []const u8, cid: []const u8 };

/// MODULES, in declaration order (install order).
pub const modules = [_]Module{
    .{ .name = "brush", .cid = "bafkreiemwcli2372geseu7l527ivxwjodogng7zoltixf6pfh5ujnpauc4" },
    .{ .name = "coreutils", .cid = "bafkreidohpuc5gyi4xroxlhc367ry5hkpixtabc7sln2tidedeqbwcgese" },
    .{ .name = "run-handler", .cid = "bafkreidt7tsn5l3xg2jyt72cmtd23ggopfsol4gdbdiu7kb3b2jmxrm2i4" },
    .{ .name = "objects-handler", .cid = "bafkreiht7bb4iry6hg6tcr4j73rtunxuxh3kgjizsdqpvjrfvaxx2idtyy" },
    .{ .name = "head-handler", .cid = "bafkreibc5a5u375bxqpq6oo6r3tzfv23qku3jnjtejwh6dxgk2kwljs32m" },
    .{ .name = "subscribe-handler", .cid = "bafkreiaotl4zkhkuxe2yykptlkhc23imyawimbt5vhuxqxjamov5k2e7di" },
    .{ .name = "loop", .cid = "bafkreihf3wwfzvgd5p3oqf7wixvxo2esmcigqxyf6culaa3xxruyro4sb4" },
    // The wallet's state inside the VM (issue #29): installed, not in a genesis by default.
    .{ .name = "wallet", .cid = "bafkreid2kaqltmak2eayvteju5gopb7z5eww2mk5ciiysfbgvp6ptum3aa" },
    // The messagebox's records in the instance (issue #33): Zig, wasm32-wasi (programs/messagebox).
    .{ .name = "messagebox", .cid = "bafkreiehhusheqk3oguayz43gbtwdqdx6fcpatiuztzomuglrj7ksm266m" },
    // The front door (#40): the instance as an HTTP server — BRC-103/104, routes, handlers (programs/frontdoor).
    .{ .name = "frontdoor", .cid = "bafkreia4gjhjv5wea2ahu3sknay6wehzrjuxqcaz3s5i6laxpgvvg3wq64" },
    // The peer table's writer (#40): BRC-169 resolve, the admin's `peers`, `register` claims (programs/resolve).
    .{ .name = "resolve", .cid = "bafkreicxsp4aoppj6xvfmdgh5lh7g4dxmajv7zepyykaovrrixujvnv63y" },
    .{ .name = "find", .cid = "bafkreib7nn5j3hys3m2ux5mzwxnesqzspfou2lng5jcudvnps3g5kpv4bu" },
    .{ .name = "xargs", .cid = "bafkreiaizwk5lqff2b23kpovpsglmct5xconf7n45zlzekyplvnjjjqgju" },
    .{ .name = "diff", .cid = "bafkreifhra2rwueqtn3pqjpjfmobhd6dcijhexr46eyfcnr5hs3gmebv6i" },
    .{ .name = "cmp", .cid = "bafkreifhra2rwueqtn3pqjpjfmobhd6dcijhexr46eyfcnr5hs3gmebv6i" },
    .{ .name = "jq", .cid = "bafkreih226yv4dcowahyziroqms5r6h4k7mliutf2kpjp3klofcskdg56e" },
    .{ .name = "which", .cid = "bafkreicdmerbpermjjw5x26pjokqhwbwbsncfqgdw63zo2e2g6tmm43iye" },
    .{ .name = "grep", .cid = "bafkreihbm7x5gatusjkpo7oxwkh43ltpv7osaw4jaiia46hzl7ua64dvye" },
    .{ .name = "tree", .cid = "bafkreiaubyrhpjhf2n6owdq4xtdemxfu6bbfzs3dcsssjhxnoovsw67yh4" },
    .{ .name = "awk", .cid = "bafkreibop3tyl52wkntqcxwgy5ub2ybfs2hwl725tiixxtinrxlmblhlju" },
    .{ .name = "sed", .cid = "bafkreidwtqxsblyapruappd2uuffd633ti6zgizh5giwiscl34lbuctzcy" },
    .{ .name = "git", .cid = "bafkreiak3i7snop2xhiyilewrhcm5jgdjpfwuzk5awjqhd2hafzttwwrxe" },
    // Script runtimes (issue #25): QuickJS-ng (also `node`) and CPython (also `python3`).
    .{ .name = "qjs", .cid = "bafkreig4lw4ceuhl5qvzr43ketajajhkexgqmg6et2rpjlx66dvavw6zwe" },
    .{ .name = "python", .cid = "bafkreid5irpih6ehtwxvg2jf556f4bupz2p54c5n746i5r5spxpta2i42m" },
};

/// FILES: support files the shell's programs read (raw blocks, like the
/// modules), each committed as wasm/<name>; installed with the modules.
pub const files = [_]Module{
    .{ .name = "python314.zip", .cid = "bafkreigogn32gek27rar2k5pacj2knivlobbjc6tip25qki3hjr3d2v5ce" },
};

/// The shell's extra single-purpose tools (programs.ts TOOL_NAMES).
pub const tool_names = [_][]const u8{ "find", "xargs", "diff", "cmp", "jq", "which", "grep", "tree", "awk", "sed", "git", "qjs", "python" };

/// TOOL_ALIASES: more command names for a module in tool_names (`node` is qjs
/// with its node shim, chosen by argv[0]).
pub const Alias = struct { name: []const u8, of: []const u8 };
pub const tool_aliases = [_]Alias{ .{ .name = "node", .of = "qjs" }, .{ .name = "python3", .of = "python" } };

/// What an extra program needs besides its module (shell.ts Support):
/// files mounted read-only at `mount` for that program only, and env
/// defaults the caller's env overrides. Python's stdlib (programs.ts PYTHON_*).
pub const Support = struct {
    mount: []const u8,
    files: []const Module, // path under mount → FILES name
    env: []const [2][]const u8,
};
pub const python_home = "/opt/skein/python";
const python_support = Support{
    .mount = python_home,
    .files = &.{.{ .name = "lib/python314.zip", .cid = "python314.zip" }},
    .env = &.{ .{ "PYTHONHOME", python_home }, .{ "PYTHONDONTWRITEBYTECODE", "1" } },
};
pub const supported = [_]struct { name: []const u8, support: Support }{
    .{ .name = "python", .support = python_support },
    .{ .name = "python3", .support = python_support },
};

pub fn supportOf(name: []const u8) ?*const Support {
    for (&supported) |*x| if (std.mem.eql(u8, x.name, name)) return &x.support;
    return null;
}

pub fn fileText(name: []const u8) []const u8 {
    for (files) |f| if (std.mem.eql(u8, f.name, name)) return f.cid;
    unreachable;
}

pub fn moduleText(name: []const u8) []const u8 {
    for (modules) |m| if (std.mem.eql(u8, m.name, name)) return m.cid;
    unreachable;
}

pub fn moduleCid(alloc: std.mem.Allocator, name: []const u8) ![]u8 {
    return cidm.parse(alloc, moduleText(name));
}

const handler_inputs = [_]cbor.Entry{
    .{ .key = "message", .value = .{ .string = "cid" } },
    .{ .key = "body", .value = .{ .string = "cid" } },
    .{ .key = "box", .value = .{ .string = "string" } },
    .{ .key = "sender", .value = .{ .string = "identity" } },
};


const call_inputs = [_]cbor.Entry{
    .{ .key = "event", .value = .{ .string = "cid?" } },
    .{ .key = "box", .value = .{ .string = "string?" } },
};

const Handler = struct { name: []const u8, services: []const []const u8, description: []const u8, inputs: []const cbor.Entry = &handler_inputs };

const handlers = [_]Handler{
    .{ .name = "run-handler", .services = &.{}, .description = "The `run` box: read the body {cmd, tree?, cwd?, env?} (no tree: `main`'s, else the empty tree), run the shell over it, reply in `results`." },
    .{ .name = "objects-handler", .services = &.{}, .description = "The `objects` box: read the bundle {records: [{cid, bytes}], root?}, store each record; a root becomes `main` if there is none." },
    .{ .name = "head-handler", .services = &.{}, .description = "The `head` box: read the body {name, tree}, advance the named head to the tree." },
    .{ .name = "subscribe-handler", .services = &.{}, .description = "The `subscribe` box: read the body {op, sender?, box, handler}, add or remove the subscription (sender, box) → handler (a program record in the store)." },
    .{ .name = "loop", .services = &.{"infer"}, .description = "The `chat` box: the turn loop. Prompt from the tree's SOUL.md; keeps each turn; asks the `infer` peer; runs `bash` tool calls in the shell and `message` calls as a `chat` to another party (a reply, if the thread already talks with them), resting on their reply; answers the opener with a `chat` reply and awaits theirs. Everything it sends goes through the messagebox's `send` (#40)." },
    .{ .name = "messagebox", .services = &.{}, .inputs = &call_inputs, .description = "The BRC-33 messagebox (#40): the front door's sendMessage (one `mail` entry), listMessages (a read), acknowledgeMessage (an `ack` event); stepped, keeps the mail a subscription routes to it (head `mailbox`); called from a step, `send` delivers over http (recorded) on a BRC-104 session with the peer." },
    .{ .name = "resolve", .services = &.{}, .description = "The peer table (#40, head `peers`): `resolve` {handle, domain} looks a BRC-169 handle up (recorded http) and writes its record; the `peers` box (the admin) adds or removes one; the `register` box takes a claim {handle, domain} and records it if it resolves to the sender." },
    .{ .name = "frontdoor", .services = &.{}, .inputs = &call_inputs, .description = "The front door: called with each HTTP request (fn http); runs BRC-103/104 against the session records, routes by the routes table, invokes the handler, signs the answer; stepped on `:sessions` to keep a handshake's session (head `sessions`)." },
};

/// The program names a genesis lists (PROGRAMS), in order.
pub const program_names = [_][]const u8{ "shell", "run-handler", "objects-handler", "head-handler", "subscribe-handler", "loop", "messagebox", "frontdoor", "resolve" };

/// A program record as a value.
pub fn program(alloc: std.mem.Allocator, name: []const u8) !Value {
    var m = cbor.MapBuilder.init(alloc);
    try m.put("kind", cbor.string("program"));
    try m.put("name", cbor.string(name));
    if (std.mem.eql(u8, name, "shell")) {
        var code = cbor.MapBuilder.init(alloc);
        try code.put("ts", cbor.string("shell"));
        try m.put("code", code.value());
        var mods = cbor.MapBuilder.init(alloc);
        try mods.put("brush", cbor.cidv(try moduleCid(alloc, "brush")));
        try mods.put("coreutils", cbor.cidv(try moduleCid(alloc, "coreutils")));
        for (tool_names) |t| try mods.put(t, cbor.cidv(try moduleCid(alloc, t)));
        for (tool_aliases) |t| try mods.put(t.name, cbor.cidv(try moduleCid(alloc, t.of)));
        try m.put("modules", mods.value());
        var sup = cbor.MapBuilder.init(alloc);
        for (supported) |x| {
            var one = cbor.MapBuilder.init(alloc);
            try one.put("mount", cbor.string(x.support.mount));
            var fs = cbor.MapBuilder.init(alloc);
            for (x.support.files) |f| try fs.put(f.name, cbor.cidv(try cidm.parse(alloc, fileText(f.cid))));
            try one.put("files", fs.value());
            var env = cbor.MapBuilder.init(alloc);
            for (x.support.env) |kv| try env.put(kv[0], cbor.string(kv[1]));
            try one.put("env", env.value());
            try sup.put(x.name, one.value());
        }
        try m.put("support", sup.value());
        var inputs = cbor.MapBuilder.init(alloc);
        try inputs.put("cmd", cbor.string("string"));
        try inputs.put("tree", cbor.string("cid"));
        try inputs.put("cwd", cbor.string("string?"));
        try inputs.put("env", cbor.string("map?"));
        try m.put("inputs", inputs.value());
        try m.put("services", .{ .array = &.{} });
        try m.put("description", cbor.string("Run a bash command in the wasm shell over a tree; result {exitCode, stdout, stderr, tree}."));
        return m.value();
    }
    for (handlers) |h| if (std.mem.eql(u8, h.name, name)) {
        var code = cbor.MapBuilder.init(alloc);
        try code.put("wasm", cbor.cidv(try moduleCid(alloc, name)));
        try m.put("code", code.value());
        try m.put("inputs", .{ .map = h.inputs });
        const sv = try alloc.alloc(Value, h.services.len);
        for (h.services, 0..) |s, i| sv[i] = cbor.string(s);
        try m.put("services", .{ .array = sv });
        try m.put("description", cbor.string(h.description));
        return m.value();
    };
    return error.UnknownProgram;
}

pub fn programCid(alloc: std.mem.Allocator, name: []const u8) ![]u8 {
    return cbor.cidOfValue(alloc, try program(alloc, name));
}

/// records.ts isProgram.
pub fn isProgram(x: ?Value) bool {
    const v = x orelse return false;
    if (v != .map) return false;
    if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse return false, "program")) return false;
    const name = Value.str(v.get("name")) orelse return false;
    if (name.len == 0) return false;
    const code = v.get("code") orelse return false;
    if (code != .map) return false;
    const has_ts = Value.str(code.get("ts")) != null;
    const has_wasm = Value.cidOf(code.get("wasm")) != null;
    if (has_ts == has_wasm) return false;
    if (v.get("inputs") == null) return false;
    const services = v.get("services") orelse return false;
    if (services != .array) return false;
    for (services.array) |s| if (s != .string) return false;
    return Value.str(v.get("description")) != null;
}

pub fn wasmOf(p: Value) ?[]const u8 {
    const code = p.get("code") orelse return null;
    return Value.cidOf(code.get("wasm"));
}

pub fn hasService(p: Value, s: []const u8) bool {
    const services = p.get("services") orelse return false;
    if (services != .array) return false;
    for (services.array) |x| if (x == .string and std.mem.eql(u8, x.string, s)) return true;
    return false;
}
