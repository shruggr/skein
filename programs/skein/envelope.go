package skein

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/shruggr/skein/programs/brc78"
)

// Envelope is the part of a BRC-169 envelope a handler reads, from the
// envelope record (the JSON object as received, as dag-cbor). The runtime's
// edge verified its signature before admitting it (src/runtime/inbox.ts).
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
	Created string `cbor:"created"`
	Content string `cbor:"content"`
}

// MessageKey is the key record the host delivered with the envelope.
type MessageKey struct {
	Kind     string `cbor:"kind"`
	Envelope CID    `cbor:"envelope"`
	Key      []byte `cbor:"key"`
}

// Open reads the envelope record and its key record and decrypts the content.
func Open(envelope, key CID) (*Envelope, []byte, error) {
	raw, err := Get(envelope)
	if err != nil {
		return nil, nil, fmt.Errorf("get envelope: %w", err)
	}
	var env Envelope
	if err := Decode(raw, &env); err != nil {
		return nil, nil, fmt.Errorf("envelope record: %w", err)
	}
	kb, err := Get(key)
	if err != nil {
		return nil, nil, fmt.Errorf("get key: %w", err)
	}
	var k MessageKey
	if err := Decode(kb, &k); err != nil || k.Kind != "message-key" {
		return nil, nil, fmt.Errorf("key record: %v", err)
	}
	if !bytes.Equal(k.Envelope, envelope) {
		return nil, nil, errors.New("key record is for another envelope")
	}
	content, err := base64.StdEncoding.DecodeString(env.Content)
	if err != nil {
		return nil, nil, fmt.Errorf("content base64: %w", err)
	}
	h, plain, err := brc78.Decrypt(content, k.Key)
	if err != nil {
		return nil, nil, err
	}
	if h.Sender != env.Sender.IdentityKey {
		return nil, nil, errors.New("BRC-78 sender is not the envelope's sender")
	}
	return &env, plain, nil
}

// EmitRecord asks the edge to seal an envelope with content Body to To, in Box.
type EmitRecord struct {
	Kind   string `cbor:"kind"`
	To     string `cbor:"to"`
	Handle string `cbor:"handle,omitempty"`
	Domain string `cbor:"domain,omitempty"`
	Box    string `cbor:"box"`
	Body   CID    `cbor:"body"`
}

// Send puts body as a record and emits it to `to` in box; returns the sealed envelope's CID.
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
