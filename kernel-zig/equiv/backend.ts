// Which store backend an equiv driver runs its instances on (#96, #158):
// SQLite files (the default); with SKEIN_EQUIV_STORE=lmdb, sets of one LMDB
// environment per host (<home>/store; the set the handle), each instance its
// own `skein-kernel serve`; with SKEIN_EQUIV_STORE=rocksdb, sets of one
// RocksDB database per host (<home>/store-rocksdb) inside ONE `skein-kernel
// host` process per host (the worker pool). run.sh runs the drivers each way.

import { join } from "node:path";

export const LMDB_MODE = process.env.SKEIN_EQUIV_STORE === "lmdb";
export const ROCKS_MODE = process.env.SKEIN_EQUIV_STORE === "rocksdb";
/** The settled split (2026-10-31): SKEIN_EQUIV_STORE=wasm — every host's instances sets of its one SQLite database (<home>/store.sqlite), run by the WASM kernel the host loads. */
export const WASM_MODE = process.env.SKEIN_EQUIV_STORE === "wasm";
export const BACKEND = LMDB_MODE ? "lmdb" : ROCKS_MODE ? "rocksdb" : WASM_MODE ? "wasm" : "sqlite";

/** host.db's `store` for an instance of the host at `home`. */
export const storeFor = (home: string, handle: string): string => (WASM_MODE ? `sqlite:${join(home, "store.sqlite")}` : ROCKS_MODE ? `rocksdb:${join(home, "store-rocksdb")}` : LMDB_MODE ? `lmdb:${join(home, "store")}` : join(home, "instances", handle, "runtime.db"));

/** The store as the kernel's tools name it: the file, `lmdb:<env dir>#<handle>` or `rocksdb:<db dir>#<handle>`. */
export const specFor = (home: string, handle: string): string => (WASM_MODE ? `sqlite:${join(home, "store.sqlite")}#${handle}` : ROCKS_MODE ? `rocksdb:${join(home, "store-rocksdb")}#${handle}` : LMDB_MODE ? `lmdb:${join(home, "store")}#${handle}` : join(home, "instances", handle, "runtime.db"));

/** Router options: in LMDB mode the instances it creates are sets of <home>/store; in RocksDB mode of <home>/store-rocksdb. */
export const routerStore = (home: string): { lmdbStore?: string; rocksStore?: string; sqliteStore?: string } => (WASM_MODE ? { sqliteStore: join(home, "store.sqlite") } : ROCKS_MODE ? { rocksStore: join(home, "store-rocksdb") } : LMDB_MODE ? { lmdbStore: join(home, "store") } : {});
