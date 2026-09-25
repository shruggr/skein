// `skein run`: the one process that runs the runtime and the host services
// (model requests and child processes live here), ticks on a timer, and
// serves the web browser. Other CLI processes put owner messages into the
// same SQLite file and POST /wake so they needn't wait for the next tick.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WalletInterface } from "@bsv/sdk";
import type { Store } from "./store.ts";
import { loadConfig, type Config } from "./config.ts";
import { initInstance } from "./instance.ts";
import { Runtime } from "./runtime.ts";
import { clockService } from "./services/clock.ts";
import { executionService } from "./services/execution.ts";
import { inferenceService } from "./services/inference.ts";
import type { Service } from "./services/types.ts";
import { webHandler } from "./web/server.ts";

export interface DaemonOptions {
  store: Store;
  wallet: WalletInterface;
  port?: number;        // 0 = ephemeral
  host?: string;        // default 127.0.0.1
  tickMs?: number;
  log?: (line: string) => void;
  config?: Config;      // default: re-read from disk per use, so edits apply live
  fetch?: typeof fetch; // model HTTP, for tests
  services?: Service[]; // default: inference, execution, clock
}

export interface Daemon {
  url: string;
  port: number;
  runtime: Runtime;
  server: Server;
  close(): Promise<void>;
}

export async function startDaemon(o: DaemonOptions): Promise<Daemon> {
  const host = o.host ?? "127.0.0.1";
  const services = o.services ?? [inferenceService({ config: o.config, fetch: o.fetch }), executionService(), clockService()];
  const runtime = new Runtime(o.store, { wallet: o.wallet, services, log: o.log, names: ["david"] });
  const inst = await initInstance(o.store, o.wallet, { runtime });
  if (inst.created) o.log?.(`new instance: genesis ${inst.genesis}`);
  const handler = webHandler({
    store: o.store,
    wallet: o.wallet,
    runtime,
    config: () => o.config ?? loadConfig(),
    loopbackOnly: isLoopback(host),
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 4322, host, () => { server.off("error", reject); resolve(); });
  });
  await runtime.start(o.tickMs ?? 1000);
  const port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    port,
    runtime,
    server,
    close: () => (closing ??= (async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await runtime.stop();
    })()),
  };
}

const isLoopback = (h: string) => h === "localhost" || h === "::1" || h.startsWith("127.");
