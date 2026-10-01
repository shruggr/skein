// The app manifest's checks (#72, #76; manifest.ts): the fields, the route
// escapes, the senders' normalisation, the handler map, and `requires`
// against what the installed apps provide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appPath, checkManifest, ManifestError, missingInterfaces, overlayWiring, routeKey, shapeProblem } from "./manifest.ts";

const files = new Set(["bin/demo.wasm", "bin/engine.cid", "etc/app.json"]);
const has = (p: string) => files.has(p);
const base = () => ({
  kind: "app", name: "demo", version: "0.1.0",
  programs: { demo: "bin/demo.wasm" }, handler: "demo",
  provides: [{ interface: "demo.counter/1", functions: { get: { writes: false, args: {}, answer: { count: "int" } }, add: { writes: true, args: { by: "int", "note?": "string" } } } }],
  boxes: [{ box: "demo", senders: ["*", "$cron"] }, "admin"],
  routes: [{ path: "/call", program: "demo", fn: "call" }],
  heads: [],
});
const problems = (m: unknown): string[] => {
  try { checkManifest(m, has); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};

test("a good manifest: boxes normalised (a bare name is the owner's), the app's head added, handlers per box", () => {
  const c = checkManifest(base(), has);
  assert.deepEqual(c.manifest.boxes, [{ box: "demo", senders: ["*", "$cron"] }, { box: "admin", senders: ["$owner"] }]);
  assert.deepEqual(c.manifest.heads, ["demo"]);
  assert.deepEqual(c.handlers, { demo: "demo", admin: "demo" });
  assert.deepEqual(c.sources.demo, { kind: "wasm", path: "bin/demo.wasm", name: "demo" });
});

test("programs: files in the tree, a pinned .cid, or an instance program by name", () => {
  const m = { ...base(), programs: { demo: "bin/demo.wasm", engine: "bin/engine.cid", shell: "shell" } };
  const c = checkManifest(m, has);
  assert.deepEqual(c.sources.engine, { kind: "cid", path: "bin/engine.cid", name: "engine" });
  assert.deepEqual(c.sources.shell, { kind: "instance", name: "shell" });
  assert.match(problems({ ...base(), programs: { demo: "bin/missing.wasm" } }).join("\n"), /bin\/missing\.wasm is not in the tree/);
  assert.match(problems({ ...base(), programs: { demo: "../x.wasm" } }).join("\n"), /is not bin\/<x>\.wasm/);
});

test("the handler: a role, or a box → role map covering every box", () => {
  const m = { ...base(), programs: { demo: "bin/demo.wasm", engine: "bin/engine.cid" }, handler: { demo: "demo", admin: "engine" } };
  assert.deepEqual(checkManifest(m, has).handlers, { demo: "demo", admin: "engine" });
  assert.match(problems({ ...m, handler: { demo: "demo" } }).join("\n"), /no role for box admin/);
  assert.match(problems({ ...m, handler: { demo: "demo", admin: "engine", other: "demo" } }).join("\n"), /handler\.other: not a box the app asks for/);
  assert.match(problems({ ...base(), handler: undefined }).join("\n"), /handler: required/);
  assert.match(problems({ ...base(), handler: "nobody" }).join("\n"), /handler: nobody is not a role/);
});

test("senders: *, $provider, $owner or a key; nothing else", () => {
  const key = `02${"ab".repeat(32)}`;
  assert.equal(problems({ ...base(), boxes: [{ box: "demo", senders: ["*", "$status", "$owner", key] }] }).length, 0);
  assert.match(problems({ ...base(), boxes: [{ box: "demo", senders: ["anyone"] }] }).join("\n"), /sender "anyone"/);
  assert.match(problems({ ...base(), boxes: [{ box: "demo", senders: [] }] }).join("\n"), /senders is a non-empty list/);
  assert.match(problems({ ...base(), boxes: [{ box: ":ack" }] }).join("\n"), /want a box name/);
  assert.match(problems({ ...base(), boxes: ["demo", "demo"] }).join("\n"), /demo twice/);
});

test("routes are relative to /<app>/; escapes are refused", () => {
  assert.equal(appPath("demo", "/call"), "/demo/call");
  assert.equal(appPath("demo", "call"), "/demo/call");
  assert.equal(appPath("demo", "/"), "/demo/");
  assert.equal(appPath("demo", "//site//x"), "/demo/site/x");
  for (const bad of ["/../amm/submit", "/a/../../x", "/./x", "/%2e%2e/x", "/a%2Fb", "/a\\b", "http://x/y", "/x?q", "libp2p:topic"]) {
    assert.throws(() => appPath("demo", bad), Error, bad);
  }
  const route = (r: Record<string, unknown>) => problems({ ...base(), routes: [{ program: "demo", fn: "call", ...r }] }).join("\n");
  assert.match(route({ path: "/../amm/submit" }), /segment/);
  assert.match(route({ prefix: "/%2e%2e" }), /encoded dot or slash/);
  assert.match(route({ path: "https://elsewhere/x" }), /URL or a scheme/);
  assert.equal(route({ path: "libp2p:amm-proofs" }), "", "a libp2p topic is a route");
  assert.equal(route({ path: "libp2p:/amm-validator/1/swap" }), "", "a libp2p stream protocol is a route");
  assert.match(route({ prefix: "libp2p:amm" }), /a libp2p route is a path/);
  assert.match(route({ path: "libp2p:" }), /want libp2p:<topic>/);
  assert.match(route({ path: "libp2p:amm proofs" }), /want libp2p:<topic>/);
  assert.match(route({ path: "libp2p:amm-proofs", auth: "none" }), /takes no auth or read/);
  assert.equal(routeKey("demo", { path: "libp2p:amm-proofs" }), "path libp2p:amm-proofs", "libp2p names are global: not under /<app>/");
  assert.match(route({ path: "/a", prefix: "/b" }), /path or a prefix \(one\)/);
  assert.match(route({ path: "/a", auth: "basic" }), /auth is "none" or absent/);
  assert.match(route({ path: "/a", app: "other" }), /app is set by the install/);
  assert.match(problems({ ...base(), routes: [{ path: "/a", program: "nobody", fn: "x" }] }).join("\n"), /program "nobody" is not a role/);
  assert.match(problems({ ...base(), routes: [{ path: "/a", program: "demo", fn: "x" }, { path: "a", program: "demo", fn: "y" }] }).join("\n"), /path \/demo\/a twice/);
});

test("name, version, heads, provides, start/stop", () => {
  assert.match(problems({ ...base(), name: "Demo" }).join("\n"), /is not a name/);
  assert.match(problems({ ...base(), name: "routes" }).join("\n"), /stock box or head/);
  assert.match(problems({ ...base(), version: "1" }).join("\n"), /not semver/);
  assert.match(problems({ ...base(), kind: "tree" }).join("\n"), /kind: want "app"/);
  assert.match(problems({ ...base(), heads: ["sessions"] }).join("\n"), /sessions is the instance's own/);
  assert.deepEqual(checkManifest({ ...base(), heads: ["ls:*", "demo"] }, has).manifest.heads, ["ls:*", "demo"]);
  assert.match(problems({ ...base(), provides: [{ interface: "demo", functions: { a: { writes: true } } }] }).join("\n"), /not <name>\/<major>/);
  assert.match(problems({ ...base(), provides: [{ interface: "demo.x/1", functions: { a: { args: {} } } }] }).join("\n"), /writes \(true \| false\) is required/);
  assert.match(problems({ ...base(), provides: [{ interface: "demo.x/1", functions: { a: { writes: false, args: { x: "float" } } } }] }).join("\n"), /unknown type "float"/);
  assert.match(problems({ ...base(), requires: ["wallet"] }).join("\n"), /requires: "wallet"/);
  assert.equal(problems({ ...base(), start: { body: { kind: "go" } }, stop: { body: {} } }).length, 0, "the owner may send into a box open to anyone");
  assert.match(problems({ ...base(), start: { kind: "go" } }).join("\n"), /start: want \{body/);
  assert.match(problems({ ...base(), boxes: [{ box: "demo", senders: ["$cron"] }], start: { body: {} } }).join("\n"), /must admit "\$owner" or "\*"/);
  assert.match(problems({ ...base(), boxes: [], handler: undefined, start: { body: {} } }).join("\n"), /boxes must include demo/);
});

test("shapes", () => {
  assert.equal(shapeProblem({ a: "int", "b?": ["string"], c: { d: "cid" }, e: "map", f: "any", g: "ms", h: "bytes", i: "bool" }, "args"), undefined);
  assert.match(shapeProblem(["int", "string"], "args")!, /one element shape/);
  assert.match(shapeProblem(3, "args")!, /a shape is a type name/);
});

test("requires: provided by some installed app's head", () => {
  const installed = [{ provides: [{ interface: "wallet.records/1", functions: {} }] }, {}];
  assert.deepEqual(missingInterfaces(["wallet.records/1"], installed), []);
  assert.deepEqual(missingInterfaces(["wallet.records/2", "overlay.topics/1"], installed), ["wallet.records/2", "overlay.topics/1"]);
});

test("the stock apps' manifests check (skein-static, skein-workbench as of #71)", () => {
  const stat = {
    kind: "app", name: "static", version: "0.1.0", programs: { static: "bin/static.wasm" },
    provides: [{ interface: "static.files/1", functions: { get: { writes: false, args: { "method?": "string", "route?": "string", "path?": "string", "query?": "string", "headers?": "map", "match?": "map" }, answer: { status: "int", type: "string", headers: "map", body: "bytes" } } } }],
    requires: [], boxes: [],
    routes: [{ prefix: "/site", program: "static", fn: "get", auth: "none", root: "www" }, { path: "/", program: "static", fn: "get", auth: "none", root: "www" }],
    heads: [],
  };
  const c = checkManifest(stat, (p) => p === "bin/static.wasm");
  assert.deepEqual(c.manifest.heads, ["static"]);
  assert.deepEqual(c.manifest.routes.map((r) => appPath("static", (r.path ?? r.prefix)!)), ["/static/site", "/static/"]);
  const wb = {
    kind: "app", name: "workbench", version: "0.1.0",
    programs: { run: "bin/run-handler.wasm", loop: "bin/loop.wasm", objects: "bin/objects-handler.cid", head: "bin/head-handler.cid", subscribe: "bin/subscribe-handler.cid", shell: "shell" },
    handler: { run: "run", chat: "loop", objects: "objects", head: "head", subscribe: "subscribe" },
    provides: [], requires: [], boxes: ["run", "chat", "objects", "head", "subscribe"], routes: [], heads: ["main"],
  };
  const w = checkManifest(wb, (p) => p.startsWith("bin/"));
  assert.deepEqual(w.manifest.heads, ["workbench", "main"]);
  assert.equal(w.handlers.chat, "loop");
});

// ---------------------------------------------------------------- an overlay app's wiring (APPS.md §6)

const overlayFiles = new Set(["bin/overlay.wasm", "bin/topic-demo.wasm", "bin/lookup-demo.wasm"]);
const overlayApp = (ov: unknown, more: Record<string, unknown> = {}) => ({
  kind: "app", name: "overlay", version: "0.2.0",
  programs: { overlay: "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm" },
  config: { overlay: ov },
  routes: [{ path: "/listTopicManagers", program: "overlay", fn: "listTopicManagers", auth: "none" }],
  heads: ["wallet", "overlay:gossip"],
  ...more,
});
const demoOverlay = { topics: { tm_demo: "topic-demo" }, lookups: { ls_demo: { program: "lookup-demo", topics: ["tm_demo"] } }, status: "$status", gossip: { tm_demo: true } };
const overlayProblems = (m: unknown, files = overlayFiles): string[] => {
  try { checkManifest(m, (p) => files.has(p)); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};

test("config.overlay derives the wiring: three libp2p routes per topic, /submit and /lookup, the submit/chain/status boxes, an ls: head per service", () => {
  const c = checkManifest(overlayApp(demoOverlay), (p) => overlayFiles.has(p));
  const m = c.manifest;
  assert.deepEqual(m.routes.map((r) => `${r.path}→${r.program}.${r.fn}${r.auth ? `(${r.auth})` : ""}`), [
    "/listTopicManagers→overlay.listTopicManagers(none)",
    "/submit→overlay.submit(none)", "/lookup→overlay.lookup(none)",
    "libp2p:tm_demo→overlay.submit", "libp2p:tm_demo-admit→overlay.peerAdmit", "libp2p:tm_demo-proof→overlay.peerProof",
  ]);
  // Events (the front door's admits, the host's chain feed) carry no sender: submit and chain take them from anyone.
  assert.deepEqual(m.boxes, [{ box: "submit", senders: ["*"] }, { box: "chain", senders: ["*"] }, { box: "status", senders: ["$status"] }]);
  assert.deepEqual(c.handlers, { submit: "overlay", chain: "overlay", status: "overlay" });
  assert.deepEqual(m.handler, { submit: "overlay", chain: "overlay", status: "overlay" }, "no handler named: the record names each box's");
  assert.deepEqual(m.heads, ["overlay", "wallet", "overlay:gossip", "ls:ls_demo"]);
  assert.deepEqual(c.derived, {
    boxes: ["submit", "chain", "status"],
    routes: ["/submit", "/lookup", "libp2p:tm_demo", "libp2p:tm_demo-admit", "libp2p:tm_demo-proof"],
    heads: ["ls:ls_demo"],
  });
});

test("config.overlay: two topics, no status provider (admitted at the proof); what the manifest names itself wins", () => {
  const ov = { topics: { tm_demo: "topic-demo", tm_two: "topic-demo" }, lookups: { ls_demo: "lookup-demo" } };
  const explicit = { path: "libp2p:tm_two", program: "topic-demo", fn: "own" };
  const c = checkManifest(overlayApp(ov, { routes: [explicit], boxes: [{ box: "chain", senders: ["$owner", "*"] }], handler: "overlay" }), (p) => overlayFiles.has(p));
  assert.deepEqual(c.manifest.boxes.map((b) => b.box), ["chain", "submit"], "no status box: no status provider named");
  assert.deepEqual(c.manifest.boxes[0], { box: "chain", senders: ["$owner", "*"] }, "the manifest's own box entry wins");
  assert.equal(c.manifest.handler, "overlay", "one role handles every box: the handler stays a role");
  const libp2p = c.manifest.routes.filter((r) => r.path?.startsWith("libp2p:")).map((r) => `${r.path}→${r.program}.${r.fn}`);
  assert.deepEqual(libp2p, ["libp2p:tm_two→topic-demo.own", "libp2p:tm_demo→overlay.submit", "libp2p:tm_demo-admit→overlay.peerAdmit", "libp2p:tm_demo-proof→overlay.peerProof", "libp2p:tm_two-admit→overlay.peerAdmit", "libp2p:tm_two-proof→overlay.peerProof"]);
  assert.ok(!c.derived.routes.includes("libp2p:tm_two"), "an explicit route is not derived");
  assert.deepEqual(c.derived.boxes, ["submit"]);
});

test("config.overlay: an app whose handler is another role keeps it for its own boxes; the engine takes the derived ones", () => {
  const files = new Set([...overlayFiles, "bin/amm.wasm"]);
  const m = overlayApp(demoOverlay, { name: "amm", programs: { overlay: "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm", validator: "bin/amm.wasm" }, handler: "validator", boxes: [{ box: "amm", senders: ["*"] }] });
  const c = checkManifest(m, (p) => files.has(p));
  assert.deepEqual(c.manifest.handler, { amm: "validator", submit: "overlay", chain: "overlay", status: "overlay" });
  assert.deepEqual(c.manifest.routes.filter((r) => r.path === "/submit").map((r) => routeKey("amm", r)), ["path /amm/submit"], "/submit is the app's: /amm/submit");
});

test("config.overlay: its problems", () => {
  const p = (ov: unknown, more: Record<string, unknown> = {}) => overlayProblems(overlayApp(ov, more)).join("\n");
  assert.match(p({ topics: {} }), /topics: want \{<topic>: <role>\}, at least one/);
  assert.match(p({ topics: { tm_x: "nobody" } }), /topics\.tm_x: "nobody" is not a role/);
  assert.match(p({ topics: { "tm x": "topic-demo" } }), /is not a topic name/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, lookups: { ls_x: { program: "nobody" } } }), /lookups\.ls_x: program "nobody"/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, lookups: { ls_x: { program: "lookup-demo", topics: ["tm_other"] } } }), /lookups\.ls_x\.topics/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, status: "status" }), /status: "status" is not/);
  assert.match(p({ topics: { tm_demo: "topic-demo" }, gossip: { tm_other: false } }), /gossip: want/);
  assert.match(p(demoOverlay, { programs: { engine: "bin/overlay.wasm", "topic-demo": "bin/topic-demo.wasm", "lookup-demo": "bin/lookup-demo.wasm" } }), /the engine is the role "overlay"/);
  const w = overlayWiring({ topics: { tm_a: "t" }, status: `03${"cd".repeat(32)}` }, (r) => r === "t" || r === "overlay");
  assert.ok(!Array.isArray(w) && w.boxes.at(-1)!.senders[0] === `03${"cd".repeat(32)}`, "a remote status provider's key");
});
