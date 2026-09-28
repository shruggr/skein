// The kernel proof page (issue #35; not easel, #16): a skein instance in this
// tab — the wasm kernel in a Worker over IndexedDB (host.ts) — whose identity
// is the connected wallet's, and a chat box that talks to it. Configured by
// the query string:
//
//   host         the skein host, the router (default http://127.0.0.1:8100): this identity's mailbox instance is registered there
//   handle       this instance's name there (default "me")
//   infer        the inference peer's identity (hex), inferHandle its handle@domain
//   key          tests only: a private key (hex) for a ProtoWallet instead of Yours
//
// window.skein is the host, for the tests (equiv/browser-live.ts).

import { connectWallet } from "@1sat/connect";
import { PrivateKey, ProtoWallet, WalletClient, type WalletInterface } from "@bsv/sdk";
import { BrowserHost } from "./host.ts";

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function line(text: string, cls = ""): void {
  const div = document.createElement("div");
  div.textContent = text;
  if (cls) div.className = cls;
  $("log").append(div);
  $("log").scrollTop = $("log").scrollHeight;
}

function say(who: string, text: string, cls: string): void {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = `${who}: ${text}`;
  $("chat").append(div);
}

async function wallet(): Promise<WalletInterface> {
  const key = q.get("key");
  if (key) return new ProtoWallet(PrivateKey.fromHex(key));
  let reason: unknown;
  const r = await connectWallet({
    autoDetect: false,
    providers: [{
      type: "brc100", name: "BRC-100 wallet",
      connect: async () => {
        try {
          const client = new WalletClient("auto");
          await client.connectToSubstrate();
          await client.waitForAuthentication({});
          const { publicKey } = await client.getPublicKey({ identityKey: true });
          return { wallet: client, provider: "brc100", identityKey: publicKey, disconnect: () => {} };
        } catch (e) { reason = e; throw e; }
      },
    }],
  });
  if (!r) throw new Error(`no wallet: ${reason instanceof Error ? reason.message : String(reason ?? "nothing answered")}`);
  return r.wallet as WalletInterface;
}

async function main(): Promise<void> {
  if (!crossOriginIsolated) { line("this page must be served cross-origin isolated (web/kernel/serve.ts)", "err"); return; }
  const [ih, id] = (q.get("inferHandle") ?? "infer@localhost").split("@");
  const host = new BrowserHost({
    wallet: await wallet(),
    host: q.get("host") ?? "http://127.0.0.1:8100",
    handle: q.get("handle") ?? "me",
    infer: q.get("infer") ?? undefined,
    inferHandle: { handle: ih!, domain: id ?? "localhost" },
    pollMs: Number(q.get("pollMs") ?? 1000),
    log: (l) => line(l),
    onMessage: (m) => say("instance", String((m.body as { text?: unknown }).text ?? JSON.stringify(m.body)), "in"),
  });
  (window as unknown as { skein: BrowserHost }).skein = host;
  await host.start();
  $("identity").textContent = host.identity;
  line("ready", "ok");
  $<HTMLFormElement>("form").onsubmit = async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("text");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    say("you", text, "out");
    try { await host.chat(text); } catch (err) { line(String((err as Error).message), "err"); }
  };
  (window as unknown as { ready: boolean }).ready = true;
}

main().catch((e) => { line(`failed: ${(e as Error).stack ?? e}`, "err"); (window as unknown as { failed: string }).failed = String(e); });
