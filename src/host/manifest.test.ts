// The app manifest's checks (#72, #76, #77, #79, #143; manifest.ts): the fields, the
// routes (addresses relative to the app, the escapes, filters, handlers, read routes),
// the app's filters and roles, the forms gone (#79, #143), an overlay app's derived
// wiring, a shell program's form (#83), and `requires` against what the installed
// apps provide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appBox, appPath, checkManifest, handlerOf, ManifestError, missingInterfaces, overlayWiring, routeKey, shapeProblem } from "./manifest.ts";

const files = new Set(["bin/demo.wasm", "bin/engine.cid", "etc/app.json"]);
const has = (p: string) => files.has(p);
const base = () => ({
  kind: "app", name: "demo", version: "0.1.0",
  programs: { demo: "bin/demo.wasm" },
  provides: [{ interface: "demo.counter/1", functions: { get: { writes: false, args: {}, answer: { count: "int" } }, add: { writes: true, args: { by: "int", "note?": "string" } } } }],
  filters: { page: "demo.page" },
  roles: { admin: ["config"], user: ["call"] },
  routes: [
    { address: "", handler: "demo.message" },
    { transport: "event", address: "", handler: "demo" },
    { address: "admin", handler: "demo.config" },
    { transport: "http", address: "/call", filters: ["kernel.brc104"], handler: "demo.call" },
    { transport: "http", address: "/", prefix: true, filters: ["page"], root: "www" },
  ],
});
const problems = (m: unknown): string[] => {
  try { checkManifest(m, has); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};
const keys = (m: unknown) => checkManifest(m, has).manifest.routes.map((r) => routeKey("demo", r));

test("a good manifest: its routes normalised (transport mailbox by default); filters and roles kept as written", () => {
  const c = checkManifest(base(), has);
  assert.deepEqual(keys(base()), ["mailbox demo", "event demo", "mailbox demo/admin", "http /demo/call", "http /demo/ prefix"]);
  assert.deepEqual(c.manifest.routes[0], { transport: "mailbox", address: "", handler: "demo.message" });
  assert.deepEqual(c.manifest.routes[4], { transport: "http", address: "/", prefix: true, filters: ["page"], root: "www" }, "a read route: filters only, its settings carried");
  assert.deepEqual(c.manifest.filters, { page: "demo.page" });
  assert.deepEqual(c.manifest.roles, { admin: ["config"], user: ["call"] });
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

test("handlers: <role>.<fn>, a bare role (no function named), or a function of the app's one program", () => {
  assert.deepEqual(handlerOf("demo.call", ["demo"]), { role: "demo", fn: "call" });
  assert.deepEqual(handlerOf("demo", ["demo"]), { role: "demo" }, "a role: the program, no function");
  assert.deepEqual(handlerOf("call", ["demo"]), { role: "demo", fn: "call" }, "one program: a bare function");
  assert.equal(handlerOf("call", ["a", "b"]), undefined, "two programs: a bare name is a role or nothing");
  assert.equal(handlerOf("nobody.call", ["demo"]), undefined);
  assert.equal(handlerOf("", ["demo"]), undefined);
});

test("routes: no sender (#143), the transports, handlers, filters, the keys", () => {
  const route = (r: Record<string, unknown>) => problems({ ...base(), routes: [{ address: "demo", handler: "demo.m", ...r }] }).join("\n");
  assert.equal(route({}), "");
  assert.match(route({ sender: "*" }), /sender: gone \(#143\)/);
  assert.match(route({ program: "demo" }), /program: name the handler/);
  assert.match(route({ fn: "x" }), /fn: name the handler/);
  assert.match(route({ filter: "beef" }), /filter: gone \(#143\): name `filters`/);
  assert.match(route({ optional: true }), /optional: gone \(#143\)/);
  assert.match(route({ app: "x" }), /app is set by the install/);
  assert.match(route({ address: "a b" }), /whitespace or a control character/);
  assert.match(route({ transport: "local" }), /transport "local"/);
  assert.match(route({ handler: "nobody.x" }), /handler "nobody\.x" is not "<role>\.<fn>"/);
  assert.match(route({ handler: undefined }), /handler: a mailbox, event or libp2p route names its handler/);
  assert.match(route({ prefix: true }), /a mailbox route has no prefix/);
  assert.match(route({ transport: "event", filters: ["kernel.beef"] }), /an event route has no filters/);
  assert.match(route({ filters: ["kernel.nope"] }), /filter kernel\.nope: the kernel's are kernel\.brc104, kernel\.beef/);
  assert.match(route({ filters: ["nope"] }), /filter nope: not one of this app's/);
  assert.match(route({ filters: ["Other App.x"] }), /not <app>\.<filter>/);
  assert.equal(route({ filters: ["kernel.beef", "page", "chain.check"] }), "", "the kernel's, the app's own, another app's");
  assert.match(route({ filters: "kernel.beef" }), /filters is a list/);
  assert.match(problems({ ...base(), routes: [{ address: "demo", handler: "demo.m" }, { address: "", handler: "demo.n" }] }).join("\n"), /mailbox demo twice/, "\"\" and the app's name are one box");
  assert.match(problems({ ...base(), routes: [{ transport: "libp2p", address: "tm_x", handler: "demo" }] }).join("\n"), /an libp2p route names a function/);
  assert.match(problems({ ...base(), routes: [{ transport: "http", address: "/x", handler: "demo" }] }).join("\n"), /an http route names a function/);
  assert.match(problems({ ...base(), routes: [{ transport: "http", address: "/x" }] }).join("\n"), /a read route \(no handler\) names its filters/);
  assert.deepEqual(keys({ ...base(), routes: [{ transport: "libp2p", address: "/amm/1/swap", filters: ["kernel.beef"], handler: "demo.swap" }] }), ["libp2p /amm/1/swap"]);
  // A mailbox and an event route at one box are two keys.
  assert.deepEqual(keys({ ...base(), routes: [{ address: "", handler: "demo" }, { transport: "event", address: "", handler: "demo" }] }), ["mailbox demo", "event demo"]);
});

test("filters and roles: declared by name; a filter is a handler; a role lists functions (root and user by name)", () => {
  assert.match(problems({ ...base(), filters: { "a b": "demo.x" } }).join("\n"), /is not a filter name/);
  assert.match(problems({ ...base(), filters: { x: "nobody.x" } }).join("\n"), /filters\.x: "nobody\.x" is not "<role>\.<fn>"/);
  assert.match(problems({ ...base(), filters: ["x"] }).join("\n"), /filters: want \{<filter>/);
  assert.equal(problems({ ...base(), filters: { page: "page", check: "demo" } }).join("\n"), "", "a bare function of the one program; a role (its function named as the filter)");
  assert.match(problems({ ...base(), roles: { "Admin": ["x"] } }).join("\n"), /is not a role name/);
  assert.match(problems({ ...base(), roles: { admin: "config" } }).join("\n"), /roles\.admin: want a list/);
  assert.match(problems({ ...base(), roles: [] }).join("\n"), /roles: want \{<role>/);
  assert.equal(problems({ ...base(), roles: { root: ["wipe"], user: ["call"], ops: [] } }).join("\n"), "");
});

test("http routes are relative to /<app>/; escapes are refused", () => {
  assert.equal(appPath("demo", "/call"), "/demo/call");
  assert.equal(appPath("demo", "call"), "/demo/call");
  assert.equal(appPath("demo", "/"), "/demo/");
  assert.equal(appPath("demo", "a//b"), "/demo/a/b");
  const http = (address: string, more: Record<string, unknown> = {}) => problems({ ...base(), routes: [{ transport: "http", address, handler: "demo.f", ...more }] }).join("\n");
  assert.equal(http("/x"), "");
  assert.equal(http("/site", { prefix: true, root: "www" }), "");
  assert.match(http("../x"), /a "\." or "\.\." segment/);
  assert.match(http("/a/./b"), /a "\." or "\.\." segment/);
  assert.match(http("/a%2fb"), /encoded dot or slash/);
  assert.match(http("https://x/y"), /is a URL or a scheme/);
  assert.match(http("/a?b"), /query/);
  assert.match(http("/x", { prefix: "yes" }), /prefix is true or absent/);
  assert.deepEqual(keys({ ...base(), routes: [{ transport: "http", address: "/site", prefix: true, handler: "demo.get" }] }), ["http /demo/site prefix"]);
});

test("shapes", () => {
  assert.equal(shapeProblem({ a: "int", "b?": ["string"], c: { d: "cid" }, e: "map", f: "any", g: "ms", h: "bytes", i: "bool" }, "args"), undefined);
  assert.match(shapeProblem(["int", "string"], "args")!, /one element shape/);
  assert.match(shapeProblem(3, "args")!, /a shape is a type name/);
});

test("boxes are relative to the app (#128): \"\" or its name is its own box, \"x\" is <app>/x; escapes are refused", () => {
  assert.equal(appBox("demo", ""), "demo");
  assert.equal(appBox("demo", "demo"), "demo");
  assert.equal(appBox("demo", "run"), "demo/run");
  assert.equal(appBox("demo", "a/b"), "demo/a/b");
  assert.equal(appBox("demo", "demo/x"), "demo/demo/x", "written relative: the app's name is not stripped");
  assert.equal(appBox("demo", ":ack"), "demo/:ack");
  const box = (address: string) => problems({ ...base(), routes: [{ address, handler: "demo" }] }).join("\n");
  for (const ok of ["", "demo", "run", "a/b", "amm-p2p"]) assert.equal(box(ok), "", ok);
  for (const bad of ["/run", "run/", "a//b", "..", "../chain", "a/./b", "./x"]) assert.match(box(bad), /an empty, "\." or "\.\." segment/, bad);
  for (const bad of ["a b", " run", "run\n", "a\tb", "x\u0000", "x\u007f"]) assert.match(box(bad), /whitespace or a control character/, JSON.stringify(bad));
  assert.match(box("x".repeat(124)), /more than 128 bytes/);
  assert.equal(box("x".repeat(123)), "");
  assert.equal(problems({ ...base(), routes: [{ address: "", handler: "demo" }], start: { body: {} } }).join("\n"), "", "start goes into the own box, written \"\"");
  assert.match(problems({ ...base(), routes: [{ address: "run", handler: "demo" }], start: { body: {} } }).join("\n"), /routes must have a mailbox route for demo/, "demo/run is not the app's box");
  assert.match(problems({ ...base(), routes: [{ transport: "event", address: "", handler: "demo" }], start: { body: {} } }).join("\n"), /routes must have a mailbox route for demo/, "an event route takes no message");
});

test("name, version, provides, start/stop", () => {
  assert.match(problems({ ...base(), name: "Demo" }).join("\n"), /is not a name/);
  for (const n of ["dispatch", "frontdoor", "grant", "grants", "root", "user"]) assert.match(problems({ ...base(), name: n }).join("\n"), /stock box, head, program or role/, n);
  assert.match(problems({ ...base(), version: "1" }).join("\n"), /not semver/);
  assert.match(problems({ ...base(), provides: [{ interface: "x", functions: {} }] }).join("\n"), /interface is not <name>\/<major>/);
  assert.match(problems({ ...base(), provides: [{ interface: "x/1", functions: { f: {} } }] }).join("\n"), /writes \(true \| false\) is required/);
  assert.match(problems({ ...base(), requires: ["x"] }).join("\n"), /is not <name>\/<major>/);
  assert.equal(problems({ ...base(), start: { body: { kind: "go" } }, stop: { body: {} } }).join("\n"), "");
  assert.match(problems({ ...base(), start: 1 }).join("\n"), /start: want \{body/);
  assert.match(problems({ ...base(), routes: [], start: { body: {} } }).join("\n"), /routes must have a mailbox route for demo/);
});

test("requires: provided by some installed app's head", () => {
  const installed = [{ provides: [{ interface: "wallet.records/1", functions: {} }] }, {}];
  assert.deepEqual(missingInterfaces(["wallet.records/1"], installed), []);
  assert.deepEqual(missingInterfaces(["wallet.records/2", "overlay.topics/1"], installed), ["wallet.records/2", "overlay.topics/1"]);
});

// ---------------------------------------------------------------- the forms gone

test("the forms gone are refused: before #77 (handler, boxes, heads); #143's dispatch and reads", () => {
  for (const f of ["handler", "boxes", "heads"]) assert.match(problems({ ...base(), [f]: [] }).join("\n"), new RegExp(`${f}: the form before #77 is gone`));
  assert.match(problems({ ...base(), dispatch: [] }).join("\n"), /dispatch: gone \(#143\): name `routes`/);
  assert.match(problems({ ...base(), reads: [] }).join("\n"), /reads: gone \(#143\): a read is a route with filters and no handler/);
});

test("the stock apps' manifests check in the #143 shape (skein-site's read route; skein-chat's box)", () => {
  const site = {
    kind: "app", name: "site", version: "0.8.0", programs: { site: "bin/site.wasm" },
    provides: [{ interface: "site/1", functions: { get: { writes: false } } }],
    filters: { get: "site.get" },
    routes: [{ transport: "http", address: "/", prefix: true, filters: ["get"], root: "www" }],
  };
  const c = checkManifest(site, (p) => p === "bin/site.wasm");
  assert.deepEqual(c.manifest.routes.map((r) => routeKey("site", r)), ["http /site/ prefix"], "#125: the site's one route is under /site/");
  const chat = {
    kind: "app", name: "chat", version: "0.2.0", programs: { loop: "bin/loop.wasm" }, roles: { root: ["say"] },
    routes: [{ address: "", handler: "loop.say" }],
  };
  const w = checkManifest(chat, (p) => p.startsWith("bin/"));
  assert.deepEqual(w.manifest.routes.map((r) => `${routeKey("chat", r)} → ${r.handler}`), ["mailbox chat → loop.say"]);
});

// ---------------------------------------------------------------- a shell program (#83)

const shellFiles = new Set(["bin/run-handler.wasm", "bin/brush.wasm", "bin/coreutils.wasm", "bin/qjs.wasm", "bin/python.wasm", "lib/python314.zip"]);
const shellApp = (shell: unknown) => ({
  kind: "app", name: "shell", version: "0.1.0", programs: { run: "bin/run-handler.wasm", shell },
  routes: [{ address: "run", handler: "run" }],
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
  filters: { topics: "overlay.listTopicManagers" },
  routes: [{ transport: "http", address: "/listTopicManagers", filters: ["topics"] }],
  ...more,
});
const demoOverlay = { topics: { tm_demo: "topic-demo" }, lookups: { ls_demo: { program: "lookup-demo", topics: ["tm_demo"] } }, gossip: { tm_demo: true } };
const overlayProblems = (m: unknown, files = overlayFiles): string[] => {
  try { checkManifest(m, (p) => files.has(p)); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};
const shown = (app: string) => (r: { transport: string; address: string; prefix?: boolean; filters?: string[]; handler?: string }) => `${routeKey(app, r)}${r.filters ? ` [${r.filters.join(",")}]` : ""}→${r.handler ?? "(read)"}`;

test("config.overlay derives the wiring: three libp2p routes per topic, /submit (kernel.beef) and the read route /lookup, the app's box for events and for messages", () => {
  const c = checkManifest(overlayApp(demoOverlay), (p) => overlayFiles.has(p));
  const m = c.manifest;
  assert.deepEqual(m.routes.map(shown("overlay")), [
    "http /overlay/listTopicManagers [topics]→(read)",
    "event overlay→overlay", "mailbox overlay→overlay",
    "http /overlay/submit [kernel.beef]→overlay.submit",
    "http /overlay/lookup [overlay.lookup]→(read)",
    "libp2p tm_demo [kernel.beef]→overlay.submit", "libp2p tm_demo-admit→overlay.peerAdmit", "libp2p tm_demo-proof→overlay.peerProof",
  ]);
  assert.deepEqual(c.derived, { routes: ["event overlay", "mailbox overlay", "http /overlay/submit", "http /overlay/lookup", "libp2p tm_demo", "libp2p tm_demo-admit", "libp2p tm_demo-proof"] });
  assert.deepEqual(m.filters, { topics: "overlay.listTopicManagers", lookup: "overlay.lookup" }, "the derived /lookup's filter: the engine's lookup");
  // Another name, the same tree: its box is its own name — two overlay apps do not clash (#79).
  const two = checkManifest({ ...overlayApp(demoOverlay), name: "amm" }, (p) => overlayFiles.has(p));
  assert.deepEqual(two.manifest.routes.filter((r) => r.transport === "mailbox" || r.transport === "event").map((r) => routeKey("amm", r)), ["event amm", "mailbox amm"]);
});

test("config.overlay: two topics; what the manifest names itself wins", () => {
  const ov = { topics: { tm_demo: "topic-demo", tm_two: "topic-demo" }, lookups: { ls_demo: "lookup-demo" } };
  const explicit = { transport: "libp2p", address: "tm_two", handler: "topic-demo.own" };
  const c = checkManifest(overlayApp(ov, { routes: [explicit], filters: { lookup: "lookup-demo.mine" } }), (p) => overlayFiles.has(p));
  const libp2p = c.manifest.routes.filter((r) => r.transport === "libp2p").map((r) => `${r.address}→${r.handler}`);
  assert.deepEqual(libp2p, ["tm_two→topic-demo.own", "tm_demo→overlay.submit", "tm_demo-admit→overlay.peerAdmit", "tm_demo-proof→overlay.peerProof", "tm_two-admit→overlay.peerAdmit", "tm_two-proof→overlay.peerProof"]);
  assert.ok(!c.derived.routes.includes("libp2p tm_two"), "an explicit route is not derived");
  assert.deepEqual(c.manifest.filters, { lookup: "lookup-demo.mine" }, "a filter the manifest declares itself wins");
  assert.ok(!c.manifest.routes.some((r) => r.address === "chain" || r.address === "status" || r.address === "submit"), "no chain, status or submit box: the chain app's, and the app's own box");
});

test("config.overlay: its problems", () => {
  const p = (ov: unknown, more: Record<string, unknown> = {}) => overlayProblems(overlayApp(ov, more)).join("\n");
  assert.match(p({ topics: ["tm_x"] }), /topics: want \{<topic>: <role>\}/);
  assert.match(p({ topics: { tm_x: "nobody" } }), /topics\.tm_x: "nobody" is not a role/);
  assert.match(p({ topics: { "tm x": "topic-demo" } }), /is not a topic name/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, lookups: { ls_x: { program: "nobody" } } }), /lookups\.ls_x: program "nobody"/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, lookups: { ls_x: { program: "lookup-demo", topics: ["tm_other"] } } }), /lookups\.ls_x\.topics/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, status: "$status" }), /status: gone \(#79\)/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, gossip: { tm_other: false } }), /gossip: want/);
  assert.match(p(demoOverlay, { programs: { engine: "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm" }, filters: {}, routes: [] }), /the engine is the role "overlay"/);
  const w = overlayWiring("ov2", { topics: { tm_a: "t" } }, (r) => r === "t" || r === "overlay");
  assert.ok(!Array.isArray(w) && w.routes.filter((r) => r.address === "ov2").length === 2, "the app's own box, by its name: an event route and a mailbox route");
});

test("config.overlay: market {window} and validator {every} are the engine's settings: accepted, checked, no routes derived", () => {
  const ov = { ...demoOverlay, market: { window: 60_000 }, validator: { every: 30_000 } };
  const c = checkManifest(overlayApp(ov), (p) => overlayFiles.has(p));
  const plain = checkManifest(overlayApp(demoOverlay), (p) => overlayFiles.has(p));
  assert.deepEqual(c.derived, plain.derived, "the same wiring as without them");
  assert.deepEqual(c.manifest.routes, plain.manifest.routes);
  const p = (x: unknown) => overlayProblems(overlayApp(x)).join("\n");
  assert.equal(p({ market: { window: 1 } }), "");
  assert.equal(p({ validator: { every: 1 } }), "");
  for (const bad of [{ market: 5 }, { market: {} }, { market: { window: "1m" } }, { market: { window: 0 } }, { market: { window: 1.5 } }, { market: { window: 1, extra: 1 } }]) assert.match(p(bad), /market: want \{window: <ms>\}/, JSON.stringify(bad));
  for (const bad of [{ validator: true }, { validator: {} }, { validator: { every: -1 } }, { validator: { every: 1, window: 1 } }]) assert.match(p(bad), /validator: want \{every: <ms>\}/, JSON.stringify(bad));
});

test("config.overlay with no topics (#120): accepted; the box routes, /submit and /lookup derived, no per-topic routes", () => {
  const routes = ["event overlay", "mailbox overlay", "http /overlay/submit", "http /overlay/lookup"];
  for (const ov of [{}, { topics: {} }, { lookups: { ls_demo: "lookup-demo" } }, { topics: {}, lookups: { ls_demo: { program: "lookup-demo" } } }]) {
    const c = checkManifest(overlayApp(ov), (p) => overlayFiles.has(p));
    assert.deepEqual(c.derived, { routes }, JSON.stringify(ov));
    assert.ok(!c.manifest.routes.some((r) => r.transport === "libp2p"), "no per-topic routes");
  }
  const w = overlayWiring("mandala", {}, (r) => r === "overlay");
  assert.ok(!Array.isArray(w));
  assert.deepEqual(w.topics, []);
  assert.deepEqual(w.routes.map((r) => routeKey("mandala", r)), ["event mandala", "mailbox mandala", "http /mandala/submit", "http /mandala/lookup"]);
});

test("config.overlay: no prefix declarations (#120): prefixes refused, in the overlay and in a lookup service", () => {
  const p = (ov: unknown) => overlayProblems(overlayApp(ov)).join("\n");
  assert.match(p({ prefixes: { tm_: { program: "topic-demo", active: "mandala" } } }), /prefixes: not a field \(want topics, lookups, gossip, market, validator; no prefix declarations, #120\)/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, prefixes: {} }), /prefixes: not a field/);
  assert.match(p({ lookups: { ls_demo: { program: "lookup-demo", prefixes: ["tm_"] } } }), /lookups\.ls_demo: prefixes: not a field \(want program, topics\)/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, extra: 1 }), /extra: not a field/);
});
