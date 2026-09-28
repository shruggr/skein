// run-handler: the handler program for the `run` box (docs/MESSAGES.md).
//
// Step 1 (input: the admitted message and its body record): decode
// the body {cmd, tree?, cwd?, env?} (no tree: the `main` head's, else the empty
// tree), put the shell's arguments {cmd, tree, cwd?, env?} as a record and
// launch the shell with it. The step ends; the thread waits on the shell.
//
// Step 2 (input: the shell at rest): send the result to the sender in box
// `results` (the messagebox's delivery, #40): {exitCode, stdout, stderr, tree,
// replyTo: <message>} (or {error, replyTo} if the shell errored).
package main

import (
	"fmt"
	"os"

	"github.com/shruggr/skein/programs/skein"
)

type args struct {
	Message  skein.CID `cbor:"message"`
	Body     skein.CID `cbor:"body"`
	Box      string    `cbor:"box"`
	Sender   skein.Key `cbor:"sender"`
}

type runBody struct {
	Cmd  string            `cbor:"cmd"`
	Tree skein.CID         `cbor:"tree,omitzero"`
	Cwd  string            `cbor:"cwd,omitempty"`
	Env  map[string]string `cbor:"env,omitempty"`
}

type shellArgs struct {
	Cmd  string            `cbor:"cmd"`
	Tree skein.CID         `cbor:"tree"`
	Cwd  string            `cbor:"cwd,omitempty"`
	Env  map[string]string `cbor:"env,omitempty"`
}

type shellResult struct {
	ExitCode int       `cbor:"exitCode"`
	Stdout   []byte    `cbor:"stdout"`
	Stderr   []byte    `cbor:"stderr"`
	Tree     skein.CID `cbor:"tree"`
}

type resultBody struct {
	ExitCode int       `cbor:"exitCode"`
	Stdout   []byte    `cbor:"stdout"`
	Stderr   []byte    `cbor:"stderr"`
	Tree     skein.CID `cbor:"tree"`
	ReplyTo  skein.CID `cbor:"replyTo"`
}

type errorBody struct {
	Error   string    `cbor:"error"`
	ReplyTo skein.CID `cbor:"replyTo"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "run-handler:", err)
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
	if len(step.Resolved) == 0 {
		return first(step, a)
	}
	return second(step, a)
}

func first(step *skein.Step, a args) error {
	_, plain, err := skein.Read(a.Message, a.Body)
	if err != nil {
		return err
	}
	var b runBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("body: %w", err)
	}
	if b.Cmd == "" {
		return fmt.Errorf("body: want {cmd, tree?, cwd?, env?}")
	}
	if len(b.Tree) == 0 {
		if b.Tree, err = skein.StartTree(); err != nil {
			return err
		}
	}
	rc, err := skein.Put(shellArgs{Cmd: b.Cmd, Tree: b.Tree, Cwd: b.Cwd, Env: b.Env})
	if err != nil {
		return fmt.Errorf("put shell args: %w", err)
	}
	shell, ok := step.Programs["shell"]
	if !ok {
		return fmt.Errorf("no shell program")
	}
	if _, err := skein.Launch(shell, rc); err != nil {
		return fmt.Errorf("launch: %w", err)
	}
	return nil
}

func second(step *skein.Step, a args) error {
	r := step.Resolved[0]
	if r.State != "finished" || len(r.Result) == 0 {
		msg := r.State
		var e struct {
			Message string `cbor:"message"`
		}
		if len(r.Error) > 0 && skein.Decode(r.Error, &e) == nil && e.Message != "" {
			msg = e.Message
		}
		_, err := skein.Send(step, a.Sender, "results", errorBody{Error: msg, ReplyTo: a.Message}, "", "")
		return err
	}
	var res shellResult
	if err := skein.Decode(r.Result, &res); err != nil {
		return fmt.Errorf("shell result: %w", err)
	}
	_, err := skein.Send(step, a.Sender, "results", resultBody{ExitCode: res.ExitCode, Stdout: res.Stdout, Stderr: res.Stderr, Tree: res.Tree, ReplyTo: a.Message}, "", "")
	return err
}
