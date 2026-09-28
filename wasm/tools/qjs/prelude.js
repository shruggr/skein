// skein prelude for qjs (QuickJS-ng), evaluated before every script as the
// module "skein:prelude". Upstream qjs has only console.log (which prints
// objects as "[object Object]"); this gives the usual console methods, with
// error/warn on stderr, and a small value formatter. Nothing else changes.
import * as std from "qjs:std";

function inspect(v, depth, seen) {
  if (typeof v === "string") return depth ? `'${JSON.stringify(v).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'` : v;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol" || typeof v === "undefined" || v === null) return String(v);
  if (typeof v === "function") return `[Function: ${v.name || "(anonymous)"}]`;
  if (typeof v !== "object") return String(v);
  if (v instanceof Error) return v.stack ? `${v.name}: ${v.message}\n${v.stack}`.trimEnd() : `${v.name}: ${v.message}`;
  if (seen.includes(v)) return "[Circular]";
  if (depth > 2) return Array.isArray(v) ? "[Array]" : "[Object]";
  const next = [...seen, v];
  if (Array.isArray(v)) return v.length ? `[ ${v.map((x) => inspect(x, depth + 1, next)).join(", ")} ]` : "[]";
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return `${v.constructor.name}(${v.length}) [ ${Array.from(v).join(", ")} ]`;
  if (v instanceof Map) return `Map(${v.size}) { ${[...v].map(([k, x]) => `${inspect(k, depth + 1, next)} => ${inspect(x, depth + 1, next)}`).join(", ")} }`;
  if (v instanceof Set) return `Set(${v.size}) { ${[...v].map((x) => inspect(x, depth + 1, next)).join(", ")} }`;
  if (v instanceof Date) return isNaN(v) ? "Invalid Date" : v.toISOString();
  if (v instanceof RegExp) return String(v);
  const keys = Object.keys(v);
  if (!keys.length) return "{}";
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{ ${keys.map((k) => `${key(k)}: ${inspect(v[k], depth + 1, next)}`).join(", ")} }`;
}

/** console.log's formatting: a leading string may carry %s %d %i %f %j %o %O %%. */
export function format(...args) {
  let out = [];
  if (typeof args[0] === "string" && args.length > 1 && args[0].includes("%")) {
    let i = 1;
    const head = args[0].replace(/%([sdifjoO%])/g, (m, c) => {
      if (c === "%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      switch (c) {
        case "s": return typeof a === "string" ? a : inspect(a, 1, []);
        case "d": case "i": return String(c === "i" ? Math.trunc(Number(a)) : Number(a));
        case "f": return String(Number(a));
        case "j": return JSON.stringify(a);
        default: return inspect(a, 1, []);
      }
    });
    out = [head, ...args.slice(i).map((a) => inspect(a, 0, []))];
  } else out = args.map((a) => inspect(a, 0, []));
  return out.join(" ");
}

function writer(f) {
  return (...args) => { f.puts(format(...args) + "\n"); f.flush(); };
}

const out = writer(std.out), err = writer(std.err);
globalThis.console = {
  log: out, info: out, debug: out,
  error: err, warn: err, trace: err,
  dir: (v) => out(v),
};
