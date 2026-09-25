import { test } from "node:test";
import assert from "node:assert/strict";
import type { CID } from "multiformats/cid";
import { fmt } from "./cid.ts";
import { openStore, type SqliteStore } from "./sqlite.ts";
import { Scheduler } from "./scheduler.ts";
import type { Config } from "./config.ts";
import type { ThreadOrigin } from "./types.ts";
import type { LoopSpec } from "./runners/loop.ts";
import { loopRunner } from "./runners/loop.ts";
import { modelRunner } from "./runners/model.ts";
import { shellRunner } from "./runners/shell.ts";
import { davidRunner } from "./runners/david.ts";
import { nodesOf, short } from "./runners/util.ts";
import { collect, delta, drive, fakeModel, openThread, toolCall } from "./testkit.ts";
import { formatLs, main, parseArgs, UsageError, type Env } from "./cli.ts";
import { findWaitingDavid, resolveCid, Ambiguous } from "./view.ts";
import { DEFAULT_SYSTEM } from "./prompts.ts";

const config: Config = { providers: { fake: { baseUrl: "http://fake/v1" } } };
const spec: LoopSpec = { system: "terse", model: "fake/m", thinking: "off", tools: ["bash", "say", "page"], prompt: "What does echo hi print?" };

function setup(scripts: Parameters<typeof fakeModel>[0]) {
  const store = openStore(":memory:");
  const fake = fakeModel(scripts);
  const sched = new Scheduler(store, [loopRunner(), modelRunner({ config, fetch: fake.fetch }), shellRunner(), davidRunner()], { log: () => {} });
  const out: string[] = [], err: string[] = [], woke: Array<string | undefined> = [];
  const env: Partial<Env> = {
    out: (l) => out.push(l), err: (l) => err.push(l), store: () => store,
    wake: async (t) => { woke.push(t && fmt(t)); return true; },
    sleep: async () => { await sched.tick(); }, // watch polls; each poll lets the engine move
    columns: 200,
  };
  const run = async (...argv: string[]) => {
    out.length = 0; err.length = 0;
    const code = await main(argv, env);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { store, sched, fake, run, woke };
}

const waitingDavid = (store: SqliteStore) => collect(store.live.resting({ runner: "david", state: ["waiting"] }));

async function seeded() {
  const s = setup([
    [delta({ reasoning_content: "I should run it." }), ...toolCall("c1", "bash", { command: "echo hi" })],
    [...toolCall("c2", "say", { text: "It prints hi." })],
    [...toolCall("c3", "page", { markdown: "# Done\n\n- one", say: "See the page." })],
  ]);
  const loop = await openThread(s.store, "loop", spec);
  await drive(s.sched, async () => (await waitingDavid(s.store)).length === 1);
  return { ...s, loop };
}

test("cli: parseArgs", () => {
  assert.deepEqual(parseArgs(["a", "--model", "x/y", "--watch", "--thinking=low", "b"], { model: "string", watch: "boolean", thinking: "string" }),
    { pos: ["a", "b"], opts: { model: "x/y", watch: true, thinking: "low" } });
  assert.deepEqual(parseArgs(["--", "--not-a-flag"], {}), { pos: ["--not-a-flag"], opts: {} });
  assert.deepEqual(parseArgs(["-h"], {}).opts, { help: true });
  assert.deepEqual(parseArgs(["--port", "9"], {}).opts, { port: "9" }); // every command accepts --port
  assert.throws(() => parseArgs(["--nope"], {}), UsageError);
  assert.throws(() => parseArgs(["--model"], { model: "string" }), /needs a value/);
  assert.throws(() => parseArgs(["--watch=1"], { watch: "boolean" }), /takes no value/);
});

test("cli: help, unknown command, usage errors", async () => {
  const { run } = setup([]);
  assert.match((await run("--help")).out, /skein new/);
  const r = await run("new", "--help");
  assert.equal(r.code, 0);
  assert.match(r.out, /--thinking off\|low\|medium\|high/);
  assert.equal((await run("bogus")).code, 2);
  const bad = await run("new");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /missing <prompt>/);
  assert.equal((await run("new", "x", "--thinking", "max")).code, 2);
});

test("cli: formatLs aligns columns and truncates the label to the terminal", () => {
  const now = 1_000_000_000;
  const cid = "bafyreiabcdefghijklmnopqrstuvwxyz";
  const out = formatLs([
    { cid, runner: "loop", state: "waiting", at: now - 125_000, tipAt: now - 5_000, label: "x".repeat(300), davidWaiting: "bafyother" },
    { cid: "bafyreizzzzzzzzzzzzz", runner: "shell", state: "finished", at: now - 7_200_000, tipAt: now - 7_100_000, label: "$ ls" },
  ], now, 80).split("\n");
  assert.match(out[0], /^CID\s+RUNNER\s+STATE\s+AGE\s+ACTIVE\s+LABEL$/);
  assert.match(out[1], /^reiabcdefghi {2}loop {4}waiting:you {2}2m {3}5s {6}x+…$/);
  assert.ok(out[1].length <= 80, out[1]);
  assert.match(out[2], /^reizzzzzzzzz {2}shell {3}finished {5}2h {3}1h {6}\$ ls$/);
});

test("cli: ls, show, refs over a scripted loop run", async () => {
  const { run, loop, store } = await seeded();
  const ls = await run("ls");
  assert.equal(ls.code, 0);
  const lines = ls.out.split("\n");
  assert.equal(lines.length, 2, ls.out); // parent-less only
  assert.match(lines[1], new RegExp(`^${short(loop)}\\s+loop\\s+waiting:you\\s+\\d+s\\s+\\d+s\\s+What does echo hi print\\?$`));

  const all = (await run("ls", "--all")).out;
  for (const r of ["model", "shell", "david"]) assert.match(all, new RegExp(`\\s${r}\\s`));
  assert.match((await run("ls", "--all", "--runner", "shell")).out, /\$ echo hi/);
  assert.equal((await run("ls", "--all", "--state", "running")).out, "no threads");

  const show = await run("show", short(loop));
  assert.equal(show.code, 0, show.err);
  const o = show.out;
  assert.match(o, new RegExp(`^thread ${fmt(loop)}`));
  assert.match(o, /model fake\/m · thinking off · tools bash,say,page/);
  assert.match(o, /states\n\s+1\s+waiting/);
  assert.match(o, /step 1 .*\n\s+Prompt: What does echo hi print\?\n\s+↳ model {2}\w+ {2}finished {2}fake\/m · no usage · [\d.]+s {2}\[thinking 16 chars\]\n\s+↳ \$ echo hi {2}\w+ {2}finished {2}exit 0\n\s+rest waiting on/);
  assert.match(o, /step 2 .*\n\s+result ok \(c1\):\n\s+hi\n\s+\[exit 0\]/);
  assert.match(o, /say: It prints hi\.\n\s+↳ david {2}\w+ {2}waiting\n\s+rest finished/);
  assert.match(o, /waiting on David: skein reply/);
  assert.doesNotMatch(o, /I should run it/);
  assert.match((await run("show", fmt(loop), "--thinking")).out, /┊ I should run it\./);

  const [s1] = await nodesOf(store, loop);
  const node = await run("show", `bafy${short(s1)}`);
  assert.match(node.out, new RegExp(`^node ${fmt(s1)}\\n\\s+thread ${short(loop)} \\(loop\\)`));
  assert.match(node.out, /request\n[\s\S]*"role": "system"[\s\S]*emissions\n\s+↳ model {2}\w+ {2}finished\n\s+↳ \$ echo hi {2}\w+ {2}finished\nrest waiting on/);

  const update = await store.chains.tip(loop);
  const json = JSON.parse((await run("show", fmt(update))).out);
  assert.equal(json.origin, fmt(loop));
  assert.equal(json.state, "waiting");

  const refs = (await run("refs", short(s1))).out;
  assert.match(refs, /from bafy\S+\n\s+launched\s+bafy/);
  assert.match(refs, /depends-on/);

  const amb = await run("show", "rei");
  assert.equal(amb.code, 1);
  assert.match(amb.err, /"rei" matches \d+ origins/);
  await assert.rejects(resolveCid(store, "rei"), Ambiguous);
  assert.equal((await run("show", "zzzzzz")).code, 1);
});

test("cli: reply finds the waiting david thread from the loop, wakes it; --watch follows the next turn", async () => {
  const { run, loop, store, woke } = await seeded();
  const david = (await findWaitingDavid(store, loop))!;
  const r = await run("reply", short(loop), "thanks,", "now", "a", "page", "--watch");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^replied to ${short(david)}`));
  assert.deepEqual(woke, [fmt(david)]);
  assert.match(r.out, /David: thanks, now a page/);
  assert.match(r.out, /say: See the page\.\n.*page:\n\s+│ # Done\n\s+│ \n\s+│ - one/);
  assert.match(r.out, /— your turn: skein reply/);
  assert.equal((await nodesOf(store, loop)).length, 3);
  const next = (await findWaitingDavid(store, loop))!;
  assert.ok(!next.equals(david));

  // Replying via the david thread's own prefix works too; replying twice to a settled one doesn't.
  const again = await run("reply", short(david), "late");
  assert.equal(again.code, 1);
  assert.match(again.err, /waiting on David/);
  assert.equal((await run("reply", short(next), "ok")).code, 0);
});

test("cli: new opens a parent-less loop with the default prompt; --watch runs it to David", async () => {
  const { run, store, woke } = setup([[...toolCall("c1", "say", { text: "Hello David." })]]);
  const r = await run("new", "Say hello", "--model", "fake/m", "--thinking", "low", "--tools", "say", "--watch");
  assert.equal(r.code, 0, r.err);
  const cid = r.out.split("\n")[0];
  const t: CID = await resolveCid(store, cid);
  assert.deepEqual(woke, [cid]);
  const o = await store.get<ThreadOrigin>(t);
  assert.equal(o.launchedBy, undefined);
  assert.deepEqual(o.spec, { system: DEFAULT_SYSTEM, model: "fake/m", thinking: "low", tools: ["say"], prompt: "Say hello" });
  assert.match(r.out, /model \w+ → running {2}fake\/m/);
  assert.match(r.out, /say: Hello David\./);
  assert.match(r.out, /— your turn/);
});

test("cli: rebuild keeps ls identical", async () => {
  const { run } = await seeded();
  const before = (await run("ls", "--all")).out;
  assert.equal((await run("rebuild")).out, "index rebuilt");
  assert.equal((await run("ls", "--all")).out, before);
});
