// lib.js: the libraries the site's pages use, as one browser bundle (build.mjs).
// Nothing here but exports: the BRC-104 client and the install plan are
// skein's own code (src/client/raw.ts, src/host/plan.ts, at the commit in
// lib/SKEIN_REV), the wallet connection is @1sat/connect over @bsv/sdk's
// WalletClient, the codecs are @ipld's. The Inbox: @bsv/message-box-client
// lists a mailbox, @1sat/actions' syncMetanetInbox takes its payments in.
// Handles (#103): @bsv/sdk's Certificate and MasterCertificate check and
// read the handle certificates the wallet keeps. Profiles (#104): the OpNS
// profile codec (@1sat/utils encodeProfile/decodeProfile), an outpoint's 36
// bytes (@1sat/templates), its `txid_vout` form (@1sat/types), a record's
// CID (skein's src/runtime/cid.ts), @bsv/sdk's ProtoWallet to verify a
// profile's signature.

export { RawBox } from "skein/src/client/raw.ts";
export { chunk } from "skein/src/client/bundle.ts";
export { appHead, appRecordIn, describe, planInstall, planUninstall, readStoredApp, sendInstall, sendUninstall, wiring } from "skein/src/host/plan.ts";
export { dispatchOrigin, fold, rowKey, senderText } from "skein/src/runtime/dispatch.ts";
export { headOrigin } from "skein/src/runtime/heads.ts";
export { lookup, parseTree, readBlob, readTree } from "skein/src/runtime/tree.ts";
export { encode as encodeBlock } from "skein/src/runtime/cid.ts";
// @1sat/actions by file: its package entry re-exports every action (with
// their wallet and template dependencies, about 2 MB more); the Inbox uses one.
export { syncMetanetInbox } from "../node_modules/@1sat/actions/dist/metanet/receive.js";
export { createContext } from "../node_modules/@1sat/actions/dist/types.js";
// The profile codec and the outpoint helpers by file, for the same reason.
export { decodeProfile, encodeProfile } from "../node_modules/@1sat/utils/dist/fields.js";
export { outpointFromBytes, outpointToBytes } from "../node_modules/@1sat/templates/dist/shrug/metadata.js";
export { formatOrdinalOutpoint } from "../node_modules/@1sat/types/dist/ordinalTags.js";
export { connectWallet } from "@1sat/connect";
export { MessageBoxClient } from "@bsv/message-box-client";
export { Certificate, Hash, LockingScript, MasterCertificate, ProtoWallet, PushDrop, Utils, WalletClient } from "@bsv/sdk";
export * as dagCbor from "@ipld/dag-cbor";
export * as dagJson from "@ipld/dag-json";
export { CID } from "multiformats/cid";
