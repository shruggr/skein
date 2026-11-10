# Changes

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
- **`skein-dev install` is gone** (it installed the pinned wallet module; the
  kernel installs its own pinned modules).
- docs/WALLET.md is gone; its proofs and settlement sections are
  docs/CHAIN.md.
