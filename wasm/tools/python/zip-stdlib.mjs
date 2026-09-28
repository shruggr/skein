// Pack CPython's stdlib (lib/python3.X of the WASI build) into the zip python
// imports it from: every .py file (no __pycache__), sorted, ZIP_STORED — the
// WASI build has no zlib, so zipimport cannot inflate — with fixed
// timestamps and modes, so the same input gives the same bytes.
// Run by scripts/build-wasm.sh: node wasm/tools/python/zip-stdlib.mjs <libdir> <out.zip>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32 } from "node:zlib";

const [src, out] = process.argv.slice(2);
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "__pycache__") walk(p); }
    else if (e.isFile() && e.name.endsWith(".py")) files.push(relative(src, p).split("\\").join("/"));
  }
})(src);
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01 00:00:00
const parts = [], central = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(join(src, name)), nb = Buffer.from(name, "utf8"), crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nb.length, 26); local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE((3 << 8) | 20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(0, 10); cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14); cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nb.length, 28);
  cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); cen.writeUInt32LE(offset, 42);
  parts.push(local, nb, data);
  central.push(cen, nb);
  offset += 30 + nb.length + data.length;
}
const cd = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
writeFileSync(out, Buffer.concat([...parts, cd, end]));
console.log(`${out}: ${files.length} files, ${offset + cd.length + 22} bytes`);
