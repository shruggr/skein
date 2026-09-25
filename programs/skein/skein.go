// Package skein is a handler program's side of the skein import namespace
// (src/runtime/wasi/skein-imports.ts). A program is a plain WASI command
// (GOOS=wasip1) stepped by the runtime: it runs to completion once per input,
// and if it launched threads, it is run again with their resolution when they
// come to rest.
//
// Every import that returns bytes has the shape f(..., out_ptr, out_cap) → n:
// n >= 0 is the full length; when n > out_cap nothing was written and the
// result is held for Take (so the call is never repeated — wallet calls are
// attested and recorded once). n < 0 is an error; LastError has the message.
// CIDs cross the boundary in binary form.
package skein

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/fxamacker/cbor/v2"
)

//go:wasmimport skein input
func _input(out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein get
func _get(cid unsafe.Pointer, cidLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein put
func _put(data unsafe.Pointer, n uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein putblock
func _putblock(cid unsafe.Pointer, cidLen uint32, data unsafe.Pointer, n uint32) int32

//go:wasmimport skein reveal
func _reveal(cid unsafe.Pointer, cidLen uint32) int32

//go:wasmimport skein launch
func _launch(prog unsafe.Pointer, progLen uint32, args unsafe.Pointer, argsLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein emit
func _emit(cid unsafe.Pointer, cidLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein await
func _await(cid unsafe.Pointer, cidLen uint32) int32

//go:wasmimport skein wallet
func _wallet(req unsafe.Pointer, n uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein take
func _take(out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein error
func _error(out unsafe.Pointer, cap uint32) int32

// CID is a binary CID. In dag-cbor it is tag 42 over 0x00 ‖ bytes.
type CID []byte

// IsZero lets `omitzero` drop an absent CID (omitempty does not apply to a Marshaler).
func (c CID) IsZero() bool { return len(c) == 0 }

func (c CID) MarshalCBOR() ([]byte, error) {
	if len(c) == 0 {
		return nil, errors.New("skein: empty CID")
	}
	return cbor.Marshal(cbor.Tag{Number: 42, Content: append([]byte{0}, c...)})
}

func (c *CID) UnmarshalCBOR(data []byte) error {
	var t cbor.Tag
	if err := cbor.Unmarshal(data, &t); err != nil {
		return err
	}
	b, ok := t.Content.([]byte)
	if t.Number != 42 || !ok || len(b) < 2 || b[0] != 0 {
		return errors.New("skein: not a dag-cbor CID")
	}
	*c = append(CID(nil), b[1:]...)
	return nil
}

var enc cbor.EncMode

func init() {
	opts := cbor.CanonicalEncOptions() // length-first key order: dag-cbor's
	var err error
	if enc, err = opts.EncMode(); err != nil {
		panic(err)
	}
}

// Encode is dag-cbor (the runtime re-encodes on Put, so this need only be valid CBOR).
func Encode(v any) ([]byte, error) { return enc.Marshal(v) }

// Decode dag-cbor into v.
func Decode(data []byte, v any) error { return cbor.Unmarshal(data, v) }

func ptr(b []byte) unsafe.Pointer {
	if len(b) == 0 {
		return nil
	}
	return unsafe.Pointer(&b[0])
}

func lastError() error {
	buf := make([]byte, 1024)
	n := _error(ptr(buf), uint32(len(buf)))
	if n < 0 {
		return errors.New("skein: import failed")
	}
	if int(n) > len(buf) {
		n = int32(len(buf))
	}
	return errors.New(string(buf[:n]))
}

// result runs an import that writes into (out, cap), taking the held result when it did not fit.
func result(call func(out unsafe.Pointer, cap uint32) int32) ([]byte, error) {
	buf := make([]byte, 4096)
	n := call(ptr(buf), uint32(len(buf)))
	if n < 0 {
		return nil, lastError()
	}
	if int(n) <= len(buf) {
		return buf[:n], nil
	}
	buf = make([]byte, n)
	if m := _take(ptr(buf), uint32(n)); m != n {
		return nil, lastError()
	}
	return buf, nil
}

// Resolved is a launched thread at rest, as a later step's input names it.
type Resolved struct {
	Thread CID             `cbor:"thread"`
	State  string          `cbor:"state"`
	Result cbor.RawMessage `cbor:"result,omitempty"`
	Error  cbor.RawMessage `cbor:"error,omitempty"`
}

// Answer is an admitted envelope delivered to the thread that awaited the
// envelope its body's replyTo names (see Await). Same fields as a handler's
// args, so Open(r.Envelope, r.Key) decrypts it.
type Answer struct {
	Envelope CID    `cbor:"envelope"`
	Key      CID    `cbor:"key"`
	Box      string `cbor:"box"`
	Sender   string `cbor:"sender"`
	ReplyTo  CID    `cbor:"replyTo"`
}

// Step is what input() returns: which thread, which step, and why it runs now
// (the first step; Resolved: launched threads at rest; Reply: an awaited reply).
type Step struct {
	Thread   CID               `cbor:"thread"`
	N        int               `cbor:"step"`
	Entry    CID               `cbor:"entry"`
	Args     cbor.RawMessage   `cbor:"args"`
	Programs map[string]CID    `cbor:"programs"`
	Resolved []Resolved        `cbor:"resolved,omitempty"`
	Tip      CID               `cbor:"tip,omitzero"`      // the thread's latest update before this step; absent on step 1
	Reply    *Answer            `cbor:"reply,omitempty"`
	Peers    map[string]string `cbor:"peers,omitempty"`    // genesis peers by role (e.g. "infer")
	Defaults map[string]string `cbor:"defaults,omitempty"` // genesis defaults (e.g. "model")
}

// Update is the part of a thread update a program reads when walking its own
// chain back from Step.Tip.
type Update struct {
	Prev    CID    `cbor:"prev"`
	Seq     int    `cbor:"seq"`
	State   string `cbor:"state"`
	Reveals []CID  `cbor:"reveals,omitempty"`
	Awaits  []CID  `cbor:"awaits,omitempty"`
}

// Reveals walks the thread's chain from tip back to its origin and returns
// every revealed record CID in order, oldest first.
func Reveals(tip CID) ([]CID, error) {
	var chain [][]CID
	for c := tip; len(c) > 0; {
		b, err := Get(c)
		if err != nil {
			return nil, err
		}
		var u Update
		if err := Decode(b, &u); err != nil {
			return nil, fmt.Errorf("update: %w", err)
		}
		if u.Seq < 1 {
			break // the origin
		}
		chain = append(chain, u.Reveals)
		c = u.Prev
	}
	var out []CID
	for i := len(chain) - 1; i >= 0; i-- {
		out = append(out, chain[i]...)
	}
	return out, nil
}

// Input is this step's input record.
func Input() (*Step, error) {
	b, err := result(_input)
	if err != nil {
		return nil, err
	}
	var s Step
	if err := Decode(b, &s); err != nil {
		return nil, fmt.Errorf("input: %w", err)
	}
	return &s, nil
}

// Get a record's bytes by CID.
func Get(c CID) ([]byte, error) {
	return result(func(out unsafe.Pointer, cap uint32) int32 { return _get(ptr(c), uint32(len(c)), out, cap) })
}

// Put a value as a dag-cbor record; returns its CID.
func Put(v any) (CID, error) {
	data, err := Encode(v)
	if err != nil {
		return nil, err
	}
	b, err := result(func(out unsafe.Pointer, cap uint32) int32 { return _put(ptr(data), uint32(len(data)), out, cap) })
	return CID(b), err
}

// PutBlock stores bytes under a CID minted elsewhere (git-raw, raw); the runtime checks the hash.
func PutBlock(c CID, data []byte) error {
	if _putblock(ptr(c), uint32(len(c)), ptr(data), uint32(len(data))) < 0 {
		return lastError()
	}
	return nil
}

// Reveal marks a record (already Put) as revealed: the runtime signs it with the instance identity.
func Reveal(c CID) error {
	if _reveal(ptr(c), uint32(len(c))) < 0 {
		return lastError()
	}
	return nil
}

// Launch a thread running program with the record at args as its arguments. The
// thread starts when this step ends; this step's thread then waits on it.
func Launch(program, args CID) (CID, error) {
	b, err := result(func(out unsafe.Pointer, cap uint32) int32 {
		return _launch(ptr(program), uint32(len(program)), ptr(args), uint32(len(args)), out, cap)
	})
	return CID(b), err
}

// Emit seals an outbound envelope described by an emit record (already Put):
// {kind: "emit", to, handle?, domain?, box, body: <cid>}, and returns the sealed
// envelope record's CID (what a reply's replyTo names). Sealing is attested;
// the envelope is sent when the step ends.
func Emit(c CID) (CID, error) {
	b, err := result(func(out unsafe.Pointer, cap uint32) int32 { return _emit(ptr(c), uint32(len(c)), out, cap) })
	return CID(b), err
}

// Await rests the thread on a reply to an envelope this step emitted: the step
// ends waiting, and the admitted envelope whose body's replyTo is env (from the
// identity it was sealed to) is the next step's Reply. A step awaits replies or
// launches threads, not both.
func Await(env CID) error {
	if _await(ptr(env), uint32(len(env))) < 0 {
		return lastError()
	}
	return nil
}

// WalletCall sends one BRC-100 wallet wire request frame to the instance wallet
// through the runtime and returns the result frame. Every call is attested:
// recorded, and served from the record on replay. Package
// github.com/shruggr/skein/programs/wallet wraps it as a go-sdk wallet.
func WalletCall(frame []byte) ([]byte, error) {
	return result(func(out unsafe.Pointer, cap uint32) int32 { return _wallet(ptr(frame), uint32(len(frame)), out, cap) })
}
