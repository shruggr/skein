// The default image's chain part (#132): the whole header chain, from the
// network's genesis header to the last header the host received, as blocks
// in the image tree — so a skein made at any moment is born with the chain up
// to the current tip, and its chain app starts from it (skein-sdk
// `chain.image`). Headers are pushed, never pulled by a skein: the host grows
// the image, and from its creation on a skein gets each new tip as an event,
// as before.
//
// The layout (skein-sdk chain/src/image.zig, the same bytes):
//
//   chain/headers/<first>   the raw 80-byte headers, concatenated in height order, 2016 per block,
//                           <first> the first one's height in 8 digits (00000000, 00002016, …);
//                           every block but the last is full; the last holds the rest
//   chain/tip               {"height":<n>,"hash":"<display hex>"} and a newline
//
// The image tree is the static part — the repo's images/default, scanned —
// with `chain` added at its root. **A new tree per header**: each header the
// host takes rewrites the last block (at most 2016 × 80 bytes), the tip, the
// two trees above them and the root; every full block stays as it is. The
// chain part's objects live in host.db (`image_blocks`: only the current ones;
// a replaced object is deleted with the write that replaces it), the current
// root and `chain` tree in `host_settings` (`image`, `image_chain`).
//
// Where the headers come from: the host's headers feed (SKEIN_HEADERS_URL,
// feeds.ts), each one appended as it arrives; and its history, from the same
// chaintracks service (`/headers?height=&count=`, 80 bytes a header, next to
// `/tip/stream`): at start the host fills the chain from genesis once, then
// catches up from a little below its tip (a restart, a gap, a reorg deeper
// than the last block). A header that links to none the host holds near its
// tip is taken through the history; with no history service it is dropped,
// logged. The host checks what it writes as the chain app will: each header
// links to the one before, its target is usable and its hash meets it. It does
// not judge the network: the chain app refuses an image whose first header is
// not its network's genesis.

import { createHash } from "node:crypto";
import type { CID } from "multiformats/cid";
import { CID as Cid } from "multiformats/cid";
import * as dagCbor from "@ipld/dag-cbor";
import { headTree } from "../runtime/heads.ts";
import type { Store } from "../runtime/store.ts";
import { hashBlob, hashTree, parseTree, readBlob, readTree, type Entry } from "../runtime/tree.ts";
import { anyOf, DEFAULT_IMAGE, dirSource, HOST_IMAGE, MemBlocks, mergeImages, OPEN_EXCHANGE_IMAGE, WASM_DIR, wasmDirObjects, type BootSource, type Objects } from "./boot.ts";
import type { HostDb } from "./instances.ts";

/** Headers per block (skein-sdk `image.per_block`). */
export const PER_BLOCK = 2016;
const SIZE = 80;

export const blockName = (first: number) => String(first).padStart(8, "0");

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");

/** The target a compact `bits` encodes, or undefined when it is not usable (skein-sdk header.zig `target`). */
function target(bits: number): bigint | undefined {
  const mantissa = BigInt(bits & 0x007fffff);
  const negative = (bits & 0x00800000) !== 0;
  const exponent = bits >>> 24;
  let t: bigint;
  if (exponent <= 3) t = mantissa >> BigInt(8 * (3 - exponent));
  else {
    const shift = 8 * (exponent - 3);
    if (shift >= 256) return undefined;
    t = mantissa << BigInt(shift);
    if (t >> 256n !== 0n) return undefined;
  }
  return t === 0n || negative ? undefined : t;
}

/** Why a header (80 bytes) is not one the chain app takes on its own: an unusable target, or a hash that misses it. */
export function headerProblem(raw: Uint8Array): string | undefined {
  if (raw.length !== SIZE) return "not 80 bytes";
  const t = target(Buffer.from(raw).readUInt32LE(72));
  if (t === undefined) return "an unusable target";
  return BigInt(`0x${display(sha256d(raw))}`) <= t ? undefined : "its hash misses its target";
}

const prevOf = (raw: Uint8Array) => Buffer.from(raw.subarray(4, 36));

export interface ImageChainOptions {
  db: HostDb;
  /** The chaintracks headers endpoint (`…/chaintracks/v2/headers`): history by height. */
  history?: string;
  /** Headers per history request (default 100 800: 50 blocks). */
  page?: number;
  /** The static part (default: the repo's images/default). */
  dir?: string;
  /** The host image's own part (#142, default: the repo's images/host), merged over the static part. */
  hostDir?: string;
  /** The Open Exchange image's own part (#147, default: the repo's images/open-exchange), merged over the static part. */
  openExchangeDir?: string;
  fetch?: typeof fetch;
  log?(line: string): void;
}

/** The history endpoint beside a chaintracks tip stream (`…/tip/stream` → `…/headers`), if the URL is one. */
export function historyOf(feed: string | undefined): string | undefined {
  if (!feed) return undefined;
  const u = new URL(feed);
  if (!/\/tip\/stream\/?$/.test(u.pathname)) return undefined;
  u.pathname = u.pathname.replace(/\/tip\/stream\/?$/, "/headers");
  u.search = "";
  return u.toString();
}

/** The images merged over the default one (#142, #147). */
export type MergedImage = "host" | "open-exchange";
/** The image names a creation takes (#147): `default`, `open-exchange` (the host image is the host skein's alone). */
export const IMAGE_NAMES = ["default", "open-exchange"] as const;
function mergedImage(name: string): MergedImage {
  if (name !== "open-exchange") throw new Error(`image ${JSON.stringify(name)}: this host has ${IMAGE_NAMES.join(", ")}`);
  return name;
}

export class ImageChain {
  readonly o: ImageChainOptions;
  /** chain/headers' blocks, in height order. */
  private blocks: CID[] = [];
  /** The last block's headers (raw). */
  private last: Buffer = Buffer.alloc(0);
  private queue: Promise<unknown> = Promise.resolve();
  private stat?: Promise<{ root: CID; entries: Entry[]; objects: Objects }>;
  /** #142, #147: the named images' static parts — each one's own part merged over the default image, once. */
  private merged = new Map<string, Promise<{ root: CID; entries: Entry[]; objects: Objects }>>();
  /** Settles once the first sync (start) is done: what a creation waits for. */
  ready: Promise<void> = Promise.resolve();

  constructor(o: ImageChainOptions) {
    this.o = o;
    const chain = o.db.setting("image_chain");
    if (chain) {
      const ch = parseTree(this.object(Cid.parse(chain)));
      const hd = ch.find((e) => e.name === "headers");
      if (hd) {
        this.blocks = parseTree(this.object(hd.cid)).map((e) => e.cid);
        if (this.blocks.length) this.last = this.blob(this.blocks.at(-1)!);
      }
    }
  }

  private say(line: string): void { this.o.log?.(line); }

  private object(cid: CID): Buffer {
    const b = this.o.db.imageBlock(cid.toString());
    if (!b) throw new Error(`the image's ${cid} is not in host.db`);
    return Buffer.from(b);
  }

  /** A block's headers (the one read last kept: a search below the tip reads one block many times). */
  private blob(cid: CID): Buffer {
    if (this.read?.cid.equals(cid)) return this.read.bytes;
    const o = this.object(cid);
    this.read = { cid, bytes: o.subarray(o.indexOf(0) + 1) };
    return this.read.bytes;
  }
  private read?: { cid: CID; bytes: Buffer };

  /** The tip's height (-1: no chain part). */
  height(): number { return this.blocks.length ? (this.blocks.length - 1) * PER_BLOCK + this.last.length / SIZE - 1 : -1; }

  tip(): { height: number; hash: string } | undefined {
    const h = this.height();
    return h < 0 ? undefined : { height: h, hash: display(sha256d(this.last.subarray(this.last.length - SIZE))) };
  }

  /** The header at a height (raw), from its block. */
  private at(height: number): Buffer {
    const b = Math.floor(height / PER_BLOCK);
    const bytes = b === this.blocks.length - 1 ? this.last : this.blob(this.blocks[b]!);
    const o = (height - b * PER_BLOCK) * SIZE;
    return bytes.subarray(o, o + SIZE);
  }

  /** One at a time: every change to the chain part goes through here. */
  private serial<T>(f: () => Promise<T> | T): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Put `raws` at `height` (at most the tip + 1): the headers held from there
   * that differ are replaced (a reorg), the ones that match are kept, the
   * rest appended; a new tree. Whether anything changed. Refused: a gap, a
   * header that does not link to the one before it, one the chain app would
   * refuse on its own.
   */
  put(height: number, raws: Uint8Array[]): Promise<boolean> { return this.serial(() => this.write(height, raws)); }

  private async write(height: number, raws: Uint8Array[]): Promise<boolean> {
    const tipH = this.height();
    if (height > tipH + 1) throw new Error(`a gap: header ${height} after the tip ${tipH}`);
    let prev = height === 0 ? Buffer.alloc(32) : sha256d(this.at(height - 1));
    for (const [i, raw] of raws.entries()) {
      const why = headerProblem(raw);
      if (why) throw new Error(`header ${height + i}: ${why}`);
      if (!prevOf(raw).equals(prev)) throw new Error(`header ${height + i} does not link to header ${height + i - 1}`);
      prev = sha256d(raw);
    }
    // Skip what is held already.
    let i = 0;
    while (i < raws.length && height + i <= tipH && this.at(height + i).equals(raws[i]!)) i++;
    if (i === raws.length) return false;
    const h0 = height + i;
    const b0 = Math.floor(h0 / PER_BLOCK);
    const base = b0 < this.blocks.length ? (b0 === this.blocks.length - 1 ? this.last : this.blob(this.blocks[b0]!)) : Buffer.alloc(0);
    const rest = Buffer.concat([base.subarray(0, (h0 - b0 * PER_BLOCK) * SIZE), ...raws.slice(i)]);
    const puts = new Map<string, Uint8Array>();
    const drops = new Set<string>(this.blocks.slice(b0).map(String));
    const blocks = this.blocks.slice(0, b0);
    for (let o = 0; o < rest.length; o += PER_BLOCK * SIZE) {
      const { cid, object } = hashBlob(rest.subarray(o, o + PER_BLOCK * SIZE));
      blocks.push(cid);
      puts.set(cid.toString(), object);
    }
    const last = rest.subarray(Math.floor((rest.length - 1) / (PER_BLOCK * SIZE)) * PER_BLOCK * SIZE);
    const tipHeight = blocks.length ? (blocks.length - 1) * PER_BLOCK + last.length / SIZE - 1 : -1;
    const tipText = `{"height":${tipHeight},"hash":"${display(sha256d(last.subarray(last.length - SIZE)))}"}\n`;
    const headers = hashTree(blocks.map((cid, k) => ({ mode: "100644", name: blockName(k * PER_BLOCK), cid })));
    const tip = hashBlob(Buffer.from(tipText));
    const chain = hashTree([{ mode: "40000", name: "headers", cid: headers.cid }, { mode: "100644", name: "tip", cid: tip.cid }]);
    const root = await this.rootWith(chain.cid, await this.static());
    for (const x of [headers, tip, chain, root]) puts.set(x.cid.toString(), x.object);
    // The objects this tree no longer names.
    const old = this.o.db.setting("image_chain");
    if (old) {
      const ch = parseTree(this.object(Cid.parse(old)));
      drops.add(old);
      for (const e of ch) drops.add(e.cid.toString());
    }
    const oldRoot = this.o.db.setting("image");
    if (oldRoot) drops.add(oldRoot);
    for (const k of puts.keys()) drops.delete(k);
    this.o.db.writeImage(puts, drops, { image: root.cid.toString(), image_chain: chain.cid.toString() });
    this.blocks = blocks;
    this.last = Buffer.from(last);
    return true;
  }

  /** The static part: the image directory, scanned once. */
  private static(): Promise<{ root: CID; entries: Entry[]; objects: Objects }> {
    this.stat ??= (async () => {
      const d = await dirSource(this.o.dir ?? DEFAULT_IMAGE);
      return { root: d.root, entries: parseTree(await d.objects.bytes(d.root)), objects: d.objects };
    })();
    return this.stat;
  }

  /**
   * #142, #147: a named image's static part — its own part merged over images/default (boot.ts
   * mergeImages), once: `host` (images/host), `open-exchange` (images/open-exchange).
   */
  private mergedStatic(name: MergedImage): Promise<{ root: CID; entries: Entry[]; objects: Objects }> {
    let p = this.merged.get(name);
    if (!p) this.merged.set(name, p = (async () => {
      const base = await this.static();
      const own = await dirSource(name === "host" ? this.o.hostDir ?? HOST_IMAGE : this.o.openExchangeDir ?? OPEN_EXCHANGE_IMAGE);
      const merged = new MemBlocks();
      const objects = anyOf(merged, base.objects, own.objects);
      const root = await mergeImages(objects, base.root, own.root, merged);
      return { root, entries: parseTree((await objects.get(root))!), objects };
    })());
    return p;
  }

  /** The image's root: the static part's entries, `chain` among them. */
  private async rootWith(chain: CID, s: { entries: Entry[] }): Promise<{ cid: CID; object: Uint8Array }> {
    return hashTree([...s.entries.filter((e) => e.name !== "chain"), { mode: "40000", name: "chain", cid: chain }]);
  }

  /**
   * The current image as a boot source (#89, #132): the static part with the
   * chain part at `chain/`; with no chain part, the static part alone (the
   * repo's images/default, as before). Its objects: host.db's, the scan's,
   * the repo's pinned modules.
   */
  async source(o: { host?: boolean; image?: string } = {}): Promise<BootSource> {
    const named: MergedImage | undefined = o.host ? "host" : o.image === undefined || o.image === "default" ? undefined : mergedImage(o.image);
    const s = named ? await this.mergedStatic(named) : await this.static();
    const chainObjects = { get: async (cid: CID) => this.o.db.imageBlock(cid.toString()) };
    const chain = this.o.db.setting("image_chain");
    if (named) {
      // The host image (#142), the Open Exchange image (#147): its root is not kept in host.db; the chain part's objects are the same.
      const root = chain ? await this.rootWith(Cid.parse(chain), s) : undefined;
      const mem = new MemBlocks();
      if (root) await mem.putBlock(root.cid, root.object);
      return { kind: "tree", root: root?.cid ?? s.root, objects: anyOf(mem, s.objects, wasmDirObjects(WASM_DIR), chainObjects) };
    }
    const objects = anyOf(s.objects, wasmDirObjects(WASM_DIR), chainObjects);
    if (!chain) return { kind: "tree", root: s.root, objects };
    const root = await this.rootWith(Cid.parse(chain), s);
    // The static part changed since the last write (a new checkout): this root is the current one.
    if (this.o.db.setting("image") !== root.cid.toString()) this.o.db.writeImage(new Map([[root.cid.toString(), root.object]]), new Set([this.o.db.setting("image") ?? ""]), { image: root.cid.toString() });
    return { kind: "tree", root: root.cid, objects };
  }

  /**
   * Headers from the stream (feeds.ts, in order): each appended at the tip
   * when it links there; one that links to a header a little below the tip
   * replaces from there (a reorg); otherwise the history fills in (a gap,
   * a deeper reorg), or, with none, it is dropped.
   */
  headers(raws: Uint8Array[]): Promise<void> {
    return this.serial(async () => {
      for (const raw of raws) {
        try {
          const prev = prevOf(raw);
          const tipH = this.height();
          let at: number | undefined;
          if (tipH < 0) at = prev.equals(Buffer.alloc(32)) ? 0 : undefined;
          else for (let h = tipH; h >= Math.max(0, tipH - 2 * PER_BLOCK); h--) if (sha256d(this.at(h)).equals(prev)) { at = h + 1; break; }
          if (at !== undefined) { await this.write(at, [raw]); continue; }
          if (!this.o.history) { this.say(`header ${display(sha256d(raw))}: links to no header near the tip ${tipH}, and no history to fill in from: dropped`); continue; }
          await this.syncNow();
        } catch (e) { this.say(`header ${display(sha256d(raw))} not taken: ${(e as Error).message}`); }
      }
    });
  }

  /** Fill in from the history (#132): from genesis once, then from a little below the tip. */
  sync(): Promise<void> { return this.serial(() => this.syncNow()); }

  private async syncNow(): Promise<void> {
    const url = this.o.history;
    if (!url) return;
    const page = this.o.page ?? 50 * PER_BLOCK;
    const t0 = Date.now();
    const start = this.height();
    let from = Math.max(0, start - 6);
    for (let back = 0; ;) {
      const res = await (this.o.fetch ?? fetch)(`${url}?height=${from}&count=${page}`);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length % SIZE) throw new Error(`${url}: ${bytes.length} bytes, not whole headers`);
      const raws: Uint8Array[] = [];
      for (let o = 0; o < bytes.length; o += SIZE) raws.push(bytes.subarray(o, o + SIZE));
      if (!raws.length) break;
      if (from > 0 && from <= this.height() + 1 && !prevOf(raws[0]!).equals(sha256d(this.at(from - 1)))) {
        // A reorg below where we asked from: further back.
        if (++back > 8) throw new Error(`${url}: header ${from} links to none held, ${back} pages back`);
        from = Math.max(0, from - PER_BLOCK * back);
        continue;
      }
      await this.write(from, raws);
      from += raws.length;
    }
    const tip = this.tip();
    if (tip && tip.height !== start) this.say(`the image's chain: ${start < 0 ? "built from genesis" : `from ${start}`} to ${tip.height} (${tip.hash}) in ${Date.now() - t0} ms`);
  }

  /**
   * #141: the headers a skein whose tip is `tip` lacks, from the image's chain, in order — what the
   * host pushes it on (re)subscribing, before the live stream. From the header after its tip when
   * the image holds that tip; a tip the image does not hold at its height (a fork) from a little
   * below it; none when the skein is at or past the image's tip, or has no tip (no chain part).
   * Run in turn with the chain part's writes: every header the feed brought before this call is in.
   */
  after(tip: { height: number; hash: string } | undefined): Promise<Uint8Array[]> {
    return this.serial(() => {
      const top = this.height();
      if (!tip || tip.height >= top) return [];
      const from = display(sha256d(this.at(tip.height))) === tip.hash ? tip.height + 1 : Math.max(0, tip.height - 6);
      const out: Uint8Array[] = [];
      for (let h = from; h <= top; h++) out.push(new Uint8Array(this.at(h)));
      return out;
    });
  }

  /** Start: the first sync, which creations wait for (`ready`). */
  start(): Promise<void> {
    this.ready = this.sync().catch((e) => this.say(`the image's chain not synced: ${(e as Error).message}`));
    return this.ready;
  }
}

/**
 * #141: a skein's chain tip as its store holds it: the chain app's state (the head `chain/state`,
 * {kind: "chain-state", maps: {headers}} — the MST height (u32 big-endian) → header, skein-sdk
 * chain.zig; its last key is the tip), else the chain part of the tree it was born from (`main`'s
 * `chain/tip`, image.zig's format), else none.
 */
export async function skeinTip(store: Store): Promise<{ height: number; hash: string } | undefined> {
  const state = await headTree(store, "chain/state");
  if (state) {
    const v = await store.get(state).catch(() => undefined) as { kind?: string; maps?: { headers?: CID | null } } | undefined;
    let node = v?.kind === "chain-state" ? v.maps?.headers ?? undefined : undefined;
    let last: [Uint8Array, unknown, CID | null] | undefined;
    while (node) {
      const [, es] = dagCbor.decode(await store.bytes(node)) as [CID | null, Array<[Uint8Array, unknown, CID | null]>];
      if (!es.length) break;
      last = es[es.length - 1]!;
      node = last[2] ?? undefined;
    }
    if (last) {
      const raw = await store.bytes(last[1] as CID);
      return { height: Buffer.from(last[0]).readUInt32BE(0), hash: display(sha256d(raw)) };
    }
  }
  const main = await headTree(store, "main");
  if (!main) return undefined;
  const chain = (await readTree(store, main).catch(() => [] as Entry[])).find((e) => e.name === "chain" && e.mode === "40000");
  const tip = chain && (await readTree(store, chain.cid)).find((e) => e.name === "tip");
  if (!tip) return undefined;
  const t = JSON.parse(Buffer.from(await readBlob(store, tip.cid)).toString("utf8")) as { height?: unknown; hash?: unknown };
  return typeof t.height === "number" && typeof t.hash === "string" ? { height: t.height, hash: t.hash } : undefined;
}
