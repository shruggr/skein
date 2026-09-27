# host-go

The wasm shell under **wasmtime**, from Go: brush + uutils coreutils (the
WASI preview1 modules in `../wasm/`) over a git-shaped tree read from the
SQLite store. A port of `src/runtime/shell.ts` and `src/runtime/wasi/{host,vfs}.ts`;
the same tree and command line give byte-identical stdout, stderr, exit code
and tree CID on both hosts. First slice of issue #14 (provisional name).

| file | what |
|---|---|
| `cid.go`, `tree.go` | CIDv1 (git-raw/sha1 for trees and blobs, raw/sha2-256 for modules); git objects |
| `store.go` | the `blocks` table of the runtime's SQLite file (get/has/put; nothing else is touched) |
| `vfs.go` | the copy-on-write tree view; inode numbers in load order, as on Node |
| `wasi.go` | `wasi_snapshot_preview1` + the `skein` imports brush uses (`cmd_exists`, `pipe`, `spawn`) |
| `shell.go` | modules, `Modules.Run`, spawn, clock, random, fuel |
| `cmd/skein-shell` | the CLI |
| `node/run-shell.ts` | the Node host's side of the equivalence test (`runShell` over the same store) |

## Build, run, test

Go 1.27, cgo (wasmtime-go links a prebuilt static `libwasmtime.a`; no Rust needed).

```
cd host-go
go build -o skein-shell ./cmd/skein-shell
./skein-shell -db <store.db> -tree <cid or git sha1> [-cwd /sub] [-env K=V]… [-stdin] \
    [-time <ms>] [-seed <n>] [-fuel <n>] [-wasm ../wasm] -- '<command line>'
go test ./...            # needs node (26, with node:sqlite) and ../node_modules
SKEIN_NO_NODE=1 go test ./...   # only the Go-side tests
```

The CLI prints the command's captured stdout and stderr, then on stderr
`exit <code>`, `tree <cid>` and, with `-fuel`, `fuel <used>`. Objects of the
new tree go into the store. The modules are read from the store by the CIDs
the runtime uses (`MODULES` in `src/runtime/programs.ts`; `skein-dev install`
puts them there), or from a directory with `-wasm`; either way the bytes are
checked against those CIDs. Out of fuel exits 3.

Compiling all modules takes ~1 s per process (Cranelift, parallel, arm64,
now brush + coreutils + the toolset's nine extra modules); after that the
64 test cases run in ~0.3 s. Node takes proportionally longer for the same
batch including its compile.

## Behaviour

- **Clock**: every clock reads one value (`-time`, ms since the epoch; default
  0). **Random**: one splitmix32 stream seeded by `-seed`, shared by every process
  of the run. These are `runShell`'s defaults when no clock/random is passed.
  **Sleep** (`poll_oneoff` on clocks only) returns at once, as `runShell`'s
  default does.
- **Processes**: each program (brush, each spawned utility or script) is a
  fresh instance in a **store of its own**, closed when it exits; brush's
  `skein.spawn` runs the child to completion from inside the host call. Parent
  and child share open file descriptions (pipes, file positions).
- **Fuel**: with `-fuel N` the engine meters execution and the run has one
  budget. A child starts with what its parent has left (read from the parent's
  store during the `spawn` call) and hands back what it did not use; so fuel
  spent in pipelines and subshells is charged. Running out anywhere ends the
  whole run with `ErrOutOfFuel`; no partial result is returned.
- Unknown imports return ENOSYS (as on Node). A trap other than out-of-fuel
  writes `<argv0>: trapped: <message>` to the process's stderr and exits 134.

## Equivalence with the Node host

Tested by shelling out, not by recorded fixtures: `TestEquivalentToNode`
builds the `shell.test.ts` fixture (plus a copy with a 2 MB file) in a fresh
store, runs every case through `node/run-shell.ts` (one Node process, real
`runShell` over `openStore`) and through `Modules.Run`, and compares stdout,
stderr, exit code and tree CID byte for byte. The cases are every command
line in `src/runtime/shell.test.ts` (reads, writes, renames, `cp`, symlinks,
pipelines, command substitution, here-docs, `yes | head`, exit codes, pipefail,
the determinism line with stdin/`date`/`$RANDOM`/`ls -la`/`od`/`sleep`/`mktemp`,
`-time`, `-seed`, escaping the root, `/dev`, cwd + env, a refused cwd, scripts
in the tree, the 2 MB round trip: 32) and 32 more (hard links, `ls -R`, `realpath`,
`cp -r`/`rm -r`, `rmdir` of a non-empty dir, `truncate`, `sort > same file`,
`dd`/`tail -c`, moving a dir into itself, dangling symlinks written through,
NUL bytes, globs, nested substitution, `/dev/std*`, stdin, `printenv`,
`$SRANDOM`/`shuf`/`mktemp`, `test`, and the toolset of issue #13: `grep -rn`/
`-il`, `find | xargs`, `which`, `sed -i`/`-n`, `awk '{print}'`, `diff`, `cmp`,
`jq`/`jq -r`, a `grep -rl | xargs | sed | awk` pipeline). **All 64 match.**
`TestTreeMatchesNodeScan` checks that Go's tree hashing agrees with
`src/dev/scan.ts` (and, checked by hand, a scanned tree's CID is its `git write-tree` id).

Known differences, none exercised by the cases:

- **Trap messages** come from the engine (V8 vs wasmtime wording), so the
  `trapped: …` line differs. Exit code 134 is the same.
- **Pipe and `/dev/null` inode numbers**: Node counts them in a module-global
  counter, so they depend on what ran before in that Node process; Go counts
  per run. Nothing in brush/coreutils prints them here.
- **A submodule opened directly** (`path_open` on a gitlink): Node hands out the
  gitlink node itself as a directory and reading it fails with EIO; Go gives the
  empty read-only directory that `vfs.ts` documents. The Node side looks wrong.
- Directory listings sort as JavaScript does (UTF-16 code units), to match.

Not in this slice:

- The scheduler's clock and random (`ThreadClock`: entry stamp, +1 ns per read;
  `entropy(entry, thread)`: SHA-256 counter stream) and sleeps that park a
  thread. Only `runShell`'s standalone defaults are implemented.
- The handler programs' `skein` imports (`input`, `get`, `put`, `emit`, `await`,
  `head`, `advance`, `wallet`, …), the log, chains, messages: nothing beyond
  the shell. The shell modules import only `cmd_exists`, `pipe`, `spawn`.
- Fuel has no counterpart on the Node host, so fuel numbers are
  wasmtime's alone. Within one wasmtime version and module they are exact and
  repeatable (`TestFuel`); across wasmtime versions they are not promised.

## Toolchain findings (2026-09-26)

Checked for issue #14: can a Go host run WASI 0.2 components?

- **Latest**: `github.com/bytecodealliance/wasmtime-go/v49` **v49.0.0**
  (tagged 2026-09-21, "Bump to 49.0.0"), wrapping the wasmtime C API 49; the
  newest wasmtime release is v49.0.1 (2026-09-24). No v50 module exists yet.
- **Component model in wasmtime-go v49.0.0: loading only.** It has
  `Config.SetWasmComponentModel`, `NewComponent`, (de)serialize, type
  introspection (primitive kinds only), `ComponentLinker.Instantiate`,
  `DefineUnknownImportsAsTraps`, export indices
  (`component_*_feat_component_model.go`). It has **no** way to call a
  component's exported function (`component_feat_component_model.go`: "TODO:
  ComponentFunc + value marshaling"), **no** host functions or resources on
  a component linker, and **no** `wasip2` or `wasi:http` registration. So a
  WASI 0.2 component cannot be run from Go with the released package — nor can
  skein implement its own `wasi:filesystem`/`wasi:http` over the graph, which
  needs host functions and resources.
- **In review, not merged**: tracking issue
  [wasmtime-go#280](https://github.com/bytecodealliance/wasmtime-go/issues/280);
  draft PRs [#290](https://github.com/bytecodealliance/wasmtime-go/pull/290)
  (component function calls and values),
  [#291](https://github.com/bytecodealliance/wasmtime-go/pull/291) (component
  host functions and resources, stacked on #290),
  [#292](https://github.com/bytecodealliance/wasmtime-go/pull/292) (synchronous
  WASIp2 linker registration), all opened 2026-08-01; the maintainer wrote on
  2026-08-14 that review was pending. The earlier merged
  [#281](https://github.com/bytecodealliance/wasmtime-go/pull/281)/[#282](https://github.com/bytecodealliance/wasmtime-go/pull/282)
  are what v49 ships.
- **The C API underneath has it.** The headers and the prebuilt
  `libwasmtime.a` bundled in wasmtime-go v49 are built with
  `WASMTIME_FEATURE_COMPONENT_MODEL`, `_COMPONENT_MODEL_ASYNC`, `_WASI`,
  `_WASI_HTTP` (`build/include/wasmtime/conf.h`), and
  `wasmtime/component/linker.h` declares
  `wasmtime_component_linker_instance_add_func` (+ `_async`),
  `wasmtime_component_linker_instance_add_resource`,
  `wasmtime_component_linker_add_wasip2`,
  `wasmtime_component_linker_add_wasi_http`, and `component/func.h`
  `wasmtime_component_func_call`. So Go could reach them with its own cgo
  bindings against that library (or a fork of wasmtime-go) today. Note that
  `add_wasip2`/`add_wasi_http` are wasmtime's own implementations over the real
  host filesystem and network; skein's kernel would instead define those
  interfaces itself via `add_func`/`add_resource`.
- **Preview1 core modules + `wasi_snapshot_preview1`**: fully supported
  (`Linker.FuncNew`/`FuncWrap`, also `DefineWasi` for wasmtime's own host-backed
  WASI, not used here). This slice runs entirely on that.
- **Fuel: yes.** `Config.SetConsumeFuel`, `Store.SetFuel`, `Store.GetFuel`
  (`config.go`, `store.go`); exhaustion is a trap with code
  `wasmtime.OutOfFuel`. Proven here (`TestFuel`): `while :; do :; done` and
  `yes > /dev/null` end with `ErrOutOfFuel`; `cat a.txt | sort | wc -l` uses
  exactly the same fuel on every run (3,615,765, of which the shell alone
  `echo 3` is 1,155,478 — the children are charged), and that exact budget
  suffices. Epoch interruption (`SetEpochDeadline`) is also exposed.
- For comparison, Rust's `wasmtime` + `wasmtime-wasi` + `wasmtime-wasi-http`
  crates are where the component model is complete (bindgen for WIT worlds,
  host resources, async); the C API and hence Go trail them.
