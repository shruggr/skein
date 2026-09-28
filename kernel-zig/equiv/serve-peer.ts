// The peer process for equiv/serve.ts: peer/peer.ts (the real Delivery, Tick
// and RemoteRuntime) with fixed keys and an in-process messagebox hub, and the
// owner's client and an inference peer on the same hub, driving a scenario
// through `skein-kernel serve`. SKEIN_SCENARIO picks it; the results go to
// $SKEIN_HOME/scenario.json; then it asks the kernel to stop (SIGTERM to its parent).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { open, seal, signedPart, verify, type Envelope } from "../../src/envelope.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { encode } from "../../src/runtime/cid.ts";
import { bundlesOf, messageBoxHub } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";
import { runPeer, say } from "../peer/peer.ts";

export const KEYS = { instance: "1111", owner: "2222", host: "3333", infer: "4444" };
const key = (h: string) => new PrivateKey(h, 16);

const env = process.env;
const hub = messageBoxHub();
const owner = ephemeralWallet(key(KEYS.owner));
const ownerId = key(KEYS.owner).toPublicKey().toString();
const inferKey = key(KEYS.infer);
const report: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendTo(identity: string, box: string, body: unknown): Promise<Envelope> {
  const bytes = body instanceof Uint8Array ? body : dagCbor.encode(body);
  const env = await seal(owner, { recipient: { identityKey: identity, handle: "zigtest", domain: "localhost" }, body: bytes, created: new Date().toISOString() });
  await hub.as(ownerId).send({ recipient: identity, box, body: env });
  return env;
}

async function inbox(box: string): Promise<Array<{ env: Envelope; body: Record<string, unknown> }>> {
  const out = [];
  for (const m of hub.pending(ownerId, box)) {
    const e = JSON.parse(m.body as string) as Envelope;
    if (!verify(e)) throw new Error("reply does not verify");
    out.push({ env: e, body: dagCbor.decode((await open(owner, e)).body) as Record<string, unknown> });
  }
  return out;
}

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const text = (b: unknown) => Buffer.from(b as Uint8Array).toString("utf8");

await runPeer({
  host: ephemeralWallet(key(KEYS.host)),
  wallet: ephemeralWallet(key(KEYS.instance)),
  box: () => hub.as(key(KEYS.instance).toPublicKey().toString()),
  pollMs: 50,
  async running(identity) {
    try {
      const scenario = env.SKEIN_SCENARIO ?? "run";
      if (scenario === "run" || scenario === "sleep") {
        const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-serve-"));
        await fs.mkdir(join(dir, "src"));
        await fs.writeFile(join(dir, "src/a.txt"), "alpha\n");
        await fs.writeFile(join(dir, "README"), "hello\n");
        const { root, bundles } = await bundlesOf(dir);
        for (const b of bundles) await sendTo(identity, "objects", b);
        await sendTo(identity, "run", { cmd: "cat README; ls; echo $RANDOM", tree: root });
        const [r1] = await until("the first result", async () => (await inbox("results"))[0] ? await inbox("results") : undefined);
        report.first = { exitCode: r1.body.exitCode, stdout: text(r1.body.stdout) };
        if (scenario === "sleep") {
          await sendTo(identity, "run", { cmd: "sleep 1; echo woke; date +%s", tree: root });
          await sleep(300);
          report.sleeping = true;
          say("scenario: sleeping; stopping the kernel mid-sleep");
        } else {
          const inferId = inferKey.toPublicKey().toString();
          const peer = new InferPeer({ log: (l) => say(`infer: ${l}`), wallet: ephemeralWallet(inferKey), box: hub.as(inferId), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } },
            fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "It holds README and src." } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
            now: () => Date.now() });
          await sendTo(identity, "chat", { text: "What is here?", tree: root });
          const [a] = await until("the chat answer", async () => { await peer.poll(); const x = await inbox("chat"); return x.length ? x : undefined; });
          report.chat = { text: a.body.text };
          await sendTo(identity, "run", { cmd: "sleep 1; echo woke", tree: root });
          const rs = await until("the sleeper's result", async () => { const x = await inbox("results"); return x.length >= 2 ? x : undefined; }, 20_000);
          report.second = { exitCode: rs[1].body.exitCode, stdout: text(rs[1].body.stdout) };
        }
        await fs.rm(dir, { recursive: true, force: true });
      } else if (scenario === "fuel") {
        // A shell that never ends (issue #5): with a low fuelPerStep it runs out; run-handler replies.
        const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-serve-"));
        await fs.writeFile(join(dir, "README"), "hello\n");
        const { root, bundles } = await bundlesOf(dir);
        for (const b of bundles) await sendTo(identity, "objects", b);
        await sendTo(identity, "run", { cmd: "echo start; while :; do :; done", tree: root });
        const [r] = await until("the spinning shell's result", async () => { const x = await inbox("results"); return x.length ? x : undefined; }, 60_000);
        report.spun = { ...r.body, stdout: r.body.stdout ? text(r.body.stdout) : undefined, stderr: r.body.stderr ? text(r.body.stderr) : undefined };
        await fs.rm(dir, { recursive: true, force: true });
      } else if (scenario === "resume") {
        // After a restart mid-sleep: the shell re-executes, parks again, the tick wakes it, the reply comes.
        const rs = await until("the resumed sleeper's result", async () => { const x = await inbox("results"); return x.length ? x : undefined; }, 20_000);
        report.resumed = { exitCode: rs[0].body.exitCode, stdout: text(rs[0].body.stdout) };
      }
      report.ok = true;
    } catch (e) {
      report.error = (e as Error).message;
    }
    writeFileSync(join(env.SKEIN_HOME!, "scenario.json"), JSON.stringify(report));
    if (env.SKEIN_SCENARIO_STOP !== "channel") process.kill(process.ppid, "SIGTERM");
    else writeFileSync(join(env.SKEIN_HOME!, "scenario.done"), "");
  },
});
