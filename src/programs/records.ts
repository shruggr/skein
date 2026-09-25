// The built-in Program records. Built once from constants, so their CIDs are
// stable across processes and replays; a program's identity is its record.

import { program, type Program } from "../records.ts";
import { cidOf } from "./sdk.ts";

export const BASH: Program = program({
  name: "bash",
  code: { ts: "bash" },
  description: "Run a shell command. Returns its stdout/stderr and exit code.",
  inputs: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "The command line, run with bash -c." },
      cwd: { type: "string", description: "Working directory, relative to the tree's root (or absolute when there is no tree)." },
      tree: { type: "string", format: "cid", description: "The git tree to run in; the caller fills this." },
    },
    required: ["cmd"],
  },
  services: ["execution"],
});

export const LOOP: Program = program({
  name: "loop",
  code: { ts: "loop" },
  description: "The turn loop: a model with tools, until it has something to say.",
  inputs: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The opening line (or `text`, when launched by a prompt message)." },
      system: { type: "string" },
      model: { type: "string", description: "provider/model; the inference service's default when absent." },
      thinking: { enum: ["off", "low", "medium", "high"] },
      tools: { type: "array", items: { format: "cid" }, description: "Program records offered as tools; default [bash]." },
      tree: { format: "cid", description: "The tree tools run in; each bash result's tree carries forward." },
    },
  },
  services: ["inference"],
});

export const BASH_CID = cidOf(BASH);
export const LOOP_CID = cidOf(LOOP);

export const PROGRAM_RECORDS: Program[] = [LOOP, BASH];
