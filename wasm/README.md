# wasm/

The programs the wasm shell (`src/runtime/shell.ts`) runs: brush + uutils
coreutils, the toolset of issue #13 (search/edit/structured-data
commands beyond coreutils, registered in `Modules.extra`), and the script
runtimes of issue #25 (`qjs`/`node`, `python`/`python3`; see "Script
runtimes" below — those are C, built with wasi-sdk, or a pinned upstream
build, not Rust). All WASI preview1
modules (`wasm32-wasip1`), built with Rust 1.98.1 and stripped of symbols.
`scripts/build-wasm.sh` rebuilds all of them from the pinned sources plus
`patches/`, byte-identically on the same machine in the same checkout
layout (paths of the build machine and even line numbers within a patched
file appear in panic-location strings baked into the binary, so a
different machine, or a differently-named `.build/` checkout dir, gets
other bytes — verified the hard way while pinning `sed.wasm`, see the
`tools` branch history).

| file             | size    | source                                                                  |
|------------------|---------|-------------------------------------------------------------------------|
| `brush.wasm`     | 4.9 MB  | reubeno/brush `739a15d` (main, 2026-09-25), `--no-default-features --features minimal`, + `patches/brush.patch` |
| `coreutils.wasm` | 10.0 MB | uutils/coreutils `0.12.0` (`dc1efd8`), `--no-default-features --features feat_wasm`, + `patches/coreutils.patch` |
| `find.wasm`      | 1.86 MB | uutils/findutils `0.10.0` (`28be1fa2`), `--bin find`, + `patches/findutils.patch` |
| `xargs.wasm`     | 0.38 MB | uutils/findutils `0.10.0` (`28be1fa2`), `--bin xargs`, + `patches/findutils.patch` |
| `diff.wasm`      | 1.28 MB | uutils/diffutils `v0.5.0` (`60f65858`), + `patches/diffutils.patch` |
| `cmp.wasm`       | 1.28 MB | same build as `diff.wasm` (one multicall binary, same bytes/CID), registered under the name `cmp` too |
| `jq.wasm`        | 3.00 MB | 01mf02/jaq `v3.1.1` (`c866e703`), `-p jaq --no-default-features`, + `patches/jaq.patch` |
| `sed.wasm`       | 2.04 MB | uutils/sed `0.2.0` (`2ce633cb`), + `patches/sed.patch` |
| `awk.wasm`       | 1.54 MB | quinnjr/rawk (crate `awk-rs`) `v0.2.0` (`4addaefa`), unpatched |
| `tree.wasm`      | 0.69 MB | peteretelej/tree (crate `rust_tree`) `v1.3.0` (`dfed2820`), unpatched |
| `which.wasm`     | 0.07 MB | first-party, `wasm/tools/which` — no Rust `which` CLI exists (library only) |
| `grep.wasm`      | 1.57 MB | first-party, `wasm/tools/grep` on grep-matcher/grep-regex/grep-searcher (ripgrep's own libraries) — no GNU-grep-compatible CLI exists in Rust |
| `qjs.wasm`       | 1.20 MB | quickjs-ng/quickjs `v0.17.0` (`6d46d07d`), wasi-sdk 34.0, + `patches/quickjs.patch` + `tools/qjs/`; registered as `qjs` and `node` (issue #25) |
| `python.wasm`    | 7.63 MB | CPython 3.14.7 WASI build, brettcannon/cpython-wasi-build `v3.14.7` (`python-3.14.7-wasi_sdk-24.zip`, sha256 `2e064d3f…584b`), `llvm-strip`ped (30.5 MB with DWARF); registered as `python` and `python3` (issue #25) |
| `python314.zip`  | 10.31 MB | not a module: that release's `lib/python3.14`, every `.py` (529 files), packed stored by `tools/python/zip-stdlib.mjs` |

Base image growth: **10 files / 9 unique binaries, 13.71 MB committed
(12.43 MB unique bytes** — `diff.wasm`/`cmp.wasm` are identical).

Issue #25 adds 19.14 MB (qjs 1.20 + python 7.63 + stdlib 10.31); in git's
packs it compresses to about 5.1 MB (gzip -9: 0.42 + 2.30 + 2.38).

sha256 (as committed):

```
8cb0968d6ffa31244a7d7dd7d15bd92e1b8cd37f2e5cd172f9e53f6896bc1417  brush.wasm
6e3be82e9b08e5e2ebace2dfbf1c74ea7a2f30045f92dba9a06419201b08c491  coreutils.wasm
3f6b7a9d9f12db354bf599b5da494332795d4d2da6ea4541d5af96cdd53ebc0d  find.wasm
08cd95d5c0a5d075b53dd57c8cb60a7db89cd2fdbcee57922b0f5d5a94a6064d  xargs.wasm
a788351b50909b76f825e92b1c138fc31212725e3cf13051363d3cb6661035f2  diff.wasm
a788351b50909b76f825e92b1c138fc31212725e3cf13051363d3cb6661035f2  cmp.wasm
fad7b15e0c4eb00f8ca22e8325d8f8fc57d8b45265d29e97ed4b7145250cddf1  jq.wasm
769c2f20af007c6807bc7aa50a51fb7b9a3d932327e99164484bdf161a0a7916  sed.wasm
2e7ee785f7565367015ec6c7681d6025968f65ff5d9a117bcd0d8dd6c0aceb4d  awk.wasm
140e2277a4e5d37ceb0e1cbcc6465cb4f0425ccb6314a5249eed73ab2b7bf83f  tree.wasm
43612217922c4a6ddbebcf4b9503d8360c9a22c0c3b7b797689a37a6c67368c1  which.wasm
e167efd302749254f77dd7b28fcdae6fafdd205b8902100e78f95fe80f7075c1  grep.wasm
dc5db82250ebec2b98f36a24c09024ea25cd061bc49ea2f4aefef0ea0adbd9b1  qjs.wasm
7d445e83f8879daf536925ef7c5e068fce9fde0badff3c8ec7b27ddf30691cd3  python.wasm
ce3377a3115afc411d2baf0093a535155b82148bd343f5d8291b3a63b1eabd11  python314.zip
```

## Why patched builds and not the releases

- **brush** publishes no WASI artifact (its CI builds `wasm32-wasip2` and
  `wasm32-unknown-unknown` and tests the former under wasmtime with pipes,
  external commands and command substitution skipped). Upstream under WASI
  runs builtins only: `std::process::Command::spawn` and `std::io::pipe` are
  unsupported there, host env vars are not imported, and `test -x`/PATH
  lookup treat every path as an existing executable.
- **uutils** does publish `coreutils-0.12.0-wasm32-wasip1.tar.gz` (10.4 MB),
  and it runs here unchanged except for one thing: wasi-libc starts every
  program with cwd `/`, and there is no way to hand a child a working
  directory. The one-line patch makes the multicall binary `chdir($PWD)` at
  startup.

## brush.patch

All changes are `#[cfg(target_os = "wasi")]`; native builds are unaffected.

- `sys/wasm/skein.rs` (new): imports from the `skein` module —
  `cmd_exists(name) -> 0|1`, `pipe(*fds) -> errno`,
  `spawn(req, len, stdin_fd, stdout_fd, stderr_fd, *code) -> errno` where
  `req` is NUL-separated `program, cwd, argc, argv…, envc, KEY=VAL…`.
- `commands.rs`: external commands go to `skein.spawn` with the child's stdio
  as fds of this instance; the host runs the child to completion and the
  command completes with its exit code. Builtins in pipeline subshells run
  inline instead of on a (nonexistent) blocking thread. Command substitution
  runs the subshell to completion into a host pipe, then drains it.
  Stdio→`std::process::Stdio` conversion is skipped (no `dup` in WASI).
- `interp.rs`, `sys.rs`: `std::io::pipe()` → `sys::anon_pipe()` (host pipe).
- `shell/fs.rs`, `commands.rs`: a name not found on `$PATH` resolves to itself
  when the host has a program by that name (so `type`, `command -v` work).
- `sys/stubs/env.rs`: inherit the environment (`std::env::vars()`).
- `sys/wasm/fs.rs`: readable/writable/executable = exists.
- `brush-shell/src/main.rs`: `chdir($PWD)` at startup.

Still unsupported under this patch: process substitution `<(…)`/`>(…)`,
coprocesses, background jobs `&` that must run concurrently.

## The toolset (issue #13)

### Inventory: what `feat_wasm` coreutils already has

`coreutils --list` under `feat_wasm` (79 names): `arch b2sum base32 base64
basename basenc cat cksum comm cp csplit cut date dd dir dircolors dirname
echo expand expr factor false fmt fold head hostid join link ln ls md5sum
mkdir mktemp mv nice nl nproc numfmt od paste pathchk pr printenv printf ptx
pwd readlink realpath rm rmdir seq sha1sum sha224sum sha256sum sha384sum
sha512sum shred shuf sleep sort split sum tail tee test touch tr true
truncate tsort tty uname unexpand uniq unlink vdir wc yes`.

Against the issue's list, already covered: `tr`, `cut`, `sort`, `uniq`,
`tee`, `head`, `tail`, `wc`, `cat`, `printf`/`echo`, `base64`,
`sha256sum`/`md5sum` (plus sha1/224/384/512, b2sum), `paste`, `join`,
`comm`, `fold`, `basename`/`dirname`/`realpath`. **Not** in `feat_wasm`
despite being in full coreutils: `stat`, `du`, `env`, `chmod`/`chown` —
these need filesystem-mode support (`skein.chmod`, the "File modes" item
in issue #13, explicitly out of scope here) and aren't re-enabled by this
change. `file` and `column` were never coreutils (separate GNU/util-linux
projects); see "not attempted" below for `file`. Missing and built here:
`grep`, `find`, `xargs`, `which`, `sed`, `awk`, `diff`/`cmp`, `jq`, `tree`.

### The new modules

- **find, xargs** — uutils/findutils. `find` builds unpatched (needs a
  WASI C toolchain for its `onig` dependency — see "wasi-sdk" below —
  but no source changes). `xargs` needed a real patch: it spawns children
  with `std::process::Command`, which traps under WASI preview1
  ("operation not supported on this platform") the same way brush's did
  before its own patch. `patches/findutils.patch` adds `src/skein.rs`
  (a `skein.spawn` binding, the same wire format as brush's
  `sys/wasm/skein.rs`) and switches `xargs`'s command execution to it
  under `#[cfg(target_os = "wasi")]`; the native code path is untouched.
  Tested: `find . -name '*.go'`, `find . -name '*.go' | xargs wc -l`,
  `xargs -n1`, `xargs -I{}` (multiple invocations per line).
- **diff, cmp** — uutils/diffutils, one multicall binary (like coreutils'
  own) dispatching on argv[0]/binary name, registered under both names
  (same CID). `patches/diffutils.patch`: `cmp.rs` used
  `std::os::unix::fs::MetadataExt` unconditionally for an optimization
  (skip comparing when stdout is `/dev/null`) and `.size()` for file
  sizes; WASI's equivalent (`std::os::wasi::fs::MetadataExt`) exists but
  is nightly-only (`wasi_ext`, rust-lang/rust#71213) on stable 1.98.1, so
  the patch drops the `/dev/null` fast path under wasi (behavior is
  unaffected beyond that one optimization) and uses the portable
  `Metadata::len()` for sizes.
- **jq** — 01mf02/jaq (a jq clone), built `-p jaq --no-default-features`
  (drops the `mimalloc` allocator; `jaq-all`'s own defaults, formats +
  std-all, stay on — so `--from yaml`/`--to yaml` etc. work). Unpatched
  build still fails: `rustyline` (for the `repl` filter builtin, callable
  from inside a jq program) is a required, not optional, dependency, and
  pulls in `fd-lock` via its `with-file-history` feature, which does not
  build for wasm32-wasip1 at all (`sys::AsOpenFile`/`RwLockWriteGuard` not
  found — no `wasi` backend in that crate version). `patches/jaq.patch`
  moves `rustyline`/`dirs` into
  `[target.'cfg(not(target_os = "wasi"))'.dependencies]` and stubs
  `repl()`'s implementation under wasi to return an error ("not available
  (no terminal under the skein WASI host)") instead of silently doing
  nothing — WASI has no termios/ioctl, so there is no real terminal to
  back a REPL either way, same as the skein shell itself.
- **which** — no Rust `which` CLI exists on crates.io, only a library
  (`which`). First-party, `wasm/tools/which` (~50 lines): checks `$PATH`
  entries as files first (`std::env::split_paths` is unimplemented under
  wasm32-wasip1 — "unsupported" panic — so `PATH` is split on `:` by
  hand), then falls back to the host's `skein.cmd_exists` import (the
  same one brush uses to resolve builtins/coreutils/other extra modules
  that are never files in the tree) and prints the bare name — matching
  how brush itself resolves a name not on `$PATH` (see `brush.patch`
  above). Supports `-a`/`--all`.
- **grep** — no GNU-grep-flag-compatible CLI exists in Rust (ripgrep is
  the closest but explicitly disclaims GNU/POSIX flag compatibility:
  different defaults, no `-E`, always-recursive). First-party,
  `wasm/tools/grep`, built directly on the libraries ripgrep itself is
  built from (`grep-matcher`, `grep-regex`, `grep-searcher`, all pure
  Rust). Covers `-r -R -n -i -E -l -v -c -H -h -o -e`, multiple files,
  stdin, and a plain single-threaded deterministic recursive walk (no
  `ignore::WalkParallel`; sorted, since the skein host needs deterministic
  output). Memory maps are never used (`grep-searcher`'s
  `MmapChoice::never()` is already its default — `memmap2` is a
  dependency but is a no-op/errors under WASI at runtime, so this
  matters). **Known gap**: `-E` is accepted but has no effect — patterns
  are always parsed in `grep-regex`'s own syntax (close to POSIX ERE /
  Rust `regex` syntax), never true POSIX BRE (where `( ) { } + ? |` are
  literal unless backslash-escaped). Only affects patterns that lean on
  that BRE/ERE distinction; literal-word searches (`grep -rn TODO`) and
  already-ERE-style patterns behave identically either way.
- **sed** — uutils/sed 0.2.0, unpatched build compiles clean, but has a
  real bug reproducible outside skein/wasm entirely (checked with a
  native build, no patch): `-i`'s clap `Arg` is `num_args(0..=1)` with a
  `default_missing_value`, and clap's optional-value handling for that
  combination swallows the *next* argv entry as the backup suffix even
  though GNU sed only ever takes an attached suffix (`-i.bak`). So
  `sed -i 's/x/y/' f` — overwhelmingly the most common form, and the
  one issue #13 asks to test — treated `'s/x/y/'` as the suffix and `f`
  as the script, and failed. `patches/sed.patch` adds
  `.require_equals(true)`, which fixes the common bare-`-i` case at the
  cost of GNU's attached-without-`=` short form: a backup suffix now
  needs `-i=.bak` (or `--in-place=.bak`) instead of `-i.bak`. Tested:
  `sed -i 's/x/y/'`, `sed -n '2,4p'`, multiple `-e`, `--in-place`.
- **awk** — quinnjr/rawk (crate `awk-rs`) v0.2.0, unpatched; minimal deps
  (`regex`, `thiserror`) build clean. The only other Rust awk
  implementations (`frawk`, its `zawk` fork, `awkrs`) hard-depend on a
  `cranelift`-JIT or similar exec-page-needing backend and cannot run
  under WASI at all — not a build failure, a fundamental incompatibility
  (no interpreter fallback). Tested: field splitting (`$1`/`$2`), `-F`,
  `BEGIN`/`END` blocks, multi-line input over a pipe.
- **tree** — peteretelej/tree (crate `rust_tree`) v1.3.0, unpatched.

### wasi-sdk

findutils' `onig` dependency (Oniguruma, the regex engine behind `-regex`/
`-iregex`/`-name`) is a C library compiled via the `cc`/`onig_sys` build
script; the Rust `wasm32-wasip1` target's bundled wasi-libc is not a C
*compiler*, so `cc` has nothing to compile C with and fails
(`fatal error: 'stdlib.h' file not found`). `scripts/build-wasm.sh` fetches
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk) 34.0 into
`.build/wasi-sdk/` (once; ~190 MB, cached after) and points `CC_wasm32_wasip1`/
`CFLAGS_wasm32_wasip1` at its clang + sysroot, only for the findutils step.

### Not attempted

- **`tar`, `gzip`/`gunzip`, `zip`/`unzip`** — no Rust project publishes a
  GNU-tar- or gzip-flag-compatible CLI (only libraries: `tar`, `flate2`,
  the `zip` crate); the closest all-in-one CLI, `ouch`, hard-depends on
  `rayon` (real threads, unlikely to run under WASI preview1) and has its
  own flag syntax regardless. The issue's own phrasing ("if a Rust port
  builds") treats these as opportunistic, unlike `which`/`grep` which it
  asks for outright — building bespoke wrapper CLIs for three formats was
  out of scope for this pass; flagging honestly rather than shipping a
  half-compatible wrapper.
- **`xxd`/`hexdump`** — no xxd-flag-compatible Rust CLI exists (`hexyl` is
  a real, maintained hex *viewer* but a different output format, no `-r`
  reverse mode; `xxd-rs` is stale, pre-1.0 deps). `od` (already in
  `feat_wasm`, e.g. `od -A x -t x1z`) covers the practical need already,
  so this was not pursued further.
- **`yq`** — no standalone pure-Rust `yq` CLI exists (the closest,
  `clux/lq`, literally shells out to a `jq` binary — impossible for us,
  no subprocess). Not a gap in practice: jaq's own format flags cover it —
  `jq --from yaml <filter> file.yaml` (or `--to yaml`) — since `jq.wasm`
  is already built with jaq-all's `formats` feature on. No separate `yq`
  command is registered (registering one under a different argv0 without
  it defaulting to YAML would be a false advertisement of `yq`'s actual
  ergonomics).

## Script runtimes (issue #25)

Skill scripts that use only files and stdio run unmodified: `python3 x.py`,
`node x.js`, `qjs x.mjs`, or `./x` for a `#!` script whose interpreter
(its basename, through `/usr/bin/env`, skipping `env -S`) is one of the
shell's extra programs; any other `#!` still runs under brush. Nothing in
either runtime reaches a network, a process or a wall clock: every clock
read is the runtime's `clock_time_get` (fixed outside a thread, the log
entry's time inside one) and every random byte is the runtime's
`random_get` stream. `src/runtime/scripts.test.ts` checks both. Outside a
thread (`runShell` given no `clock` and no `sleep`), a sleep now moves the
run's virtual clock to its deadline instead of returning with time
unchanged: QuickJS's timers loop until the monotonic clock reaches their
deadline, and with a clock that never moved `setTimeout` spun forever.
Inside a thread the scheduler supplies both, as before.

### qjs / node — QuickJS-ng

Built from source with wasi-sdk's `wasi-sdk-p1.cmake` (`qjs_exe`, Release,
`-DSKEIN_PRELUDE`), stripped with wasi-sdk's `llvm-strip`. ES2023 modules
and scripts (autodetected; `.mjs` is a module), plus QuickJS's own
`qjs:std` / `qjs:os` / `qjs:bjson` modules (`--std` makes them globals).
No TypeScript: a `.ts` file is not stripped of its types.

`patches/quickjs.patch` (all under `#ifdef SKEIN_PRELUDE`):
- `qjs.c` evaluates the modules of `tools/qjs/` (compiled in as C strings
  by `tools/qjs/gen-prelude.mjs`) before the script: `prelude.js` always —
  `console.log/info/debug` on stdout, `console.error/warn/trace` on stderr,
  with a Node-like value formatter and `%s %d %i %f %j %o %O` (upstream has
  only `console.log`, printing objects as `[object Object]`); and, when
  argv[0] is `node`, `node.js` plus the named modules `fs`, `fs/promises`,
  `path`, `process`, `buffer` (bare and `node:`-prefixed). As `node` the
  exit status is `process.exitCode` once the event loop drains.
- `quickjs.c` seeds `Math.random` from `getentropy` (the runtime's
  `random_get`) instead of the clock.

What `node` is — a shim, not Node.js:

| available | not available |
|---|---|
| `process.argv` (`["node", <abs script>, …args]`), `argv0`, `env`, `exit()`, `exitCode`, `cwd()`, `chdir()`, `platform` (`"wasi"`), `arch`, `stdout.write`, `stderr.write`, `nextTick`, `versions.quickjs` | `process.version`, `hrtime`, `memoryUsage`, `on('exit')` (a no-op), `stdin` as a stream (read it with `fs.readFileSync(0)`) |
| `fs` sync: `readFileSync` (path or fd 0), `writeFileSync`/`appendFileSync` (path or fd 1/2), `existsSync`, `accessSync`, `statSync`/`lstatSync` (`isFile`/`isDirectory`/`isSymbolicLink`, `size`), `readdirSync` (`withFileTypes` too), `mkdirSync` (`recursive`), `rmSync`, `rmdirSync`, `unlinkSync`, `renameSync`, `copyFileSync`, `realpathSync`, `readlinkSync`, `symlinkSync`; `fs/promises` and `fs.promises`: the same, resolved | streams (`createReadStream`…), callback-style `fs.readFile(p, cb)`, `watch`, `chmod`, file descriptors (`openSync`…) |
| `path` (POSIX): `join`, `resolve`, `normalize`, `dirname`, `basename`, `extname`, `relative`, `isAbsolute`, `parse`, `format`, `sep`, `delimiter` | `path.win32` |
| `Buffer`: a `Uint8Array` with `toString(enc)`, `from`, `alloc`, `concat`, `isBuffer`, `byteLength`, `equals`; utf8, hex, base64, latin1/binary, ascii | the rest of Buffer's API (`readUInt32LE`, `write`…) |
| `require` of those modules and of relative `.js`/`.cjs`/`.json` files; `module`, `exports`, `__filename`, `__dirname`, `global` | npm packages / `node_modules` resolution; `child_process`, `http`/`https`/`net`/`dns`, `fetch`, `crypto`, `os`, `util`, `events`, `stream`, `zlib`, `worker_threads`, `url`, … — `require` throws `MODULE_NOT_FOUND` naming the module; an `import` fails to load it |
| `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`setImmediate` (global, over QuickJS's `qjs:os` timers; the waits are the runtime's sleeps), `queueMicrotask`, `atob`/`btoa` | `URL`, `TextEncoder`/`TextDecoder`, `structuredClone`, `AbortController`, `performance` |

### python / python3 — CPython 3.14.7

Not built here: the WASI build CPython's own WASI maintainer publishes
(brettcannon/cpython-wasi-build, wasi-sdk 24), pinned by version and by the
SHA-256 of the release zip, then stripped of DWARF (30.5 → 7.6 MB).
Building CPython ourselves would add a CPython checkout, its `Tools/wasm`
driver and a native build Python for no functional gain today.

The stdlib is `wasm/python314.zip`: `lib/python3.14` of the same release,
every `.py` file, packed **stored** (the build has no `zlib`, so
`zipimport` could not inflate) with fixed timestamps, sorted. It is a raw
block like the modules (`FILES` in `src/runtime/programs.ts`,
`skein-dev install` puts it in the store). The shell mounts it read-only
for python processes only (`Modules.support`, a second WASI preopen) at
`/opt/skein/python/lib/python314.zip`, with `PYTHONHOME=/opt/skein/python`
and `PYTHONDONTWRITEBYTECODE=1` as environment defaults (the caller's env
wins). The mount is not in the tree, never committed, and other programs
do not see it; writes to it fail with EROFS. The tree's own `/usr/local`
is untouched, so pure-Python dependencies can live in the tree (next to a
script, or on `PYTHONPATH`).

Determinism, verified (`scripts.test.ts`): `time.time()`,
`time.monotonic()`, `datetime.now()` read `clock_time_get` → the runtime's
clock; `random` seeds from `os.urandom` → `random_get`; the `str` hash seed
(`hash()`, set iteration order) and `uuid.uuid4()` too — same `seed`, same
values; another seed, others. `time.sleep` is the runtime's sleep.

Not available: `zlib` (so `gzip`, `zipfile` deflate, `tarfile.gz`),
`_ssl`/`ssl`, sockets (`socket`, `urllib.request`, `http.client` fail at
`getaddrinfo`), `subprocess`/`os.system` (`ENOTSUP`), threads
(`RuntimeError: can't start new thread`), `sqlite3`, `ctypes`, `_lzma`,
`_bz2`, pip / third-party packages (none installed; pure-Python ones can be
put in the tree). Imports compile from source every run (no `.pyc` in the
zip, and none written): start-up is about 0.3 s, importing json/argparse/
re/pathlib/csv/datetime/dataclasses/hashlib about 0.6 s, on the dev
machine.

Size options if 19 MB matters: drop test/IDE-only packages from the zip
(`_pyrepl`, `pydoc_data`, `turtle` — about 1.2 MB; the release already
leaves out `test`, `idlelib`, `tkinter`, `ensurepip`); add `.pyc` (faster imports, roughly
doubles the zip) or ship `.pyc` only (no source in tracebacks); or build
CPython ourselves with zlib and a deflated zip (~2.4 MB).
