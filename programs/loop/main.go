// loop: the turn loop (README.md, "Records"; docs/MESSAGES.md), launched by a
// subscription (…, chat) → loop with the opening `chat` envelope as its input:
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
//	user       {of: <chat envelope>, role: "user", text, tree?, model?, thinking?}   (the opener's)
//	assistant  {of: <completions envelope>, role: "assistant", content?, reasoning?, tool_calls?, model, ms?, usage?}
//	tool       {of: <shell thread>, role: "tool", call, exitCode, stdout, stderr, tree}   (bash; outputs capped at 16 KiB)
//	tool       {of: <their chat reply>, role: "tool", call, to, sent: <our chat envelope>, text}   (message)
//	tool       {of: <entry>, role: "tool", call, to?, error}   (a message that could not be sent, or delivered)
//	error      {of: <completions envelope | outcome entry>, role: "error", error}
//
// Kept beside the turns, not one of them: {kind: "missing", of: <completions
// envelope>, missing: [<node>]} — the peer did not hold a node we named.
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
// Everything the loop sends a party is a `chat` — the same envelope in both
// directions — and it rests on the reply. A chat to a party this thread
// already has a conversation with (it opened the thread, or replied to one of
// our messages) is a reply to that party's latest envelope here (latestFrom),
// so their waiting thread resumes with it; a chat to anyone else starts a new
// conversation (no replyTo). A conversation is pairwise; two agents talking
// alternate on one thread each.
//
// Tools: `bash` (a command in the shell over the working tree) and `message`
// ({to: "@handle@domain", text}: a `chat` to another party, sealed to the
// identity the handle resolves to through the host — skein.Resolve, attested
// — then rest on the reply as on an `infer`; their reply is the tool result).
// Calls run one at a time, in order.
//
// The answer: a turn ends with a `chat` to the opener, {text, tree, thread,
// replyTo: <their latest envelope>}, and rests on their reply; that reply is
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
//	an awaited envelope was not delivered      (the host's `failed` outcome) a `message` →
//	                                           an error tool result, run the next call; the
//	                                           `infer` → an error, answered as an inference
//	                                           error; the answer → an error turn, and the
//	                                           thread ends (no reply can come)
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/fxamacker/cbor/v2"
	"github.com/shruggr/skein/programs/envelope"
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
			if r.Kind == "turn" {
				l.conv = append(l.conv, r)
				l.cids = append(l.cids, c)
			}
		}
	}
	switch {
	case step.Failed != nil:
		return l.undelivered(step.Failed)
	case step.Reply != nil && step.Reply.Box == "completions":
		return l.completion(step.Reply)
	case step.Reply != nil && l.messaging() != nil:
		return l.messageDone(step.Reply)
	case step.Reply != nil:
		return l.chat(step.Reply.Envelope, step.Reply.Body)
	case len(step.Resolved) > 0:
		return l.toolDone(step.Resolved[0])
	default:
		return l.chat(l.a.Envelope, l.a.Body)
	}
}

// keep a turn: the next node of the conversation, its parent the last one.
func (l *loop) keep(r turn) error {
	r.Kind = "turn"
	if n := len(l.cids); n > 0 {
		r.Parent = l.cids[n-1]
	}
	c, err := l.put(r)
	if err != nil {
		return err
	}
	l.conv = append(l.conv, r)
	l.cids = append(l.cids, c)
	return nil
}

// put and keep a record (a turn, or a note beside the turns).
func (l *loop) put(r turn) (skein.CID, error) {
	c, err := skein.Put(r)
	if err != nil {
		return nil, fmt.Errorf("put %s: %w", r.Kind, err)
	}
	if err := skein.Keep(c); err != nil {
		return nil, fmt.Errorf("keep: %w", err)
	}
	l.last = r.Kind
	return c, nil
}

// chat: the opener's line (the opening one, or their reply to our answer).
func (l *loop) chat(envelope, body skein.CID) error {
	_, plain, err := skein.Read(envelope, body)
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
	if err := l.keep(turn{Of: envelope, Role: "user", Text: b.Text, Tree: b.Tree, Model: b.Model, Thinking: b.Thinking}); err != nil {
		return err
	}
	return l.infer(false)
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
	if len(b.Missing) > 0 && b.Error == "" {
		// The peer lost the conversation (a restart, an eviction): send it
		// all, once. `missing` for a request that already carried it all —
		// the first of the conversation (no assistant turn yet), or the
		// resend itself — is an error.
		if l.last != "missing" && l.lastAssistant() != nil {
			if _, err := l.put(turn{Kind: "missing", Of: r.Envelope, Missing: b.Missing}); err != nil {
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
		if err := l.keep(turn{Of: r.Envelope, Role: "error", Error: msg}); err != nil {
			return err
		}
		return l.answer("inference failed: " + msg)
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
// if the last answer called tools, else answer with its content.
func (l *loop) next() error {
	for _, call := range l.pending() {
		if call.Function.Name == "message" {
			to, h, d, text, msg := messageArgs(call)
			if msg == "" {
				key, err := skein.Resolve(h, d)
				if err == nil {
					return l.message(key, to, h, d, text)
				}
				msg = err.Error()
			}
			if err := l.keep(turn{Of: l.step.Entry, Role: "tool", Call: call.ID, To: to, Error: msg}); err != nil {
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
		if err := l.keep(turn{Of: l.step.Entry, Role: "tool", Call: call.ID, ExitCode: &code, Stdout: &empty, Stderr: &msg, Tree: l.tree()}); err != nil {
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

// message: a `chat` to another agent (sealed to the identity its handle
// resolved to); rest on their reply, as on an `infer`. If this thread already
// has a conversation with that identity — it opened the thread, or answered
// one of our messages — the chat is a reply to their latest envelope here, so
// their waiting thread resumes with it; else it starts a new conversation.
func (l *loop) message(key, to, handle, domain, text string) error {
	replyTo, err := l.latestFrom(key)
	if err != nil {
		return err
	}
	env, err := envelope.Send(key, handle, domain, "chat", chatBody{Text: text, ReplyTo: replyTo})
	if err != nil {
		return err
	}
	return skein.Await(env)
}

// latestFrom: the latest envelope this thread received from identity `key` —
// the opener's chats (user turns) and the answers to our messages (tool turns
// with `sent`) — or nil if it has none.
func (l *loop) latestFrom(key string) (skein.CID, error) {
	var latest skein.CID
	for _, r := range l.conv {
		if r.Role != "user" && !(r.Role == "tool" && len(r.Sent) > 0) {
			continue
		}
		raw, err := skein.Get(r.Of)
		if err != nil {
			return nil, fmt.Errorf("get envelope: %w", err)
		}
		var env skein.Envelope
		if err := skein.Decode(raw, &env); err != nil {
			return nil, fmt.Errorf("envelope record: %w", err)
		}
		if env.Sender.IdentityKey == key {
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

// undelivered: the host could not deliver what this thread rests on. A
// `message` becomes an error result for the model ("could not deliver to
// @h@d: reason"), as an unresolvable handle is; the `infer`, an inference
// error answered to the opener; the answer itself is noted and the turn ends:
// the thread finishes, since the reply it awaited cannot come.
func (l *loop) undelivered(f *skein.DeliveryFailed) error {
	if call := l.messaging(); call != nil && f.Box == "chat" {
		to, _, _, _, _ := messageArgs(*call)
		if err := l.keep(turn{Of: l.step.Entry, Role: "tool", Call: call.ID, To: to, Error: "could not deliver to " + to + ": " + f.Reason}); err != nil {
			return err
		}
		return l.next()
	}
	if f.Box == "infer" {
		msg := "could not deliver to the inference peer: " + f.Reason
		if err := l.keep(turn{Of: l.step.Entry, Role: "error", Error: msg}); err != nil {
			return err
		}
		return l.answer("inference failed: " + msg)
	}
	return l.keep(turn{Of: l.step.Entry, Role: "error", Error: "could not deliver the answer: " + f.Reason})
}

// messageDone: the other party's reply to our message: kept as its tool result.
func (l *loop) messageDone(r *skein.Answer) error {
	call := l.messaging()
	to, _, _, _, _ := messageArgs(*call)
	_, plain, err := skein.Read(r.Envelope, r.Body)
	if err != nil {
		return err
	}
	var b struct {
		Text string `cbor:"text"`
	}
	if err := skein.Decode(plain, &b); err != nil {
		return fmt.Errorf("message answer: %w", err)
	}
	if err := l.keep(turn{Of: r.Envelope, Role: "tool", Call: call.ID, To: to, Sent: r.ReplyTo, Text: b.Text}); err != nil {
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
	if peer == "" {
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
	body := inferBody{Model: model, Thinking: thinking, Tools: []any{bashTool, messageTool}, Parent: parent}
	for _, c := range l.cids[from:] {
		b, err := skein.Get(c)
		if err != nil {
			return fmt.Errorf("get turn: %w", err)
		}
		body.Nodes = append(body.Nodes, b)
	}
	env, err := envelope.Send(peer, "", "", "infer", body)
	if err != nil {
		return err
	}
	return skein.Await(env)
}

// answer: the turn's answer to the opener — a `chat` replying to their latest
// envelope in this thread (the chat that opened the turn, or their reply to a
// message) — then rest on their reply, which continues the conversation.
func (l *loop) answer(text string) error {
	replyTo, err := l.latestFrom(l.a.Sender)
	if err != nil {
		return err
	}
	if len(replyTo) == 0 {
		replyTo = l.a.Envelope
	}
	opening, err := skein.Get(l.a.Envelope)
	if err != nil {
		return err
	}
	var env skein.Envelope
	if err := skein.Decode(opening, &env); err != nil {
		return err
	}
	c, err := envelope.Send(l.a.Sender, env.Sender.Handle, env.Sender.Domain, "chat", chatBody{Text: text, Tree: l.tree(), Thread: l.step.Thread, ReplyTo: replyTo})
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
