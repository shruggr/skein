/**
 * public/manifest.json: the W3C manifest's `metanet.groupPermissions`
 * (BRC-73, wallet-toolbox `GroupedPermissions`) declares what the pages use
 * and in the form WalletPermissionsManager matches: level-2 grants by the
 * exact counterparty string ("self" for the BRC-29 keys the page derives),
 * level 1 without one, the action labels as `[1, "action label <label>"]`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import { BRC29_PROTOCOL, brc29PublicKey } from "../src/wallet/brc29";

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8"));
const g = manifest.metanet.groupPermissions;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [readFileSync(p, "utf8")] : [];
  });
}

describe("manifest.json", () => {
  it("a W3C manifest with metanet.groupPermissions: description, spending, protocols, baskets, no certificates", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe("./");
    expect(Object.keys(g).sort()).toEqual(["basketAccess", "certificateAccess", "description", "protocolPermissions", "spendingAuthorization"]);
    expect(g.spendingAuthorization).toEqual({ amount: 10_000_000, description: expect.any(String) });
    expect(g.certificateAccess).toEqual([]);
    expect(g.basketAccess.map((b: { basket: string }) => b.basket)).toEqual(["bsv21", "1sat", "1sat-deposit"]);
    for (const e of [...g.protocolPermissions, ...g.basketAccess, g.spendingAuthorization]) {
      expect(e.description).toMatch(/^[A-Z][^.]*(\.[^.]+)*\.$/); // one sentence
    }
  });

  it("protocols: onesat, BRC-29 to self, identity key, AuthFetch's two, and every action label the pages use", () => {
    const used = new Set<string>();
    for (const src of sources(join(root, "src"))) for (const m of src.matchAll(/labels: \[([^\]]*)\]/g)) for (const l of m[1]!.matchAll(/"([^"]+)"/g)) used.add(l[1]!);
    expect([...used].sort()).toEqual(["amm-close", "amm-payout", "amm-pool-deploy", "amm-swap"]);
    expect(g.protocolPermissions.map((p: { protocolID: unknown; counterparty?: string }) => [p.protocolID, p.counterparty])).toEqual([
      [[0, "onesat"], undefined],
      [[2, "3241645161d8"], "self"],
      [[1, "identity key retrieval"], undefined],
      [[2, "server hmac"], "self"],
      // No counterparty: the instance's identity is not known here; the manager groups it per peer at first use.
      [[2, "auth message signature"], undefined],
      ...["amm-swap", "amm-pool-deploy", "amm-close", "amm-payout"].map((l) => [[1, `action label ${l}`], undefined]),
    ]);
  });

  it("the page asks for its BRC-29 keys with counterparty \"self\", the string the grant is keyed by", async () => {
    const asked: unknown[] = [];
    const w = { getPublicKey: async (a: unknown) => (asked.push(a), { publicKey: new PrivateKey(7).toPublicKey().toString() }) } as unknown as WalletInterface;
    await brc29PublicKey(w, { derivationPrefix: "AA==", derivationSuffix: "AQ==" });
    expect(asked).toEqual([{ protocolID: BRC29_PROTOCOL, keyID: "AA== AQ==", counterparty: "self", forSelf: true }]);
    const entry = g.protocolPermissions.find((p: { protocolID: unknown }) => JSON.stringify(p.protocolID) === JSON.stringify(BRC29_PROTOCOL));
    expect(entry.counterparty).toBe("self");
  });
});
