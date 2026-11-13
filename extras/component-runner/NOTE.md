# The component runner (moved out of the kernel, skein next)

Source as at skein v0.9.1 (kernel-zig/src/component.zig, component_web.zig, component_test.zig,
and its fixtures kernel-zig/test/components/ → test-components/), moved here unchanged by the
skein-next kernel build (SPEC.md section 5). Not built, not tested here, until David says where it
lives.

What it was: WASI 0.2 components run over wasmtime's component API (native only; the browser
build had component_web.zig, a stub), told apart from preview1 modules by their preamble in
kernel-zig/src/runner.zig (`component.isComponent`, `Compiled.comp`). No app shipped a component.
The WIT world it bound is skein-sdk wit/skein.wit.
