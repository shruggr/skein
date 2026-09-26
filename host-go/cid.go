// Package host runs skein's WASI preview1 programs under wasmtime: the wasm
// shell (brush + uutils coreutils) over a git-shaped tree read from the SQLite
// store, with the same import behaviour as the Node host (src/runtime/shell.ts,
// src/runtime/wasi/*.ts). The same tree and command line give the same bytes
// out and the same tree CID on both.
package host

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
)

// CID is a CIDv1 in binary form. Only the two shapes the shell needs are
// minted here: git objects (git-raw, sha1) and modules (raw, sha2-256).
type CID string

const (
	codecRaw    = 0x55
	codecGitRaw = 0x78
	mhSHA1      = 0x11
	mhSHA256    = 0x12
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func newCID(codec, mh uint64, digest []byte) CID {
	var b []byte
	b = binary.AppendUvarint(b, 1)
	b = binary.AppendUvarint(b, codec)
	b = binary.AppendUvarint(b, mh)
	b = binary.AppendUvarint(b, uint64(len(digest)))
	return CID(append(b, digest...))
}

// gitCID is the CID of a git object from its whole bytes ("blob <len>\0…").
func gitCID(object []byte) CID {
	d := sha1.Sum(object)
	return newCID(codecGitRaw, mhSHA1, d[:])
}

// rawCID is how the runtime names a module: raw codec, sha2-256.
func rawCID(data []byte) CID {
	d := sha256.Sum256(data)
	return newCID(codecRaw, mhSHA256, d[:])
}

// parts decodes the header: codec, multihash code, digest.
func (c CID) parts() (codec, mh uint64, digest []byte, err error) {
	r := bytes.NewReader([]byte(c))
	var v [4]uint64
	for i := range v {
		if v[i], err = binary.ReadUvarint(r); err != nil {
			return 0, 0, nil, fmt.Errorf("bad cid")
		}
	}
	if v[0] != 1 || int(v[3]) != r.Len() {
		return 0, 0, nil, fmt.Errorf("bad cid")
	}
	return v[1], v[2], []byte(c)[len(c)-r.Len():], nil
}

// gitDigest is the 20-byte git object id inside a git-raw CID.
func (c CID) gitDigest() ([]byte, error) {
	codec, mh, d, err := c.parts()
	if err != nil || codec != codecGitRaw || mh != mhSHA1 || len(d) != 20 {
		return nil, fmt.Errorf("not a git object cid: %s", c)
	}
	return d, nil
}

// String is the base32 multibase form the Node side prints (bafy…, baf4…).
func (c CID) String() string { return "b" + strings.ToLower(b32.EncodeToString([]byte(c))) }

// ParseCID accepts the base32 multibase form, or a 40-hex git object id.
func ParseCID(s string) (CID, error) {
	if len(s) == 40 {
		if d, err := hex.DecodeString(s); err == nil {
			return newCID(codecGitRaw, mhSHA1, d), nil
		}
	}
	if !strings.HasPrefix(s, "b") {
		return "", fmt.Errorf("unsupported cid encoding: %q (want base32 'b…' or a git sha1)", s)
	}
	b, err := b32.DecodeString(strings.ToUpper(s[1:]))
	if err != nil {
		return "", fmt.Errorf("bad cid %q: %w", s, err)
	}
	c := CID(b)
	if _, _, _, err := c.parts(); err != nil {
		return "", fmt.Errorf("bad cid %q", s)
	}
	return c, nil
}
