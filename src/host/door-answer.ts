// What the kernel's door answers without writing an entry (#143): a filter's rejection or answer
// (a read route's), or the gate's refusal — the `admit` frame's `{answered: {…}}`. No node APIs: the
// node host (kernel.ts) and the browser host (web/kernel/host.ts) both read it.

/**
 * What the kernel's door answered without writing an entry (#143): a filter's rejection or answer
 * (a read route's), or the gate's refusal. `admit` throws it: the request was never admitted.
 */
export interface DoorAnswer {
  kind: "reject" | "answer";
  status: number;
  code?: string;
  reason?: string;
  type?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Who the filters said it was from, if they got that far (the host's meter). */
  principal?: Uint8Array;
  /** The filters' fuel (an app's filter runs as a call): the host's meter. */
  fuel: number;
}

/** A request the kernel's door turned away or answered (#143): nothing was written. */
export class DoorAnswered extends Error {
  readonly answer: DoorAnswer;
  constructor(answer: DoorAnswer) {
    super(`${answer.kind === "answer" ? "answered" : "turned away"} at the door: ${answer.status}${answer.reason ? ` ${answer.reason}` : ""}`);
    this.answer = answer;
  }
}

/** The kernel's `answered` frame as a DoorAnswer (absent fields left out). */
export function doorAnswer(x: Record<string, unknown>): DoorAnswer {
  return {
    kind: x.kind === "answer" ? "answer" : "reject", status: Number(x.status ?? 500), fuel: Number(x.fuel ?? 0),
    ...(typeof x.code === "string" ? { code: x.code } : {}), ...(typeof x.reason === "string" ? { reason: x.reason } : {}),
    ...(typeof x.type === "string" ? { type: x.type } : {}),
    ...(x.headers && typeof x.headers === "object" ? { headers: x.headers as Record<string, string> } : {}),
    ...(x.body instanceof Uint8Array ? { body: x.body } : {}), ...(x.principal instanceof Uint8Array ? { principal: x.principal } : {}),
  };
}

