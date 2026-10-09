// Paid routes (#149): kernel.pay, ts-stack's payment-express-middleware wire at the kernel's door,
// with the stock AuthFetch (which pays a 402 itself through its wallet's createAction) and the real
// Zig kernel. A priced route answers a request with no X-BSV-Payment 402 — the version, the price
// and the derivation prefix (a nonce over the skein's signer) in signed headers, ts-stack's body; the
// client's resend carries a BRC-29 payment, which passes with the `payment` block beside the
// principal, the BEEF behind its pointer record (no BEEF bytes in the logged request), and the
// wallet program internalizes it before the handler runs. The same payment again: 409 replayed. An
// underpayment: 400. A payment the wallet refuses (not to the skein's BRC-29 key): logged, the
// handler does not run. An unpriced route, or price 0: untouched. kernel.pay with no kernel.brc104
// before it: refused at install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthFetch, LockingScript, P2PKH, PrivateKey, Transaction, type WalletInterface } from "@bsv/sdk";
import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { encode } from "../runtime/cid.ts";
import { WALLET } from "../runtime/programs.ts";
import { msStamp } from "../runtime/syscalls.ts";
import { ephemeralWallet } from "../wallet.ts";
import { rawCid } from "./boot.ts";
import { appendRequest, frontDoorFetch, type FrontAnswer } from "./frontdoor.ts";
import { codeSystem, keyBytes, writeSystemGenesis, type Genesis2Config } from "./genesis.ts";
import { Kernel, KERNEL_BIN } from "./kernel.ts";
import { MESSAGE_KEY_ID, MESSAGE_PROTOCOL } from "./providers.ts";

const PROBE = new URL("../../kernel-zig/test/call/probe.wasm", import.meta.url);
const WALLET_WASM = new URL("../../wasm/wallet.wasm", import.meta.url);
const PRICE = 1000;

type Mode = "pay" | "short" | "elsewhere";

/** The client's wallet: its signer, and a createAction that pays from a coin of its own (a parent with no inputs). */
function payingWallet(key: PrivateKey, mode: () => Mode, paid: Array<{ txid: string }>): WalletInterface {
  const base = ephemeralWallet(key);
  const createAction = async (args: { outputs?: Array<{ satoshis: number; lockingScript: string }> }) => {
    const out = args.outputs![0]!;
    const m = mode();
    const sats = m === "short" ? out.satoshis - 1 : out.satoshis;
    const script = m === "elsewhere" ? new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()) : LockingScript.fromHex(out.lockingScript);
    const parent = new Transaction(1, [], [{ lockingScript: new P2PKH().lock(key.toPublicKey().toAddress()), satoshis: sats + 500 }], paid.length);
    const tx = new Transaction(1, [{ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key), sequence: 0xffffffff }], [{ lockingScript: script, satoshis: sats }], 0);
    await tx.sign();
    paid.push({ txid: tx.id("hex") });
    return { txid: tx.id("hex"), tx: tx.toAtomicBEEF() };
  };
  return new Proxy(base, {
    get(t, p) {
      if (p === "createAction") return createAction;
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

test("paid routes (#149): kernel.pay — 402 with ts-stack's headers; a payment passes with the block, the wallet internalizes it before the handler; replay, underpayment and a payment the wallet refuses; unpriced untouched; refused at install without kernel.brc104", { skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }, async (t) => {
  const home = await fs.mkdtemp(join(tmpdir(), "skein-pay-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const key = PrivateKey.fromRandom(), clientKey = PrivateKey.fromRandom();
  const identity = key.toPublicKey().toString(), client = clientKey.toPublicKey().toString();
  const lines: string[] = [];
  const k = new Kernel({ db: join(home, "runtime.db"), handle: "alpha", domain: "localhost", wallet: ephemeralWallet(key), env: { SKEIN_HOME: home }, log: (l) => lines.push(l) });
  t.after(() => k.stop());
  const probeWasm = readFileSync(PROBE), walletWasm = readFileSync(WALLET_WASM);
  await k.putBlock(rawCid(probeWasm), probeWasm);
  await k.putBlock(rawCid(walletWasm), walletWasm);
  const probe = await k.store.put({ kind: "program", name: "probe", code: { wasm: rawCid(probeWasm) }, inputs: {}, services: [], description: "the call probe" } as never) as CID;
  const wallet = await k.store.put(WALLET as never) as CID;
  const p = probe.toString();
  const cfg: Genesis2Config = {
    identity, root: [client], handle: "alpha", domain: "localhost",
    dispatch: [
      // The test manifest's one priced route.
      { transport: "http", address: "/paid", filters: ["kernel.brc104", "kernel.pay"], program: p, fn: "whoami", price: PRICE },
      { transport: "http", address: "/free", filters: ["kernel.brc104", "kernel.pay"], program: p, fn: "whoami" },
      { transport: "http", address: "/zero", filters: ["kernel.brc104", "kernel.pay"], program: p, fn: "whoami", price: 0 },
    ],
  };
  const programs = { ...(await k.call("programs") as Record<string, CID>), wallet };
  await writeSystemGenesis(k, cfg, codeSystem(cfg, programs));
  await k.start();
  await k.idle();

  const answers: FrontAnswer[] = [];
  const sentHeaders: string[] = [];
  const door: typeof fetch = (input, init) => {
    const x = new Headers(init?.headers).get("x-bsv-payment");
    if (x) sentHeaders.push(x);
    return frontDoorFetch(k, { now: () => msStamp(Date.now()), onAnswer: (a) => answers.push(a), waitMs: 3000 })(input, init);
  };
  let mode: Mode = "pay";
  const paid: Array<{ txid: string }> = [];
  const af = new AuthFetch(payingWallet(clientKey, () => mode, paid), undefined, undefined, undefined, {}, door);
  const entries = async () => (await k.store.get((await k.store.log.tip())!) as unknown as { n: number }).n;
  const admin = async (box: string, body: unknown) => {
    const bodyBytes = dagCbor.encode(body);
    const unsigned = { kind: "mail", op: "put", sender: keyBytes(client), recipient: keyBytes(identity), box, body: encode(dagCbor.decode(bodyBytes)).cid, nonce: Uint8Array.from(Buffer.from(PrivateKey.fromRandom().toHex().slice(0, 32), "hex")) };
    const { signature } = await ephemeralWallet(clientKey).createSignature({ protocolID: MESSAGE_PROTOCOL, keyID: MESSAGE_KEY_ID, counterparty: "anyone", data: [...dagCbor.encode(unsigned)] });
    await appendRequest(k, "local", { kind: "message", message: { ...unsigned, signature: Uint8Array.from(signature) }, body: bodyBytes });
    await k.idle();
  };
  const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  type Entry = { n: number; request: CID; door?: { principal?: Uint8Array; filters?: string[]; beefs?: CID[]; payment?: { satoshisPaid: number; txid: string; derivationPrefix: string; derivationSuffix: string; sender: Uint8Array } } };

  // A chain state for the BEEF's path (kernel.beef's: no headers, so a BEEF with no BUMP enters unproven) and the wallet's SPV.
  const state = await k.store.put({ kind: "chain-state", network: "main", maps: { headers: null } } as never);
  await admin("head", { name: "chain/state", tree: state });

  // Unpriced (no price, or 0): passed untouched — no payment block, no 402.
  for (const path of ["/free", "/zero"]) {
    answers.length = 0;
    const r = await af.fetch(`http://alpha.test${path}`, post);
    assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
    assert.equal(Buffer.from(await r.arrayBuffer()).toString("hex"), client);
    const e = await k.store.get(answers.at(-1)!.entry!) as unknown as Entry;
    assert.deepEqual(e.door!.filters, ["kernel.brc104", "kernel.pay"], `${path}: kernel.pay ran`);
    assert.equal(e.door!.payment, undefined, `${path}: no payment`);
  }

  // The challenge, as the wire has it: a priced route, no X-BSV-Payment — 402, signed, nothing written.
  answers.length = 0;
  const n0 = await entries();
  // A stock client that hands the 402 back instead of paying it (its handlePaymentAndRetry), to look at.
  const unpaid = new AuthFetch(ephemeralWallet(clientKey), undefined, undefined, undefined, {}, door);
  (unpaid as unknown as { handlePaymentAndRetry: (u: string, c: unknown, res: Response) => Promise<Response> }).handlePaymentAndRetry = async (_u, _c, res) => res;
  const challenge = await unpaid.fetch("http://alpha.test/paid", post);
  assert.equal(challenge.status, 402);
  assert.equal(challenge.headers.get("x-bsv-payment-version"), "1.0");
  assert.equal(challenge.headers.get("x-bsv-payment-satoshis-required"), String(PRICE));
  const prefix = challenge.headers.get("x-bsv-payment-derivation-prefix")!;
  assert.equal(Buffer.from(prefix, "base64").length, 48, "the prefix: ts-stack's createNonce, 48 bytes");
  assert.deepEqual(JSON.parse(await challenge.text()), { status: "error", code: "ERR_PAYMENT_REQUIRED", satoshisRequired: PRICE, description: "A BSV payment is required. Provide the X-BSV-Payment header." });
  const a402 = answers.at(-1)!;
  assert.ok(!a402.entry && a402.headers["x-bsv-auth-signature"], "answered at the door, signed on the session (AuthFetch verified it, x-bsv-payment-* signed), no entry");
  await k.idle();
  assert.equal(await entries(), n0 + 1, "the new client's handshake only: the 402 writes nothing");

  // The stock client pays it (AuthFetch: 402 → createAction → resend with X-BSV-Payment): admitted with the
  // payment block, the wallet internalizes it before the handler, which answers.
  answers.length = 0;
  const ok = await af.fetch("http://alpha.test/paid", post);
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString("hex"), client, "the handler ran: its caller the payer");
  assert.deepEqual(answers.map((a) => a.status), [402, 200]);
  const txid = paid.at(-1)!.txid;
  const e = await k.store.get(answers.at(-1)!.entry!) as unknown as Entry;
  const pay = e.door!.payment!;
  assert.deepEqual({ ...pay, sender: Buffer.from(pay.sender).toString("hex") }, { satoshisPaid: PRICE, txid, derivationPrefix: pay.derivationPrefix, derivationSuffix: pay.derivationSuffix, sender: client }, "the payment block beside the principal");
  assert.equal(Buffer.from(e.door!.principal!).toString("hex"), client);
  assert.equal(Buffer.from(pay.derivationPrefix, "base64").length, 48);
  assert.equal(e.door!.beefs?.length, 1, "the BEEF's pointer record");
  const req = await k.store.get(e.request) as unknown as { headers: Record<string, unknown> };
  const h = req.headers["x-bsv-payment"] as { kind: string; before: string; beef: CID; after: string };
  assert.equal(h.kind, "x-bsv-payment", "the logged header: its text around the pointer record");
  assert.ok(h.beef.equals(e.door!.beefs![0]!), "the header names the pointer record");
  assert.ok(!JSON.stringify(dagCbor.decode(dagCbor.encode(req))).includes("AQEBAQ"), "no Atomic BEEF (base64 01010101…) in the logged request");
  assert.equal(h.before + JSON.parse(lastHeader()).transaction + h.after, lastHeader(), "the header's text is the sent one with the transaction cut out (restored: door.zig restore)");
  const walletAt = lines.findIndex((l) => l.startsWith(`#${e.n} payment ${txid}: ${PRICE} sats → wallet`));
  const handlerAt = lines.findIndex((l) => l.startsWith(`#${e.n} http request`));
  assert.ok(walletAt >= 0 && handlerAt > walletAt, `the kernel launched the wallet's internalize, then the request's thread (${walletAt}, ${handlerAt})`);
  const ws = await k.call("head", "wallet/state") as CID | null;
  assert.ok(ws, "the wallet advanced its state");
  const wsr = await k.store.get(ws) as unknown as { kind: string; maps: { actions: CID | null; outputs: CID | null } };
  assert.ok(wsr.kind === "wallet-state" && wsr.maps.actions && wsr.maps.outputs, "the wallet holds the payment: an action and its output");

  // The same payment again (a replay): 409, nothing written.
  answers.length = 0;
  const n1 = await entries();
  const replay = await af.fetch("http://alpha.test/paid", { ...post, headers: { ...post.headers, "x-bsv-payment": lastHeader() } });
  assert.equal(replay.status, 409, await replay.clone().text());
  assert.deepEqual(JSON.parse(await replay.text()), { status: "error", code: "ERR_PAYMENT_REPLAYED", description: "This payment was already used." });
  await k.idle();
  assert.equal(await entries(), n1, "refused at the door: nothing written");

  // Underpaid: 400 ERR_INVALID_PAYMENT, nothing written.
  mode = "short";
  answers.length = 0;
  const short = await af.fetch("http://alpha.test/paid", post);
  assert.equal(short.status, 400);
  assert.deepEqual(JSON.parse(await short.text()), { status: "error", code: "ERR_INVALID_PAYMENT", description: "The payment transaction is invalid or does not cover the required amount." });
  await k.idle();
  assert.equal(await entries(), n1, "underpaid: nothing written");

  // A forged prefix: 400 ERR_INVALID_DERIVATION_PREFIX.
  mode = "pay";
  const forged = JSON.parse(lastHeader()) as Record<string, string>;
  forged.derivationPrefix = Buffer.alloc(48, 7).toString("base64");
  const bad = await af.fetch("http://alpha.test/paid", { ...post, headers: { ...post.headers, "x-bsv-payment": JSON.stringify(forged) } });
  assert.equal(bad.status, 400);
  assert.equal((JSON.parse(await bad.text()) as { code: string }).code, "ERR_INVALID_DERIVATION_PREFIX");

  // Paid to a key not the skein's BRC-29 one: the door passes it (the amount covers the price), the entry is
  // logged, the wallet refuses it, and the handler does not run.
  mode = "elsewhere";
  answers.length = 0;
  const n2 = await entries();
  // The stock client hears no answer (an unsigned 503 when the host stops waiting) and pays again, three times.
  await assert.rejects(af.fetch("http://alpha.test/paid", post), /failed after 3\/3 attempts/);
  await k.idle();
  const admitted = answers.filter((a) => a.entry);
  assert.equal(admitted.length, 3, "each payment admitted");
  assert.equal(await entries(), n2 + 3, "three entries");
  assert.equal(lines.filter((l) => /payment [0-9a-f]{64}: the wallet refused it; the handler does not run/.test(l)).length, 3, "the wallet's refusal, each on its thread's errored update");
  for (const a of admitted) {
    assert.equal(a.status, 503);
    assert.equal(a.thread, undefined, "no request thread: the handler did not run");
    const re = await k.store.get(a.entry!) as unknown as Entry;
    assert.ok(re.door!.payment, "it passed the door with its payment");
  }

  // Install: kernel.pay with no kernel.brc104 before it is refused (the table unchanged); after it, taken.
  const routes = async () => (await k.dispatch()).rows.map((r) => r.address);
  await admin("dispatch", { op: "add", row: { transport: "http", address: "/unsigned-pay", filters: ["kernel.pay"], program: probe, fn: "whoami", price: 5 } });
  assert.ok(!(await routes()).includes("/unsigned-pay"), "kernel.pay without kernel.brc104: refused");
  await admin("dispatch", { op: "add", row: { transport: "http", address: "/signed-pay", filters: ["kernel.brc104", "kernel.pay"], program: probe, fn: "whoami", price: 5 } });
  assert.ok((await routes()).includes("/signed-pay"), "after kernel.brc104: taken");

  function lastHeader(): string {
    const x = sentHeaders.at(-1);
    assert.ok(x, "the client sent a payment header");
    return x;
  }
});
