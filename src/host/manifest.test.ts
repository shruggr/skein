// The app manifest's checks (#72, #76, #77, #79; manifest.ts): the fields, the
// dispatch rows (addresses relative to /<app>/, the escapes, the senders —
// `event` and `$self` since #79), the form before #77 refused (#79), an
// overlay app's derived wiring, a shell program's form (#83), and `requires`
// against what the installed apps provide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appPath, checkManifest, ManifestError, missingInterfaces, overlayWiring, rowKey, shapeProblem } from "./manifest.ts";

const files = new Set(["bin/demo.wasm", "bin/engine.cid", "etc/app.json"]);
const has = (p: string) => files.has(p);
const base = () => ({
  kind: "app", name: "demo", version: "0.1.0",
  programs: { demo: "bin/demo.wasm" },
  provides: [{ interface: "demo.counter/1", functions: { get: { writes: false, args: {}, answer: { count: "int" } }, add: { writes: true, args: { by: "int", "note?": "string" } } } }],
  dispatch: [
    { address: "demo", sender: "*", program: "demo" },
    { address: "demo", sender: "$cron", program: "demo" },
    { address: "admin", sender: "$owner", program: "demo" },
    { transport: "http", address: "/call", sender: "session", program: "demo", fn: "call" },
  ],
});
const problems = (m: unknown): string[] => {
  try { checkManifest(m, has); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};
const keys = (m: unknown) => checkManifest(m, has).manifest.dispatch.map((r) => rowKey("demo", r));

test("a good manifest: its rows normalised (transport mailbox by default)", () => {
  const c = checkManifest(base(), has);
  assert.deepEqual(keys(base()), ["mailbox demo *", "mailbox demo $cron", "mailbox admin $owner", "http /demo/call session"]);
  assert.deepEqual(c.manifest.dispatch[0], { transport: "mailbox", address: "demo", sender: "*", program: "demo" });
  assert.deepEqual(c.sources.demo, { kind: "wasm", path: "bin/demo.wasm", name: "demo" });
});

test("programs: files in the tree, a pinned .cid, or an instance program by name", () => {
  const m = { ...base(), programs: { demo: "bin/demo.wasm", engine: "bin/engine.cid", door: "frontdoor" } };
  const c = checkManifest(m, has);
  assert.deepEqual(c.sources.engine, { kind: "cid", path: "bin/engine.cid", name: "engine" });
  assert.deepEqual(c.sources.door, { kind: "instance", name: "frontdoor" });
  assert.match(problems({ ...base(), programs: { demo: "bin/missing.wasm" } }).join("\n"), /bin\/missing\.wasm is not in the tree/);
  assert.match(problems({ ...base(), programs: { demo: "../x.wasm" } }).join("\n"), /is not bin\/<x>\.wasm/);
});

test("rows: the senders, the transports, the keys", () => {
  const key = `02${"ab".repeat(32)}`;
  const row = (r: Record<string, unknown>) => problems({ ...base(), dispatch: [{ address: "demo", sender: "*", program: "demo", ...r }] }).join("\n");
  assert.equal(row({ sender: key }), "");
  assert.equal(row({ sender: "$status" }), "");
  assert.equal(row({ sender: "$self" }), "");
  assert.equal(row({ sender: "event" }), "");
  assert.match(problems({ ...base(), dispatch: [{ transport: "http", address: "/x", sender: "event", program: "demo", fn: "f" }] }).join("\n"), /"event" is for mailbox rows/);
  assert.match(row({ sender: "anyone" }), /sender "anyone"/);
  assert.match(row({ sender: "session" }), /"session" is for http rows/);
  assert.match(row({ address: ":ack" }), /is not a box name/);
  assert.match(row({ transport: "local" }), /transport "local"/);
  assert.match(row({ program: "nobody" }), /program "nobody" is not a role/);
  assert.match(row({ app: "x" }), /app is set by the install/);
  assert.match(row({ prefix: true }), /a mailbox row has no prefix/);
  assert.match(problems({ ...base(), dispatch: [{ address: "demo", sender: "*", program: "demo" }, { address: "demo", sender: "*", program: "demo" }] }).join("\n"), /mailbox demo \* twice/);
  assert.match(problems({ ...base(), dispatch: [{ transport: "libp2p", address: "tm_x", sender: "$owner", program: "demo", fn: "f" }] }).join("\n"), /a libp2p row's sender is "\*"/);
  assert.match(problems({ ...base(), dispatch: [{ transport: "libp2p", address: "tm_x", sender: "*", program: "demo" }] }).join("\n"), /fn is not text/);
  assert.deepEqual(keys({ ...base(), dispatch: [{ transport: "libp2p", address: "/amm/1/swap", sender: "*", program: "demo", fn: "swap" }] }), ["libp2p /amm/1/swap *"]);
});

test("http rows are relative to /<app>/; escapes are refused", () => {
  assert.equal(appPath("demo", "/call"), "/demo/call");
  assert.equal(appPath("demo", "call"), "/demo/call");
  assert.equal(appPath("demo", "/"), "/demo/");
  assert.equal(appPath("demo", "a//b"), "/demo/a/b");
  const http = (address: string, more: Record<string, unknown> = {}) => problems({ ...base(), dispatch: [{ transport: "http", address, sender: "*", program: "demo", fn: "f", ...more }] }).join("\n");
  assert.equal(http("/x"), "");
  assert.equal(http("/site", { prefix: true, root: "www" }), "");
  assert.match(http("../x"), /a "\." or "\.\." segment/);
  assert.match(http("/a/./b"), /a "\." or "\.\." segment/);
  assert.match(http("/a%2fb"), /encoded dot or slash/);
  assert.match(http("https://x/y"), /is a URL or a scheme/);
  assert.match(http("/a?b"), /query/);
  assert.match(http("/x", { prefix: "yes" }), /prefix is true or absent/);
  assert.deepEqual(keys({ ...base(), dispatch: [{ transport: "http", address: "/site", prefix: true, sender: "*", program: "demo", fn: "get" }] }), ["http /demo/site* *"]);
});

test("shapes", () => {
  assert.equal(shapeProblem({ a: "int", "b?": ["string"], c: { d: "cid" }, e: "map", f: "any", g: "ms", h: "bytes", i: "bool" }, "args"), undefined);
  assert.match(shapeProblem(["int", "string"], "args")!, /one element shape/);
  assert.match(shapeProblem(3, "args")!, /a shape is a type name/);
});

test("name, version, provides, start/stop", () => {
  assert.match(problems({ ...base(), name: "Demo" }).join("\n"), /is not a name/);
  assert.match(problems({ ...base(), name: "dispatch" }).join("\n"), /stock box, head or program/);
  assert.match(problems({ ...base(), name: "frontdoor" }).join("\n"), /stock box, head or program/);
  assert.match(problems({ ...base(), version: "1" }).join("\n"), /not semver/);
  assert.match(problems({ ...base(), provides: [{ interface: "x", functions: {} }] }).join("\n"), /interface is not <name>\/<major>/);
  assert.match(problems({ ...base(), provides: [{ interface: "x/1", functions: { f: {} } }] }).join("\n"), /writes \(true \| false\) is required/);
  assert.match(problems({ ...base(), requires: ["x"] }).join("\n"), /is not <name>\/<major>/);
  assert.equal(problems({ ...base(), start: { body: { kind: "go" } }, stop: { body: {} } }).join("\n"), "");
  assert.match(problems({ ...base(), start: 1 }).join("\n"), /start: want \{body/);
  assert.match(problems({ ...base(), dispatch: [{ address: "demo", sender: "$cron", program: "demo" }], start: { body: {} } }).join("\n"), /must admit "\$owner" or "\*"/);
  assert.match(problems({ ...base(), dispatch: [], start: { body: {} } }).join("\n"), /dispatch must have a mailbox row for demo/);
});

test("requires: provided by some installed app's head", () => {
  const installed = [{ provides: [{ interface: "wallet.records/1", functions: {} }] }, {}];
  assert.deepEqual(missingInterfaces(["wallet.records/1"], installed), []);
  assert.deepEqual(missingInterfaces(["wallet.records/2", "overlay.topics/1"], installed), ["wallet.records/2", "overlay.topics/1"]);
});

// ---------------------------------------------------------------- the form before #77: refused (#79)

test("the form before #77 (handler, boxes, routes, heads) is refused", () => {
  for (const f of ["handler", "boxes", "routes", "heads"]) {
    assert.match(problems({ ...base(), [f]: [] }).join("\n"), new RegExp(`${f}: the form before #77 is gone`));
  }
});

test("the stock apps' manifests check in the #77 shape (skein-static, #79; skein-chat, #83)", () => {
  const stat = {
    kind: "app", name: "static", version: "0.2.0", programs: { static: "bin/static.wasm" },
    provides: [{ interface: "static.files/1", functions: { get: { writes: false, args: { "method?": "string", "route?": "string", "path?": "string", "query?": "string", "headers?": "map", "match?": "map" }, answer: { status: "int", type: "string", headers: "map", body: "bytes" } } } }],
    requires: [],
    dispatch: [
      { transport: "http", address: "/site", prefix: true, sender: "*", program: "static", fn: "get", root: "www" },
      { transport: "http", address: "/", sender: "*", program: "static", fn: "get", root: "www" },
    ],
  };
  const c = checkManifest(stat, (p) => p === "bin/static.wasm");
  assert.deepEqual(c.manifest.dispatch.map((r) => rowKey("static", r)), ["http /static/site* *", "http /static/ *"]);
  // #83: the chat app — and the shell app, whose shell program is a map (below); app names `shell` and `chat` are free.
  const chat = {
    kind: "app", name: "chat", version: "0.1.0", programs: { loop: "bin/loop.wasm" }, provides: [], requires: [],
    dispatch: [{ address: "chat", sender: "$owner", program: "loop" }, { address: "chat", sender: "*", program: "loop" }],
  };
  const w = checkManifest(chat, (p) => p.startsWith("bin/"));
  assert.deepEqual(w.manifest.dispatch.map((r) => `${rowKey("chat", r)} → ${r.program}`), ["mailbox chat $owner → loop", "mailbox chat * → loop"]);
});

// ---------------------------------------------------------------- a shell program (#83)

const shellFiles = new Set(["bin/run-handler.wasm", "bin/brush.wasm", "bin/coreutils.wasm", "bin/qjs.wasm", "bin/python.wasm", "lib/python314.zip"]);
const shellApp = (shell: unknown) => ({
  kind: "app", name: "shell", version: "0.1.0", programs: { run: "bin/run-handler.wasm", shell },
  dispatch: [{ address: "run", sender: "$owner", program: "run" }],
});
const PY = { mount: "/opt/skein/python", files: { "lib/python314.zip": "lib/python314.zip" }, env: { PYTHONHOME: "/opt/skein/python" } };
const goodShell = () => ({ code: "shell", modules: { brush: "bin/brush.wasm", coreutils: "bin/coreutils.wasm", qjs: "bin/qjs.wasm", node: "bin/qjs.wasm", python: "bin/python.wasm" }, support: { python: PY } });
const shellProblems = (shell: unknown) => { try { checkManifest(shellApp(shell), (p) => shellFiles.has(p)); } catch (e) { if (e instanceof ManifestError) return e.problems.join("\n"); throw e; } return ""; };

test("a shell program: its modules and support files in the tree, two names for one module", () => {
  const c = checkManifest(shellApp(goodShell()), (p) => shellFiles.has(p));
  assert.deepEqual(c.sources.shell, { kind: "shell", modules: goodShell().modules, support: { python: { ...PY } } });
  assert.deepEqual(c.sources.run, { kind: "wasm", path: "bin/run-handler.wasm", name: "run-handler" });
});

test("a shell program: refusals", () => {
  assert.match(shellProblems({ ...goodShell(), code: "wasm" }), /a program given as a map is a shell program/);
  assert.match(shellProblems({ ...goodShell(), modules: { coreutils: "bin/coreutils.wasm" } }), /no brush/);
  assert.match(shellProblems({ ...goodShell(), modules: { ...goodShell().modules, jq: "bin/jq.wasm" } }), /bin\/jq\.wasm is not in the tree/);
  assert.match(shellProblems({ ...goodShell(), modules: { ...goodShell().modules, jq: "lib/python314.zip" } }), /is not bin\/<x>\.wasm/);
  assert.match(shellProblems({ ...goodShell(), modules: { ...goodShell().modules, "a b": "bin/qjs.wasm" } }), /is not a command name/);
  assert.match(shellProblems({ ...goodShell(), support: { ruby: PY } }), /ruby is not a command in modules/);
  assert.match(shellProblems({ ...goodShell(), support: { python: { ...PY, mount: "opt" } } }), /mount: not an absolute path/);
  assert.match(shellProblems({ ...goodShell(), support: { python: { ...PY, files: { "../x": "lib/python314.zip" } } } }), /is not a relative path/);
  assert.match(shellProblems({ ...goodShell(), support: { python: { ...PY, files: { "lib/x.zip": "lib/missing.zip" } } } }), /is not a file in the tree/);
  assert.match(shellProblems({ ...goodShell(), support: { python: { ...PY, env: { "1X": "y" } } } }), /env\.1X: want a name and text/);
  assert.match(shellProblems({ ...goodShell(), extra: 1 }), /extra: not a field of a shell program/);
});

// ---------------------------------------------------------------- an overlay app's wiring (APPS.md §6)

const overlayFiles = new Set(["bin/overlay.wasm", "bin/topic-demo.wasm", "bin/lookup-demo.wasm"]);
const overlayApp = (ov: unknown, more: Record<string, unknown> = {}) => ({
  kind: "app", name: "overlay", version: "0.3.0",
  programs: { overlay: "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm" },
  config: { overlay: ov },
  dispatch: [{ transport: "http", address: "/listTopicManagers", sender: "*", program: "overlay", fn: "listTopicManagers" }],
  ...more,
});
const demoOverlay = { topics: { tm_demo: "topic-demo" }, lookups: { ls_demo: { program: "lookup-demo", topics: ["tm_demo"] } }, gossip: { tm_demo: true } };
const overlayProblems = (m: unknown, files = overlayFiles): string[] => {
  try { checkManifest(m, (p) => files.has(p)); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};

test("config.overlay derives the wiring: three libp2p rows per topic, /submit and /lookup open, the app's box from events and from itself (#79)", () => {
  const c = checkManifest(overlayApp(demoOverlay), (p) => overlayFiles.has(p));
  const m = c.manifest;
  assert.deepEqual(m.dispatch.map((r) => `${rowKey("overlay", r)}→${r.program}${r.fn ? `.${r.fn}` : ""}`), [
    "http /overlay/listTopicManagers *→overlay.listTopicManagers",
    // Events (its libp2p routes' admits) into its own box; its own watch messages, by the loopback.
    "mailbox overlay event→overlay", "mailbox overlay $self→overlay",
    "http /overlay/submit *→overlay.submit", "http /overlay/lookup *→overlay.lookup",
    "libp2p tm_demo *→overlay.submit", "libp2p tm_demo-admit *→overlay.peerAdmit", "libp2p tm_demo-proof *→overlay.peerProof",
  ]);
  assert.deepEqual(c.derived, {
    rows: ["mailbox overlay event", "mailbox overlay $self", "http /overlay/submit *", "http /overlay/lookup *", "libp2p tm_demo *", "libp2p tm_demo-admit *", "libp2p tm_demo-proof *"],
  });
  // Another name, the same tree: its box is its own name — two overlay apps do not clash (#79).
  const two = checkManifest({ ...overlayApp(demoOverlay), name: "amm" }, (p) => overlayFiles.has(p));
  assert.deepEqual(two.manifest.dispatch.filter((r) => r.transport === "mailbox").map((r) => rowKey("amm", r)), ["mailbox amm event", "mailbox amm $self"]);
});

test("config.overlay: two topics; what the manifest names itself wins", () => {
  const ov = { topics: { tm_demo: "topic-demo", tm_two: "topic-demo" }, lookups: { ls_demo: "lookup-demo" } };
  const explicit = { transport: "libp2p", address: "tm_two", sender: "*", program: "topic-demo", fn: "own" };
  const c = checkManifest(overlayApp(ov, { dispatch: [explicit] }), (p) => overlayFiles.has(p));
  const libp2p = c.manifest.dispatch.filter((r) => r.transport === "libp2p").map((r) => `${r.address}→${r.program}.${r.fn}`);
  assert.deepEqual(libp2p, ["tm_two→topic-demo.own", "tm_demo→overlay.submit", "tm_demo-admit→overlay.peerAdmit", "tm_demo-proof→overlay.peerProof", "tm_two-admit→overlay.peerAdmit", "tm_two-proof→overlay.peerProof"]);
  assert.ok(!c.derived.rows.includes("libp2p tm_two *"), "an explicit row is not derived");
  assert.ok(!c.manifest.dispatch.some((r) => r.address === "chain" || r.address === "status" || r.address === "submit"), "no chain, status or submit box: the chain app's, and the app's own box");
});

test("config.overlay: its problems", () => {
  const p = (ov: unknown, more: Record<string, unknown> = {}) => overlayProblems(overlayApp(ov, more)).join("\n");
  assert.match(p({ topics: {} }), /topics: want \{<topic>: <role>\}, at least one/);
  assert.match(p({ topics: { tm_x: "nobody" } }), /topics\.tm_x: "nobody" is not a role/);
  assert.match(p({ topics: { "tm x": "topic-demo" } }), /is not a topic name/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, lookups: { ls_x: { program: "nobody" } } }), /lookups\.ls_x: program "nobody"/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, lookups: { ls_x: { program: "lookup-demo", topics: ["tm_other"] } } }), /lookups\.ls_x\.topics/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, status: "$status" }), /status: gone \(#79\)/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, gossip: { tm_other: false } }), /gossip: want/);
  assert.match(p(demoOverlay, { programs: { engine: "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm" } }), /the engine is the role "overlay"/);
  const w = overlayWiring("ov2", { topics: { tm_a: "t" } }, (r) => r === "t" || r === "overlay");
  assert.ok(!Array.isArray(w) && w.rows.filter((r) => r.address === "ov2").length === 2, "the app's own box, by its name");
});

test("optional rows (#78): only from a $<provider>; kept in the manifest as written", () => {
  const m = { ...base(), dispatch: [...base().dispatch, { address: "status", sender: "$status", program: "demo", optional: true }] };
  const c = checkManifest(m, has);
  assert.deepEqual(c.manifest.dispatch.at(-1), { transport: "mailbox", address: "status", sender: "$status", program: "demo", optional: true });
  assert.ok(problems({ ...base(), dispatch: [{ address: "demo", sender: "*", program: "demo", optional: true }] }).some((p) => /optional is for a row from a \$<provider>/.test(p)));
  assert.ok(problems({ ...base(), dispatch: [{ address: "demo", sender: "$owner", program: "demo", optional: true }] }).some((p) => /optional is for a row from a \$<provider>/.test(p)));
  assert.ok(problems({ ...base(), dispatch: [{ address: "demo", sender: "$self", program: "demo", optional: true }] }).some((p) => /optional is for a row from a \$<provider>/.test(p)));
  assert.ok(problems({ ...base(), dispatch: [{ address: "status", sender: "$status", program: "demo", optional: "yes" }] }).some((p) => /optional is true or absent/.test(p)));
});
