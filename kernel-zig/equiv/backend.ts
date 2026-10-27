// Which store backend an equiv driver runs its instances on (#96): SQLite
// files (the default), or, with SKEIN_EQUIV_STORE=lmdb, sets of one LMDB
// environment per host (<home>/store; the set the handle). run.sh runs the
// corpus, serve.ts, chain.ts, overlay.ts and sync.ts both ways.

import { join } from "node:path";

export const LMDB_MODE = process.env.SKEIN_EQUIV_STORE === "lmdb";
export const BACKEND = LMDB_MODE ? "lmdb" : "sqlite";

/** host.db's `store` for an instance of the host at `home`. */
export const storeFor = (home: string, handle: string): string => (LMDB_MODE ? `lmdb:${join(home, "store")}` : join(home, "instances", handle, "runtime.db"));

/** The store as the kernel's tools name it: the file, or `lmdb:<env dir>#<handle>`. */
export const specFor = (home: string, handle: string): string => (LMDB_MODE ? `lmdb:${join(home, "store")}#${handle}` : join(home, "instances", handle, "runtime.db"));

/** Router options: in LMDB mode the instances it creates are sets of <home>/store. */
export const routerStore = (home: string): { lmdbStore?: string } => (LMDB_MODE ? { lmdbStore: join(home, "store") } : {});
