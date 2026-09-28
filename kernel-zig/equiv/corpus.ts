// A generated corpus for the replay equivalence: instance stores in format 2
// (issue #33), written by the Zig kernel as the router drives it
// (src/host/router.ts: messages admitted through the BRC-33 messagebox API,
// wakes by the waker, emits delivered in process with their outcomes), on a
// script clock. It exercises the shell under run-handler (writes, cwd,
// failures, sleeps and their wakes), the script runtimes, objects/head/
// subscribe handlers, the loop with bash and message tools, replies,
// resolutions, delivery outcomes, inference errors, two agents talking, and a
// low fuelPerStep. Envelopes in both forms: the owner's client sends §7.2
// JSON; the instances and the inference peer send §7.3 dag-cbor.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/corpus.ts <out-dir>

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthFetch, PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { seal, signedPart, type Envelope } from "../../src/envelope.ts";
import { HostDb } from "../../src/host/instances.ts";
import { messageBoxClient, type MessageBox } from "../../src/host/messagebox.ts";
import { Router } from "../../src/host/router.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { encode } from "../../src/runtime/cid.ts";
import { DEFAULTS, stampMs } from "../../src/runtime/log.ts";
import { bundlesOf, iso, scriptClock } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

type Json = Record<string, unknown>;
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const out = process.argv[2]!;
await fs.mkdir(out, { recursive: true });
const verbose = !!process.env.VERBOSE;

// Fixed keys, so the corpus is the same every time it is made (up to wallet IVs).
let seed = 0x5eed00n;
const key = () => new PrivateKey((seed++).toString(16), 16);

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-corpus-"));
  for (const [p, s] of Object.entries(files)) {
    await fs.mkdir(join(dir, p, ".."), { recursive: true });
    await fs.writeFile(join(dir, p), s);
  }
  return dir;
}

function scripted(answers: Array<Json | { status: number; text: string }>) {
  return (async () => {
    const a = answers.shift();
    if (!a) return new Response("no more answers", { status: 500 });
    if ("status" in a && typeof a.status === "number") return new Response(String(a.text), { status: a.status });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
const toolCall = (id: string, cmd: string) => ({ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd }) } });
const messageCall = (id: string, to: string, text: string) => ({ id, type: "function", function: { name: "message", arguments: JSON.stringify({ to, text }) } });
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });

/** One host: a router over its own host.db, its instances' stores written to out/<name>.db, on a script clock. */
async function host(o: { defaults?: Record<string, string>; resolve?: (h: string, d: string) => Promise<Json>; infer?: PrivateKey } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-kz-corpus-home-"));
  const db = new HostDb(join(home, "host.db"));
  const clock = scriptClock();
  const keys = new Map<string, PrivateKey>();
  const ownerKey = key();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const router = new Router({
    db, walletFor: (row) => ephemeralWallet(keys.get(row.handle)!), authWallet: ephemeralWallet(key()),
    owner: ownerId, infer: o.infer?.toPublicKey().toString(), idleMs: 0, now: clock.now, resolve: o.resolve,
    fuelPerStep: o.defaults?.fuelPerStep, kernel: { command: kernel, env: { SKEIN_HOME: home } },
    log: (s, l) => { if (verbose) process.stdout.write(`  | [${s}] ${l}\n`); },
  });
  const server = await router.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const box = (w: ReturnType<typeof ephemeralWallet>) => messageBoxClient(w, `${base}/messagebox`, "skein-client");
  const register = async (w: ReturnType<typeof ephemeralWallet>, name: string) => {
    const r = await new AuthFetch(w).fetch(`${base}/account/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name }) });
    if (r.status !== 200) throw new Error(`register ${name}: ${r.status} ${await r.text()}`);
  };
  let registered = false;
  const add = async (name: string) => {
    keys.set(name, key());
    await fs.rm(join(out, `${name}.db`), { force: true });
    db.add(name, { store: join(out, `${name}.db`), identity: keys.get(name)!.toPublicKey().toString() });
    await router.hydrate(name);
    if (!registered) { registered = true; await register(owner, "david"); } // kept by the first instance
    return keys.get(name)!.toPublicKey().toString();
  };
  const ownerBox: MessageBox = box(owner);
  const h = {
    db, router, clock, owner, ownerKey, ownerId, box, register, add, base,
    /** Let every kernel finish what it was given. */
    settle: () => router.settled(),
    later(s: number) { const [sec, ns] = clock.now(); clock.set([sec + s, ns + 1000]); },
    /** Advance the clock and let the waker admit what is due. */
    async tick(s: number) { h.later(s); await router.wake(); await router.settled(); },
    /** The owner's client: seal `body` (JSON form) to `to` in `box`. */
    async send(to: string, boxName: string, body: unknown, as = owner): Promise<Envelope> {
      const env = await seal(as, { recipient: { identityKey: to, handle: "skein", domain: "localhost" }, body: body instanceof Uint8Array ? body : dagCbor.encode(body), created: iso(clock.now()) });
      await (as === owner ? ownerBox : box(as)).send({ recipient: to, box: boxName, body: env });
      await router.settled();
      return env;
    },
    async done() { await router.settled(); await router.stop(); db.close(); await fs.rm(home, { recursive: true, force: true }); },
  };
  return h;
}

function inferPeer(h: Awaited<ReturnType<typeof host>>, k: PrivateKey, answers: Array<Json | { status: number; text: string }>) {
  const w = ephemeralWallet(k);
  return new InferPeer({ log: () => {}, wallet: w, box: h.box(w), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: scripted(answers), now: () => stampMs(h.clock.now()) });
}

const made: string[] = [];

// ---------------------------------------------------------------- run: the shell under run-handler
{
  const h = await host();
  const i = await h.add("gen-run");
  const dir = await fixture({ "README": "hello\n", "src/a.txt": "alpha\n", "src/b.txt": "beta\n", "notes/x.md": "# x\n" });
  const { root, bundles } = await bundlesOf(dir, 700);
  for (const b of bundles) await h.send(i, "objects", b);
  const cmds = [
    "cat README; ls | head -3; date -u +%s; echo $RANDOM $RANDOM",
    "echo hi > new.txt && mkdir -p d && cp src/a.txt d/ && ls -R",
    "grep -rn a src | sort; wc -l src/*",
    "exit 3",
    "cat nope",
    "printf 'b\\na\\n' | sort | tr a-z A-Z; seq 3 | awk '{s+=$1} END {print s}'",
  ];
  for (const cmd of cmds) { h.later(1); await h.send(i, "run", { cmd, tree: root }); }
  h.later(1);
  await h.send(i, "run", { cmd: "pwd; ls", tree: root, cwd: "/src", env: { FOO: "bar" } });
  h.later(1);
  await h.send(i, "run", { cmd: "echo from main; ls" }); // no tree: main's
  // Sleeps: one wake, then two in a row.
  h.later(1);
  await h.send(i, "run", { cmd: "date +%s%N; echo $RANDOM; sleep 2; date +%s%N; echo $RANDOM; echo x > made.txt; ls", tree: root });
  await h.tick(1); // not due
  await h.tick(5);
  h.later(1);
  await h.send(i, "run", { cmd: "sleep 1; echo one; sleep 1; echo two", tree: root });
  await h.tick(3);
  await h.tick(3);
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-run");
}

// ---------------------------------------------------------------- scripts: qjs/node and python in a thread (issue #25)
{
  const h = await host();
  const i = await h.add("gen-scripts");
  const js = "#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync('out.txt', fs.readFileSync('src/a.txt', 'utf8').toUpperCase());\nconsole.log(process.argv.slice(2), Date.now(), Math.random());\nprocess.exitCode = 2;\n";
  const py = "#!/usr/bin/env python3\nimport sys, time, random, os, uuid, json\nprint(sys.argv[1:], time.time(), random.random(), os.urandom(4).hex(), hash('x'), uuid.uuid4())\njson.dump(sorted(os.listdir('src')), open('ls.json', 'w'))\n";
  const dir = await fixture({ "src/a.txt": "alpha\n", "src/b.txt": "beta\n", "t.js": js, "t.py": py });
  const { root, bundles } = await bundlesOf(dir, 700);
  for (const b of bundles) await h.send(i, "objects", b);
  const cmds = [
    "node t.js a b; echo \"exit=$?\"; ./t.js c; cat out.txt",
    "python3 t.py x; ./t.py y; cat ls.json; python -c 'import datetime; print(datetime.datetime.now())'",
    "qjs -e 'console.log(scriptArgs, Date.now())'; python3 -c 'open(\"/opt/skein/python/lib/python314.zip\", \"ab\")' 2>&1 | tail -1",
  ];
  for (const cmd of cmds) { h.later(1); await h.send(i, "run", { cmd, tree: root }); }
  h.later(1);
  await h.send(i, "run", { cmd: "python3 -c 'import time; print(time.time()); time.sleep(2); print(time.time())'; node -e 'setTimeout(() => console.log(\"later\", Date.now()), 1000)'", tree: root });
  await h.tick(3);
  await h.tick(3);
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-scripts");
}

// ---------------------------------------------------------------- heads and subscriptions
{
  const h = await host();
  const i = await h.add("gen-subs");
  const stranger = key();
  const sw = ephemeralWallet(stranger), sid = stranger.toPublicKey().toString();
  await h.register(sw, "stranger"); // its replies have somewhere to go
  const dir = await fixture({ "a.txt": "a\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await h.send(i, "objects", b);
  const handler = (await h.router.loaded.get("gen-subs")!.kernel.call("programs") as Record<string, unknown>)["run-handler"];
  await h.send(i, "chat", { text: "hello?" }, sw);
  // The subscribe body's sender: bytes (format 2), and once as hex (a JSON-era client; the handler takes both).
  await h.send(i, "subscribe", { op: "add", sender: Uint8Array.from(Buffer.from(sid, "hex")), box: "run", handler });
  await h.send(i, "subscribe", { op: "add", sender: sid, box: "run", handler }); // no change
  h.later(1);
  await h.send(i, "run", { cmd: "ls; echo stranger", tree: root }, sw);
  await h.send(i, "subscribe", { op: "remove", sender: Uint8Array.from(Buffer.from(sid, "hex")), box: "run", handler });
  await h.send(i, "run", { cmd: "echo again", tree: root }, sw);
  await h.send(i, "subscribe", { op: "bogus", box: "run", handler });
  await h.send(i, "head", { name: "work", tree: root });
  await h.send(i, "head", { name: "bad name", tree: root });
  await h.send(i, "run", { cmd: "echo x > y; ls" });
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-subs");
}

// ---------------------------------------------------------------- chat: the loop, bash, replies, inference errors
{
  const inferKey = key();
  const h = await host({ infer: inferKey });
  const peer = inferPeer(h, inferKey, [
    answer({ content: "", tool_calls: [toolCall("call-1", "ls | head -3; cat README")] }),
    answer({ content: "README and src.", reasoning_content: "short" }),
    answer({ content: "", tool_calls: [toolCall("call-2", "echo more > more.txt; ls"), toolCall("call-3", "sleep 1; date +%s")] }),
    answer({ content: "Done." }),
    { status: 500, text: "upstream down" },
  ]);
  const i = await h.add("gen-chat");
  await h.register(ephemeralWallet(inferKey), "infer");
  const poll = async () => { await peer.poll(); await h.settle(); };
  const dir = await fixture({ "README": "hello\n", "src/a.txt": "alpha\n", "SOUL.md": "Be brief.\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await h.send(i, "objects", b);
  const chat = await h.send(i, "chat", { text: "What is here?", tree: root });
  await poll(); await poll();
  // David replies to the answer: the same thread.
  const [ans] = await h.box(h.owner).list("chat");
  const ansCid = encode(signedPart((typeof ans!.body === "string" ? JSON.parse(ans!.body) : ans!.body) as Envelope)).cid;
  h.later(2);
  await h.send(i, "chat", { text: "Make more, then wait a second.", replyTo: ansCid });
  await poll();
  await h.tick(5);
  await poll();
  // A second conversation: the inference peer fails.
  h.later(1);
  await h.send(i, "chat", { text: "again?" });
  await poll();
  // A stray reply nobody awaits.
  await h.send(i, "chat", { text: "stray", replyTo: encode(signedPart(chat)).cid });
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-chat");
}

// ---------------------------------------------------------------- two agents talking (dag-cbor envelopes between them); resolutions; outcomes
{
  const inferKey = key();
  const h = await host({ infer: inferKey });
  const directory: Record<string, string> = {};
  h.router.o.resolve = async (hd, d) => directory[`${hd}@${d}`] ? { identityKey: directory[`${hd}@${d}`], via: "host" } : { identityKey: "", error: "unknown handle" };
  // One inference peer serves both; each agent's requests in turn (martha's first, as the conversation goes).
  const peer = inferPeer(h, inferKey, [
    answer({ content: "", tool_calls: [messageCall("m1", "@gen-kurt@localhost", "What does the blue one cost?")] }), // martha
    answer({ content: "", tool_calls: [messageCall("k1", "@gen-martha@localhost", "Which size?")] }), // kurt
    answer({ content: "", tool_calls: [messageCall("m2", "@gen-kurt@localhost", "The large one."), toolCall("c1", "echo noted")] }), // martha
    answer({ content: "The large blue one is 5." }), // kurt
    answer({ content: "", tool_calls: [messageCall("m3", "@nobody@localhost", "hi"), messageCall("m4", "nobody", "hi")] }), // martha
    answer({ content: "Blue is 5." }), // martha
  ]);
  const martha = await h.add("gen-martha");
  const kurt = await h.add("gen-kurt");
  await h.register(ephemeralWallet(inferKey), "infer");
  directory["gen-martha@localhost"] = martha;
  directory["gen-kurt@localhost"] = kurt;
  await h.send(martha, "chat", { text: "ask kurt about the blue one" });
  for (let n = 0; n < 12; n++) { if (await peer.poll() === 0) break; await h.settle(); }
  await h.done();
  made.push("gen-martha", "gen-kurt");
}
{
  const inferKey = key();
  const bob = key().toPublicKey().toString(); // no mailbox on this host: the delivery fails
  const h = await host({ infer: inferKey, resolve: async () => ({ identityKey: bob }) });
  const peer = inferPeer(h, inferKey, [
    answer({ content: "", tool_calls: [messageCall("m1", "@bob@localhost", "hi bob")] }),
    answer({ content: "Bob cannot be reached." }),
  ]);
  const i = await h.add("gen-outcome");
  await h.register(ephemeralWallet(inferKey), "infer");
  await h.send(i, "chat", { text: "ask bob" });
  for (let n = 0; n < 4; n++) { await peer.poll(); await h.settle(); }
  await h.done();
  made.push("gen-outcome");
}
{
  // The inference peer has no mailbox here: the loop's infer fails; an inference error to the opener.
  const h = await host({ infer: key() });
  const i = await h.add("gen-refused");
  await h.send(i, "chat", { text: "hello" });
  await h.done();
  made.push("gen-refused");
}

// ---------------------------------------------------------------- fuel: a low fuelPerStep (issue #5)
// The objects handler (~3M) fits in 10^8 and run-handler (~3·10^8, the Go
// runtime starting) runs out in its first step: errored, "fuel exhausted".
{
  const h = await host({ defaults: { ...DEFAULTS, fuelPerStep: "100000000" } });
  const i = await h.add("gen-fuel");
  const dir = await fixture({ "a.txt": "a\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await h.send(i, "objects", b);
  h.later(1);
  await h.send(i, "run", { cmd: "ls", tree: root });
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-fuel");
}

process.stdout.write(made.map((n) => join(out, `${n}.db`)).join("\n") + "\n");
