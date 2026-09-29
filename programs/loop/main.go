// loop: the turn loop (README.md, "Records"; docs/MESSAGES.md), launched by a
// subscription (…, chat) → loop with the opening `chat` message as its input:
// David's, or another agent's (the `message` tool of another instance). Its
// sender is the thread's opener.
//
// The conversation is the thread's own chain: every turn is a record the step
// keeps (skein.Keep), and each step rebuilds it by walking the chain back from
// its tip. Turns ({kind: "turn", parent?, of, role, …}), built from the
// admitted plaintext bodies and the shell's results; `parent` is the turn
// before (the system turn has none), so the turns are a graph of nodes keyed
// by CID, which is what the inference peer holds (below):
//
//	system     {of: <tree>, role: "system", content}   (first, once: the conversation's prompt)
//	user       {of: <chat message>, role: "user", text, tree?, model?, thinking?, annotations?}   (the opener's)
//	assistant  {of: <completions message>, role: "assistant", content?, reasoning?, tool_calls?, model, ms?, usage?}
//	tool       {of: <shell thread>, role: "tool", call, exitCode, stdout, stderr, tree}   (bash; outputs capped at 16 KiB)
//	tool       {of: <their chat reply>, role: "tool", call, to, sent: <our chat message>, text}   (message)
//	tool       {of: <entry>, role: "tool", call, to?, error}   (a message that could not be sent, or delivered)
//	tool       {of: <say|present|annotation record>, role: "tool", call, text}   (the record's CID, as JSON)
//	tool       {of: <entry>, role: "tool", call, error}   (a say/present/annotate call with bad arguments)
//	error      {of: <completions message | entry>, role: "error", error}
//
// Kept beside the turns, not one of them: {kind: "missing", of: <completions
// message>, missing: [<node>]} — the peer did not hold a node we named; and
// the conversation's artefacts (issue #19; docs/MESSAGES.md, "The turn
// stream"):
//
//	{kind: "say", of: <assistant turn>, call, text}
//	{kind: "present", of: <assistant turn>, call, page, blocks?: [{id, …}]}
//	{kind: "annotation", of: <assistant turn>, by: "model", call, present, block?, note}
//	{kind: "annotation", of: <user turn>, by: "user", present, block?, note}   (from a chat's `annotations`)
//
// The infer protocol (issue #12; docs/MESSAGES.md, "The infer protocol"):
// each `infer` carries only the turns since the last request — from the
// latest assistant turn on, since the peer held everything up to its parent —
// and names the node they extend (`parent`); the first carries the whole
// conversation. `model` and `thinking` are per request: the latest user
// turn's, else the genesis defaults. A `missing` reply (a restarted or
// evicted peer) is kept as above and answered with the whole conversation,
// once; a second in a row is an inference error.
//
// The prompt: a new conversation reads /SOUL.md from the tree it starts on
// (the chat's tree, else `main`'s) — else the fixed one below — and appends
// /IDENTITY.md, then /ROSTER.md (the colleagues the host says this agent
// knows, with their addresses), after it if there are. It is kept as the system turn, so the
// conversation keeps it however the tree moves on.
//
// Everything the loop sends a party is a `chat` — the same body in both
// directions — and it rests on the reply. A chat to a party this thread
// already has a conversation with (it opened the thread, or replied to one of
// our messages) is a reply to that party's latest message here (latestFrom),
// so their waiting thread resumes with it; a chat to anyone else starts a new
// conversation (no replyTo). A conversation is pairwise; two agents talking
// alternate on one thread each.
//
// Tools: `bash` (a command in the shell over the working tree) and `message`
// ({to: "@handle@domain", text}: a `chat` to another party — the identity the
// handle resolves to, from the peer table, or on first contact through the
// resolve program (an in-VM call; its BRC-169 lookup is recorded) — delivered
// by the messagebox program over http (#40), then rest on the reply as on an
// `infer`; their reply is the tool result).
// Calls run one at a time, in order. With `defaults.tools` in the genesis
// naming them (a comma-separated list; default none), three more: `say`
// ({text}), `present` ({page, blocks?}) and `annotate` ({present, block?,
// note}) — ordinary tools the model calls when the conversation calls for
// them. Each puts its record, keeps it (so the page lives on by CID, and the
// call and its result reach every later prompt), sends it to the opener in
// their `turn` box — a message, not awaited — and answers the model with the
// record's CID (and a present's block ids).
//
// The turn stream: with `defaults.stream` "on", the loop also sends the opener,
// in `turn`, the moment each happens: {kind: "thinking", of: <assistant
// turn>, text} (a completion's reasoning), {kind: "log", of, call, name,
// event: "started"|"finished", exitCode?, tree?, error?} (each tool call; `of`
// the assistant turn when started, the tool turn when finished), {kind:
// "error", of: <error turn>, error}, and the opener's own annotations as
// kept. These are sent, not kept: the turns hold the same facts.
//
// The answer: a turn ends with a `chat` to the opener, {text, tree, thread,
// replyTo: <their latest message>}, and rests on their reply; that reply is
// the next user turn.
//
// Per step, by why it runs:
//
//	a chat (step 1, or a reply to our answer)  keep the user turn; emit `infer`; await it
//	a completion (reply to our `infer`)        keep it; tool calls → run the first (one at
//	                                           a time); none → answer, await the reply
//	                                           (an error → keep it, answer with it, await)
//	a reply to our `message`                   keep it as the tool result; run the next call
//	the shell at rest                          keep the tool result; run the next call, or
//	                                           emit `infer` again when none is left
//	a send fails (the messagebox's error:      a `message` → an error tool result, run the
//	  delivery is inside the step, #40)        next call (a transient one is tried again
//	                                           first: below); the `infer` → an error, answered
//	                                           as an inference error; the answer → an error
//	                                           turn, and the thread ends (no reply can come)
//	woken (a retry's deadline came)            run the pending `message` call again
//
// Retries: a `message` whose delivery fails with a transient error (the
// messagebox's "transient: …": no answer, 5xx, 408, 425, 429 — or the
// resolve's) is tried again after a while: the step keeps a note beside the
// turns, {kind: "retry", of: <entry>, call, to, attempt, error}, and rests on
// a deadline (the kernel's `deadline`, deadline.go) `defaults.sendRetryMs` ahead (default 30 s);
// the wake runs the call again. After `defaults.sendAttempts` attempts
// (default 3) it is an error tool result for the model, as a permanent
// failure is at once.
package main

import (
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/fxamacker/cbor/v2"
	"github.com/shruggr/skein/programs/skein"
)

const system = "You are working with David through skein. Use the bash tool to run commands over the working tree; when you are done or need David, answer in plain text; keep answers short."

const defaultModel = "ripper/qwen38"

const outputCap = 16 << 10

// A transient `message` failure: this many attempts in all, this far apart (defaults.sendAttempts, defaults.sendRetryMs).
const (
	sendAttempts = 3
	sendRetryMs  = 30_000
)

type args struct {
	Message  skein.CID `cbor:"message"`
	Body     skein.CID `cbor:"body"`
	Box      string    `cbor:"box"`
	Sender   skein.Key `cbor:"sender"`
}

// chatBody is every `chat`, both directions: a new conversation (no replyTo)
// or a reply. The loop's answer at the end of a turn also names its working
// tree and its thread.
type chatBody struct {
	Text     string    `cbor:"text"`
	Tree     skein.CID `cbor:"tree,omitzero"`
	Model    string    `cbor:"model,omitempty"`
	Thinking string    `cbor:"thinking,omitempty"`
	Thread   skein.CID `cbor:"thread,omitzero"`
	ReplyTo  skein.CID `cbor:"replyTo,omitzero"`
	// The opener's notes on a page the model presented (issue #19).
	Annotations []userNote `cbor:"annotations,omitempty"`
}

// userNote is an annotation as a chat carries it, and as its user turn keeps it.
type userNote struct {
	Present skein.CID `cbor:"present"`
	Block   string    `cbor:"block,omitempty"`
	Note    string    `cbor:"note"`
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
	Missing []skein.CID       `cbor:"missing,omitempty"`
}

// turn is every turn the loop keeps; Role says which fields apply.
type turn struct {
	Kind      string          `cbor:"kind"`
	Parent    skein.CID       `cbor:"parent,omitzero"`
	Of        skein.CID       `cbor:"of"`
	Role      string          `cbor:"role,omitempty"`
	Text      string          `cbor:"text,omitempty"`
	Tree      skein.CID       `cbor:"tree,omitzero"`
	Model     string          `cbor:"model,omitempty"`
	Thinking  string          `cbor:"thinking,omitempty"`
	Content   string          `cbor:"content,omitempty"`
	Reasoning string          `cbor:"reasoning,omitempty"`
	ToolCalls []toolCall      `cbor:"tool_calls,omitempty"`
	Ms        int64           `cbor:"ms,omitempty"`
	Usage     cbor.RawMessage `cbor:"usage,omitempty"`
	Call      string          `cbor:"call,omitempty"`
	To        string          `cbor:"to,omitempty"`
	Sent      skein.CID       `cbor:"sent,omitzero"`
	ExitCode  *int            `cbor:"exitCode,omitempty"`
	Stdout    *string         `cbor:"stdout,omitempty"`
	Stderr    *string         `cbor:"stderr,omitempty"`
	Error     string          `cbor:"error,omitempty"`
	Missing   []skein.CID     `cbor:"missing,omitempty"`
	// user turns: the chat's annotations
	Annotations []userNote `cbor:"annotations,omitempty"`
}

// record is what the loop sends on the turn stream (and, for say, present and
// annotation, keeps); Kind says which fields apply.
type record struct {
	Kind     string           `cbor:"kind"`
	Of       skein.CID        `cbor:"of"`
	By       string           `cbor:"by,omitempty"`
	Call     string           `cbor:"call,omitempty"`
	Name     string           `cbor:"name,omitempty"`
	Event    string           `cbor:"event,omitempty"`
	Text     string           `cbor:"text,omitempty"`
	Page     string           `cbor:"page,omitempty"`
	Blocks   []map[string]any `cbor:"blocks,omitempty"`
	Present  skein.CID        `cbor:"present,omitzero"`
	Block    string           `cbor:"block,omitempty"`
	Note     string           `cbor:"note,omitempty"`
	ExitCode *int             `cbor:"exitCode,omitempty"`
	Tree     skein.CID        `cbor:"tree,omitzero"`
	Error    string           `cbor:"error,omitempty"`
}

// The `infer` body: the turns new since the last request, as kept (their
// stored bytes, so the peer keys them by the same CIDs), the node the first
// extends, the model and thinking for this request, and the tool definitions.
type inferBody struct {
	Model    string            `cbor:"model"`
	Thinking string            `cbor:"thinking,omitempty"`
	Tools    []any             `cbor:"tools,omitempty"`
	Parent   skein.CID         `cbor:"parent,omitzero"`
	Nodes    []cbor.RawMessage `cbor:"nodes"`
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

var messageTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "message",
		"description": "Message a colleague — another agent — and wait for their answer. `to` is their handle, @handle@domain; `text` is what you want to tell or ask them. Their reply comes back as the result.",
		"parameters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"to":   map[string]any{"type": "string", "description": "their handle, @handle@domain"},
				"text": map[string]any{"type": "string", "description": "what to say"},
			},
			"required": []string{"to", "text"},
		},
	},
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

// The optional tools (issue #19), offered in this order when defaults.tools names them.
var optionalTools = []string{"say", "present", "annotate"}

var sayTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "say",
		"description": "Say a line aloud to the person you are talking with, now, while you work. Only where the conversation calls for it (a voice channel is established); your answer at the end of the turn is still your plain-text reply.",
		"parameters": map[string]any{
			"type":       "object",
			"properties": map[string]any{"text": map[string]any{"type": "string", "description": "the line to say"}},
			"required":   []string{"text"},
		},
	},
}

var presentTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "present",
		"description": "Show the person a page (markdown or HTML) to discuss. Only when you are discussing something that is better seen than said. The page stays in the conversation by its CID (the result); give blocks ids so you and they can annotate parts of it.",
		"parameters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"page": map[string]any{"type": "string", "description": "the page: markdown or HTML"},
				"blocks": map[string]any{
					"type":        "array",
					"description": "the page's annotatable parts, each with a unique id",
					"items": map[string]any{
						"type":       "object",
						"properties": map[string]any{"id": map[string]any{"type": "string"}},
						"required":   []string{"id"},
					},
				},
			},
			"required": []string{"page"},
		},
	},
}

var annotateTool = map[string]any{
	"type": "function",
	"function": map[string]any{
		"name":        "annotate",
		"description": "Add a note to a page presented in this conversation, on one of its blocks.",
		"parameters": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"present": map[string]any{"type": "string", "description": "the page's CID, as `present` returned it"},
				"block":   map[string]any{"type": "string", "description": "the block's id"},
				"note":    map[string]any{"type": "string", "description": "the note"},
			},
			"required": []string{"present", "note"},
		},
	},
}

var toolDefs = map[string]any{"say": sayTool, "present": presentTool, "annotate": annotateTool}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "loop:", err)
		os.Exit(1)
	}
}

// loop is one step's view: its input, the thread's args, the conversation so
// far (its turns and their CIDs), and the kind of the last record kept.
type loop struct {
	step *skein.Step
	a    args
	conv []turn
	cids []skein.CID
	last string
	// the pages presented in this thread: their CIDs and block ids
	presents []presented
	// the retry notes kept: which call, and how many turns the conversation had then
	retries []retryMark
}

type retryMark struct {
	call  string
	turns int
}

// retryNote is the record kept when a `message` delivery failed transiently and is tried again.
type retryNote struct {
	Kind    string    `cbor:"kind"`
	Of      skein.CID `cbor:"of"`
	Call    string    `cbor:"call"`
	To      string    `cbor:"to"`
	Attempt int       `cbor:"attempt"`
	Error   string    `cbor:"error"`
}

type presented struct {
	cid    skein.CID
	blocks []string
}

// enabled: whether defaults.tools names this optional tool.
func (l *loop) enabled(tool string) bool {
	for _, t := range strings.FieldsFunc(l.step.Defaults["tools"], func(r rune) bool { return r == ',' || r == ' ' }) {
		if t == tool {
			return true
		}
	}
	return false
}

// streaming: whether defaults.stream turns the non-model kinds on.
func (l *loop) streaming() bool {
	switch l.step.Defaults["stream"] {
	case "on", "true", "1", "yes":
		return true
	}
	return false
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
			l.last = r.Kind
			switch r.Kind {
			case "turn":
				l.conv = append(l.conv, r)
				l.cids = append(l.cids, c)
			case "present":
				var p record
				if err := skein.Decode(b, &p); err != nil {
					return fmt.Errorf("present: %w", err)
				}
				l.presents = append(l.presents, presented{cid: c, blocks: blockIDs(p.Blocks)})
			case "retry":
				l.retries = append(l.retries, retryMark{call: r.Call, turns: len(l.conv)})
			}
		}
	}
	switch {
	case step.Reply != nil && step.Reply.Box == "completions":
		return l.completion(step.Reply)
	case step.Reply != nil && l.messaging() != nil:
		return l.messageDone(step.Reply)
	case step.Reply != nil:
		return l.chat(step.Reply.Message, step.Reply.Body)
	case len(step.Resolved) > 0:
		return l.toolDone(step.Resolved[0])
	case step.Woke:
		// A retry's deadline: the pending `message` call again.
		return l.next()
	default:
		return l.chat(l.a.Message, l.a.Body)
	}
}

// keep a turn: the next node of the conversation, its parent the last one.
func (l *loop) keep(r turn) error {
	_, err := l.keepTurn(r)
	return err
}

// keepTurn is keep, returning the turn's CID.
func (l *loop) keepTurn(r turn) (skein.CID, error) {
	r.Kind = "turn"
	if n := len(l.cids); n > 0 {
		r.Parent = l.cids[n-1]
	}
	c, err := l.put(r.Kind, r)
	if err != nil {
		return nil, err
	}
	l.conv = append(l.conv, r)
	l.cids = append(l.cids, c)
	return c, nil
}

// put and keep a record (a turn, a note beside the turns, an artefact).
func (l *loop) put(kind string, r any) (skein.CID, error) {
	c, err := skein.Put(r)
	if err != nil {
		return nil, fmt.Errorf("put %s: %w", kind, err)
	}
	if err := skein.Keep(c); err != nil {
		return nil, fmt.Errorf("keep: %w", err)
	}
	l.last = kind
	return c, nil
}

// fail keeps an error turn and sends it on the turn stream.
func (l *loop) fail(of skein.CID, msg string) error {
	c, err := l.keepTurn(turn{Of: of, Role: "error", Error: msg})
	if err != nil {
		return err
	}
	if l.streaming() {
		return l.stream(record{Kind: "error", Of: c, Error: msg})
	}
	return nil
}

// result keeps a tool call's result turn and logs the call finished.
func (l *loop) result(call toolCall, t turn) error {
	t.Role, t.Call = "tool", call.ID
	c, err := l.keepTurn(t)
	if err != nil {
		return err
	}
	if !l.streaming() {
		return nil
	}
	return l.stream(record{Kind: "log", Of: c, Call: call.ID, Name: call.Function.Name, Event: "finished", ExitCode: t.ExitCode, Tree: t.Tree, Error: t.Error})
}

// started logs a tool call started.
func (l *loop) started(call toolCall) error {
	if !l.streaming() {
		return nil
	}
	return l.stream(record{Kind: "log", Of: l.lastAssistantCID(), Call: call.ID, Name: call.Function.Name, Event: "started"})
}

// stream sends a record to the opener in their `turn` box: a message, not awaited.
// A record that cannot be delivered is noted on stderr and the turn goes on.
func (l *loop) stream(r record) error {
	if _, err := skein.Send(l.step, l.a.Sender, "turn", r, "", ""); err != nil {
		fmt.Fprintln(os.Stderr, "loop: turn stream:", err)
	}
	return nil
}

// chat: the opener's line (the opening one, or their reply to our answer).
func (l *loop) chat(message, body skein.CID) error {
	_, plain, err := skein.Read(message, body)
	if err != nil {
		return err
	}
	var b chatBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("chat body: %w", err)
	}
	if len(l.conv) == 0 {
		// A new conversation that names no tree starts from `main`, if there is one.
		if len(b.Tree) == 0 {
			if b.Tree, err = skein.Head("main"); err != nil {
				return err
			}
		}
		// Its system prompt, from that tree, kept for the whole conversation.
		of := b.Tree
		if len(of) == 0 {
			of = skein.EmptyTree
			if err := skein.PutBlock(of, skein.EmptyTreeObject); err != nil {
				return err
			}
		}
		if err := l.keep(turn{Of: of, Role: "system", Content: prompt(b.Tree)}); err != nil {
			return err
		}
	}
	user, err := l.keepTurn(turn{Of: message, Role: "user", Text: b.Text, Tree: b.Tree, Model: b.Model, Thinking: b.Thinking, Annotations: b.Annotations})
	if err != nil {
		return err
	}
	// The opener's annotations: each a record of its own, kept beside the turn
	// (which carries them into the prompt), and streamed back with its CID.
	for _, a := range b.Annotations {
		r := record{Kind: "annotation", Of: user, By: "user", Present: a.Present, Block: a.Block, Note: a.Note}
		if _, err := l.put(r.Kind, r); err != nil {
			return err
		}
		if l.streaming() {
			if err := l.stream(r); err != nil {
				return err
			}
		}
	}
	return l.infer(false)
}

// completion: the inference peer's answer to our `infer`.
func (l *loop) completion(r *skein.Answer) error {
	_, plain, err := skein.Read(r.Message, r.Body)
	if err != nil {
		return err
	}
	var b completionBody
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("completion body: %w", err)
	}
	if len(b.Missing) > 0 && b.Error == "" {
		// The peer lost the conversation (a restart, an eviction): send it
		// all, once. `missing` for a request that already carried it all —
		// the first of the conversation (no assistant turn yet), or the
		// resend itself — is an error.
		if l.last != "missing" && l.lastAssistant() != nil {
			if _, err := l.put("missing", turn{Kind: "missing", Of: r.Message, Missing: b.Missing}); err != nil {
				return err
			}
			return l.infer(true)
		}
		b.Error = fmt.Sprintf("the inference peer is missing %d node(s) after the whole conversation was sent", len(b.Missing))
	}
	if b.Error != "" || b.Message == nil {
		msg := b.Error
		if msg == "" {
			msg = "completion has no message"
		}
		if err := l.fail(r.Message, msg); err != nil {
			return err
		}
		return l.answer("inference failed: " + msg)
	}
	m := b.Message
	c, err := l.keepTurn(turn{Of: r.Message, Role: "assistant", Content: m.Content, Reasoning: m.Reasoning, ToolCalls: m.ToolCalls, Model: b.Model, Ms: b.Ms, Usage: b.Usage})
	if err != nil {
		return err
	}
	if l.streaming() && m.Reasoning != "" {
		if err := l.stream(record{Kind: "thinking", Of: c, Text: m.Reasoning}); err != nil {
			return err
		}
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
	if err := l.result(call, turn{Of: res.Thread, ExitCode: &code, Stdout: &stdout, Stderr: &stderr, Tree: tree}); err != nil {
		return err
	}
	return l.next()
}

// next: run the next pending tool call; when none is left, ask the model again
// if the last answer called tools, else answer with its content.
func (l *loop) next() error {
	for _, call := range l.pending() {
		attempt := l.attempt(call.ID)
		if attempt == 1 {
			if err := l.started(call); err != nil {
				return err
			}
		}
		if call.Function.Name == "message" {
			to, h, d, text, msg := messageArgs(call)
			if msg == "" {
				key, err := skein.Resolve(l.step, h, d)
				if err == nil {
					var sent skein.CID
					if sent, err = l.message(key, h, d, text); err == nil {
						return skein.Await(sent)
					}
				}
				if skein.Transient(err) && attempt < l.setting("sendAttempts", sendAttempts) {
					return l.retry(call, to, attempt, err)
				}
				msg = "could not deliver to " + to + ": " + err.Error()
				if attempt > 1 {
					msg += fmt.Sprintf(" (%d attempts)", attempt)
				}
			}
			if err := l.result(call, turn{Of: l.step.Entry, To: to, Error: msg}); err != nil {
				return err
			}
			continue
		}
		if l.enabled(call.Function.Name) && toolDefs[call.Function.Name] != nil {
			if err := l.artefact(call); err != nil {
				return err
			}
			continue
		}
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
		if err := l.result(call, turn{Of: l.step.Entry, ExitCode: &code, Stdout: &empty, Stderr: &msg, Tree: l.tree()}); err != nil {
			return err
		}
	}
	last := l.lastAssistant()
	if last != nil && len(last.ToolCalls) > 0 {
		return l.infer(false)
	}
	text := ""
	if last != nil {
		text = last.Content
	}
	return l.answer(text)
}

// attempt: which attempt at tool call `id` of the latest assistant turn this is (1 + its retry notes since).
func (l *loop) attempt(id string) int {
	last := -1
	for i, r := range l.conv {
		if r.Role == "assistant" {
			last = i
		}
	}
	n := 1
	for _, m := range l.retries {
		if m.call == id && m.turns > last {
			n++
		}
	}
	return n
}

// setting: a positive integer from the genesis defaults, else def.
func (l *loop) setting(name string, def int) int {
	if v, err := strconv.Atoi(l.step.Defaults[name]); err == nil && v > 0 {
		return v
	}
	return def
}

// retry: a `message` delivery failed transiently: keep a note of it and rest
// until the retry's deadline; the wake runs the call again (next).
func (l *loop) retry(call toolCall, to string, attempt int, cause error) error {
	if _, err := l.put("retry", retryNote{Kind: "retry", Of: l.step.Entry, Call: call.ID, To: to, Attempt: attempt, Error: cause.Error()}); err != nil {
		return err
	}
	l.retries = append(l.retries, retryMark{call: call.ID, turns: len(l.conv)})
	wait := l.setting("sendRetryMs", sendRetryMs)
	fmt.Fprintf(os.Stderr, "loop: message to %s: attempt %d failed (%v); again in %d ms\n", to, attempt, cause, wait)
	return deadline(l.step.At + int64(wait))
}

// messageArgs: a `message` call's arguments — the handle as "@handle@domain"
// and its parts, the text — or what is wrong with them.
func messageArgs(call toolCall) (to, handle, domain, text, problem string) {
	var a struct {
		To   string `json:"to"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(call.Function.Arguments), &a); err != nil || a.Text == "" {
		return "", "", "", "", "message wants {\"to\": \"@handle@domain\", \"text\": string}"
	}
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(a.To), "@"), "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return a.To, "", "", "", "message: `to` must be a handle, @handle@domain, not " + strconv.Quote(a.To)
	}
	return "@" + parts[0] + "@" + parts[1], parts[0], parts[1], a.Text, ""
}

// message: a `chat` to another party (the identity its handle resolved to),
// delivered over http by the messagebox (#40); the caller rests on the reply,
// as on an `infer`. If this thread already has a conversation with that
// identity — it opened the thread, or answered one of our messages — the chat
// is a reply to their latest message here, so their waiting thread resumes
// with it; else it starts a new conversation.
func (l *loop) message(key skein.Key, handle, domain, text string) (skein.CID, error) {
	replyTo, err := l.latestFrom(key.Hex())
	if err != nil {
		return nil, err
	}
	return skein.Send(l.step, key, "chat", chatBody{Text: text, ReplyTo: replyTo}, handle, domain)
}

// latestFrom: the latest message this thread received from identity `key` —
// the opener's chats (user turns) and the answers to our messages (tool turns
// with `sent`) — or nil if it has none.
func (l *loop) latestFrom(key string) (skein.CID, error) {
	var latest skein.CID
	for _, r := range l.conv {
		if r.Role != "user" && !(r.Role == "tool" && len(r.Sent) > 0) {
			continue
		}
		m, err := skein.ReadMessage(r.Of)
		if err != nil {
			return nil, err
		}
		if m.Sender.Hex() == key {
			latest = r.Of
		}
	}
	return latest, nil
}

// messaging: the `message` call this thread rests on, if it rests on one (the
// first pending call is a message; the step that emitted it awaited the answer).
func (l *loop) messaging() *toolCall {
	p := l.pending()
	if len(p) == 0 || p[0].Function.Name != "message" {
		return nil
	}
	return &p[0]
}

// messageDone: the other party's reply to our message: kept as its tool result.
func (l *loop) messageDone(r *skein.Answer) error {
	call := l.messaging()
	to, _, _, _, _ := messageArgs(*call)
	_, plain, err := skein.Read(r.Message, r.Body)
	if err != nil {
		return err
	}
	var b struct {
		Text string `cbor:"text"`
	}
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("message answer: %w", err)
	}
	if err := l.result(*call, turn{Of: r.Message, To: to, Sent: r.ReplyTo, Text: b.Text}); err != nil {
		return err
	}
	return l.next()
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

// infer: ask the inference peer for the next completion; rest on it. The
// request carries the turns from the latest assistant turn on — the peer holds
// everything up to that turn's parent, the last node of the request it
// answered — or, the first time and when `all`, the whole conversation.
// `model` and `thinking`: the latest user turn's, else the genesis defaults.
func (l *loop) infer(all bool) error {
	peer := l.step.Peers["infer"]
	if len(peer) == 0 {
		return l.answer("no inference peer is configured (genesis peers.infer)")
	}
	model, thinking := l.step.Defaults["model"], l.step.Defaults["thinking"]
	if model == "" {
		model = defaultModel
	}
	for i := len(l.conv) - 1; i >= 0; i-- {
		if r := l.conv[i]; r.Role == "user" {
			if r.Model != "" {
				model = r.Model
			}
			if r.Thinking != "" {
				thinking = r.Thinking
			}
			break
		}
	}
	from, parent := 0, skein.CID(nil)
	if !all {
		for i := len(l.conv) - 1; i >= 0; i-- {
			if l.conv[i].Role == "assistant" {
				from, parent = i, l.conv[i].Parent
				break
			}
		}
	}
	tools := []any{bashTool, messageTool}
	for _, t := range optionalTools {
		if l.enabled(t) {
			tools = append(tools, toolDefs[t])
		}
	}
	body := inferBody{Model: model, Thinking: thinking, Tools: tools, Parent: parent}
	for _, c := range l.cids[from:] {
		b, err := skein.Get(c)
		if err != nil {
			return fmt.Errorf("get turn: %w", err)
		}
		body.Nodes = append(body.Nodes, b)
	}
	n, _ := l.step.NameOf(peer.Hex())
	sent, err := skein.Send(l.step, peer, "infer", body, n.Handle, n.Domain)
	if err != nil {
		msg := "could not deliver to the inference peer: " + err.Error()
		if err := l.fail(l.step.Entry, msg); err != nil {
			return err
		}
		return l.answer("inference failed: " + msg)
	}
	return skein.Await(sent)
}

// answer: the turn's answer to the opener — a `chat` replying to their latest
// message in this thread (the chat that opened the turn, or their reply to a
// message) — then rest on their reply, which continues the conversation.
func (l *loop) answer(text string) error {
	replyTo, err := l.latestFrom(l.a.Sender.Hex())
	if err != nil {
		return err
	}
	if len(replyTo) == 0 {
		replyTo = l.a.Message
	}
	sent, err := skein.Send(l.step, l.a.Sender, "chat", chatBody{Text: text, Tree: l.tree(), Thread: l.step.Thread, ReplyTo: replyTo}, "", "")
	if err != nil {
		// The reply this turn would rest on cannot come: note it, and the thread ends.
		return l.fail(l.step.Entry, "could not deliver the answer: "+err.Error())
	}
	return skein.Await(sent)
}

// lastAssistantCID: the latest assistant turn's CID (what a tool call is of).
func (l *loop) lastAssistantCID() skein.CID {
	for i := len(l.conv) - 1; i >= 0; i-- {
		if l.conv[i].Role == "assistant" {
			return l.cids[i]
		}
	}
	return nil
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

// prompt: a new conversation's system prompt, from the tree it starts on:
// /SOUL.md (else the fixed one), then /IDENTITY.md and /ROSTER.md after it,
// each if there is one. A tree that cannot be read counts as having none.
func prompt(tree skein.CID) string {
	p := system
	if len(tree) == 0 {
		return p
	}
	if soul, ok, err := skein.ReadFile(tree, "SOUL.md"); err == nil && ok {
		p = string(soul)
	}
	for _, name := range []string{"IDENTITY.md", "ROSTER.md"} {
		if f, ok, err := skein.ReadFile(tree, name); err == nil && ok {
			p = strings.TrimRight(p, "\n") + "\n\n" + string(f)
		}
	}
	return p
}

func capText(b []byte) string {
	if len(b) <= outputCap {
		return string(b)
	}
	return fmt.Sprintf("%s\n… (%d more bytes)", b[:outputCap], len(b)-outputCap)
}

func isEmptyTree(c skein.CID) bool { return string(c) == string(skein.EmptyTree) }

// artefact runs a say, present or annotate call: put its record, keep it,
// send it to the opener in `turn`, and answer the model with its CID (and a
// present's block ids). Bad arguments are an error result, and nothing is sent.
func (l *loop) artefact(call toolCall) error {
	var a struct {
		Text    string           `json:"text"`
		Page    string           `json:"page"`
		Blocks  []map[string]any `json:"blocks"`
		Present string           `json:"present"`
		Block   string           `json:"block"`
		Note    string           `json:"note"`
	}
	r := record{Kind: call.Function.Name, Of: l.lastAssistantCID(), Call: call.ID}
	problem := ""
	if err := json.Unmarshal([]byte(call.Function.Arguments), &a); err != nil {
		problem = call.Function.Name + ": arguments are not a JSON object: " + err.Error()
	}
	switch {
	case problem != "":
	case call.Function.Name == "say":
		if a.Text == "" {
			problem = "say wants {\"text\": string}"
		}
		r.Text = a.Text
	case call.Function.Name == "present":
		if a.Page == "" {
			problem = "present wants {\"page\": string, \"blocks\"?: [{\"id\": string, …}]}"
		} else if msg := checkBlocks(a.Blocks); msg != "" {
			problem = "present: " + msg
		}
		r.Page, r.Blocks = a.Page, normalize(a.Blocks)
	default: // annotate
		r.Kind, r.By, r.Block, r.Note = "annotation", "model", a.Block, a.Note
		if a.Present == "" || a.Note == "" {
			problem = "annotate wants {\"present\": <cid>, \"block\"?: string, \"note\": string}"
			break
		}
		p := l.presented(a.Present)
		if p == nil {
			problem = "annotate: no page " + strconv.Quote(a.Present) + " was presented in this conversation"
			break
		}
		if a.Block != "" && len(p.blocks) > 0 && !contains(p.blocks, a.Block) {
			problem = "annotate: the page has no block " + strconv.Quote(a.Block) + " (its blocks: " + strings.Join(p.blocks, ", ") + ")"
			break
		}
		r.Present = p.cid
	}
	if problem != "" {
		return l.result(call, turn{Of: l.step.Entry, Error: problem})
	}
	c, err := l.put(r.Kind, r)
	if err != nil {
		return err
	}
	if r.Kind == "present" {
		l.presents = append(l.presents, presented{cid: c, blocks: blockIDs(r.Blocks)})
	}
	if err := l.stream(r); err != nil {
		return err
	}
	out := map[string]any{r.Kind: cidString(c)}
	if r.Kind == "present" {
		out["blocks"] = blockIDs(r.Blocks)
	}
	text, err := json.Marshal(out)
	if err != nil {
		return err
	}
	return l.result(call, turn{Of: c, Text: string(text)})
}

// presented: the page presented in this thread whose CID is s, or nil.
func (l *loop) presented(s string) *presented {
	for i := range l.presents {
		if cidString(l.presents[i].cid) == strings.TrimSpace(s) {
			return &l.presents[i]
		}
	}
	return nil
}

// checkBlocks: what is wrong with a present's blocks, or "".
func checkBlocks(blocks []map[string]any) string {
	seen := map[string]bool{}
	for i, b := range blocks {
		id, ok := b["id"].(string)
		if !ok || id == "" {
			return fmt.Sprintf("block %d has no string id", i)
		}
		if seen[id] {
			return "two blocks have the id " + strconv.Quote(id)
		}
		seen[id] = true
	}
	return ""
}

// blockIDs: the blocks' ids, in order.
func blockIDs(blocks []map[string]any) []string {
	ids := []string{}
	for _, b := range blocks {
		if id, ok := b["id"].(string); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// normalize JSON values for dag-cbor: a whole number is an integer (as the
// runtime's re-encoding would make it), not a float.
func normalize(blocks []map[string]any) []map[string]any {
	var fix func(v any) any
	fix = func(v any) any {
		switch x := v.(type) {
		case float64:
			if x == float64(int64(x)) {
				return int64(x)
			}
		case []any:
			for i := range x {
				x[i] = fix(x[i])
			}
		case map[string]any:
			for k := range x {
				x[k] = fix(x[k])
			}
		}
		return v
	}
	for _, b := range blocks {
		fix(b)
	}
	return blocks
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// cidString: a binary CIDv1 as its base32 string ("b…"), as the model reads it.
func cidString(c skein.CID) string {
	return "b" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(c))
}
