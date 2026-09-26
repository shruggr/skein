// objects-handler: the handler program for the `objects` box.
//
// The admitted body is a dag-cbor bundle {records: [{cid, bytes}], root?} of
// at most 1 MiB; the client chunks larger sets across messages. Each record is
// stored under its CID with putblock (the runtime checks the hash: git-raw/sha1,
// raw or dag-cbor/sha2-256). A bundle naming a root (the client names it on the
// last one) makes that tree the `main` head if the instance has none yet.
package main

import (
	"fmt"
	"os"

	"github.com/shruggr/skein/programs/skein"
)

type args struct {
	Envelope skein.CID `cbor:"envelope"`
	Body     skein.CID `cbor:"body"`
}

type bundle struct {
	Records []struct {
		CID   skein.CID `cbor:"cid"`
		Bytes []byte    `cbor:"bytes"`
	} `cbor:"records"`
	Root skein.CID `cbor:"root,omitempty"`
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
	_, plain, err := skein.Read(a.Envelope, a.Body)
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
	if len(b.Root) == 0 {
		return nil
	}
	main, err := skein.Head("main")
	if err != nil || len(main) > 0 {
		return err
	}
	return skein.Advance("main", b.Root)
}
