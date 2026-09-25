// objects-handler: the handler program for the `objects` box.
//
// The envelope's content decrypts (purely, with the host-delivered message key) to a dag-cbor
// bundle {records: [{cid, bytes}], root?} of at most 1 MiB; the client chunks
// larger sets across messages. Each record is stored under its CID with
// putblock (the runtime checks the hash: git-raw/sha1, raw or dag-cbor/sha2-256),
// then a reveal {kind: "reveal", of: <envelope>, root?, count} is put and signed.
package main

import (
	"fmt"
	"os"

	"github.com/shruggr/skein/programs/skein"
)

type args struct {
	Envelope skein.CID `cbor:"envelope"`
	Key      skein.CID `cbor:"key"`
}

type bundle struct {
	Records []struct {
		CID   skein.CID `cbor:"cid"`
		Bytes []byte    `cbor:"bytes"`
	} `cbor:"records"`
	Root skein.CID `cbor:"root,omitempty"`
}

type reveal struct {
	Kind  string    `cbor:"kind"`
	Of    skein.CID `cbor:"of"`
	Root  *skein.CID `cbor:"root,omitempty"`
	Count int        `cbor:"count"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "objects-handler:", err)
		os.Exit(1)
	}
}

func run() error {
	step, err := skein.Input()
	if err != nil {
		return err
	}
	var a args
	if err := skein.Decode(step.Args, &a); err != nil {
		return fmt.Errorf("args: %w", err)
	}
	_, plain, err := skein.Open(a.Envelope, a.Key)
	if err != nil {
		return err
	}
	var b bundle
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("bundle: %w", err)
	}
	for i, r := range b.Records {
		if err := skein.PutBlock(r.CID, r.Bytes); err != nil {
			return fmt.Errorf("record %d: %w", i, err)
		}
	}
	r := reveal{Kind: "reveal", Of: a.Envelope, Count: len(b.Records)}
	if len(b.Root) > 0 {
		r.Root = &b.Root
	}
	rc, err := skein.Put(r)
	if err != nil {
		return err
	}
	return skein.Reveal(rc)
}
