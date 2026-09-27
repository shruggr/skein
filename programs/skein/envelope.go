package skein

import "fmt"

// Envelope is the part of a BRC-169 envelope a handler reads, from the
// envelope record: the signed part (the JSON object without `content`, as
// dag-cbor). The delivery provider verified its signature, decrypted the content and
// checked it against ContentHash before admitting it (src/host/messagebox.ts);
// the plaintext is the body record beside it in the log entry.
type Envelope struct {
	Recipient struct {
		Handle string `cbor:"handle"`
		Domain string `cbor:"domain"`
	} `cbor:"recipient"`
	Sender struct {
		IdentityKey string `cbor:"identityKey"`
		Handle      string `cbor:"handle,omitempty"`
		Domain      string `cbor:"domain,omitempty"`
	} `cbor:"sender"`
	Created     string `cbor:"created"`
	ContentHash string `cbor:"contentHash"`
}

// Read reads the envelope record and its plaintext body record (dag-cbor bytes).
func Read(envelope, body CID) (*Envelope, []byte, error) {
	raw, err := Get(envelope)
	if err != nil {
		return nil, nil, fmt.Errorf("get envelope: %w", err)
	}
	var env Envelope
	if err := Decode(raw, &env); err != nil {
		return nil, nil, fmt.Errorf("envelope record: %w", err)
	}
	plain, err := Get(body)
	if err != nil {
		return nil, nil, fmt.Errorf("get body: %w", err)
	}
	return &env, plain, nil
}

// EmitRecord is an outbound message: the complete envelope (signed and
// encrypted by the program, package envelope), its plaintext body record, the
// identity it is sealed to, and the box. Emit checks it and hands it on.
type EmitRecord struct {
	Kind     string `cbor:"kind"`
	To       string `cbor:"to"`
	Box      string `cbor:"box"`
	Body     CID    `cbor:"body"`
	Envelope any    `cbor:"envelope"`
}
