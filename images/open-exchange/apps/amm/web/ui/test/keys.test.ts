import { describe, expect, it } from "vitest";
import { PrivateKey } from "@bsv/sdk";
import { deriveValidatorPubKey } from "../src/lib/keys";

// Pinned vector: computed directly with @bsv/sdk (no programs/amm-topic
// fixtures exist yet in this worktree — task fallback: "compute with
// @bsv/sdk and pin"). The validator's identity root is PrivateKey(1), a
// fixed deterministic test scalar (same convention as runar-sdk's README
// quick start). Cross-checked two ways when the vector was generated:
// KeyDeriver('anyone').derivePublicKey(protocol, keyId, identityPubKey)
// (what a client with no private key computes) equals
// KeyDeriver(validatorRoot).derivePrivateKey(protocol, keyId, 'anyone').toPublicKey()
// (what the validator itself, holding its root key, would sign with) — see
// docs/notes.md "Validator derivation" and "Identity" for why 'anyone'
// counterparty makes this a public, one-way computable child key.
describe("deriveValidatorPubKey", () => {
  const validatorIdentityHex = new PrivateKey(1).toPublicKey().toString();
  const outpoint = {
    txid: "aa11bb22cc33dd44ee55ff660011223344556677889900112233445566778899",
    vout: 0,
  };

  it("matches the pinned vector", () => {
    expect(validatorIdentityHex).toBe(
      "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    );
    const derived = deriveValidatorPubKey(validatorIdentityHex, outpoint);
    expect(derived).toBe(
      "03562cac932cbd0b8a3b3c8de23a0c60c3c46b0e9a6589cb7f6eea376cbc60dc8d",
    );
  });

  it("changes when the outpoint (key ID) changes", () => {
    const a = deriveValidatorPubKey(validatorIdentityHex, outpoint);
    const b = deriveValidatorPubKey(validatorIdentityHex, { ...outpoint, vout: 1 });
    expect(a).not.toBe(b);
  });
});
