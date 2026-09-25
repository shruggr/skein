# skein

A content-addressed graph of threads, and the scheduler that wakes them.

Everything that does work is a thread: a shell command, one model call, a
subagent loop, a question to David. Every thread is an immutable origin block
plus a chain of state updates; every turn inside it is a node with typed
emissions. The only mutable state is a rebuildable tip index and transient
runner handles. See `docs/MODEL.md` for the model and `src/store.ts` for the
interface everything is built against.
Files live in the same store as git objects (`src/tree.ts`): a directory's
tree CID is CIDv1(git-raw, sha1) over git's own tree object, so it carries the
same id `git write-tree` prints.

Skein is the engine. `easel` (a sibling repo) is the first lens onto it, and
is not part of it.

```
npm install
npm run skein -- --help
npm test
```

Requires Node ≥ 24 (`node:sqlite`, type stripping, `import.meta.main`).

## Running it

Models are configured in `~/.skein/config.json` (copy `docs/config.example.json`).
The graph lives in `~/.skein/skein.db` (override with `$SKEIN_DB`).

```
npm run skein -- run                 # the daemon: scheduler + runners + web UI
```

Then open **http://localhost:4322** — start a thread, watch it, reply to it,
and browse any block (`/b/<cid>`) with every CID a link. The daemon binds
127.0.0.1 only; the UI starts threads that run bash, so widen `--host` only
onto a network you trust. `--port` / `$SKEIN_PORT` changes the port; bash runs
in `$SKEIN_CWD` (default `~`).

The CLI works with or without the daemon (reads never need it; writes poke it
via `POST /wake`, else its 1 s timer picks them up):

```
skein new "Run uname -a and tell me what machine this is" --watch
skein ls [--all] [--state waiting] [--runner shell]
skein show <cid> [--thinking]        # a thread, a node, or any block as JSON
skein reply <cid> "thanks, now list ~/Work" [--watch]
skein watch <cid> [--replay]
skein refs <cid>
skein rebuild                        # rebuild the index from the blocks
```

(`skein` = `npm run -s skein --`.) A `<cid>` is a whole CID or a prefix of a
thread/node origin: the 12 characters `ls` and the daemon log print, with or
without `bafy`. `reply` takes the loop or the david thread it waits on.

JSON API: `GET /api/threads`, `GET /api/thread/:cid[?since=version]`,
`GET /api/block/:cid`, `POST /api/new {prompt, model?, thinking?, tools?, system?}`,
`POST /api/reply {thread, text}`, `POST /api/wake {thread?}`.
