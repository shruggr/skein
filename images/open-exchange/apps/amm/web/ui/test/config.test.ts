import { describe, expect, it } from "vitest";
import { appBaseOf, appName } from "../src/lib/config";
import { policyOf } from "../src/validator/control";

describe("the app's base URL from the page's own URL", () => {
  it("is the page's directory: <handle>.<host>/<app>/ or <host>/@<handle>/<app>/", () => {
    expect(appBaseOf("https://alice.skein.nexus/amm/")).toBe("https://alice.skein.nexus/amm");
    expect(appBaseOf("https://alice.skein.nexus/amm/index.html?x=1#swap")).toBe("https://alice.skein.nexus/amm");
    expect(appBaseOf("http://127.0.0.1:8100/@alice/amm/")).toBe("http://127.0.0.1:8100/@alice/amm");
    expect(appBaseOf("http://localhost:4900/")).toBeUndefined();
  });

  it("names the app by its last segment", () => {
    expect(appName("https://alice.skein.nexus/amm")).toBe("amm");
    expect(appName("http://127.0.0.1:8100/@alice/amm")).toBe("amm");
    expect(appName("http://127.0.0.1:8100/@alice")).toBeUndefined();
    expect(appName("http://localhost:4900")).toBeUndefined();
  });
});

describe("the policy from the installed app record", () => {
  it("reads config.amm and config.overlay's market / validator (objects), as the programs do before the genesis defaults", () => {
    const rec = { kind: "app", name: "amm", config: { amm: { ammValidator: { minValidatorFeeBps: 5, maxLpFeeBps: 100 } }, overlay: { market: { window: 90_000 }, validator: { every: 30_000 } } } };
    expect(policyOf(rec)).toEqual({ minValidatorFeeBps: 5, maxLpFeeBps: 100, marketWindowMs: 90_000, validatorEveryMs: 30_000 });
    expect(policyOf({ kind: "app", name: "amm" })).toEqual({});
  });
});
