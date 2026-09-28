package skein

import (
	"fmt"

	"github.com/fxamacker/cbor/v2"
)

// Envelope is the part of a BRC-169 envelope a handler reads, from the
// envelope record: the signed part (the envelope without `content`), kept in
// the encoding its sender made it in — §7.2 JSON (hex text, from JSON clients)
// or §7.3 dag-cbor (bytes; issue #33). The router verified its signature,
// decrypted the content and checked it against contentHash before admitting
// it; the plaintext is the body record beside it in the log entry.
type Envelope struct {
	Recipient struct {
		Handle string `cbor:"handle"`
		Domain string `cbor:"domain"`
	} `cbor:"recipient"`
	Sender struct {
		IdentityKey Key    `cbor:"identityKey"`
		Handle      string `cbor:"handle,omitempty"`
		Domain      string `cbor:"domain,omitempty"`
	} `cbor:"sender"`
	Created     string          `cbor:"created"`
	ContentHash cbor.RawMessage `cbor:"contentHash"`
}

// CBOR reports whether the envelope is in the §7.3 dag-cbor form (its
// contentHash a byte string), not the §7.2 JSON form.
func (e *Envelope) CBOR() bool {
	return len(e.ContentHash) > 0 && e.ContentHash[0]>>5 == 2 // major type 2: bytes
}

// Read reads the envelope record and its plaintext body record (dag-cbor bytes).
func Read(envelope, body CID) (*Envelope, []byte, error) {
	env, err := ReadEnvelope(envelope)
	if err != nil {
		return nil, nil, err
	}
	plain, err := Get(body)
	if err != nil {
		return nil, nil, fmt.Errorf("get body: %w", err)
	}
	return env, plain, nil
}

// ReadEnvelope reads an envelope record.
func ReadEnvelope(envelope CID) (*Envelope, error) {
	raw, err := Get(envelope)
	if err != nil {
		return nil, fmt.Errorf("get envelope: %w", err)
	}
	var env Envelope
	if err := Decode(raw, &env); err != nil {
		return nil, fmt.Errorf("envelope record: %w", err)
	}
	return &env, nil
}

// EmitRecord is an outbound message: the complete envelope (signed and
// encrypted by the program, package envelope), its plaintext body record, the
// identity it is sealed to (33 bytes), and the box. Emit checks it and hands it on.
type EmitRecord struct {
	Kind     string `cbor:"kind"`
	To       Key    `cbor:"to"`
	Box      string `cbor:"box"`
	Body     CID    `cbor:"body"`
	Envelope any    `cbor:"envelope"`
}
