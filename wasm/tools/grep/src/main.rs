// A GNU-grep-flag-compatible `grep` for the skein WASI host. No upstream
// Rust project is both a real GNU grep clone and wasm32-wasip1-buildable
// (ripgrep is the closest, but its own docs disclaim GNU/POSIX flag
// compatibility) — see wasm/README.md for the survey. This is built on the
// same crates ripgrep itself is built from (grep-matcher, grep-regex,
// grep-searcher — all pure Rust, no mmap at runtime: memory_map() is left
// at its default, MmapChoice::never()), with a small GNU-flag-shaped CLI on
// top covering: -r -R -n -i -E -l -v -c -H -h -o, plus -e/--regexp for
// multiple patterns.
//
// Known gap: patterns are always parsed as grep-regex's own syntax (close to
// POSIX ERE / Rust `regex` syntax), regardless of -E. True POSIX BRE (where
// `(`, `)`, `{`, `}`, `+`, `?`, `|` are literal unless backslash-escaped) is
// not implemented. This matters only for patterns that use those characters
// as metacharacters without -E; literal-word searches and already-ERE-style
// patterns (the common case) behave identically either way.

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

struct Opts {
    recursive: bool,
    line_number: bool,
    ignore_case: bool,
    files_with_matches: bool,
    invert: bool,
    count: bool,
    force_filename: bool,
    suppress_filename: bool,
    only_matching: bool,
}

fn usage() -> ! {
    eprintln!("usage: grep [-rRniElvcHho] [-e PATTERN]... [PATTERN] [FILE...]");
    std::process::exit(2);
}

fn main() -> ExitCode {
    let mut opts = Opts {
        recursive: false,
        line_number: false,
        ignore_case: false,
        files_with_matches: false,
        invert: false,
        count: false,
        force_filename: false,
        suppress_filename: false,
        only_matching: false,
    };
    let mut patterns: Vec<String> = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    let mut end_of_opts = false;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if end_of_opts || arg == "-" || !arg.starts_with('-') {
            positional.push(arg.clone());
            i += 1;
            continue;
        }
        if arg == "--" {
            end_of_opts = true;
            i += 1;
            continue;
        }
        if let Some(rest) = arg.strip_prefix("--") {
            match rest {
                "recursive" => opts.recursive = true,
                "line-number" => opts.line_number = true,
                "ignore-case" => opts.ignore_case = true,
                "extended-regexp" => {}
                "files-with-matches" => opts.files_with_matches = true,
                "invert-match" => opts.invert = true,
                "count" => opts.count = true,
                "only-matching" => opts.only_matching = true,
                "with-filename" => opts.force_filename = true,
                "no-filename" => opts.suppress_filename = true,
                _ if rest.starts_with("regexp=") => {
                    patterns.push(rest["regexp=".len()..].to_string());
                }
                "regexp" => {
                    i += 1;
                    if i >= args.len() {
                        usage();
                    }
                    patterns.push(args[i].clone());
                }
                _ => usage(),
            }
            i += 1;
            continue;
        }
        // Short flags, possibly bundled (-rn, -il, ...).
        let chars: Vec<char> = arg[1..].chars().collect();
        let mut j = 0;
        while j < chars.len() {
            match chars[j] {
                'r' | 'R' => opts.recursive = true,
                'n' => opts.line_number = true,
                'i' => opts.ignore_case = true,
                'E' => {}
                'l' => opts.files_with_matches = true,
                'v' => opts.invert = true,
                'c' => opts.count = true,
                'H' => opts.force_filename = true,
                'h' => opts.suppress_filename = true,
                'o' => opts.only_matching = true,
                'e' => {
                    // -ePATTERN or -e PATTERN
                    let rest: String = chars[j + 1..].iter().collect();
                    if !rest.is_empty() {
                        patterns.push(rest);
                    } else {
                        i += 1;
                        if i >= args.len() {
                            usage();
                        }
                        patterns.push(args[i].clone());
                    }
                    j = chars.len();
                    continue;
                }
                _ => usage(),
            }
            j += 1;
        }
        i += 1;
    }

    if patterns.is_empty() {
        if positional.is_empty() {
            usage();
        }
        patterns.push(positional.remove(0));
    }
    let files = positional;

    let mut builder = RegexMatcherBuilder::new();
    builder.case_insensitive(opts.ignore_case);
    let matcher = match builder.build_many(&patterns) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("grep: {e}");
            return ExitCode::from(2);
        }
    };

    // Recursive mode expands directory arguments (and a bare directory
    // without -r is an error, like GNU grep).
    let mut error = false;
    let mut sources: Vec<PathBuf> = Vec::new();
    if files.is_empty() {
        sources.push(PathBuf::new()); // stdin, marked by an empty path
    } else {
        for f in &files {
            let p = PathBuf::from(f);
            if p.is_dir() {
                if opts.recursive {
                    walk(&p, &mut sources);
                } else {
                    eprintln!("grep: {f}: Is a directory");
                    error = true;
                }
            } else {
                sources.push(p);
            }
        }
    }

    let show_name = !opts.suppress_filename && (opts.force_filename || files.len() > 1 || opts.recursive);
    let mut searcher = SearcherBuilder::new();
    searcher.line_number(opts.line_number).invert_match(opts.invert);
    let mut searcher = searcher.build();

    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut any_match = false;

    for src in &sources {
        let label = if src.as_os_str().is_empty() { None } else { Some(src.to_string_lossy().into_owned()) };
        let (count, any, werr, result) = {
            let mut sink = GrepSink {
                matcher: &matcher,
                opts: &opts,
                label: label.as_deref(),
                show_name,
                count: 0,
                any: false,
                out: &mut out,
                werr: false,
            };
            let result = if let Some(l) = &label {
                searcher.search_path(&matcher, l, &mut sink)
            } else {
                let mut buf = Vec::new();
                if let Err(e) = io::stdin().read_to_end(&mut buf) {
                    eprintln!("grep: stdin: {e}");
                    error = true;
                    continue;
                }
                searcher.search_slice(&matcher, &buf, &mut sink)
            };
            (sink.count, sink.any, sink.werr, result)
        };
        if let Err(e) = result {
            eprintln!("grep: {}: {e}", label.as_deref().unwrap_or("stdin"));
            error = true;
            continue;
        }
        if werr {
            error = true;
        }
        if opts.count && !opts.files_with_matches {
            if show_name {
                let _ = write!(out, "{}:", label.as_deref().unwrap_or("(standard input)"));
            }
            let _ = writeln!(out, "{count}");
        }
        if opts.files_with_matches && any {
            let _ = writeln!(out, "{}", label.as_deref().unwrap_or("(standard input)"));
        }
        any_match = any_match || any;
    }

    let _ = out.flush();
    if error {
        ExitCode::from(2)
    } else if any_match {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    // A plain, single-threaded, deterministic recursive walk (the skein host
    // requires deterministic output; std::fs::read_dir's order here comes
    // from the tree VFS, already deterministic — see src/runtime/wasi/vfs.ts).
    // Symlinks are not followed, matching GNU grep -r's default.
    let mut entries: Vec<_> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(e) => {
            eprintln!("grep: {}: {e}", dir.display());
            return;
        }
    };
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            walk(&path, out);
        } else if file_type.is_file() {
            out.push(path);
        }
    }
}

struct GrepSink<'a> {
    matcher: &'a RegexMatcher,
    opts: &'a Opts,
    label: Option<&'a str>,
    show_name: bool,
    count: u64,
    any: bool,
    out: &'a mut dyn Write,
    werr: bool,
}

impl<'a> GrepSink<'a> {
    fn write_prefix(&mut self, line_number: Option<u64>) {
        if self.show_name {
            if write!(self.out, "{}:", self.label.unwrap_or("(standard input)")).is_err() {
                self.werr = true;
            }
        }
        if self.opts.line_number {
            if let Some(n) = line_number {
                if write!(self.out, "{n}:").is_err() {
                    self.werr = true;
                }
            }
        }
    }
}

impl<'a> Sink for GrepSink<'a> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        self.any = true;
        self.count += 1;

        if self.opts.files_with_matches {
            return Ok(false); // one match is enough to name the file
        }
        if self.opts.count {
            return Ok(true); // tally only; printed once after the search
        }

        let line = mat.bytes();
        if self.opts.only_matching {
            let mut werr = false;
            let out = &mut self.out;
            let matcher = self.matcher;
            let show = self.show_name;
            let label = self.label;
            let ln = self.opts.line_number.then(|| mat.line_number()).flatten();
            let _ = matcher.find_iter(line, |m| {
                if show && write!(out, "{}:", label.unwrap_or("(standard input)")).is_err() {
                    werr = true;
                }
                if let Some(n) = ln {
                    if write!(out, "{n}:").is_err() {
                        werr = true;
                    }
                }
                if out.write_all(&line[m.start()..m.end()]).is_err() || out.write_all(b"\n").is_err() {
                    werr = true;
                }
                true
            });
            if werr {
                self.werr = true;
            }
        } else {
            self.write_prefix(mat.line_number());
            if self.out.write_all(line).is_err() {
                self.werr = true;
            }
            if !line.ends_with(b"\n") && self.out.write_all(b"\n").is_err() {
                self.werr = true;
            }
        }
        Ok(true)
    }
}
