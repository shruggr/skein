// The host's management database (#23): which instances this host runs, one
// row each, in $SKEIN_HOME/host.db. Host-side state, outside every instance's
// graph: nothing in src/runtime reads it. Rows get here by hand (`skein-host
// add`), by script (scripts/host/instance.sh) or later by an API; `skein-host
// run` starts every enabled one (host.ts).

import { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS instances (
  handle            TEXT PRIMARY KEY,                 -- the BRC-169 handle's user part, e.g. martha
  domain            TEXT NOT NULL DEFAULT 'localhost',
  identity          TEXT,                             -- the instance wallet's identity key, hex; filled once the wallet exists
  wallet_url        TEXT,                             -- its BRC-100 endpoint, e.g. http://127.0.0.1:3401
  wallet_originator TEXT NOT NULL DEFAULT 'skein',
  store             TEXT NOT NULL,                    -- its runtime.db
  tree              TEXT,                             -- the CID the genesis's main should point at (#4; recorded, not acted on yet)
  status            TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at        TEXT NOT NULL
);`;

export type Status = "enabled" | "disabled";

export interface InstanceRow {
  handle: string;
  domain: string;
  identity: string | null;
  wallet_url: string | null;
  wallet_originator: string;
  store: string;
  tree: string | null;
  status: Status;
  created_at: string;
}

/** The fields `add` sets; absent ones keep their value (or the column's default on insert). */
export type RowFields = Partial<Omit<InstanceRow, "handle" | "created_at">>;

const FIELDS = ["domain", "identity", "wallet_url", "wallet_originator", "store", "tree", "status"] as const;

export class HostDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(DDL);
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

  /** The recorded identity for handle@domain (the resolver's first answer), if any. */
  identityOf(handle: string, domain: string): string | undefined {
    const r = this.db.prepare("SELECT identity FROM instances WHERE handle = ? AND domain = ?").get(handle, domain) as { identity: string | null } | undefined;
    return r?.identity ?? undefined;
  }

  list(status?: Status): InstanceRow[] {
    const q = status ? this.db.prepare("SELECT * FROM instances WHERE status = ? ORDER BY created_at, handle").all(status) : this.db.prepare("SELECT * FROM instances ORDER BY created_at, handle").all();
    return q.map((r) => ({ ...r }) as unknown as InstanceRow);
  }

  /** Set a row's status; false if there is no such row. */
  setStatus(handle: string, status: Status): boolean {
    return Number(this.db.prepare("UPDATE instances SET status = ? WHERE handle = ?").run(status, handle).changes) > 0;
  }

  /** Remove the row (not its store or wallet); false if there was none. */
  remove(handle: string): boolean {
    return Number(this.db.prepare("DELETE FROM instances WHERE handle = ?").run(handle).changes) > 0;
  }

  close(): void { this.db.close(); }
}
