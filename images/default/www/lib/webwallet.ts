// webwallet.js: a BRC-100 wallet in the tab over a private key
// (@1sat/wallet-browser's createWebWallet, over IndexedDB) — the site's test
// mode (`?key=`), loaded only then. In use, the wallet is the user's own
// (Yours, or any BRC-100 wallet the browser reaches).

export { createWebWallet } from "@1sat/wallet-browser";
export { PrivateKey } from "@bsv/sdk";
