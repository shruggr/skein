// Types for kernel.js (the wasm kernel's dependency-free shim), for the TypeScript host that loads it.

/** A store the kernel's `skein_store` imports reach by id. */
export interface ShimStore {
  getBlock(cid: Uint8Array): Uint8Array | undefined;
  hasBlock(cid: Uint8Array): boolean;
  putBlock(cid: Uint8Array, bytes: Uint8Array): boolean;
  getPointer(name: string): Uint8Array | undefined;
  setPointer(name: string, cid: Uint8Array): boolean;
  begin(): void;
  commit(): boolean;
  rollback(): void;
  entries?(): Iterable<[Uint8Array, Uint8Array]>;
}

export interface Peers {
  request?(op: string, v: Uint8Array): { ok: Uint8Array } | { error: string };
  notify?(op: string, v: Uint8Array | string): void;
}

export declare class MemoryStore implements ShimStore {
  constructor(o?: { readOnly?: boolean });
  blocks: Map<string, Uint8Array>;
  pointers: Map<string, Uint8Array>;
  getBlock(cid: Uint8Array): Uint8Array | undefined;
  hasBlock(cid: Uint8Array): boolean;
  putBlock(cid: Uint8Array, bytes: Uint8Array): boolean;
  getPointer(name: string): Uint8Array | undefined;
  setPointer(name: string, cid: Uint8Array): boolean;
  begin(): void;
  commit(): boolean;
  rollback(): void;
  entries(): Iterable<[Uint8Array, Uint8Array]>;
}

export declare function codecOf(cid: Uint8Array): number;

export declare class Kernel {
  constructor(module: WebAssembly.Module, o?: { stores?: Record<number, ShimStore>; peers?: Peers });
  stores: Record<number, ShimStore>;
  stats: { compiled: number; instances: number; hostCalls: number };
  x: Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
  push(bytes: Uint8Array | string): [number, number];
  release(p: [number, number]): void;
  result(n: number): Uint8Array;
  check(r: number): number;
  open(id: number): void;
  modulesList(): Uint8Array;
  putBlock(cid: Uint8Array, bytes: Uint8Array): void;
  getBlock(cid: Uint8Array): Uint8Array | undefined;
  call(frame: Uint8Array): Uint8Array;
  admit(frame: Uint8Array): Uint8Array;
  start(): Uint8Array;
  drain(): Uint8Array;
  state(): Uint8Array;
  replay(src: number, dst: number): string;
}

export declare function replayInto(kernel: Kernel, srcId: number, dstId: number): string;
