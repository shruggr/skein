// Root's requests (skein next, SPEC.md section 3): building them is a library — installing an app,
// removing it, root's own row, a directory into `main`, a grant, the claim — each a few requests to the
// kernel's operation rows (plan.ts KERNEL_PATHS: objects, head, route, grant; the claim's), each
// returning data (done, or refused with the reason). The client `skein` (admin-cli.ts) signs each with
// the operator's key under the `signed` scheme (raw.ts signRequest) and hands it to the running host
// over its control socket (target.ts); an application host (Open Exchange) signs them with its own key
// and hands them to its router (Router.messageLocal).
//
// A request is a path and a body (a record value: what the kernel's operation takes; dag-cbor on the wire).

import * as dagCbor from "@ipld/dag-cbor";
import type { CID } from "multiformats/cid";
import { hashDir, recordBundles, type Rec } from "./bundle.ts";
import { rowProblem, type DispatchRow } from "../runtime/dispatch.ts";
import { MAIN } from "../runtime/heads.ts";
import { DEFAULT_ONLY, onlyIgnore } from "../host/deploy.ts";
import { describe, installRequests, KERNEL_PATHS, mergeConfig, planInstall, planRootRoute, planUninstall, showGrant, showRow, uninstallRequests, type AppRecord, type AppTree, type InstanceView } from "../host/plan.ts";
import { isCallName, MAX_CALL_NAME, PARTY, SERVICES } from "../host/manifest.ts";
import type { Objects } from "../host/boot.ts";

/** One of root's requests: the kernel operation row's path and the body (a record value). */
export interface AdminRequest { path: string; body: unknown }

/** What the admin commands build: the prompt (what the requests do), the recipient (the instance's identity, hex), the requests in order. */
export interface AdminPlan { prompt: string[]; recipient: string; requests: AdminRequest[] }

const isKey = (s: string) => /^0[23][0-9a-f]{64}$/.test(s);
const keyBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const decoded = (rs: Array<{ path: string; body: Uint8Array }>): AdminRequest[] => rs.map((r) => ({ path: r.path, body: dagCbor.decode(r.body) }));

/**
 * Install (or upgrade) the app `tree` into the instance `view` reads (docs/APPS.md §3): objects (≤ 1 MiB
 * bundles), the head `<app>/app`, a route request per row that changes, the grants. `config` is merged
 * over the manifest's. `modules`: where a `bin/<x>.cid` module the instance lacks is found.
 */
export async function planInstallApp(tree: AppTree, view: InstanceView, o: { config?: Record<string, unknown>; modules?: Objects } = {}): Promise<AdminPlan & { app: string; version: string; recordCid: CID; record: AppRecord }> {
  if (o.config) tree.checked.manifest.config = mergeConfig(tree.checked.manifest.config, o.config);
  const plan = await planInstall(tree, view, { modules: o.modules ?? { get: async () => undefined } });
  return { prompt: describe(plan), recipient: view.identity, requests: decoded(installRequests(plan)), app: plan.app, version: plan.version, recordCid: plan.recordCid, record: plan.record };
}

/** Uninstall: every row the app's handler names removed, its grants taken back; its heads are left. */
export async function planUninstallApp(name: string, view: InstanceView): Promise<AdminPlan> {
  const p = await planUninstall(name, view);
  const prompt = [`uninstall ${name} ${p.record.version} · route remove ×${p.rows.length}${p.grants.length ? ` · grant remove ×${p.grants.length}` : ""} · head ${name}/app left`, ...p.rows.map((r) => `    route ${showRow(r)}`), ...p.grants.map((g) => `    grant ${showGrant(g)}`)];
  return { prompt, recipient: view.identity, requests: decoded(uninstallRequests(p)) };
}

/** Root's own row (`skein routes`): one `route` add or remove of a row as the kernel takes it (a remove names the row as held). */
export async function planRoute(view: InstanceView, op: "add" | "remove", row: DispatchRow): Promise<AdminPlan> {
  if (op === "add") { const why = rowProblem(row); if (why) throw new Error(`row: ${why}`); }
  const p = await planRootRoute(view, op, row);
  return { prompt: p.prompt, recipient: view.identity, requests: p.rows.map((r) => ({ path: KERNEL_PATHS.route, body: { op: r.op, row: r.row } })) };
}

/** The claim (SPEC 3): one request to the image's claim row — its sender is granted root, the claim row removed. */
export function planClaim(recipient: string, o: { handle?: string; domain?: string } = {}): AdminPlan {
  const body = { ...(o.handle ? { handle: o.handle, ...(o.domain ? { domain: o.domain } : {}) } : {}) };
  return { prompt: [`claim ${recipient}: root to the key that sends this${o.handle ? ` (@${o.handle}${o.domain ? `@${o.domain}` : ""})` : ""}`], recipient, requests: [{ path: KERNEL_PATHS.claim, body }] };
}

/**
 * A directory into the instance's `main` (#23): its git objects in ≤ 1 MiB bundles to `objects`, the
 * root on the last (the kernel sets `main` when there is none), then `head {name: "main", tree}` when
 * `main` is another tree. `only` filters the directory (deploy.ts onlyIgnore; default DEFAULT_ONLY; []
 * for all of it). Records the view's store has are not sent.
 */
export async function planDeploy(dir: string, target: InstanceView | { identity: string }, o: { only?: string[] } = {}): Promise<AdminPlan & { root: CID }> {
  const only = o.only ?? DEFAULT_ONLY;
  const { root, records } = await hashDir(dir, only.length ? { ignore: onlyIgnore(dir, only) } : {});
  const view = "store" in target ? target as InstanceView : undefined;
  const { records: n, bundles } = await recordBundles(root, records as Rec[], view ? { skip: (c) => view.store.has(c) } : {});
  const main = view?.heads.find((h) => h.name === MAIN)?.root;
  const head = !view || (main !== undefined && !main.equals(root));
  const requests: AdminRequest[] = bundles.map((b) => ({ path: KERNEL_PATHS.objects, body: dagCbor.decode(b) }));
  if (head) requests.push({ path: KERNEL_PATHS.head, body: { name: MAIN, tree: root } });
  const prompt = [`deploy ${dir} → main ${root}${main?.equals(root) ? " (main is this tree already)" : ""}`, `  requests  objects ×${bundles.length} (${n} records)${head ? " · head main" : ""}`];
  return { prompt, recipient: target.identity, requests, root };
}

/** A grant (the kernel's `grant` operation): `role` (root by default, or `<app>.<role>`) to `key`, or with `remove` from it. Nothing is sent when the grants say so already. */
export async function planGrant(view: InstanceView, key: string, o: { role?: string; remove?: boolean } = {}): Promise<AdminPlan> {
  if (!isKey(key)) throw new Error(`${key}: not an identity key (hex)`);
  const role = o.role ?? "root";
  if (role !== "root" && !/^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9_-]*$/.test(role)) throw new Error(`${role}: a role is root or <app>.<role> (user and anyone are never granted)`);
  const op = o.remove ? "remove" : "add";
  const root = view.heads.find((h) => h.name === "grants")?.root;
  const g = root ? await view.store.get(root).catch(() => undefined) as { roles?: Record<string, unknown[]> } | undefined : undefined;
  const holds = (g?.roles?.[role] ?? []).some((k) => (k instanceof Uint8Array ? Buffer.from(k).toString("hex") : String(k)) === key);
  if (holds === (op === "add")) return { prompt: [`grant ${op} ${role} ${key}: the grants say so already`], recipient: view.identity, requests: [] };
  return { prompt: [`grant ${op} ${role} ${key}`], recipient: view.identity, requests: [{ path: KERNEL_PATHS.grant, body: { op, role, principal: keyBytes(key) } }] };
}

/** A call permission (`skein grant --calls`): the kernel's `grant` with `calls: {caller, callee, name}` ("*": any name). */
export function planGrantCalls(view: InstanceView, caller: string, callee: string, name: string, o: { remove?: boolean } = {}): AdminPlan {
  for (const p of [caller, callee]) if (!PARTY.test(p)) throw new Error(`${p}: a caller or callee is an app's name`);
  if (!isCallName(name)) throw new Error(`${JSON.stringify(name)}: a call's name is 1 to ${MAX_CALL_NAME} bytes with no NUL ("*": any)`);
  const op = o.remove ? "remove" : "add";
  return { prompt: [`grant ${op}: ${caller} calls ${callee} as ${name === "*" ? "ANY NAME (admin)" : JSON.stringify(name)}`], recipient: view.identity, requests: [{ path: KERNEL_PATHS.grant, body: { op, calls: { caller, callee, name } } }] };
}

/** A kernel service (`skein grant --service`): the kernel's `grant` with `service: {caller, service}`. */
export function planGrantService(view: InstanceView, caller: string, service: string, o: { remove?: boolean } = {}): AdminPlan {
  if (!PARTY.test(caller)) throw new Error(`${caller}: a caller is an app's name`);
  if (!SERVICES.includes(service)) throw new Error(`${service}: not a kernel service (${SERVICES.join(", ")})`);
  const op = o.remove ? "remove" : "add";
  return { prompt: [`grant ${op}: ${caller} ${o.remove ? "loses" : "holds"} service ${service}${service === "signer" ? " (the raw signer import: any derivation)" : ""}`], recipient: view.identity, requests: [{ path: KERNEL_PATHS.grant, body: { op, service: { caller, service } } }] };
}
