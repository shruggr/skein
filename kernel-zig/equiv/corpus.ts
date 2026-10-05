// A generated corpus for the replay equivalence: instance stores in format 3
// (issue #40), written by the Zig kernel as the router drives it (each
// instance an HTTP server — its front door — messages admitted as `mail`
// entries, acknowledgements as events (sessions are in memory, never in the
// log), delivery over http from
// the VM, wakes by the waker), on a script clock. The shell and the chat loop
// are apps (#83): each instance that runs them has the shell app and/or the
// chat app installed first by the owner's messages (`skein plan install`, #124; src/testapps.ts: their
// pinned commits, or $SKEIN_SHELL_DIR / $SKEIN_CHAT_DIR) — the installs are in
// the corpus too. It exercises the shell
// under run-handler (writes, cwd, failures, sleeps and their wakes), the
// script runtimes, the kernel's objects/head/dispatch operations (#77), the loop with bash and
// message tools, replies, resolves (no claims, #40), delivery failures, inference
// errors, two agents talking, the owner's mailbox instance, and a low
// fuelPerStep. The owner speaks raw BRC-33 (src/client/raw.ts); the
// inference peer answers from its own mailbox instance.
//
//   node --experimental-strip-types --no-warnings kernel-zig/equiv/corpus.ts <out-dir>

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";
import { CID } from "multiformats/cid";
import { RawBox } from "../../src/client/raw.ts";
import { HostDb } from "../../src/host/instances.ts";
import { Router } from "../../src/host/router.ts";
import { fakeDiscovery } from "../../src/host/fake-discovery.ts";
import { Signer } from "../../src/host/signer.ts";
import { InferPeer } from "../../src/peers/infer.ts";
import { DEFAULTS } from "../../src/runtime/log.ts";
import { CHAT_APP, installApps, SHELL_APP, type PinnedApp } from "../../src/testapps.ts";
import { bundlesOf, scriptClock } from "../../src/testkit.ts";
import { ephemeralWallet } from "../../src/wallet.ts";

type Json = Record<string, unknown>;
const here = dirname(fileURLToPath(import.meta.url));
const kernel = process.env.SKEIN_KERNEL_BIN ?? join(here, "../zig-out/bin/skein-kernel");
const out = process.argv[2]!;
await fs.mkdir(out, { recursive: true });
const verbose = !!process.env.VERBOSE;

// Fixed keys, so the corpus is the same every time it is made (up to wallet IVs and session nonces).
let seed = 0x5eed00n;
const key = () => new PrivateKey((seed++).toString(16), 16);

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "skein-kz-corpus-"));
  for (const [p, t] of Object.entries(files)) {
    await fs.mkdir(join(dir, p, ".."), { recursive: true });
    await fs.writeFile(join(dir, p), t);
  }
  return dir;
}

function scripted(answers: Array<Json | { status: number; text: string }>) {
  return (async () => {
    const x = answers.shift();
    if (!x) return new Response("no more answers", { status: 500 });
    if ("status" in x && typeof x.status === "number") return new Response(String(x.text), { status: x.status });
    return new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}
const toolCall = (id: string, cmd: string) => ({ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd }) } });
const messageCall = (id: string, to: string, text: string) => ({ id, type: "function", function: { name: "message", arguments: JSON.stringify({ to, text }) } });
const answer = (message: Json) => ({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "qwen38" });

/**
 * One host: a router over its own host.db, its agents' stores written to
 * out/<name>.db, the owner's mailbox instance `david` (in the corpus as
 * out/<first agent>-david.db), on a script clock.
 */
async function host(o: { defaults?: Record<string, string>; infer?: PrivateKey } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-kz-corpus-home-"));
  const db = new HostDb(join(home, "host.db"));
  const clock = scriptClock();
  const keys = new Map<string, PrivateKey>();
  const handles = new Map<string, string>(); // key → handle
  const ownerKey = key();
  const owner = ephemeralWallet(ownerKey), ownerId = ownerKey.toPublicKey().toString();
  const router: Router = new Router({
    db, walletFor: (row) => ephemeralWallet(keys.get(row.handle)!), home, providerKeyFor: (n) => new Signer(new PrivateKey("a77e57", 16)).providerKey(n),
    // No host skein here (#113): the handles resolve over host.db (a fixture).
    discovery: fakeDiscovery(db, () => router),
    owner: ownerId, infer: o.infer?.toPublicKey().toString(), idleMs: 0, now: clock.now, ledgerMs: 3_600_000,
    fuelPerStep: o.defaults?.fuelPerStep, kernel: { command: kernel, env: { SKEIN_HOME: home } },
    log: (src, l) => { if (verbose) process.stdout.write(`  | [${src}] ${l}\n`); },
  });
  await router.listen(0);
  const base = `http://127.0.0.1:${router.port}`;
  const boxes = new Map<string, RawBox>();
  const boxOf = (w: ReturnType<typeof ephemeralWallet>, wid: string, handle: string) => {
    const k = `${wid}/${handle}`;
    let b = boxes.get(k);
    if (!b) { b = new RawBox(w, `${base}/@${handle}`); boxes.set(k, b); }
    return b;
  };
  /** A mailbox instance for identity `whose`: its row (a fixture's; its genesis at first hydration). */
  const mailbox = (name: string, whose: string, store?: string) => {
    keys.set(name, key());
    db.add(name, { kind: "mailbox", owner: whose, store: store ?? join(home, "instances", name, "runtime.db"), identity: keys.get(name)!.toPublicKey().toString() });
  };
  let first: string | undefined;
  const add = async (name: string) => {
    keys.set(name, key());
    await fs.rm(join(out, `${name}.db`), { force: true });
    if (!first) {
      // The owner's mailbox before the first agent's genesis (which names it): in the corpus too.
      first = name;
      await fs.rm(join(out, `${name}-david.db`), { force: true });
      mailbox("david", ownerId, join(out, `${name}-david.db`));
      mailboxes.push(`${name}-david`);
    }
    db.add(name, { store: join(out, `${name}.db`), identity: keys.get(name)!.toPublicKey().toString() });
    await router.hydrate(name);
    const id = keys.get(name)!.toPublicKey().toString();
    handles.set(id, name);
    return id;
  };
  const h = {
    db, router, clock, owner, ownerKey, ownerId, add, mailbox, base,
    /** Let every kernel finish what it was given. */
    settle: () => router.settled(),
    /** Install apps into an agent as the owner (#83), by the owner's messages (`skein plan install`, #124). */
    install: (name: string, apps: PinnedApp[]) => installApps({ home, port: router.port, owner, settled: () => router.settled() }, name, apps),
    later(sec: number) { const [s0, ns] = clock.now(); clock.set([s0 + sec, ns + 1000]); },
    /** Advance the clock and let the waker admit what is due. */
    async tick(sec: number) { h.later(sec); await router.wake(); await router.settled(); },
    /** Raw BRC-33 to `to` (an agent's key) in `box`, as the owner (or `as`); the message's id. */
    async send(to: string, boxName: string, body: unknown, as = owner, asId = ownerId): Promise<CID> {
      const r = await boxOf(as, asId, handles.get(to)!).send(to, boxName, body);
      await router.settled();
      return r.id;
    },
    /** The owner's mailbox: a box's messages. */
    list: (boxName: string) => boxOf(owner, ownerId, "david").list(boxName),
    async done() { await router.settled(); await router.stop(); db.close(); await fs.rm(home, { recursive: true, force: true }); },
  };
  return h;
}

/** The inference peer on its own mailbox instance `infer` (raw BRC-33), answering from a script. */
function inferPeer(h: Awaited<ReturnType<typeof host>>, k: PrivateKey, answers: Array<Json | { status: number; text: string }>) {
  const w = ephemeralWallet(k);
  h.mailbox("infer", k.toPublicKey().toString());
  const outs = new Map<string, RawBox>();
  return new InferPeer({
    log: () => {}, wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1", apiKey: "k" } }, fetch: scripted(answers),
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => { let b = outs.get(url); if (!b) { b = new RawBox(w, url); outs.set(url, b); } return b; },
      // Its address book (#40), configured: every row's key at its origin.
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox") ?? h.db.mailboxOf(k); return r && h.router.originOf(r.handle); },
    },
  });
}

const made: string[] = [];
/** The owners' mailbox instances: in the corpus if anything was delivered there (it has a store). */
const mailboxes: string[] = [];

// The in-step clock is the Zig kernel's (issue #38: entry stamp + fuel ×
// 1 ns). The scripts below print only clock invariants (orderings, elapsed ≥
// the sleep, the year), as they did when the corpus was written by the TS
// runtime; equiv/serve.ts prints real mid-step times.

// ---------------------------------------------------------------- run: the shell under run-handler
{
  const h = await host();
  const i = await h.add("gen-run");
  await h.install("gen-run", [SHELL_APP]);
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
  await h.send(i, "run", { cmd: "t0=$(date +%s%N); echo $RANDOM; sleep 2; t1=$(date +%s%N); echo $(( t1 - t0 >= 2000000000 )); echo $RANDOM; echo x > made.txt; ls", tree: root });
  await h.tick(1); // not due
  await h.tick(5);
  h.later(1);
  await h.send(i, "run", { cmd: "sleep 1; echo one; sleep 1; echo two", tree: root });
  await h.tick(3);
  await h.tick(3);
  // Scripts: qjs/node and python in a thread (issue #25), on the same instance (#83: one shell app install for both).
  const js = "#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync('out.txt', fs.readFileSync('src/a.txt', 'utf8').toUpperCase());\nconsole.log(process.argv.slice(2), Date.now() > 1.7e12, Math.random());\nprocess.exitCode = 2;\n";
  const py = "#!/usr/bin/env python3\nimport sys, time, random, os, uuid, json\nprint(sys.argv[1:], time.time() > 1.7e9, random.random(), os.urandom(4).hex(), hash('x'), uuid.uuid4())\njson.dump(sorted(os.listdir('src')), open('ls.json', 'w'))\n";
  const sdir = await fixture({ "src/a.txt": "alpha\n", "src/b.txt": "beta\n", "t.js": js, "t.py": py });
  const s = await bundlesOf(sdir, 700);
  for (const b of s.bundles) await h.send(i, "objects", b);
  const sroot = s.root;
  const scmds = [
    "node t.js a b; echo \"exit=$?\"; ./t.js c; cat out.txt",
    "python3 t.py x; ./t.py y; cat ls.json; python -c 'import datetime; print(datetime.datetime.now().year)'",
    "qjs -e 'console.log(scriptArgs, Date.now() > 1.7e12)'; python3 -c 'open(\"/opt/skein/python/lib/python314.zip\", \"ab\")' 2>&1 | tail -1",
  ];
  for (const cmd of scmds) { h.later(1); await h.send(i, "run", { cmd, tree: sroot }); }
  // A sleep inside a runtime: python's time.sleep and a qjs timer rest the thread until the waker wakes it.
  h.later(1);
  await h.send(i, "run", { cmd: "python3 -c 'import time; t = time.time(); time.sleep(2); print(time.time() - t >= 2)'; node -e 'const t = Date.now(); setTimeout(() => console.log(\"later\", Date.now() - t >= 1000), 1000)'", tree: sroot });
  await h.tick(3);
  await h.tick(3);
  await fs.rm(sdir, { recursive: true, force: true });
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-run");
}

// ---------------------------------------------------------------- heads and the dispatch table (#77: kernel operations)
{
  const h = await host();
  const i = await h.add("gen-subs");
  await h.install("gen-subs", [CHAT_APP]);
  const stranger = key();
  const sw = ephemeralWallet(stranger), sid = stranger.toPublicKey().toString();
  const dir = await fixture({ "a.txt": "a\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await h.send(i, "objects", b);
  // The chat app's loop (#83): its app record's, at the head chat/app — the row below wires it to a box of its own, `ask`.
  const k = h.router.loaded.get("gen-subs")!.kernel;
  const handler = (await k.store.get(await k.call("head", "chat/app") as CID) as unknown as { programs: Record<string, CID> }).programs.loop;
  await h.send(i, "chat", { text: "hello?" }, sw, sid);
  // The kernel's `dispatch` operation (#77): a row's sender is bytes; the same row again changes nothing; a hex sender is refused.
  const row = { transport: "mailbox", address: "ask", sender: Uint8Array.from(Buffer.from(sid, "hex")), program: handler };
  await h.send(i, "dispatch", { op: "add", row });
  await h.send(i, "dispatch", { op: "add", row }); // no change
  await h.send(i, "dispatch", { op: "add", row: { ...row, sender: sid } }); // refused: the sender is not a key
  h.later(1);
  await h.send(i, "ask", { text: "what is here?", tree: root }, sw, sid); // the loop; no inference peer here: it answers so, and the answer has nowhere to go (no peer record)
  await h.send(i, "dispatch", { op: "remove", row });
  await h.send(i, "ask", { text: "again" }, sw, sid).catch(() => {}); // no row: refused, nothing written
  await h.send(i, "dispatch", { op: "bogus", row });
  await h.send(i, "head", { name: "work", tree: root });
  await h.send(i, "head", { name: "bad name", tree: root });
  await h.send(i, "run", { cmd: "echo x > y; ls" }).catch(() => {}); // no shell app here (#83): no row takes `run`; refused, nothing written
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
  await h.install("gen-chat", [SHELL_APP, CHAT_APP]);
  const poll = async () => { await peer.poll(); await h.settle(); };
  const dir = await fixture({ "README": "hello\n", "src/a.txt": "alpha\n", "SOUL.md": "Be brief.\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await h.send(i, "objects", b);
  const chat = await h.send(i, "chat", { text: "What is here?", tree: root });
  await poll(); await poll();
  // David replies to the answer (its id: the messageId his mailbox lists): the same thread.
  const [ans] = await h.list("chat");
  const ansCid = CID.parse(ans!.messageId);
  h.later(2);
  await h.send(i, "chat", { text: "Make more, then wait a second.", replyTo: ansCid });
  await poll();
  await h.tick(5);
  await poll();
  // A second conversation: the inference peer fails.
  h.later(1);
  await h.send(i, "chat", { text: "again?" });
  await poll();
  // A reply to the loop's "Done." resumes that thread.
  const done = (await h.list("chat")).find((m) => (m.value as { text?: string }).text === "Done.")!;
  await h.send(i, "chat", { text: "and the rest?", replyTo: CID.parse(done.messageId) });
  await poll();
  // A stray reply nobody awaits: the chat we sent names no message the instance sent us.
  await h.send(i, "chat", { text: "stray", replyTo: chat });
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-chat");
}

// ---------------------------------------------------------------- two agents talking (raw BRC-33 between them); resolves (each learns the other by its own resolve); delivery failures
{
  const inferKey = key();
  const h = await host({ infer: inferKey });
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
  await h.install("gen-martha", [CHAT_APP]); // no shell app (#83): her `bash` call answers that there is none
  await h.add("gen-kurt");
  await h.install("gen-kurt", [CHAT_APP]);
  await h.send(martha, "chat", { text: "ask kurt about the blue one" });
  for (let n = 0; n < 12; n++) { if (await peer.poll() === 0) break; await h.settle(); }
  await h.done();
  made.push("gen-martha", "gen-kurt");
}
{
  // The admin's `peers` box: bob at a URL where nothing answers — the delivery fails, an error result for the model.
  const inferKey = key();
  const bob = key().toPublicKey().toString();
  const h = await host({ infer: inferKey });
  const peer = inferPeer(h, inferKey, [
    answer({ content: "", tool_calls: [messageCall("m1", "@bob@localhost", "hi bob")] }),
    answer({ content: "Bob cannot be reached." }),
  ]);
  const i = await h.add("gen-outcome");
  await h.install("gen-outcome", [CHAT_APP]);
  await h.send(i, "peers", { op: "add", key: Uint8Array.from(Buffer.from(bob, "hex")), url: `${h.base}/@gone`, handle: "bob", domain: "localhost" });
  await h.send(i, "chat", { text: "ask bob" });
  for (let n = 0; n < 4; n++) { await peer.poll(); await h.settle(); }
  await h.done();
  made.push("gen-outcome");
}
{
  // The inference peer has no mailbox anywhere: its handle does not resolve; an inference error to the opener.
  const h = await host({ infer: key() });
  const i = await h.add("gen-refused");
  await h.install("gen-refused", [CHAT_APP]);
  await h.send(i, "chat", { text: "hello" });
  await h.done();
  made.push("gen-refused");
}
{
  // A stranger in no address book chats the agent's open box (#40): admitted and inferred; the answer has no route.
  const inferKey = key();
  const h = await host({ infer: inferKey });
  const peer = inferPeer(h, inferKey, [answer({ content: "Hello, stranger." })]);
  const i = await h.add("gen-stranger");
  await h.install("gen-stranger", [CHAT_APP]);
  const sk = key();
  await h.send(i, "chat", { text: "hi" }, ephemeralWallet(sk), sk.toPublicKey().toString());
  for (let n = 0; n < 4; n++) { await peer.poll(); await h.settle(); }
  await h.done();
  made.push("gen-stranger");
}

// ---------------------------------------------------------------- fuel: a low fuelPerStep (issue #5)
// A fuelPerStep the shell app's install fits in (#83: the front door steps on
// each install message, a module whole — ~10 MB — among them; 10^6, as this
// case was before, admits none), and run-handler's steps; the shell spinning
// runs out: errored, "fuel exhausted", and run-handler delivers the error.
{
  const h = await host({ defaults: { ...DEFAULTS, fuelPerStep: "1000000000" } });
  const i = await h.add("gen-fuel");
  await h.install("gen-fuel", [SHELL_APP]);
  const dir = await fixture({ "a.txt": "a\n" });
  const { root, bundles } = await bundlesOf(dir);
  for (const b of bundles) await h.send(i, "objects", b);
  h.later(1);
  await h.send(i, "run", { cmd: "ls", tree: root });
  h.later(1);
  await h.send(i, "run", { cmd: "echo start; while :; do :; done", tree: root });
  await fs.rm(dir, { recursive: true, force: true });
  await h.done();
  made.push("gen-fuel");
}

for (const m of mailboxes) if (await fs.stat(join(out, `${m}.db`)).then(() => true, () => false)) made.push(m);
process.stdout.write(made.map((n) => join(out, `${n}.db`)).join("\n") + "\n");
