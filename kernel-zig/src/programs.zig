// A program record (src/runtime/records.ts isProgram): {kind: "program", name, code: {wasm: <raw
// CID>}, inputs, services, description}. skein next: nothing is pinned in the kernel binary (no
// front door, mail or resolve program; SPEC 5) and the shell runner moved out (a `code: {ts}`
// record is no program here).
const std = @import("std");
const cbor = @import("cbor");
const Value = cbor.Value;

/// records.ts isProgram: a wasm program record.
pub fn isProgram(x: ?Value) bool {
    const v = x orelse return false;
    if (v != .map) return false;
    if (!std.mem.eql(u8, Value.str(v.get("kind")) orelse return false, "program")) return false;
    const name = Value.str(v.get("name")) orelse return false;
    if (name.len == 0) return false;
    const code = v.get("code") orelse return false;
    if (code != .map) return false;
    if (Value.cidOf(code.get("wasm")) == null or code.get("ts") != null) return false;
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
