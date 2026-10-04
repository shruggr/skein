// lib.js: the libraries the site's pages use, as one browser bundle (build.mjs).
// Nothing here but exports: the BRC-104 client and the install plan are
// skein's own code (src/client/raw.ts, src/host/plan.ts, at the commit in
// lib/SKEIN_REV), the wallet connection is @1sat/connect over @bsv/sdk's
// WalletClient, the codecs are @ipld's. The Inbox: @bsv/message-box-client
// lists a mailbox, @1sat/actions' syncMessages takes its payments in.

export { RawBox } from "skein/src/client/raw.ts";
export { chunk } from "skein/src/client/bundle.ts";
export { appHead, appRecordIn, describe, planInstall, planUninstall, readStoredApp, sendInstall, sendUninstall, wiring } from "skein/src/host/plan.ts";
export { dispatchOrigin, fold, rowKey, senderText } from "skein/src/runtime/dispatch.ts";
export { headOrigin } from "skein/src/runtime/heads.ts";
export { lookup, parseTree, readBlob, readTree } from "skein/src/runtime/tree.ts";
// @1sat/actions by file: its package entry re-exports every action (with
// their wallet and template dependencies, about 2 MB more); the Inbox uses one.
export { syncMessages } from "../node_modules/@1sat/actions/dist/sync/syncMessages.js";
export { createContext } from "../node_modules/@1sat/actions/dist/types.js";
export { connectWallet } from "@1sat/connect";
export { MessageBoxClient } from "@bsv/message-box-client";
export { LockingScript, PushDrop, Utils, WalletClient } from "@bsv/sdk";
export * as dagCbor from "@ipld/dag-cbor";
export * as dagJson from "@ipld/dag-json";
export { CID } from "multiformats/cid";
