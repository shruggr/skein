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
    .{ .name = "run-handler", .cid = "bafkreiawt6fpfgcnjokta75shlzu7ej3o3jzyon2bqhdu3q5gl7gywezjm" },
    .{ .name = "objects-handler", .cid = "bafkreid6muh6uqwhrouywofov75uubrpv26ykojydfb5j2x5abpb342al4" },
    .{ .name = "head-handler", .cid = "bafkreibffmjtkr6q7xalmzia3uzant7kyt6orrpx5l76tbmnmz2wmmso7q" },
    .{ .name = "subscribe-handler", .cid = "bafkreiclc5brxmakpcaky4asqz4a5sjxuftiir5zfrj7h7lyeabkktmz2e" },
    .{ .name = "loop", .cid = "bafkreihi2lx7lj54qaw4lopithify5x5gm7tcdomfig3bjijoqzj5sj2ty" },
    // The wallet's state inside the VM (issue #29): installed, not in a genesis by default.
    .{ .name = "wallet", .cid = "bafkreibcgstrnbzzrjii3unfynwt3tj6jo26qe4i5ktiueh7fc6brxke24" },
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
};

/// The shell's extra single-purpose tools (programs.ts TOOL_NAMES).
pub const tool_names = [_][]const u8{ "find", "xargs", "diff", "cmp", "jq", "which", "grep", "tree", "awk", "sed", "git" };

pub fn moduleText(name: []const u8) []const u8 {
    for (modules) |m| if (std.mem.eql(u8, m.name, name)) return m.cid;
    unreachable;
}

pub fn moduleCid(alloc: std.mem.Allocator, name: []const u8) ![]u8 {
    return cidm.parse(alloc, moduleText(name));
}

const handler_inputs = [_]cbor.Entry{
    .{ .key = "envelope", .value = .{ .string = "cid" } },
    .{ .key = "body", .value = .{ .string = "cid" } },
    .{ .key = "box", .value = .{ .string = "string" } },
    .{ .key = "sender", .value = .{ .string = "identity" } },
};

const Handler = struct { name: []const u8, services: []const []const u8, description: []const u8 };

const handlers = [_]Handler{
    .{ .name = "run-handler", .services = &.{}, .description = "The `run` box: read the body {cmd, tree?, cwd?, env?} (no tree: `main`'s, else the empty tree), run the shell over it, reply in `results`." },
    .{ .name = "objects-handler", .services = &.{}, .description = "The `objects` box: read the bundle {records: [{cid, bytes}], root?}, store each record; a root becomes `main` if there is none." },
    .{ .name = "head-handler", .services = &.{}, .description = "The `head` box: read the body {name, tree}, advance the named head to the tree." },
    .{ .name = "subscribe-handler", .services = &.{}, .description = "The `subscribe` box: read the body {op, sender?, box, handler}, add or remove the subscription (sender, box) → handler (a program record in the store)." },
    .{ .name = "loop", .services = &.{ "infer", "outcomes" }, .description = "The `chat` box: the turn loop. Prompt from the tree's SOUL.md; keeps each turn; asks the `infer` peer; runs `bash` tool calls in the shell and `message` calls as a `chat` to another party (a reply, if the thread already talks with them), resting on their reply; answers the opener with a `chat` reply and awaits theirs." },
};

/// The program names a genesis lists (PROGRAMS), in order.
pub const program_names = [_][]const u8{ "shell", "run-handler", "objects-handler", "head-handler", "subscribe-handler", "loop" };

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
        try m.put("modules", mods.value());
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
        try m.put("inputs", .{ .map = &handler_inputs });
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
