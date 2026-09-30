// The host's management database (#23): which instances this host runs, one
// row each, in $SKEIN_HOME/host.db. Host-side state, outside every instance's
// graph: nothing in src/runtime reads it. Rows get here by hand (`skein-host
// add`), by script (scripts/host/instance.sh) or later by an API; `skein-host
// run` (the router, router.ts) serves every enabled row.
//
// #40: a row is an agent (its own identity) or a **mailbox instance** — an
// instance whose system is only the front door and the messagebox, keeping
// mail for an identity outside the host (`owner`: a user's wallet, the
// inference peer). There is no messagebox host: every identity's mailbox is
// an instance at its own origin. Beside the rows, the **fuel ledger**: what
// each caller's calls (#40: the front door's reads, which the log never sees)
// cost, per instance and op. And the broadcaster's two (#58, arc.ts): the
// last event id taken from Arcade's stream, and the statuses already routed.

import { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS instances (
  handle            TEXT PRIMARY KEY,                 -- the BRC-169 handle's user part, e.g. martha
  domain            TEXT NOT NULL DEFAULT 'localhost',
  identity          TEXT,                             -- the instance wallet's identity key, hex; filled once the wallet exists
  wallet_url        TEXT,                             -- its BRC-100 endpoint, e.g. http://127.0.0.1:3401
  wallet_originator TEXT NOT NULL DEFAULT 'skein',
  store             TEXT NOT NULL,                    -- its runtime.db
  tree              TEXT,                             -- the root CID of the directory last deployed into it (skein-host deploy)
  source            TEXT,                             -- that directory, for skein-host deploy --all
  knows             TEXT,                             -- JSON array of the handles this agent knows (its ROSTER.md); ["*"]: everyone; NULL: nobody
  status            TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at        TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'mailbox')),
  owner             TEXT                               -- a mailbox instance's: the identity (hex) whose mailbox it is
);
-- The fuel of calls (#40): per instance, caller (hex, or '' for none) and op (the route).
CREATE TABLE IF NOT EXISTS fuel_ledger (
  instance          TEXT NOT NULL,
  caller            TEXT NOT NULL,
  op                TEXT NOT NULL,
  calls             INTEGER NOT NULL DEFAULT 0,
  fuel              INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (instance, caller, op)
) WITHOUT ROWID;
-- The broadcaster's subscription (#58): the last event id taken from each SSE stream (Last-Event-ID on resume).
CREATE TABLE IF NOT EXISTS stream_cursor (
  stream            TEXT PRIMARY KEY,                 -- the events URL
  last_id           TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) WITHOUT ROWID;
-- The statuses already routed (#58): txid + txStatus + blockHash, so a redelivered one writes nothing.
CREATE TABLE IF NOT EXISTS status_seen (
  txid              TEXT NOT NULL,
  status            TEXT NOT NULL,                    -- txStatus, a space, the block hash ('' if none)
  at                TEXT NOT NULL,
  PRIMARY KEY (txid, status)
) WITHOUT ROWID;`;

export type Status = "enabled" | "disabled";

export type Kind = "agent" | "mailbox";

/** One row of the fuel ledger. */
export interface Ledger { instance: string; caller: string; op: string; calls: number; fuel: number; updated_at: string }

export interface InstanceRow {
  handle: string;
  domain: string;
  identity: string | null;
  wallet_url: string | null;
  wallet_originator: string;
  store: string;
  tree: string | null;
  source: string | null;
  /** JSON array of handles, `["*"]` for every other row; null: none. See knowsOf. */
  knows: string | null;
  status: Status;
  created_at: string;
  kind?: Kind;
  /** A mailbox instance's: whose mailbox it is (hex). */
  owner?: string | null;
}

/** The fields `add` sets; absent ones keep their value (or the column's default on insert). */
export type RowFields = Partial<Omit<InstanceRow, "handle" | "created_at">>;

const FIELDS = ["domain", "identity", "wallet_url", "wallet_originator", "store", "tree", "source", "knows", "status", "kind", "owner"] as const;

/** The handles a row knows: a list, or "all" (every other enabled row). */
export function knowsOf(row: Pick<InstanceRow, "knows">): string[] | "all" {
  const k = row.knows ? (JSON.parse(row.knows) as string[]) : [];
  return k.includes("*") ? "all" : k;
}

/** The `knows` column for a list of handles (`*` among them: everyone); an empty list is null. */
export function knowsColumn(handles: string[] | "all"): string | null {
  if (handles === "all" || handles.includes("*")) return JSON.stringify(["*"]);
  const k = [...new Set(handles)];
  return k.length ? JSON.stringify(k) : null;
}

export class HostDb {
  readonly db: DatabaseSync;

  /** `readOnly`: an existing file, read only (an instance's resolver beside the supervisor): no schema, no migration. */
  constructor(path: string, o: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: o.readOnly ?? false });
    this.db.exec("PRAGMA busy_timeout = 5000;"); // `run` holds it open while `deploy`/`add` write
    if (o.readOnly) return;
    this.db.exec(DDL);
    // Older files: columns added since.
    const cols = new Set(this.db.prepare("PRAGMA table_info(instances)").all().map((c) => c.name));
    if (!cols.has("source")) this.db.exec("ALTER TABLE instances ADD COLUMN source TEXT");
    if (!cols.has("knows")) this.db.exec("ALTER TABLE instances ADD COLUMN knows TEXT");
    if (!cols.has("kind")) this.db.exec("ALTER TABLE instances ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'");
    if (!cols.has("owner")) this.db.exec("ALTER TABLE instances ADD COLUMN owner TEXT");
  }

  /**
   * Insert `handle`, or update the given fields of the row that has it (so a
   * provisioning script can run again). A new row needs `store`.
   */
  add(handle: string, f: RowFields, now = new Date()): InstanceRow {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle)) throw new Error(`bad handle ${JSON.stringify(handle)}`);
    const set = FIELDS.filter((k) => f[k] !== undefined);
    if (this.get(handle)) {
      if (set.length) this.db.prepare(`UPDATE instances SET ${set.map((k) => `${k} = ?`).join(", ")} WHERE handle = ?`).run(...set.map((k) => f[k]!), handle);
    } else {
      if (!f.store) throw new Error(`${handle}: a new instance needs a store`);
      const cols = ["handle", ...set, "created_at"];
      this.db.prepare(`INSERT INTO instances (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(handle, ...set.map((k) => f[k]!), now.toISOString());
    }
    return this.get(handle)!;
  }

  get(handle: string): InstanceRow | undefined {
    const r = this.db.prepare("SELECT * FROM instances WHERE handle = ?").get(handle);
    return r ? { ...r } as unknown as InstanceRow : undefined; // node:sqlite rows have a null prototype
  }

  /**
   * The identity handle@domain names (BRC-169's answer): an agent's own, or
   * the owner of a mailbox instance (whose mailbox the instance is).
   */
  identityOf(handle: string, domain: string): string | undefined {
    const r = this.db.prepare("SELECT identity, kind, owner FROM instances WHERE handle = ? AND domain = ?").get(handle, domain) as { identity: string | null; kind?: string; owner?: string | null } | undefined;
    if (!r) return undefined;
    return (r.kind === "mailbox" ? r.owner : r.identity) ?? undefined;
  }

  list(status?: Status): InstanceRow[] {
    const q = status ? this.db.prepare("SELECT * FROM instances WHERE status = ? ORDER BY created_at, handle").all(status) : this.db.prepare("SELECT * FROM instances ORDER BY created_at, handle").all();
    return q.map((r) => ({ ...r }) as unknown as InstanceRow);
  }

  /** Set which handles a row knows (knowsColumn); false if there is no such row. */
  setKnows(handle: string, handles: string[] | "all"): boolean {
    return Number(this.db.prepare("UPDATE instances SET knows = ? WHERE handle = ?").run(knowsColumn(handles), handle).changes) > 0;
  }

  /** Set a row's status; false if there is no such row. */
  setStatus(handle: string, status: Status): boolean {
    return Number(this.db.prepare("UPDATE instances SET status = ? WHERE handle = ?").run(status, handle).changes) > 0;
  }

  /** Remove the row (not its store or wallet); false if there was none. */
  remove(handle: string): boolean {
    return Number(this.db.prepare("DELETE FROM instances WHERE handle = ?").run(handle).changes) > 0;
  }

  /** The enabled mailbox instance for identity `owner` (hex). */
  mailboxOf(owner: string): InstanceRow | undefined {
    const r = this.db.prepare("SELECT * FROM instances WHERE kind = 'mailbox' AND owner = ? AND status = 'enabled'").get(owner);
    return r ? { ...r } as unknown as InstanceRow : undefined;
  }

  /** Add calls and fuel to the ledger (#40): `rows` aggregated by (instance, caller, op). */
  charge(rows: Array<{ instance: string; caller: string; op: string; calls: number; fuel: number }>, now = new Date()): void {
    const st = this.db.prepare("INSERT INTO fuel_ledger (instance, caller, op, calls, fuel, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (instance, caller, op) DO UPDATE SET calls = calls + excluded.calls, fuel = fuel + excluded.fuel, updated_at = excluded.updated_at");
    for (const r of rows) st.run(r.instance, r.caller, r.op, r.calls, r.fuel, now.toISOString());
  }

  ledger(instance?: string): Ledger[] {
    const q = instance ? this.db.prepare("SELECT * FROM fuel_ledger WHERE instance = ? ORDER BY fuel DESC").all(instance) : this.db.prepare("SELECT * FROM fuel_ledger ORDER BY instance, fuel DESC").all();
    return q.map((r) => ({ ...r }) as unknown as Ledger);
  }

  /** The last event id taken from an SSE stream (#58), if any. */
  cursor(stream: string): string | undefined {
    const r = this.db.prepare("SELECT last_id FROM stream_cursor WHERE stream = ?").get(stream) as { last_id: string } | undefined;
    return r?.last_id;
  }

  setCursor(stream: string, id: string, now = new Date()): void {
    this.db.prepare("INSERT INTO stream_cursor (stream, last_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (stream) DO UPDATE SET last_id = excluded.last_id, updated_at = excluded.updated_at").run(stream, id, now.toISOString());
  }

  /** Note a status as routed (#58); false if it was already. */
  markStatus(txid: string, status: string, now = new Date()): boolean {
    return Number(this.db.prepare("INSERT OR IGNORE INTO status_seen (txid, status, at) VALUES (?, ?, ?)").run(txid, status, now.toISOString()).changes) > 0;
  }

  hasStatus(txid: string, status: string): boolean {
    return this.db.prepare("SELECT 1 FROM status_seen WHERE txid = ? AND status = ?").get(txid, status) !== undefined;
  }

  /** The enabled row whose identity is `identity`. */
  byIdentity(identity: string): InstanceRow | undefined {
    const r = this.db.prepare("SELECT * FROM instances WHERE identity = ? AND status = 'enabled'").get(identity);
    return r ? { ...r } as unknown as InstanceRow : undefined;
  }

  close(): void { this.db.close(); }
}
