package skein

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"
)

// Message is a message record (#40): a BRC-33 message that arrived — its
// sender the identity the BRC-104 session proved, the body a dag-cbor record
// beside it — or one this instance sent (the same shape, put by the
// messagebox's `send`). Its CID is the message's id: what a reply's replyTo
// names.
type Message struct {
	Kind      string `cbor:"kind"`
	Op        string `cbor:"op"`
	Sender    Key    `cbor:"sender"`
	Recipient Key    `cbor:"recipient"`
	Box       string `cbor:"box"`
	Body      CID    `cbor:"body"`
	JSON      bool   `cbor:"json,omitempty"`
}

// Read reads a message record and its body record (dag-cbor bytes).
func Read(message, body CID) (*Message, []byte, error) {
	m, err := ReadMessage(message)
	if err != nil {
		return nil, nil, err
	}
	plain, err := Get(body)
	if err != nil {
		return nil, nil, fmt.Errorf("get body: %w", err)
	}
	return m, plain, nil
}

// ReadMessage reads a message record.
func ReadMessage(message CID) (*Message, error) {
	raw, err := Get(message)
	if err != nil {
		return nil, fmt.Errorf("get message: %w", err)
	}
	var m Message
	if err := Decode(raw, &m); err != nil {
		return nil, fmt.Errorf("message record: %w", err)
	}
	return &m, nil
}

//go:wasmimport skein call
func _call(prog unsafe.Pointer, progLen uint32, fn unsafe.Pointer, fnLen uint32, arg unsafe.Pointer, argLen uint32, out unsafe.Pointer, cap uint32) int32

// Call runs another program's function (#40, an in-VM call): from a step it
// is part of the step — its recorded calls and head moves are this step's —
// and it answers with what it wrote to stdout. A non-zero exit is the error.
func Call(program CID, fn string, arg []byte) ([]byte, error) {
	f := []byte(fn)
	return result(func(out unsafe.Pointer, cap uint32) int32 {
		return _call(ptr(program), uint32(len(program)), ptr(f), uint32(len(f)), ptr(arg), uint32(len(arg)), out, cap)
	})
}

// Transient reports whether a Send failed for a reason that may pass (no
// answer, 5xx, 408, 425, 429): the messagebox marks those "transient: …".
func Transient(err error) bool {
	return err != nil && strings.Contains(err.Error(), "transient: ")
}

// Send delivers body (a record, dag-cbor encoded here) to identity `to` in
// `box`: the messagebox program's `send` over http (#40), recorded with this
// step. The peer's messagebox URL comes from the peer table (or the owner's
// from the genesis); `handle`/`domain`, when given, resolve it on first contact.
// It answers with the message's id — the record a reply's replyTo names, which
// the caller may Await.
func Send(step *Step, to Key, box string, body any, handle, domain string) (CID, error) {
	mb, ok := step.Programs["messagebox"]
	if !ok {
		return nil, errors.New("send: no messagebox program in the genesis")
	}
	raw, err := Encode(body)
	if err != nil {
		return nil, err
	}
	arg := map[string]any{"to": []byte(to), "box": box, "body": raw}
	if handle != "" {
		arg["handle"] = handle
		arg["domain"] = domain
	}
	a, err := Encode(arg)
	if err != nil {
		return nil, err
	}
	out, err := Call(mb, "send", a)
	if err != nil {
		return nil, err
	}
	var r struct {
		ID CID `cbor:"id"`
	}
	if err := Decode(out, &r); err != nil {
		return nil, fmt.Errorf("send: %w", err)
	}
	return r.ID, nil
}

// Peer is a record of the peer table (#40, the head `peers`, written by the
// resolve program): who an identity is and where its messagebox is.
type Peer struct {
	Key    Key    `cbor:"key"`
	URL    string `cbor:"url"`
	Handle string `cbor:"handle,omitempty"`
	Domain string `cbor:"domain,omitempty"`
	Since  int64  `cbor:"since"`
	Source string `cbor:"source"`
}

// Peers is the peer table as it stands (this step's own writes included).
func Peers() ([]Peer, error) {
	root, err := Head("peers")
	if err != nil || len(root) == 0 {
		return nil, err
	}
	b, err := Get(root)
	if err != nil {
		return nil, err
	}
	var t struct {
		Peers []struct {
			Key  Key `cbor:"key"`
			Peer CID `cbor:"peer"`
		} `cbor:"peers"`
	}
	if err := Decode(b, &t); err != nil {
		return nil, fmt.Errorf("peers: %w", err)
	}
	out := make([]Peer, 0, len(t.Peers))
	for _, x := range t.Peers {
		pb, err := Get(x.Peer)
		if err != nil {
			return nil, err
		}
		var p Peer
		if err := Decode(pb, &p); err != nil {
			return nil, fmt.Errorf("peer: %w", err)
		}
		out = append(out, p)
	}
	return out, nil
}

// Resolve a BRC-169 handle to its identity key: the peer table's record for
// it, else the resolve program's lookup (an in-VM call whose http calls are
// recorded with this step, and which writes the peer record).
func Resolve(step *Step, handle, domain string) (Key, error) {
	peers, err := Peers()
	if err != nil {
		return nil, err
	}
	for _, p := range peers {
		if p.Handle == handle && p.Domain == domain {
			return p.Key, nil
		}
	}
	rp, ok := step.Programs["resolve"]
	if !ok {
		return nil, fmt.Errorf("resolve @%s@%s: no resolve program in the genesis", handle, domain)
	}
	a, err := Encode(map[string]any{"handle": handle, "domain": domain})
	if err != nil {
		return nil, err
	}
	out, err := Call(rp, "resolve", a)
	if err != nil {
		return nil, err
	}
	var p Peer
	if err := Decode(out, &p); err != nil {
		return nil, fmt.Errorf("resolve: %w", err)
	}
	return p.Key, nil
}
