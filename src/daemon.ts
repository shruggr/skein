// `skein run`: the one process that runs the scheduler. It owns the runners
// (model requests and child processes live here), ticks on a timer, and
// serves the web browser. Other CLI processes write to the same SQLite file
// and POST /wake so they needn't wait for the next tick.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CID } from "multiformats/cid";
import type { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { Scheduler } from "./scheduler.ts";
import type { Runner } from "./runners/types.ts";
import { loopRunner } from "./runners/loop.ts";
import { modelRunner } from "./runners/model.ts";
import { shellRunner } from "./runners/shell.ts";
import { davidRunner } from "./runners/david.ts";
import { webHandler } from "./web/server.ts";
import { workDir } from "./env.ts";

export interface DaemonOptions {
  store: Store;
  port?: number;       // 0 = ephemeral
  host?: string;       // default 127.0.0.1
  tickMs?: number;
  log?: (line: string) => void;
  config?: Config;     // default: re-read from disk per use, so edits apply live
  fetch?: typeof fetch; // model HTTP, for tests
  runners?: Runner[];
}

export interface Daemon {
  url: string;
  port: number;
  scheduler: Scheduler;
  server: Server;
  close(): Promise<void>;
}

export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const host = o.host ?? "127.0.0.1";
  const runners = o.runners ?? [
    loopRunner({ cwd: workDir() }),
    modelRunner({ config: o.config, fetch: o.fetch }),
    shellRunner(),
    davidRunner(),
  ];
  const scheduler = new Scheduler(o.store, runners, { tickMs: o.tickMs ?? 1000, log: o.log });
  const handler = webHandler({
    store: o.store,
    wake: (t?: CID) => (t ? scheduler.wake(t) : void scheduler.tick()),
    config: () => o.config ?? loadConfig(),
    loopbackOnly: isLoopback(host),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 4322, host, () => { server.off("error", reject); resolve(); });
  });
  scheduler.start();
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    scheduler,
    server,
    close: () => (closing ??= (async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await scheduler.stop();
    })()),
  };
}

const isLoopback = (h: string) => h === "localhost" || h === "::1" || h.startsWith("127.");
