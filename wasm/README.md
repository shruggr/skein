# wasm/

The programs the wasm shell (`src/runtime/shell.ts`) runs. Both are WASI preview1
modules (`wasm32-wasip1`), built with Rust 1.98.1 and stripped of symbols.
`scripts/build-wasm.sh` rebuilds both from the pinned sources plus
`patches/`, byte-identically on the same machine (paths of the build
machine appear in panic strings, so another machine gets other bytes).

| file             | size    | source                                                                  |
|------------------|---------|-------------------------------------------------------------------------|
| `brush.wasm`     | 4.9 MB  | reubeno/brush `739a15d` (main, 2026-09-25), `--no-default-features --features minimal`, + `patches/brush.patch` |
| `coreutils.wasm` | 10.0 MB | uutils/coreutils `0.12.0` (`dc1efd8`), `--no-default-features --features feat_wasm`, + `patches/coreutils.patch` |

sha256 (as committed):

```
8cb0968d6ffa31244a7d7dd7d15bd92e1b8cd37f2e5cd172f9e53f6896bc1417  brush.wasm
6e3be82e9b08e5e2ebace2dfbf1c74ea7a2f30045f92dba9a06419201b08c491  coreutils.wasm
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
