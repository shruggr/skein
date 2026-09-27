# Backlog

The backlog lives in GitHub issues: https://github.com/shruggr/skein/issues.
Each issue is the design record for its item — decisions are written into the
issue body as they are made with David, one item at a time, and an issue is
closed when the thing is built and merged. Raw notes behind the older items
are in `OPEN.md`.

## Done (closed)
- #1 named heads; #7 signed-plaintext messages; #9 host-signed log entries;
  #20 dev-tool fixes; #27 per-agent rosters; #28 pairwise conversations, chat
  replies; #24 the bopen.ai proof of concept (agents as instances that message
  each other); #22 the bopen.ai mapping (research).

## Open, by area
- **Machine core:** #2 git as a client for repos in the graph · #3 subscriptions
  as records · #4 bootstrap from a system tree / a packet · #5 metering ·
  #6 store boundary · #26 resolution and encryption inside the step.
- **Messages and host:** #10 providers per interface (delivery outcomes still
  to build) · #23 host service (process per instance, registration API) ·
  #18 a real wallet per instance · #29 wallet split: signing oracle outside,
  wallet state as records · #11 payment negotiation · #8 group encryption ·
  #21 data format (bytes, CBOR end to end).
- **Inference:** #12 inference proxy protocol (bitplan gateway peer noted there).
- **Programs and runtime:** #13 shell toolset / streaming · #25 JS and Python on
  WASI · #14 WASI 0.2 components, wasmtime + browser backends · #15 wasi:http
  over messages.
- **Interface:** #16 easel is one front end · #19 typed emissions from the loop.
- **Specs upstream:** #17 (draft PR bsv-blockchain/BRCs#274).

## Where to look
Issues on GitHub are the ordered record; this file only points at them.
`OPEN.md` keeps the raw notes; `ARCH.md`, `MESSAGES.md`, `VM.md` describe what
is built.
