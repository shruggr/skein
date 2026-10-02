# Skill scripts in the VM

The bopen.ai agents reference 280 skills (#22, scope comment); 68 bundle
scripts. This is where each of those stands now that the shell has `qjs` /
`node` (QuickJS-ng + a file/stdio shim) and `python3` (CPython 3.14, stdlib
only) — issue #25; what each runtime does and does not provide is in
`wasm/README.md`, "Script runtimes". Audit of 2026-09-27, read from the
skill sources (none were run on a host); `content-scorer`,
`experiment-stats` and `remind` were also run inside the VM.

Categories:

- **A** — runs as is today.
- **B** — runs after a trivial edit (named).
- **C** — needs only HTTP: a message to the fetch provider (the web proxy,
  docs/MESSAGES.md "The providers"), which no script runtime in the shell
  exposes yet. The TypeScript ones are plain JS
  plus type annotations; they also need their types stripped, since
  qjs does not run `.ts` (strip at install, or add a strip step to `node`).
- **D** — needs third-party npm/pip packages bundled into the tree (pure JS/
  Python, so bundling works); network as noted.
- **E** — needs a peer: a native binary (`curl`, `gh`, `git`, `ffmpeg`,
  `sharp`, a browser, `codeql`…), a running service, or an API-key service.
  Shell scripts that call `curl` are here, not C: no `curl` exists in the
  shell until one is built over the fetch provider.
- **other** — something else in the runtime (named).

| skill | lang | agents | cat | why |
|---|---|---|---|---|
| agent-development | sh | 3 | A | grep/sed/awk frontmatter validator |
| code-audit-scripts | sh | 2 | A | grep/sed/cut text scanning |
| codex-security | sh | 2 | A | `command -v` probe only; never runs the scanner |
| content-scorer | py | 1 | A | stdlib only (ran in the VM) |
| experiment-stats | py | 1 | A | stdlib only, seeded RNG (ran in the VM) |
| hook-development | sh | 1 | A | bash + jq hook linter |
| runtime-context | sh | 3 | A | `command -v`/find capability detection |
| visual-coordinator | sh+py | 1 | A | `command -v` probes; reports "unavailable" gracefully |
| perf-audit | sh | 1 | B | `stat -c%s` → `wc -c` in 2 of 4 scripts (gzip use already guarded) |
| 1sat-stack | ts | 1 | C | fetch api.1sat.app, no key |
| auth-md | py | 1 | C | stdlib urllib/socket/ssl probe (ssl also missing today) |
| check-bsv-price | ts | 2 | C | fetch whatsonchain, no key |
| lookup-block-info | ts | 1 | C | fetch block API, no key |
| lookup-bsv-address | ts | 2 | C | fetch whatsonchain, no key |
| ordinals-marketplace | ts | 3 | C | fetch public 1sat API, no key |
| setup-nextjs | ts | 2 | C | health-check fetch; other two scripts type-only |
| stack-api | ts | 2 | C | fetch api.1sat.app, no key |
| decode-bsv-transaction | ts | 2 | D | @bsv/sdk; keyless fetch (junglebus/whatsonchain) |
| geo-optimizer | py | 2 | D | requests + bs4 (and a `pip install` fallback via subprocess) |
| ordinals-create | ts | 2 | D | @1sat/actions, @1sat/wallet-remote, @bsv/sdk; network |
| wallet-brc100 | ts | 1 | D | @bsv/sdk (get-balance is a mock) |
| wallet-create-ordinals | ts | 1 | D | @1sat/actions, @1sat/wallet-remote; network |
| wallet-encrypt-decrypt | ts | 1 | D | @bsv/sdk + node:crypto; local only |
| wallet-send-bsv | ts | 1 | D | @bsv/sdk; UTXO fetch, ARC broadcast |
| remind | py | 4 | other | `sqlite3`: not in the WASI build (`_sqlite3` missing) |
| ask-gemini | ts | 2 | E | @google/genai + GEMINI_API_KEY |
| blockchain-media | ts | 2 | E | spawns native `txex` |
| brainstorming | sh+js | 1 | E | runs a Node http/WebSocket server |
| browsing-styles | ts | 4 | E | sharp + Gemini key + Bun.serve |
| check-version | sh | 2 | E | curl to GitHub raw |
| chrome-cdp | ts | 5 | E | CDP to a running Chrome |
| clawnet-cli | sh | 5 | E | clawnet/vercel CLIs, bun |
| codeql | py+sh | 4 | E | native `codeql` |
| deck-creator | ts | 5 | E | bun/next dev server, opens a browser |
| devops-scripts | sh | 1 | E | vercel/railway/redis-cli/psql |
| edit-image | ts | 2 | E | Gemini/OpenAI image API key |
| encrypt-decrypt-backup | ts | 3 | E | spawns native `bbackup` |
| extract-blockchain-media | ts | 1 | E | spawns native `txex` |
| generate-icon | ts | 1 | E | sharp + Gemini/Replicate key |
| generate-image | ts | 4 | E | Gemini/OpenAI/xAI image API key |
| generate-svg | ts | 3 | E | Quiver/Gemini key |
| generate-video | ts | 3 | E | Gemini/Replicate/xAI video API key |
| html-to-pdf | ts | 1 | E | playwright Chromium |
| nextjs-upgrade | sh | 1 | E | node/npm/bun toolchain |
| notebooklm | py | 2 | E | patchright/Playwright browser, venv/pip |
| npm-publish | sh | 2 | E | npm/bun/git, OAuth browser login |
| optimize-images | ts | 3 | E | sharp |
| paperclip | sh | 1 | E | curl + PAPERCLIP_API_KEY |
| pdf | py | 1 | E | pdf2image needs poppler; Pillow (native) |
| persona | sh+ts | 4 | E | X/GitHub/xAI keys + Hono server |
| saas-launch-audit | sh | 2 | E | curl + openssl |
| schedule-social-post | sh | 1 | E | curl + OAuth device flow (bopen.ai) |
| section-dividers | ts | 1 | E | sharp + Replicate key |
| segment-image | ts | 2 | E | Gemini API key |
| semgrep | sh+py | 6 | E | native `semgrep` |
| skill-creator | py | 4 | E | subprocess `claude` CLI |
| software-factory | sh | 5 | E | `gh` |
| ui-audio-theme | py | 3 | E | ElevenLabs key + ffmpeg |
| upscale-image | ts | 2 | E | Vertex AI + `gcloud auth` |
| visual-planner | ts | 2 | E | Bun.spawn `bun install`/`bun run` |
| voice-clone | ts | 1 | E | ffmpeg + ElevenLabs key |
| wait-for-ci | sh | 1 | E | gh/vercel/glab, git |
| webapp-testing | py | 2 | E | subprocess dev servers |
| x-research | sh | 3 | E | curl + XAI_API_KEY |
| x-tweet-search | sh | 2 | E | curl + X_BEARER_TOKEN |
| x-user-lookup | sh | 3 | E | curl + X_BEARER_TOKEN |
| x-user-timeline | sh | 3 | E | curl + X_BEARER_TOKEN |
| x402 | py | 1 | E | local MetaNet Client wallet + requests |

**Totals (68):** A 8, B 1, C 8, D 7, other 1, E 43. By language (a skill
mixing two counts under both): TypeScript 33 — none runs as is (C 7,
D 6, E 20); shell 25 — A 5 (+ visual-coordinator), B 1, rest E; Python 14 —
A 2 (+ visual-coordinator), C 1, D 1, other 1, E 8.

What would move the most rows: an HTTP client for shell scripts over
the fetch provider plus the API-key peers (the `curl` + key rows: x-*,
paperclip, check-version…); a TypeScript strip step plus that client (all of C);
bundling `@bsv/sdk` / `@1sat/*` into the tree (most of D, which then also
needs the fetch provider and, for signing, the wallet binding); `sqlite3` in the Python
build (remind).
