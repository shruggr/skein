// Register an identity as an account on the skein host. `1sat serve` only
// stores messages for recipients holding an account (ERR_ACCOUNT_REQUIRED), so
// both the instance and the owner must register once. BRC-104 (AuthFetch)
// through the identity's own wallet-api; idempotent (409 = already registered).
//   node scripts/host/register.ts <wallet-url> <originator> <username> [host-url]
import { AuthFetch, HTTPWalletJSON } from "@bsv/sdk";

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
const res = await new AuthFetch(wallet).fetch(`${host}/account/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username }),
});
const text = await res.text();
if (res.status === 200) console.log(`registered ${username} on ${host}`);
else if (res.status === 409) console.log(`${username}: ${JSON.parse(text).error}`);
else { console.error(`register ${username}: HTTP ${res.status} ${text}`); process.exit(1); }
