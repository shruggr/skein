package brc78

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// testdata/sdk.json is written by src/envelope.test.ts from @bsv/sdk:
// EncryptedMessage.encrypt(...) (and a wallet's encrypt) with the key our
// deriveMessageKey computes. Regenerate with SKEIN_WRITE_VECTORS=1 npm test.
type vector struct {
	Name      string `json:"name"`
	Message   string `json:"message"`
	Key       string `json:"key"`
	Plaintext string `json:"plaintext"`
	Sender    string `json:"sender"`
	Recipient string `json:"recipient"`
}

func TestSDKVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/sdk.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vs {
		msg, _ := hex.DecodeString(v.Message)
		key, _ := hex.DecodeString(v.Key)
		h, plain, err := Decrypt(msg, key)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if hex.EncodeToString(plain) != v.Plaintext || h.Sender != v.Sender || h.Recipient != v.Recipient {
			t.Fatalf("%s: got %x from %s to %s", v.Name, plain, h.Sender, h.Recipient)
		}
		bad := append([]byte(nil), key...)
		bad[0] ^= 1
		if _, _, err := Decrypt(msg, bad); err == nil {
			t.Fatalf("%s: a wrong key decrypted", v.Name)
		}
		msg[len(msg)-1] ^= 1
		if _, _, err := Decrypt(msg, key); err == nil {
			t.Fatalf("%s: altered content decrypted", v.Name)
		}
	}
}
