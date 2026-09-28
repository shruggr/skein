// A generated corpus for the replay equivalence: instance stores (SQLite
// files) written by the TypeScript runtime through the test kit, exercising
// what the live stores have not yet: the shell under run-handler (writes,
// cwd, failures, sleeps and their wakes), objects/head/subscribe handlers,
// the loop with bash and message tools, replies, resolutions, delivery
// outcomes, inference errors, two agents talking. Scenarios follow
// src/runtime/{handlers,chat,subscriptions,heads}.test.ts.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/corpus.ts <out-dir>

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import { seal } from "../../src/envelope.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { ensureGenesis } from "../../src/host/entry.ts";
import { stampMs, type InstanceConfig } from "../../src/runtime/log.ts";
import { PROGRAM_CIDS } from "../../src/runtime/programs.ts";
import { openStore } from "../../src/runtime/sqlite.ts";
import { bundlesOf, faultyHub, installWasm, instance, iso, messageBoxHub, noAccount, scriptClock, send, T0, type Hub, type Instance } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

type Json = Record<string, unknown>;
const out = process.argv[2];
await fs.mkdir(out, { recursive: true });

// Fixed keys, so the corpus is the same every time it is made (up to wallet IVs).
let seed = 0x5eed00n;
const key = () => new PrivateKey((seed++).toString(16), 16);

async function sqliteInstance(name: string, o: { hub?: Hub; clock?: ReturnType<typeof scriptClock>; config?: Partial<InstanceConfig> } = {}): Promise<Instance> {
  const path = join(out, `${name}.db`);
  await fs.rm(path, { force: true });
  const store = openStore(path);
  const instanceKey = key(), ownerKey = key(), hostKey = key();
  await installWasm(store);
  await ensureGenesis(store, ephemeralWallet(instanceKey), ephemeralWallet(hostKey), { owner: ownerKey.toPublicKey().toString(), ...o.config }, T0);
  return instance({ store, instanceKey, ownerKey, hostKey, hub: o.hub, clock: o.clock });
}

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-corpus-"));
  for (const [p, s] of Object.entries(files)) {
    await fs.mkdir(join(dir, p, ".."), { recursive: true });
    await fs.writeFile(join(dir, p), s);
  }
  return dir;
}

const settle = async (i: Instance) => { await i.delivery.poll(); await i.rt.idle(); };
const later = (i: Instance, s: number) => { const [sec, ns] = i.clock.now(); i.clock.set([sec + s, ns + 1000]); };

function scripted(answers: Array<Json | { status: number; text: string }>) {
  const f = (async () => {
    const a = answers.shift();
    if (!a) return new Response("no more answers", { status: 500 });
    if ("status" in a && typeof a.status === "number") return new Response(String(a.text), { status: a.status });
    return new Response(JSON.stringify(a), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return f;
}
const toolCall = (id: string, cmd: string) => ({ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd }) } });
const messageCall = (id: string, to: string, text: string) => ({ id, type: "function", function: { name: "message", arguments: JSON.stringify({ to, text }) } });
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });

async function agent(name: string, hub: Hub, clock: ReturnType<typeof scriptClock>, answers: Array<Json | { status: number; text: string }>, open = false) {
  const inferKey = key();
  const inferId = inferKey.toPublicKey().toString();
  const i = await sqliteInstance(name, { hub, clock, config: { handle: name, peers: { infer: inferId }, ...(open ? { subscriptions: [{ match: { box: "chat" }, handler: PROGRAM_CIDS.loop }] } : {}) } });
  const peer = new InferPeer({ log: () => {}, wallet: ephemeralWallet(inferKey), box: hub.as(inferId), providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: scripted(answers), now: () => stampMs(i.clock.now()) });
  return { i, peer };
}

async function sendAs(i: Instance, who: PrivateKey, box: string, body: unknown): Promise<void> {
  const env = await seal(ephemeralWallet(who), { recipient: { identityKey: i.identity, handle: "skein", domain: "localhost" }, body: dagCbor.encode(body), created: iso(i.clock.now()) });
  await i.hub.as(who.toPublicKey().toString()).send({ recipient: i.identity, box, body: env });
}

const made: string[] = [];
const done = async (name: string, ...is: Instance[]) => { for (const i of is) { await i.rt.idle(); await i.rt.stop(); await i.store.close(); } made.push(name); };

// The in-step clock is the Zig kernel's own (issue #38: entry stamp + fuel
// × 1 ns), not the TS runtime's (stamp + 1 ns per read): a mid-step time
// printed into a reply would make the reply the replay seals differ from the
// source's, with no witness for its wallet calls. So the scripts below read
// the clock but print only what both clocks agree on (orderings, elapsed
// ≥ the sleep, the year). equiv/serve.ts prints real mid-step times, in
// stores the Zig kernel writes itself.

// ---------------------------------------------------------------- run: the shell under run-handler
{
  const i = await sqliteInstance("gen-run");
  const dir = await fixture({ "README": "hello\n", "src/a.txt": "alpha\n", "src/b.txt": "beta\n", "notes/x.md": "# x\n" });
  const { root, bundles } = await bundlesOf(dir, 700);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  const cmds = [
    "cat README; ls | head -3; date -u +%s; echo $RANDOM $RANDOM",
    "echo hi > new.txt && mkdir -p d && cp src/a.txt d/ && ls -R",
    "grep -rn a src | sort; wc -l src/*",
    "exit 3",
    "cat nope",
    "printf 'b\\na\\n' | sort | tr a-z A-Z; seq 3 | awk '{s+=$1} END {print s}'",
  ];
  for (const cmd of cmds) { later(i, 1); await send(i, "run", { cmd, tree: root }); await settle(i); }
  later(i, 1);
  await send(i, "run", { cmd: "pwd; ls", tree: root, cwd: "/src", env: { FOO: "bar" } });
  await settle(i);
  later(i, 1);
  await send(i, "run", { cmd: "echo from main; ls" }); // no tree: main's
  await settle(i);
  // Sleeps: one wake, then two in a row.
  later(i, 1);
  await send(i, "run", { cmd: "t0=$(date +%s%N); echo $RANDOM; sleep 2; t1=$(date +%s%N); echo $(( t1 - t0 >= 2000000000 )); echo $RANDOM; echo x > made.txt; ls", tree: root });
  await settle(i);
  later(i, 1); await i.tick.fire(); // not due
  later(i, 5); await i.tick.fire(); await settle(i);
  later(i, 1);
  await send(i, "run", { cmd: "sleep 1; echo one; sleep 1; echo two", tree: root });
  await settle(i);
  later(i, 3); await i.tick.fire(); await settle(i);
  later(i, 3); await i.tick.fire(); await settle(i);
  await fs.rm(dir, { recursive: true, force: true });
  await done("gen-run", i);
}

// ---------------------------------------------------------------- scripts: qjs/node and python in a thread (issue #25)
{
  const i = await sqliteInstance("gen-scripts");
  const js = "#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync('out.txt', fs.readFileSync('src/a.txt', 'utf8').toUpperCase());\nconsole.log(process.argv.slice(2), Date.now() > 1.7e12, Math.random());\nprocess.exitCode = 2;\n";
  const py = "#!/usr/bin/env python3\nimport sys, time, random, os, uuid, json\nprint(sys.argv[1:], time.time() > 1.7e9, random.random(), os.urandom(4).hex(), hash('x'), uuid.uuid4())\njson.dump(sorted(os.listdir('src')), open('ls.json', 'w'))\n";
  const dir = await fixture({ "src/a.txt": "alpha\n", "src/b.txt": "beta\n", "t.js": js, "t.py": py });
  const { root, bundles } = await bundlesOf(dir, 700);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  const cmds = [
    "node t.js a b; echo \"exit=$?\"; ./t.js c; cat out.txt",
    "python3 t.py x; ./t.py y; cat ls.json; python -c 'import datetime; print(datetime.datetime.now().year)'",
    "qjs -e 'console.log(scriptArgs, Date.now() > 1.7e12)'; python3 -c 'open(\"/opt/skein/python/lib/python314.zip\", \"ab\")' 2>&1 | tail -1",
  ];
  for (const cmd of cmds) { later(i, 1); await send(i, "run", { cmd, tree: root }); await settle(i); }
  // A sleep inside a runtime: python's time.sleep and a qjs timer rest the thread until the tick wakes it.
  later(i, 1);
  await send(i, "run", { cmd: "python3 -c 'import time; t = time.time(); time.sleep(2); print(time.time() - t >= 2)'; node -e 'const t = Date.now(); setTimeout(() => console.log(\"later\", Date.now() - t >= 1000), 1000)'", tree: root });
  await settle(i);
  later(i, 3); await i.tick.fire(); await settle(i);
  later(i, 3); await i.tick.fire(); await settle(i);
  await fs.rm(dir, { recursive: true, force: true });
  await done("gen-scripts", i);
}

// ---------------------------------------------------------------- heads and subscriptions
{
  const i = await sqliteInstance("gen-subs");
  const stranger = key();
  const dir = await fixture({ "a.txt": "a\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  await sendAs(i, stranger, "chat", { text: "hello?" }); await settle(i);
  await send(i, "subscribe", { op: "add", sender: stranger.toPublicKey().toString(), box: "run", handler: PROGRAM_CIDS["run-handler"] }); await settle(i);
  await send(i, "subscribe", { op: "add", sender: stranger.toPublicKey().toString(), box: "run", handler: PROGRAM_CIDS["run-handler"] }); await settle(i); // no change
  later(i, 1);
  await sendAs(i, stranger, "run", { cmd: "ls; echo stranger", tree: root }); await settle(i);
  await send(i, "subscribe", { op: "remove", sender: stranger.toPublicKey().toString(), box: "run", handler: PROGRAM_CIDS["run-handler"] }); await settle(i);
  await sendAs(i, stranger, "run", { cmd: "echo again", tree: root }); await settle(i);
  await send(i, "subscribe", { op: "bogus", box: "run", handler: PROGRAM_CIDS["run-handler"] }); await settle(i);
  await send(i, "head", { name: "work", tree: root }); await settle(i);
  await send(i, "head", { name: "bad name", tree: root }); await settle(i);
  await send(i, "run", { cmd: "echo x > y; ls" }); await settle(i);
  await fs.rm(dir, { recursive: true, force: true });
  await done("gen-subs", i);
}

// ---------------------------------------------------------------- chat: the loop, bash, replies, inference errors
{
  const hub = messageBoxHub();
  const clock = scriptClock();
  const a = await agent("gen-chat", hub, clock, [
    answer({ content: "", tool_calls: [toolCall("call-1", "ls | head -3; cat README")] }),
    answer({ content: "README and src.", reasoning_content: "short" }),
    answer({ content: "", tool_calls: [toolCall("call-2", "echo more > more.txt; ls"), toolCall("call-3", "sleep 1; date +%s")] }),
    answer({ content: "Done." }),
    { status: 500, text: "upstream down" },
  ]);
  const i = a.i;
  const dir = await fixture({ "README": "hello\n", "src/a.txt": "alpha\n", "SOUL.md": "Be brief.\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  const chat = await send(i, "chat", { text: "What is here?", tree: root });
  await settle(i); await a.peer.poll(); await settle(i); await a.peer.poll(); await settle(i);
  // David replies to the answer: the same thread.
  const [ans] = hub.pending(i.owner.identity, "chat");
  const { signedPart } = await import("../../src/envelope.ts");
  const { encode } = await import("../../src/runtime/cid.ts");
  const ansCid = encode(signedPart(JSON.parse(ans.body as string))).cid;
  later(i, 2);
  await send(i, "chat", { text: "Make more, then wait a second.", replyTo: ansCid });
  await settle(i); await a.peer.poll(); await settle(i);
  later(i, 5); await i.tick.fire(); await settle(i);
  await a.peer.poll(); await settle(i);
  // A second conversation: the inference peer fails.
  later(i, 1);
  await send(i, "chat", { text: "again?" });
  await settle(i); await a.peer.poll(); await settle(i);
  // A stray reply nobody awaits.
  await send(i, "chat", { text: "stray", replyTo: encode(signedPart(chat)).cid });
  await settle(i);
  await fs.rm(dir, { recursive: true, force: true });
  await done("gen-chat", i);
}

// ---------------------------------------------------------------- two agents talking; resolutions; outcomes
{
  const hub = messageBoxHub();
  const clock = scriptClock();
  const martha = await agent("gen-martha", hub, clock, [
    answer({ content: "", tool_calls: [messageCall("m1", "@gen-kurt@localhost", "What does the blue one cost?")] }),
    answer({ content: "", tool_calls: [messageCall("m2", "@gen-kurt@localhost", "The large one."), toolCall("c1", "echo noted")] }),
    answer({ content: "", tool_calls: [messageCall("m3", "@nobody@localhost", "hi"), messageCall("m4", "nobody", "hi")] }),
    answer({ content: "Blue is 5." }),
  ]);
  const kurt = await agent("gen-kurt", hub, clock, [
    answer({ content: "", tool_calls: [messageCall("k1", "@gen-martha@localhost", "Which size?")] }),
    answer({ content: "The large blue one is 5." }),
  ], true);
  const directory: Record<string, string> = { "gen-kurt@localhost": kurt.i.identity, "gen-martha@localhost": martha.i.identity };
  const resolver = { resolve: async (h: string, d: string) => directory[`${h}@${d}`] ? { identityKey: directory[`${h}@${d}`], via: "host" } : Promise.reject(new Error("unknown handle")) };
  martha.i.rt.resolver = resolver;
  kurt.i.rt.resolver = resolver;
  await send(martha.i, "chat", { text: "ask kurt about the blue one" });
  for (let n = 0; n < 12; n++) {
    await settle(martha.i); await settle(kurt.i); await settle(martha.i);
    if (await martha.peer.poll() + await kurt.peer.poll() === 0) break;
  }
  await done("gen-martha", martha.i);
  await done("gen-kurt", kurt.i);
}
{
  const bob = key().toPublicKey().toString();
  const inferKey = key();
  const hub = faultyHub(messageBoxHub(), (m) => m.recipient === bob ? noAccount() : undefined);
  const a = await agent("gen-outcome", hub, scriptClock(), [
    answer({ content: "", tool_calls: [messageCall("m1", "@bob@localhost", "hi bob")] }),
    answer({ content: "Bob cannot be reached." }),
  ]);
  a.i.rt.resolver = { resolve: async () => ({ identityKey: bob }) };
  await send(a.i, "chat", { text: "ask bob" });
  await settle(a.i); await a.peer.poll(); await settle(a.i); await settle(a.i); await a.peer.poll(); await settle(a.i);
  await done("gen-outcome", a.i);
  // The infer refused (no account): an inference error to the opener.
  const inferId = inferKey.toPublicKey().toString();
  const b = await sqliteInstance("gen-refused", { hub: faultyHub(messageBoxHub(), (m) => m.recipient === inferId ? noAccount() : undefined), config: { peers: { infer: inferId } } });
  await send(b, "chat", { text: "hello" });
  await settle(b); await settle(b);
  await done("gen-refused", b);
}

// ---------------------------------------------------------------- fuel: a low fuelPerStep (issue #5)
// The TS runtime does not meter, so it runs everything; on the Zig kernel
// the objects handler (~3M) fits in 10^8 and run-handler (~3·10^8, the Go
// runtime starting) runs out in its first step: errored, "fuel exhausted".
{
  const { DEFAULTS } = await import("../../src/runtime/log.ts");
  const i = await sqliteInstance("gen-fuel", { config: { defaults: { ...DEFAULTS, fuelPerStep: "100000000" } } });
  const dir = await fixture({ "a.txt": "a\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await send(i, "objects", b);
  await settle(i);
  later(i, 1);
  await send(i, "run", { cmd: "ls", tree: root });
  await settle(i);
  await fs.rm(dir, { recursive: true, force: true });
  await done("gen-fuel", i);
}

process.stdout.write(made.map((n) => join(out, `${n}.db`)).join("\n") + "\n");
