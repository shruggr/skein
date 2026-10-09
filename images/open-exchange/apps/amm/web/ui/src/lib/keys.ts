import { KeyDeriver, PublicKey, type WalletProtocol } from "@bsv/sdk";

/**
 * Validator key derivation (docs/notes.md, "Validator derivation" and
 * "Overlay and communication layer on skein" / "Identity"):
 *
 * BRC-43 security level 1, protocol "amm pool" (BRC-43 needs >= 5
 * characters, so not "amm"), key ID `<txid display hex>_<vout>`, anyone
 * counterparty: invoice `1-amm pool-<txid>_<vout>`.
 *
 * The pool's rotating `ValidatorPubKey` is always a child of the
 * validator's own stable `ValidatorIdentity`, keyed by the outpoint of the
 * *last input the validator signed*. At deploy nothing is signed yet, so
 * the starting point is the LP's token deposit: the first input spending
 * an output of this token id (state layout, pool/Pool.runar.go).
 *
 * Because the counterparty is "anyone", this is a public one-way function
 * of the validator's identity public key and the key ID: anyone holding
 * `validatorIdentity` (published, part of every pool's state) can compute
 * the derived child public key without the validator's private key. The
 * LP's deploy-time UI uses this to fill the pool's initial `ValidatorPubKey`
 * state field before ever talking to the validator.
 */
export const AMM_POOL_PROTOCOL: WalletProtocol = [1, "amm pool"];

/** `<txid display hex>_<vout>` key ID for a spent outpoint, per the convention above. */
export function validatorKeyId(outpoint: { txid: string; vout: number }): string {
  return `${outpoint.txid}_${outpoint.vout}`;
}

/**
 * Derives the rotating validator signing public key (hex, compressed) as a
 * child of `validatorIdentityHex`, keyed by the outpoint the validator is
 * about to sign for (or, at deploy, the LP's first token-deposit input).
 * Callable by anyone: only `validatorIdentityHex` (public) is needed.
 */
export function deriveValidatorPubKey(
  validatorIdentityHex: string,
  outpoint: { txid: string; vout: number },
): string {
  const anyone = new KeyDeriver("anyone");
  const identity = PublicKey.fromString(validatorIdentityHex);
  const keyId = validatorKeyId(outpoint);
  return anyone
    .derivePublicKey(AMM_POOL_PROTOCOL, keyId, identity, false)
    .toString();
}
