package skein

import "fmt"

// Envelope is the part of a BRC-169 envelope a handler reads, from the
// envelope record: the signed part (the JSON object without `content`, as
// dag-cbor). The edge verified its signature, decrypted the content and
// checked it against ContentHash before admitting it (src/runtime/inbox.ts);
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

// EmitRecord asks the edge to sign and send an envelope with content Body to To, in Box.
type EmitRecord struct {
	Kind   string `cbor:"kind"`
	To     string `cbor:"to"`
	Handle string `cbor:"handle,omitempty"`
	Domain string `cbor:"domain,omitempty"`
	Box    string `cbor:"box"`
	Body   CID    `cbor:"body"`
}

// Send puts body as a record and emits it to `to` in box; returns the signed envelope's CID.
func Send(to, handle, domain, box string, body any) (CID, error) {
	bc, err := Put(body)
	if err != nil {
		return nil, fmt.Errorf("put body: %w", err)
	}
	ec, err := Put(EmitRecord{Kind: "emit", To: to, Handle: handle, Domain: domain, Box: box, Body: bc})
	if err != nil {
		return nil, fmt.Errorf("put emit: %w", err)
	}
	return Emit(ec)
}

// Reply puts body as a record and emits it to env's sender in box.
func Reply(env *Envelope, box string, body any) error {
	_, err := Send(env.Sender.IdentityKey, env.Sender.Handle, env.Sender.Domain, box, body)
	return err
}
