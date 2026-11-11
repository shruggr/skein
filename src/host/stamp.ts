// 0.9.1: the wall-clock stamp on every line a long-running host (`skein-host run`, `open-exchange`) writes —
// put on at the process's one writer, so every source's lines carry it (the router's, the kernel's, the
// host's own). An ISO UTC prefix with milliseconds; a multi-line chunk (a stack trace) is stamped on each line.

/** `text` with `<ISO UTC> ` before each of its lines: `2026-11-11T10:22:33.123Z [router] …`. */
export function stampLines(text: string, at: Date = new Date()): string {
  const s = at.toISOString();
  return text.split("\n").map((l) => `${s} ${l}`).join("\n");
}

/** The process writer's line form: stamped when `run` (the long-running command), else as it is. */
export function lineWriter(run: boolean): (l: string) => string {
  return run ? (l) => stampLines(l) : (l) => l;
}
