// The host's management database (#23): which instances this host runs, one
// row each, in $SKEIN_HOME/host.db. Host-side state, outside every instance's
// graph: nothing in src/runtime reads it. Rows get here by hand (`skein-host
// add`), by the instance manager (`create`, #90), or by registration; `skein-host
// run` (the router, router.ts) serves every enabled row.
//
// A row is an instance with its own identity (#40). Mail for identities
// outside the host is kept by a messagebox app (shruggr/skein-messagebox, in
// the host skein: one mailbox per registered key), not by an instance per
// identity: since 0.4.1 there are no mailbox instances (files made before keep
// their `kind` and `owner` columns, unread). Beside the rows, the **fuel ledger**: what
// each caller's calls (#40: the front door's reads, which the log never sees)
// cost, per instance and op. And the broadcaster's three (#58, #65, arc.ts):
// the last event id taken from Arcade's stream, the statuses already routed,
// and the queue of broadcasts Arcade has not taken yet. And the cron
// provider's one (#69, cron.ts): the schedules the instances asked for.
// And the host's own settings (#90): which row is the host skein — the
// operator's instance (`skein-host init`), whose identity alone reaches the
// instance manager. And overlay sync's: the peers each
// instance's overlay topics heard beats from (`topic_peers`). And the liveness
// tool's (#138): the beats it kept, reloaded at a start (`live_beats`).

import { DatabaseSync } from "node:sqlite";

const DDL = `
CREATE TABLE IF NOT EXISTS instances (
  handle            TEXT PRIMARY KEY,                 -- the BRC-169 handle's user part, e.g. martha
  domain            TEXT NOT NULL DEFAULT 'localhost',
  identity          TEXT,                             -- the instance's identity key, hex: the signer's child for the handle
  store             TEXT NOT NULL,                    -- its runtime.db, or rocksdb:<db dir> / sqlite:<db path>: its set (its handle) in the host's shared store
  tree              TEXT,                             -- the root CID of the directory last deployed into it (skein-host deploy)
  source            TEXT,                             -- that directory, for skein-host deploy --all
  knows             TEXT,                             -- JSON array of the handles this agent knows (its ROSTER.md); ["*"]: everyone; NULL: nobody
  status            TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created_at        TEXT NOT NULL,
  topics            TEXT                               -- JSON array: the overlay names (topics, lookup services) the host routes to it at the bare host (#137); NULL: none
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
-- The statuses already seen (#58): txid + txStatus + blockHash, so a redelivered one writes nothing; the
-- host-level ones (skein 0.9.0: not delivered into an instance) are recorded here too.
CREATE TABLE IF NOT EXISTS status_seen (
  txid              TEXT NOT NULL,
  status            TEXT NOT NULL,                    -- txStatus, a space, the block hash ('' if none)
  at                TEXT NOT NULL,
  PRIMARY KEY (txid, status)
) WITHOUT ROWID;
-- The broadcaster's queue (#58, #65, arc.ts): a transaction an instance broadcast (its broadcast event),
-- held until Arcade answers it taken or refused, tried again with backoff while it does not.
CREATE TABLE IF NOT EXISTS broadcast_queue (
  txid              TEXT PRIMARY KEY,
  body              BLOB NOT NULL,                    -- what goes to Arcade: Extended Format (arc.ts arcadeBody)
  instances         TEXT NOT NULL,                    -- JSON array: the instances that broadcast it
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_at           INTEGER NOT NULL,                 -- ms: when it is posted (again)
  since             INTEGER NOT NULL,                 -- ms: when it was first queued (given up a day on)
  last_error        TEXT
) WITHOUT ROWID;
-- The cron provider's schedules (#69, cron.ts): what each instance asked to be ticked, by name, until it
-- says stop (an \`at\` one until it fired).
CREATE TABLE IF NOT EXISTS cron_schedule (
  instance          TEXT NOT NULL,                    -- the handle the ticks go to
  name              TEXT NOT NULL,
  recipient         TEXT NOT NULL,                    -- its identity key (hex): the ticks' recipient
  spec              BLOB NOT NULL,                    -- dag-cbor {every | at, box, body?}
  request           TEXT NOT NULL,                    -- the tick request's CID
  next              INTEGER NOT NULL,                 -- ms: the next tick
  PRIMARY KEY (instance, name)
) WITHOUT ROWID;
-- The host's settings (#90): key → value. \`host_skein\`: the handle of the host skein. \`image\`, \`image_chain\` (#132):
-- the default image's current root tree and its \`chain\` tree (image-chain.ts).
CREATE TABLE IF NOT EXISTS host_settings (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
) WITHOUT ROWID;
-- The default image's chain part (#132, image-chain.ts): the git objects of its \`chain/\` (the header blocks, the tip,
-- their trees) and its root tree, as the host grows them; only the current ones (a replaced object is deleted).
CREATE TABLE IF NOT EXISTS image_blocks (
  cid               TEXT PRIMARY KEY,                 -- the object's CID (git-raw, sha1)
  bytes             BLOB NOT NULL                     -- the git object ("blob <n>\\0…", "tree <n>\\0…")
);
-- Overlay sync (the settled design, David 2026-10-30): per instance and overlay topic, the peers whose beats on
-- <topic>-live were kept, with the addresses the node knew for them; a restart dials them and asks at once.
CREATE TABLE IF NOT EXISTS topic_peers (
  handle            TEXT NOT NULL,
  topic             TEXT NOT NULL,                    -- the overlay topic (not its -live)
  peer_id           TEXT NOT NULL,                    -- the libp2p peer ID
  addrs             TEXT NOT NULL,                    -- JSON array of multiaddrs (may be empty)
  last_seen         INTEGER NOT NULL,                 -- ms: the last beat kept from it
  PRIMARY KEY (handle, topic, peer_id)
) WITHOUT ROWID;
-- The liveness tool's beats (#138, liveness.ts): per instance and liveness topic, the latest beat kept from each
-- sender, the frame as received; a start feeds them through the tool again (signature and window re-checked).
CREATE TABLE IF NOT EXISTS live_beats (
  handle            TEXT NOT NULL,
  topic             TEXT NOT NULL,                    -- the liveness topic (e.g. <topic>-live)
  sender            TEXT NOT NULL,                    -- the beat's identity key (hex)
  at                INTEGER NOT NULL,                 -- ms: the beat's own time
  peer_id           TEXT NOT NULL,                    -- the libp2p peer that published it
  frame             BLOB NOT NULL,                    -- the beacon frame (p2p.ts beaconFrame)
  PRIMARY KEY (handle, topic, sender)
) WITHOUT ROWID;`;

/**
 * A handle: one hostname label (lower-case letters, digits and "-", at most
 * 63, no "-" at either end), so `<handle>.<domain>` is the instance's origin.
 * The one grammar for every row (H22): `add`, the instance manager's
 * `create`.
 */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A path-only handle (#161): a token id `<txid>_<vout>` (64 lower-case hex digits, `_`, the output
 * index). Not a hostname label, so its instance is published under no hostname: it is reached at
 * `/@<handle>/…` on the host's origin only (Router.target, originOf). Everything else about its row is
 * a row's.
 */
export const TOKEN_HANDLE = /^[0-9a-f]{64}_[0-9]+$/;

/** Whether `handle` is a handle this host takes (#161): a hostname label (HANDLE), or a path-only token id (TOKEN_HANDLE). */
export const validHandle = (handle: string): boolean => HANDLE.test(handle) || TOKEN_HANDLE.test(handle);

/** Whether `handle` is path-only (#161): a token id, reached by `/@<handle>` and never by a hostname. */
export const pathOnly = (handle: string): boolean => TOKEN_HANDLE.test(handle);

export type Status = "enabled" | "disabled";

/** One row of the fuel ledger. */
export interface Ledger { instance: string; caller: string; op: string; calls: number; fuel: number; updated_at: string }

export interface InstanceRow {
  handle: string;
  domain: string;
  identity: string | null;
  store: string;
  tree: string | null;
  source: string | null;
  /** JSON array of handles, `["*"]` for every other row; null: none. See knowsOf. */
  knows: string | null;
  status: Status;
  created_at: string;
  /**
   * JSON array of the overlay names (gossip topics and lookup services alike) a bare-host POST /submit
   * or /lookup naming them is routed to this instance by (#137: what the instance manager's create or
   * start named; Router.overlayTarget); null: none. See topicsOf.
   */
  topics?: string | null;
}

/** The fields `add` sets; absent ones keep their value (or the column's default on insert). */
export type RowFields = Partial<Omit<InstanceRow, "handle" | "created_at">>;

const FIELDS = ["domain", "identity", "store", "tree", "source", "knows", "status", "topics"] as const;

/** The overlay names a row is routed by (#137): its `topics` column, a list (none: empty). */
export function topicsOf(row: Pick<InstanceRow, "topics">): string[] {
  return row.topics ? (JSON.parse(row.topics) as string[]) : [];
}

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
    // Older files: columns added since. Files from before #33 also carry
    // wallet_url and wallet_originator (an instance's own wallet-api): nothing
    // reads them, and an insert leaves them to their defaults.
    const cols = new Set(this.db.prepare("PRAGMA table_info(instances)").all().map((c) => c.name));
    if (!cols.has("source")) this.db.exec("ALTER TABLE instances ADD COLUMN source TEXT");
    if (!cols.has("knows")) this.db.exec("ALTER TABLE instances ADD COLUMN knows TEXT");
    if (!cols.has("topics")) this.db.exec("ALTER TABLE instances ADD COLUMN topics TEXT");
  }

  /**
   * Insert `handle`, or update the given fields of the row that has it (so a
   * provisioning script can run again). A new row needs `store`.
   */
  add(handle: string, f: RowFields, now = new Date()): InstanceRow {
    const set = FIELDS.filter((k) => f[k] !== undefined);
    if (this.get(handle)) {
      if (set.length) this.db.prepare(`UPDATE instances SET ${set.map((k) => `${k} = ?`).join(", ")} WHERE handle = ?`).run(...set.map((k) => f[k]!), handle);
    } else {
      // A new row's handle is a hostname label; a row an older file already has keeps its handle.
      if (!validHandle(handle)) throw new Error(`bad handle ${JSON.stringify(handle)}: lower-case letters, digits and "-", at most 63, as a hostname label; or a token id <txid>_<vout> (path-only, #161)`);
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

  /** The identity handle@domain names (BRC-169's answer): the instance's own. */
  identityOf(handle: string, domain: string): string | undefined {
    const r = this.db.prepare("SELECT identity FROM instances WHERE handle = ? AND domain = ?").get(handle, domain) as { identity: string | null } | undefined;
    return r?.identity ?? undefined;
  }

  list(status?: Status): InstanceRow[] {
    const q = status ? this.db.prepare("SELECT * FROM instances WHERE status = ? ORDER BY created_at, handle").all(status) : this.db.prepare("SELECT * FROM instances ORDER BY created_at, handle").all();
    return q.map((r) => ({ ...r }) as unknown as InstanceRow);
  }

  /** Set which handles a row knows (knowsColumn); false if there is no such row. */
  setKnows(handle: string, handles: string[] | "all"): boolean {
    return Number(this.db.prepare("UPDATE instances SET knows = ? WHERE handle = ?").run(knowsColumn(handles), handle).changes) > 0;
  }

  /** Set the overlay names a row is routed by (#137; topicsOf); an empty list is null; false if there is no such row. */
  setTopics(handle: string, topics: string[]): boolean {
    return Number(this.db.prepare("UPDATE instances SET topics = ? WHERE handle = ?").run(topics.length ? JSON.stringify(topics) : null, handle).changes) > 0;
  }

  /** Set a row's status; false if there is no such row. */
  setStatus(handle: string, status: Status): boolean {
    return Number(this.db.prepare("UPDATE instances SET status = ? WHERE handle = ?").run(status, handle).changes) > 0;
  }

  /** Remove the row (not its store or wallet); false if there was none. */
  remove(handle: string): boolean {
    return Number(this.db.prepare("DELETE FROM instances WHERE handle = ?").run(handle).changes) > 0;
  }

  /** A liveness beat kept (#138): the sender's row on `handle`'s `topic` replaced. */
  putBeat(handle: string, topic: string, b: { sender: string; at: number; from: string; frame: Uint8Array }): void {
    this.db.prepare("INSERT INTO live_beats (handle, topic, sender, at, peer_id, frame) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (handle, topic, sender) DO UPDATE SET at = excluded.at, peer_id = excluded.peer_id, frame = excluded.frame")
      .run(handle, topic, b.sender, b.at, b.from, b.frame);
  }

  /** The liveness beats kept for `handle` (on `topic` only, when named). */
  beatsOf(handle: string, topic?: string): Array<{ topic: string; sender: string; at: number; from: string; frame: Uint8Array }> {
    const rows = topic === undefined
      ? this.db.prepare("SELECT topic, sender, at, peer_id, frame FROM live_beats WHERE handle = ? ORDER BY topic, sender").all(handle)
      : this.db.prepare("SELECT topic, sender, at, peer_id, frame FROM live_beats WHERE handle = ? AND topic = ? ORDER BY sender").all(handle, topic);
    return rows.map((r) => ({ topic: String(r.topic), sender: String(r.sender), at: Number(r.at), from: String(r.peer_id), frame: new Uint8Array(r.frame as Uint8Array) }));
  }

  /** Forget `handle`'s liveness beats: all, a topic's, or one sender's on a topic. */
  dropBeats(handle: string, topic?: string, sender?: string): void {
    if (topic === undefined) this.db.prepare("DELETE FROM live_beats WHERE handle = ?").run(handle);
    else if (sender === undefined) this.db.prepare("DELETE FROM live_beats WHERE handle = ? AND topic = ?").run(handle, topic);
    else this.db.prepare("DELETE FROM live_beats WHERE handle = ? AND topic = ? AND sender = ?").run(handle, topic, sender);
  }

  /** Forget the liveness beats dated before `before` (ms). → how many rows went. */
  pruneBeats(before: number): number {
    return Number(this.db.prepare("DELETE FROM live_beats WHERE at < ?").run(before).changes);
  }

  /** A beat kept from `peer` on `handle`'s overlay `topic` (sync): upserted with its addresses (kept when none are known now). */
  seenPeer(handle: string, topic: string, peer: string, addrs: string[], now: number): void {
    this.db.prepare("INSERT INTO topic_peers (handle, topic, peer_id, addrs, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT (handle, topic, peer_id) DO UPDATE SET addrs = CASE WHEN excluded.addrs = '[]' THEN addrs ELSE excluded.addrs END, last_seen = excluded.last_seen")
      .run(handle, topic, peer, JSON.stringify(addrs), now);
  }

  /** The peers `handle`'s overlay `topic` heard beats from, the latest first. */
  topicPeers(handle: string, topic: string): Array<{ peer: string; addrs: string[]; lastSeen: number }> {
    return this.db.prepare("SELECT peer_id, addrs, last_seen FROM topic_peers WHERE handle = ? AND topic = ? ORDER BY last_seen DESC, peer_id").all(handle, topic)
      .map((r) => ({ peer: String(r.peer_id), addrs: JSON.parse(String(r.addrs)) as string[], lastSeen: Number(r.last_seen) }));
  }

  /** Forget the peers not heard from since `before` (ms). → how many rows went. */
  prunePeers(before: number): number {
    return Number(this.db.prepare("DELETE FROM topic_peers WHERE last_seen < ?").run(before).changes);
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

  /** The statuses seen for `txid` (each `txStatus blockHash`), in no order. */
  statusesOf(txid: string): string[] {
    return (this.db.prepare("SELECT status FROM status_seen WHERE txid = ?").all(txid) as Array<{ status: string }>).map((r) => r.status);
  }

  /** Queue a broadcast (#65, arc.ts), due now; one already queued keeps its schedule and gains `instance`. */
  queueBroadcast(txid: string, body: Uint8Array, instance: string, now: number): void {
    const had = this.db.prepare("SELECT instances FROM broadcast_queue WHERE txid = ?").get(txid) as { instances: string } | undefined;
    if (had) {
      const hs = new Set(JSON.parse(had.instances) as string[]);
      hs.add(instance);
      this.db.prepare("UPDATE broadcast_queue SET instances = ?, next_at = MIN(next_at, ?) WHERE txid = ?").run(JSON.stringify([...hs]), now, txid);
      return;
    }
    this.db.prepare("INSERT INTO broadcast_queue (txid, body, instances, attempts, next_at, since) VALUES (?, ?, ?, 0, ?, ?)").run(txid, body, JSON.stringify([instance]), now, now);
  }

  /** The queued broadcasts due at `now`, oldest first. */
  dueBroadcasts(now: number): Array<{ txid: string; body: Uint8Array; instances: string[]; attempts: number; since: number }> {
    return this.db.prepare("SELECT txid, body, instances, attempts, since FROM broadcast_queue WHERE next_at <= ? ORDER BY next_at, txid").all(now).map((r) => {
      const x = r as { txid: string; body: Uint8Array; instances: string; attempts: number; since: number };
      return { txid: x.txid, body: new Uint8Array(x.body), instances: JSON.parse(x.instances) as string[], attempts: Number(x.attempts), since: Number(x.since) };
    });
  }

  /** When the next queued broadcast is due (ms), if any. */
  nextBroadcastAt(): number | undefined {
    const r = this.db.prepare("SELECT MIN(next_at) AS n FROM broadcast_queue").get() as { n: number | null } | undefined;
    return r?.n == null ? undefined : Number(r.n);
  }

  /** A queued broadcast Arcade did not take: one more attempt, posted again at `next`. */
  retryBroadcast(txid: string, next: number, error: string): void {
    this.db.prepare("UPDATE broadcast_queue SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE txid = ?").run(next, error, txid);
  }

  /** A broadcast Arcade answered (or one given up): off the queue. */
  unqueueBroadcast(txid: string): void {
    this.db.prepare("DELETE FROM broadcast_queue WHERE txid = ?").run(txid);
  }

  /** The queue as it stands. */
  broadcasts(): Array<{ txid: string; attempts: number; next: number; error?: string }> {
    return this.db.prepare("SELECT txid, attempts, next_at, last_error FROM broadcast_queue ORDER BY next_at, txid").all().map((r) => {
      const x = r as { txid: string; attempts: number; next_at: number; last_error: string | null };
      return { txid: x.txid, attempts: Number(x.attempts), next: Number(x.next_at), ...(x.last_error ? { error: x.last_error } : {}) };
    });
  }

  /** Keep a cron schedule (#69): an instance's, by name (a later one replaces it). */
  saveSchedule(s: { instance: string; name: string; recipient: string; spec: Uint8Array; request: string; next: number }): void {
    this.db.prepare("INSERT INTO cron_schedule (instance, name, recipient, spec, request, next) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (instance, name) DO UPDATE SET recipient = excluded.recipient, spec = excluded.spec, request = excluded.request, next = excluded.next")
      .run(s.instance, s.name, s.recipient, s.spec, s.request, s.next);
  }

  /** Drop an instance's schedule; false if it had none by that name. */
  dropSchedule(instance: string, name: string): boolean {
    return Number(this.db.prepare("DELETE FROM cron_schedule WHERE instance = ? AND name = ?").run(instance, name).changes) > 0;
  }

  /** Every kept schedule. */
  schedules(): Array<{ instance: string; name: string; recipient: string; spec: Uint8Array; request: string; next: number }> {
    return this.db.prepare("SELECT instance, name, recipient, spec, request, next FROM cron_schedule ORDER BY instance, name").all().map((r) => {
      const x = r as { instance: string; name: string; recipient: string; spec: Uint8Array; request: string; next: number };
      return { instance: x.instance, name: x.name, recipient: x.recipient, spec: new Uint8Array(x.spec), request: x.request, next: Number(x.next) };
    });
  }

  /** The enabled row whose identity is `identity`. */
  byIdentity(identity: string): InstanceRow | undefined {
    const r = this.db.prepare("SELECT * FROM instances WHERE identity = ? AND status = 'enabled'").get(identity);
    return r ? { ...r } as unknown as InstanceRow : undefined;
  }

  /** A host setting (#90), if set. */
  setting(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM host_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO host_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** An object of the default image's chain part (#132), if held. */
  imageBlock(cid: string): Uint8Array | undefined {
    const r = this.db.prepare("SELECT bytes FROM image_blocks WHERE cid = ?").get(cid) as { bytes: Uint8Array } | undefined;
    return r ? new Uint8Array(r.bytes) : undefined;
  }

  /** One write of the image's chain part (#132): objects put, objects dropped, settings set — all or nothing. */
  writeImage(puts: Map<string, Uint8Array>, drops: Set<string>, settings: Record<string, string>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const put = this.db.prepare("INSERT INTO image_blocks (cid, bytes) VALUES (?, ?) ON CONFLICT (cid) DO NOTHING");
      const drop = this.db.prepare("DELETE FROM image_blocks WHERE cid = ?");
      for (const c of drops) drop.run(c);
      for (const [c, b] of puts) put.run(c, b);
      for (const [k, v] of Object.entries(settings)) this.setSetting(k, v);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The host skein (#90): the operator's instance (`skein-host init`), the one row whose identity reaches the instance manager. */
  hostSkein(): InstanceRow | undefined {
    const h = this.setting("host_skein");
    return h ? this.get(h) : undefined;
  }

  close(): void { this.db.close(); }
}
