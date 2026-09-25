// wire-probe: a test program for the wallet wire import (src/runtime/program.test.ts).
// One step: getPublicKey (identity) and createSignature (protocol [2, "skein probe"],
// key "1", anyone) over the bytes of its input entry's CID, both through the
// go-sdk wire client; puts {kind: "probe", identityKey, signature} and exits.
// Not in the genesis.
package main

import (
	"context"
	"fmt"
	"os"

	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/shruggr/skein/programs/skein"
	"github.com/shruggr/skein/programs/wallet"
)

type probe struct {
	Kind        string `cbor:"kind"`
	IdentityKey string `cbor:"identityKey"`
	Signature   []byte `cbor:"signature"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "wire-probe:", err)
		os.Exit(1)
	}
}

func run() error {
	step, err := skein.Input()
	if err != nil {
		return err
	}
	w, ctx := wallet.New(), context.Background()
	pk, err := w.GetPublicKey(ctx, sdk.GetPublicKeyArgs{IdentityKey: true}, "skein")
	if err != nil {
		return fmt.Errorf("getPublicKey: %w", err)
	}
	sig, err := w.CreateSignature(ctx, sdk.CreateSignatureArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryAppAndCounterparty, Protocol: "skein probe"},
			KeyID:        "1",
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeAnyone},
		},
		Data: []byte(step.Entry),
	}, "skein")
	if err != nil {
		return fmt.Errorf("createSignature: %w", err)
	}
	c, err := skein.Put(probe{Kind: "probe", IdentityKey: pk.PublicKey.ToDERHex(), Signature: sig.Signature.Serialize()})
	if err != nil {
		return err
	}
	fmt.Printf("%x\n", []byte(c))
	return nil
}
