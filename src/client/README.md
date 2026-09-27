# The client (`bin/skein`)

David's side: it signs through his wallet-api and talks only to the messagebox
(host setup: scripts/host/README.md). Every message is a BRC-169 envelope with a
dag-cbor body; the envelope's signed `contentHash` binds the body to David's
signature, and the BRC-78 content encryption is for the wire only. An
envelope's id (a `replyTo`) is the CID of its signed part, without `content`.
State lives in `~/.skein/client/`: `sent.jsonl` (every envelope sent) and
`conversation.json` (the instance's last `chat` reply received). `import` names the
root tree on its last bundle; the instance makes it `main` if it has none.

```
skein whoami
skein import <dir>                                   # tree objects -> box objects; prints the tree CID
skein run [--tree <cid>] [--cwd p] [--env K=V]... -- '<cmd>'   # no --tree: the instance's `main` head
skein head <name> <cid>                              # box head: "<name> is now <cid>"
skein subscribe add|remove [--sender <key>] <box> <handler>   # box subscribe; handler: a built-in name (loop, run-handler, …) or a program CID
skein inbox [--wait] [--timeout s] [--no-ack] [--json]
skein chat "<text>" [--tree <cid>] [--model ripper/qwen38] [--new] [--wait] [--timeout s]
skein talk [--tree <cid>] [--model m] [--new] [--timeout s]
```

## Chat

| box | direction | body |
|---|---|---|
| `chat` | david → instance | `{ text, tree?: CID, model?: string, replyTo?: CID }` |
| `chat` | instance → david | `{ text, page?: markdown, tree?: CID, thread?: CID, replyTo: CID }` — a reply (replyTo = the envelope it answers); the answer at the end of a turn names tree and thread |
| `results` | instance → david | `{ exitCode, stdout, stderr, tree, replyTo }` (answers a `run`) |
| `head` | david → instance | `{ name, tree: CID }` — moves the named head; no reply |
| `subscribe` | david → instance | `{ op: "add" \| "remove", sender?: identity, box, handler: CID }` — adds or removes the subscription (sender, box) → handler (no sender: anyone); no reply |

- `chat` continues the conversation: `replyTo` = the CID of the instance's
  last `chat` reply in `conversation.json`, and `--tree` defaults to its `tree`
  (a reply that names none keeps the one before).
  `--new` (or no conversation yet) sends no `replyTo` and no default tree: the
  instance starts the conversation from its `main` head.
- `chat --wait` polls (1 s) until the `chat` replying to it arrives, then prints it.
- `inbox` reads `results` then `chat`, prints them, acknowledges, and records the
  newest verified `chat` reply from the instance in `conversation.json` (a chat
  with no `replyTo`, or from anyone else, is shown only). A reply prints as its
  text, the page as plain markdown, then `[tree … thread …]` as short CIDs.
  `--wait` stops at the `chat` replying to the last `chat` sent, or the result
  answering the last `run`. `--timeout` defaults to 120 s.
- `talk` is a REPL: each line is a `chat` (chained by replyTo), then it waits
  for the reply. `/new` starts a new conversation, `/tree <cid>` sets the tree
  for the next message (after that the reply's tree carries on), `/quit` exits.
