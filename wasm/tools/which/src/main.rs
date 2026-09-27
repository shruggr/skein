// A small `which` for the skein WASI host, first-party: no upstream Rust
// project ships a `which` CLI (the `which` crate is a library only, and its
// executable-bit checks don't mean anything under WASI preview1 anyway —
// this host, like brush's patched fs.rs, treats "exists" as "executable").
//
// Usage: which [-a] name...
//   -a  print every match on $PATH, not just the first
// Exit 0 if every name was found, 1 if any was not (GNU `which`'s contract).

use std::env;
use std::path::{Path, PathBuf};

// Most commands here (coreutils, brush builtins, the other single-purpose
// programs) are never files in the tree — the host dispatches them by name
// (shell.ts `exists`/`spawn`). Ask it directly, the same way brush resolves
// a bare name not found on $PATH (wasm/README.md, "a name not found on $PATH
// resolves to itself when the host has a program by that name").
#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "skein")]
unsafe extern "C" {
    #[link_name = "cmd_exists"]
    fn host_cmd_exists(name: *const u8, len: usize) -> i32;
}
#[cfg(target_os = "wasi")]
fn host_has(name: &str) -> bool {
    unsafe { host_cmd_exists(name.as_ptr(), name.len()) == 1 }
}
#[cfg(not(target_os = "wasi"))]
fn host_has(_name: &str) -> bool {
    false
}

fn candidates(name: &str) -> Vec<PathBuf> {
    if name.contains('/') {
        return vec![PathBuf::from(name)];
    }
    // std::env::split_paths is unimplemented under wasm32-wasip1 (there is no
    // platform notion of a path list); PATH here is always ':'-separated,
    // set by the skein shell (shell.ts), so split on that directly.
    let path = env::var("PATH").unwrap_or_default();
    path.split(':').filter(|d| !d.is_empty()).map(|dir| Path::new(dir).join(name)).collect()
}

fn main() {
    let mut all = false;
    let mut names = Vec::new();
    for arg in env::args().skip(1) {
        match arg.as_str() {
            "-a" | "--all" => all = true,
            "--" => {}
            _ => names.push(arg),
        }
    }
    if names.is_empty() {
        eprintln!("usage: which [-a] name...");
        std::process::exit(2);
    }
    let mut ok = true;
    for name in &names {
        let mut found = false;
        for cand in candidates(name) {
            if Path::new(&cand).is_file() || Path::new(&cand).is_symlink() {
                println!("{}", cand.display());
                found = true;
                if !all {
                    break;
                }
            }
        }
        if !found && !name.contains('/') && host_has(name) {
            println!("{name}");
            found = true;
        }
        if !found {
            ok = false;
        }
    }
    std::process::exit(if ok { 0 } else { 1 });
}
