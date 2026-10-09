package pool

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	"github.com/icellan/runar/compilers/go/compiler"
	runar "github.com/icellan/runar/packages/runar-go"
)

// These tests hand-build transactions and run input 0 (the pool) through the
// go-sdk interpreter with the real BIP-143 preimage. Rúnar's SDK call helpers
// don't understand a locking-script prefix yet, so they are bypassed.

const (
	methodSwap = iota
	methodAddLiquidity
	methodRemoveLiquidity
)

// assetID is a canonical BRC-162 token id: the 32-byte deploy txid.
var assetID = bytes.Repeat([]byte{0xa5}, 32)

var validatorIdentity = key(nil, 0x7f)

type fixture struct {
	code          []byte // compiled code with readonly args spliced in (no state)
	userPkh       []byte
	commissionPkh []byte // the relay's payout address, passed per swap
	lpFeeBps      int64
	validatorBps  int64
	commissionBps int64
}

func newFixture(t *testing.T, lpFeeBps, validatorBps, commissionBps int64) *fixture {
	t.Helper()
	art, err := compiler.CompileFromSource("Pool.runar.go")
	if err != nil {
		t.Fatal(err)
	}
	js, err := compiler.ArtifactToJSON(art)
	if err != nil {
		t.Fatal(err)
	}
	var sa runar.RunarArtifact
	if err := json.Unmarshal(js, &sa); err != nil {
		t.Fatal(err)
	}
	f := &fixture{
		userPkh:       bytes.Repeat([]byte{0x33}, 20),
		commissionPkh: bytes.Repeat([]byte{0x44}, 20),
		lpFeeBps:      lpFeeBps,
		validatorBps:  validatorBps,
		commissionBps: commissionBps,
	}

	// State values don't affect the code part; any will do.
	p := pool{tokens: 1000, lp: key(t, 1), validator: key(t, 2)}
	c := runar.NewRunarContract(&sa, []interface{}{
		p.tokens,
		hex.EncodeToString(p.lp.PubKey().Compressed()),
		hex.EncodeToString(p.validator.PubKey().Compressed()),
		hex.EncodeToString(validatorIdentity.PubKey().Compressed()),
		hex.EncodeToString(assetID),
		lpFeeBps,
		validatorBps,
		commissionBps,
	})
	full, _ := hex.DecodeString(c.GetLockingScript())
	tail := append([]byte{0x6a}, p.state()...)
	if !bytes.HasSuffix(full, tail) {
		t.Fatalf("SDK state layout differs from pool.state(): %x", full[len(full)-len(tail):])
	}
	f.code = full[:len(full)-len(tail)]
	return f
}

// key stands in for an off-chain deterministic derivation: key n of a party.
func key(t *testing.T, n byte) *ec.PrivateKey {
	k, _ := ec.PrivateKeyFromBytes(bytes.Repeat([]byte{n}, 32))
	return k
}

// next is the party's following key in its derivation sequence.
func next(k *ec.PrivateKey) *ec.PrivateKey { return key(nil, k.Serialize()[0]+1) }

func pkh(k *ec.PrivateKey) []byte { return k.PubKey().Hash() }

// --- script building (mirrors the contract) ---

func scriptNum(n int64) []byte {
	var b []byte
	for n > 0 {
		b = append(b, byte(n&0xff))
		n >>= 8
	}
	if len(b) > 0 && b[len(b)-1]&0x80 != 0 {
		b = append(b, 0)
	}
	return b
}

// pushNum is a minimal push of a number (-1 as OP_1NEGATE, other negatives
// as sign-magnitude).
func pushNum(n int64) []byte {
	switch {
	case n == -1:
		return []byte{0x4f}
	case n < 0:
		b := scriptNum(-n)
		if b[len(b)-1]&0x80 != 0 {
			b = append(b, 0x80)
		} else {
			b[len(b)-1] |= 0x80
		}
		return append([]byte{byte(len(b))}, b...)
	case n == 0:
		return []byte{0x00}
	case n <= 16:
		return []byte{byte(0x50 + n)}
	}
	b := scriptNum(n)
	return append([]byte{byte(len(b))}, b...)
}

func pushData(b []byte) []byte {
	s, _ := hex.DecodeString(runar.EncodePushData(hex.EncodeToString(b)))
	return s
}

func pushBool(v bool) []byte {
	if v {
		return []byte{0x51}
	}
	return []byte{0x00}
}

// tokenPrefix is the BRC-162 value-output prefix with no payload:
// push(assetId) push(amount) OP_2DROP.
func tokenPrefix(amount int64) []byte {
	p := append([]byte{0x20}, assetID...)
	p = append(p, pushNum(amount)...)
	return append(p, 0x6d)
}

// state is TokenReserve (8, LE) || LpPubKey || ValidatorPubKey ||
// ValidatorIdentity (33 each). newFixture checks this against the SDK.
func (p pool) state() []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, uint64(p.tokens))
	b = append(b, p.lp.PubKey().Compressed()...)
	b = append(b, p.validator.PubKey().Compressed()...)
	return append(b, validatorIdentity.PubKey().Compressed()...)
}

func p2pkh(pkh []byte) []byte {
	return append(append([]byte{0x76, 0xa9, 0x14}, pkh...), 0x88, 0xac)
}

func (f *fixture) poolScript(p pool) []byte {
	s := append(tokenPrefix(p.tokens), f.code...)
	s = append(s, 0x6a)
	return append(s, p.state()...)
}

func tokenP2pkh(amount int64, pkh []byte) []byte {
	return append(tokenPrefix(amount), p2pkh(pkh)...)
}

// --- spending ---

type pool struct {
	bsv, tokens   int64
	lp, validator *ec.PrivateKey // current keys
	lock          []byte         // defaults to poolScript(pool)
}

type out struct {
	sats   int64
	script []byte
}

type call struct {
	method int
	args   [][]byte // pushes, in ABI order, excluding implicit params
	outs   []out
	// signers produce sigs over the real preimage; placed at sigSlots in args.
	signers  []*ec.PrivateKey
	sigSlots []int
	// poolIndex is the pool's input index (0 by convention; not enforced).
	poolIndex int
}

// separatorScriptCode is the locking script after the pool's OP_CODESEPARATOR.
func separatorScriptCode(lock []byte) []byte {
	off := 1 + 32 // push assetId
	switch op := lock[off]; {
	case op >= 0x51 && op <= 0x60:
		off++
	default:
		off += 1 + int(op)
	}
	off++ // OP_2DROP
	if lock[off] != 0x61 || lock[off+1] != 0xab {
		panic("separator not where expected")
	}
	return lock[off+2:]
}

func (f *fixture) run(t *testing.T, p pool, c call) error {
	t.Helper()
	lock := p.lock
	if lock == nil {
		lock = f.poolScript(p)
	}
	prevOut := &transaction.TransactionOutput{Satoshis: uint64(p.bsv), LockingScript: script.NewFromBytes(lock)}

	tx := transaction.NewTransaction()
	prevTxid, _ := chainhash.NewHashFromHex(strings.Repeat("11", 32))
	fundTxid, _ := chainhash.NewHashFromHex(strings.Repeat("22", 32))
	poolIn := &transaction.TransactionInput{SourceTXID: prevTxid, SourceTxOutIndex: 0, SequenceNumber: 0xffffffff}
	poolIn.SetSourceTxOutput(prevOut)
	// A funding / token input. Not executed here: the validator vouches for it.
	fundIn := &transaction.TransactionInput{SourceTXID: fundTxid, SourceTxOutIndex: 0, SequenceNumber: 0xffffffff}
	if c.poolIndex == 0 {
		tx.AddInput(poolIn)
		tx.AddInput(fundIn)
	} else {
		tx.AddInput(fundIn)
		tx.AddInput(poolIn)
	}
	pi := c.poolIndex
	for _, o := range c.outs {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(o.sats), LockingScript: script.NewFromBytes(o.script)})
	}

	cp := tx.ShallowClone()
	cp.Inputs[pi].SetSourceTxOutput(&transaction.TransactionOutput{Satoshis: uint64(p.bsv), LockingScript: script.NewFromBytes(separatorScriptCode(lock))})
	pre, err := cp.CalcInputPreimage(uint32(pi), sighash.AllForkID)
	if err != nil {
		t.Fatal(err)
	}
	h1 := sha256.Sum256(pre)
	digest := sha256.Sum256(h1[:])

	args := append([][]byte{}, c.args...)
	for i, k := range c.signers {
		sig, err := k.Sign(digest[:])
		if err != nil {
			t.Fatal(err)
		}
		args[c.sigSlots[i]] = pushData(append(sig.Serialize(), 0x41))
	}

	var u []byte
	u = append(u, pushData(f.code)...) // _codePart
	for _, a := range args {
		u = append(u, a...)
	}
	u = append(u, pushData(make([]byte, 20))...) // _changePKH
	u = append(u, 0x00)                          // _changeAmount = 0: no change output
	u = append(u, pushData(pre)...)              // txPreimage
	u = append(u, pushNum(int64(c.method))...)
	tx.Inputs[pi].UnlockingScript = script.NewFromBytes(u)

	return interpreter.NewEngine().Execute(
		interpreter.WithTx(tx, pi, prevOut),
		interpreter.WithForkID(),
		interpreter.WithAfterGenesis(),
		interpreter.WithAfterChronicle(),
	)
}

// --- expected results (reference math) ---

type swapResult struct {
	out, lpFee, validatorFee, commission, newBsv, newTokens int64
	nextValidator                                           *ec.PrivateKey
}

func (r swapResult) pool(p pool) pool {
	return pool{bsv: r.newBsv, tokens: r.newTokens, lp: p.lp, validator: r.nextValidator}
}

func (f *fixture) expectSwap(p pool, amountIn int64, bsvIn bool) swapResult {
	r := swapResult{
		lpFee:         (amountIn*f.lpFeeBps + 9999) / 10000,
		validatorFee:  (amountIn*f.validatorBps + 9999) / 10000,
		commission:    (amountIn*f.commissionBps + 9999) / 10000,
		nextValidator: next(p.validator),
	}
	net := amountIn - r.lpFee - r.validatorFee - r.commission
	if bsvIn {
		r.out = net * p.tokens / (p.bsv + net)
		r.newBsv, r.newTokens = p.bsv+net, p.tokens-r.out
	} else {
		r.out = net * p.bsv / (p.tokens + net)
		r.newBsv, r.newTokens = p.bsv-r.out, p.tokens+net
	}
	return r
}

// swapCall builds a swap paying the commission (if any) to f.commissionPkh.
func (f *fixture) swapCall(p pool, amountIn int64, bsvIn bool, r swapResult) call {
	// Fees are paid to the keys current at this spend.
	outs := []out{{r.newBsv, f.poolScript(r.pool(p))}}
	// fee pays a fee in the input asset: sats for BSV in, a 1-sat token
	// output for tokens in.
	fee := func(amount int64, to []byte) {
		if amount == 0 {
			return
		}
		if bsvIn {
			outs = append(outs, out{amount, p2pkh(to)})
		} else {
			outs = append(outs, out{1, tokenP2pkh(amount, to)})
		}
	}
	if bsvIn {
		outs = append(outs, out{1, tokenP2pkh(r.out, f.userPkh)})
	} else {
		outs = append(outs, out{r.out, p2pkh(f.userPkh)})
	}
	fee(r.lpFee, pkh(p.lp))
	fee(r.validatorFee, pkh(p.validator))
	fee(r.commission, f.commissionPkh)
	return call{
		method: methodSwap,
		args: [][]byte{nil, pushData(r.nextValidator.PubKey().Compressed()), pushNum(amountIn), pushBool(bsvIn),
			pushData(f.userPkh), pushData(f.commissionPkh)},
		outs:     outs,
		signers:  []*ec.PrivateKey{p.validator},
		sigSlots: []int{0},
	}
}

func mustPass(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
}

func mustFail(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected failure")
	}
	t.Logf("rejected: %v", err)
}

// --- tests ---

func TestSwap(t *testing.T) {
	f := newFixture(t, 30, 5, 0) // 0.30% LP, 0.05% validator, no commission
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}

	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)

		t.Run(name+": pays out along the curve with fees", func(t *testing.T) {
			if r.lpFee == 0 || r.validatorFee == 0 {
				t.Fatalf("fixture should exercise both fees: %+v", r)
			}
			mustPass(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, r)))
		})
		t.Run(name+": product does not decrease", func(t *testing.T) {
			if r.newBsv*r.newTokens < p.bsv*p.tokens {
				t.Fatalf("k decreased: %d -> %d", p.bsv*p.tokens, r.newBsv*r.newTokens)
			}
		})
		t.Run(name+": user takes one more than the curve allows", func(t *testing.T) {
			bad := r
			bad.out++
			if bsvIn {
				bad.newTokens--
			} else {
				bad.newBsv--
			}
			mustFail(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, bad)))
		})
		t.Run(name+": legacy bug, full amountIn into the pool", func(t *testing.T) {
			bad := r
			if bsvIn {
				bad.newBsv = p.bsv + 20_000
			} else {
				bad.newTokens = p.tokens + 20_000
			}
			mustFail(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, bad)))
		})
		t.Run(name+": validator signature from the wrong key", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.signers = []*ec.PrivateKey{p.lp}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": validator fee paid to the next key instead of the current", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			last := &c.outs[len(c.outs)-1]
			if bsvIn {
				last.script = p2pkh(pkh(r.nextValidator))
			} else {
				last.script = tokenP2pkh(r.validatorFee, pkh(r.nextValidator))
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": LP key changes on a swap", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			moved := r.pool(p)
			moved.lp = next(p.lp)
			c.outs[0].script = f.poolScript(moved)
			mustFail(t, f.run(t, p, c))
		})
	}

	t.Run("chained swaps rotate the validator key", func(t *testing.T) {
		r1 := f.expectSwap(p, 20_000, true)
		mustPass(t, f.run(t, p, f.swapCall(p, 20_000, true, r1)))
		p2 := r1.pool(p)
		r2 := f.expectSwap(p2, 50_000, false)
		mustPass(t, f.run(t, p2, f.swapCall(p2, 50_000, false, r2)))

		t.Run("old validator key can no longer sign", func(t *testing.T) {
			c := f.swapCall(p2, 50_000, false, r2)
			c.signers = []*ec.PrivateKey{p.validator}
			mustFail(t, f.run(t, p2, c))
		})
	})

	t.Run("tiny swap still pays each fee at least 1, OP_n amount pushes", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 3, true) // fees 1 + 1, net 1, out = 5000/1001 = 4
		if r.lpFee != 1 || r.validatorFee != 1 || r.out > 16 {
			t.Fatalf("fixture should hit minimum fees and a small push: %+v", r)
		}
		mustPass(t, f.run(t, small, f.swapCall(small, 3, true, r)))
	})
	t.Run("rounded-down fees are rejected", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		bad := f.expectSwap(small, 3, true)
		bad.lpFee, bad.validatorFee = 0, 0
		net := int64(3)
		bad.out = net * small.tokens / (small.bsv + net)
		bad.newBsv, bad.newTokens = small.bsv+net, small.tokens-bad.out
		mustFail(t, f.run(t, small, f.swapCall(small, 3, true, bad)))
	})
	t.Run("fees consume the whole swap", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 2, true) // 1 + 1 in fees, net 0
		mustFail(t, f.run(t, small, f.swapCall(small, 2, true, r)))
	})

	t.Run("continuation without the token prefix", func(t *testing.T) {
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		c.outs[0].script = c.outs[0].script[len(tokenPrefix(r.newTokens)):]
		mustFail(t, f.run(t, p, c))
	})
	t.Run("continuation with the wrong amount in the prefix", func(t *testing.T) {
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		lock := append(tokenPrefix(r.newTokens+1), f.code...)
		c.outs[0].script = append(append(lock, 0x6a), r.pool(p).state()...)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("continuation with the wrong amount in state", func(t *testing.T) {
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		bad := r.pool(p)
		bad.tokens++
		lock := append(tokenPrefix(r.newTokens), f.code...)
		c.outs[0].script = append(append(lock, 0x6a), bad.state()...)
		mustFail(t, f.run(t, p, c))
	})
	t.Run("continuation with a payload after the prefix", func(t *testing.T) {
		// The pool writes no payload; a continuation carrying one is not
		// the script the contract built.
		r := f.expectSwap(p, 20_000, true)
		c := f.swapCall(p, 20_000, true, r)
		lock := append(tokenPrefix(r.newTokens), 0x00, 0x75) // OP_0 OP_DROP
		lock = append(lock, f.code...)
		c.outs[0].script = append(append(lock, 0x6a), r.pool(p).state()...)
		mustFail(t, f.run(t, p, c))
	})

	t.Run("input prefix is never read", func(t *testing.T) {
		// Prefix disagrees with state; the contract trusts state. Overlays
		// must reject such a pool when it is first admitted.
		r := f.expectSwap(p, 20_000, true)
		lying := p
		lying.lock = append(tokenPrefix(999_999_999), f.code...)
		lying.lock = append(append(lying.lock, 0x6a), p.state()...)
		mustPass(t, f.run(t, lying, f.swapCall(p, 20_000, true, r)))
	})
}

func TestSwapZeroFeeRates(t *testing.T) {
	f := newFixture(t, 0, 0, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	for _, bsvIn := range []bool{true, false} {
		r := f.expectSwap(p, 20_000, bsvIn)
		if r.lpFee != 0 || r.validatorFee != 0 {
			t.Fatalf("zero rates should mean zero fees: %+v", r)
		}
		mustPass(t, f.run(t, p, f.swapCall(p, 20_000, bsvIn, r))) // no fee outputs
	}
}

func TestAddLiquidity(t *testing.T) {
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	add := func(bsv, tokens int64) call {
		after := pool{bsv: p.bsv + bsv, tokens: p.tokens + tokens, lp: next(p.lp), validator: next(p.validator)}
		return call{
			method: methodAddLiquidity,
			args: [][]byte{nil, nil,
				pushData(after.lp.PubKey().Compressed()), pushData(after.validator.PubKey().Compressed()),
				pushNum(bsv), pushNum(tokens)},
			outs:     []out{{after.bsv, f.poolScript(after)}},
			signers:  []*ec.PrivateKey{p.lp, p.validator},
			sigSlots: []int{0, 1},
		}
	}

	t.Run("both assets, both keys rotate", func(t *testing.T) { mustPass(t, f.run(t, p, add(10_000, 50_000))) })
	t.Run("one-sided", func(t *testing.T) { mustPass(t, f.run(t, p, add(0, 50_000))) })
	t.Run("not the LP", func(t *testing.T) {
		c := add(10_000, 50_000)
		c.signers[0] = p.validator
		mustFail(t, f.run(t, p, c))
	})
	t.Run("no validator", func(t *testing.T) {
		c := add(10_000, 50_000)
		c.signers[1] = p.lp
		mustFail(t, f.run(t, p, c))
	})
	t.Run("pool output understates the deposit", func(t *testing.T) {
		c := add(10_000, 50_000)
		c.outs[0] = out{p.bsv + 10_000, f.poolScript(pool{tokens: p.tokens + 49_999, lp: next(p.lp), validator: next(p.validator)})}
		mustFail(t, f.run(t, p, c))
	})
}

func TestRemoveLiquidity(t *testing.T) {
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	remove := func(bsv, tokens int64) call {
		after := pool{bsv: p.bsv - bsv, tokens: p.tokens - tokens, lp: next(p.lp), validator: p.validator}
		// Withdrawals go to the key that signed (the current LP key).
		var outs []out
		if after.bsv != 0 || after.tokens != 0 {
			outs = append(outs, out{after.bsv, f.poolScript(after)})
		}
		if bsv > 0 {
			outs = append(outs, out{bsv, p2pkh(pkh(p.lp))})
		}
		if tokens > 0 {
			outs = append(outs, out{1, tokenP2pkh(tokens, pkh(p.lp))})
		}
		return call{
			method:   methodRemoveLiquidity,
			args:     [][]byte{nil, pushData(after.lp.PubKey().Compressed()), pushNum(bsv), pushNum(tokens)},
			outs:     outs,
			signers:  []*ec.PrivateKey{p.lp},
			sigSlots: []int{0},
		}
	}

	t.Run("both assets, LP key rotates", func(t *testing.T) { mustPass(t, f.run(t, p, remove(10_000, 50_000))) })
	t.Run("tokens only", func(t *testing.T) { mustPass(t, f.run(t, p, remove(0, 50_000))) })
	t.Run("not the LP", func(t *testing.T) {
		c := remove(10_000, 50_000)
		c.signers[0] = p.validator
		mustFail(t, f.run(t, p, c))
	})
	t.Run("close: withdraw everything, no continuation", func(t *testing.T) {
		mustPass(t, f.run(t, p, remove(p.bsv, p.tokens)))
	})
	t.Run("close by someone other than the LP", func(t *testing.T) {
		c := remove(p.bsv, p.tokens)
		c.signers[0] = p.validator
		mustFail(t, f.run(t, p, c))
	})
	t.Run("all BSV but not all tokens", func(t *testing.T) {
		mustFail(t, f.run(t, p, remove(p.bsv, 0)))
	})
	t.Run("all tokens but not all BSV", func(t *testing.T) {
		mustFail(t, f.run(t, p, remove(0, p.tokens)))
	})
	t.Run("more than the pool holds", func(t *testing.T) {
		mustFail(t, f.run(t, p, remove(p.bsv+1, p.tokens)))
	})
}

func TestSwapCommission(t *testing.T) {
	f := newFixture(t, 30, 5, 10) // 0.10% commission
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}

	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)
		base := f.swapCall(p, 20_000, bsvIn, r)

		t.Run(name+": commission output after the LP and validator fees", func(t *testing.T) {
			if r.commission != 20 || len(base.outs) != 5 {
				t.Fatalf("expected a 20-unit commission as the fifth output: %+v, %d outputs", r, len(base.outs))
			}
			mustPass(t, f.run(t, p, base))
		})
		t.Run(name+": net excludes the commission", func(t *testing.T) {
			net := int64(20_000) - r.lpFee - r.validatorFee - r.commission
			if bsvIn && r.newBsv != p.bsv+net || !bsvIn && r.newTokens != p.tokens+net {
				t.Fatalf("pool did not take exactly net %d: %+v", net, r)
			}
			// The commission entering the pool instead of being paid out.
			bad := r
			if bsvIn {
				bad.newBsv += r.commission
			} else {
				bad.newTokens += r.commission
			}
			c := f.swapCall(p, 20_000, bsvIn, bad)
			c.outs = c.outs[:4]
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission missing", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.outs = c.outs[:4]
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission to a different pkh than the argument", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			other := pkh(key(t, 50))
			if bsvIn {
				c.outs[4].script = p2pkh(other)
			} else {
				c.outs[4].script = tokenP2pkh(r.commission, other)
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": relay names its own pkh", func(t *testing.T) {
			g := *f
			g.commissionPkh = pkh(key(t, 50))
			mustPass(t, g.run(t, p, g.swapCall(p, 20_000, bsvIn, r)))
		})
		t.Run(name+": commission underpaid", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			if bsvIn {
				c.outs[4].sats--
			} else {
				c.outs[4].script = tokenP2pkh(r.commission-1, f.commissionPkh)
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission in the wrong asset", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			if bsvIn {
				c.outs[4] = out{1, tokenP2pkh(r.commission, f.commissionPkh)}
			} else {
				c.outs[4] = out{r.commission, p2pkh(f.commissionPkh)}
			}
			mustFail(t, f.run(t, p, c))
		})
		t.Run(name+": commission before the validator fee", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.outs[3], c.outs[4] = c.outs[4], c.outs[3]
			mustFail(t, f.run(t, p, c))
		})
	}

	t.Run("tiny swap rounds the commission up to 1", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 4, true) // fees 1 + 1 + 1, net 1
		if r.commission != 1 || r.out == 0 {
			t.Fatalf("expected a commission of 1: %+v", r)
		}
		mustPass(t, f.run(t, small, f.swapCall(small, 4, true, r)))
	})
	t.Run("fees including the commission consume the whole swap", func(t *testing.T) {
		small := pool{bsv: 1_000, tokens: 5_000, lp: p.lp, validator: p.validator}
		r := f.expectSwap(small, 3, true) // 1 + 1 + 1, net 0
		mustFail(t, f.run(t, small, f.swapCall(small, 3, true, r)))
	})
}

func TestSwapZeroCommission(t *testing.T) {
	f := newFixture(t, 30, 5, 0)
	p := pool{bsv: 1_000_000, tokens: 5_000_000, lp: key(t, 10), validator: key(t, 20)}
	for _, bsvIn := range []bool{true, false} {
		name := map[bool]string{true: "bsv in", false: "tokens in"}[bsvIn]
		r := f.expectSwap(p, 20_000, bsvIn)
		base := f.swapCall(p, 20_000, bsvIn, r)
		t.Run(name+": no commission output", func(t *testing.T) {
			if r.commission != 0 || len(base.outs) != 4 {
				t.Fatalf("expected pool, payout and two fee outputs: %+v, %d outputs", r, len(base.outs))
			}
			mustPass(t, f.run(t, p, base))
		})
		t.Run(name+": a zero-value commission output is rejected", func(t *testing.T) {
			c := f.swapCall(p, 20_000, bsvIn, r)
			c.outs = append(c.outs, out{0, p2pkh(f.commissionPkh)})
			mustFail(t, f.run(t, p, c))
		})
	}
}
