# The client (`bin/skein`)

David's side: it signs through his wallet-api and speaks raw BRC-33 on a
BRC-104 session (#40; src/client/raw.ts). It sends to the instance's own front
door — the instance is an HTTP server, at `SKEIN_INSTANCE_URL` (default
`$SKEIN_HOST_URL/@<handle>`, or its host name `http://<handle>.localhost:8100`)
— and reads David's boxes from his mailbox: the mailbox instance his instances
deliver to (`skein-host add david --mailbox --owner <his key>`; the client finds
it at `SKEIN_MAILBOX_URL`, `~/.skein/mailbox.url`, else `$SKEIN_HOST_URL/@david`).
Bodies are dag-cbor (an `application/cbor` request, BRC-231). There is no
envelope: the session proves who sends, and a message's id is the CID of its
record, which the sender and the recipient compute alike — what a reply's
`replyTo` names. State lives in `~/.skein/client/`: `sent.jsonl` (every message
sent, with its id) and `conversation.json` (the instance's last `chat` reply
received). `import` names the root tree on its last bundle; the instance makes it
`main` if it has none.

```
skein whoami
skein import <dir>                                   # tree objects -> the kernel's objects operation; prints the tree CID
skein run [--tree <cid>] [--cwd p] [--env K=V]... -- '<cmd>'   # no --tree: the instance's `main` head
skein head <name> <cid>                              # the kernel's head operation: "<name> is now <cid>"
skein dispatch add|remove [--sender <key>] <box> <handler>    # the kernel's dispatch operation: a mailbox row; handler: a program record CID (`skein plan dispatch` also takes a name the genesis gives)
skein inbox [--wait] [--timeout s] [--no-ack] [--json]
skein chat "<text>" [--tree <cid>] [--model ripper/qwen38] [--new] [--wait] [--timeout s]
skein talk [--tree <cid>] [--model m] [--new] [--timeout s]
skein plan install|uninstall|dispatch|peers|deploy …  # the owner's admin messages as /sendMessage JSON files (no wallet: admin.ts)
skein send <origin> <dir>                            # those files, in order, by the wallet's BRC-104 client (`1sat authfetch`)
```

`plan` and `send` (#124, src/client/admin-cli.ts, admin.ts) need no wallet
of the client's own: the plan reads the instance through its explorer with
the owner's wallet (`--origin`, `1sat authfetch GET`) or from its store file
(`--store`), and writes the prompt and one `/sendMessage` body per message;
any BRC-100 wallet sends them (scripts/host/README.md, "The owner's
messages").

## Chat

| box | direction | body |
|---|---|---|
| `chat` | david → instance | `{ text, tree?: CID, model?: string, replyTo?: CID }` |
| `chat` | instance → david | `{ text, page?: markdown, tree?: CID, thread?: CID, replyTo: CID }` — a reply (replyTo = the id of the message it answers); the answer at the end of a turn names tree and thread |
| `results` | instance → david | `{ exitCode, stdout, stderr, tree, replyTo }` (answers a `run`) |
| `head` | owner → instance | `{ name, tree: CID }`: the kernel's `head` operation, moves the named head; no reply |
| `dispatch` | owner → instance | `{ op: "add" \| "remove", row }`: the kernel's `dispatch` operation, adds or removes a row; no reply |

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
