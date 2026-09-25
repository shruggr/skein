// Block shapes. Every value here is encoded as dag-cbor and identified by its
// CIDv1 (codec dag-cbor 0x71, multihash sha2-256 0x12). See docs/VM.md
// (docs/MODEL.md for the v1 shapes some fields are kept from).
//
// CIDs are carried as multiformats `CID` instances inside blocks (dag-cbor
// tag 42) and as base32 strings (`bafy…`) everywhere a string is needed:
// the CLI, the index tables, URLs (`skein://bafy…`).

import type { CID } from "multiformats/cid";

export type Ms = number; // milliseconds since the epoch, UTC

// ---------------------------------------------------------------- refs

export type Rel =
  | "depends-on" // scheduler semantics: the holder waits on `to`
  | "launched"   // this node launched thread `to`
  | "produced"   // this node produced asset `to`
  | "about"      // free correlation: repo, commit, topic, prior thread
  | "replies-to" // a reply message → the request message (or thread) it answers
  | "from-thread" // an emitted message → the thread whose step emitted it
  | (string & {}); // producers may add their own; retrieval tolerates unknown rels

export interface Ref {
  to: CID | string; // a block, or a URL in another world ("git-raw:…", "file:…")
  rel: Rel;
  locator?: string; // where inside `to`: "#L10-20", a DOM path, an output index
}

// ---------------------------------------------------------------- threads

export type RunnerKind = "model" | "shell" | "loop" | "david" | (string & {});

export type ThreadState =
  | "running"
  | "waiting"        // on threads (waitingOn) and/or a time (until)
  | "finished"
  | "errored"
  | "out-of-context"
  | "dropped";

export interface ThreadOrigin {
  kind: "thread";
  program?: CID;      // the program record to run (docs/VM.md); absent only on v1 threads
  args?: unknown;     // the program's input, per its `inputs` schema
  launchedBy?: CID;   // the node (step) or message that launched it; absent only on v1 threads
  at: Ms;
  nonce?: string;     // distinguishes otherwise identical launches (a tool call id)
  runner?: RunnerKind; // v1 only: kept so old files still read
  spec?: unknown;      // v1 only
}

export interface ThreadUpdate {
  origin: CID;
  prev: CID;          // previous update, or the origin for seq 1
  seq: number;
  at: Ms;
  state: ThreadState;
  waitingOn?: CID[];  // thread origins
  waitingFrom?: string; // an identity (pubkey hex): woken by a message from it
  until?: Ms;         // wake time (nudges, retries, David)
  resolution?: CID;   // node holding the result, when finished
  error?: { kind: "cant-do" | "blew-up"; message: string };
  note?: string;      // free text a program attaches ("ripper/qwen38 · 812 in / 40 out")
  head?: CID;         // the thread's latest node *update* as of this update: how a program, which
                      // can only `get`, finds its own nodes' emissions (walk prev back to the origin)
}

// ---------------------------------------------------------------- nodes

export type Emission =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "say"; text: string; call?: string }         // call: the model's tool call id, when one produced it
  | { type: "page"; markdown: string; call?: string }    // or `to: CID` for a stored page block
  | { type: "launched"; thread: CID; label?: string; call?: string } // a tool call, model call, question
  | { type: "tool_result"; thread: CID; ok: boolean; content: string; call?: string }
  | { type: "conclusion"; text: string; exitCode?: number }
  | { type: string; [k: string]: unknown };           // open for new kinds

export interface Rest {
  state: ThreadState;  // the node's own stop shape; usually mirrors its thread
  waitingOn?: CID[];
}

export interface NodeOrigin {
  kind: "node";
  thread: CID;         // thread origin
  prev: CID[];         // previous node(s) in the thread; [] for the first
  request: unknown;    // prompt, tool arguments, model-call input
  refs: Ref[];
  at: Ms;
  nonce?: string;      // distinguishes otherwise identical nodes
}

export interface NodeUpdate {
  origin: CID;
  prev: CID;
  seq: number;
  at: Ms;
  emit?: Emission;
  rest?: Rest;
}

export type Origin = ThreadOrigin | NodeOrigin;
export type Update = ThreadUpdate | NodeUpdate;
export type Block = Origin | Update | { kind: string; [k: string]: unknown };
