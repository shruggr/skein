// What the kernel refused (skein next, SPEC.md section 4): a CHECK or COMMIT refusal — nothing was
// stored or logged. No node APIs: the node host (router.ts, door.ts) reads it, and Open Exchange
// imports `DoorAnswered` (its deploy feed tells a refusal from a failure).

/** A refusal by the kernel (CHECK or COMMIT): nothing was written. */
export interface DoorAnswer {
  kind: "reject";
  status: number;
  code?: string;
  reason?: string;
  /** Who the checks said it was from, if they got that far (the host's meter). */
  principal?: Uint8Array;
  /** The checks' fuel: the host's meter. */
  fuel: number;
}

/** An arrival the kernel refused (CHECK or COMMIT): nothing was written. */
export class DoorAnswered extends Error {
  readonly answer: DoorAnswer;
  constructor(answer: DoorAnswer) {
    super(`refused: ${answer.status}${answer.reason ? ` ${answer.reason}` : ""}`);
    this.answer = answer;
  }
}

/** A kernel refusal ({status, code?, reason, principal?, fuel}) as a DoorAnswer. */
export function doorAnswer(x: Record<string, unknown>): DoorAnswer {
  return {
    kind: "reject", status: Number(x.status ?? 500), fuel: Number(x.fuel ?? 0),
    ...(typeof x.code === "string" ? { code: x.code } : {}), ...(typeof x.reason === "string" ? { reason: x.reason } : {}),
    ...(x.principal instanceof Uint8Array ? { principal: x.principal } : {}),
  };
}
