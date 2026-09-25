// bash: one command, run by the execution service.
//   step 1 (never stepped): send {kind:"run"} to execution; wait for its reply.
//   step 2 (the reply): a node with the output; conclusion {exitCode, tree};
//          finished with that node as the resolution (errored if the service failed).

import type { CID } from "multiformats/cid";
import type { ProgramImpl } from "../program.ts";
import type { ThreadOrigin } from "../types.ts";
import { cidOf, compact, isObj, isUpdate, NOTHING, Out, serviceIdentity } from "./sdk.ts";

export interface BashArgs { cmd: string; tree?: CID; cwd?: string; timeoutMs?: number }

/** What execution replies to a run. */
export interface Ran {
  kind: "ran";
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated?: { stdout?: number; stderr?: number }; // bytes dropped
  tree?: CID;
  error?: string; // timeout, spawn failure: the command didn't answer
  ms: number;
}

export const bash: ProgramImpl = {
  async step({ thread, tip, message }, { get, wallet }) {
    const out = new Out();
    const exec = await serviceIdentity(wallet, "execution");
    const args = ((await get<ThreadOrigin>(thread)).args ?? {}) as BashArgs;

    if (!isUpdate(tip)) {
      if (typeof args.cmd !== "string" || !args.cmd) {
        out.add(thread, { state: "errored", error: { kind: "cant-do", message: "bash needs args.cmd" } });
        return out.done();
      }
      out.send(exec, compact({ kind: "run", cmd: args.cmd, tree: args.tree, cwd: args.cwd, timeoutMs: args.timeoutMs }));
      out.add(thread, { state: "waiting", waitingFrom: exec });
      return out.done();
    }

    if (!message || message.from !== exec || tip.state !== "waiting" || !isObj(message.body)) return NOTHING;
    const body = message.body;
    const node = out.open({ kind: "node", thread, prev: [], request: args, refs: [{ to: cidOf(message), rel: "about" }] });
    if (body.kind === "ran") {
      const r = body as unknown as Ran;
      if (r.stdout) out.add(node, { emit: { type: "text", text: r.stdout, stream: "stdout" } });
      if (r.stderr) out.add(node, { emit: { type: "text", text: r.stderr, stream: "stderr" } });
      const text = r.error ?? (r.signal ? `killed by ${r.signal}` : `exit ${r.exitCode}`);
      out.add(node, { emit: compact({ type: "conclusion", text, exitCode: r.exitCode ?? undefined, tree: r.tree, truncated: r.truncated }) });
      const state = r.error ? "errored" : "finished";
      const head = out.add(node, { rest: { state } });
      // Errored still points at the node: the output up to the timeout is worth reading.
      out.add(thread, compact({ state, resolution: node, head, note: r.error ? undefined : text, error: r.error ? { kind: "blew-up", message: r.error } : undefined }));
    } else {
      const err = isObj(body.error) ? body.error : { kind: "blew-up", message: `unexpected reply: ${String(body.kind)}` };
      const head = out.add(node, { rest: { state: "errored" } });
      out.add(thread, { state: "errored", error: { kind: err.kind === "cant-do" ? "cant-do" : "blew-up", message: String(err.message) }, head });
    }
    return out.done();
  },
};
