# The shell runner (moved out of the kernel, skein next)

Source as at skein v0.9.1 (kernel-zig/src/shell.zig, kernel-zig/src/cmd_shell.zig), moved here
unchanged by the skein-next kernel build (SPEC.md section 5: "Out of the kernel but kept as tools
in a home of their own"). Not built, not tested here, until David says where it lives.

What it was: the kernel ran `code: {ts: "shell"}` program records (brush + coreutils over the
kernel's copy-on-write git tree, kernel-zig/src/vfs.zig) as threads; `skein-kernel shell` (cmd_shell.zig)
ran shell cases for equiv/git.ts. A shell's `sleep` rested the thread on the kernel's `deadline`
intention, which skein next removes (SPEC.md section 5) — bringing it back needs a timer service
answer instead.

What it needs from the kernel it came out of: wasi.zig's process services (`spawn`, `pipe`,
`cmd_exists`, `sleep`, `Park`), vfs.zig, tree.zig, objects.zig, runner.zig's shell bindings, and the
scheduler's shell section (ShellRun, runShellThread, shellBody, shSleep — at v0.9.1
kernel-zig/src/scheduler.zig:3563-3864).
