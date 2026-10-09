//go:build ignore

// Pool is a single-LP constant-product AMM between BSV and one BSV-21 binary
// token (BRC-162).
//
// On-chain locking script (a BRC-162 value output with no payload):
//
//	0x20 <assetId:32> <push tokenReserve> OP_2DROP || code || OP_RETURN || state
//
// The BSV reserve is the output's satoshi value. The token reserve lives in
// the token prefix and is duplicated in state (TokenReserve), because the
// prefix sits before Rúnar's OP_CODESEPARATOR and is not covered by the
// preimage. The same goes for the asset id, a readonly property compiled into
// the code. The contract never reads the input's prefix; it always writes the
// continuation's prefix from its own copies. Overlays must check prefix ==
// state (and a 32-byte AssetId) once, when a pool is first admitted.
//
// Token outputs (payouts and fees) are BRC-162 value outputs locked with
// P2PKH, holding 1 sat.
//
// Fees (each fixed at deploy, in basis points of amountIn, rounded up, taken
// in the input asset): LpFeeBps to the LP, ValidatorFeeBps to the validator,
// and CommissionBps to whoever relays the swap (a market, or the user's own
// overlay), at the address it names per call. The contract builds every
// output itself; a swap carries no arbitrary outputs.
// The script cannot see token inputs, so every method that brings tokens in
// requires the validator's signature: the validator's role is to confirm the
// token inputs are valid and cover the token outputs.
package pool

import runar "github.com/icellan/runar/packages/runar-go"

type Pool struct {
	runar.StatefulSmartContract

	TokenReserve runar.Bigint
	// Keys rotate: each party supplies its next key on every spend it signs
	// (validator: swap, addLiquidity; LP: addLiquidity, removeLiquidity).
	// Payouts go to Hash160 of the current key. Next keys are derived
	// off-chain so wallets can find their payouts from overlay data.
	LpPubKey        runar.PubKey
	ValidatorPubKey runar.PubKey

	// ValidatorIdentity is state only so the compiler keeps it: Rúnar drops
	// unreferenced readonly fields, and the Go DSL has no way to opt out (see
	// docs/notes.md, upstream candidate #6). It is never assigned, so every
	// continuation carries it forward unchanged.
	//
	// It is the validator's stable identity key: who a taker
	// contacts to execute a swap (BRC-103 auth; resolving it to an address is
	// deferred), and the BRC-42 root of the rotating ValidatorPubKey, derived
	// with the `anyone` counterparty keyed by the outpoint of input 0 of the
	// transaction creating the pool output. The contract never checks the
	// derivation: the validator won't sign a spend that breaks it, and the
	// overlay rejects violations.
	ValidatorIdentity runar.PubKey

	// AssetId is the token's canonical 32-byte BRC-162 id (the deploy txid;
	// binary deploys are at output 0). 36-byte legacy ids are not supported.
	AssetId         runar.ByteString `runar:"readonly"`
	LpFeeBps        runar.Bigint     `runar:"readonly"`
	ValidatorFeeBps runar.Bigint     `runar:"readonly"`
	// CommissionBps is the relay's commission. Markets filter pools by it.
	CommissionBps runar.Bigint `runar:"readonly"`
}

// Swap trades amountIn of one asset for the other along x·y = k.
// bsvIn selects the direction. Three fees are taken from amountIn in the
// input asset: the LP fee, the validator fee and the commission, paid to
// commissionPkh (named by the relay per call). Only amountIn minus fees
// enters the pool. A CommissionBps of 0 means no commission output.
//
// Outputs: 0 pool, 1 user payout, then LP fee, validator fee and commission,
// each only when nonzero.
func (c *Pool) Swap(validatorSig runar.Sig, nextValidatorPubKey runar.PubKey, amountIn runar.Bigint, bsvIn runar.Bool, userPkh runar.Addr, commissionPkh runar.Addr) {
	runar.Assert(runar.CheckSig(validatorSig, c.ValidatorPubKey))
	runar.Assert(amountIn > 0)
	lpPkh := runar.Hash160(c.LpPubKey)
	validatorPkh := runar.Hash160(c.ValidatorPubKey)

	bsvReserve := runar.ExtractAmount(c.TxPreimage)
	// Fees round up, in the pool's favour: a nonzero rate always takes >= 1.
	lpFee := (amountIn*c.LpFeeBps + 9999) / 10000
	validatorFee := (amountIn*c.ValidatorFeeBps + 9999) / 10000
	commission := (amountIn*c.CommissionBps + 9999) / 10000
	net := amountIn - lpFee - validatorFee - commission
	runar.Assert(net > 0)

	out := net * bsvReserve / (c.TokenReserve + net)
	newBsv := bsvReserve - out
	newTokens := c.TokenReserve + net
	if bsvIn {
		out = net * c.TokenReserve / (bsvReserve + net)
		newBsv = bsvReserve + net
		newTokens = c.TokenReserve - out
	}
	runar.Assert(out > 0)

	c.TokenReserve = newTokens
	c.ValidatorPubKey = nextValidatorPubKey
	c.writePool(newBsv)
	c.AddRawOutput(c.payoutSats(out, !bsvIn), c.payoutScript(out, userPkh, !bsvIn))
	// Scripts computed outside the conditionals: a conditional output whose
	// argument inlines nested branches (payoutScript -> tokenPrefix) trips
	// a Rúnar codegen error. A single level of branching is fine.
	lpScript := c.payoutScript(lpFee, lpPkh, bsvIn)
	validatorScript := c.payoutScript(validatorFee, validatorPkh, bsvIn)
	commissionScript := c.payoutScript(commission, commissionPkh, bsvIn)
	if lpFee > 0 {
		c.AddRawOutput(c.payoutSats(lpFee, bsvIn), lpScript)
	}
	if validatorFee > 0 {
		c.AddRawOutput(c.payoutSats(validatorFee, bsvIn), validatorScript)
	}
	if commission > 0 {
		c.AddRawOutput(c.payoutSats(commission, bsvIn), commissionScript)
	}
}

// AddLiquidity lets the LP deposit BSV and/or tokens. The LP owns the pool,
// so deposits need not keep the reserve ratio. Tokens coming in need the
// validator's signature.
//
// Outputs: 0 pool.
func (c *Pool) AddLiquidity(lpSig runar.Sig, validatorSig runar.Sig, nextLpPubKey runar.PubKey, nextValidatorPubKey runar.PubKey, addBsv runar.Bigint, addTokens runar.Bigint) {
	runar.Assert(runar.CheckSig(lpSig, c.LpPubKey))
	runar.Assert(runar.CheckSig(validatorSig, c.ValidatorPubKey))
	runar.Assert(addBsv >= 0)
	runar.Assert(addTokens >= 0)
	runar.Assert(addBsv+addTokens > 0)

	c.TokenReserve = c.TokenReserve + addTokens
	c.LpPubKey = nextLpPubKey
	c.ValidatorPubKey = nextValidatorPubKey
	c.writePool(runar.ExtractAmount(c.TxPreimage) + addBsv)
}

// RemoveLiquidity lets the LP withdraw BSV and/or tokens to their payout
// lock. Either both reserves stay positive and the pool continues, or both
// reach zero and the pool closes (no continuation output).
//
// Outputs: 0 pool (unless closing), then BSV and token withdrawals when nonzero.
func (c *Pool) RemoveLiquidity(lpSig runar.Sig, nextLpPubKey runar.PubKey, removeBsv runar.Bigint, removeTokens runar.Bigint) {
	runar.Assert(runar.CheckSig(lpSig, c.LpPubKey))
	lpPkh := runar.Hash160(c.LpPubKey)
	runar.Assert(removeBsv >= 0)
	runar.Assert(removeTokens >= 0)
	runar.Assert(removeBsv+removeTokens > 0)

	newBsv := runar.ExtractAmount(c.TxPreimage) - removeBsv
	c.TokenReserve = c.TokenReserve - removeTokens
	c.LpPubKey = nextLpPubKey
	closing := newBsv == 0 && c.TokenReserve == 0
	runar.Assert(closing || (newBsv > 0 && c.TokenReserve > 0))

	if !closing {
		c.AddRawOutput(newBsv, c.poolScript())
	}
	if removeBsv > 0 {
		c.AddRawOutput(removeBsv, p2pkh(lpPkh))
	}
	if removeTokens > 0 {
		c.AddRawOutput(1, c.tokenP2pkh(removeTokens, lpPkh))
	}
}

// writePool emits the pool continuation holding bsvReserve.
func (c *Pool) writePool(bsvReserve runar.Bigint) {
	runar.Assert(bsvReserve > 0)
	runar.Assert(c.TokenReserve > 0)
	c.AddRawOutput(bsvReserve, c.poolScript())
}

// poolScript is the pool's locking script for the current state: token
// prefix for TokenReserve, this contract's code (recovered from the preimage
// scriptCode), and the state.
func (c *Pool) poolScript() runar.ByteString {
	// scriptCode = varint || code[2:] || OP_RETURN || state, where state is
	// TokenReserve (8) + LpPubKey, ValidatorPubKey, ValidatorIdentity (33
	// each) = 107 bytes.
	sc := runar.ExtractScriptCode(c.TxPreimage)
	first := runar.Bin2Num(runar.Cat(runar.Substr(sc, 0, 1), runar.Num2Bin(0, 1)))
	varintLen := runar.Bigint(1)
	if first == 253 {
		varintLen = 3
	}
	body := runar.Substr(sc, varintLen, runar.Len(sc)-varintLen-107)

	// Re-add the two prologue bytes (OP_NOP OP_CODESEPARATOR) that sit
	// before the separator and are therefore not in scriptCode.
	script := runar.Cat(c.tokenPrefix(c.TokenReserve), runar.Cat(runar.ByteString("\x61\xab"), body))
	return runar.Cat(script, c.GetStateScript())
}

// payoutSats is the output value for paying amount of BSV (isBsv) or tokens.
func (c *Pool) payoutSats(amount runar.Bigint, isBsv runar.Bool) runar.Bigint {
	sats := runar.Bigint(1)
	if isBsv {
		sats = amount
	}
	return sats
}

// payoutScript pays amount of BSV (isBsv) or tokens to pkh.
func (c *Pool) payoutScript(amount runar.Bigint, pkh runar.Addr, isBsv runar.Bool) runar.ByteString {
	s := p2pkh(pkh)
	if !isBsv {
		s = c.tokenP2pkh(amount, pkh)
	}
	return s
}

// tokenP2pkh is a BRC-162 value output of amount to pkh (no payload).
func (c *Pool) tokenP2pkh(amount runar.Bigint, pkh runar.Addr) runar.ByteString {
	return runar.Cat(c.tokenPrefix(amount), p2pkh(pkh))
}

// tokenPrefix is the BRC-162 value-output prefix push(assetId) push(amount)
// OP_2DROP, with no payload. The id push length is fixed at 32 bytes; the
// amount is minimally pushed (OP_1..OP_16 for small values). Callers only
// emit it for amount > 0 (a zero amount would be an authority output);
// zero-amount scripts are built but never output.
func (c *Pool) tokenPrefix(amount runar.Bigint) runar.ByteString {
	push := runar.Num2Bin(runar.Clamp(amount, 0, 16)+80, 1) // OP_1..OP_16
	if amount > 16 {
		amt := runar.Pack(amount)
		push = runar.Cat(runar.Num2Bin(runar.Len(amt), 1), amt)
	}
	prefix := runar.Cat(runar.ByteString("\x20"), c.AssetId)
	return runar.Cat(prefix, runar.Cat(push, runar.ByteString("\x6d")))
}

func p2pkh(pkh runar.Addr) runar.ByteString {
	return runar.Cat(runar.ByteString("\x76\xa9\x14"), runar.Cat(pkh, runar.ByteString("\x88\xac")))
}
