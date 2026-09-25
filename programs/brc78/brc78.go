// Package brc78 decrypts BRC-78 portable encrypted messages given the message
// key, with no wallet: the host derives the key (src/runtime/inbox.ts,
// deriveMessageKey) and delivers it with the envelope; a handler (or anyone
// replaying the log) decrypts here and the GCM tag proves the plaintext.
//
// Layout: version 0x42421033 ‖ sender (33) ‖ recipient (33) ‖ key id (32) ‖
// BRC-2 ciphertext, where BRC-2 is AES-256-GCM with a 32-byte IV prepended and
// the 16-byte tag appended (@bsv/sdk SymmetricKey).
package brc78

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"errors"
)

var Version = []byte{0x42, 0x42, 0x10, 0x33}

// Header is the plaintext part of a BRC-78 message.
type Header struct {
	Sender, Recipient string // compressed keys, hex
	KeyID             []byte // 32 bytes
}

// Parse splits a BRC-78 message into its header and BRC-2 ciphertext.
func Parse(msg []byte) (Header, []byte, error) {
	if len(msg) < 4+33+33+32+32+16 || !bytes.Equal(msg[:4], Version) {
		return Header{}, nil, errors.New("brc78: not a BRC-78 message")
	}
	return Header{Sender: hex.EncodeToString(msg[4:37]), Recipient: hex.EncodeToString(msg[37:70]), KeyID: msg[70:102]}, msg[102:], nil
}

// Decrypt a BRC-78 message with its 32-byte message key.
func Decrypt(msg, key []byte) (Header, []byte, error) {
	h, ct, err := Parse(msg)
	if err != nil {
		return h, nil, err
	}
	if len(key) != 32 {
		return h, nil, errors.New("brc78: message key is not 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return h, nil, err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, 32)
	if err != nil {
		return h, nil, err
	}
	plain, err := gcm.Open(nil, ct[:32], ct[32:], nil)
	if err != nil {
		return h, nil, errors.New("brc78: authentication failed (wrong key or altered content)")
	}
	return h, plain, nil
}
