// The route table's rows (skein next, SPEC 3): the TS mirror's rules (dispatch.ts rowProblem, as
// kernel-zig/src/dispatch.zig has them), the key, the fold and the match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, forPath, rowApp, rowKey, rowProblem, takesEvent, type DispatchRow } from "./dispatch.ts";

const R = (x: Record<string, unknown>) => x as DispatchRow;

test("dispatch: a row's rules — kind, path | name, role on request and read rows (nothing open by omission), checks, a kernel row's role", () => {
  for (const ok of [
    { kind: "request", path: "/a", role: "user", handler: "app.main.f" },
    { kind: "request", path: "/a", role: "anyone", checks: ["chain.beef"], recheck: "chain.unspent", handler: "app.f" },
    { kind: "read", path: "/r/", prefix: true, role: "anyone", handler: "app.main.read" },
    { kind: "event", name: "chain", handler: "chain.main.chain" },
    { kind: "request", path: "/kernel/route", role: "root", handler: "kernel.route" },
    { kind: "request", path: "/kernel/claim", role: "user", handler: "kernel.claim" },
    { kind: "request", path: "/a", role: "app.admin", handler: "app.f", root: "www" },
  ]) assert.equal(rowProblem(ok), undefined, JSON.stringify(ok));
  for (const [bad, why] of [
    [{ kind: "request", path: "/a", handler: "app.f" }, /role/],
    [{ kind: "request", path: "/a", role: "anyone", handler: "app.f" }, /at least one check/],
    [{ kind: "read", path: "/a", role: "anyone", checks: ["x.y"], handler: "app.f" }, /no checks/],
    [{ kind: "event", name: "x", role: "user", handler: "app.f" }, /no principal/],
    [{ kind: "request", path: "/kernel/route", role: "user", handler: "kernel.route" }, /role root/],
    [{ kind: "request", path: "/kernel/claim", role: "root", handler: "kernel.claim" }, /role user/],
    [{ kind: "request", path: "/k", role: "root", handler: "kernel.peers" }, /operations/],
    [{ kind: "request", path: "/a", role: "user", handler: "app.f", transport: "http" }, /transport/],
    [{ kind: "request", path: "/a", role: "user", handler: "app.f", app: "app" }, /app/],
    [{ transport: "mailbox", address: "x", program: "kernel" }, /kind/],
  ] as Array<[Record<string, unknown>, RegExp]>) assert.match(rowProblem(bad) ?? "", why, JSON.stringify(bad));
});

test("dispatch: the key (path and prefix for request and read rows together; name for events), the fold, the match", () => {
  assert.notEqual(rowKey(R({ kind: "request", path: "/x" })), rowKey(R({ kind: "request", path: "/x", prefix: true })));
  assert.equal(rowKey(R({ kind: "request", path: "/x" })), rowKey(R({ kind: "read", path: "/x" })));
  assert.equal(rowKey(R({ kind: "event", name: "chain" })), "event chain");
  const a = R({ kind: "request", path: "/a", role: "user", handler: "one.f" });
  const p = R({ kind: "read", path: "/a/", prefix: true, role: "anyone", handler: "one.r" });
  const e = R({ kind: "event", name: "chain", handler: "chain.c" });
  const rows = fold([{ op: "add", row: a }, { op: "add", row: p }, { op: "add", row: e }, { op: "add", row: R({ ...a, handler: "two.f" }) }, { op: "remove", row: p }]);
  assert.deepEqual(rows.map((r) => [rowKey(r), r.handler]), [["path /a", "two.f"], ["event chain", "chain.c"]]);
  assert.equal(forPath([a, p], "/a")?.handler, "one.f");
  assert.equal(forPath([a, p], "/a/b")?.handler, "one.r");
  assert.equal(forPath([a, p], "/b"), undefined);
  assert.ok(takesEvent(rows, "chain") && !takesEvent(rows, "chain/proof"));
  assert.equal(rowApp(a), "one");
  assert.equal(rowApp(R({ kind: "request", path: "/k", role: "root", handler: "kernel.route" })), undefined);
});
