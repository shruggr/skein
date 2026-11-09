// Which store backend an equiv driver runs its instances on (#158):
// SQLite files (the default), each instance its own `skein-kernel serve`;
// with SKEIN_EQUIV_STORE=rocksdb, sets of one RocksDB database per host
// (<home>/store-rocksdb) inside ONE `skein-kernel host` process per host (the
// worker pool); with SKEIN_EQUIV_STORE=wasm, below. run.sh runs each scenario
// once, in its default mode, but for the checks that compare backends.

import { join } from "node:path";

export const ROCKS_MODE = process.env.SKEIN_EQUIV_STORE === "rocksdb";
/** The settled split (2026-10-31): SKEIN_EQUIV_STORE=wasm — every host's instances sets of its one SQLite database (<home>/store.sqlite), run by the WASM kernel the host loads. */
export const WASM_MODE = process.env.SKEIN_EQUIV_STORE === "wasm";
export const BACKEND = ROCKS_MODE ? "rocksdb" : WASM_MODE ? "wasm" : "sqlite";

/** host.db's `store` for an instance of the host at `home`. */
export const storeFor = (home: string, handle: string): string => (WASM_MODE ? `sqlite:${join(home, "store.sqlite")}` : ROCKS_MODE ? `rocksdb:${join(home, "store-rocksdb")}` : join(home, "instances", handle, "runtime.db"));

/** The store as the kernel's tools name it: the file, `rocksdb:<db dir>#<handle>` or `sqlite:<db>#<handle>`. */
export const specFor = (home: string, handle: string): string => (WASM_MODE ? `sqlite:${join(home, "store.sqlite")}#${handle}` : ROCKS_MODE ? `rocksdb:${join(home, "store-rocksdb")}#${handle}` : join(home, "instances", handle, "runtime.db"));

/** Router options: in RocksDB mode the instances it creates are sets of <home>/store-rocksdb; in wasm mode of <home>/store.sqlite. */
export const routerStore = (home: string): { rocksStore?: string; sqliteStore?: string } => (WASM_MODE ? { sqliteStore: join(home, "store.sqlite") } : ROCKS_MODE ? { rocksStore: join(home, "store-rocksdb") } : {});
