// loop: the turn loop (README.md, "Records"; docs/MESSAGES.md), launched by the subscription
// (owner, chat) → loop with David's opening `chat` envelope as its input.
//
// The conversation is the thread's own chain: every turn is a record the step
// keeps (skein.Keep), and each step rebuilds the messages by walking the chain
// back from its tip. Turns ({kind: "turn", of, role, …}), built from the
// admitted plaintext bodies and the shell's results:
//
//	user       {of: <chat envelope>, role: "user", text, tree?, model?}
//	assistant  {of: <completions envelope>, role: "assistant", content?, reasoning?, tool_calls?, model, ms?, usage?}
//	tool       {of: <shell thread>, role: "tool", call, exitCode, stdout, stderr, tree}   (outputs capped at 16 KiB)
//	error      {of: <completions envelope>, role: "error", error}
//
// Per step, by why it runs:
//
//	a chat (step 1, or a reply to our `say`)  keep the user turn; emit `infer`; await it
//	a completion (reply to our `infer`)      keep it; tool calls → launch the shell for the
//	                                         first (one at a time); none → emit `say`, await it
//	                                         (an error → keep it, `say` it, await)
//	the shell at rest                        keep the tool result; launch the next call, or
//	                                         emit `infer` again when none is left
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/fxamacker/cbor/v2"
	"github.com/shruggr/skein/programs/skein"
)

const system = "You are working with David through skein. Use the bash tool to run commands over the working tree; when you are done or need David, answer in plain text; keep answers short."

const defaultModel = "ripper/qwen38"

const outputCap = 16 << 10

type args struct {
	Envelope skein.CID `cbor:"envelope"`
	Body     skein.CID `cbor:"body"`
	Box      string    `cbor:"box"`
	Sender   string    `cbor:"sender"`
}

type chatBody struct {
	Text    string    `cbor:"text"`
	Tree    skein.CID `cbor:"tree,omitzero"`
	Model   string    `cbor:"model,omitempty"`
	ReplyTo skein.CID `cbor:"replyTo,omitzero"`
}

type function struct {
	Name      string `cbor:"name" json:"name"`
	Arguments string `cbor:"arguments" json:"arguments"`
}

type toolCall struct {
	ID       string   `cbor:"id"`
	Type     string   `cbor:"type"`
	Function function `cbor:"function"`
}

type assistantMessage struct {
	Role      string     `cbor:"role"`
	Content   string     `cbor:"content,omitempty"`
	Reasoning string     `cbor:"reasoning,omitempty"`
	ToolCalls []toolCall `cbor:"tool_calls,omitempty"`
}

type completionBody struct {
	ReplyTo skein.CID         `cbor:"replyTo"`
	Message *assistantMessage `cbor:"message,omitempty"`
	Usage   cbor.RawMessage   `cbor:"usage,omitempty"`
	Model   string            `cbor:"model,omitempty"`
	Ms      int64             `cbor:"ms,omitempty"`
	Error   string            `cbor:"error,omitempty"`
}

// turn is every turn the loop keeps; Role says which fields apply.
type turn struct {
	Kind      string          `cbor:"kind"`
	Of        skein.CID       `cbor:"of"`
	Role      string          `cbor:"role"`
	Text      string          `cbor:"text,omitempty"`
	Tree      skein.CID       `cbor:"tree,omitzero"`
	Model     string          `cbor:"model,omitempty"`
	Content   string          `cbor:"content,omitempty"`
	Reasoning string          `cbor:"reasoning,omitempty"`
	ToolCalls []toolCall      `cbor:"tool_calls,omitempty"`
	Ms        int64           `cbor:"ms,omitempty"`
	Usage     cbor.RawMessage `cbor:"usage,omitempty"`
	Call      string          `cbor:"call,omitempty"`
	ExitCode  *int            `cbor:"exitCode,omitempty"`
	Stdout    *string         `cbor:"stdout,omitempty"`
	Stderr    *string         `cbor:"stderr,omitempty"`
	Error     string          `cbor:"error,omitempty"`
}

// The `infer` body: OpenAI chat messages and tool definitions.
type message struct {
	Role       string     `cbor:"role"`
	Content    string     `cbor:"content"`
	ToolCalls  []toolCall `cbor:"tool_calls,omitempty"`
	ToolCallID string     `cbor:"tool_call_id,omitempty"`
}

type inferBody struct {
	Model    string    `cbor:"model"`
	Messages []message `cbor:"messages"`
	Tools    []any     `cbor:"tools,omitempty"`
	Thinking string    `cbor:"thinking,omitempty"`
}

type sayBody struct {
	Text    string    `cbor:"text"`
	Page    string    `cbor:"page,omitempty"`
	Tree    skein.CID `cbor:"tree,omitzero"`
	Thread  skein.CID `cbor:"thread"`
	ReplyTo skein.CID `cbor:"replyTo"`
}

type shellArgs struct {
	Cmd  string    `cbor:"cmd"`
	Tree skein.CID `cbor:"tree"`
}

type shellResult struct {
	ExitCode int       `cbor:"exitCode"`
	Stdout   []byte    `cbor:"stdout"`
	Stderr   []byte    `cbor:"stderr"`
	Tree     skein.CID `cbor:"tree"`
}

var bashTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "bash",
		"description": "Run a shell command over the working tree",
		"parameters": map[string]any{
			"type":       "object",
			"properties": map[string]any{"cmd": map[string]any{"type": "string"}},
			"required":   []string{"cmd"},
		},
	},
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "loop:", err)
		os.Exit(1)
	}
}

// loop is one step's view: its input, the thread's args, and the conversation so far.
type loop struct {
	step *skein.Step
	a    args
	conv []turn
}

func run() error {
	step, err := skein.Input()
	if err != nil {
		return err
	}
	l := &loop{step: step}
	if err := skein.Decode(step.Args, &l.a); err != nil {
		return fmt.Errorf("args: %w", err)
	}
	if len(step.Tip) > 0 {
		cids, err := skein.Kept(step.Tip)
		if err != nil {
			return fmt.Errorf("chain: %w", err)
		}
		for _, c := range cids {
			b, err := skein.Get(c)
			if err != nil {
				return err
			}
			var r turn
			if err := skein.Decode(b, &r); err != nil {
				return fmt.Errorf("turn: %w", err)
			}
			l.conv = append(l.conv, r)
		}
	}
	switch {
	case step.Reply != nil && step.Reply.Box == "completions":
		return l.completion(step.Reply)
	case step.Reply != nil:
		return l.chat(step.Reply.Envelope, step.Reply.Body)
	case len(step.Resolved) > 0:
		return l.toolDone(step.Resolved[0])
	default:
		return l.chat(l.a.Envelope, l.a.Body)
	}
}

func (l *loop) keep(r turn) error {
	r.Kind = "turn"
	c, err := skein.Put(r)
	if err != nil {
		return fmt.Errorf("put turn: %w", err)
	}
	if err := skein.Keep(c); err != nil {
		return fmt.Errorf("keep: %w", err)
	}
	l.conv = append(l.conv, r)
	return nil
}

// chat: David's line (the opening one, or a reply to our `say`).
func (l *loop) chat(envelope, body skein.CID) error {
	_, plain, err := skein.Read(envelope, body)
	if err != nil {
		return err
	}
	var b chatBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("chat body: %w", err)
	}
	if len(b.Tree) == 0 && len(l.conv) == 0 {
		// A new conversation that names no tree starts from `main`, if there is one.
		if b.Tree, err = skein.Head("main"); err != nil {
			return err
		}
	}
	if err := l.keep(turn{Of: envelope, Role: "user", Text: b.Text, Tree: b.Tree, Model: b.Model}); err != nil {
		return err
	}
	return l.infer()
}

// completion: the inference peer's answer to our `infer`.
func (l *loop) completion(r *skein.Answer) error {
	_, plain, err := skein.Read(r.Envelope, r.Body)
	if err != nil {
		return err
	}
	var b completionBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("completion body: %w", err)
	}
	if b.Error != "" || b.Message == nil {
		msg := b.Error
		if msg == "" {
			msg = "completion has no message"
		}
		if err := l.keep(turn{Of: r.Envelope, Role: "error", Error: msg}); err != nil {
			return err
		}
		return l.say("inference failed: " + msg)
	}
	m := b.Message
	if err := l.keep(turn{Of: r.Envelope, Role: "assistant", Content: m.Content, Reasoning: m.Reasoning, ToolCalls: m.ToolCalls, Model: b.Model, Ms: b.Ms, Usage: b.Usage}); err != nil {
		return err
	}
	return l.next()
}

// toolDone: the shell for the first pending call came to rest.
func (l *loop) toolDone(res skein.Resolved) error {
	pending := l.pending()
	if len(pending) == 0 {
		return errors.New("a shell finished but no tool call is pending")
	}
	call := pending[0]
	tree := l.tree()
	code, stdout, stderr := -1, "", ""
	if res.State == "finished" && len(res.Result) > 0 {
		var sr shellResult
		if err := skein.Decode(res.Result, &sr); err != nil {
			return fmt.Errorf("shell result: %w", err)
		}
		code, stdout, stderr = sr.ExitCode, capText(sr.Stdout), capText(sr.Stderr)
		if len(sr.Tree) > 0 {
			tree = sr.Tree
		}
	} else {
		var e struct {
			Message string `cbor:"message"`
		}
		_ = skein.Decode(res.Error, &e)
		stderr = "shell " + res.State + ": " + e.Message
	}
	if err := l.keep(turn{Of: res.Thread, Role: "tool", Call: call.ID, ExitCode: &code, Stdout: &stdout, Stderr: &stderr, Tree: tree}); err != nil {
		return err
	}
	return l.next()
}

// next: run the next pending tool call; when none is left, ask the model again
// if the last answer called tools, else say its content to David.
func (l *loop) next() error {
	for _, call := range l.pending() {
		var a struct {
			Cmd string `json:"cmd"`
		}
		err := json.Unmarshal([]byte(call.Function.Arguments), &a)
		if call.Function.Name == "bash" && err == nil && a.Cmd != "" {
			return l.launch(a.Cmd)
		}
		msg := "unknown tool " + call.Function.Name
		if call.Function.Name == "bash" {
			msg = "bash wants {\"cmd\": string}"
		}
		code, empty := 2, ""
		if err := l.keep(turn{Of: l.step.Entry, Role: "tool", Call: call.ID, ExitCode: &code, Stdout: &empty, Stderr: &msg, Tree: l.tree()}); err != nil {
			return err
		}
	}
	last := l.lastAssistant()
	if last != nil && len(last.ToolCalls) > 0 {
		return l.infer()
	}
	text := ""
	if last != nil {
		text = last.Content
	}
	return l.say(text)
}

func (l *loop) launch(cmd string) error {
	tree := l.tree()
	if isEmptyTree(tree) {
		if err := skein.PutBlock(tree, skein.EmptyTreeObject); err != nil {
			return err
		}
	}
	ac, err := skein.Put(shellArgs{Cmd: cmd, Tree: tree})
	if err != nil {
		return err
	}
	shell, ok := l.step.Programs["shell"]
	if !ok {
		return errors.New("no shell program")
	}
	_, err = skein.Launch(shell, ac)
	return err
}

// infer: the conversation to the inference peer; rest on its completion.
func (l *loop) infer() error {
	peer := l.step.Peers["infer"]
	if peer == "" {
		return l.say("no inference peer is configured (genesis peers.infer)")
	}
	model := l.step.Defaults["model"]
	if model == "" {
		model = defaultModel
	}
	msgs := []message{{Role: "system", Content: system}}
	for _, r := range l.conv {
		switch r.Role {
		case "user":
			if r.Model != "" {
				model = r.Model
			}
			msgs = append(msgs, message{Role: "user", Content: r.Text})
		case "assistant":
			msgs = append(msgs, message{Role: "assistant", Content: r.Content, ToolCalls: r.ToolCalls})
		case "tool":
			msgs = append(msgs, message{Role: "tool", ToolCallID: r.Call, Content: toolText(r)})
		}
	}
	env, err := skein.Send(peer, "", "", "infer", inferBody{Model: model, Messages: msgs, Tools: []any{bashTool}, Thinking: l.step.Defaults["thinking"]})
	if err != nil {
		return err
	}
	return skein.Await(env)
}

// say: text to David, answering the chat that opened this turn; rest on his reply.
func (l *loop) say(text string) error {
	var turn skein.CID
	for _, r := range l.conv {
		if r.Role == "user" {
			turn = r.Of
		}
	}
	if len(turn) == 0 {
		turn = l.a.Envelope
	}
	opening, err := skein.Get(l.a.Envelope)
	if err != nil {
		return err
	}
	var env skein.Envelope
	if err := skein.Decode(opening, &env); err != nil {
		return err
	}
	c, err := skein.Send(l.a.Sender, env.Sender.Handle, env.Sender.Domain, "say", sayBody{Text: text, Tree: l.tree(), Thread: l.step.Thread, ReplyTo: turn})
	if err != nil {
		return err
	}
	return skein.Await(c)
}

func (l *loop) lastAssistant() *turn {
	for i := len(l.conv) - 1; i >= 0; i-- {
		if l.conv[i].Role == "assistant" {
			return &l.conv[i]
		}
	}
	return nil
}

// pending: the last answer's tool calls with no tool result yet, in order.
func (l *loop) pending() []toolCall {
	last := -1
	for i, r := range l.conv {
		if r.Role == "assistant" {
			last = i
		}
	}
	if last < 0 {
		return nil
	}
	done := map[string]bool{}
	for _, r := range l.conv[last+1:] {
		if r.Role == "tool" {
			done[r.Call] = true
		}
	}
	var out []toolCall
	for _, c := range l.conv[last].ToolCalls {
		if !done[c.ID] {
			out = append(out, c)
		}
	}
	return out
}

// tree: the working tree now — the latest one a chat named (the opening one: or `main`) or a tool produced; else the empty tree.
func (l *loop) tree() skein.CID {
	t := skein.EmptyTree
	for _, r := range l.conv {
		if (r.Role == "user" || r.Role == "tool") && len(r.Tree) > 0 {
			t = r.Tree
		}
	}
	return t
}

func toolText(r turn) string {
	var b strings.Builder
	if r.ExitCode != nil {
		fmt.Fprintf(&b, "exit %d\n", *r.ExitCode)
	}
	if r.Stdout != nil {
		b.WriteString(*r.Stdout)
	}
	if r.Stderr != nil && *r.Stderr != "" {
		b.WriteString("\n[stderr]\n")
		b.WriteString(*r.Stderr)
	}
	return b.String()
}

func capText(b []byte) string {
	if len(b) <= outputCap {
		return string(b)
	}
	return fmt.Sprintf("%s\n… (%d more bytes)", b[:outputCap], len(b)-outputCap)
}

func isEmptyTree(c skein.CID) bool { return string(c) == string(skein.EmptyTree) }
