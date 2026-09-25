# The client (`bin/skein`)

David's side: it signs through his wallet-api and talks only to the messagebox
(host setup: scripts/host/README.md). Every message is a BRC-169 envelope with a
dag-cbor body. State lives in `~/.skein/client/`: `sent.jsonl` (every envelope
sent) and `conversation.json` (the last `say` received).

```
skein whoami
skein import <dir>                                   # tree objects -> box objects; prints the tree CID
skein run --tree <cid> [--cwd p] [--env K=V]... -- '<cmd>'
skein inbox [--wait] [--timeout s] [--no-ack] [--json]
skein chat "<text>" [--tree <cid>] [--model ripper/qwen38] [--new] [--wait] [--timeout s]
skein talk [--tree <cid>] [--model m] [--new] [--timeout s]
```

## Chat

| box | direction | body |
|---|---|---|
| `chat` | david → instance | `{ text, tree?: CID, model?: string, replyTo?: CID }` |
| `say` | instance → david | `{ text, page?: markdown, tree?: CID, thread: CID, replyTo: CID }` (replyTo = the chat it answers) |
| `results` | instance → david | `{ exitCode, stdout, stderr, tree, replyTo }` (answers a `run`) |

- `chat` continues the conversation: `replyTo` = the CID of the last `say`
  envelope in `conversation.json`, and `--tree` defaults to that say's `tree`.
  `--new` (or no conversation yet) sends no `replyTo` and no default tree.
- `chat --wait` polls (1 s) until the `say` answering it arrives, then prints it.
- `inbox` reads `results` then `say`, prints them, acknowledges, and records the
  newest verified `say` in `conversation.json`. A `say` prints as its text, the
  page as plain markdown, then `[tree … thread …]` as short CIDs.
  `--wait` stops at the `say` answering the last `chat` sent, or the result
  answering the last `run`. `--timeout` defaults to 120 s.
- `talk` is a REPL: each line is a `chat` (chained by replyTo), then it waits
  for the `say`. `/new` starts a new conversation, `/tree <cid>` sets the tree
  for the next message (after that the say's tree carries on), `/quit` exits.
