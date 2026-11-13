// The app manifest's checks (skein next, SPEC 3; manifest.ts): the fields, the rows (paths and names
// relative to the app, the escapes, roles on the rows, checks, handlers, read rows), the declared roles,
// the forms gone, and `requires` against what the installed apps provide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rowKey } from "../runtime/dispatch.ts";
import { appName, appPath, checkManifest, handlerOf, ManifestError, missingInterfaces, roleOf, rowOf, shapeProblem } from "./manifest.ts";

const files = new Set(["bin/demo.wasm", "bin/engine.cid", "etc/app.json"]);
const has = (p: string) => files.has(p);
const base = () => ({
  kind: "app", name: "demo", version: "0.1.0",
  programs: { demo: "bin/demo.wasm" },
  provides: [{ interface: "demo.counter/1", functions: { get: { writes: false, args: {}, answer: { count: "int" } }, add: { writes: true, args: { by: "int", "note?": "string" } } } }],
  roles: { admin: "configures the demo" },
  routes: [
    { kind: "request", path: "/demo/call", role: "user", handler: "demo.call" },
    { kind: "request", path: "/demo/config", role: "demo.admin", handler: "demo.demo.config" },
    { kind: "request", path: "/demo/submit", role: "anyone", checks: ["chain.beef", "demo.admits"], recheck: "chain.unspent", handler: "demo.submit" },
    { kind: "read", path: "/demo/", prefix: true, role: "anyone", handler: "demo.page", root: "www" },
    { kind: "event", name: "demo", handler: "demo.event" },
    { kind: "event", name: "demo/deploy", checks: ["chain.beef"], handler: "demo.deploy" },
  ],
});
const problems = (m: unknown): string[] => {
  try { checkManifest(m, has); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};
const rows = (m: unknown) => { const c = checkManifest(m, has); return c.manifest.routes.map((r) => rowOf("demo", r, Object.keys(c.sources), Object.keys(c.manifest.roles ?? {}))); };

test("a good manifest: its rows exactly as the kernel takes them, under the app's own name", () => {
  assert.deepEqual(problems(base()), []);
  const r = rows(base());
  assert.deepEqual(r.map(rowKey), ["path /demo/call", "path /demo/config", "path /demo/submit", "path /demo/ prefix", "event demo", "event demo/deploy"]);
  assert.deepEqual(r.map((x) => x.role), ["user", "demo.admin", "anyone", "anyone", undefined, undefined]);
  assert.deepEqual(r.map((x) => x.handler), ["demo.call", "demo.demo.config", "demo.submit", "demo.page", "demo.event", "demo.deploy"]);
  assert.deepEqual(r[2]!.checks, ["chain.beef", "demo.admits"]);
  assert.equal(r[2]!.recheck, "chain.unspent");
  assert.equal(r[3]!.root, "www", "a setting rides on the row");
});

test("rows: under the app's name; nothing open by omission; anyone needs a check; a read has no checks; an event has no role; the old row form refused", () => {
  const m = (route: Record<string, unknown>) => problems({ ...base(), routes: [route] }).join("\n");
  assert.match(m({ kind: "request", path: "/other/x", role: "user", handler: "demo.x" }), /a path under its own/);
  assert.match(m({ kind: "request", path: "/demox", role: "user", handler: "demo.x" }), /a path under its own/);
  assert.match(m({ kind: "event", name: "chain", handler: "demo.x" }), /a name under its own/);
  assert.match(m({ kind: "request", path: "/demo/x", role: "user", handler: "other.x" }), /one of this app's functions/);
  assert.match(m({ kind: "request", path: "/demo/x", handler: "demo.x" }), /role: every request and read row names its role/);
  assert.match(m({ kind: "request", path: "/demo/x", role: "anyone", handler: "demo.x" }), /at least one check/);
  assert.match(m({ kind: "read", path: "/demo/x", role: "anyone", checks: ["demo.c"], handler: "demo.x" }), /no checks/);
  assert.match(m({ kind: "event", name: "demo/x", role: "user", handler: "demo.x" }), /no principal/);
  assert.match(m({ kind: "request", path: "/demo/x", role: "demo.owner", handler: "demo.x" }), /declared roles/);
  assert.match(m({ kind: "request", path: "/demo/x", role: "user", checks: ["demo.other.c"], handler: "demo.x" }), /no role other/);
  assert.match(m({ kind: "request", path: "/demo/../x", role: "user", handler: "demo.x" }), /segment/);
  assert.match(m({ kind: "box", path: "/demo/x", role: "user", handler: "demo.x" }), /want request, read or event/);
  for (const k of ["transport", "address", "filters", "program", "fn", "sender", "app"]) assert.match(m({ kind: "request", path: "/demo/x", role: "user", handler: "demo.x", [k]: "y" }), new RegExp(`${k}: `), k);
  assert.match(problems({ ...base(), routes: [base().routes[0], base().routes[0]] }).join("\n"), /path \/demo\/call twice/);
  assert.deepEqual(problems({ ...base(), routes: [{ kind: "request", path: "/demo/x", role: "chain.status", handler: "demo.x" }] }), [], "another app's role as written");
});

test("paths are relative to /<app>/; names to the app; escapes refused", () => {
  assert.equal(appPath("demo", "/call"), "/demo/call");
  assert.equal(appPath("demo", "call"), "/demo/call");
  assert.equal(appPath("demo", "/"), "/demo/");
  for (const bad of ["/../x", "/a/./b", "/%2e%2e/x", "https://x/y", "/a?b", "/a b"]) assert.throws(() => appPath("demo", bad), Error, bad);
  assert.equal(appName("demo", ""), "demo");
  assert.equal(appName("demo", "demo"), "demo");
  assert.equal(appName("demo", "deploy"), "demo/deploy");
  for (const bad of ["/x", "a//b", "..", "a b"]) assert.throws(() => appName("demo", bad), Error, bad);
});

test("handlers and roles: <role>.<fn> or a function of the one program; a declared role → <app>.<role>, another app's as written", () => {
  assert.deepEqual(handlerOf("demo.call", ["demo"]), { role: "demo", fn: "call" });
  assert.deepEqual(handlerOf("call", ["demo"]), { role: "demo", fn: "call" });
  assert.equal(handlerOf("call", ["a", "b"]), undefined);
  assert.equal(roleOf("demo", "admin", ["admin"]), "demo.admin");
  assert.equal(roleOf("demo", "chain.status", []), "chain.status");
  assert.equal(roleOf("demo", "demo.nope", ["admin"]), undefined);
  for (const r of ["anyone", "user", "root"]) assert.equal(roleOf("demo", r, []), r);
});

test("shapes", () => {
  assert.equal(shapeProblem({ a: "int", "b?": ["string"], c: { d: "cid" }, e: "map", f: "any", g: "ms", h: "bytes", i: "bool" }, "args"), undefined);
  assert.match(shapeProblem(["int", "string"], "args")!, /one element shape/);
  assert.match(shapeProblem(3, "args")!, /a shape is a type name/);
});

test("name, version, programs, provides, roles", () => {
  assert.match(problems({ ...base(), name: "Demo" }).join("\n"), /is not a name/);
  for (const n of ["kernel", "grants", "root", "user", "anyone"]) assert.match(problems({ ...base(), name: n }).join("\n"), /the kernel's/, n);
  assert.match(problems({ ...base(), version: "1" }).join("\n"), /not semver/);
  assert.match(problems({ ...base(), programs: { demo: "bin/nope.wasm" } }).join("\n"), /not in the tree/);
  assert.match(problems({ ...base(), programs: { demo: { code: "shell" } } }).join("\n"), /no shell programs/);
  assert.match(problems({ ...base(), provides: [{ interface: "x", functions: {} }] }).join("\n"), /interface is not <name>\/<major>/);
  assert.match(problems({ ...base(), roles: { admin: ["config"] } }).join("\n"), /roles.admin: want text/);
  assert.match(problems({ ...base(), roles: { root: "x" } }).join("\n"), /not root, user or anyone/);
});

test("requires: provided by some installed app's head", () => {
  const installed = [{ provides: [{ interface: "wallet.records/1", functions: {} }] }, {}];
  assert.deepEqual(missingInterfaces(["wallet.records/1"], installed), []);
  assert.deepEqual(missingInterfaces(["wallet.records/2", "overlay.topics/1"], installed), ["wallet.records/2", "overlay.topics/1"]);
});

test("the forms gone are refused: filters, start/stop, dispatch, reads, the form before #77", () => {
  for (const f of ["handler", "boxes", "heads"]) assert.match(problems({ ...base(), [f]: [] }).join("\n"), new RegExp(`${f}: the form before #77 is gone`));
  assert.match(problems({ ...base(), filters: {} }).join("\n"), /filters: gone \(skein next\)/);
  assert.match(problems({ ...base(), start: { body: {} } }).join("\n"), /start: gone \(skein next\)/);
  assert.match(problems({ ...base(), stop: { body: {} } }).join("\n"), /stop: gone \(skein next\)/);
  assert.match(problems({ ...base(), dispatch: [] }).join("\n"), /dispatch: gone/);
  assert.match(problems({ ...base(), reads: [] }).join("\n"), /reads: gone/);
});

test("calls and services (call permissions): per callee, names or \"*\"; services from the kernel's list", () => {
  assert.deepEqual(problems({ ...base(), calls: { signer: ["1/amm pool", "2/skein instance/self"], wallet: "*" }, services: ["signer"] }), []);
  assert.match(problems({ ...base(), calls: { signer: [] } }).join("\n"), /calls\.signer: want "\*" or a list of names/);
  assert.match(problems({ ...base(), calls: { signer: ["x".repeat(257)] } }).join("\n"), /1 to 256 bytes/);
  assert.match(problems({ ...base(), calls: { "Not An App": ["x"] } }).join("\n"), /is not an app's name/);
  assert.match(problems({ ...base(), services: ["http"] }).join("\n"), /services: a list of kernel services \(signer\)/);
});
