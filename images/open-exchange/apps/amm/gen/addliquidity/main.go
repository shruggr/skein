// Command gen writes the AMM validator's own fixture: an AddLiquidity spend of
// the pool that gen/vectors's fixtures end with (remove_liquidity:0),
// signed by the LP and by the validator and run through the go-sdk
// interpreter. The swaps come from src/fixtures/vectors.zig
// unchanged; this adds the one method they do not cover.
//
//	src/fixtures/add_liquidity.zig
//
// Run from the repo root, after gen/vectors's fixtures:
//
//	go run ./gen/addliquidity
//
// The chain continues gen/vectors': the pool after RemoveLiquidity (whose
// validator key carried over from swap_tokens_in, so it is the child of
// swap_bsv_in:0), the LP's token output from the pool deploy
// (pool_deploy:2, 4,950,000 tokens, all deposited: the contract commits to
// the exact outputs, so there is no token change), and the LP's sats change
// from the removal (remove_liquidity:3). The LP key rotates 11 -> 12; the
// validator key rotates to the child of remove_liquidity:0.
//
// Then the funded variant, the shape the marketplace relay carries (amm-p2p
// `amm.liquidity.submit`): the LP's nosend funding transaction (fund:3 -> one
// exact output, the sats added + the miner fee - the token input's sat, and
// change) and an AddLiquidity of the fixture pool (pool_deploy:0) spending
// pool_deploy:2 and that output, with no change output.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	"github.com/bsv-blockchain/go-sdk/transaction/template/p2pkh"
	"github.com/icellan/runar/compilers/go/compiler"
	runar "github.com/icellan/runar/packages/runar-go"
)

// Must match src/pool.zig and gen/vectors.
const validatorInvoicePrefix = "1-amm pool-"

const (
	methodAddLiquidity = 1
	lpFeeBps           = 30
	validatorFeeBps    = 5
	commissionBps      = 10 // gen/vectors: the fixture pool's commission
	addBsv             = 5_000
	addBsvFunded       = 20_000
	minerFee           = 500
	fundingFee         = 50
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func key(n byte) *ec.PrivateKey {
	k, _ := ec.PrivateKeyFromBytes(bytes.Repeat([]byte{n}, 32))
	return k
}

var (
	identity = key(0x7f)
	lpKey    = key(10) // owns pool_deploy:2 and remove_liquidity:3
	lpNow    = key(11) // the pool's LP key after RemoveLiquidity
	lpNext   = key(12)
)

func validatorKey(txid *chainhash.Hash, vout uint32) *ec.PrivateKey {
	anyone, _ := ec.PrivateKeyFromBytes(append(make([]byte, 31), 1))
	k, err := identity.DeriveChild(anyone.PubKey(), fmt.Sprintf("%s%s_%d", validatorInvoicePrefix, txid.String(), vout))
	must(err)
	return k
}

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

func pushNum(n int64) []byte {
	switch {
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

func p2pkhScript(k *ec.PrivateKey) []byte {
	return append(append([]byte{0x76, 0xa9, 0x14}, k.PubKey().Hash()...), 0x88, 0xac)
}

type pool struct {
	tokens        int64
	lp, validator *ec.PublicKey
}

type gen struct {
	sa      runar.RunarArtifact
	assetID []byte
	code    []byte
}

func (g *gen) tokenPrefix(amount int64) []byte {
	p := append([]byte{0x20}, g.assetID...)
	p = append(p, pushNum(amount)...)
	return append(p, 0x6d)
}

func (p pool) state() []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, uint64(p.tokens))
	b = append(b, p.lp.Compressed()...)
	b = append(b, p.validator.Compressed()...)
	return append(b, identity.PubKey().Compressed()...)
}

func (g *gen) poolScript(p pool) []byte {
	s := append(g.tokenPrefix(p.tokens), g.code...)
	s = append(s, 0x6a)
	return append(s, p.state()...)
}

// codeFor is the compiled code with the readonly args spliced in, as the
// Rúnar SDK builds it (no prefix, no state): gen/vectors, verbatim.
func (g *gen) codeFor() []byte {
	p := pool{tokens: 1000, lp: key(1).PubKey(), validator: key(2).PubKey()}
	c := runar.NewRunarContract(&g.sa, []interface{}{
		p.tokens,
		hex.EncodeToString(p.lp.Compressed()),
		hex.EncodeToString(p.validator.Compressed()),
		hex.EncodeToString(identity.PubKey().Compressed()),
		hex.EncodeToString(g.assetID),
		int64(lpFeeBps),
		int64(validatorFeeBps),
		int64(commissionBps),
	})
	full, _ := hex.DecodeString(c.GetLockingScript())
	tail := append([]byte{0x6a}, p.state()...)
	if !bytes.HasSuffix(full, tail) {
		panic("SDK state layout differs from pool.state()")
	}
	return full[:len(full)-len(tail)]
}

func separatorScriptCode(lock []byte) []byte {
	off := 1 + 32
	switch op := lock[off]; {
	case op >= 0x51 && op <= 0x60:
		off++
	default:
		off += 1 + int(op)
	}
	off++
	if lock[off] != 0x61 || lock[off+1] != 0xab {
		panic("separator not where expected")
	}
	return lock[off+2:]
}

// vectors reads gen/vectorserated vectors.zig: `pub const name = "hex";`.
func vectors(path string) map[string]string {
	b, err := os.ReadFile(path)
	must(err)
	out := map[string]string{}
	for _, m := range regexp.MustCompile(`pub const (\w+) = "([0-9a-f]+)";`).FindAllSubmatch(b, -1) {
		out[string(m[1])] = string(m[2])
	}
	return out
}

func txOf(v map[string]string, name string) *transaction.Transaction {
	h, ok := v[name]
	if !ok {
		panic("no vector " + name)
	}
	tx, err := transaction.NewTransactionFromHex(h)
	must(err)
	return tx
}

type spent struct {
	tx   *transaction.Transaction
	vout uint32
}

// addSpend is an AddLiquidity of pool:0 holding bsv: the LP's other inputs
// (each the LP's key(10) P2PKH, plain or under a token prefix), the
// continuation `next`, signed by the pool's current LP and validator keys.
type addSpend struct {
	pool              *transaction.Transaction
	bsv               int64
	next              pool
	lp, validator     *ec.PrivateKey
	inputs            []spent
	addBsv, addTokens int64
	change            int64
}

// addLiquidity builds, signs and runs (go-sdk interpreter) the AddLiquidity.
func (g *gen) addLiquidity(s addSpend) *transaction.Transaction {
	tx := transaction.NewTransaction()
	for _, i := range append([]spent{{s.pool, 0}}, s.inputs...) {
		ti := &transaction.TransactionInput{SourceTXID: i.tx.TxID(), SourceTxOutIndex: i.vout, SequenceNumber: 0xffffffff}
		ti.SetSourceTxOutput(i.tx.Outputs[i.vout])
		tx.AddInput(ti)
	}
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(s.bsv + s.addBsv), LockingScript: script.NewFromBytes(g.poolScript(s.next))})
	if s.change > 0 {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(s.change), LockingScript: script.NewFromBytes(p2pkhScript(lpKey))})
	}

	// The pool input: args, then Rúnar's change and preimage, the method last.
	prev := tx.Inputs[0].SourceTxOutput()
	cp := tx.ShallowClone()
	cp.Inputs[0].SetSourceTxOutput(&transaction.TransactionOutput{Satoshis: prev.Satoshis, LockingScript: script.NewFromBytes(separatorScriptCode(prev.LockingScript.Bytes()))})
	pre, err := cp.CalcInputPreimage(0, sighash.AllForkID)
	must(err)
	h1 := sha256.Sum256(pre)
	digest := sha256.Sum256(h1[:])
	sigOf := func(k *ec.PrivateKey) []byte {
		sig, err := k.Sign(digest[:])
		must(err)
		return pushData(append(sig.Serialize(), 0x41))
	}
	args := [][]byte{sigOf(s.lp), sigOf(s.validator), pushData(s.next.lp.Compressed()), pushData(s.next.validator.Compressed()), pushNum(s.addBsv), pushNum(s.addTokens)}
	var u []byte
	u = append(u, pushData(g.code)...)
	for _, a := range args {
		u = append(u, a...)
	}
	u = append(u, pushData(lpKey.PubKey().Hash())...)
	u = append(u, pushNum(s.change)...)
	u = append(u, pushData(pre)...)
	u = append(u, pushNum(methodAddLiquidity)...)
	tx.Inputs[0].UnlockingScript = script.NewFromBytes(u)
	must(interpreter.NewEngine().Execute(
		interpreter.WithTx(tx, 0, prev),
		interpreter.WithForkID(),
		interpreter.WithAfterGenesis(),
		interpreter.WithAfterChronicle(),
	))
	for idx := 1; idx < len(tx.Inputs); idx++ {
		un, err := p2pkh.Unlock(lpKey, nil)
		must(err)
		sig, err := un.Sign(tx, uint32(idx))
		must(err)
		tx.Inputs[idx].UnlockingScript = sig
	}
	return tx
}

func main() {
	src := flag.String("pool", "pool/Pool.runar.go", "the Pool contract")
	topicVectors := flag.String("vectors", "src/fixtures/vectors.zig", "the pool fixtures (gen/vectors)")
	outDir := flag.String("out", "src/fixtures", "where to write the fixture")
	flag.Parse()

	art, err := compiler.CompileFromSource(*src)
	must(err)
	js, err := compiler.ArtifactToJSON(art)
	must(err)
	g := &gen{}
	must(json.Unmarshal(js, &g.sa))

	v := vectors(*topicVectors)
	deploy, poolDeploy, swap1, remove := txOf(v, "token_deploy"), txOf(v, "pool_deploy"), txOf(v, "swap_bsv_in"), txOf(v, "remove_liquidity")
	g.assetID = deploy.TxID().CloneBytes()
	g.code = g.codeFor()

	// The pool as RemoveLiquidity left it; check we rebuild its script exactly.
	lock := remove.Outputs[0].LockingScript.Bytes()
	tokens := int64(binary.LittleEndian.Uint64(lock[len(lock)-(8+33*3):]))
	cur := pool{tokens: tokens, lp: lpNow.PubKey(), validator: validatorKey(swap1.TxID(), 0).PubKey()}
	if !bytes.Equal(g.poolScript(cur), lock) {
		panic("the pool after remove_liquidity does not rebuild: fixtures out of date?")
	}
	curValidator := validatorKey(swap1.TxID(), 0)
	bsvReserve := int64(remove.Outputs[0].Satoshis)

	tokenIn, sats := poolDeploy.Outputs[2], remove.Outputs[3]
	addTokens := int64(4_950_000)
	if !bytes.Equal(tokenIn.LockingScript.Bytes(), append(g.tokenPrefix(addTokens), p2pkhScript(lpKey)...)) {
		panic("pool_deploy:2 is not the LP's 4,950,000 tokens")
	}
	next := pool{tokens: tokens + addTokens, lp: lpNext.PubKey(), validator: validatorKey(remove.TxID(), 0).PubKey()}
	change := int64(sats.Satoshis) + int64(tokenIn.Satoshis) - addBsv - minerFee
	tx := g.addLiquidity(addSpend{
		pool: remove, bsv: bsvReserve, next: next, lp: lpNow, validator: curValidator,
		inputs: []spent{{poolDeploy, 2}, {remove, 3}}, addBsv: addBsv, addTokens: addTokens, change: change,
	})

	// The funded variant (docs/notes.md 2026-10-02, "Swap funding and
	// signing", as the marketplace relay carries an AddLiquidity: amm-p2p
	// `amm.liquidity.submit`): the LP's nosend funding transaction spends
	// fund:3 (100,000 sats to the LP) and pays one exact output, the sats
	// added plus the miner fee less the token input's sat, and change; the
	// AddLiquidity spends the fixture pool deploy's pool (pool_deploy:0, the
	// pool's first spend: the validator's key is the child of token_deploy:0),
	// the LP's 4,950,000 tokens (pool_deploy:2) and that output, and writes
	// the pool only: no change (_changeAmount = 0). The LP key rotates
	// 10 -> 12; the validator key to the child of pool_deploy:0.
	fund := txOf(v, "fund")
	p0Lock := poolDeploy.Outputs[0].LockingScript.Bytes()
	p0Tokens := int64(binary.LittleEndian.Uint64(p0Lock[len(p0Lock)-(8+33*3):]))
	p0 := pool{tokens: p0Tokens, lp: lpKey.PubKey(), validator: validatorKey(deploy.TxID(), 0).PubKey()}
	if !bytes.Equal(g.poolScript(p0), p0Lock) {
		panic("the fixture pool does not rebuild: fixtures out of date?")
	}
	if !bytes.Equal(fund.Outputs[3].LockingScript.Bytes(), p2pkhScript(lpKey)) {
		panic("fund:3 is not the LP's")
	}
	exact := int64(addBsvFunded) + minerFee - int64(tokenIn.Satoshis)
	funding := transaction.NewTransaction()
	fin := &transaction.TransactionInput{SourceTXID: fund.TxID(), SourceTxOutIndex: 3, SequenceNumber: 0xffffffff}
	fin.SetSourceTxOutput(fund.Outputs[3])
	funding.AddInput(fin)
	funding.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(exact), LockingScript: script.NewFromBytes(p2pkhScript(lpKey))})
	funding.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(int64(fund.Outputs[3].Satoshis) - exact - fundingFee), LockingScript: script.NewFromBytes(p2pkhScript(lpKey))})
	un, err := p2pkh.Unlock(lpKey, nil)
	must(err)
	fs, err := un.Sign(funding, 0)
	must(err)
	funding.Inputs[0].UnlockingScript = fs
	next5 := pool{tokens: p0Tokens + addTokens, lp: lpNext.PubKey(), validator: validatorKey(poolDeploy.TxID(), 0).PubKey()}
	funded := g.addLiquidity(addSpend{
		pool: poolDeploy, bsv: int64(poolDeploy.Outputs[0].Satoshis), next: next5, lp: lpKey, validator: validatorKey(deploy.TxID(), 0),
		inputs: []spent{{poolDeploy, 2}, {funding, 0}}, addBsv: addBsvFunded, addTokens: addTokens, change: 0,
	})
	if got := int64(poolDeploy.Outputs[0].Satoshis) + int64(tokenIn.Satoshis) + exact - int64(funded.Outputs[0].Satoshis); got != minerFee || len(funded.Outputs) != 1 {
		panic("the funded AddLiquidity's fee is not the miner fee, or it has change")
	}

	var b bytes.Buffer
	b.WriteString("//! Generated by `go run ./gen/addliquidity` from pool/Pool.runar.go and\n")
	b.WriteString("//! src/fixtures/vectors.zig: do not edit. An AddLiquidity of\n")
	b.WriteString("//! remove_liquidity:0, signed by the LP and the validator, checked by the go-sdk interpreter.\n\n")
	fmt.Fprintf(&b, "pub const add_liquidity = \"%s\";\n", tx.Hex())
	fmt.Fprintf(&b, "pub const add_bsv = %d;\npub const add_tokens = %d;\n", addBsv, addTokens)
	fmt.Fprintf(&b, "pub const pool4 = .{ .bsv = %d, .tokens = %d, .validator = \"%s\" };\n", bsvReserve+addBsv, next.tokens, hex.EncodeToString(next.validator.Compressed()))
	b.WriteString("\n// The funded variant: the LP's nosend funding transaction (fund:3 -> one exact\n")
	b.WriteString("// output + change), and an AddLiquidity of pool_deploy:0 spending pool_deploy:2 and\n")
	b.WriteString("// that output, the pool its only output (no change), the LP key rotated to key(12).\n")
	fmt.Fprintf(&b, "pub const add_funding = \"%s\";\n", funding.Hex())
	fmt.Fprintf(&b, "pub const add_liquidity_funded = \"%s\";\n", funded.Hex())
	fmt.Fprintf(&b, "pub const add_funded_bsv = %d;\npub const add_funded_fee = %d;\n", addBsvFunded, minerFee)
	fmt.Fprintf(&b, "pub const pool5 = .{ .bsv = %d, .tokens = %d, .lp = \"%s\", .validator = \"%s\" };\n", int64(poolDeploy.Outputs[0].Satoshis)+addBsvFunded, next5.tokens, hex.EncodeToString(next5.lp.Compressed()), hex.EncodeToString(next5.validator.Compressed()))
	must(os.WriteFile(filepath.Join(*outDir, "add_liquidity.zig"), b.Bytes(), 0o644))
	fmt.Println("wrote", *outDir)
}
