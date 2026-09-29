// The loop over #40's delivery, end to end with the real Zig kernel: a chat
// to alpha; alpha's `infer` goes over http to the inference peer's mailbox
// instance (its peer record from its own resolve, first contact); the peer
// learns where alpha is from alpha's claim and answers into alpha's
// `completions`; the model calls `message` to @beta@localhost — alpha resolves
// beta, delivers the chat to beta's front door in process (no socket), beta's
// loop answers alpha (beta knows alpha from alpha's claim, checked by a
// resolve); alpha's turn ends with its answer in the owner's mailbox. The
// peer tables hold only what the instances' own programs wrote.

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
      resolve: async (handle, domain) => {
        const r = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=${handle}@${domain}`);
        return await r.json() as { identityKey: string; messagebox: string };
      },
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

  // The peer tables: what each instance's own programs wrote, nothing from the host's rows.
  const peersOf = async (handle: string) => {
    const k = (await h.router.hydrate(handle)).kernel;
    const root = await k.call("head", "peers") as CID | null;
    if (!root) return [];
    const t = await k.store.get(root) as unknown as { peers: Array<{ peer: CID }> };
    return await Promise.all(t.peers.map(async (p) => await k.store.get(p.peer) as unknown as { key: Uint8Array; source: string; handle?: string }));
  };
  const ap = await peersOf("alpha"), bp = await peersOf("beta");
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  assert.deepEqual(ap.map((p) => [hex(p.key), p.source]).sort(), [[beta, "claim"], [inferId, "resolve"]].sort(), "alpha: infer by its own resolve; beta resolved first, then beta's claim (checked by a resolve) replaced it");
  assert.deepEqual(bp.map((p) => [hex(p.key), p.source]).sort(), [[alpha, "claim"], [inferId, "resolve"]].sort(), "beta: alpha from alpha's claim (checked by a resolve), infer by its own resolve");
  assert.equal(peer.peers.get(alpha), h.origin("alpha"), "the inference peer learned alpha's messagebox from alpha's claim");
});

test("the loop: a `message` whose delivery fails transiently is tried again on a deadline (two 503s, then delivered); a permanent failure is an error result at once", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const inferKey = PrivateKey.fromRandom(), inferId = inferKey.toPublicKey().toString();
  const h = await testHost(t, { infer: inferId, genesis: { defaults: { sendRetryMs: "300" } } });
  h.mailbox("david", h.ownerId);
  h.mailbox("infer", inferId);
  const alpha = h.agent("alpha");
  h.agent("beta");
  await h.router.start();

  // beta's messagebox as a flaky remote: of the chats sent to it (not the claims), the first two answer 503, the fourth 400.
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
      resolve: async (handle, domain) => {
        const r = await fetch(`${h.base}/.well-known/metanet-handles/resolve?handle=${handle}@${domain}`);
        return await r.json() as { identityKey: string; messagebox: string };
      },
    },
  });

  await new RawBox(h.owner, `${h.base}/@alpha`).send(alpha, "chat", { text: "ask beta twice" });
  const mine = new RawBox(h.owner, `${h.base}/@david`);
  const final = await until("alpha's answer", async () => {
    await peer.poll();
    return (await mine.list("chat")).find((m) => (m.value as { text?: string }).text === "done");
  }, 60_000);
  assert.equal(final.sender, alpha);
  assert.deepEqual(statuses, [503, 503, 200, 400], "c1: two transient failures, then delivered on the third attempt; c2: one permanent failure, no retry");
  const tools = (i: number) => (asked[i]!.messages as Json[]).filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(tools(2).at(-1)!.content, "pong from beta", "the retried message's result is beta's reply");
  const c2 = tools(3).at(-1)!.content;
  assert.match(c2, /could not deliver to @beta@localhost/);
  assert.match(c2, /HTTP 400/);
  assert.doesNotMatch(c2, /attempts/, "a permanent failure is not retried");
});
