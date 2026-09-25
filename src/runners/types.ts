// The runner contract. The scheduler knows nothing about what a runner does;
// it offers threads and applies the answers. See docs/MODEL.md.

import type { CID } from "multiformats/cid";
import type { Store } from "../store.ts";
import type { Emission, Ms, Rest, RunnerKind, ThreadState } from "../types.ts";

/** A runner's answer about one thread; applied as a thread update. */
export interface Status {
  state: ThreadState;
  waitingOn?: CID[];
  until?: Ms;
  resolution?: CID;
  error?: { kind: "cant-do" | "blew-up"; message: string };
  note?: string;
}

export interface LaunchSpec {
  runner: RunnerKind;
  spec: unknown;
  /** Extra fields for the `launched` emission on the launching node (label, call id…). */
  tag?: { label?: string; [k: string]: unknown };
}

export interface RunnerContext {
  store: Store;
  /** Monotonic ms: distinct per call so identical launches in one ms get distinct origins. */
  now(): Ms;
  /** Open a thread origin; if launchedBy is given, emit `launched` on that node. The scheduler picks it up. */
  launch(what: LaunchSpec, launchedBy?: CID): Promise<CID>;
  emit(node: CID, emission: Emission): Promise<CID>;
  rest(node: CID, rest: Rest): Promise<CID>;
  /** Append a thread update (deduped against the tip, logged, waiters woken on settle). */
  update(thread: CID, status: Status): Promise<void>;
  /** Ask the scheduler to look at a thread soon (e.g. a process exited). */
  wake(thread: CID): void;
  log(line: string): void;
}

export interface Runner {
  kind: RunnerKind;
  /**
   * Called for a thread with no updates yet, and again whenever a waiting
   * thread becomes ready (all waitingOn settled, or until passed). May refuse
   * (capacity) by returning without appending anything.
   */
  start(thread: CID, ctx: RunnerContext): Promise<void>;
  /** Called for a running thread: still going, at rest in which shape, or lost. Must not append thread updates itself. */
  check(thread: CID, ctx: RunnerContext): Promise<Status>;
}
