# The skein model

Skein is a content-addressed graph of threads and the scheduler that wakes them.
It is not an agent framework: a runner can be a model, a shell, a subagent loop,
or David. Agents are one thing that can be built on it.

This file states the model as agreed on 2026-09-24. The reasoning behind each
decision is in the design doc
(https://claude.ai/code/artifact/25e9f57d-b1b0-452c-a523-96429fb1c64e) and the
voice session it records. Where this file and that record disagree, this file
is what the code implements; raise the disagreement rather than silently
following either.

## Blocks

Everything durable is an immutable block: a dag-cbor map, identified by its
CIDv1 (dag-cbor codec, sha2-256). Blocks link to each other by CID. Nothing is
ever edited; change is expressed as new blocks.

Two block roles:

- **Origin**: written the moment something is requested. Its CID is the
  identity of the thing from then on.
- **Update**: a later event about an origin. Carries `origin`, `prev` (the
  previous update, or the origin for the first), and `seq` (1, 2, 3 …). This is
  the ORDFS origin/sequence shape: a pointer to an origin means "as it is now",
  a pointer to an update means "exactly this version".

A **chain** is an origin plus its updates. The **tip** is the latest update.
Tips are kept in a local index that is rebuildable from the blocks; it is not
part of the record.

Large content (a page, a log, an image) is its own block, or a `raw` block, or
an external thing reached through a resolver; the graph holds a reference to
it, never a copy.

## Threads

A thread is the unit the scheduler acts on. Its origin says what to run and who
launched it; its updates are its state changes.

```
thread origin  { kind: "thread", runner, spec, launchedBy?, at }
thread update  { origin, prev, seq, at, state, waitingOn?, until?, resolution?, error? }
```

- `runner` names the kind of thing that executes it: `model` (one inference
  call), `shell` (one process), `loop` (the harness turn loop — what a
  "session" or "subagent" is), `david` (a question or turn that David
  resolves). More runner kinds can be added; the scheduler never needs to know
  what they do.
- `spec` is what the runner needs: a prompt and model, a command line, a system
  prompt and tool set, a page and spoken line.
- `launchedBy` is the CID of the node (step) that launched it. A thread with no
  `launchedBy` is parent-less: what David starts by hand.
- `state` is the stop shape: `running`, `waiting` (on threads in `waitingOn`,
  or until a time in `until`), `finished`, `errored`, `out-of-context`,
  `dropped`. Finished and waiting differ only in whether something is expected
  to wake the thread; that is the only classification the scheduler needs.
  `errored` distinguishes can't-do (stable; retry changes nothing) from blew-up
  (the scheduler may retry) via `error.kind`.
- `resolution` on a finished thread points at the node that holds its result.

Everything that launches work launches a thread: a tool call, a model call, a
subagent, a question to David. There is no other mechanism. A thread waiting
on another thread points at it in `waitingOn`; when that thread comes to rest,
the scheduler wakes the waiter. Threads are flat; dependency edges are the only
structure, never containment.

Talking to David is launching a `david` thread. Its spec is what is put in
front of him (spoken line, page); its resolution is his reply and any
annotations. A nudge is a `david` thread whose wake trigger is `until`.

## Nodes and steps

A node is a request and everything that came back from it, together.

```
node origin  { kind: "node", thread, prev: CID[], request, refs, at }
node update  { origin, prev, seq, at, emit?: Emission, rest?: Rest }
```

- `thread` is the thread this node belongs to. `prev` is the node(s) before
  it in the thread; two means a merge. Every node carries all its own pointers;
  nothing is inferred from position, so forking is free.
- `request` is the payload that started it: the prompt, a tool's arguments.
- `refs` are pointers out: `{ to: CID | URL, rel, locator? }`. `rel` is
  whatever the producer knows (`depends-on`, `produced`, `about`, `launched`,
  …). Only `depends-on` has semantics the scheduler acts on; the rest are for
  retrieval, which is allowed to be imprecise. A locator (`#L10-20`, a DOM
  path) is data on the ref, resolved by whoever finally opens the thing.
- Emissions are typed: `thinking`, `text`, `say`, `page`, `launched` (a thread
  CID), `tool_result`, `conclusion`. They are written as they happen, one
  update each, so a crash loses nothing already produced. Consumers read the
  types they care about and ignore the rest.
- `rest` closes the node: `{ state, waitingOn? }` mirroring thread states.

A **step** is one node whose request is a model call's input (context plus the
previous step or David's prompt) and whose emissions are what the model
produced plus the threads it launched. A step that launches tools rests waiting
on them; the next step's request carries their results.

A **turn** is a run of steps that begins with David's prompt and ends with a
step that rests without launching anything, or with `say`/`page`. The turn
boundary is a span, not a block; lenses find it by walking back from a resting
step to the last `david`-resolved request.

Node text is the searchable content. There is no summary layer.

## The mutable layer

Only two things change in place, and both are derived or transient:

- **Tip index**: origin → latest update CID, plus enough metadata to narrow on
  (kind, thread, runner, state, timestamps). Rebuildable from the blocks.
- **Runner handles**: opaque per-thread bookkeeping a runner needs to find its
  work again (a PID and command line, an HTTP request id). Keyed by thread
  origin, overwritten freely, deleted when the thread comes to rest. A handle
  is never a fact; facts (which model answered, when, how many tokens) go into
  the chain.

The graph records what the harness launched and observed. It never mirrors the
machine: processes, files, and services live in systems that already know
their own state, and the graph reaches them through resolvers.

## Scheduler and runners

One scheduler, two triggers: an event (a thread came to rest) or the passage
of time (a `waiting` thread's `until` passed; a `running` thread should be
checked). Its worklist is every thread whose tip state is not `finished`.

For each such thread it asks that thread's runner one question — still going,
at rest in which shape, or lost — and applies the answer as a thread update.
Runners own state resolution and the judgement about relaunching; the
scheduler only reads. Capacity is the runner's view of its own limits: the
scheduler offers, the runner accepts or refuses, and a refused thread stays
where it is until the next pass. There is no queue.

Capabilities are declared on the tool (the thread spec's type), never acquired
mid-thread. A thread that needs more resolves `finished` with a conclusion of
"out of scope" and lets its caller decide.

## Addressing

Every block is addressable as `skein://<cid>`. Other worlds get their own
schemes with resolvers registered against them (git objects and Bitcoin
transactions are themselves CIDs under IPLD's `git-raw` and `bitcoin-tx`
codecs). A URL's scheme and path say which thing; its fragment says where
inside it. Resolve by handing the URL to the registry and getting bytes or a
typed failure. Routes are never stored inside blocks: identity is the hash,
the URL is only a way to reach it.

## Out of scope for now

Search (vector or text) is a separate layer over the same blocks. The
entry/routing pipeline, lenses beyond a rudimentary browser, checkpointing to
chain via gib, and any BRC wallet integration all sit above this and are not
part of the store. Deployment topology is configuration, not architecture.
