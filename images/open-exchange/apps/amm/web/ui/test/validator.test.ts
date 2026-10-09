/**
 * The Validator page: the explorer's genesis and app-record reads (the policy
 * and the two role settings) through a fake AuthFetch, the this-instance view
 * from mocked manifest / resolve / live answers, and pools-served filtering.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLookupAnswer, parseTokenTopic } from "../src/lib/overlay";
import type { FetchLike } from "../src/lp/validators";
import { ago } from "../src/lp/validators";
import { hostLabel, instanceAddress, livenessLine, loadThisInstance, poolsServedBy } from "../src/validator/instance";
import { beatEntry } from "./liveRead";
import { dagBytesHex, policyOf, readAppPolicy, readGenesis, withSwitches, type AuthFetchLike } from "../src/validator/control";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/instance-v2/${name}`, import.meta.url), "utf8")) as unknown;

const AMM2 = "02f2607898feca297bec05cc510475ff896fb3e9a1d3c0528f6ce2c4382eff472a";
const AMM3 = "03cdee31ef0446ffb95aeae00353d9ab4c26a8555d597a9930b0ddd4f4cc1ae0d0";
const AMM2_PEER = "16Uiu2HAmL3ee25zUdPHFTUVToTuzBgBjt8yoxAd952pYyvfbmDT9";

/** A fake AuthFetch: records calls, answers from a function. */
function fakeAuthFetch(answer: (url: string, config?: { method?: string; body?: string }) => { status: number; body: unknown }) {
  const calls: { url: string; config?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const af: AuthFetchLike = {
    async fetch(url, config) {
      calls.push({ url, ...(config ? { config } : {}) });
      const a = answer(url, config);
      return { status: a.status, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
    },
  };
  return { af, calls };
}

describe("the explorer (root only): the genesis and policy", () => {
  const ownerHex = "027c21b23e13472d370821454a34874d934ee5721bb3327ceb489c38d1a4b0f21b";
  const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "");
  const genesis = {
    kind: "genesis",
    identity: { "/": { bytes: b64(AMM2) } },
    defaults: {
      ammValidator: '{"minValidatorFeeBps":5,"maxLpFeeBps":100}',
      overlayValidator: '{"every":30000}',
    },
  };

  it("decodes DAG-JSON bytes", () => {
    expect(dagBytesHex({ "/": { bytes: b64(ownerHex) } })).toBe(ownerHex);
    expect(dagBytesHex(ownerHex.toUpperCase())).toBe(ownerHex);
    expect(dagBytesHex(42)).toBeUndefined();
  });

  it("reads the policy from the genesis defaults (JSON strings); no overlayMarket: not a market", () => {
    expect(policyOf(genesis)).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100, validatorEveryMs: 30_000 });
    expect(policyOf({ kind: "genesis" })).toEqual({});
  });

  it("reads the policy and the two role settings from the app record (0.6.0): config.amm.ammValidator, config.overlay.market / .validator", async () => {
    const app = {
      kind: "app",
      name: "amm",
      config: { overlay: { lookups: {}, market: { window: 40_000 }, validator: { every: 30_000 } }, amm: { ammValidator: { minValidatorFeeBps: 5, maxLpFeeBps: 100 } } },
    };
    expect(policyOf(app)).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100, marketWindowMs: 40_000, validatorEveryMs: 30_000 });
    expect(policyOf({ kind: "app", config: { overlay: {}, amm: {} } })).toEqual({});
    const { af, calls } = fakeAuthFetch((url) => (url.endsWith("/explore/head/amm/app") ? { status: 200, body: { tree: { "/": "bafyApp" } } } : { status: 200, body: app }));
    expect(await readAppPolicy(af, "http://amm2.localhost:8300", "amm")).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100, marketWindowMs: 40_000, validatorEveryMs: 30_000 });
    expect(calls.map((c) => c.url)).toEqual(["http://amm2.localhost:8300/explore/head/amm/app", "http://amm2.localhost:8300/explore/record/bafyApp", "http://amm2.localhost:8300/explore/head/amm/topics"]);
  });

  it("the roles in effect (0.6.2, skein-overlay 0.9.2): root's switch in <app>/topics over config.overlay; the manifest sets neither", async () => {
    const app = { kind: "app", name: "amm", config: { overlay: { lookups: {} }, amm: { ammValidator: { minValidatorFeeBps: 5, maxLpFeeBps: 100 } } } };
    const set = (sw: Record<string, unknown>) => ({ kind: "overlay-topics", topics: [{ topic: "tm_x", program: "mandala-topic" }], ...sw });
    expect(withSwitches(policyOf(app), undefined)).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100 });
    expect(withSwitches(policyOf(app), set({}))).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100 });
    expect(withSwitches(policyOf(app), set({ market: { window: 40_000 }, validator: { every: 30_000 } }))).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100, marketWindowMs: 40_000, validatorEveryMs: 30_000 });
    // Off over a manifest value: off; never switched: the manifest's.
    expect(withSwitches({ marketWindowMs: 40_000, validatorEveryMs: 30_000 }, set({ market: { off: true } }))).toEqual({ validatorEveryMs: 30_000 });
    const { af } = fakeAuthFetch((url) =>
      url.endsWith("/explore/head/amm/app") ? { status: 200, body: { tree: { "/": "bafyApp" } } }
      : url.endsWith("/explore/head/amm/topics") ? { status: 200, body: { tree: { "/": "bafySet" } } }
      : url.endsWith("/bafySet") ? { status: 200, body: set({ validator: { every: 30_000 } }) }
      : { status: 200, body: app });
    expect(await readAppPolicy(af, "http://amm2.localhost:8300", "amm")).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100, validatorEveryMs: 30_000 });
  });

  it("log entry 0 with its record", async () => {
    const { af, calls } = fakeAuthFetch(() => ({ status: 200, body: { entries: [{ n: 0, entry: { "/": "bafyg" }, record: genesis }] } }));
    const g = await readGenesis(af, "http://amm2.localhost:8300");
    expect(calls.map((c) => [c.url, c.config?.method])).toEqual([["http://amm2.localhost:8300/explore/log?before=1&limit=1", "GET"]]);
    expect(g).toMatchObject({ ok: true, identity: AMM2, policy: { minValidatorFeeBps: 5, maxLpFeeBps: 100, validatorEveryMs: 30_000 } });
  });

  it("follows a record that links the genesis", async () => {
    const { af, calls } = fakeAuthFetch((url) =>
      url.endsWith("/explore/record/bafyg")
        ? { status: 200, body: genesis }
        : { status: 200, body: { entries: [{ n: 0, entry: { "/": "bafye" }, record: { kind: "log", genesis: { "/": "bafyg" } } }] } },
    );
    const g = await readGenesis(af, "http://amm2.localhost:8300");
    expect(calls.map((c) => c.url)).toEqual([
      "http://amm2.localhost:8300/explore/log?before=1&limit=1",
      "http://amm2.localhost:8300/explore/record/bafyg",
    ]);
    expect(g.ok).toBe(true);
    expect(g.identity).toBe(AMM2);
    expect("owner" in g).toBe(false);
  });

  it("a 403 for a key without root", async () => {
    const { af } = fakeAuthFetch(() => ({ status: 403, body: { status: "error" } }));
    const g = await readGenesis(af, "http://amm2.localhost:8300");
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
    expect(g.error).toMatch(/root only/);
  });
});

describe("this instance", () => {
  it("takes the handle from the origin", () => {
    expect(instanceAddress("http://amm2.localhost:8300/amm")).toEqual({ origin: "http://amm2.localhost:8300", name: "amm2", domain: "localhost:8300" });
    expect(instanceAddress("https://val.example.com/amm")).toEqual({ origin: "https://val.example.com", name: "val", domain: "example.com" });
    expect(instanceAddress("http://localhost:8300/@amm2/amm")).toEqual({ origin: "http://localhost:8300/@amm2", name: "amm2", domain: "localhost:8300" });
    expect(instanceAddress("http://127.0.0.1:8300/amm")).toEqual({ origin: "http://127.0.0.1:8300" });
    expect(hostLabel("http://amm3.localhost:8400/amm")).toBe("amm3.localhost:8400");
  });

  /** The router (manifest, resolve) as recorded 2026-10-01, and the peer's liveness read of one token topic (skein #138). */
  const TOPIC = `tm_mandala_${"ab".repeat(32)}_0`;
  const READ = `http://amm3.localhost:8400/amm/.live/${TOPIC}-live`;
  function fakeFetch(amm3Read: unknown, status = 200): { fetchFn: FetchLike; urls: string[] } {
    const urls: string[] = [];
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const fetchFn: FetchLike = async (url) => {
      urls.push(url);
      if (url === "http://localhost:8300/manifest.json") return ok({ metanet: { handles: { resolve: "http://127.0.0.1:8300/.well-known/metanet-handles/resolve" } } });
      if (url === "http://127.0.0.1:8300/.well-known/metanet-handles/resolve?handle=amm2%40localhost")
        return ok({ handle: "amm2", domain: "localhost", identityKey: AMM2, messagebox: "http://amm2.localhost:8300" });
      if (url === READ && status === 200) return ok(amm3Read);
      return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
    };
    return { fetchFn, urls };
  }

  it("identity from resolve, peer ID and liveness from the peer's liveness read of our token topics", async () => {
    const { fetchFn, urls } = fakeFetch([beatEntry(AMM2, AMM2_PEER, 1790846271647)]);
    const t = await loadThisInstance("http://amm2.localhost:8300/amm", "http://amm3.localhost:8400/amm", [TOPIC], fetchFn, 1790846296911);
    expect(urls).toEqual([
      "http://localhost:8300/manifest.json",
      "http://127.0.0.1:8300/.well-known/metanet-handles/resolve?handle=amm2%40localhost",
      READ,
    ]);
    expect(t.address.origin).toBe("http://amm2.localhost:8300");
    expect(t.handle).toBe("amm2@localhost:8300");
    expect(t.identityKey).toBe(AMM2);
    expect(t.peerId).toBe(AMM2_PEER);
    expect(t.peer?.entry?.live).toBe(true);
    expect(livenessLine(t, ago)).toBe("last beat seen by amm3.localhost:8400: 25 s ago (live)");
  });

  it("unknown until the peer keeps a beat of ours: another validator only; or no liveness kept (404)", async () => {
    const { fetchFn } = fakeFetch(fixture("../live-read.json"));
    const t = await loadThisInstance("http://amm2.localhost:8300/amm", "http://amm3.localhost:8400/amm", [TOPIC], fetchFn, 1790846296911);
    expect(t.identityKey).toBe(AMM2);
    expect(t.peerId).toBeUndefined();
    expect(livenessLine(t, ago)).toBe("amm3.localhost:8400 has no beat from this identity within its window");
    const none = await loadThisInstance("http://amm2.localhost:8300/amm", "http://amm3.localhost:8400/amm", [TOPIC], fakeFetch(null, 404).fetchFn);
    expect(none.peer?.live?.kept).toBe(false);
    expect(livenessLine(none, ago)).toBe("amm3.localhost:8400 keeps no liveness for this instance's tokens");
  });

  it("a resolve failure and an unreachable peer are reported, not thrown", async () => {
    const { fetchFn } = fakeFetch({});
    const failing: FetchLike = async (url) => (url.includes("/.live/") ? { ok: false, status: 502, json: async () => ({}), text: async () => "bad gateway" } : fetchFn(url));
    const t = await loadThisInstance("http://amm9.localhost:8300/amm", "http://amm4.localhost:8500/amm", [TOPIC], failing);
    expect(t.identityKey).toBeUndefined();
    expect(t.resolveError).toMatch(/404/);
    expect(t.peer?.error).toMatch(/502/);
    expect(livenessLine(t, ago)).toMatch(/^could not read amm4.localhost:8500's liveness/);
    const noPeer = await loadThisInstance("http://amm2.localhost:8300/amm", "", [TOPIC], fetchFn);
    expect(noPeer.peer).toBeUndefined();
    expect(livenessLine(noPeer, ago)).toMatch(/no peer configured/);
  });
});

describe("pools served", () => {
  const topics = Object.keys(fixture("listTopicManagers.json") as object).map((n) => parseTokenTopic(n)!);
  const pools = parseLookupAnswer(fixture("lookup-all.json"));

  it("on v2 today: none for amm2 (the seeded pool names the fixture validator)", () => {
    const m = new Map([[topics[0]!.tokenId, pools]]);
    expect(poolsServedBy(AMM2, topics, m)).toEqual([]);
    const fixtureValidator = pools[0]!.validatorIdentityKey;
    expect(poolsServedBy(fixtureValidator.toUpperCase(), topics, m).map((s) => s.pool.outpoint)).toEqual([pools[0]!.outpoint]);
  });

  it("filters by validator identity across topics, skipping failed lookups", () => {
    const t2 = parseTokenTopic(`tm_mandala_${"ab".repeat(32)}_0`)!;
    const t3 = parseTokenTopic(`tm_mandala_${"cd".repeat(32)}_1`)!;
    const mine = { ...pools[0]!, outpoint: `${"11".repeat(32)}_0`, validatorIdentityKey: AMM2 };
    const theirs = { ...pools[0]!, outpoint: `${"22".repeat(32)}_0`, validatorIdentityKey: AMM3 };
    const m = new Map<string, (typeof pools)[number][] | Error>([
      [topics[0]!.tokenId, pools],
      [t2.tokenId, [mine, theirs]],
      [t3.tokenId, new Error("lookup failed")],
    ]);
    const served = poolsServedBy(AMM2, [topics[0]!, t2, t3], m);
    expect(served).toEqual([{ topic: t2, pool: mine }]);
  });
});
