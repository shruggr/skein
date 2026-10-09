import { describe, expect, it } from "vitest";
import Mandala from "@1sat/templates/mandala";
import { BSV21, buildInscriptionScript } from "@1sat/templates";
import { LockingScript, P2PKH, PrivateKey, Transaction, type WalletInterface, type WalletOutput } from "@bsv/sdk";
import { formatAmount, parseAmount } from "../src/lp/amounts";
import { buildInventory, decodeTokenRow } from "../src/lp/inventory";
import { imageOrdinals } from "../src/lp/ordinals";
import { buildDeployArgs, deployToken, type DeployRequest, type DerivedKey } from "../src/lp/deploy";

const T = (c: string) => c.repeat(64);
const ADDR = PrivateKey.fromHex("01".padStart(64, "0")).toAddress();
const P2 = new P2PKH().lock(ADDR);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const pngInscription = (lock: LockingScript = P2) => buildInscriptionScript(lock, PNG, "image/png").toHex();

const row = (outpoint: string, script: string, extra: Partial<WalletOutput> = {}): WalletOutput => ({
  outpoint,
  satoshis: 1,
  spendable: true,
  lockingScript: script,
  ...extra,
});

describe("amounts", () => {
  it("formats base units with decimals", () => {
    expect(formatAmount(0n, 0)).toBe("0");
    expect(formatAmount(123456n, 0)).toBe("123456");
    expect(formatAmount(123456n, 2)).toBe("1234.56");
    expect(formatAmount(120000n, 4)).toBe("12");
    expect(formatAmount(5n, 8)).toBe("0.00000005");
    expect(formatAmount(0xffff_ffff_ffff_ffffn, 18)).toBe("18.446744073709551615");
    expect(() => formatAmount(1n, 19)).toThrow();
  });
  it("parses display units to base units", () => {
    expect(parseAmount("1234.56", 2)).toBe(123456n);
    expect(parseAmount("12", 4)).toBe(120000n);
    expect(parseAmount(".5", 1)).toBe(5n);
    expect(parseAmount("21_000_000", 0)).toBe(21_000_000n);
    expect(() => parseAmount("1.234", 2)).toThrow();
    expect(() => parseAmount("-1", 2)).toThrow();
    expect(() => parseAmount("", 2)).toThrow();
    expect(() => parseAmount("1e5", 0)).toThrow();
  });
});

describe("inventory", () => {
  // A binary deploy whose icon is embedded in it (BRC-162 draft BRCs#308: [mediaType, bytes]).
  const deployTx = new Transaction();
  const deployScript = Mandala.deployValue(100_000n, { lock: ADDR, payload: { sym: "GOLD", dec: 2, icon: { mediaType: "image/png", bytes: PNG } } }).lock();
  deployTx.addOutput({ satoshis: 1, lockingScript: deployScript });
  // A Mandala token's id is `<txid>_0` (BRC-162 Token identification, David 2026-10-07), as the SDK's Mandala.value takes it.
  const gold = `${deployTx.id("hex")}_0`;
  const goldSdk = gold;

  // A binary deploy with no icon.
  const silverDeploy = Mandala.deployAuthority({ lock: ADDR, payload: { sym: "SILV", dec: 0 } }).lock();
  // A binary deploy whose embedded "icon" is not an image: no picture.
  const ironDeploy = Mandala.deployValue(9n, { lock: ADDR, payload: { sym: "IRON", icon: { mediaType: "text/html", bytes: PNG } } }).lock();

  const legacyDeploy = BSV21.deployMint("OLD", 500n, 1).lock(P2);
  // A legacy JSON deploy whose icon is an outpoint, held in the ordinals basket (its resolution unchanged).
  const silverIcon = `${T("5")}_3`;
  const jsonDeploy = BSV21.deployMint("JSN", 10n, 0, silverIcon).lock(P2);
  const old = `${T("2")}_0`;

  const rows: WalletOutput[] = [
    row(`${deployTx.id("hex")}.0`, deployScript.toHex(), { tags: ["bsv21:deploy"] }),
    row(`${T("a")}.0`, Mandala.value(goldSdk, 250n, { lock: ADDR }).lock().toHex()),
    row(`${T("a")}.1`, Mandala.value(goldSdk, 17n, { lock: ADDR }).lock().toHex()),
    row(`${T("3")}.0`, silverDeploy.toHex()),
    row(`${T("4")}.0`, ironDeploy.toHex()),
    row(`${T("2")}.0`, legacyDeploy.toHex()),
    row(`${T("8")}.0`, jsonDeploy.toHex()),
    row(`${T("b")}.1`, BSV21.transfer(old, 40n).lock(P2).toHex()),
    // binary value of the legacy token (36-byte id would be for vout > 0; vout 0 is 32 bytes)
    row(`${T("b")}.2`, Mandala.value(old, 2n, { lock: ADDR }).lock().toHex()),
    // a legacy transfer of a token whose deploy is not in the wallet
    row(`${T("c")}.0`, BSV21.transfer(`${T("7")}_2`, 7n).lock(P2).toHex()),
    row(`${T("d")}.0`, P2.toHex()),
  ];
  const ordinalRows = [row(`${T("5")}.3`, pngInscription(), { tags: ["type:image/png", "origin"] })];
  const inv = buildInventory(rows, { ordinalRows, txs: new Map([[deployTx.id("hex"), deployTx]]) });
  const byId = new Map(inv.tokens.map((t) => [t.tokenId, t]));

  it("groups by token id and sums value", () => {
    const g = byId.get(gold)!;
    expect(g.balance).toBe(100_000n + 250n + 17n);
    expect(g.valueOutputs).toBe(3);
    expect(g).toMatchObject({ sym: "GOLD", dec: 2, deployInWallet: true, encodings: ["mandala"] });
  });

  it("a Mandala deploy's icon is the image embedded in it (nothing to resolve)", () => {
    const icon = byId.get(gold)!.icon!;
    expect(icon.outpoint).toBe(`${deployTx.id("hex")}_0`);
    expect(icon.image?.contentType).toBe("image/png");
    expect(icon.image?.via).toBe("embedded");
    expect(Array.from(icon.image!.bytes)).toEqual(Array.from(PNG));
    const s = byId.get(`${T("3")}_0`)!;
    expect(s).toMatchObject({ sym: "SILV", balance: 0n, authorities: 1 });
    expect(s.icon).toBeUndefined();
    // Not an image: no picture, the deploy named.
    const iron = byId.get(`${T("4")}_0`)!;
    expect(iron.icon).toEqual({ outpoint: `${T("4")}_0` });
    expect(iron.dec).toBeUndefined();
  });

  it("a legacy JSON deploy's icon outpoint resolves from the ordinals basket as before", () => {
    const j = byId.get(`${T("8")}_0`)!;
    expect(j.icon!.outpoint).toBe(silverIcon);
    expect(j.icon!.image?.via).toBe("inscription");
  });

  it("reads legacy JSON deploys and transfers, mixed with binary outputs", () => {
    const o = byId.get(old)!;
    expect(o).toMatchObject({ sym: "OLD", dec: 1, balance: 542n, deployInWallet: true });
    expect(o.encodings.sort()).toEqual(["bsv21", "mandala"]);
    // one token, one id `<txid>_0`
    expect(o.tokenId).toBe(`${T("2")}_0`);
    expect(byId.has(T("2"))).toBe(false);
  });

  it("writes every token id `<txid>_<vout>` (David 2026-10-07, BRC-162 Token identification): Mandala and legacy BSV-21 alike, `_0` included", () => {
    // a Mandala deploy row: `<txid>_0`
    expect(decodeTokenRow({ outpoint: `${T("3")}.0`, lockingScript: silverDeploy.toHex() })).toMatchObject({ tokenId: `${T("3")}_0`, role: "deploy", encoding: "mandala" });
    // a Mandala value row with a 32-byte id: `<txid>_0`
    const v32 = decodeTokenRow({ outpoint: `${T("a")}.0`, lockingScript: Mandala.value(goldSdk, 250n, { lock: ADDR }).lock().toHex() })!;
    expect(Mandala.decode(LockingScript.fromHex(Mandala.value(goldSdk, 1n, { lock: ADDR }).lock().toHex()))!.idBytes!.length).toBe(32);
    expect(v32).toMatchObject({ tokenId: gold, role: "value", encoding: "mandala" });
    // a Mandala value row with a 36-byte (legacy, vout > 0) id: `<txid>_<vout>`
    const legacy36 = `${T("7")}_2`;
    expect(decodeTokenRow({ outpoint: `${T("e")}.0`, lockingScript: Mandala.value(legacy36, 3n, { lock: ADDR }).lock().toHex() })).toMatchObject({ tokenId: legacy36, encoding: "mandala" });
    // a BSV-21 JSON row: `<txid>_<vout>`, `_0` included
    expect(decodeTokenRow({ outpoint: `${T("2")}.0`, lockingScript: legacyDeploy.toHex() })).toMatchObject({ tokenId: `${T("2")}_0`, encoding: "bsv21" });
    expect(decodeTokenRow({ outpoint: `${T("b")}.1`, lockingScript: BSV21.transfer(old, 40n).lock(P2).toHex() })).toMatchObject({ tokenId: old, encoding: "bsv21" });
    expect(byId.get(gold)!.tokenId).toBe(gold);
  });

  it("shows a token without its deploy as id and balance only", () => {
    const x = byId.get(`${T("7")}_2`)!;
    expect(x).toMatchObject({ balance: 7n, deployInWallet: false });
    expect(x.sym).toBeUndefined();
    expect(x.icon).toBeUndefined();
  });

  it("lists outputs neither template decodes", () => {
    expect(inv.unrecognized).toEqual([`${T("d")}_0`]);
    expect(decodeTokenRow({ outpoint: `${T("d")}.0`, lockingScript: P2.toHex() })).toBeUndefined();
  });
});

describe("ordinals picker", () => {
  it("offers image ordinals with the outpoint that holds the bytes", () => {
    const items = imageOrdinals([
      row(`${T("1")}.0`, pngInscription(), { tags: ["type:image/png", "origin"] }),
      // transferred: no envelope in the script, bytes at its origin
      row(`${T("2")}.1`, P2.toHex(), { tags: ["type:image/jpeg", `origin:${T("9")}_0`] }),
      // text inscription: not an image
      row(`${T("3")}.0`, buildInscriptionScript(P2, new Uint8Array([104, 105]), "text/plain").toHex(), { tags: ["type:text/plain"] }),
      // an image tag but no bytes and no pointer: unusable
      row(`${T("4")}.0`, P2.toHex(), { tags: ["type:image/png"] }),
    ]);
    expect(items.map((i) => [i.outpoint, i.iconOutpoint, i.contentType, !!i.image])).toEqual([
      [`${T("1")}_0`, `${T("1")}_0`, "image/png", true],
      [`${T("2")}_1`, `${T("9")}_0`, "image/jpeg", false],
    ]);
  });
});

describe("deploy action", () => {
  const key = (keyID: string, n: number): DerivedKey => ({
    protocolID: [0, "onesat"],
    keyID,
    publicKey: PrivateKey.fromHex(n.toString(16).padStart(64, "0")).toPublicKey().toString(),
  });
  const tokenKey = key("bsv21-deploy-GOLD-00", 2);
  const base: DeployRequest = { symbol: "GOLD", decimals: 2, supply: { kind: "fixed", amount: 100_000n }, icon: { kind: "none" } };
  const tokenLock = new P2PKH().lock(PrivateKey.fromHex("02".padStart(64, "0")).toAddress());

  const deployOut = (args: ReturnType<typeof buildDeployArgs>) => {
    const out = args.outputs![0]!;
    return { out, t: Mandala.decode(LockingScript.fromHex(out.lockingScript))!, ci: JSON.parse(out.customInstructions!) };
  };

  it("no icon: one bsv21 deploy output", () => {
    const args = buildDeployArgs(base, tokenKey);
    expect(args.outputs).toHaveLength(1);
    expect(args.options).toMatchObject({ randomizeOutputs: false });
    const { out, t, ci } = deployOut(args);
    expect(out).toMatchObject({ satoshis: 1, basket: "bsv21", tags: ["bsv21:deploy"], outputDescription: "Deploy GOLD" });
    expect(t).toMatchObject({ role: "deploy", amount: 100_000n, metadata: { sym: "GOLD", dec: 2 } });
    expect(t.lock.toHex()).toBe(tokenLock.toHex());
    expect(ci).toEqual({ amt: "100000", op: "deploy+mint", sym: "GOLD", dec: "2", protocolID: [0, "onesat"], keyID: "bsv21-deploy-GOLD-00" });
  });

  it("authority supply: amount 0, deploy+auth tags", () => {
    const { out, t, ci } = deployOut(buildDeployArgs({ ...base, supply: { kind: "authority" } }, tokenKey));
    expect(out.tags).toEqual(["bsv21:deploy", "bsv21:auth"]);
    expect(t).toMatchObject({ role: "deploy", amount: 0n });
    expect(ci).toMatchObject({ amt: "0", op: "deploy+auth" });
  });

  it("an icon is embedded in the deploy's payload, [mediaType, bytes] (BRC-162 draft BRCs#308): an upload or an ordinal's bytes; one output", () => {
    for (const kind of ["upload", "ordinal"] as const) {
      const args = buildDeployArgs({ ...base, icon: { kind, content: PNG, contentType: "image/png" } }, tokenKey);
      expect(args.outputs).toHaveLength(1);
      const { t, ci } = deployOut(args);
      expect(t.metadata!.icon).toEqual({ mediaType: "image/png", bytes: PNG });
      expect(ci.icon).toBeUndefined();
    }
    // The media type as embedded: its parameters dropped, lower case.
    const { t } = deployOut(buildDeployArgs({ ...base, icon: { kind: "upload", content: PNG, contentType: "image/PNG; x=1" } }, tokenKey));
    expect(t.metadata!.icon!.mediaType).toBe("image/png");
  });

  it("refuses bad input", () => {
    expect(() => buildDeployArgs({ ...base, symbol: " " }, tokenKey)).toThrow();
    expect(() => buildDeployArgs({ ...base, decimals: 19 }, tokenKey)).toThrow();
    expect(() => buildDeployArgs({ ...base, supply: { kind: "fixed", amount: 0n } }, tokenKey)).toThrow();
    expect(() => buildDeployArgs({ ...base, icon: { kind: "upload", content: PNG, contentType: "text/plain" } }, tokenKey)).toThrow();
    expect(() => buildDeployArgs({ ...base, icon: { kind: "upload", content: new Uint8Array(), contentType: "image/png" } }, tokenKey)).toThrow();
  });

  it("derives keys through the wallet and hands the action to the wallet", async () => {
    const calls: { getPublicKey: unknown[]; createAction: any[] } = { getPublicKey: [], createAction: [] };
    const wallet = {
      async getPublicKey(args: any) {
        calls.getPublicKey.push(args);
        return { publicKey: PrivateKey.fromHex("02".padStart(64, "0")).toPublicKey().toString() };
      },
      async createAction(args: any) {
        calls.createAction.push(args);
        return { txid: T("f") };
      },
    } as unknown as WalletInterface;
    const res = await deployToken(wallet, { ...base, icon: { kind: "upload", content: PNG, contentType: "image/png" } });
    expect(res).toMatchObject({ txid: T("f"), tokenId: `${T("f")}_0` });
    expect(calls.getPublicKey).toHaveLength(1);
    expect(calls.getPublicKey[0]).toMatchObject({ protocolID: [0, "onesat"], counterparty: "self", forSelf: true });
    expect((calls.getPublicKey[0] as any).keyID).toMatch(/^bsv21-deploy-GOLD-[0-9a-f]{16}$/);
    expect(calls.createAction).toHaveLength(1);
    const ca = calls.createAction[0];
    expect(ca.outputs).toHaveLength(1);
    // 1sat-sdk's pipeline stamps its managed `id:<action>_<index>` tag on basketed outputs
    expect(ca.outputs[0].tags.slice(0, 1)).toEqual(["bsv21:deploy"]);
    expect(ca.outputs[0].tags[1]).toMatch(/^id:[0-9a-f]{16}_0$/);
    expect(JSON.parse(ca.outputs[0].customInstructions).keyID).toBe((calls.getPublicKey[0] as any).keyID);
    expect(ca.options).toMatchObject({ randomizeOutputs: false });
  });
});
