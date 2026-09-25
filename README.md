# skein

A content-addressed graph of threads, and the scheduler that wakes them.

Everything that does work is a thread: a shell command, one model call, a
subagent loop, a question to David. Every thread is an immutable origin block
plus a chain of state updates; every turn inside it is a node with typed
emissions. The only mutable state is a rebuildable tip index and transient
runner handles. See `docs/MODEL.md` for the model and `src/store.ts` for the
interface everything is built against.

Skein is the engine. `easel` (a sibling repo) is the first lens onto it, and
is not part of it.

```
npm install
npm run skein -- --help
npm test
```

Requires Node ≥ 22.5 (`node:sqlite`, `--experimental-strip-types`).
