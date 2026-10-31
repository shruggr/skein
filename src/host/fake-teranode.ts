// A fake Teranode network for the tests (#156; fake-arcade.ts is the pattern):
// one js-libp2p node on 127.0.0.1 (TCP, noise, yamux, GossipSub with
// StrictSign) that publishes block announcements on the block topic as the
// Teranode message bus does (`{"name", "data": <base64 BlockMessage JSON>}`),
// and a data hub (the Teranode asset API's two reads the tracker uses:
// `GET /bestblockheader` (+ `/json`) and `GET /headers/<hash>?n=` — child to
// parent, binary) serving a regtest chain the test mines.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { headerProblem } from "./image-chain.ts";
import { blockTopic } from "./teranode.ts";

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const display = (h: Uint8Array) => Buffer.from(h).reverse().toString("hex");

export const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");

/** A regtest header on `prev` (its merkle root `root`, else one from `salt`). */
export function mineHeader(prev: Uint8Array, salt: number | string, root?: Uint8Array): Buffer {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(root ?? sha256d(Buffer.from(`block ${salt}`))).copy(h, 36);
  h.writeUInt32LE(1_790_300_000 + (typeof salt === "number" ? salt : 7) * 600, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) { h.writeUInt32LE(nonce, 76); if (!headerProblem(h)) return h; }
}

export class FakeTeranode {
  /** The chain the hub serves (height = index). */
  chain: Buffer[] = [REGTEST_GENESIS];
  node!: Libp2p;
  hub = "";
  /** Every hub request's path and query, in order. */
  readonly asked: string[] = [];
  readonly topic: string;
  private server?: Server;

  constructor(network = "regtest") { this.topic = blockTopic(network); }

  static async start(network = "regtest"): Promise<FakeTeranode> {
    const f = new FakeTeranode(network);
    f.node = await createLibp2p({
      addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
      transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
      services: { identify: identify(), pubsub: gossipsub({ globalSignaturePolicy: "StrictSign", allowPublishToZeroTopicPeers: true, emitSelf: false }) } as never,
    });
    f.pubsub().subscribe(f.topic);
    f.server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      f.asked.push(`${u.pathname}${u.search}`);
      const best = f.chain.at(-1)!;
      if (u.pathname === "/bestblockheader") return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(best);
      if (u.pathname === "/bestblockheader/json") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hash: display(sha256d(best)), height: f.chain.length - 1 }));
      const m = /^\/headers\/([0-9a-f]{64})$/.exec(u.pathname);
      if (m) {
        const at = f.chain.findIndex((h) => display(sha256d(h)) === m[1]);
        if (at < 0) return void res.writeHead(404).end();
        const n = Math.min(Number(u.searchParams.get("n") ?? 1), 10_000);
        const out: Buffer[] = [];
        for (let h = at; h >= 0 && out.length < n; h--) out.push(f.chain[h]!);
        return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.concat(out));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => f.server!.listen(0, "127.0.0.1", r));
    f.hub = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`;
    return f;
  }

  private pubsub() { return (this.node.services as { pubsub: ReturnType<ReturnType<typeof gossipsub>> }).pubsub; }

  /** The node's address (the tracker's bootstrap). */
  addr(): string { return this.node.getMultiaddrs().find((a) => a.toString().includes("127.0.0.1"))!.toString(); }

  /** Peers subscribed to the block topic. */
  subscribers(): number { return this.pubsub().getSubscribers(this.topic).length; }

  /** Mine to `height` on the served chain. */
  mineTo(height: number): void { while (this.chain.length <= height) this.chain.push(mineHeader(sha256d(this.chain.at(-1)!), this.chain.length)); }

  /** Announce the header at `height` as a Teranode node does (the bus envelope around a BlockMessage). */
  async announce(height: number, o: { hub?: string | null; raw?: unknown } = {}): Promise<void> {
    const h = this.chain[height]!;
    const msg = o.raw ?? { PeerID: this.node.peerId.toString(), ClientName: "fake", DataHubURL: o.hub === null ? "" : (o.hub ?? this.hub), Hash: display(sha256d(h)), Height: height, Header: h.toString("hex"), Coinbase: "" };
    const data = Buffer.from(typeof msg === "string" ? msg : JSON.stringify({ name: "fake", data: Buffer.from(JSON.stringify(msg)).toString("base64") }));
    await this.pubsub().publish(this.topic, data);
  }

  async stop(): Promise<void> {
    await this.node.stop();
    await new Promise((r) => this.server?.close(r));
  }
}
