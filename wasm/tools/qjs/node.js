// skein's `node` shim for qjs (QuickJS-ng), the module "skein:node". It runs
// only when qjs is started under the name `node`. It is NOT Node.js: it gives
// the small part of Node's surface that a file + stdio script needs, over
// QuickJS's own std/os modules, and fails loudly on everything else.
//
// Provided: process (argv, argv0, env, exit, exitCode, cwd, chdir, platform,
// stdout.write, stderr.write, nextTick, versions.quickjs), require() and
// `import` of fs, fs/promises, path, process (bare or `node:`-prefixed), a
// CommonJS loader for relative .js/.cjs/.json files, __filename/__dirname in
// the main script, and a minimal Buffer (a Uint8Array with toString(enc),
// from, alloc, concat, isBuffer, byteLength; encodings utf8, hex, base64,
// latin1/binary, ascii). Everything else - child_process, http(s)/net/fetch,
// crypto, os, util, stream, events, worker_threads, timers beyond setTimeout -
// is absent: require() throws MODULE_NOT_FOUND naming the module, an `import`
// fails to load it. See docs/SKILLS.md.
import * as std from "qjs:std";
import * as os from "qjs:os";

// ---------------------------------------------------------------- errors

// wasi-libc errno values (the numbers os.* returns) and their Node codes.
const ERRNO = { 2: ["EACCES", "permission denied"], 8: ["EBADF", "bad file descriptor"], 20: ["EEXIST", "file already exists"],
  28: ["EINVAL", "invalid argument"], 31: ["EISDIR", "illegal operation on a directory"], 44: ["ENOENT", "no such file or directory"],
  54: ["ENOTDIR", "not a directory"], 55: ["ENOTEMPTY", "directory not empty"], 58: ["ENOTSUP", "operation not supported"],
  63: ["EPERM", "operation not permitted"], 69: ["EROFS", "read-only file system"], 76: ["ENOTCAPABLE", "not capable"] };

function fsError(errno, syscall, path) {
  errno = Math.abs(errno);
  const [code, text] = ERRNO[errno] ?? ["EIO", std.strerror(errno)];
  const e = new Error(`${code}: ${text}, ${syscall}${path !== undefined ? ` '${path}'` : ""}`);
  Object.assign(e, { errno: -errno, code, syscall });
  if (path !== undefined) e.path = path;
  return e;
}

// ---------------------------------------------------------------- Buffer

function utf8Encode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.codePointAt(i);
    if (c > 0xffff) i++;
    else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function utf8Decode(b) {
  let s = "";
  for (let i = 0; i < b.length;) {
    const c = b[i];
    let n = 0, cp = 0xfffd;
    if (c < 0x80) { cp = c; n = 1; }
    else if (c >= 0xc2 && c < 0xe0 && (b[i + 1] & 0xc0) === 0x80) { cp = ((c & 31) << 6) | (b[i + 1] & 63); n = 2; }
    else if (c >= 0xe0 && c < 0xf0 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
      cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); n = 3;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    } else if (c >= 0xf0 && c < 0xf5 && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) {
      cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63); n = 4;
      if (cp < 0x10000 || cp > 0x10ffff) cp = 0xfffd;
    }
    if (!n) { n = 1; cp = 0xfffd; }
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function normEnc(enc) {
  const e = String(enc ?? "utf8").toLowerCase();
  if (e === "utf-8") return "utf8";
  if (e === "binary") return "latin1";
  if (!["utf8", "hex", "base64", "latin1", "ascii"].includes(e)) throw new TypeError(`Unknown encoding: ${enc} (skein node shim)`);
  return e;
}

export class Buffer extends Uint8Array {
  static from(x, encOrOffset, length) {
    if (typeof x === "string") {
      const enc = normEnc(encOrOffset);
      if (enc === "utf8") return new Buffer(utf8Encode(x));
      if (enc === "hex") { const a = []; for (let i = 0; i + 1 < x.length; i += 2) { const v = parseInt(x.slice(i, i + 2), 16); if (isNaN(v)) break; a.push(v); } return new Buffer(a); }
      if (enc === "base64") {
        const s = x.replace(/[^A-Za-z0-9+/\-_]/g, "").replace(/-/g, "+").replace(/_/g, "/"), a = [];
        for (let i = 0, bits = 0, acc = 0; i < s.length; i++) { acc = (acc << 6) | B64.indexOf(s[i]); bits += 6; if (bits >= 8) { bits -= 8; a.push((acc >> bits) & 0xff); } }
        return new Buffer(a);
      }
      return new Buffer(Array.from(x, (c) => c.charCodeAt(0) & (enc === "ascii" ? 0x7f : 0xff)));
    }
    if (x instanceof ArrayBuffer) return new Buffer(x, encOrOffset ?? 0, length ?? x.byteLength - (encOrOffset ?? 0));
    if (ArrayBuffer.isView(x)) return new Buffer(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    return new Buffer(x);
  }
  static alloc(n, fill = 0) { return new Buffer(n).fill(typeof fill === "number" ? fill : 0); }
  static isBuffer(x) { return x instanceof Buffer; }
  static byteLength(s, enc) { return typeof s === "string" ? Buffer.from(s, enc).length : s.byteLength; }
  static concat(list, total) {
    const n = total ?? list.reduce((a, b) => a + b.length, 0), out = Buffer.alloc(n);
    let off = 0;
    for (const b of list) { out.set(b.subarray(0, Math.min(b.length, n - off)), off); off += b.length; if (off >= n) break; }
    return out;
  }
  toString(enc, start = 0, end = this.length) {
    const b = this.subarray(start, end), e = normEnc(enc);
    if (e === "utf8") return utf8Decode(b);
    if (e === "hex") return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    if (e === "base64") {
      let s = "";
      for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
      }
      return s;
    }
    return String.fromCharCode(...Array.from(b, (x) => x & (e === "ascii" ? 0x7f : 0xff)));
  }
  toJSON() { return { type: "Buffer", data: Array.from(this) }; }
  equals(o) { return this.length === o.length && this.every((x, i) => x === o[i]); }
  subarray(s, e) { const u = Uint8Array.prototype.subarray.call(this, s, e); return new Buffer(u.buffer, u.byteOffset, u.length); }
  slice(s, e) { return this.subarray(s, e); }
}

// ---------------------------------------------------------------- path (POSIX)

function getcwd() { const [d, e] = os.getcwd(); if (e) throw fsError(e, "uv_cwd"); return d; }

function normalizeParts(parts, abs) {
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); }
    else out.push(p);
  }
  return out;
}

export const path = {
  sep: "/", delimiter: ":",
  isAbsolute: (p) => p.startsWith("/"),
  normalize(p) {
    if (p === "") return ".";
    const abs = p.startsWith("/"), trail = p.endsWith("/");
    let s = normalizeParts(p.split("/"), abs).join("/");
    if (!s && !abs) s = ".";
    if (s && trail) s += "/";
    return (abs ? "/" : "") + s;
  },
  join: (...ps) => path.normalize(ps.filter((x) => x !== "").join("/") || "."),
  resolve(...ps) {
    let r = "";
    for (let i = ps.length - 1; i >= 0 && !r.startsWith("/"); i--) if (ps[i]) r = ps[i] + (r ? "/" + r : "");
    if (!r.startsWith("/")) r = getcwd() + (r ? "/" + r : "");
    return "/" + normalizeParts(r.split("/"), true).join("/");
  },
  dirname(p) {
    if (!p) return ".";
    const s = p.replace(/\/+$/, "");
    if (!s) return "/";
    const i = s.lastIndexOf("/");
    return i < 0 ? "." : i === 0 ? "/" : s.slice(0, i).replace(/\/+$/, "") || "/";
  },
  basename(p, ext) {
    let b = p.replace(/\/+$/, "");
    b = b.slice(b.lastIndexOf("/") + 1);
    return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
  },
  extname(p) {
    const b = path.basename(p), i = b.lastIndexOf(".");
    return i <= 0 ? "" : b.slice(i);
  },
  relative(from, to) {
    const f = path.resolve(from).split("/").filter(Boolean), t = path.resolve(to).split("/").filter(Boolean);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/");
  },
  parse(p) {
    const root = p.startsWith("/") ? "/" : "", base = path.basename(p), ext = path.extname(p);
    const dir = p.includes("/") ? path.dirname(p) : "";
    return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
  },
  format: (o) => (o.dir || o.root || "") ? `${o.dir || o.root}${o.dir && o.dir !== "/" ? "/" : ""}${o.base ?? (o.name ?? "") + (o.ext ?? "")}` : o.base ?? (o.name ?? "") + (o.ext ?? ""),
};
path.posix = path;

// ---------------------------------------------------------------- fs (sync, over qjs:std/os)

const encOf = (o) => (typeof o === "string" ? o : o?.encoding ?? null);
const STDIO = [std.in, std.out, std.err];

function open(p, mode, syscall = "open") {
  if (typeof p === "number") { if (STDIO[p]) return { f: STDIO[p], own: false }; throw fsError(8, syscall); }
  const err = {};
  const f = std.open(String(p), mode, err);
  if (!f) throw fsError(err.errno, syscall, String(p));
  return { f, own: true };
}

function toBytes(data, enc) {
  if (typeof data === "string") return Buffer.from(data, enc ?? "utf8");
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

function writeAll(p, data, opts, mode) {
  const { f, own } = open(p, mode);
  const b = toBytes(data, encOf(opts));
  if (b.length) f.write(b.buffer, b.byteOffset, b.length);
  f.flush();
  if (own) f.close();
}

class Stats {
  constructor(st) {
    Object.assign(this, { dev: st.dev, ino: st.ino, mode: st.mode, nlink: st.nlink, uid: st.uid, gid: st.gid, size: st.size,
      atimeMs: st.atime, mtimeMs: st.mtime, ctimeMs: st.ctime, atime: new Date(st.atime), mtime: new Date(st.mtime), ctime: new Date(st.ctime) });
  }
  isFile() { return (this.mode & os.S_IFMT) === os.S_IFREG; }
  isDirectory() { return (this.mode & os.S_IFMT) === os.S_IFDIR; }
  isSymbolicLink() { return (this.mode & os.S_IFMT) === os.S_IFLNK; }
}

function stat(p, fn, syscall) {
  const [st, err] = fn(String(p));
  if (err) throw fsError(err, syscall, String(p));
  return new Stats(st);
}

class Dirent {
  constructor(name, dir) { this.name = name; this.parentPath = this.path = dir; }
  #st() { return stat(`${this.parentPath}/${this.name}`, os.lstat, "lstat"); }
  isFile() { return this.#st().isFile(); }
  isDirectory() { return this.#st().isDirectory(); }
  isSymbolicLink() { return this.#st().isSymbolicLink(); }
}

export const fs = {
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
  readFileSync(p, opts) {
    const { f, own } = open(p, "rb");
    const ab = f.readAsArrayBuffer();
    if (own) f.close();
    const b = Buffer.from(ab);
    const enc = encOf(opts);
    return enc ? b.toString(enc) : b;
  },
  writeFileSync(p, data, opts) { writeAll(p, data, opts, typeof opts === "object" && opts?.flag === "a" ? "ab" : "wb"); },
  appendFileSync(p, data, opts) { writeAll(p, data, opts, "ab"); },
  existsSync(p) { try { return !os.stat(String(p))[1]; } catch { return false; } },
  accessSync(p) { stat(p, os.stat, "access"); },
  statSync(p, o) {
    try { return stat(p, os.stat, "stat"); } catch (e) { if (o?.throwIfNoEntry === false && e.code === "ENOENT") return undefined; throw e; }
  },
  lstatSync: (p) => stat(p, os.lstat, "lstat"),
  readdirSync(p, o) {
    const [names, err] = os.readdir(String(p));
    if (err) throw fsError(err, "scandir", String(p));
    const list = names.filter((n) => n !== "." && n !== "..").sort();
    return o?.withFileTypes ? list.map((n) => new Dirent(n, String(p))) : list;
  },
  mkdirSync(p, o) {
    p = String(p);
    if (!o?.recursive) { const e = os.mkdir(p); if (e) throw fsError(e, "mkdir", p); return undefined; }
    let cur = p.startsWith("/") ? "" : ".", first;
    for (const part of p.split("/").filter(Boolean)) {
      cur += "/" + part;
      const [st] = os.stat(cur);
      if (st) { if ((st.mode & os.S_IFMT) !== os.S_IFDIR) throw fsError(54, "mkdir", p); continue; }
      const e = os.mkdir(cur);
      if (e) throw fsError(e, "mkdir", p);
      first ??= path.resolve(cur);
    }
    return first;
  },
  unlinkSync(p) { const e = os.remove(String(p)); if (e) throw fsError(e, "unlink", String(p)); },
  rmdirSync(p) { const e = os.remove(String(p)); if (e) throw fsError(e, "rmdir", String(p)); },
  rmSync(p, o) {
    p = String(p);
    const [st, err] = os.lstat(p);
    if (err) { if (o?.force) return; throw fsError(err, "rm", p); }
    if ((st.mode & os.S_IFMT) === os.S_IFDIR) {
      if (!o?.recursive) throw fsError(31, "rm", p);
      for (const n of fs.readdirSync(p)) fs.rmSync(`${p}/${n}`, o);
    }
    const e = os.remove(p);
    if (e) throw fsError(e, "rm", p);
  },
  renameSync(a, b) { const e = os.rename(String(a), String(b)); if (e) throw fsError(e, "rename", String(a)); },
  copyFileSync(a, b) { fs.writeFileSync(b, fs.readFileSync(a)); },
  realpathSync(p) { const [r, e] = os.realpath(String(p)); if (e) throw fsError(e, "realpath", String(p)); return r; },
  readlinkSync(p) { const [r, e] = os.readlink(String(p)); if (e) throw fsError(e, "readlink", String(p)); return r; },
  symlinkSync(t, p) { const e = os.symlink(String(t), String(p)); if (e) throw fsError(e, "symlink", String(p)); },
};
fs.realpathSync.native = fs.realpathSync;

// fs/promises and fs.promises: the sync calls, resolved (the VM runs one thing at a time anyway).
export const fsPromises = {};
for (const [sync, name] of [["readFileSync", "readFile"], ["writeFileSync", "writeFile"], ["appendFileSync", "appendFile"], ["statSync", "stat"],
  ["lstatSync", "lstat"], ["readdirSync", "readdir"], ["mkdirSync", "mkdir"], ["unlinkSync", "unlink"], ["rmdirSync", "rmdir"], ["rmSync", "rm"],
  ["renameSync", "rename"], ["copyFileSync", "copyFile"], ["realpathSync", "realpath"], ["readlinkSync", "readlink"], ["symlinkSync", "symlink"], ["accessSync", "access"]]) {
  fsPromises[name] = async (...a) => fs[sync](...a);
}
fs.promises = fsPromises;

// ---------------------------------------------------------------- process

let exiting = false;
const script = globalThis.scriptArgs?.[0];
const scriptPath = script && script !== "-" && !script.startsWith("/dev/") ? (() => { try { return fs.realpathSync(script); } catch { return path.resolve(script); } })() : undefined;

export const process = {
  argv: ["node", ...(scriptPath ? [scriptPath] : []), ...(globalThis.scriptArgs ?? []).slice(1)],
  argv0: "node",
  execArgv: [],
  env: std.getenviron(),
  platform: "wasi",
  arch: "wasm32",
  pid: 1,
  exitCode: undefined,
  versions: { quickjs: globalThis.navigator?.userAgent?.split("/")[1] ?? "?" },
  release: { name: "skein-node-shim" },
  cwd: getcwd,
  chdir(d) { const e = os.chdir(String(d)); if (e) throw fsError(e, "chdir", String(d)); },
  exit(code) {
    if (code !== undefined) process.exitCode = code;
    exiting = true;
    std.out.flush(); std.err.flush();
    std.exit(Number(process.exitCode ?? 0) | 0);
  },
  nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
  stdout: { isTTY: false, write(s) { writeAll(1, s, undefined); return true; } },
  stderr: { isTTY: false, write(s) { writeAll(2, s, undefined); return true; } },
  stdin: { isTTY: false, fd: 0 },
  on() { return process; }, once() { return process; }, off() { return process; },
};

// ---------------------------------------------------------------- require (CommonJS)

const builtins = { fs, "fs/promises": fsPromises, path, process, buffer: { Buffer } };
const cache = new Map();

function missing(name) {
  const e = new Error(`Cannot find module '${name}': skein's node shim (QuickJS-ng) provides only fs, fs/promises, path and process, plus relative .js/.cjs/.json files`);
  e.code = "MODULE_NOT_FOUND";
  return e;
}

function resolveFile(p) {
  for (const c of [p, `${p}.js`, `${p}.cjs`, `${p}.json`, `${p}/index.js`, `${p}/index.cjs`, `${p}/index.json`]) {
    const [st] = os.stat(c);
    if (st && (st.mode & os.S_IFMT) === os.S_IFREG) return c;
  }
  return undefined;
}

function makeRequire(dir) {
  const req = (name) => {
    const bare = String(name).replace(/^node:/, "");
    if (bare in builtins) return builtins[bare];
    if (!/^(\.{1,2}\/|\/)/.test(name)) throw missing(name);
    const file = resolveFile(path.resolve(dir, name));
    if (!file) throw missing(name);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {}, filename: file, id: file, loaded: false };
    cache.set(file, module);
    const src = fs.readFileSync(file, "utf8");
    if (file.endsWith(".json")) module.exports = JSON.parse(src);
    else {
      const body = src.startsWith("#!") ? "//" + src : src;
      new Function("exports", "require", "module", "__filename", "__dirname", body)(module.exports, makeRequire(path.dirname(file)), module, file, path.dirname(file));
    }
    module.loaded = true;
    return module.exports;
  };
  req.resolve = (name) => { const f = resolveFile(path.resolve(dir, name)); if (!f) throw missing(name); return f; };
  req.cache = cache;
  return req;
}

// ---------------------------------------------------------------- globals

const mainDir = scriptPath ? path.dirname(scriptPath) : process.cwd();
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.require = makeRequire(mainDir);
globalThis.module = { exports: {}, filename: scriptPath, id: ".", loaded: false };
globalThis.exports = globalThis.module.exports;
globalThis.__filename = scriptPath;
globalThis.__dirname = mainDir;
globalThis.global = globalThis;
// QuickJS keeps its timers in qjs:os; Node has them global. Sleeps are the runtime's.
globalThis.setTimeout ??= (fn, ms, ...a) => os.setTimeout(() => fn(...a), ms ?? 0);
globalThis.clearTimeout ??= (t) => t !== undefined && os.clearTimeout(t);
globalThis.setInterval ??= (fn, ms, ...a) => os.setInterval(() => fn(...a), ms ?? 0);
globalThis.clearInterval ??= (t) => t !== undefined && os.clearInterval(t);
globalThis.setImmediate ??= (fn, ...a) => os.setTimeout(() => fn(...a), 0);

/** Read by qjs after the event loop drains (patches/quickjs.patch): the exit status. */
globalThis.__skeinExitCode = () => (exiting ? undefined : Number(process.exitCode ?? 0) | 0);
