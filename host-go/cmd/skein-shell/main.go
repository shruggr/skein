// skein-shell runs a command line in the wasm shell over a tree in a skein
// store, under wasmtime:
//
//	skein-shell -db <sqlite> -tree <cid> [-cwd /sub] [-env K=V]… [-time ms] [-seed n] [-fuel n] [-wasm dir] -- <command line>
//
// It prints the command's stdout and stderr as they were captured, then on
// stderr the exit code and the resulting tree CID. New objects go into the
// store. The modules come from the store by CID unless -wasm names a directory.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	host "github.com/shruggr/skein/host-go"
)

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(s string) error { *m = append(*m, s); return nil }

func main() { os.Exit(run()) }

func run() int {
	var env multi
	db := flag.String("db", "", "the SQLite store")
	tree := flag.String("tree", "", "the tree CID (base32 or a git sha1)")
	cwd := flag.String("cwd", "/", "working directory inside the tree")
	flag.Var(&env, "env", "KEY=VALUE (repeatable)")
	stdin := flag.Bool("stdin", false, "pass this process's stdin to the shell")
	at := flag.Int64("time", 0, "what every clock reads, in ms since the epoch")
	seed := flag.Uint("seed", 0, "seed of the random stream")
	fuel := flag.Uint64("fuel", 0, "meter execution: the run's fuel budget (0 = unmetered)")
	wasm := flag.String("wasm", "", "load brush.wasm and coreutils.wasm from this directory instead of the store")
	flag.Parse()
	if *db == "" || *tree == "" || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: skein-shell -db <sqlite> -tree <cid> [flags] -- <command line>")
		flag.PrintDefaults()
		return 2
	}
	fail := func(err error) int { fmt.Fprintln(os.Stderr, "skein-shell:", err); return 1 }

	root, err := host.ParseCID(*tree)
	if err != nil {
		return fail(err)
	}
	store, err := host.OpenStore(*db)
	if err != nil {
		return fail(err)
	}
	defer store.Close()
	var mods *host.Modules
	if *wasm != "" {
		mods, err = host.LoadModulesFromDir(*wasm, *fuel > 0)
	} else {
		mods, err = host.LoadModulesFromStore(store, *fuel > 0)
	}
	if err != nil {
		return fail(err)
	}
	var in []byte
	if *stdin {
		if in, err = io.ReadAll(os.Stdin); err != nil {
			return fail(err)
		}
	}
	res, err := mods.Run(store, host.ShellOptions{
		Tree: root, Cmd: strings.Join(flag.Args(), " "), Cwd: *cwd, Env: env,
		Stdin: in, Time: *at, Seed: uint32(*seed), Fuel: *fuel,
	})
	if errors.Is(err, host.ErrOutOfFuel) {
		fmt.Fprintf(os.Stderr, "skein-shell: out of fuel (budget %d)\n", *fuel)
		return 3
	}
	if err != nil {
		return fail(err)
	}
	os.Stdout.Write(res.Stdout)
	os.Stderr.Write(res.Stderr)
	fmt.Fprintf(os.Stderr, "exit %d\ntree %s\n", res.ExitCode, res.Tree)
	if *fuel > 0 {
		fmt.Fprintf(os.Stderr, "fuel %d\n", res.FuelUsed)
	}
	return 0
}
