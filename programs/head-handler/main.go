// head-handler: the handler program for the `head` box — the owner moving a
// named head (docs/VM.md, "Heads").
//
// The envelope's content decrypts (purely, with the host-delivered message key)
// to {name, tree}. A reveal {kind: "reveal", of: <envelope>, name, tree} is put
// and signed, then the head is advanced to the tree; the runtime writes the
// head's update when the step ends (the tree must be in the store).
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

type headBody struct {
	Name string    `cbor:"name"`
	Tree skein.CID `cbor:"tree"`
}

type reveal struct {
	Kind string    `cbor:"kind"`
	Of   skein.CID `cbor:"of"`
	Name string    `cbor:"name"`
	Tree skein.CID `cbor:"tree"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "head-handler:", err)
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
	var b headBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("body: %w", err)
	}
	if b.Name == "" || len(b.Tree) == 0 {
		return fmt.Errorf("body: want {name, tree}")
	}
	rc, err := skein.Put(reveal{Kind: "reveal", Of: a.Envelope, Name: b.Name, Tree: b.Tree})
	if err != nil {
		return fmt.Errorf("put reveal: %w", err)
	}
	if err := skein.Reveal(rc); err != nil {
		return fmt.Errorf("reveal: %w", err)
	}
	return skein.Advance(b.Name, b.Tree)
}
