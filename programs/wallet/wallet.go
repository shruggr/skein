// Package wallet is the instance wallet as a go-sdk wallet.Interface, over the
// `skein.wallet` import: BRC-100 wire frames (substrates.WalletWireTransceiver),
// each call attested by the runtime. Only key-derivation and crypto calls are
// allowed (getPublicKey, encrypt, decrypt, createHmac, verifyHmac,
// createSignature, verifySignature). A separate package so that programs which
// do not call the wallet do not link go-sdk.
package wallet

import (
	"context"

	"github.com/bsv-blockchain/go-sdk/wallet/substrates"
	"github.com/shruggr/skein/programs/skein"
)

// Wire is a substrates.WalletWire over the runtime.
type Wire struct{}

func (Wire) TransmitToWallet(_ context.Context, frame []byte) ([]byte, error) {
	return skein.WalletCall(frame)
}

// New returns the instance wallet.
func New() *substrates.WalletWireTransceiver {
	return &substrates.WalletWireTransceiver{Wire: Wire{}}
}
