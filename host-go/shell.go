package host

// The wasm shell (src/runtime/shell.ts): brush running uutils coreutils, all
// over a copy-on-write view of a git-shaped tree. brush is patched
// (wasm/README.md) to ask the host to run external commands through the
// "skein" import module; each one runs to completion as a fresh instance, in a
// store of its own, sharing the filesystem view. Pipelines run stage by stage
// with in-memory pipes between them.
//
// Clock and random are fixed by the caller: every clock reads `Time`, and
// random_get draws from one splitmix32 stream seeded by `Seed`, shared by
// every process of the run — runShell's defaults on the Node host.
//
// Fuel (wasmtime's instruction metering) is one budget for the whole run: a
// child starts with what its parent has left and hands back what it did not
// use. Running out anywhere ends the run with ErrOutOfFuel.

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/bytecodealliance/wasmtime-go/v49"
)

// The shell's modules as the runtime names them (src/runtime/programs.ts MODULES).
var (
	BrushCID     = mustCID("bafkreiemwcli2372geseu7l527ivxwjodogng7zoltixf6pfh5ujnpauc4")
	CoreutilsCID = mustCID("bafkreidohpuc5gyi4xroxlhc367ry5hkpixtabc7sln2tidedeqbwcgese")
)

// ExtraCIDs are the single-purpose WASI programs beyond brush/coreutils, keyed
// by the command name the shell runs them under (src/runtime/programs.ts
// MODULES; kept in sync by hand — a `wasm/<name>.wasm` and this entry are
// added together, never one without the other). diff and cmp are two names
// for the one uutils/diffutils multicall binary (same CID).
var ExtraCIDs = map[string]CID{
	"find":  mustCID("bafkreib7nn5j3hys3m2ux5mzwxnesqzspfou2lng5jcudvnps3g5kpv4bu"),
	"xargs": mustCID("bafkreiaizwk5lqff2b23kpovpsglmct5xconf7n45zlzekyplvnjjjqgju"),
	"diff":  mustCID("bafkreifhra2rwueqtn3pqjpjfmobhd6dcijhexr46eyfcnr5hs3gmebv6i"),
	"cmp":   mustCID("bafkreifhra2rwueqtn3pqjpjfmobhd6dcijhexr46eyfcnr5hs3gmebv6i"),
	"jq":    mustCID("bafkreih226yv4dcowahyziroqms5r6h4k7mliutf2kpjp3klofcskdg56e"),
	"which": mustCID("bafkreicdmerbpermjjw5x26pjokqhwbwbsncfqgdw63zo2e2g6tmm43iye"),
	"grep":  mustCID("bafkreihbm7x5gatusjkpo7oxwkh43ltpv7osaw4jaiia46hzl7ua64dvye"),
	"tree":  mustCID("bafkreiaubyrhpjhf2n6owdq4xtdemxfu6bbfzs3dcsssjhxnoovsw67yh4"),
	"awk":   mustCID("bafkreibop3tyl52wkntqcxwgy5ub2ybfs2hwl725tiixxtinrxlmblhlju"),
	"sed":   mustCID("bafkreidwtqxsblyapruappd2uuffd633ti6zgizh5giwiscl34lbuctzcy"),
}

func mustCID(s string) CID {
	c, err := ParseCID(s)
	if err != nil {
		panic(err)
	}
	return c
}

var ErrOutOfFuel = errors.New("out of fuel")

var shells = map[string]bool{"sh": true, "bash": true, "brush": true}

// ---------------------------------------------------------------- modules

// Modules are brush and coreutils compiled for one engine, the utilities that
// coreutils build contains, and the single-purpose programs in ExtraCIDs.
type Modules struct {
	engine    *wasmtime.Engine
	fuel      bool
	brush     *wasmtime.Module
	coreutils *wasmtime.Module
	utils     map[string]bool
	extra     map[string]*wasmtime.Module
}

// LoadModules compiles the shell's modules from their bytes, checking each
// against the CID the runtime knows it by. extra is keyed by command name
// (ExtraCIDs); a name it does not contain is an error. With fuel, execution
// is metered.
func LoadModules(brush, coreutils []byte, extra map[string][]byte, fuel bool) (*Modules, error) {
	cfg := wasmtime.NewConfig()
	cfg.SetConsumeFuel(fuel)
	m := &Modules{engine: wasmtime.NewEngineWithConfig(cfg), fuel: fuel, extra: map[string]*wasmtime.Module{}}
	for _, x := range []struct {
		name  string
		want  CID
		bytes []byte
		into  **wasmtime.Module
	}{{"brush", BrushCID, brush, &m.brush}, {"coreutils", CoreutilsCID, coreutils, &m.coreutils}} {
		if got := rawCID(x.bytes); got != x.want {
			return nil, fmt.Errorf("%s: bytes hash to %s, want %s", x.name, got, x.want)
		}
		mod, err := wasmtime.NewModule(m.engine, x.bytes)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", x.name, err)
		}
		*x.into = mod
	}
	for name, b := range extra {
		want, ok := ExtraCIDs[name]
		if !ok {
			return nil, fmt.Errorf("%s: not a known extra module", name)
		}
		if got := rawCID(b); got != want {
			return nil, fmt.Errorf("%s: bytes hash to %s, want %s", name, got, want)
		}
		mod, err := wasmtime.NewModule(m.engine, b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		m.extra[name] = mod
	}
	// The utilities, from the build's own --list. Pure: fixed clock, zero random.
	out := NewPipe(64<<20, nil)
	r := &run{mods: m, vfs: NewVfs(nil, emptyTree), clock: func(int32) uint64 { return 0 }, random: func(n int) []byte { return make([]byte, n) }}
	if _, err := r.runModule(nil, m.coreutils, []string{"coreutils", "--list"}, nil, [3]*Desc{r.nullDesc(), r.pipeDesc(out, true), r.nullDesc()}); err != nil {
		return nil, err
	}
	m.utils = map[string]bool{}
	for _, u := range strings.Fields(string(out.Drain())) {
		m.utils[u] = true
	}
	return m, nil
}

// LoadModulesFromStore reads the modules by CID, as the runtime does.
func LoadModulesFromStore(s *Store, fuel bool) (*Modules, error) {
	b, err := s.Get(BrushCID)
	if err != nil {
		return nil, fmt.Errorf("brush not in store (skein-dev install puts it there): %w", err)
	}
	c, err := s.Get(CoreutilsCID)
	if err != nil {
		return nil, fmt.Errorf("coreutils not in store (skein-dev install puts it there): %w", err)
	}
	extra := map[string][]byte{}
	for name, cid := range ExtraCIDs {
		b, err := s.Get(cid)
		if err != nil {
			return nil, fmt.Errorf("%s not in store (skein-dev install puts it there): %w", name, err)
		}
		extra[name] = b
	}
	return LoadModules(b, c, extra, fuel)
}

// LoadModulesFromDir reads brush.wasm, coreutils.wasm and every ExtraCIDs
// module from a directory (the repo's wasm/).
func LoadModulesFromDir(dir string, fuel bool) (*Modules, error) {
	b, err := os.ReadFile(filepath.Join(dir, "brush.wasm"))
	if err != nil {
		return nil, err
	}
	c, err := os.ReadFile(filepath.Join(dir, "coreutils.wasm"))
	if err != nil {
		return nil, err
	}
	extra := map[string][]byte{}
	for name := range ExtraCIDs {
		b, err := os.ReadFile(filepath.Join(dir, name+".wasm"))
		if err != nil {
			return nil, err
		}
		extra[name] = b
	}
	return LoadModules(b, c, extra, fuel)
}

// Commands are the names the shell can run besides its builtins.
func (m *Modules) Commands() []string {
	out := []string{"coreutils"}
	for s := range shells {
		out = append(out, s)
	}
	for u := range m.utils {
		out = append(out, u)
	}
	for x := range m.extra {
		out = append(out, x)
	}
	sort.Strings(out)
	return slices.Compact(out)
}

// The empty tree, for the one run that needs no filesystem.
var emptyTree, _, _ = HashTree(nil)

// ---------------------------------------------------------------- running

type ShellOptions struct {
	Tree CID
	Cmd  string
	Cwd  string   // absolute path inside the tree; default "/"
	Env  []string // KEY=VALUE, applied over the defaults in order
	// Stdin is the shell's standard input.
	Stdin []byte
	// Time is what every clock reads, in ms since the epoch.
	Time int64
	// Seed seeds the random stream.
	Seed uint32
	// Limit caps captured stdout/stderr, in bytes. Default 64 MiB.
	Limit int
	// Fuel is the run's budget when the modules meter fuel.
	Fuel uint64
}

type ShellResult struct {
	ExitCode int32
	Stdout   []byte
	Stderr   []byte
	Tree     CID
	// FuelUsed is what the run consumed (0 without metering).
	FuelUsed uint64
}

// run is one shell invocation: the filesystem view and everything its
// processes share.
type run struct {
	mods    *Modules
	vfs     *Vfs
	clock   func(id int32) uint64
	random  func(n int) []byte
	descIno uint64
}

// Pipes and null get inode numbers far from the tree's.
func (r *run) nextIno() uint64 {
	if r.descIno == 0 {
		r.descIno = 1 << 30
	}
	r.descIno++
	return r.descIno - 1
}
func (r *run) nullDesc() *Desc { return &Desc{t: dNull, ino: r.nextIno()} }
func (r *run) pipeDesc(p *Pipe, write bool) *Desc {
	return &Desc{t: dPipe, pipe: p, write: write, ino: r.nextIno()}
}

func (r *run) exists(name string) bool {
	return shells[name] || name == "coreutils" || r.mods.utils[name] || r.mods.extra[name] != nil
}

// Run runs a command line in the shell over a tree. New objects go to the store.
func (m *Modules) Run(s *Store, o ShellOptions) (*ShellResult, error) {
	cwd := "/" + strings.Join(strings.FieldsFunc(o.Cwd, func(r rune) bool { return r == '/' }), "/")
	r := &run{mods: m, vfs: NewVfs(s, o.Tree), clock: fixedClock(o.Time), random: splitmix32(o.Seed)}
	at, err := r.vfs.Resolve(r.vfs.Root, cwd, true)
	if _, isErrno := errnoOf(err); err != nil && !isErrno {
		return nil, err
	}
	if at == nil || at.Kind != KDir {
		return nil, fmt.Errorf("cwd is not a directory in the tree: %s", cwd)
	}

	limit := o.Limit
	if limit == 0 {
		limit = 64 << 20
	}
	stdout, stderr := NewPipe(limit, nil), NewPipe(limit, nil)
	stdin := NewPipe(max(limit, len(o.Stdin)), o.Stdin)
	env := mergeEnv([]string{"HOME=/", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "USER=skein"}, o.Env, "PWD="+cwd)

	var fuel *uint64
	if m.fuel {
		fuel = &o.Fuel
	}
	budget := o.Fuel
	code, err := r.runModule(fuel, m.brush, []string{"bash", "--disable-color", "-c", o.Cmd}, env,
		[3]*Desc{r.pipeDesc(stdin, false), r.pipeDesc(stdout, true), r.pipeDesc(stderr, true)})
	if err != nil {
		return nil, err
	}
	tree, err := r.vfs.Commit()
	if err != nil {
		return nil, err
	}
	res := &ShellResult{ExitCode: code, Stdout: stdout.Drain(), Stderr: stderr.Drain(), Tree: tree}
	if fuel != nil {
		res.FuelUsed = budget - *fuel
	}
	return res, nil
}

// mergeEnv applies KEY=VALUE overrides in order, keeping each key where it
// first appeared (as a JavaScript object spread does), then forces last.
func mergeEnv(base, over []string, last string) []string {
	out := slices.Clone(base)
	for _, kv := range append(slices.Clone(over), last) {
		k, _, _ := strings.Cut(kv, "=")
		i := slices.IndexFunc(out, func(e string) bool { return strings.HasPrefix(e, k+"=") })
		if i >= 0 {
			out[i] = kv
		} else {
			out = append(out, kv)
		}
	}
	return out
}

// spawn runs what brush asks for: a shell, coreutils, one of its utilities, or
// a script in the tree. found is false when there is no such program.
func (r *run) spawn(parent *Process, req SpawnRequest) (code int32, found bool, err error) {
	env := slices.DeleteFunc(slices.Clone(req.Env), func(e string) bool { return strings.HasPrefix(e, "PWD=") })
	cwd := req.Cwd
	if cwd == "" {
		cwd = "/"
	}
	env = append(env, "PWD="+cwd)
	var mod *wasmtime.Module
	var args []string
	rest := req.Argv[min(1, len(req.Argv)):]
	switch {
	case !strings.Contains(req.Program, "/"):
		switch {
		case shells[req.Program]:
			mod, args = r.mods.brush, append([]string{"bash", "--disable-color"}, rest...)
		case req.Program == "coreutils":
			mod, args = r.mods.coreutils, append([]string{"coreutils"}, rest...)
		case r.mods.utils[req.Program]:
			mod, args = r.mods.coreutils, append([]string{req.Program}, rest...)
		case r.mods.extra[req.Program] != nil:
			mod, args = r.mods.extra[req.Program], append([]string{req.Program}, rest...)
		default:
			return 0, false, nil
		}
	default:
		// A path in the tree: scripts run under the shell; nothing else is executable.
		path := req.Program
		if !strings.HasPrefix(path, "/") {
			path = req.Cwd + "/" + path
		}
		node, err := r.vfs.Resolve(r.vfs.Root, path, true)
		if err != nil {
			if _, isErrno := errnoOf(err); isErrno {
				return 0, false, nil
			}
			return 0, false, err
		}
		var head []byte
		if node.Kind == KFile {
			if head, err = r.vfs.Content(node); err != nil {
				return 0, false, err
			}
		}
		if len(head) < 2 || head[0] != '#' || head[1] != '!' {
			argv0 := ""
			if len(req.Argv) > 0 {
				argv0 = req.Argv[0]
			}
			writeTo(req.Stdio[2], argv0+": cannot execute: only shell scripts run from the tree\n")
			return 126, true, nil
		}
		mod, args = r.mods.brush, append([]string{"bash", "--disable-color", req.Program}, rest...)
	}

	var fuel *uint64
	if r.mods.fuel {
		left, err := parent.store.GetFuel()
		if err != nil {
			return 0, false, err
		}
		fuel = &left
	}
	code, err = r.runModule(fuel, mod, args, env, req.Stdio)
	if err != nil {
		return 0, false, err
	}
	if fuel != nil {
		if err := parent.store.SetFuel(*fuel); err != nil {
			return 0, false, err
		}
	}
	return code, true, nil
}

// runModule instantiates a WASI command in a store of its own and runs it to
// exit. With fuel, the store starts with *fuel and *fuel is left holding what
// remains.
func (r *run) runModule(fuel *uint64, mod *wasmtime.Module, args, env []string, stdio [3]*Desc) (int32, error) {
	p := newProcess(r, args, env, stdio)
	store := wasmtime.NewStore(r.mods.engine)
	defer store.Close()
	p.store = store
	if fuel == nil && r.mods.fuel {
		unmetered := uint64(math.MaxUint64)
		fuel = &unmetered
	}
	if fuel != nil {
		if err := store.SetFuel(*fuel); err != nil {
			return 0, err
		}
	}
	linker := wasmtime.NewLinker(r.mods.engine)
	defer linker.Close()
	var memory *wasmtime.Memory
	if err := p.link(linker, mod, func(c *wasmtime.Caller) []byte { return memory.UnsafeData(c) }); err != nil {
		return 0, err
	}
	inst, err := linker.Instantiate(store, mod)
	if err != nil {
		return 0, err
	}
	memory = inst.GetExport(store, "memory").Memory()
	_, err = inst.GetFunc(store, "_start").Call(store)
	if fuel != nil {
		*fuel, _ = store.GetFuel()
	}
	switch {
	case p.fatal != nil:
		return 0, p.fatal
	case p.exit != nil:
		return *p.exit, nil
	case err == nil:
		return 0, nil
	}
	var trap *wasmtime.Trap
	if errors.As(err, &trap) {
		if c := trap.Code(); c != nil && *c == wasmtime.OutOfFuel {
			return 0, ErrOutOfFuel
		}
		msg, _, _ := strings.Cut(trap.Message(), "\n")
		writeTo(stdio[2], args[0]+": trapped: "+msg+"\n")
		return 134, nil
	}
	return 0, err
}

func writeTo(d *Desc, s string) {
	if d.t == dPipe && d.write {
		d.pipe.Write([]byte(s))
	}
}

func fixedClock(ms int64) func(int32) uint64 {
	ns := uint64(ms) * 1_000_000
	return func(int32) uint64 { return ns }
}

// splitmix32 is the Node host's stream for runs outside a thread (shell.ts prng).
func splitmix32(seed uint32) func(n int) []byte {
	s := seed
	return func(n int) []byte {
		b := make([]byte, n)
		for i := range b {
			s += 0x9e3779b9
			z := s
			z = (z ^ z>>16) * 0x85ebca6b
			z = (z ^ z>>13) * 0xc2b2ae35
			b[i] = byte(z ^ z>>16)
		}
		return b
	}
}
