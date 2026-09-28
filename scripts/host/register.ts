// A mailbox instance for an identity outside the host (#40): the signed
// registration the router takes at POST /account/register {username,
// identityKey, signature} — signature by the identity's own wallet-api over
// "register <username>" (protocol [2, "skein register"], keyID the username,
// counterparty anyone). Prints the mailbox's URL; idempotent (409 = the name
// is taken, by this key or another).
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
const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
const { signature } = await wallet.createSignature({
  protocolID: [2, "skein register"], keyID: username, counterparty: "anyone", data: Utils.toArray(`register ${username}`, "utf8"),
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
