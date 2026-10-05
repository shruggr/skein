# skein core audit — incomplete work

Repo: /home/shruggr/Work/agent-env/skein, commit 6658a45 (not a git worktree per
env banner, but `.git` present and `git` commands work against it).
Scope as given: kernel-zig/src, src/host, src/runtime, programs/, images/,
docs/, README.md, bin/, scripts/ — resolved to git-tracked files only (231
tracked files; build artifacts under programs/*/{.zig-cache,zig-out,zig-pkg}
are gitignored and were excluded as not part of the committed tree). For
§3 "the equiv suite" the task names kernel-zig/equiv explicitly, so that
directory is cited there even though it sits outside the literal
`kernel-zig/src` scope line.

Read-only. Nothing in the repo was changed.

---

## 1. TODO/FIXME/XXX/HACK/"not yet"/"for now"/"temporary"/"to review" markers

Literal `TODO`, `FIXME`, `XXX`, `HACK` (word-boundary, case-sensitive):
**zero occurrences** anywhere in the scoped, tracked files.

Prose markers ("not yet", "for now", "temporary", "to review", "(to
review)"): **25 occurrences**, all of them narrative, none a bracketed
code-comment marker. Grouped by file:

**docs/OPEN.md**
- L12: "a `launched` record not yet written when the process dies. Recovery would relaunch, so a shell command could run twice." — open question, no fix landed.
- L89: "Dead or legacy code, not yet removed: `host-go/` ...; `scripts/host/{messagebox.sh, messagebox-migrate.mjs, grants-legacy.sh, register.ts, web.sh}` and the instance/host wallets in `wallets.sh` (the pre-#33 layout); `src/runtime/log.ts`, a format-1 reader the node host still imports; `attested` in `src/runtime/records.ts` and `types.ts`." — see §2, verified below.

**docs/BOOTSTRAP.md**
- L80: "an outpoint (`<txid>_<vout>`) is refused for now: an image on chain is read [later]."

**docs/MESSAGES.md**
- L216 (table cell): "`{wait: true, admit?: [entry]}` ... not yet: it launched, or awaits, the thread the answer depends on."

**docs/VM.md**
- L178-179: "No `local` row fires today: a provider's answer is a message, routed by its `mailbox` row (to review)."
- L368: "...an instance that is its own owner, the browser page, #16, names its own mailbox there, and its answers to its owner are for the person. To review.)"
- L470: "[entry CIDs admitted and not yet processed]"

**docs/APPS.md**
- L245: "Not yet: `push` (publishing from a skein), refs or tags as the `hash`, sha256 repositories."

**kernel-zig/src/program.zig**
- L81: "/// keeps so far, not yet in the index: from the block at seq 0, as the update will write them)"

**kernel-zig/src/serve.zig**
- L78: "/// The host's `answer` requests not yet answered (#66): each waits on a request entry's thread."
- L320: "// ({thread, state: "waiting"}, or {state: "pending"}: the entry not yet processed)."

**kernel-zig/src/web.zig**
- L19: "// skein_admit(frame, n) → n  serve's `admit` ({entry, body?}): the one call in that writes; not yet processed"

**kernel-zig/src/index.zig**
- L595: "/// One update of a chain, recorded (not yet the tip)."

**kernel-zig/src/scheduler.zig**
- L1946: "/// the log are read as they stand (plus the entries admitted and not yet processed, `pending`, and the committed state record, `state`)"

**programs/messagebox/main.zig**
- L32: "//! <count>, messages: [{id: <mail cid>, at}]} — the messages not yet acknowledged, in arrival order."
- L333: "// Only ids in the caller's own lists, not yet acknowledged."

**programs/wallet/main.zig**
- L199: "/// `unproven` (not yet ingested: our own, on its way to the chain app)."

**src/host/feeds.ts**
- L35: "// queue of items not yet admitted holds at most `maxQueue` (the oldest go first, logged)."

**src/host/arc.ts**
- L50: "// instances not yet known."

**src/host/install.ts**
- L86: "`<url>#<rev>`) cloned into a temporary directory." — ordinary use of "temporary", not a flagged gap.

**src/host/testhost.ts**
- L1: "// A test host (#40): a router over a temporary host.db and SKEIN_HOME, agents..." — ordinary use; also a vocabulary note (§7: "agents").

**src/host/arc.test.ts**
- L240: assertion message "only the running instance not yet known".

**src/runtime/identity.ts**
- L29: `p.catch(() => byName.delete(name)); // don't memoise a failure (wallet locked, permission not yet granted)` — also listed in §5.

**src/host/router.ts**
- L295: "/** The fuel of calls not yet written to the ledger: instance\0caller\0op → {calls, fuel}. */"

**src/host/kernel.ts**
- L39: "/** A request thread's answer (#66, the `answer` frame): at rest (finished | errored), or not yet at the wait's bound. */"

Net: no abandoned-marker litter. The "not yet"/"to review" prose is mostly
descriptive of genuinely open design edges that the docs already own up to
(OPEN.md exists for exactly this), not code rot.

---

## 2. Stubs and dead ends

**Declared-but-unimplemented function guard (defensive, currently
unreachable):**
- `images/default/apps/git/src/main.zig:182` — `if (!eql(u8, name, CLONE)) return fail("unknown-fn", ...": declared, not implemented")`. Checked `images/default/apps/git/etc/app.json`: `provides` declares exactly one function, `clone`. So this guard currently can never fire (nothing else is declared) — it's forward defense for a function that does not yet exist, not a reachable stub.

**Revocation not implemented (consistent across the codebase, by design
gap, not a leftover):**
- `src/host/handles.ts:43,57` — "Revocation is not implemented: the host has no wallet." Same statement in `docs/ARCH.md:239`, `docs/MESSAGES.md:959`, `README.md:77`, `scripts/host/README.md:114`. BRC-52's "disabled" sentinel is used as the revocation outpoint. This is a real, acknowledged gap (not hidden), repeated consistently in five places.

**Dead/legacy code named explicitly by docs/OPEN.md:89-94** (checked against the tree):
- `scripts/host/messagebox.sh`, `scripts/host/messagebox-migrate.mjs`, `scripts/host/grants-legacy.sh`, `scripts/host/register.ts`, `scripts/host/web.sh` — all present in the tree (`git ls-files scripts/host` confirms). `scripts/host/wallets.sh:20` itself says `# LEGACY: instances sign through the router's oracle (src/host/oracle.ts) and ...`, i.e. the file documents its own legacy status inline.
- `src/runtime/log.ts` — a "format-1 reader the node host still imports" per OPEN.md. Confirmed imported: `git grep` shows `src/host/*.ts` importing from `./log.ts` / `../runtime/log.ts` (e.g. index-store.ts chain). Kept alive for old stores, per the doc's own framing.
- `attested` in `src/runtime/records.ts` and `src/runtime/types.ts` — a format-4 concept ("recorded http/libp2p calls attested by a host key", superseded at format 6 per `kernel-zig/README.md:608`). `src/runtime/records.test.ts:93` tests explicitly assert `isOracleCall` returns false for a `kind: "attested"` record — i.e. the type is kept only to recognize and reject the old shape, not to produce it.

**Dead export (no caller found anywhere in the tracked tree):**
- `src/host/brc231.ts` exports one concrete function, `cborBoxClient` (L28). Searched every tracked file for `cborBoxClient`: zero callers. The file's two *type* exports (`Listed`, `MessageBox`) are imported — but only by `src/peers/infer.ts` and `src/testkit.ts`, both outside the audited scope (src/peers, and a root-level testkit). Inside the audited core (kernel-zig/src, src/host, src/runtime, programs/, images/) nothing imports brc231.ts at all, type or value. A full BRC-231/BRC-33 client implementation that nothing in scope uses.

**Programs pinned but not auto-wired (by design, confirmed from comments,
not a gap):**
- `kernel-zig/src/programs.zig:22` — "The wallet's state inside the VM (issue #29): installed, not in a genesis by default." `resolve` similarly: wired "only where an application wires them" (`programs.zig:28`). Both are pinned CIDs (`programs.zig:23,29`) but neither appears in `images/default/bin/*.cid` (only `frontdoor` and `messagebox` are named by CID there, per `scripts/pin-programs.sh`'s own comment: "the default image names the front door and the messagebox by CID. ... Nothing else is pinned"). Matches the stated design; not flagged as incomplete.

**Orphan check — programs/, kernel-zig/src, src/host, src/runtime:**
- All tracked `programs/*` (frontdoor, messagebox, resolve, wallet, and programs/test/{fetch,p2p-component,p2p-demo,wire-probe,app-demo,cron-demo}) have at least one referrer in genesis.ts/programs.zig pins, `kernel-zig/equiv/*.ts`, or a `src/host/*.test.ts` driver. None orphaned.
- Every tracked `kernel-zig/src/*.zig` file is reachable from `build.zig`'s two root modules (`src/main.zig`, `src/web.zig`) or from `src/tests.zig`'s explicit `@import`s (checked via grep for each basename as an `@import` target). None orphaned.
- Every tracked `src/host/*.ts` / `src/runtime/*.ts` (non-test) file has at least one importer in the tracked tree **except** `src/host/brc231.ts`'s `cborBoxClient` (above).
- `src/host/vcdiff.ts`, `src/host/control.ts`, `src/host/roster.ts`, `src/host/fake-arcade.ts`, `src/host/deploy.ts`, `src/host/plan.ts` were spot-checked as the lowest-reference-count files besides brc231.ts; all are wired into `src/host/cli.ts` and/or `src/host/router.ts`/`install.ts` in production code, and `fake-arcade.ts` is used by `kernel-zig/equiv/{chain,install-overlay,overlay,wallet}.ts` as well as `arc.test.ts`. None dead.

**Known-unsupported WASM/component features (intentional restriction, not
a stub):** `kernel-zig/src/wasm_fuel.zig` has ~20 `error.Unsupported` sites
for exceptions/GC/typed-function-refs/memory64/multi-memory/component
tags — all commented with the specific unsupported feature. This is a
deliberate fuel-metering boundary (also documented in `engine_v8.zig:78`),
not incomplete work; listed here for completeness since it's the largest
cluster of "doesn't do X" code in the kernel.

---

## 3. Tests

**Test files in audited scope** (`src/host/*.test.ts`, `src/runtime/*.test.ts`): 33 files, 117 top-level `test(...)` calls.
**kernel-zig native test files**: `component_test.zig`, `fuel_test.zig`, `index_test.zig`, `wasm_fuel_test.zig` (plus inline `test` blocks in `json.zig`, `bitcoin.zig`, `objects.zig`, `syscalls.zig`, `tree.zig`, `wasm_fuel.zig`, `dispatch.zig`, and `tests.zig` itself).

**skip/todo/only:**
- No `.only`, no `.todo`, no commented-out `test(` blocks anywhere in scope.
- 14 of the 117 TS tests carry a conditional skip: `{ skip: !existsSync(KERNEL_BIN) && "kernel-zig not built" }` — e.g. `src/host/call.test.ts:21`, `loop.test.ts:44,109,151`, `explore-route.test.ts:23`, `frontdoor.test.ts:28`, `peers.test.ts:16`, `handles.test.ts:128`, `remote.test.ts:17`, `router.test.ts:26,82,95,149`, `runtime/index-store.test.ts:46`. These are silently skipped (not failed) if `kernel-zig/zig-out/bin/skein-kernel` hasn't been built first — i.e. `npm test` alone, without `zig build` first, quietly runs a smaller suite and reports green.
- No `error.SkipZigTest` anywhere in `kernel-zig/src`.

**Native Zig test coverage vs. the biggest files:** Checking which
`kernel-zig/src/*.zig` files contain their own `test "..."` declarations:
only `json.zig`, `bitcoin.zig`, `objects.zig`, `syscalls.zig`, `tree.zig`,
`wasm_fuel.zig`, and `dispatch.zig` (one test: "fold: add replaces by key,
remove deletes, first match wins") do, besides the four `*_test.zig`
files (which cover the index/MST, fuel+clock metering, and wasm
component/fuel execution respectively). **`scheduler.zig` (the single
largest file in the kernel, ~138 KB — the step/thread/dispatch execution
engine), `store.zig`, `log.zig`, `heads.zig`, `program.zig`, `programs.zig`,
`oracle.zig`, `serve.zig`, `main.zig`, `runner.zig`, `vfs.zig`, `wasi.zig`,
`env.zig`, `ipc.zig`, `addressbook.zig`, `cmd_shell.zig`, `component.zig`,
`engine.zig`, `engine_v8.zig`, `engine_wasmtime.zig`, `sqlite.zig`,
`sqlite_store.zig`, `replay.zig`, `web.zig`, `web_store.zig`,
`component_web.zig` have zero native `test` blocks of their own.** Their
behavior is exercised only through `zig build test`'s indirect fixture
checks in `tests.zig` (dag-cbor/envelope/entropy/CID fixtures and one V8
trap-message test) and through the TypeScript equiv suite below —
never by a Zig-level unit test that calls into the scheduler/store/log
machinery directly.

**What `kernel-zig/equiv/` (named explicitly in the task) covers vs not:**
Tracked files: `abi.ts, boot.ts, browser.ts, browser-live.ts, browser.html,
chain.ts, claim.ts, corpus.ts, fetch.ts, git.ts, git-clone.ts, host.ts,
install.ts, install-overlay.ts, libp2p.ts, old-store.ts, overlay.ts,
replays.ts, run.sh, serve.ts, shell.ts, shell-cases.ts,
shell-expected.json, site.ts, static.ts, wallet.ts`. By filename/README
cross-check (`kernel-zig/README.md`, `kernel-zig/equiv/run.sh` header)
this is an integration suite: boot/genesis, the shell against TS-recorded
expectations, git-in-the-VM, replay exactness over a generated corpus,
libp2p, the chain/overlay/wallet/static apps, browser (Playwright/Chromium,
skipped with a note if unavailable), and `old-store.ts` for the
pre-fuel/legacy store format. It is the only place scheduler-level
behavior is actually exercised end to end. It is **not wired into any
single repo-level command**: the root `package.json` has no script that
calls it; it is run by hand as `kernel-zig/equiv/run.sh` (per
`README.md:270-277`'s own "Build and test" section, which lists it as a
separate manual step, not part of `npm test`).

**CI:** there is no `.github/` directory in the repository at all — no
GitHub Actions, no CI of any kind. `npm test` and `zig build test` are
real, runnable local commands (wired in `package.json`'s `"test"` script
and `kernel-zig/build.zig`'s `b.step("test", ...)` respectively), but
nothing automatically runs them on push/PR.

---

## 4. Docs honesty

**Built-vs-spec tagging (docs/APPS.md):** L11 claims "Status of each part
is marked **built** or **spec**" (bold). In practice the file uses
`(Built, #NN)` / `(Spec.)` (parenthetical, not bold) — the intro line's own
formatting doesn't match its usage. Content-wise: §7's "What is built,
what is spec" table lists **one** unbuilt row out of 17: "a multi-tenant
overlay's `overlay.topics/1` / `overlay.lookups/1` — optional, not
planned" (L676). The only "(Spec.)" tag in the body (L162) is the claim
that a manifest's `provides` contract mirrors a WASI 0.2 component's WIT
closely enough that "one app can replace another behind the same
interface" — stated as spec only, not built/verified.

**"Not implemented" / "today" / "decided direction, not yet built":**
- `docs/ARCH.md:239`, `docs/MESSAGES.md:959`, `README.md:77`,
  `scripts/host/README.md:114`, `src/host/handles.ts:43,57` — BRC-52
  handle-certificate revocation not implemented (host has no wallet). (Also §2.)
- `docs/ARCH.md:119-122` — "Today an answer set ends at `proven` or
  `rejected`; the decided direction (#31, 2026-10-02) is that a reference
  to a transaction is a subscription for the transaction's life, so a
  reorg or a proven conflicting spend reaches every registrant." A
  decision recorded as settled but not yet built.
- `docs/ARCH.md:259` and `:289` — "today" used to scope current behavior
  ("What about the host is state or conversation belongs in it (today:
  the ...)"; "...emits `create` to the instance manager ... (today)") —
  both flag host-page behavior as current-but-provisional, no explicit
  successor named.
- `docs/BOOTSTRAP.md:406` — "`pack --checkpoint` holds in memory today (it
  fails with 'Invalid array ...')" — a known failure mode under a named
  condition, not fixed.
- `docs/VM.md:777` — "pure key→bytes map of immutable records (SQLite
  today; IndexedDB in a [browser host, unbuilt])".
- `docs/VM.md:178-179`, `:368` — two "(to review)"/"To review." tags on
  open design points (local-row delivery; an instance's answers to itself
  as owner). See §1.
- `docs/SKILLS.md` — a dated audit (2026-09-27) of the 68 bundled skill
  scripts the bopen.ai agents reference, categorized A–E by shell-runtime
  readiness: **A (runs today) = 8, B (trivial edit) = 1, C (needs HTTP
  the shell doesn't expose yet) = 8, D (needs bundled npm/pip packages,
  not done) = 7, E (needs a native peer/service/API key not built) = 43,
  other = 1.** 63% of the audited scripts (43/68) are blocked on
  capability that doesn't exist yet in the shell app.

**Version drift between docs that should agree, checked against the
actual shipped artifact:**
`images/default/www/package.json` declares `"version": "0.5.2"`, matching
the HEAD commit message itself ("6658a45 The default image carries
skein-site 0.5.2: no spending allowance in the grouped request"), and
`docs/BOOTSTRAP.md:52` says "shruggr/skein-site v0.5.2's tree". But:
- `images/default/www/README.md:6` still says "Version **0.5.0**" — stale
  by two patch versions inside the very directory the HEAD commit touched.
- `docs/APPS.md:667` (and the inline `0.4.0`→`0.5.0` progression at
  L272/276/280/284) tops out at "skein-site 0.5.0" — stale.
- Root `README.md:308`'s Repositories table says `v0.4.0` for
  shruggr/skein-site — stale by at least two releases relative to what the
  default image actually carries today.
Three different documents (README.md, docs/APPS.md,
images/default/www/README.md) give three different version numbers
(0.4.0 / 0.5.0 / 0.5.0) for the same dependency that the tree's own
package.json and the HEAD commit agree is 0.5.2.

**README.md as a newcomer onboarding doc:**
- "Run a skein locally" (L39-93) gives a real, linear command sequence
  (`npm install`; `zig build --release`; `bin/skein-host add/claim/run`)
  and a real "Build and test" section (L270-277: `zig build`,
  `zig build test`, `npm test`, `kernel-zig/equiv/run.sh`), including the
  documented gotcha that a stale kernel binary breaks `npm test` with
  "kernel probe: exited (1)".
- Tried `bin/skein --help` and `bin/skein-dev --help` in this checkout:
  both work and print real, accurate usage text (exit 0).
- Tried `bin/skein-infer --help`: runs, prints a real diagnostic
  ("SKEIN_MAILBOX_URL is not set...") rather than a help screen, but exits
  cleanly (0).
- **Tried `bin/skein-host --help` in this checkout: it crashes** —
  `node:internal/modules/package_json_reader` throws
  `ERR_MODULE_NOT_FOUND` for package `@1sat/utils`, imported from
  `src/host/handles.ts:49`. `@1sat/utils` is declared in `package.json`
  (`^0.0.42`) and present in `package-lock.json`, but `node_modules/@1sat/`
  has no `utils` subdirectory (every other `@1sat/*`, `@bsv/*`,
  `@chainsafe/*`, `libp2p` package checked is present). So in this exact
  checkout, the README's own "Run a host" path (`bin/skein-host add` /
  `claim` / `run`, all of which load `cli.ts` → `handles.ts`) does not run
  at all, before any of the documented commands can be tried. This may be
  an artifact of an incomplete `npm install` in this working copy rather
  than a repo defect, but it is what a newcomer following the README
  verbatim in this tree would hit first.

---

## 5. Error handling that swallows (src/host, src/runtime)

Exhaustive list of `catch {}` / `catch (e) {}` / `.catch(() => {})`-style
sites where the original error is discarded (not rethrown, and either
nothing is logged or only the stringified `.message` survives). Grouped
by what each one hides.

**Fire-and-forget promise `.catch(() => {})` (no logging at all) —
`src/host/p2p.ts`:**
- L265, L273, L299, L351, L377, L381, L419, L493, L498 — closing streams,
  dialing peers on discovery, providing content on the DHT, stopping a
  libp2p node, bounding `starting` promises. Every one of these hides
  whatever error occurred (timeout, connection refused, protocol
  mismatch) with zero trace, even to the router's own log (`this.say`).
  L383's sibling `try {} catch { /* timed out: next round */ }` and
  L507's `catch { return true; }` (treat "can't tell if private" as
  "assume private") are the same pattern with a comment instead of
  silence.

**Fire-and-forget promise `.catch(() => {})` — `src/host/router.ts`:**
- L446, L459, L544, L556, L557, L605, L902 — draining in-flight request
  promises, waiting for kernels to go idle, chaining a per-row task queue.
  Same shape: any underlying failure (a kernel crash mid-idle, a hung
  request) is invisible; the caller only knows the `Promise.all` settled.
- L918, L947 — `l.kernel.dispatch().catch(() => undefined)`: a failure to
  read the dispatch table collapses to "no dispatch table", which is then
  treated the same as "none configured" by the caller — a real failure
  and an empty table are indistinguishable downstream.

**`catch { /* comment */ }` with a named but unverified assumption:**
- `src/host/arc.ts:133` — `try { tx = parse(); break; } catch { /* the next form */ }`: any parse error (not just "wrong form") falls through to try the next format.
- `src/host/arc.ts:136,138` — Extended-Format / EF encode/decode fallbacks swallow the specific `@bsv/sdk` error and fall back to raw bytes; if the fallback itself is wrong there's no signal, only a differently-shaped result.
- `src/host/arc.ts:192` — a non-JSON SSE event is logged via `this.say` then treated as `undefined` — the message content itself (not just that it failed) is lost.
- `src/host/arc.ts:341` — `catch { /* no JSON: below */ }`: swallows the JSON.parse error and falls through to byte handling; indistinguishable from "it was never meant to be JSON".
- `src/host/arc.ts:408` — `catch { return ""; }`: whatever the function (a status/description extractor, by context) throws becomes an empty string with no trace of why.
- `src/host/kernel.ts:142-143` — `catch { /* gone */ }` ×2: writing an answer or error back to a disconnected kernel process is assumed to always mean "the process is gone"; any other write failure (e.g. a malformed frame) is indistinguishable from a clean disconnect.
- `src/host/roster.ts:56` — `catch { /* no IDENTITY.md, or the deploy has not been admitted yet */ }`: two distinct causes collapsed into one silent no-op; a real I/O error on that path would look identical.
- `src/host/p2p.ts:414` — `catch { break; } // the remote closed its side`: assumes any read error on the stream means a clean remote close.
- `src/host/handles.ts:119` — `catch { return undefined; }` in a domain-matching helper: a malformed record and "doesn't match" are indistinguishable to the caller.
- `src/host/boot.ts:291` — `catch { return undefined; }` wrapping `store.bytes(cid)`: a genuinely corrupt/missing object and "not present" look the same.
- `src/host/cli.ts:647` — `catch { return undefined; }`.
- `src/host/cli.ts:747` — `catch { /* a store this build cannot read: the router says so at hydration */ }` — deferred, not truly silent (the router reports it later), but the original error here is still discarded.
- `src/host/genesis.ts:367` — `catch { return undefined; }` around a CID parse.
- `src/host/router.ts:260` — nested `catch { /* neither */ }`: a message body that's neither dag-cbor nor JSON silently becomes `undefined`.
- `src/host/router.ts:270` — `catch { return t.slice(0, 200); }`: a description-extraction failure falls back to raw text, hiding the parse error.
- `src/host/router.ts:522` — `catch { /* not a peer ID: the front door rejects it */ }` — assumes the only possible failure mode.
- `src/host/router.ts:1001,1003` — `catch { return false; }` ×2 in URL/origin comparison helpers: a malformed URL and "different origin" are indistinguishable.
- `src/runtime/sqlite.ts:615` — `catch { /* not a CID after all; hand back the string */ }`.
- `src/runtime/index-store.ts:337` — `catch { return []; }`: a decode failure and "empty" look the same to the caller.
- `src/runtime/index-store.ts:366` — `catch { /* no such file yet: sqlite.ts makes it */ }` — assumes ENOENT; any other stat error is swallowed identically.
- `src/runtime/index-store.ts:489` — `catch { return undefined; }`.
- `src/runtime/bitcoin.ts:88` — `catch { return undefined; }` around transaction parsing.
- `src/runtime/bitcoin.ts:112` — `catch { return []; }`.
- `src/host/testhost.ts:56` — `catch { continue; }` in a test-harness polling loop (test-only, lower stakes).
- `src/host/feeds.ts:115` — `catch { return []; }` around `JSON.parse`.
- `src/host/fake-arcade.ts:47` — `try { fromEF } catch { fromBinary }` (test double; same swallow-and-fallback shape as arc.ts:47 above).
- `src/host/packet.ts:157` — `catch { continue; }` inside a loop reading possible CID lines — comment says "the loader refuses it with a reason" elsewhere, so this one is lower-risk, but the specific parse error at this site is still discarded.
- `src/runtime/identity.ts:29` — `p.catch(() => byName.delete(name)); // don't memoise a failure (wallet locked, permission not yet granted)` — deliberately treats *every* rejection reason (locked wallet, revoked permission, network error) the same way: forget the cache entry. No logging.

**Reported-but-lossy (kept `.message` only, original error/stack
dropped) — listed separately since these are not fully silent but still
discard the error object itself:**
`src/host/arc.ts:228,255,291`, `src/host/p2p.ts:355,369,372`,
`src/host/cron.ts:178`, `src/host/providers.ts:197,320,362`,
`src/host/router.ts:993,1162`, `src/host/arc.ts:306` — all of the form
`catch (e) { this.say(handle, \`...: ${(e as Error).message}\`); }`. These
surface *that* something failed and the message text, but the error's
type, cause chain and stack are gone, and a non-`Error` throw (e.g. a
thrown string or object) silently stringifies via the `.message`
assumption (`(e as Error).message` on a non-Error is `undefined`).

---

## 6. Config and environment sprawl

78 distinct `SKEIN_*` tokens found by scanning the scoped tree (a few are
false positives — not real env vars — called out below). Cross-referenced
against `scripts/host/README.md`, root `README.md`, and all of `docs/*.md`.

**Documented in `scripts/host/README.md` and/or root `README.md`:**
`SKEIN_CHAIN_DIR, SKEIN_CHAT_DIR, SKEIN_GIT_DIR, SKEIN_HEADERS_URL,
SKEIN_HOME, SKEIN_HOST_ICON, SKEIN_HOST_NAME, SKEIN_HOST_NOTE,
SKEIN_HOST_PORT, SKEIN_HOST_URL, SKEIN_HTTP, SKEIN_IDLE_MS, SKEIN_INFER,
SKEIN_INFER_HANDLE, SKEIN_INSTANCE_HANDLE, SKEIN_INSTANCE_IDENTITY,
SKEIN_INSTANCE_ORIGIN, SKEIN_INSTANCE_URL, SKEIN_MAILBOX_URL,
SKEIN_MASTER_KEY, SKEIN_ONBOARD_DIR, SKEIN_ORIGINATOR, SKEIN_OVERLAY_DIR,
SKEIN_OWNER, SKEIN_OWNER_HANDLE, SKEIN_OWNER_MESSAGEBOX,
SKEIN_OWNER_WALLET, SKEIN_ROUTER_ORIGIN, SKEIN_ROUTER_PORT,
SKEIN_SHELL_DIR, SKEIN_STATIC_DIR, SKEIN_ANSWER_WAIT_MS` and a few more
(≈33 total across both README files plus `docs/*.md`).

**Documented only in `docs/MESSAGES.md` (not in either README):**
`SKEIN_INFER_NODES`, `SKEIN_INFER_CACHE` (L1241: node-count and on-disk
cache size defaults for the inference peer).

**Read in code with an inline comment at the read site, but absent from
every `.md` doc (README.md, scripts/host/README.md, docs/*.md):**
- `SKEIN_KERNEL_BIN` (`src/host/cli.ts:106` header comment + `kernel.ts:35-36`) — documented in cli.ts's own module header, not in a README.
- `SKEIN_MASTER_KEY_FILE` (`src/host/cli.ts:91,318,326`) — same, in-code only.
- `SKEIN_FUEL_PER_STEP` (`cli.ts:104`, `genesis.ts:81`, `router.ts:858`) — in-code only.
- `SKEIN_ORDFS_URL` (`cli.ts:97`, `handles.ts:93`) — in-code only.
- `SKEIN_EXTRA_MODULES` (`kernel-zig/src/replay.zig:61`) — in-code comment only; also read in `p2p-router.test.ts:103` (test-only use).
- `SKEIN_WASM_DIR` (`replay.zig:4,36`) — in-code only.
- `SKEIN_REPLAY_ECHO`, `SKEIN_REPLAY_MODULE` (`replay.zig:145-151`, `runner.zig:34`) — in-code only, debug/replay-override flags.
- `SKEIN_COMPONENT_TRACE` (`component.zig:1324,1327`) — in-code only, debug tracing flag.
- `SKEIN_FUEL_MODE` (`engine_wasmtime.zig:18,27`) — in-code only.
- `SKEIN_WASMTIME_CACHE` (`engine_wasmtime.zig:37-38`) — in-code only.
- `SKEIN_SHELL_COMPONENTS` (`cmd_shell.zig:45,48`) — in-code only.
- `SKEIN_WASI_ADAPTER` (`programs/test/fetch/build.zig:13,21`, `programs/wallet/build.zig:22`) — in-code (build.zig comment) only.
- `SKEIN_SDK_DIR` (`scripts/sdk-local.sh:16,19,21`) — in-script comment only; README.md L256-257 mentions `scripts/sdk-local.sh` by name but not this variable.
- `SKEIN_INSTANCE_PORT` (`scripts/host/instance.sh:7,34`) — in-script comment only.
- `SKEIN_MESSAGEBOX_PORT` (`scripts/host/messagebox.sh:13`) — in-script comment only.
- `SKEIN_WEB_PORT` (`scripts/host/web.sh:4,11`) — in-script comment only.
- `SKEIN_MESSAGEBOX` (`bin/skein-host:8,17`, `bin/skein-infer:4`) — in-script comment only.
- `SKEIN_DIR` (`images/default/www/build.mjs:4,19,21`) — in-script comment only; this is the *site build's* own var (points at a skein checkout), unrelated to the host's `SKEIN_HOME`.

**Read with no comment anywhere and no doc anywhere (the only true
"undocumented, unexplained" case found):**
- `SKEIN_LIBP2P_VERBOSE` (`src/host/router.ts:536`) — `if (verdict !== "accept" || process.env.SKEIN_LIBP2P_VERBOSE) this.say(...)`. No comment at the read site, no mention in any `.md` file, no mention in any other source file.

**Test-only env vars (not product config, but real `process.env` reads
in scope):** `SKEIN_P2P_KEEP` (`p2p-router.test.ts:279`), `SKEIN_POLLS`
(`router.test.ts:75`), `SKEIN_KERNEL` (`p2p-router.test.ts:274`), `VERBOSE`
(`testhost.ts:85`, non-`SKEIN_`-prefixed).

**False positives removed from the raw 78-token scan:** `SKEIN_INTERFACE`
(a Zig string constant, `component.zig:31`, not an env var);
`SKEIN_REV` (a filename, `images/default/www/lib/SKEIN_REV`, read via
`readFileSync`, not `process.env`); the `SKEIN_ARC_` / `SKEIN_LIBP2P_`
tokens are comment prefixes for the real `SKEIN_ARC_URL` /
`SKEIN_ARC_TOKEN` / `SKEIN_ARC_EVENTS_URL` / `SKEIN_ARC_CALLBACK_URL` and
`SKEIN_LIBP2P_BOOTSTRAP` / `_DHT` / `_LISTEN` / `_MDNS` / `_RELAYS` /
`_TLS_CERT` / `_TLS_KEY` families (all of which *are* documented in
`scripts/host/README.md`).

Also read, non-`SKEIN_`-prefixed: `process.env.PATH` (`PATH` lookup,
ordinary), `HOME` / `$HOME` (`src/host/cli.ts` and `kernel-zig` build/run
fallback for `SKEIN_HOME`), `WASMTIME_C_API` (`kernel-zig/build.zig:22` —
documented in `build.zig`'s own header comment, points at the vendored
wasmtime C API directory).

---

## 7. Naming and vocabulary drift against docs/ARCH.md

ARCH.md's vocabulary (also restated in APPS.md's "Vocabulary" paragraph):
**instance** (one skein: log + four tables + store), **box** (a message
destination routed by the dispatch table), **head** (a named root),
**thread** (a step's waiting unit), **step** (one scheduler execution),
**app** (a tree under its own name), **program** (a WASI module/role
name), **route/row** (a dispatch-table entry — "first match wins").

| old/alternate term | current term (ARCH.md) | where it still appears | note |
|---|---|---|---|
| `oracle` | — | **not drift.** `oracle` is itself the canonical name throughout: `src/host/oracle.ts` (`class Oracle`), `kernel-zig/src/oracle.zig`, record `kind: "oracle"` (`scheduler.zig`, `records.ts`), used consistently in ARCH.md itself ("the host's signer (the oracle)", L15) and in every doc (BOOTSTRAP, MESSAGES, VM, WALLET, APPS). "Signer" is the plain-English gloss ARCH.md uses on first mention; "oracle" is the actual proper noun in code and stays that way everywhere. (Separately: the skein.nexus *public site* tone memo says to prefer "signer" over "oracle" there — that's a website copy preference, not a core-repo naming inconsistency.) |
| `system` / `System` (type) | **instance** | `src/host/genesis.ts`: `export interface System` (L280), `codeSystem()` (L503), `resolveSystem()` (L444), `writeSystemGenesis()` (L533); `src/host/boot.ts`: `System` type imported and used throughout (`boot.ts:201,203,212,239`), comments "system tree", "the stock system"; `src/host/boot.test.ts:29,90` test names literally say "system tree". | Real, pervasive drift: the type/function names for "what a genesis resolves to" are all `System`-rooted, where every doc (ARCH.md, APPS.md) calls the thing an **instance**. Not a leftover comment — it's the actual exported type name used across genesis.ts/boot.ts/boot.test.ts. |
| `subscriptions` / `routes` (chain) | **dispatch table / rows** | `src/host/genesis.ts`: `export interface SubscriptionSpec` (L129), `export interface RouteSpec` (L222), `rowsOfSubscriptions()` (L373), `rowsOfRoutes()` (L389); `kernel-zig/src/log.zig:55,244-245` explicitly refuses a genesis naming `subscriptions`/`routes` ("format 7... is refused"); `kernel-zig/src/dispatch.zig:2-3` says the dispatch table "replaces the subscriptions chain, the genesis's `routes` and the front door's `routes` head". | Legacy vocabulary kept alive deliberately as typed input to a backward-compatible genesis builder (pre-#77 shape), not accidental drift — but it is genuinely the old names, still exported and still load-bearing in `genesis.ts`, not just mentioned in a comment. |
| `agent` | **instance** | `src/host/testhost.ts:92-93` (`agent(handle) { ... }` test-helper method), used throughout `src/host/router.test.ts`, `p2p.test.ts`, `p2p-router.test.ts`, `emit.test.ts` as `h.agent("alpha")`; `scripts/host/up.sh` comments use "agent" repeatedly ("an agent's genesis", "every enabled agent", L19-46) for what `scripts/host/README.md` and ARCH.md call an instance; `src/host/router.test.ts:3-4,82,92` docstrings also say "agent". | Real drift, concentrated in the test-harness vocabulary (`testhost.ts`'s own helper is named `agent`) and in `scripts/host/up.sh`'s prose, both of which predate or just never adopted "instance" as the noun. |
| "routing table" (arc.ts) | **dispatch table** (unrelated concept, same words) | `src/host/arc.test.ts:6` — "the routing table (the broadcasters, a sweep of every instance at a txid's first status...)" | Not drift against ARCH.md's dispatch table — this names a different internal structure (the broadcaster's txid→instances fan-out map in arc.ts) that happens to share the word "routing". Flagged only to avoid confusion with the kernel's actual dispatch table. |
| `module` | — | used throughout for the Zig/wasm build artifact sense (`component.zig`, `build.zig` files) and for a shell program's **modules** (APPS.md: "a shell program whose modules are files of the tree") | **Not drift** — two legitimate, distinct, consistently-used senses, neither displacing "program" where ARCH.md means a WASI role. |

Everything else in ARCH.md's vocabulary (box, head, thread, step, app,
program, route/row) was not found used inconsistently with an older term
anywhere in the scoped code during the above search.
