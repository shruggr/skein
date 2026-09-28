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
	"crypto/sha1"
	"encoding/hex"
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

//go:wasmimport skein keep
func _keep(cid unsafe.Pointer, cidLen uint32) int32

//go:wasmimport skein launch
func _launch(prog unsafe.Pointer, progLen uint32, args unsafe.Pointer, argsLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein emit
func _emit(cid unsafe.Pointer, cidLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein await
func _await(cid unsafe.Pointer, cidLen uint32) int32

//go:wasmimport skein resolve
func _resolve(name unsafe.Pointer, nameLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein head
func _head(name unsafe.Pointer, nameLen uint32, out unsafe.Pointer, cap uint32) int32

//go:wasmimport skein advance
func _advance(name unsafe.Pointer, nameLen uint32, tree unsafe.Pointer, treeLen uint32) int32

//go:wasmimport skein subscribe
func _subscribe(op unsafe.Pointer, opLen uint32, sender unsafe.Pointer, senderLen uint32, box unsafe.Pointer, boxLen uint32, handler unsafe.Pointer, handlerLen uint32) int32

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
// args, so Read(r.Envelope, r.Body) reads it.
type Answer struct {
	Envelope CID    `cbor:"envelope"`
	Body     CID    `cbor:"body"`
	Box      string `cbor:"box"`
	Sender   Key    `cbor:"sender"`
	ReplyTo  CID    `cbor:"replyTo"`
}

// DeliveryFailed is an awaited envelope the host's delivery provider could not
// deliver (a `failed` outcome entry): the emit, its envelope's id, to whom, in
// which box, and why. The reply it awaited will not come.
type DeliveryFailed struct {
	Emit     CID    `cbor:"emit"`
	Envelope CID    `cbor:"envelope"`
	To       Key    `cbor:"to"`
	Box      string `cbor:"box"`
	Reason   string `cbor:"reason"`
}

// Step is what input() returns: which thread, which step, and why it runs now
// (the first step; Resolved: launched threads at rest; Reply: an awaited reply;
// DeliveryFailed: an awaited envelope that could not be delivered).
type Step struct {
	Thread   CID               `cbor:"thread"`
	N        int               `cbor:"step"`
	Entry    CID               `cbor:"entry"`
	Args     cbor.RawMessage   `cbor:"args"`
	Programs map[string]CID    `cbor:"programs"`
	Resolved []Resolved        `cbor:"resolved,omitempty"`
	Tip      CID               `cbor:"tip,omitzero"` // the thread's latest update before this step; absent on step 1
	Reply    *Answer           `cbor:"reply,omitempty"`
	Failed   *DeliveryFailed   `cbor:"deliveryFailed,omitempty"`
	At       int64             `cbor:"at"`              // the entry's stamp, ms since the epoch: an envelope's `created`
	Self     Name              `cbor:"self"`            // the instance's handle and domain (the genesis's)
	Peers    map[string]Key    `cbor:"peers,omitempty"`    // genesis peers by role (e.g. "infer")
	Defaults map[string]string `cbor:"defaults,omitempty"` // genesis defaults (e.g. "model")
	Names    []KeyName         `cbor:"names,omitempty"`    // genesis names: handles for identities (the owner, peers)
}

// KeyName is a genesis `names` entry: the handle an identity goes by.
type KeyName struct {
	IdentityKey Key    `cbor:"identityKey"`
	Handle      string `cbor:"handle"`
	Domain      string `cbor:"domain"`
}

// NameOf is the genesis's name for the identity key `hex`, if it has one.
func (s *Step) NameOf(hex string) (Name, bool) {
	for _, n := range s.Names {
		if n.IdentityKey.Hex() == hex {
			return Name{Handle: n.Handle, Domain: n.Domain}, true
		}
	}
	return Name{}, false
}

// Key is an identity key as records hold it since format 2 (issue #33): its
// 33 bytes. It also decodes from hex text (a JSON-form envelope's
// sender.identityKey, kept as the sender made it).
type Key []byte

// Hex is the key in lowercase hex (how programs name identities).
func (k Key) Hex() string { return hex.EncodeToString(k) }

func (k *Key) UnmarshalCBOR(data []byte) error {
	var v any
	if err := cbor.Unmarshal(data, &v); err != nil {
		return err
	}
	switch x := v.(type) {
	case []byte:
		*k = Key(x)
	case string:
		b, err := hex.DecodeString(x)
		if err != nil {
			return fmt.Errorf("identity key %q: %w", x, err)
		}
		*k = Key(b)
	default:
		return fmt.Errorf("identity key: want bytes or hex, got %T", v)
	}
	return nil
}

// KeyFromHex parses a hex identity key.
func KeyFromHex(s string) (Key, error) {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 33 {
		return nil, fmt.Errorf("identity key %q: not 33 bytes of hex", s)
	}
	return Key(b), nil
}

// Name is a handle at a domain.
type Name struct {
	Handle string `cbor:"handle"`
	Domain string `cbor:"domain"`
}

// Update is the part of a thread update a program reads when walking its own
// chain back from Step.Tip.
type Update struct {
	Prev   CID    `cbor:"prev"`
	Seq    int    `cbor:"seq"`
	State  string `cbor:"state"`
	Kept   []CID  `cbor:"kept,omitempty"`
	Awaits []CID  `cbor:"awaits,omitempty"`
}

// Kept walks the thread's chain from tip back to its origin and returns
// every record its steps kept (see Keep) in order, oldest first.
func Kept(tip CID) ([]CID, error) {
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
		chain = append(chain, u.Kept)
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

// Keep keeps a record (already Put) in the thread's state: it is listed in this
// step's update, so later steps find it with Kept(step.Tip).
func Keep(c CID) error {
	if _keep(ptr(c), uint32(len(c))) < 0 {
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

// Emit an outbound message: an emit record (already Put, see EmitRecord)
// carrying the complete envelope, signed and encrypted through the wallet
// (package envelope does both). The runtime checks it — signed by this
// instance, content from it to `to`, contentHash the body's — and returns the
// CID of its signed part (the message's id: what a reply's replyTo names). It
// is handed to the delivery provider, as it is, when the step ends.
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

// Resolution is the host's answer to a resolve, as recorded: the resolution
// endpoint's whole response (BRC-169 §5.2: identityKey, certificate,
// messagebox, ttl, …) plus how the host got it and what it checked.
type Resolution struct {
	IdentityKey Key             `cbor:"identityKey"`
	Via         string          `cbor:"via,omitempty"`
	Messagebox  string          `cbor:"messagebox,omitempty"`
	TTL         int64           `cbor:"ttl,omitempty"`
	Certificate cbor.RawMessage `cbor:"certificate,omitempty"`
	Checked     []string        `cbor:"checked,omitempty"`
	Unchecked   []string        `cbor:"unchecked,omitempty"`
	Error       string          `cbor:"error,omitempty"`
}

// Resolve a BRC-169 handle ("handle@domain") to the identity key it names,
// through the host's resolver. Attested: the whole answer is recorded, and
// served from the record on replay. An envelope to a handle is sealed to this
// key (envelope.Send's `to`), and a reply is taken only from it. A handle
// that does not resolve is an error.
func Resolve(handle, domain string) (string, error) {
	r, err := ResolveAll(handle, domain)
	if err != nil {
		return "", err
	}
	return r.IdentityKey.Hex(), nil
}

// ResolveAll is Resolve with the whole recorded answer.
func ResolveAll(handle, domain string) (*Resolution, error) {
	n := []byte(handle + "@" + domain)
	b, err := result(func(out unsafe.Pointer, cap uint32) int32 { return _resolve(ptr(n), uint32(len(n)), out, cap) })
	if err != nil {
		return nil, err
	}
	var r Resolution
	if err := Decode(b, &r); err != nil {
		return nil, fmt.Errorf("resolve: %w", err)
	}
	return &r, nil
}

// Head is the tree a named head points at now, or nil if it has none.
func Head(name string) (CID, error) {
	n := []byte(name)
	b, err := result(func(out unsafe.Pointer, cap uint32) int32 { return _head(ptr(n), uint32(len(n)), out, cap) })
	if err != nil || len(b) == 0 {
		return nil, err
	}
	return CID(b), nil
}

// Advance moves a named head to tree (a record in the store) when this step
// ends without error. Nothing moves a head but this.
func Advance(name string, tree CID) error {
	n := []byte(name)
	if _advance(ptr(n), uint32(len(n)), ptr(tree), uint32(len(tree))) < 0 {
		return lastError()
	}
	return nil
}

// Subscribe changes the instance's subscriptions when this step ends without
// error (docs/VM.md, "Subscriptions"): op "add" appends the rule (sender, box)
// → handler, "remove" deletes it. sender nil is any sender (else the
// identity key's 33 bytes); handler is a program record in the store.
func Subscribe(op string, sender Key, box string, handler CID) error {
	o, s, b := []byte(op), []byte(sender), []byte(box)
	if _subscribe(ptr(o), uint32(len(o)), ptr(s), uint32(len(s)), ptr(b), uint32(len(b)), ptr(handler), uint32(len(handler))) < 0 {
		return lastError()
	}
	return nil
}

// The empty git tree: object "tree 0\0", CIDv1 git-raw (0x78) sha1 (0x11).
var EmptyTreeObject = []byte("tree 0\x00")
var EmptyTree = func() CID {
	d := sha1.Sum(EmptyTreeObject)
	return append(CID{0x01, 0x78, 0x11, 0x14}, d[:]...)
}()

// StartTree is the tree a `run` that names none starts from: the `main`
// head's, else the empty tree (put into the store, so it can be run over).
func StartTree() (CID, error) {
	t, err := Head("main")
	if err != nil || len(t) > 0 {
		return t, err
	}
	return EmptyTree, PutBlock(EmptyTree, EmptyTreeObject)
}

// WalletCall sends one BRC-100 wallet wire request frame to the instance wallet
// through the runtime and returns the result frame. Every call is attested:
// recorded, and served from the record on replay. Package
// github.com/shruggr/skein/programs/wallet wraps it as a go-sdk wallet.
func WalletCall(frame []byte) ([]byte, error) {
	return result(func(out unsafe.Pointer, cap uint32) int32 { return _wallet(ptr(frame), uint32(len(frame)), out, cap) })
}
