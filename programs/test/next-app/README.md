The host's test app (`src/host/*.test.ts`): the kernel's skein-next test program
(`kernel-zig/test/call/next.zig`, built by `kernel-zig/test/call/build-next.sh`; `bin/next.wasm` is a copy of
its `next.wasm`) installed as the app `next`, role `main`. Its rows are under `/next/`; the program's
`handle` emits the fact `next/ping` and advances `next/spent` only for the paths `/ping` and `/spend`, which a
test names as root's own rows (an image's etc/apps.json `routes`).
