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
func _emit(cid unsafe.Pointer, cidLen uint32) int32

//go:wasmimport skein wallet
func _wallet(req unsafe.Pointer, n uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein take
func _take(out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein error
func _error(out unsafe.Pointer, cap uint32) int32

// CID is a binary CID. In dag-cbor it is tag 42 over 0x00 ‖ bytes.
type CID []byte

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

// Step is what input() returns: which thread, which step, and why it runs now.
type Step struct {
	Thread   CID             `cbor:"thread"`
	N        int             `cbor:"step"`
	Entry    CID             `cbor:"entry"`
	Args     cbor.RawMessage `cbor:"args"`
	Programs map[string]CID  `cbor:"programs"`
	Resolved []Resolved      `cbor:"resolved,omitempty"`
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

// Emit queues an outbound envelope described by an emit record (already Put):
// {kind: "emit", to, handle?, domain?, box, body: <cid>}. The edge seals and sends it.
func Emit(c CID) error {
	if _emit(ptr(c), uint32(len(c))) < 0 {
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
