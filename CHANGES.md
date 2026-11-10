# Changes

## 0.7.1

Host only: the kernel and the log are 0.7.0's.

- **The broadcaster posts Extended Format or nothing.** The raw-transaction
  fallbacks are gone (src/host/arc.ts). A broadcast event with no BEEF, a
  BEEF of another transaction, one whose subject lacks an input's source, or
  one that proves its subject (it is mined: a chain-app defect, which
  broadcasts only an unlinked transaction) is a host error, named with the
  txid on the instance's log. Nothing is queued and the instance is told
  nothing.
- **Arcade's answers by one table** (`ARC_CODES`, David to review). An
  invalid transaction (ARC 461-466, 471-474, and 467 on the stream) is
  REJECTED. Our payload or request at fault (a 400 with no ARC code, 460,
  467 at intake, 468, 469, 475, 401, 403, 404, any other 4xx) is not a
  rejection: an error on the instance's log, the row off the queue, no
  status. 476 (not final) keeps the row, tried again. 408, 425, 429, a 5xx
  or no answer are tried again as before. A REJECTED on the stream or a
  webhook with one of our codes or 476 is logged and not routed.
- The equivs pin skein-chain v0.11.0 (`chain.ts` on its status words), with
  `chain-proof-events.ts`, `chain-bundle.ts` and the test caller
  programs/test/ingester.

## 0.7.0

**Existing instances do not replay on this kernel. Fresh instances only.**
A log written by an earlier kernel diverges at its first signer call by a
program (the raw signer is now a granted kernel service) and wherever it
used the genesis wallet program (gone).

- **Call permissions.** A program may make a named in-VM call,
  `callAs(prog, fn, name, arg)`. The kernel checks that the calling app is
  approved to call the callee's app under that exact name (the grants head's
  `calls`, granted by root or written at birth), and hands the callee the
  name as `as` in its input. A call with no name is unchanged.
  docs/VM.md "Call permissions".
- **Granted kernel services.** The raw signer import (`wallet`) answers
  only a program whose app holds the service `signer`. The stock genesis
  grants it to the front door (`genesis:frontdoor`). An app asks for it in its
  manifest (`services: ["signer"]`); root approves it at install.
- **The genesis wallet program is gone.** No `programs.wallet` in any
  genesis, no pinned wallet module, no `wallet/` genesis scope. The name
  `wallet` is free: a wallet is an app (shruggr/skein-wallet).
- **Billing is out of the kernel** (#130: the host row, tick, meter, pay
  step, asleep gate) and **`kernel.pay` is gone** (#149), with their host
  halves (`skein-host billing`, `reclaim`, `skein host`). Per-step fuel stays.
- **An event's place identifies one event.** A step's facts are handed over,
  delivered to subscriptions and wake resting threads at their place in the
  step's own update (`n.seq.i.thread`), not in the thread's tip at the
  moment: delivering a fact the step's own thread rests on steps it again,
  and its later facts went out with no place (lost to live streams, their
  subscriptions and resting threads not stepped) or another update's place
  (de-duplicated away by the host). A log where that happened replays
  differently on this kernel.
- **`skein-dev install` is gone** (it installed the pinned wallet module; the
  kernel installs its own pinned modules).
- docs/WALLET.md is gone; its proofs and settlement sections are
  docs/CHAIN.md.
