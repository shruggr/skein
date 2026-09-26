package host

// Equivalence with the Node host: the same command lines over the same tree
// (the fixture of src/runtime/shell.test.ts) run through runShell under Node
// (node/run-shell.ts, one process for the whole batch) and through Modules.Run
// here, compared byte for byte: stdout, stderr, exit code, tree CID.
// Set SKEIN_NO_NODE=1 to skip the comparison (the other tests need no Node).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var wasmDir = filepath.Join("..", "wasm")

// scanDir puts a directory into the store as git objects and returns its tree
// (the Go twin of src/dev/scan.ts, for tests).
func scanDir(s *Store, dir string) (CID, error) {
	des, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var es []Entry
	for _, de := range des {
		p := filepath.Join(dir, de.Name())
		info, err := os.Lstat(p)
		if err != nil {
			return "", err
		}
		var e Entry
		var data []byte
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			t, err := os.Readlink(p)
			if err != nil {
				return "", err
			}
			e.Mode, data = "120000", []byte(t)
		case info.IsDir():
			if e.CID, err = scanDir(s, p); err != nil {
				return "", err
			}
			e.Mode = "40000"
		default:
			if data, err = os.ReadFile(p); err != nil {
				return "", err
			}
			e.Mode = "100644"
			if info.Mode()&0o111 != 0 {
				e.Mode = "100755"
			}
		}
		if e.Mode != "40000" {
			c, obj := HashBlob(data)
			if err := s.Put(c, obj); err != nil {
				return "", err
			}
			e.CID = c
		}
		e.Name = de.Name()
		es = append(es, e)
	}
	c, obj, err := HashTree(es)
	if err != nil {
		return "", err
	}
	return c, s.Put(c, obj)
}

type fixture struct {
	db        string
	store     *Store
	tree, big CID // big: the fixture plus a 2 MB file
	mods      *Modules
}

var (
	fixOnce sync.Once
	fix     fixture
	fixErr  error
)

// The fixture of shell.test.ts, in a fresh store with the shell's modules installed.
func getFixture(t *testing.T) *fixture {
	fixOnce.Do(func() { fixErr = buildFixture() })
	if fixErr != nil {
		t.Fatal(fixErr)
	}
	return &fix
}

func buildFixture() error {
	dir, err := os.MkdirTemp("", "skein-host-go-")
	if err != nil {
		return err
	}
	fix.db = filepath.Join(dir, "store.db")
	tree := filepath.Join(dir, "tree")
	files := map[string]string{"a.txt": "one\ntwo\nthree\n", "sub/b.txt": "bee\n", "sub/deep/c.txt": "sea\n"}
	for p, s := range files {
		os.MkdirAll(filepath.Dir(filepath.Join(tree, p)), 0o755)
		if err := os.WriteFile(filepath.Join(tree, p), []byte(s), 0o644); err != nil {
			return err
		}
	}
	if err := os.Symlink("a.txt", filepath.Join(tree, "link")); err != nil {
		return err
	}
	if fix.store, err = OpenStore(fix.db); err != nil {
		return err
	}
	if fix.tree, err = scanDir(fix.store, tree); err != nil {
		return err
	}
	big := make([]byte, 2<<20)
	for i := range big {
		big[i] = byte(i * 7919)
	}
	if err := os.WriteFile(filepath.Join(tree, "big.bin"), big, 0o644); err != nil {
		return err
	}
	if fix.big, err = scanDir(fix.store, tree); err != nil {
		return err
	}
	for _, name := range []string{"brush", "coreutils"} {
		b, err := os.ReadFile(filepath.Join(wasmDir, name+".wasm"))
		if err != nil {
			return err
		}
		if err := fix.store.Put(rawCID(b), b); err != nil {
			return err
		}
	}
	t0 := time.Now()
	if fix.mods, err = LoadModulesFromStore(fix.store, false); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "compiled brush + coreutils in %s\n", time.Since(t0).Round(time.Millisecond))
	return nil
}

type shellCase struct {
	Cmd   string      `json:"cmd"`
	Tree  string      `json:"tree"`
	Cwd   string      `json:"cwd,omitempty"`
	Env   [][2]string `json:"env,omitempty"`
	Stdin []byte      `json:"stdin,omitempty"` // base64 in JSON
	Time  int64       `json:"time,omitempty"`
	Seed  uint32      `json:"seed,omitempty"`
}

type shellOut struct {
	ExitCode int32  `json:"exitCode"`
	Stdout   []byte `json:"stdout"`
	Stderr   []byte `json:"stderr"`
	Tree     string `json:"tree"`
	Error    string `json:"error,omitempty"`
}

// cases: every command line of src/runtime/shell.test.ts, then some more that
// exercise the imports (stat, readdir, links, seek, truncate, devices).
func cases(f *fixture) []shellCase {
	tr, big := f.tree.String(), f.big.String()
	c := func(cmd string) shellCase { return shellCase{Cmd: cmd, Tree: tr} }
	det := "date; echo $RANDOM $RANDOM; ls -la; head -c 16 /dev/stdin | od -c; sleep 1; date +%s > t; mktemp -u XXXXXX"
	out := []shellCase{
		c("ls"), c("cat a.txt"), c("cat link"), c("cat sub/deep/c.txt"), c("mv a.txt b.txt"),
		c("echo hi > new.txt"),
		c("mkdir d && cp a.txt d/ && ls d"),
		c("echo x >> a.txt && rm link && ln -s sub/b.txt l2"),
		c("cat a.txt | wc -l"),
		c(`printf '%s\n' c b a b | sort | uniq | tr a-z A-Z`),
		c(`x=$(head -1 a.txt); echo "got $x"`),
		c("seq 1 4 | while read n; do echo $((n*n)); done"),
		c("cat <<EOF\nhello $USER\nEOF"),
		c("yes | head -2; echo ${PIPESTATUS[@]}"),
		c("exit 3"), c("false"), c("cat nope"), c("nosuchcommand"),
		c("false | true; echo $?"), c("set -o pipefail; false | true; echo $?"),
		{Cmd: det, Tree: tr, Stdin: []byte("0123456789abcdefXYZ")},
		{Cmd: "date -u +%FT%T", Tree: tr, Time: time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC).UnixMilli()},
		{Cmd: "echo $RANDOM", Tree: tr, Seed: 7}, c("echo $RANDOM"),
		c("cat /etc/passwd"), c("cd /; cd ..; cd ..; ls"), c("ls ../../.."),
		c("echo gone > /dev/null; ls /dev 2>&1; echo $?"),
		{Cmd: "pwd; ls; cat ../a.txt | head -1; /bin/true 2>/dev/null; echo $FOO", Tree: tr, Cwd: "/sub", Env: [][2]string{{"FOO", "bar"}}},
		{Cmd: "ls", Tree: tr, Cwd: "/nope"},
		c(`printf '#!/bin/sh\necho script $1\n' > s.sh && bash s.sh one && ./s.sh two && sh -c 'echo nested'`),
		{Cmd: "cp big.bin copy.bin && cat big.bin | cat > piped.bin && wc -c < big.bin && md5sum big.bin copy.bin piped.bin | cut -c1-32 | uniq | wc -l", Tree: big},
		// beyond shell.test.ts
		c("ls -lai; ls -la sub sub/deep"),
		c("ls -R; wc a.txt sub/b.txt; realpath link sub/../sub/deep; readlink -f link; basename sub/b.txt .txt"),
		c("cp -r sub sub3 && ls -R sub3 && rm -r sub && ls && touch sub3/deep/new && ls sub3/deep"),
		c("ln a.txt hard && ls -i hard a.txt && echo more >> hard && cat a.txt hard"),
		c("type ls cat; command -v sort; type nosuch; echo $?"),
		c("./a.txt; echo $?; ./nope; echo $?"),
		c("rmdir sub; echo $?; mkdir x && rmdir x && ls"),
		c("touch z && truncate -s 5 z && od -c z && truncate -s 2 z && od -c z"),
		c("sort -r a.txt > r.txt; cat r.txt; sort -r a.txt > a.txt; cat a.txt; wc -c a.txt"),
		c("dd if=a.txt bs=1 skip=2 count=3 2>/dev/null; echo; tail -n1 a.txt; tail -c 4 a.txt"),
		c("mv sub sub2 && ls sub2/deep && mv sub2 sub2/deep; echo $?; mkdir e && mv e sub2/deep && ls -R sub2"),
		c("ln -s nowhere dangling && cat dangling; echo $?; echo made > dangling; cat nowhere; readlink dangling"),
		c("printf 'a\\0b' | od -An -c; echo -n abc | md5sum; seq 1000 | tail -1"),
		c("for i in 1 2 3; do echo $i > f$i; done; cat f*; ls | wc -l"),
		c("echo $(echo $(echo nested)); (cd sub && pwd); pwd"),
		c("ls /; cat /dev/null; echo ok > /dev/stdout; echo err > /dev/stderr"),
		{Cmd: "cat; wc -c < /dev/stdin", Tree: tr, Stdin: []byte("piped in\n")},
		c("printenv | sort; export X=1; printenv X"),
		c("echo $((RANDOM % 100)) $SRANDOM; shuf -n2 -e a b c d; mktemp; ls tmp* 2>/dev/null; ls"),
		c("test -x a.txt && echo exec; test -d sub && echo dir; [ -e nope ] || echo none; cut -c1-2 a.txt | paste -sd,"),
	}
	return out
}

func runGo(f *fixture, c shellCase) shellOut {
	var env []string
	for _, kv := range c.Env {
		env = append(env, kv[0]+"="+kv[1])
	}
	tree, _ := ParseCID(c.Tree)
	r, err := f.mods.Run(f.store, ShellOptions{Tree: tree, Cmd: c.Cmd, Cwd: c.Cwd, Env: env, Stdin: c.Stdin, Time: c.Time, Seed: c.Seed})
	if err != nil {
		return shellOut{Error: err.Error()}
	}
	return shellOut{ExitCode: r.ExitCode, Stdout: r.Stdout, Stderr: r.Stderr, Tree: r.Tree.String()}
}

func runNode(t *testing.T, f *fixture, cs []shellCase) []shellOut {
	in, _ := json.Marshal(cs)
	cmd := exec.Command("node", "--experimental-strip-types", "--no-warnings", "node/run-shell.ts", f.db)
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node host: %v\n%s", err, stderr.String())
	}
	var res []shellOut
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func TestTreeMatchesNodeScan(t *testing.T) {
	if os.Getenv("SKEIN_NO_NODE") != "" {
		t.Skip("SKEIN_NO_NODE")
	}
	f := getFixture(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "x"), []byte("x\n"), 0o755)
	os.Mkdir(filepath.Join(dir, "d"), 0o755)
	os.WriteFile(filepath.Join(dir, "d", "y"), []byte("y"), 0o644)
	os.Symlink("d/y", filepath.Join(dir, "l"))
	want, err := scanDir(f.store, dir)
	if err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("node", "--experimental-strip-types", "--no-warnings", "node/run-shell.ts", f.db, "--scan", dir).Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != want.String() {
		t.Fatalf("node scan %s, go scan %s", got, want)
	}
}

func TestEquivalentToNode(t *testing.T) {
	if os.Getenv("SKEIN_NO_NODE") != "" {
		t.Skip("SKEIN_NO_NODE")
	}
	f := getFixture(t)
	cs := cases(f)
	t0 := time.Now()
	node := runNode(t, f, cs)
	t.Logf("node host: %d cases in %s (one process, including compile)", len(cs), time.Since(t0).Round(time.Millisecond))
	t0 = time.Now()
	for i, c := range cs {
		g := runGo(f, c)
		n := node[i]
		name := strings.ReplaceAll(c.Cmd, "\n", `\n`)
		if (g.Error != "") != (n.Error != "") {
			t.Errorf("%q: go error %q, node error %q", name, g.Error, n.Error)
			continue
		}
		if g.Error != "" {
			continue // both refused (cwd not a directory)
		}
		if g.ExitCode != n.ExitCode || !bytes.Equal(g.Stdout, n.Stdout) || !bytes.Equal(g.Stderr, n.Stderr) || g.Tree != n.Tree {
			t.Errorf("%q differs\n go: exit %d tree %s\n  stdout %q\n  stderr %q\n node: exit %d tree %s\n  stdout %q\n  stderr %q",
				name, g.ExitCode, g.Tree, g.Stdout, g.Stderr, n.ExitCode, n.Tree, n.Stdout, n.Stderr)
		}
	}
	t.Logf("go host: %d cases in %s", len(cs), time.Since(t0).Round(time.Millisecond))
}

// The shell.test.ts assertions, on the Go host alone.
func TestShellBasics(t *testing.T) {
	f := getFixture(t)
	for _, x := range []struct {
		cmd, out string
		code     int32
	}{
		{"ls", "a.txt\nlink\nsub\n", 0},
		{"cat link", "one\ntwo\nthree\n", 0},
		{"seq 1 4 | while read n; do echo $((n*n)); done", "1\n4\n9\n16\n", 0},
		{"set -o pipefail; false | true; echo $?", "1\n", 0},
		{"nosuchcommand", "", 127},
		{"exit 3", "", 3},
		{"date -u +%FT%T", "1970-01-01T00:00:00\n", 0},
	} {
		r := runGo(f, shellCase{Cmd: x.cmd, Tree: f.tree.String()})
		if r.Error != "" || string(r.Stdout) != x.out || r.ExitCode != x.code {
			t.Errorf("%q: exit %d stdout %q stderr %q err %s", x.cmd, r.ExitCode, r.Stdout, r.Stderr, r.Error)
		}
	}
	r := runGo(f, shellCase{Cmd: "echo hi > new.txt", Tree: f.tree.String()})
	tree, _ := ParseCID(r.Tree)
	v := NewVfs(f.store, tree)
	n, err := v.Resolve(v.Root, "new.txt", false)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := v.Content(n); string(b) != "hi\n" {
		t.Fatalf("new.txt = %q", b)
	}
}

// Fuel: an infinite loop ends with ErrOutOfFuel after exactly the budget, and
// a finite run's consumption is the same every time — including fuel spent in
// spawned children, which draw on the same budget.
func TestFuel(t *testing.T) {
	f := getFixture(t)
	mods, err := LoadModulesFromStore(f.store, true)
	if err != nil {
		t.Fatal(err)
	}
	run := func(cmd string, fuel uint64) (*ShellResult, error) {
		return mods.Run(f.store, ShellOptions{Tree: f.tree, Cmd: cmd, Fuel: fuel})
	}
	for _, cmd := range []string{"while :; do :; done", "yes > /dev/null"} {
		_, err := run(cmd, 50_000_000)
		if !errors.Is(err, ErrOutOfFuel) {
			t.Fatalf("%q: want out of fuel, got %v", cmd, err)
		}
	}
	const cmd = "cat a.txt | sort | wc -l"
	a, err := run(cmd, 1<<40)
	if err != nil {
		t.Fatal(err)
	}
	b, err := run(cmd, 1<<40)
	if err != nil {
		t.Fatal(err)
	}
	if string(a.Stdout) != "3\n" || a.FuelUsed != b.FuelUsed || a.FuelUsed == 0 {
		t.Fatalf("stdout %q, fuel %d then %d", a.Stdout, a.FuelUsed, b.FuelUsed)
	}
	shellOnly, err := run("echo 3", 1<<40)
	if err != nil {
		t.Fatal(err)
	}
	if shellOnly.FuelUsed >= a.FuelUsed {
		t.Fatalf("children's fuel not charged: pipeline %d, builtin only %d", a.FuelUsed, shellOnly.FuelUsed)
	}
	// Exactly what it used is enough.
	if r, err := run(cmd, a.FuelUsed); err != nil || string(r.Stdout) != "3\n" {
		t.Fatalf("budget %d: %v", a.FuelUsed, err)
	}
	t.Logf("%q used %d fuel; `echo 3` alone %d", cmd, a.FuelUsed, shellOnly.FuelUsed)
}
