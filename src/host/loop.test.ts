// The loop over #40's delivery, end to end with the real Zig kernel: a chat
// to alpha; alpha's `infer` goes over http to the inference peer's mailbox
// instance (its record from its own resolve, first contact, kept under
// `resolve/peers` — #87: never the address book, which is the owner's); the
// peer answers into alpha's `completions` at the messagebox its own address
// book names for alpha; the model calls `message` to @beta@localhost — alpha
// resolves beta, delivers the chat to beta's front door in process (no
// socket), beta's loop answers alpha (alpha is in beta's address book: the
// admin put it there through beta's `peers` box); alpha's turn ends with its
// answer in the owner's mailbox. Nothing registers itself: no claim is ever
// sent. A stranger (in no address book) may still chat an agent on its open
// `chat` box: admitted and answered, the answer fails once with "no route".

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PrivateKey } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { RawBox } from "../client/raw.ts";
import { InferPeer } from "../peers/infer.ts";
import { ephemeralWallet } from "../wallet.ts";
import { KERNEL_BIN } from "./kernel.ts";
import { testHost, until } from "./testhost.ts";

type Json = Record<string, unknown>;

/** Every box a message is delivered to over the router's http (sendMessage), in order, from now on. */
function watchBoxes(h: Awaited<ReturnType<typeof testHost>>): string[] {
  const seen: string[] = [];
  const dispatch = h.router.dispatch.bind(h.router);
  h.router.dispatch = async (req) => {
    if (req.method === "POST" && req.url.endsWith("/sendMessage")) {
      try { seen.push(String((dagCbor.decode(req.body) as { message?: { messageBox?: string } }).message?.messageBox)); } catch { /* JSON: the stock client */ try { seen.push(String(JSON.parse(new TextDecoder().decode(req.body)).message?.messageBox)); } catch { /* neither */ } }
    }
    return await dispatch(req);
  };
  return seen;
}
const answer = (message: Json) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "q" }), { status: 200 });
const messageCall = (id: string, to: string, text: string) => ({ id, type: "function", function: { name: "message", arguments: JSON.stringify({ to, text }) } });

test("the loop: infer over http to a mailbox instance; `message` to another agent resolved and delivered in process; replies both ways; the answer in the owner's mailbox", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  const alpha = h.agent("alpha");
  const beta = h.agent("beta");
  await h.router.start();
  const boxes = watchBoxes(h);
  // The admin's configuration: alpha in beta's address book (the owner, through beta's `peers` box).
  await new RawBox(h.owner, `${h.base}/@beta`).send(beta, "peers", { op: "add", key: alpha, url: h.origin("alpha"), handle: "alpha", domain: "localhost" });

  const asked: Json[] = [];
  const script = [
    answer({ content: "", tool_calls: [messageCall("c1", "@beta@localhost", "ping")] }),
    answer({ content: "pong from beta" }),
    answer({ content: "beta says: pong from beta" }),
  ];
  const f = (async (_u: string, init: { body: string }) => { asked.push(JSON.parse(init.body)); return script.shift() ?? new Response("no more", { status: 500 }); }) as unknown as typeof fetch;
  const w = ephemeralWallet(inferKey);
  const peer = new InferPeer({
    wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1" } }, fetch: f, log: (l) => h.lines.push(`[infer] ${l}`),
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => new RawBox(w, url),
      // Its address book (#40), configured by its admin: every agent's key at its origin.
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); },
    },
  });

  const sent = await new RawBox(h.owner, `${h.base}/@alpha`).send(alpha, "chat", { text: "ask beta" });
  const mine = new RawBox(h.owner, `${h.base}/@david`);
  const final = await until("alpha's answer", async () => {
    await peer.poll();
    return (await mine.list("chat")).find((m) => (m.value as { text?: string }).text?.startsWith("beta says"));
  }, 60_000);
  assert.equal(final.sender, alpha);
  assert.ok((final.value as { replyTo: CID }).replyTo.equals(sent.id), "the answer replies to the owner's chat");
  assert.equal(asked.length, 3, "three inferences: alpha's, beta's, alpha's again");
  const toolTurn = (asked[2]!.messages as Json[]).find((m) => m.role === "tool") as { content: string };
  assert.equal(toolTurn.content, "pong from beta", "beta's answer is the message tool's result");

  // The address book (the owner's, #87) and the resolve program's records (`resolve/peers`, its own):
  // what each instance's admin and its own resolve wrote, nothing from the host's rows.
  const tableOf = async (handle: string, head: string) => {
    const k = (await h.router.hydrate(handle)).kernel;
    const root = await k.call("head", head) as CID | null;
    if (!root) return [];
    const t = await k.store.get(root) as unknown as { peers: Array<{ peer: CID }> };
    const all = await Promise.all(t.peers.map(async (p) => await k.store.get(p.peer) as unknown as { kind: string; key: Uint8Array; source: string; handle?: string }));
    return all.filter((p) => p.source !== "genesis"); // the genesis seeds the host's providers and the owner (#70)
  };
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const rows = (ps: Array<{ kind: string; key: Uint8Array; source: string }>) => ps.map((p) => [p.kind, hex(p.key), p.source]).sort();
  assert.deepEqual(rows(await tableOf("alpha", "peers")), [], "alpha: its address book has nothing its programs wrote (#87: resolve never writes it)");
  assert.deepEqual(rows(await tableOf("alpha", "resolve/peers")), [["resolution", beta, "resolve"], ["resolution", inferId, "resolve"]].sort(), "alpha: infer and beta in its resolve program's records");
  assert.deepEqual(rows(await tableOf("beta", "peers")), [["peer", alpha, "admin"]], "beta: alpha from the admin's `peers` message");
  assert.deepEqual(rows(await tableOf("beta", "resolve/peers")), [["resolution", inferId, "resolve"]], "beta: infer by its own resolve");
  assert.ok(!boxes.includes("register"), `no claim was ever sent (boxes delivered to: ${[...new Set(boxes)].join(", ")})`);
  assert.ok(boxes.includes("chat") && boxes.includes("infer") && boxes.includes("completions"));
});

test("the loop: a stranger (in no address book) chats an agent on its open box: admitted, inferred, and the answer fails once with \"no route\" (no retry; #87: in the delivery thread)", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId, genesis: { defaults: { sendRetryMs: "100" } } });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  const alpha = h.agent("alpha");
  await h.router.start();
  const boxes = watchBoxes(h);

  const asked: Json[] = [];
  const f = (async (_u: string, init: { body: string }) => { asked.push(JSON.parse(init.body)); return answer({ content: "hello, stranger" }); }) as unknown as typeof fetch;
  const w = ephemeralWallet(inferKey);
  const peer = new InferPeer({
    wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1" } }, fetch: f, log: (l) => h.lines.push(`[infer] ${l}`),
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => new RawBox(w, url),
      // Its address book (#40), configured by its admin: every agent's key at its origin.
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); },
    },
  });

  const strangerKey = PrivateKey.fromRandom(), stranger = strangerKey.toPublicKey().toString();
  await new RawBox(ephemeralWallet(strangerKey), `${h.base}/@alpha`).send(alpha, "chat", { text: "hi" });
  const noRoute = () => h.lines.filter((l) => l.startsWith("[alpha] ") && l.includes("no route"));
  await until("alpha's undeliverable answer", async () => { await peer.poll(); return noRoute().length ? true : undefined; }, 60_000);
  // Some time for a retry storm to show, if there were one.
  for (let i = 0; i < 10; i++) { await peer.poll(); await h.router.settled(); await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(asked.length, 1, "the stranger's chat was admitted and inferred on, once");
  // #87: the emit goes to the delivery thread (a key the address book does not name may be one the
  // resolve program recorded); it finds no record and errors once, and the loop is told so, once.
  const lines = noRoute();
  const delivery = lines.filter((l) => / messagebox step \d+ → errored/.test(l)), loop = lines.filter((l) => l.includes("could not deliver the answer"));
  assert.equal(delivery.length, 1, `the delivery errored once (no retry):\n${lines.join("\n")}`);
  assert.equal(loop.length, 1, `logged once by the loop:\n${lines.join("\n")}`);
  assert.equal(lines.length, 2, `nothing else:\n${lines.join("\n")}`);
  assert.match(loop[0]!, new RegExp(`could not deliver the answer: .*no route to ${stranger}: not in the address book, and not resolved`));
  assert.equal(boxes.filter((b) => b === "chat").length, 1, "the only chat delivered is the stranger's own: no answer went out");
  assert.equal((await new RawBox(h.owner, `${h.base}/@david`).list("chat")).length, 0, "nothing reached the owner");
});

test("the loop: a `message` whose delivery fails transiently is tried again on a deadline (two 503s, then delivered); a permanent failure is an error result at once", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId, genesis: { defaults: { sendRetryMs: "300" } } });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  const alpha = h.agent("alpha");
  h.agent("beta");
  await h.router.start();

  // alpha in beta's address book (the admin's), so beta can answer it.
  await new RawBox(h.owner, `${h.base}/@beta`).send(h.db.get("beta")!.identity!, "peers", { op: "add", key: alpha, url: h.origin("alpha") });
  // beta's messagebox as a flaky remote: of the chats sent to it, the first two answer 503, the fourth 400.
  const statuses: number[] = [];
  const dispatch = h.router.dispatch.bind(h.router);
  h.router.dispatch = async (req) => {
    const chat = req.method === "POST" && req.url === `${h.origin("beta")}/sendMessage` && (() => { try { return (dagCbor.decode(req.body) as { message?: { messageBox?: string } }).message?.messageBox === "chat"; } catch { return false; } })();
    if (chat) {
      const n = statuses.length;
      if (n < 2 || n === 3) {
        const status = n < 2 ? 503 : 400;
        statuses.push(status);
        return { status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ status: "error", description: n < 2 ? "down for a moment" : "no" })) };
      }
      const r = await dispatch(req);
      statuses.push(r.status);
      return r;
    }
    return await dispatch(req);
  };

  const asked: Json[] = [];
  const script = [
    answer({ content: "", tool_calls: [messageCall("c1", "@beta@localhost", "ping")] }),
    answer({ content: "pong from beta" }),
    answer({ content: "", tool_calls: [messageCall("c2", "@beta@localhost", "again")] }),
    answer({ content: "done" }),
  ];
  const f = (async (_u: string, init: { body: string }) => { asked.push(JSON.parse(init.body)); return script.shift() ?? new Response("no more", { status: 500 }); }) as unknown as typeof fetch;
  const w = ephemeralWallet(inferKey);
  const peer = new InferPeer({
    wallet: w, providers: { ripper: { baseUrl: "http://ripper.test/v1" } }, fetch: f, log: (l) => h.lines.push(`[infer] ${l}`),
    raw: {
      inbox: new RawBox(w, `${h.base}/@infer`),
      outbox: (url) => new RawBox(w, url),
      // Its address book (#40), configured by its admin: every agent's key at its origin.
      addressOf: (k) => { const r = h.db.list().find((x) => x.identity === k && x.kind !== "mailbox"); return r && h.origin(r.handle); },
    },
  });

  await new RawBox(h.owner, `${h.base}/@alpha`).send(alpha, "chat", { text: "ask beta twice" });
  const mine = new RawBox(h.owner, `${h.base}/@david`);
  const final = await until("alpha's answer", async () => {
    await peer.poll();
    return (await mine.list("chat")).find((m) => (m.value as { text?: string }).text === "done");
  }, 60_000);
  assert.equal(final.sender, alpha);
  assert.ok(h.lines.some((l) => l.startsWith("[alpha] deliver chat for ") && l.endsWith(`→ ${h.origin("beta")}/sendMessage (local): HTTP 503 down for a moment`)), "a failed delivery's log line says why");
  assert.deepEqual(statuses, [503, 503, 200, 400], "c1: two transient failures, then delivered on the third attempt; c2: one permanent failure, no retry");
  const tools = (i: number) => (asked[i]!.messages as Json[]).filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(tools(2).at(-1)!.content, "pong from beta", "the retried message's result is beta's reply");
  const c2 = tools(3).at(-1)!.content;
  assert.match(c2, /could not deliver to @beta@localhost/);
  assert.match(c2, /HTTP 400/);
  assert.doesNotMatch(c2, /attempts/, "a permanent failure is not retried");
});
