// RFC 3284 VCDIFF, decode only: what an `ordfs/patch` output carries (gib's
// file edits; ~/Work/bsv/gib-cli docs/plans/ordfs-formats.html). The profile
// gib's writers emit is the plain one — header D6 C3 C4 00, no secondary
// compression, no custom code table — and this decoder takes exactly that
// (plus xdelta3's application header and Adler-32 window checksum, which it
// skips/verifies), any number of windows, VCD_SOURCE and VCD_TARGET.

export class VcdiffError extends Error {}

const NOOP = 0, ADD = 1, RUN = 2, COPY = 3;
const S_NEAR = 4, S_SAME = 3;

type Inst = { type: number; size: number; mode: number };

/** The default code table (RFC 3284 §5.6): 256 entries of one or two instructions. */
const TABLE: Array<[Inst, Inst]> = (() => {
  const t: Array<[Inst, Inst]> = [];
  const i = (type: number, size = 0, mode = 0): Inst => ({ type, size, mode });
  const none = i(NOOP);
  t.push([i(RUN, 0), none]);
  for (let s = 0; s <= 17; s++) t.push([i(ADD, s), none]);
  for (let m = 0; m <= 8; m++) {
    t.push([i(COPY, 0, m), none]);
    for (let s = 4; s <= 18; s++) t.push([i(COPY, s, m), none]);
  }
  for (let m = 0; m <= 5; m++) for (let a = 1; a <= 4; a++) for (let c = 4; c <= 6; c++) t.push([i(ADD, a), i(COPY, c, m)]);
  for (let m = 6; m <= 8; m++) for (let a = 1; a <= 4; a++) t.push([i(ADD, a), i(COPY, 4, m)]);
  for (let m = 0; m <= 8; m++) t.push([i(COPY, 4, m), i(ADD, 1)]);
  if (t.length !== 256) throw new Error("vcdiff code table");
  return t;
})();

class Reader {
  readonly b: Uint8Array;
  at: number;
  readonly end: number;
  constructor(b: Uint8Array, at = 0, end = b.length) { this.b = b; this.at = at; this.end = end; }
  byte(): number {
    if (this.at >= this.end) throw new VcdiffError("vcdiff: truncated");
    return this.b[this.at++]!;
  }
  int(): number {
    let v = 0;
    for (let n = 0; n < 9; n++) {
      const x = this.byte();
      v = v * 128 + (x & 0x7f);
      if (v > Number.MAX_SAFE_INTEGER) throw new VcdiffError("vcdiff: integer overflow");
      if (!(x & 0x80)) return v;
    }
    throw new VcdiffError("vcdiff: integer too long");
  }
  take(n: number): Uint8Array {
    if (this.at + n > this.end) throw new VcdiffError("vcdiff: truncated");
    const s = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return s;
  }
}

function adler32(b: Uint8Array): number {
  let a = 1, s = 0;
  for (const x of b) { a = (a + x) % 65521; s = (s + a) % 65521; }
  return ((s << 16) | a) >>> 0;
}

/** apply(delta, source): the target bytes. */
export function vcdiffDecode(delta: Uint8Array, source: Uint8Array = new Uint8Array(0)): Uint8Array {
  const r = new Reader(delta);
  if (r.byte() !== 0xd6 || r.byte() !== 0xc3 || r.byte() !== 0xc4) throw new VcdiffError("vcdiff: bad magic");
  if (r.byte() !== 0) throw new VcdiffError("vcdiff: unsupported version");
  const hdr = r.byte();
  if (hdr & 0x01) throw new VcdiffError("vcdiff: secondary compression is not supported");
  if (hdr & 0x02) throw new VcdiffError("vcdiff: custom code tables are not supported");
  if (hdr & ~0x07) throw new VcdiffError("vcdiff: unknown header bits");
  if (hdr & 0x04) r.take(r.int()); // xdelta3's application header
  const out: Uint8Array[] = [];
  let target: Uint8Array = new Uint8Array(0);
  while (r.at < r.end) {
    const win = r.byte();
    if (win & ~0x07) throw new VcdiffError("vcdiff: unknown window bits");
    if ((win & 0x03) === 0x03) throw new VcdiffError("vcdiff: VCD_SOURCE and VCD_TARGET together");
    let seg: Uint8Array = new Uint8Array(0);
    if (win & 0x03) {
      const len = r.int(), pos = r.int();
      const from = win & 0x01 ? source : target;
      if (pos + len > from.length) throw new VcdiffError("vcdiff: source segment out of range");
      seg = from.subarray(pos, pos + len);
    }
    const encLen = r.int();
    const encEnd = r.at + encLen;
    if (encEnd > r.end) throw new VcdiffError("vcdiff: truncated window");
    const tlen = r.int();
    if (r.byte() !== 0) throw new VcdiffError("vcdiff: compressed sections are not supported");
    const dlen = r.int(), ilen = r.int(), alen = r.int();
    const sum = win & 0x04 ? (r.byte() << 24 | r.byte() << 16 | r.byte() << 8 | r.byte()) >>> 0 : undefined;
    const data = new Reader(delta, r.at, r.at + dlen); r.take(dlen);
    const inst = new Reader(delta, r.at, r.at + ilen); r.take(ilen);
    const addr = new Reader(delta, r.at, r.at + alen); r.take(alen);
    if (r.at !== encEnd) throw new VcdiffError("vcdiff: window length mismatch");
    const t = new Uint8Array(tlen);
    let tp = 0;
    const near = new Array<number>(S_NEAR).fill(0), same = new Array<number>(S_SAME * 256).fill(0);
    let nextNear = 0;
    const cache = (a: number) => { near[nextNear] = a; nextNear = (nextNear + 1) % S_NEAR; same[a % (S_SAME * 256)] = a; };
    const decodeAddr = (here: number, mode: number): number => {
      let a: number;
      if (mode === 0) a = addr.int();
      else if (mode === 1) a = here - addr.int();
      else if (mode - 2 < S_NEAR) a = near[mode - 2]! + addr.int();
      else a = same[(mode - 2 - S_NEAR) * 256 + addr.byte()]!;
      cache(a);
      return a;
    };
    const exec = (x: Inst) => {
      if (x.type === NOOP) return;
      const size = x.size || inst.int();
      if (tp + size > tlen) throw new VcdiffError("vcdiff: instruction overruns the target window");
      if (x.type === ADD) { t.set(data.take(size), tp); tp += size; return; }
      if (x.type === RUN) { t.fill(data.byte(), tp, tp + size); tp += size; return; }
      const a = decodeAddr(seg.length + tp, x.mode);
      if (a < 0 || a >= seg.length + tp) throw new VcdiffError("vcdiff: copy address out of range");
      for (let k = 0; k < size; k++) {
        const s = a + k;
        t[tp++] = s < seg.length ? seg[s]! : t[s - seg.length]!;
      }
    };
    while (inst.at < inst.end) {
      const [x, y] = TABLE[inst.byte()]!;
      exec(x);
      exec(y);
    }
    if (tp !== tlen || data.at !== data.end || addr.at !== addr.end) throw new VcdiffError("vcdiff: window does not add up");
    if (sum !== undefined && adler32(t) !== sum) throw new VcdiffError("vcdiff: window checksum mismatch");
    out.push(t);
    target = Buffer.concat(out);
  }
  return new Uint8Array(Buffer.concat(out));
}

/**
 * A minimal encoder (tests and `pack --patch`): one window over the whole
 * source, the longest common prefix and suffix as COPYs, the middle as an ADD.
 */
export function vcdiffEncode(target: Uint8Array, source: Uint8Array = new Uint8Array(0)): Uint8Array {
  const int = (v: number): number[] => { const o = [v & 0x7f]; v = Math.floor(v / 128); while (v > 0) { o.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); } return o; };
  let pre = 0;
  while (pre < source.length && pre < target.length && source[pre] === target[pre]) pre++;
  let suf = 0;
  while (suf < source.length - pre && suf < target.length - pre && source[source.length - 1 - suf] === target[target.length - 1 - suf]) suf++;
  const mid = target.subarray(pre, target.length - suf);
  const inst: number[] = [], addr: number[] = [];
  if (pre) { inst.push(19, ...int(pre)); addr.push(...int(0)); } // COPY size 0 (explicit), mode 0 (VCD_SELF)
  if (mid.length) inst.push(1, ...int(mid.length)); // ADD size 0 (explicit)
  if (suf) { inst.push(19, ...int(suf)); addr.push(...int(source.length - suf)); }
  const body = Buffer.concat([Buffer.from([...int(target.length), 0, ...int(mid.length), ...int(inst.length), ...int(addr.length)]), mid, Buffer.from(inst), Buffer.from(addr)]);
  const win = source.length ? [0x01, ...int(source.length), ...int(0)] : [0x00];
  return new Uint8Array(Buffer.concat([Buffer.from([0xd6, 0xc3, 0xc4, 0x00, 0x00, ...win, ...int(body.length)]), body]));
}
