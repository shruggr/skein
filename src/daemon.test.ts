import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./sqlite.ts";
import { startDaemon } from "./daemon.ts";
import type { Config } from "./config.ts";
import { fakeModel, toolCall, delta } from "./testkit.ts";
import { markdown } from "./web/markdown.ts";

const config: Config = { providers: { fake: { baseUrl: "http://fake/v1", models: ["m"] } }, defaults: { model: "fake/m", thinking: "off" } };

async function until<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("daemon: new → threads → thread → block → reply → second turn, over HTTP", async () => {
  const store = openStore(":memory:");
  const fake = fakeModel([
    [delta({ reasoning_content: "hmm" }), ...toolCall("c1", "bash", { command: "echo from-bash" })],
    [...toolCall("c2", "say", { text: "It said from-bash." })],
    [...toolCall("c3", "page", { markdown: "# Listing\n\n```\na\nb\n```", say: "Here you go." })],
  ]);
  const d = await startDaemon({ store, port: 0, tickMs: 25, config, fetch: fake.fetch, log: () => {} });
  const get = async (p: string) => { const r = await fetch(d.url + p); return { status: r.status, type: r.headers.get("content-type"), text: await r.text() }; };
  const json = async (p: string) => JSON.parse((await get(p)).text);
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(d.url + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
  try {
    const created = await post("/api/new", { prompt: "What does echo from-bash print?", thinking: "off" });
    assert.equal(created.status, 201);
    const { thread } = await created.json();
    assert.match(thread, /^bafy/);

    const v1 = await until(async () => { const v = await json(`/api/thread/${thread}`); return v.davidWaiting ? v : undefined; });
    assert.equal(v1.runner, "loop");
    assert.equal(v1.nodes.length, 2);
    assert.deepEqual(v1.nodes[1].emits.map((e: { type: string }) => e.type), ["tool_result", "launched", "say", "launched"]);
    assert.equal(v1.nodes[0].emits[0].run.thinking, "hmm");
    assert.equal((await json(`/api/thread/${thread}?since=${v1.version}`)).changed, false);

    const threads = await json("/api/threads");
    assert.deepEqual(threads.map((t: { cid: string }) => t.cid), [thread]);
    assert.equal(threads[0].davidWaiting, v1.davidWaiting);
    assert.ok((await json("/api/threads?all=1")).length >= 5);

    // Block browsing: JSON with CIDs as strings, refs both ways; prefixes resolve.
    const b = await json(`/api/block/${thread.slice(4, 16)}`);
    assert.equal(b.cid, thread);
    assert.equal(b.block.kind, "thread");
    assert.equal(b.isThread, true);
    assert.ok(b.chain.length >= 3);
    const upd = await json(`/api/block/${b.chain[0]}`);
    assert.equal(upd.origin, thread);
    assert.equal(upd.block.origin, thread);
    const step = await json(`/api/block/${v1.nodes[0].cid}`);
    assert.ok(step.refsFrom.some((r: { rel: string }) => r.rel === "launched"));
    assert.equal((await get("/api/block/zzzzzz")).status, 404);

    // Pages render.
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.match(home.type!, /text\/html/);
    assert.match(home.text, /What does echo from-bash print\?/);
    assert.match(home.text, /<option selected>fake\/m<\/option>/);
    const page = await get(`/t/${thread}`);
    assert.match(page.text, /<div class="say">It said from-bash\.<\/div>/);
    assert.match(page.text, /<summary>thinking · 3 chars<\/summary><pre>hmm<\/pre>/);
    assert.match(page.text, /<pre>from-bash\n\[exit 0\]<\/pre>/);
    assert.match(page.text, /action="\/api\/reply"/);
    assert.match(page.text, /let v = \d+, live = false/);
    const blockPage = await get(`/b/${v1.nodes[0].cid}`);
    assert.match(blockPage.text, new RegExp(`<a href="/b/${thread}">${thread}</a>`));
    assert.match(blockPage.text, /refs to/);

    // Another origin can't drive it.
    const evil = await post("/api/new", { prompt: "rm -rf" }, { origin: "http://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal((await json("/api/threads")).length, 1);

    // A form reply (what the page posts) redirects back to the thread.
    const replied = await fetch(`${d.url}/api/reply`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: d.url },
      body: new URLSearchParams({ thread, text: "thanks, now a page", back: `/t/${thread}` }),
    });
    assert.equal(replied.status, 303);
    assert.equal(replied.headers.get("location"), `/t/${thread}`);
    const v2 = await until(async () => {
      const v = await json(`/api/thread/${thread}`);
      return v.davidWaiting && v.davidWaiting !== v1.davidWaiting ? v : undefined;
    });
    assert.equal(v2.nodes.length, 3);
    assert.equal(v2.nodes[2].asked, "David: thanks, now a page");
    const page2 = await get(`/t/${thread}`);
    assert.match(page2.text, /<div class="page"><h1>Listing<\/h1>\n<pre><code>a\nb<\/code><\/pre><\/div>/);

    const again = await post("/api/reply", { thread: v1.davidWaiting, text: "late" });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /waiting on David/);
    assert.equal((await post("/api/wake", {})).status, 200);
    assert.equal(fake.requests.length, 3);
  } finally {
    await d.close();
    await store.close();
  }
});

test("markdown: the constructs pages use, escaped", () => {
  assert.equal(markdown("# T\n\npara *em* **b** `c<d>`\nmore\n\n- a\n- b\n\n1. x\n\n> q\n\n---\n[l](https://x.y) [bad](javascript:alert(1))"),
    '<h1>T</h1>\n<p>para <em>em</em> <strong>b</strong> <code>c&lt;d&gt;</code> more</p>\n<ul><li>a</li><li>b</li></ul>\n<ol><li>x</li></ol>\n'
    + '<blockquote>q</blockquote>\n<hr>\n<p><a href="https://x.y">l</a> [bad](javascript:alert(1))</p>');
  assert.equal(markdown("| a | b |\n|---|---|\n| 1 | <2> |"), "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>&lt;2&gt;</td></tr></tbody></table>");
  assert.equal(markdown("```sh\n<x>\n```"), '<pre><code class="lang-sh">&lt;x&gt;</code></pre>');
});
