// Command gen writes the AMM topic's fixtures from the Pool contract:
//
//	src/fixtures/pool_artifact.zig  the compiled Pool template (code with its
//	                                constructor-arg placeholders) and the slots
//	src/fixtures/vectors.zig        a token deploy, a pool deploy, two swaps and
//	                                a liquidity removal, built like
//	                                pool/pool_test.go and each pool spend run
//	                                through the go-sdk interpreter; and legacy
//	                                BRC-161 (JSON) token transactions with
//	                                their migration to BRC-162 (legacyVectors)
//
// Run from the repo root after changing pool/Pool.runar.go:
//
//	go run ./gen/vectors
//
// The validator keys follow the topic's BRC-42 convention (decided 2026-09-29)
// (src/pool.zig, `validator_protocol`): they are derived here on the
// validator's side with go-sdk's BRC-42 (ec.PrivateKey.DeriveChild) and
// checked in Zig on the public side with bsvz, so the vectors also
// cross-check the two derivations.
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
	"strings"

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

// Must match src/pool.zig (decided 2026-09-29): BRC-43 security level 1, protocol
// "amm pool".
const validatorInvoicePrefix = "1-amm pool-"

func keyID(txid *chainhash.Hash, vout uint32) string {
	return fmt.Sprintf("%s_%d", txid.String(), vout)
}

const (
	methodSwap            = 0
	methodRemoveLiquidity = 2
	lpFeeBps              = 30
	validatorFeeBps       = 5
	commissionBps         = 10 // the relay's commission (0.10%)
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
	identity = key(0x7f) // the validator's root identity key
	lpKey    = key(10)
	lpNext   = key(11)
	taker    = key(30)
	// relay is the fixture relay's payout key: the swaps pay their
	// commission to its P2PKH (Swap's commissionPkh, vectors' commission_pkh).
	relay = key(50)
)

// validatorKey is the validator's signing key for a pool created by a
// transaction whose first token input spends txid:vout.
func validatorKey(txid *chainhash.Hash, vout uint32) *ec.PrivateKey {
	// BRC-42 with the anyone counterparty (the public key of private key 1),
	// as go-sdk's wallet.KeyDeriver.DerivePrivateKey does it.
	anyone, _ := ec.PrivateKeyFromBytes(append(make([]byte, 31), 1))
	k, err := identity.DeriveChild(anyone.PubKey(), validatorInvoicePrefix+keyID(txid, vout))
	must(err)
	return k
}

// --- script building (mirrors pool/pool_test.go) ---

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

func pushBool(v bool) []byte {
	if v {
		return []byte{0x51}
	}
	return []byte{0x00}
}

func p2pkhScript(k *ec.PrivateKey) []byte {
	return append(append([]byte{0x76, 0xa9, 0x14}, k.PubKey().Hash()...), 0x88, 0xac)
}

type pool struct {
	bsv, tokens   int64
	lp, validator *ec.PrivateKey
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

func (g *gen) tokenP2pkh(amount int64, k *ec.PrivateKey) []byte {
	return append(g.tokenPrefix(amount), p2pkhScript(k)...)
}

func (p pool) state() []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, uint64(p.tokens))
	b = append(b, p.lp.PubKey().Compressed()...)
	b = append(b, p.validator.PubKey().Compressed()...)
	return append(b, identity.PubKey().Compressed()...)
}

func (g *gen) poolScript(p pool) []byte {
	s := append(g.tokenPrefix(p.tokens), g.code...)
	s = append(s, 0x6a)
	return append(s, p.state()...)
}

// codeFor is the compiled code with the readonly args spliced in, as the
// Rúnar SDK builds it (no prefix, no state).
func (g *gen) codeFor(assetID []byte) []byte {
	p := pool{tokens: 1000, lp: key(1), validator: key(2)}
	c := runar.NewRunarContract(&g.sa, []interface{}{
		p.tokens,
		hex.EncodeToString(p.lp.PubKey().Compressed()),
		hex.EncodeToString(p.validator.PubKey().Compressed()),
		hex.EncodeToString(identity.PubKey().Compressed()),
		hex.EncodeToString(assetID),
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

// --- transactions ---

type out struct {
	sats   int64
	script []byte
}

type in struct {
	src  *transaction.Transaction
	vout uint32
	key  *ec.PrivateKey // P2PKH signer; nil for the pool input
}

func build(ins []in, outs []out) *transaction.Transaction {
	tx := transaction.NewTransaction()
	for _, i := range ins {
		ti := &transaction.TransactionInput{SourceTXID: i.src.TxID(), SourceTxOutIndex: i.vout, SequenceNumber: 0xffffffff}
		ti.SetSourceTxOutput(i.src.Outputs[i.vout])
		tx.AddInput(ti)
	}
	for _, o := range outs {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(o.sats), LockingScript: script.NewFromBytes(o.script)})
	}
	return tx
}

func signP2pkh(tx *transaction.Transaction, ins []in) {
	for idx, i := range ins {
		if i.key == nil {
			continue
		}
		u, err := p2pkh.Unlock(i.key, nil)
		must(err)
		s, err := u.Sign(tx, uint32(idx))
		must(err)
		tx.Inputs[idx].UnlockingScript = s
	}
}

// separatorScriptCode is the pool lock after its OP_CODESEPARATOR.
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

// unlockPool writes the pool input's (input 0) unlocking script: the method's
// args with sigs by signers at sigSlots, then Rúnar's change and preimage,
// and runs it through the interpreter.
func (g *gen) unlockPool(tx *transaction.Transaction, method int, args [][]byte, signers []*ec.PrivateKey, sigSlots []int, changeKey *ec.PrivateKey, change int64) {
	prev := tx.Inputs[0].SourceTxOutput()
	cp := tx.ShallowClone()
	cp.Inputs[0].SetSourceTxOutput(&transaction.TransactionOutput{Satoshis: prev.Satoshis, LockingScript: script.NewFromBytes(separatorScriptCode(prev.LockingScript.Bytes()))})
	pre, err := cp.CalcInputPreimage(0, sighash.AllForkID)
	must(err)
	h1 := sha256.Sum256(pre)
	digest := sha256.Sum256(h1[:])
	args = append([][]byte{}, args...)
	for i, k := range signers {
		sig, err := k.Sign(digest[:])
		must(err)
		args[sigSlots[i]] = pushData(append(sig.Serialize(), 0x41))
	}
	var u []byte
	u = append(u, pushData(g.code)...)
	for _, a := range args {
		u = append(u, a...)
	}
	u = append(u, pushData(changeKey.PubKey().Hash())...)
	u = append(u, pushNum(change)...)
	u = append(u, pushData(pre)...)
	u = append(u, pushNum(int64(method))...)
	tx.Inputs[0].UnlockingScript = script.NewFromBytes(u)
	must(interpreter.NewEngine().Execute(
		interpreter.WithTx(tx, 0, prev),
		interpreter.WithForkID(),
		interpreter.WithAfterGenesis(),
		interpreter.WithAfterChronicle(),
	))
}

func ceilFee(amount, bps int64) int64 { return (amount*bps + 9999) / 10000 }

func main() {
	src := flag.String("pool", "pool/Pool.runar.go", "the Pool contract")
	outDir := flag.String("out", "src/fixtures", "where to write the fixtures")
	flag.Parse()

	art, err := compiler.CompileFromSource(*src)
	must(err)
	js, err := compiler.ArtifactToJSON(art)
	must(err)
	g := &gen{}
	must(json.Unmarshal(js, &g.sa))
	if len(g.sa.CodeSepIndexSlots) != 0 {
		panic("codeSepIndex slots are not supported by the topic's template matcher")
	}
	writeArtifact(filepath.Join(*outDir, "pool_artifact.zig"), &g.sa, *src)

	// A funding transaction (its own input is a stand-in) paying the LP and the taker.
	fundIn := &transaction.TransactionInput{SourceTXID: mustHash(strings.Repeat("11", 32)), SourceTxOutIndex: 0, SequenceNumber: 0xffffffff, UnlockingScript: script.NewFromBytes([]byte{0x51})}
	fund := transaction.NewTransaction()
	fund.AddInput(fundIn)
	for _, o := range []out{{2_000_000, p2pkhScript(lpKey)}, {500_000, p2pkhScript(taker)}, {100_000, p2pkhScript(taker)}, {100_000, p2pkhScript(lpKey)}} {
		fund.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(o.sats), LockingScript: script.NewFromBytes(o.script)})
	}

	// Token deploy: fixed supply of 10,000,000 to the LP.
	deployIn := &transaction.TransactionInput{SourceTXID: mustHash(strings.Repeat("22", 32)), SourceTxOutIndex: 0, SequenceNumber: 0xffffffff, UnlockingScript: script.NewFromBytes([]byte{0x51})}
	deploy := transaction.NewTransaction()
	deploy.AddInput(deployIn)
	deployLock := append(append([]byte{0x00}, pushNum(10_000_000)...), 0x6d)
	deployLock = append(deployLock, p2pkhScript(lpKey)...)
	deploy.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: script.NewFromBytes(deployLock)})
	g.assetID = deploy.TxID().CloneBytes() // internal byte order
	g.code = g.codeFor(g.assetID)

	// Pool deploy: the LP deposits 5,000,000 tokens and 1,000,000 sats; 50,000
	// tokens go to the taker (for the tokens-in swap), the rest back to the LP.
	// Validator key ID: the first token input, deploy:0.
	p0 := pool{bsv: 1_000_000, tokens: 5_000_000, lp: lpKey, validator: validatorKey(deploy.TxID(), 0)}
	poolDeployIns := []in{{deploy, 0, lpKey}, {fund, 0, lpKey}}
	poolDeploy := build(poolDeployIns, []out{
		{p0.bsv, g.poolScript(p0)},
		{1, g.tokenP2pkh(50_000, taker)},
		{1, g.tokenP2pkh(4_950_000, lpKey)},
		{2_000_000 - 1_000_000 - 2 - 500, p2pkhScript(lpKey)},
	})
	signP2pkh(poolDeploy, poolDeployIns)

	// Swap 1: 20,000 sats in for tokens. Validator key ID: the pool input.
	amountIn := int64(20_000)
	lpFee, valFee, comm := ceilFee(amountIn, lpFeeBps), ceilFee(amountIn, validatorFeeBps), ceilFee(amountIn, commissionBps)
	net := amountIn - lpFee - valFee - comm
	tokOut := net * p0.tokens / (p0.bsv + net)
	p1 := pool{bsv: p0.bsv + net, tokens: p0.tokens - tokOut, lp: p0.lp, validator: validatorKey(poolDeploy.TxID(), 0)}
	change1 := int64(500_000) - amountIn - 500
	swap1Ins := []in{{poolDeploy, 0, nil}, {fund, 1, taker}}
	swap1 := build(swap1Ins, []out{
		{p1.bsv, g.poolScript(p1)},
		{1, g.tokenP2pkh(tokOut, taker)},
		{lpFee, p2pkhScript(p0.lp)},
		{valFee, p2pkhScript(p0.validator)},
		{comm, p2pkhScript(relay)},
		{change1, p2pkhScript(taker)},
	})
	g.unlockPool(swap1, methodSwap, [][]byte{nil, pushData(p1.validator.PubKey().Compressed()), pushNum(amountIn), pushBool(true), pushData(taker.PubKey().Hash()),
		pushData(relay.PubKey().Hash())}, []*ec.PrivateKey{p0.validator}, []int{0}, taker, change1)
	signP2pkh(swap1, swap1Ins)

	// Swap 2: the taker's 50,000 tokens in for sats.
	amountIn2 := int64(50_000)
	lpFee2, valFee2, comm2 := ceilFee(amountIn2, lpFeeBps), ceilFee(amountIn2, validatorFeeBps), ceilFee(amountIn2, commissionBps)
	net2 := amountIn2 - lpFee2 - valFee2 - comm2
	bsvOut := net2 * p1.bsv / (p1.tokens + net2)
	p2 := pool{bsv: p1.bsv - bsvOut, tokens: p1.tokens + net2, lp: p1.lp, validator: validatorKey(swap1.TxID(), 0)}
	change2 := int64(100_000) + 1 - 3 - 500 // funding + token input's sat - three 1-sat token fee outputs - miner fee
	swap2Ins := []in{{swap1, 0, nil}, {poolDeploy, 1, taker}, {fund, 2, taker}}
	swap2 := build(swap2Ins, []out{
		{p2.bsv, g.poolScript(p2)},
		{bsvOut, p2pkhScript(taker)},
		{1, g.tokenP2pkh(lpFee2, p1.lp)},
		{1, g.tokenP2pkh(valFee2, p1.validator)},
		{1, g.tokenP2pkh(comm2, relay)},
		{change2, p2pkhScript(taker)},
	})
	g.unlockPool(swap2, methodSwap, [][]byte{nil, pushData(p2.validator.PubKey().Compressed()), pushNum(amountIn2), pushBool(false), pushData(taker.PubKey().Hash()),
		pushData(relay.PubKey().Hash())}, []*ec.PrivateKey{p1.validator}, []int{0}, taker, change2)
	signP2pkh(swap2, swap2Ins)

	// RemoveLiquidity: the LP withdraws 10,000 sats and 100,000 tokens; the
	// validator does not sign, so its key carries over unchanged.
	p3 := pool{bsv: p2.bsv - 10_000, tokens: p2.tokens - 100_000, lp: lpNext, validator: p2.validator}
	change3 := int64(100_000) - 1 - 500
	removeIns := []in{{swap2, 0, nil}, {fund, 3, lpKey}}
	remove := build(removeIns, []out{
		{p3.bsv, g.poolScript(p3)},
		{10_000, p2pkhScript(p2.lp)},
		{1, g.tokenP2pkh(100_000, p2.lp)},
		{change3, p2pkhScript(lpKey)},
	})
	g.unlockPool(remove, methodRemoveLiquidity, [][]byte{nil, pushData(lpNext.PubKey().Compressed()), pushNum(10_000), pushNum(100_000)},
		[]*ec.PrivateKey{p2.lp}, []int{0}, lpKey, change3)
	signP2pkh(remove, removeIns)

	var b strings.Builder
	b.WriteString("//! Generated by `go run ./gen/vectors` from pool/Pool.runar.go: do not edit.\n")
	b.WriteString("//! A token deploy, a pool deploy, a sats-in swap, a tokens-in swap and a\n")
	b.WriteString("//! liquidity removal, each pool spend checked by the go-sdk interpreter;\n")
	b.WriteString("//! then legacy BRC-161 token transactions (`legacy_*`, gen/main.go's\n")
	b.WriteString("//! legacyVectors for what each one is).\n\n")
	for _, t := range append([]named{{"fund", fund}, {"token_deploy", deploy}, {"pool_deploy", poolDeploy}, {"swap_bsv_in", swap1}, {"swap_tokens_in", swap2}, {"remove_liquidity", remove}}, legacyVectors()...) {
		fmt.Fprintf(&b, "pub const %s = \"%s\";\n", t.name, t.tx.Hex())
	}
	fmt.Fprintf(&b, "\npub const identity = \"%s\";\n", hex.EncodeToString(identity.PubKey().Compressed()))
	fmt.Fprintf(&b, "pub const lp_fee_bps = %d;\npub const validator_fee_bps = %d;\npub const commission_bps = %d;\n", lpFeeBps, validatorFeeBps, commissionBps)
	fmt.Fprintf(&b, "pub const commission_pkh = \"%s\";\n", hex.EncodeToString(relay.PubKey().Hash()))
	for _, p := range []struct {
		name string
		p    pool
	}{{"pool0", p0}, {"pool1", p1}, {"pool2", p2}, {"pool3", p3}} {
		fmt.Fprintf(&b, "pub const %s = .{ .bsv = %d, .tokens = %d, .validator = \"%s\" };\n", p.name, p.p.bsv, p.p.tokens, hex.EncodeToString(p.p.validator.PubKey().Compressed()))
	}
	fmt.Fprintf(&b, "pub const swap_bsv_in_tokens_out = %d;\n", tokOut)
	must(os.WriteFile(filepath.Join(*outDir, "vectors.zig"), []byte(b.String()), 0o644))
	fmt.Println("wrote", *outDir)
}

type named struct {
	name string
	tx   *transaction.Transaction
}

// --- legacy BRC-161 (JSON) tokens and their migration to BRC-162 ---

// inscribe wraps a bsv-20 JSON body in a 1Sat ord envelope (content type
// application/bsv-20) and puts it before the lock, as 1sat-stack's
// inscription.Lock writes it, or after it (lockFirst: the envelope as the
// script's suffix, which 1sat-stack's decoder also finds).
func inscribe(body string, lock []byte, lockFirst bool) []byte {
	env := []byte{0x00, 0x63, 0x03, 'o', 'r', 'd', 0x51}
	env = append(env, pushData([]byte("application/bsv-20"))...)
	env = append(env, 0x00)
	env = append(env, pushData([]byte(body))...)
	env = append(env, 0x68)
	if lockFirst {
		return append(append([]byte{}, lock...), env...)
	}
	return append(env, lock...)
}

// tokenString is a token id's string form, `<txid>_<vout>` (BRC-161).
func tokenString(txid *chainhash.Hash, vout uint32) string {
	return fmt.Sprintf("%s_%d", txid.String(), vout)
}

// binaryToken is a BRC-162 value output of the token deployed at txid:vout,
// with the canonical id: 32 bytes when vout is 0, 36 (txid ‖ LE vout) when not.
func binaryToken(txid *chainhash.Hash, vout uint32, amount int64, k *ec.PrivateKey) []byte {
	var p []byte
	if vout == 0 {
		p = append([]byte{0x20}, txid.CloneBytes()...)
	} else {
		v := make([]byte, 4)
		binary.LittleEndian.PutUint32(v, vout)
		p = append(append([]byte{0x24}, txid.CloneBytes()...), v...)
	}
	p = append(p, pushNum(amount)...)
	p = append(p, 0x6d)
	return append(p, p2pkhScript(k)...)
}

func jsonOp(op, id string, amt int64) string {
	switch op {
	case "auth":
		return fmt.Sprintf(`{"p":"bsv-20","op":"auth","id":"%s"}`, id)
	default:
		return fmt.Sprintf(`{"p":"bsv-20","op":"%s","id":"%s","amt":"%d"}`, op, id, amt)
	}
}

// standIn is a deploy's funding input, a stand-in (not a real outpoint).
func standIn(b byte) *transaction.TransactionInput {
	return &transaction.TransactionInput{SourceTXID: mustHash(strings.Repeat(fmt.Sprintf("%02x", b), 32)), SourceTxOutIndex: 0, SequenceNumber: 0xffffffff, UnlockingScript: script.NewFromBytes([]byte{0x51})}
}

// legacyVectors builds BRC-161 tokens and spends of them:
//
//	legacy_fund          a funding transaction (stand-in input) paying the holder
//	legacy_deploy0       deploy+mint 1,000,000 at output 0 (token L0 = <txid>_0)
//	legacy_deploy1       a plain output 0, deploy+mint 500,000 at output 1 (L1 = <txid>_1)
//	legacy_transfer      L0: deploy0:0 -> JSON transfer 600,000 (envelope before the
//	                     lock) + 400,000 (envelope after the lock)
//	legacy_migrate0      L0: transfer:0 (JSON) -> binary 350,000 + 250,000, 32-byte id
//	legacy_migrate1      L1: deploy1:1 (JSON) -> binary 500,000, 36-byte id
//	legacy_mixed         L0: transfer:1 (JSON) -> JSON transfer 100,000 + binary 300,000
//	legacy_binary_json   L0: migrate0:0 (binary 350,000) -> binary 200,000 + JSON
//	                     transfer 150,000 (refused: one-way migration)
//	legacy_auth_deploy   deploy+auth at output 0 (LA = <txid>_0)
//	legacy_mint          LA: auth_deploy:0 -> JSON mint 1,000 + JSON auth
//	legacy_unfunded      L0: mixed:0 (JSON 100,000) -> JSON transfer 60,000 + 50,000
func legacyVectors() []named {
	holder, recipient, issuer := key(40), key(41), key(42)
	fund := transaction.NewTransaction()
	fund.AddInput(standIn(0x33))
	for i := 0; i < 8; i++ {
		fund.AddOutput(&transaction.TransactionOutput{Satoshis: 10_000, LockingScript: script.NewFromBytes(p2pkhScript(holder))})
	}
	// change: the funding input plus the token input's sat, less k 1-sat token
	// outputs and a 200-sat fee.
	change := func(k int64) out { return out{10_000 + 1 - k - 200, p2pkhScript(holder)} }

	deploy0 := transaction.NewTransaction()
	deploy0.AddInput(standIn(0x44))
	deploy0.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: script.NewFromBytes(inscribe(`{"p":"bsv-20","op":"deploy+mint","amt":"1000000","sym":"LEG","dec":"2"}`, p2pkhScript(holder), false))})
	l0 := deploy0.TxID()

	deploy1 := transaction.NewTransaction()
	deploy1.AddInput(standIn(0x45))
	deploy1.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: script.NewFromBytes(p2pkhScript(holder))})
	deploy1.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: script.NewFromBytes(inscribe(`{"p":"bsv-20","op":"deploy+mint","amt":"500000","sym":"LEG1","icon":"_0"}`, p2pkhScript(holder), false))})
	l1 := deploy1.TxID()

	spend := func(ins []in, outs []out) *transaction.Transaction {
		tx := build(ins, outs)
		signP2pkh(tx, ins)
		return tx
	}
	id0 := tokenString(l0, 0)
	transfer := spend([]in{{deploy0, 0, holder}, {fund, 0, holder}}, []out{
		{1, inscribe(jsonOp("transfer", id0, 600_000), p2pkhScript(holder), false)},
		{1, inscribe(jsonOp("transfer", id0, 400_000), p2pkhScript(recipient), true)},
		change(2),
	})
	migrate0 := spend([]in{{transfer, 0, holder}, {fund, 1, holder}}, []out{
		{1, binaryToken(l0, 0, 350_000, holder)},
		{1, binaryToken(l0, 0, 250_000, recipient)},
		change(2),
	})
	migrate1 := spend([]in{{deploy1, 1, holder}, {fund, 2, holder}}, []out{
		{1, binaryToken(l1, 1, 500_000, holder)},
		change(1),
	})
	mixed := spend([]in{{transfer, 1, recipient}, {fund, 3, holder}}, []out{
		{1, inscribe(jsonOp("transfer", id0, 100_000), p2pkhScript(recipient), false)},
		{1, binaryToken(l0, 0, 300_000, holder)},
		change(2),
	})
	binaryJSON := spend([]in{{migrate0, 0, holder}, {fund, 4, holder}}, []out{
		{1, binaryToken(l0, 0, 200_000, holder)},
		{1, inscribe(jsonOp("transfer", id0, 150_000), p2pkhScript(recipient), false)},
		change(2),
	})

	authDeploy := transaction.NewTransaction()
	authDeploy.AddInput(standIn(0x46))
	authDeploy.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: script.NewFromBytes(inscribe(`{"p":"bsv-20","op":"deploy+auth","sym":"AUTH"}`, p2pkhScript(issuer), false))})
	la := tokenString(authDeploy.TxID(), 0)
	mint := spend([]in{{authDeploy, 0, issuer}, {fund, 5, holder}}, []out{
		{1, inscribe(jsonOp("mint", la, 1_000), p2pkhScript(recipient), false)},
		{1, inscribe(jsonOp("auth", la, 0), p2pkhScript(issuer), false)},
		change(2),
	})
	unfunded := spend([]in{{mixed, 0, recipient}, {fund, 6, holder}}, []out{
		{1, inscribe(jsonOp("transfer", id0, 60_000), p2pkhScript(recipient), false)},
		{1, inscribe(jsonOp("transfer", id0, 50_000), p2pkhScript(holder), false)},
		change(2),
	})

	return []named{
		{"legacy_fund", fund}, {"legacy_deploy0", deploy0}, {"legacy_deploy1", deploy1},
		{"legacy_transfer", transfer}, {"legacy_migrate0", migrate0}, {"legacy_migrate1", migrate1},
		{"legacy_mixed", mixed}, {"legacy_binary_json", binaryJSON},
		{"legacy_auth_deploy", authDeploy}, {"legacy_mint", mint}, {"legacy_unfunded", unfunded},
	}
}

func mustHash(s string) *chainhash.Hash {
	h, err := chainhash.NewHashFromHex(s)
	must(err)
	return h
}

func writeArtifact(path string, sa *runar.RunarArtifact, src string) {
	params := sa.ABI.Constructor.Params
	idx := func(name string) int {
		for i, p := range params {
			if p.Name == name {
				return i
			}
		}
		panic("no constructor param " + name)
	}
	names := make([]string, len(sa.StateFields))
	for i, f := range sa.StateFields {
		names[i] = f.Name + ":" + f.Type
	}
	if strings.Join(names, ",") != "tokenReserve:bigint,lpPubKey:PubKey,validatorPubKey:PubKey,validatorIdentity:PubKey" {
		panic("state layout changed: update src/pool.zig: " + strings.Join(names, ","))
	}
	var b strings.Builder
	fmt.Fprintf(&b, "//! Generated by `go run ./gen/vectors` from %s: do not edit.\n", src)
	b.WriteString("//! The compiled Pool template: its code with a one-byte OP_0 placeholder\n")
	b.WriteString("//! at each constructor slot (the readonly args, spliced in as pushes).\n\n")
	fmt.Fprintf(&b, "pub const script_hex = \"%s\";\n\n", sa.Script)
	b.WriteString("pub const Slot = struct { offset: usize, param: usize };\n")
	b.WriteString("pub const slots = [_]Slot{\n")
	for _, s := range sa.ConstructorSlots {
		fmt.Fprintf(&b, "    .{ .offset = %d, .param = %d },\n", s.ByteOffset, s.ParamIndex)
	}
	b.WriteString("};\n\n")
	fmt.Fprintf(&b, "pub const param_asset_id = %d;\npub const param_lp_fee_bps = %d;\npub const param_validator_fee_bps = %d;\npub const param_commission_bps = %d;\n",
		idx("assetId"), idx("lpFeeBps"), idx("validatorFeeBps"), idx("commissionBps"))
	must(os.WriteFile(path, []byte(b.String()), 0o644))
}
