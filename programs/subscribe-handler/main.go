// subscribe-handler: the handler program for the `subscribe` box — changing
// the instance's subscriptions (docs/VM.md, "Subscriptions").
//
// The admitted body is {op, sender?, box, handler}: op "add" appends the rule
// (sender, box) → handler, "remove" deletes it; no sender is any sender. The
// handler must be a program record in the store (for a wasm program, with its
// module: `objects` delivers both). The runtime writes the change when the
// step ends. Whoever is subscribed to this box may change the subscriptions:
// the genesis subscribes the owner; delegating is subscribing another sender.
// No reply.
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

type subscribeBody struct {
	Op      string    `cbor:"op"`
	Sender  string    `cbor:"sender,omitempty"`
	Box     string    `cbor:"box"`
	Handler skein.CID `cbor:"handler"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "subscribe-handler:", err)
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
	var b subscribeBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("body: %w", err)
	}
	if (b.Op != "add" && b.Op != "remove") || b.Box == "" || len(b.Handler) == 0 {
		return fmt.Errorf("body: want {op: add|remove, sender?, box, handler}")
	}
	rec, err := skein.Get(b.Handler)
	if err != nil {
		return fmt.Errorf("handler %x: not in the store: %w", []byte(b.Handler), err)
	}
	var p struct {
		Kind string `cbor:"kind"`
	}
	if err := skein.Decode(rec, &p); err != nil || p.Kind != "program" {
		return fmt.Errorf("handler: not a program record")
	}
	return skein.Subscribe(b.Op, b.Sender, b.Box, b.Handler)
}
