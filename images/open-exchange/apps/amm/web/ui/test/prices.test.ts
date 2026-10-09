/**
 * Prices from the beats (src/market/prices.ts), the skein's doors
 * (src/lib/skein.ts) and the pool rows of the positions (src/lp/positions.ts)
 * — skein-amm 0.9.0.
 */
import { describe, expect, it } from "vitest";
import { encode, decode } from "cbor2";
import { Utils } from "@bsv/sdk";
import { beatTotals, depthOf, liveSenders, pricesFromBeats } from "../src/market/prices";
import { dagCbor, instanceBase, readBeats, readSpend, sendMessage, type Beat } from "../src/lib/skein";
import { positionRowsOf } from "../src/lp/positions";

const A = "02" + "aa".repeat(32);
const B = "03" + "bb".repeat(32);
const C = "02" + "cc".repeat(32);
const T = `${"11".repeat(32)}_0`;
const U = `${"22".repeat(32)}_0`;
const beat = (sender: string, at: number, tokens: unknown): Beat => ({ sender, at, from: "peer", body: encode({ tokens }, { cde: true }) });

describe("prices from the beats", () => {
  it("per token, Σsats / Σtokens over the live validators; a validator's own report over another's, else the newest", () => {
    const beats = [
      beat(A, 10, { [T]: { [A]: { sats: 1_000, tokens: 500, pools: 2 }, [B]: { sats: 7, tokens: 7, pools: 1 } } }),
      beat(C, 30, { [T]: { [A]: { sats: 9, tokens: 9, pools: 9 }, [B]: { sats: 200, tokens: 100, pools: 1 } }, [U]: { [C]: { sats: 50, tokens: 5_000, pools: 1 } } }),
      beat(B, 5, { [U]: { [B]: { sats: 1, tokens: 1, pools: 1 } } }),
    ];
    const live = liveSenders(beats);
    expect([...live].sort()).toEqual([A, C, B].sort());
    const p = pricesFromBeats(beats, live, (id) => (id === U ? 2 : 0));
    // T: A's own (1,000 / 500) and B's from C (newer than A's report of B, neither own): 1,200 / 600.
    expect(p.get(T)).toMatchObject({ reserves: { sats: 1_200n, tokens: 600n }, pools: 3, validators: [A, B].sort() });
    expect(p.get(T)!.marginalPrice).toBe(2);
    // U: C's own 50 / 5,000 (2 places: 50 / 50 whole = 1) and B's own 1 / 1.
    expect(p.get(U)).toMatchObject({ reserves: { sats: 51n, tokens: 5_001n } });
    // Only the live: without B, B's reports drop out.
    const q = pricesFromBeats(beats, new Set([A, C]));
    expect(q.get(T)!.reserves).toEqual({ sats: 1_000n, tokens: 500n });
    // Nobody live: no price.
    expect(pricesFromBeats(beats, new Set()).get(T)).toMatchObject({ marginalPrice: null, pools: 0, depth: null });
  });

  it("a malformed body or entry is passed over", () => {
    expect(beatTotals(new Uint8Array([0xff])).size).toBe(0);
    expect(beatTotals(encode({ tokens: { [T]: { [A]: { sats: "x" } } } })).size).toBe(0);
    expect(depthOf(0n)).toBeNull();
    expect(depthOf(1_000_000n)!.sats).toBe(9_950n);
  });
});

describe("the skein's doors", () => {
  it("a message: POST <instance>/sendMessage, BRC-231 CBOR {message: {recipient, messageBox, body: dag-cbor}}", async () => {
    expect(instanceBase("https://alice.skein.nexus/amm")).toBe("https://alice.skein.nexus");
    expect(instanceBase("http://127.0.0.1:8100/@alice/amm")).toBe("http://127.0.0.1:8100/@alice");
    const seen: { url: string; init: { headers?: Record<string, string>; body?: unknown } }[] = [];
    const af = { fetch: async (url: string, init?: { headers?: Record<string, string>; body?: unknown }) => (seen.push({ url, init: init! }), new Response(encode({ id: "m1" }) as BodyInit, { status: 200 })) };
    expect(await sendMessage(af, "https://alice.skein.nexus/amm", A, "amm/requests", { fn: "request", args: { tokenId: T } })).toBe("m1");
    expect(seen[0]!.url).toBe("https://alice.skein.nexus/sendMessage");
    expect(seen[0]!.init.headers).toEqual({ "content-type": "application/cbor" });
    const m = (decode(seen[0]!.init.body as Uint8Array) as { message: { recipient: Uint8Array; messageBox: string; body: Uint8Array } }).message;
    expect(Utils.toHex(Array.from(m.recipient))).toBe(A);
    expect(m.messageBox).toBe("amm/requests");
    expect(Array.from(m.body)).toEqual(Array.from(dagCbor({ fn: "request", args: { tokenId: T } })));
    const no = { fetch: async () => new Response(encode({ code: "ERR_DENIED", description: "not root" }) as BodyInit, { status: 403 }) };
    await expect(sendMessage(no, "https://x/amm", A, "amm/register", {})).rejects.toThrow(/403 ERR_DENIED not root/);
  });

  it("the reads: spends, beats (404: none kept)", async () => {
    const f = (async (url: string) => {
      if (url.includes("/spends")) return new Response(JSON.stringify({ outpoint: `${"11".repeat(32)}.0`, spentBy: "ab".repeat(32), hops: 0, closed: false }));
      if (url.includes("ls_amm-live")) return new Response(JSON.stringify([{ sender: A.toUpperCase(), at: 5, from: "p", body: Utils.toBase64([1, 2]) }]));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    expect(await readSpend("http://x/amm", `${"11".repeat(32)}.0`, f)).toMatchObject({ spentBy: "ab".repeat(32) });
    const bs = await readBeats("http://x/amm", "ls_amm-live", f);
    expect(bs).toEqual([{ sender: A, at: 5, from: "p", body: Uint8Array.from([1, 2]) }]);
    expect(await readBeats("http://x/amm", "tm_x-live", f)).toEqual([]);
  });
});

describe("the positions' pool rows", () => {
  it("a pool row: its deploy outpoint, the token, the LP key, the claim's vout (null before 0.9.0); other rows passed over", () => {
    const rows = positionRowsOf([
      { outpoint: `${"33".repeat(32)}.0`, satoshis: 1, tags: ["amm-pool"], customInstructions: JSON.stringify({ id: T, op: "amm-pool", sym: "TST", dec: "2", protocolID: [2, "3241645161d8"], keyID: "k", counterparty: "self", amm: { claimVout: 4, validatorIdentity: A } }) },
      { outpoint: `${"44".repeat(32)}.0`, satoshis: 1, tags: ["amm-pool"], customInstructions: JSON.stringify({ id: U, op: "amm-pool", protocolID: [0, "onesat"], keyID: "old" }) },
      { outpoint: `${"55".repeat(32)}.1`, satoshis: 1, tags: [], customInstructions: JSON.stringify({ id: T, amt: "5" }) },
    ]);
    expect(rows).toEqual([
      { deployOutpoint: `${"33".repeat(32)}.0`, tokenId: T, sym: "TST", dec: 2, lpKey: { protocolID: [2, "3241645161d8"], keyID: "k", counterparty: "self" }, claimVout: 4, validatorIdentity: A },
      { deployOutpoint: `${"44".repeat(32)}.0`, tokenId: U, lpKey: { protocolID: [0, "onesat"], keyID: "old", counterparty: "self" }, claimVout: null },
    ]);
  });
});
