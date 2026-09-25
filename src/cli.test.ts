import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CID } from "multiformats/cid";
import { fmt } from "./cid.ts";
import { openStore } from "./sqlite.ts";
import type { ThreadOrigin } from "./types.ts";
import { nodesOf, short } from "./graph.ts";
import { ownerSay } from "./instance.ts";
import { LOOP_CID } from "./programs/records.ts";
import { executionService } from "./services/execution.ts";
import { collect, instance, scriptedInference, type Reply } from "./testkit.ts";
import { formatLs, main, parseArgs, UsageError, type Env } from "./cli.ts";
import { resolveCid, Ambiguous, waitingOnPerson } from "./view.ts";

async function setup(replies: Reply[]) {
  const inf = scriptedInference(replies);
  const h = await instance([inf, executionService({ home: mkdtempSync(join(tmpdir(), "skein-cli-")), cwd: tmpdir() })], { store: openStore(":memory:") });
  const out: string[] = [], err: string[] = [], woke: Array<string | undefined> = [];
  const env: Partial<Env> = {
    out: (l) => out.push(l), err: (l) => err.push(l), store: () => h.store, wallet: async () => h.wallet,
    wake: async (t) => { woke.push(t && fmt(t)); await h.rt.poll(); await h.rt.idle(); return true; },
    sleep: async () => { await h.rt.poll(); await h.rt.idle(); }, // watch polls; each poll lets the engine move
    columns: 200,
  };
  const run = async (...argv: string[]) => {
    out.length = 0; err.length = 0;
    const code = await main(argv, env);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { ...h, inf, run, woke };
}

async function seeded() {
  const s = await setup([
    { thinking: "I should run it.", calls: [["c1", "bash", { cmd: "echo hi" }]] },
    { calls: [["c2", "say", { text: "It prints hi." }]] },
    { calls: [["c3", "page", { markdown: "# Done\n\n- one", say: "See the page." }]] },
  ]);
  await ownerSay(s.store, s.wallet, "What does echo hi print?", { runtime: s.rt });
  await s.rt.idle();
  const [loop] = await collect(s.store.edges.query({ kind: "thread", program: LOOP_CID }));
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
  const { run } = await setup([]);
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
    { cid: "bafyreizzzzzzzzzzzzz", runner: "bash", state: "finished", at: now - 7_200_000, tipAt: now - 7_100_000, label: "$ ls" },
  ], now, 80).split("\n");
  assert.match(out[0], /^CID\s+RUNNER\s+STATE\s+AGE\s+ACTIVE\s+LABEL$/);
  assert.match(out[1], /^reiabcdefghi {2}loop {4}waiting:you {2}2m {3}5s {6}x+…$/);
  assert.ok(out[1].length <= 80, out[1]);
  assert.match(out[2], /^reizzzzzzzzz {2}bash {4}finished {5}2h {3}1h {6}\$ ls$/);
});

test("cli: ls, show, refs over a scripted loop run", async () => {
  const { run, loop, store } = await seeded();
  const ls = await run("ls");
  assert.equal(ls.code, 0, ls.err);
  const lines = ls.out.split("\n");
  assert.equal(lines.length, 2, ls.out); // top-level only
  assert.match(lines[1], new RegExp(`^${short(loop)}\\s+loop\\s+waiting:you\\s+\\d+s\\s+\\d+s\\s+What does echo hi print\\?$`));

  const all = (await run("ls", "--all")).out;
  assert.match(all, /\sbash\s/);
  assert.match((await run("ls", "--all", "--runner", "bash")).out, /\$ echo hi/);
  assert.equal((await run("ls", "--all", "--state", "running")).out, "no threads");

  const show = await run("show", short(loop));
  assert.equal(show.code, 0, show.err);
  const o = show.out;
  assert.match(o, new RegExp(`^thread ${fmt(loop)}`));
  assert.match(o, /model \(config default\) · thinking \(default\) · tools \(default\)/);
  assert.match(o, /program loop \w+/);
  assert.match(o, /states\n\s+1\s+waiting\s+\S+\s+from \w+…/);
  assert.match(o, /step 1 .*\n\s+Prompt: What does echo hi print\?\n\s+→ infer \w+\n\s+← \w+  scripted\/m · 0\.0s\n\s+thinking: 16 chars\n\s+↳ \$ echo hi {2}\w+ {2}finished {2}exit 0\n\s+result ok \(c1\):\n\s+hi\n\s+\[exit 0\]\n\s+rest finished/);
  assert.match(o, /step 2 [\s\S]*say: It prints hi\.\n\s+rest finished/);
  assert.match(o, /waiting on David: skein reply/);
  assert.doesNotMatch(o, /I should run it/);
  assert.match((await run("show", fmt(loop), "--thinking")).out, /┊ I should run it\./);

  const [s1] = await nodesOf(store, loop);
  const node = await run("show", `bafy${short(s1)}`);
  assert.match(node.out, new RegExp(`^node ${fmt(s1)}\\n\\s+thread ${short(loop)} \\(loop\\)`));
  assert.match(node.out, /request\n[\s\S]*"role": "system"[\s\S]*emissions\n\s+→ infer/);

  const update = await store.chains.tip(loop);
  const json = JSON.parse((await run("show", fmt(update))).out);
  assert.equal(json.origin, fmt(loop));
  assert.equal(json.state, "waiting");

  const refs = (await run("refs", short(s1))).out;
  assert.match(refs, /from bafy\S+\n\s+about\s+bafy/);
  assert.match(refs, /launched\s+bafy/);

  const amb = await run("show", "rei");
  assert.equal(amb.code, 1);
  assert.match(amb.err, /"rei" matches \d+ origins/);
  await assert.rejects(resolveCid(store, "rei"), Ambiguous);
  assert.equal((await run("show", "zzzzzz")).code, 1);
});

test("cli: reply signs David's answer to the waiting loop; --watch follows the next turn", async () => {
  const { run, loop, store, woke } = await seeded();
  const r = await run("reply", short(loop), "thanks,", "now", "a", "page", "--watch");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^replied to ${short(loop)} \\(bafy`));
  assert.deepEqual(woke, [fmt(loop)]);
  assert.match(r.out, /say: See the page\.\n.*page:\n\s+│ # Done\n\s+│ \n\s+│ - one/);
  assert.match(r.out, /— your turn: skein reply/);
  assert.equal((await nodesOf(store, loop)).length, 3);
  assert.ok(await waitingOnPerson(store, loop));

  // A bash thread isn't waiting on David.
  const [bash] = await collect(store.edges.query({ kind: "thread", runner: undefined, state: ["finished"] }));
  const again = await run("reply", short(bash), "late");
  assert.equal(again.code, 1);
  assert.match(again.err, /not waiting on David/);
});

test("cli: new sends a new-session prompt and prints the loop's CID; --watch runs it to David", async () => {
  const { run, store, woke, inf } = await setup([{ calls: [["c1", "say", { text: "Hello David." }]] }]);
  const r = await run("new", "Say hello", "--model", "fake/m", "--thinking", "low", "--watch");
  assert.equal(r.code, 0, r.err);
  const cid = r.out.split("\n")[0];
  const t: CID = await resolveCid(store, cid);
  assert.deepEqual(woke, [cid]);
  const o = await store.get<ThreadOrigin>(t);
  assert.ok(o.program!.equals(LOOP_CID));
  assert.deepEqual(o.args, { kind: "prompt", text: "Say hello", new: true, model: "fake/m", thinking: "low" });
  assert.equal(inf.requests[0].model, "fake/m");
  assert.match(r.out, /say: Hello David\./);
  assert.match(r.out, /— your turn/);
});

test("cli: rebuild keeps ls identical", async () => {
  const { run } = await seeded();
  const before = (await run("ls", "--all")).out;
  assert.equal((await run("rebuild")).out, "index rebuilt");
  assert.equal((await run("ls", "--all")).out, before);
});
