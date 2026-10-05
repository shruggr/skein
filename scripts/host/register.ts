// A mailbox instance for an identity outside the host (#40, #113): the signed
// registration at POST /account/register {username, identityKey, signature},
// which the router carries into the host skein, where the onboarding app
// (shruggr/skein-onboard) checks it, asks the instance manager for the
// mailbox and the certifier for the handle certificate. The signature is by
// the identity's own wallet-api over "register <username>@<domain>"
// (protocol [2, "skein register"], keyID the username, counterparty anyone);
// the domain is the host's handle domain, read from /.well-known/skein-host.
// Prints the mailbox's URL; the same name again is a new certificate for the
// same mailbox (409: the name is another key's, or this key has another).
//   node scripts/host/register.ts <wallet-url> <originator> <username> [host-url]
import { HTTPWalletJSON, Utils } from "@bsv/sdk";

const [walletUrl, originator, username, host = "http://127.0.0.1:8100"] = process.argv.slice(2);
if (!walletUrl || !originator || !username) {
  console.error("usage: register.ts <wallet-url> <originator> <username> [host-url]");
  process.exit(2);
}
const wallet = new HTTPWalletJSON(originator, walletUrl, async (input, init) => {
  const res = await fetch(input, init);
  if (!res.ok) { const t = await res.clone().text(); if (t.includes("permission denied")) throw new Error(t); }
  return res;
});
const { domain } = await (await fetch(`${host}/.well-known/skein-host`)).json() as { domain: string };
const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
const { signature } = await wallet.createSignature({
  protocolID: [2, "skein register"], keyID: username, counterparty: "anyone", data: Utils.toArray(`register ${username}@${domain}`, "utf8"),
});
const res = await fetch(`${host}/account/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, identityKey, signature: Utils.toHex(signature) }),
});
const text = await res.text();
if (res.status === 200) console.log(JSON.parse(text).messagebox);
else if (res.status === 409) { console.error(`${username}: ${JSON.parse(text).error}`); process.exit(3); }
else { console.error(`register ${username}: HTTP ${res.status} ${text}`); process.exit(1); }
