// Package envelope seals a handler's outbound BRC-169 envelopes (§7.2 JSON
// to a party that wrote to us in it, else §7.3 dag-cbor: issue #33) inside
// the step (docs/MESSAGES.md, "Outbound"): the program signs the metadata and
// encrypts the content to the recipient through the instance wallet (the
// `wallet` import: getPublicKey, createSignature, encrypt, each attested, so
// replay needs no wallet), then emits the complete envelope. The delivery
// provider only carries it. A separate package so that programs which send
// nothing do not link go-sdk; the same wire format as src/envelope.ts.
package envelope

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/shruggr/skein/programs/skein"
	"github.com/shruggr/skein/programs/wallet"
)

// Name is a handle at a domain.
type Name struct {
	Handle string `cbor:"handle"`
	Domain string `cbor:"domain"`
}

// Sender is the envelope's sender: the instance's identity key, handle and domain.
type Sender struct {
	IdentityKey string `cbor:"identityKey"`
	Handle      string `cbor:"handle,omitempty"`
	Domain      string `cbor:"domain,omitempty"`
}

// Envelope is the complete envelope as sent: the signed metadata, the BRC-78
// content (base64) and the signature (hex DER). Its signed part — all but
// Content — is the message's id (its record CID).
type Envelope struct {
	MetanetHandles string `cbor:"metanetHandles"`
	Recipient      Name   `cbor:"recipient"`
	Sender         Sender `cbor:"sender"`
	Created        string `cbor:"created"`
	ContentHash    string `cbor:"contentHash"`
	Content        string `cbor:"content"`
	Signature      string `cbor:"signature"`
}

var (
	envelopeProtocol = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryAppAndCounterparty, Protocol: "metanet handles envelope"}
	messageProtocol  = sdk.Protocol{SecurityLevel: sdk.SecurityLevelEveryAppAndCounterparty, Protocol: "message encryption"}
	brc78Version     = []byte{0x42, 0x42, 0x10, 0x33}
)

const originator = "skein"

var me struct {
	step     *skein.Step
	identity string
}

// self: this step's input and the instance's identity key, read once.
func self() (*skein.Step, string, error) {
	if me.step == nil {
		s, err := skein.Input()
		if err != nil {
			return nil, "", err
		}
		pk, err := wallet.New().GetPublicKey(context.Background(), sdk.GetPublicKeyArgs{IdentityKey: true}, originator)
		if err != nil {
			return nil, "", fmt.Errorf("getPublicKey: %w", err)
		}
		me.step, me.identity = s, pk.PublicKey.ToDERHex()
	}
	return me.step, me.identity, nil
}

// CBOREnvelope is the §7.3 / BRC-231 form (issue #33): keys, the hash and the
// signature as bytes, content as the BRC-78 bytes; signed over the dag-cbor of
// the map without content and signature.
type CBOREnvelope struct {
	MetanetHandles string     `cbor:"metanetHandles"`
	Recipient      Name       `cbor:"recipient"`
	Sender         CBORSender `cbor:"sender"`
	Created        string     `cbor:"created"`
	ContentHash    []byte     `cbor:"contentHash"`
	Content        []byte     `cbor:"content,omitempty"`
	Signature      []byte     `cbor:"signature,omitempty"`
}

// CBORSender is the sender with its identity key as 33 bytes.
type CBORSender struct {
	IdentityKey []byte `cbor:"identityKey"`
	Handle      string `cbor:"handle,omitempty"`
	Domain      string `cbor:"domain,omitempty"`
}

// jsonFor: whether an envelope to `to` goes in the §7.2 JSON form — when the
// party we answer wrote to us in it (the envelope that started this thread,
// or the reply this step resumes on, from `to`): a JSON client (the front end,
// the standard messagebox client) reads only that. Everything else is §7.3
// dag-cbor.
func jsonFor(step *skein.Step, to string) bool {
	var a struct {
		Envelope skein.CID `cbor:"envelope"`
		Sender   skein.Key `cbor:"sender"`
	}
	check := func(env skein.CID, sender skein.Key) bool {
		if len(env) == 0 || sender.Hex() != to {
			return false
		}
		e, err := skein.ReadEnvelope(env)
		return err == nil && !e.CBOR()
	}
	if step.Reply != nil && check(step.Reply.Envelope, step.Reply.Sender) {
		return true
	}
	return skein.Decode(step.Args, &a) == nil && check(a.Envelope, a.Sender)
}

// Send puts body as a record, seals it to identity `to` (hex; named
// handle@domain in the envelope; with no handle, the genesis's name for `to`,
// else the key's first 16 hex digits and this instance's domain) and emits it
// in box — in the §7.2 JSON form to a party that wrote to us in it, else the
// §7.3 dag-cbor form. Returns the envelope's id: the CID of its signed part,
// what a reply's replyTo names.
func Send(to, handle, domain, box string, body any) (skein.CID, error) {
	step, identity, err := self()
	if err != nil {
		return nil, err
	}
	toKey, err := skein.KeyFromHex(to)
	if err != nil {
		return nil, fmt.Errorf("recipient: %w", err)
	}
	bc, err := skein.Put(body)
	if err != nil {
		return nil, fmt.Errorf("put body: %w", err)
	}
	plain, err := skein.Get(bc) // the body as stored: the dag-cbor the recipient hashes
	if err != nil {
		return nil, fmt.Errorf("get body: %w", err)
	}
	if n, ok := step.NameOf(to); ok && handle == "" {
		handle, domain = n.Handle, n.Domain
	}
	if handle == "" && len(to) >= 16 {
		handle = to[:16]
	}
	if domain == "" {
		domain = step.Self.Domain
	}
	hash := sha256.Sum256(plain)
	created := time.UnixMilli(step.At).UTC().Format("2006-01-02T15:04:05.000") + "Z"
	var sealed any
	if jsonFor(step, to) {
		env := Envelope{
			MetanetHandles: "1.0",
			Recipient:      Name{Handle: handle, Domain: domain},
			Sender:         Sender{IdentityKey: identity, Handle: step.Self.Handle, Domain: step.Self.Domain},
			Created:        created,
			ContentHash:    hex.EncodeToString(hash[:]),
		}
		if env.Signature, err = sign(&env); err != nil {
			return nil, err
		}
		content, err := encrypt(identity, to, plain)
		if err != nil {
			return nil, err
		}
		env.Content = base64.StdEncoding.EncodeToString(content)
		sealed = env
	} else {
		idKey, _ := hex.DecodeString(identity)
		env := CBOREnvelope{
			MetanetHandles: "1.0",
			Recipient:      Name{Handle: handle, Domain: domain},
			Sender:         CBORSender{IdentityKey: idKey, Handle: step.Self.Handle, Domain: step.Self.Domain},
			Created:        created,
			ContentHash:    hash[:],
		}
		pre, err := skein.Encode(env) // content and signature empty: omitted
		if err != nil {
			return nil, err
		}
		if env.Signature, err = signBytes(pre); err != nil {
			return nil, err
		}
		if env.Content, err = encrypt(identity, to, plain); err != nil {
			return nil, err
		}
		sealed = env
	}
	emit, err := skein.Put(skein.EmitRecord{Kind: "emit", To: toKey, Box: box, Body: bc, Envelope: sealed})
	if err != nil {
		return nil, fmt.Errorf("put emit: %w", err)
	}
	return skein.Emit(emit)
}

// Reply puts body as a record and sends it to env's sender in box.
func Reply(env *skein.Envelope, box string, body any) error {
	_, err := Send(env.Sender.IdentityKey.Hex(), env.Sender.Handle, env.Sender.Domain, box, body)
	return err
}

// sign: the §7.2 signature, hex DER, over SHA-256 of the RFC 8785 canonical
// envelope without content and signature.
func sign(env *Envelope) (string, error) {
	sender := map[string]any{"identityKey": env.Sender.IdentityKey}
	if env.Sender.Handle != "" {
		sender["handle"] = env.Sender.Handle
	}
	if env.Sender.Domain != "" {
		sender["domain"] = env.Sender.Domain
	}
	canon := jcs(map[string]any{
		"metanetHandles": env.MetanetHandles,
		"recipient":      map[string]any{"handle": env.Recipient.Handle, "domain": env.Recipient.Domain},
		"sender":         sender,
		"created":        env.Created,
		"contentHash":    env.ContentHash,
	})
	sig, err := signBytes([]byte(canon))
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(sig), nil
}

// signBytes: DER, by the instance wallet under [2, "metanet handles envelope"],
// key "1", counterparty anyone, over SHA-256 of data.
func signBytes(data []byte) ([]byte, error) {
	r, err := wallet.New().CreateSignature(context.Background(), sdk.CreateSignatureArgs{
		EncryptionArgs: sdk.EncryptionArgs{ProtocolID: envelopeProtocol, KeyID: "1", Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeAnyone}},
		Data:           data,
	}, originator)
	if err != nil {
		return nil, fmt.Errorf("createSignature: %w", err)
	}
	return r.Signature.Serialize(), nil
}

// encrypt: the BRC-78 portable message from `from` to `to` — a key id of 32
// bytes from the step's random stream (it is carried in the clear; it need
// only differ per message), then the wallet's ciphertext under
// [2, "message encryption"], that key id (base64), counterparty `to`.
func encrypt(from, to string, plain []byte) ([]byte, error) {
	toKey, err := ec.PublicKeyFromString(to)
	if err != nil {
		return nil, fmt.Errorf("recipient %q: %w", to, err)
	}
	keyID := make([]byte, 32)
	if _, err := rand.Read(keyID); err != nil {
		return nil, err
	}
	r, err := wallet.New().Encrypt(context.Background(), sdk.EncryptArgs{
		EncryptionArgs: sdk.EncryptionArgs{ProtocolID: messageProtocol, KeyID: base64.StdEncoding.EncodeToString(keyID), Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: toKey}},
		Plaintext:      plain,
	}, originator)
	if err != nil {
		return nil, fmt.Errorf("encrypt: %w", err)
	}
	f, _ := hex.DecodeString(from)
	t, _ := hex.DecodeString(to)
	if len(f) != 33 || len(t) != 33 {
		return nil, errors.New("BRC-78: identities must be 33-byte compressed keys")
	}
	return append(append(append(append(append([]byte{}, brc78Version...), f...), t...), keyID...), r.Ciphertext...), nil
}

// jcs is RFC 8785 canonical JSON for what an envelope's signed part holds:
// objects of strings. Keys sort by UTF-16 code units (byte order, for these
// ASCII keys); strings escape as ECMAScript JSON.stringify does.
func jcs(v any) string {
	var b strings.Builder
	var write func(v any)
	write = func(v any) {
		switch x := v.(type) {
		case string:
			b.WriteByte('"')
			for _, r := range x {
				switch r {
				case '"':
					b.WriteString(`\"`)
				case '\\':
					b.WriteString(`\\`)
				case '\b':
					b.WriteString(`\b`)
				case '\f':
					b.WriteString(`\f`)
				case '\n':
					b.WriteString(`\n`)
				case '\r':
					b.WriteString(`\r`)
				case '\t':
					b.WriteString(`\t`)
				default:
					if r < 0x20 {
						fmt.Fprintf(&b, `\u%04x`, r)
					} else {
						b.WriteRune(r)
					}
				}
			}
			b.WriteByte('"')
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			b.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					b.WriteByte(',')
				}
				write(k)
				b.WriteByte(':')
				write(x[k])
			}
			b.WriteByte('}')
		default:
			panic(fmt.Sprintf("jcs: %T", v))
		}
	}
	write(v)
	return b.String()
}
