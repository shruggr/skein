package host

// A mutable, copy-on-write view of a git-shaped tree (src/runtime/wasi/vfs.ts).
// Nodes load lazily from the store; a node keeps its CID until something
// under it changes, so Commit re-hashes only the changed spine and untouched
// subtrees keep their CIDs unread. Inode numbers are handed out in load
// order, exactly as the Node host does, so `ls -i` agrees.

import (
	"errors"
	"strconv"
	"strings"
)

type Kind int

const (
	KDir Kind = iota
	KFile
	KLink
	KModule // a gitlink (160000): kept as is, shown as an empty read-only directory
)

type Node struct {
	Kind     Kind
	Ino      uint64
	Parent   *Node
	CID      CID              // "" once changed (or never stored)
	Entries  map[string]*Node // dir; nil until loaded
	Readonly bool             // a submodule's stand-in directory
	Exec     bool             // file
	Data     []byte           // file contents or link target; nil until loaded
	loaded   bool
}

// Errno is a wasi errno as an error.
type Errno int32

func (e Errno) Error() string { return "errno " + strconv.Itoa(int(e)) }

// wasi errno values used here.
const (
	EACCES       Errno = 2
	EBADF        Errno = 8
	EEXIST       Errno = 20
	EINVAL       Errno = 28
	EIO          Errno = 29
	EISDIR       Errno = 31
	ELOOP        Errno = 32
	ENAMETOOLONG Errno = 37
	ENOENT       Errno = 44
	ENOSYS       Errno = 52
	ENOTDIR      Errno = 54
	ENOTEMPTY    Errno = 55
	ENOTSUP      Errno = 58
	EPERM        Errno = 63
	EPIPE        Errno = 64
	EROFS        Errno = 69
	ESPIPE       Errno = 70
)

const maxLinks = 40

type Vfs struct {
	Root    *Node
	store   *Store
	nextIno uint64
}

func NewVfs(s *Store, root CID) *Vfs {
	v := &Vfs{store: s, nextIno: 1}
	v.Root = &Node{Kind: KDir, CID: root, Ino: v.ino()}
	if root == emptyTree {
		v.Root.Entries = map[string]*Node{} // needs no store
	}
	return v
}

func (v *Vfs) ino() uint64 { v.nextIno++; return v.nextIno - 1 }

func (v *Vfs) fromEntry(e Entry, parent *Node) *Node {
	n := &Node{CID: e.CID, Ino: v.ino(), Parent: parent}
	switch e.Mode {
	case "40000":
		n.Kind = KDir
	case "120000":
		n.Kind = KLink
	case "160000":
		n.Kind = KModule
	default:
		n.Kind, n.Exec = KFile, e.Mode == "100755"
	}
	return n
}

func (v *Vfs) NewDir(parent *Node) *Node {
	return &Node{Kind: KDir, Entries: map[string]*Node{}, Ino: v.ino(), Parent: parent}
}

func (v *Vfs) NewFile(parent *Node, data []byte, exec bool) *Node {
	if data == nil {
		data = []byte{}
	}
	return &Node{Kind: KFile, Exec: exec, Data: data, loaded: true, Ino: v.ino(), Parent: parent}
}

func (v *Vfs) NewLink(parent *Node, target []byte) *Node {
	return &Node{Kind: KLink, Data: target, loaded: true, Ino: v.ino(), Parent: parent}
}

// ---------------------------------------------------------------- loading

func (v *Vfs) Dir(d *Node) (map[string]*Node, error) {
	if d.Entries == nil {
		obj, err := v.store.Get(d.CID)
		if err != nil {
			return nil, err
		}
		es, err := ParseTree(obj, d.CID)
		if err != nil {
			return nil, err
		}
		m := make(map[string]*Node, len(es))
		for _, e := range es {
			m[e.Name] = v.fromEntry(e, d)
		}
		d.Entries = m
	}
	return d.Entries, nil
}

// Content loads a file's data or a link's target.
func (v *Vfs) Content(n *Node) ([]byte, error) {
	if !n.loaded {
		b, err := ReadBlob(v.store, n.CID)
		if err != nil {
			return nil, err
		}
		n.Data, n.loaded = b, true
	}
	return n.Data, nil
}

// Dirty marks a node changed: it and every directory above it lose their CIDs.
func (v *Vfs) Dirty(n *Node) {
	for x := n; x != nil; x = x.Parent {
		if x.Kind != KModule {
			x.CID = ""
		}
	}
}

// ---------------------------------------------------------------- paths

// Resolve resolves path from directory at. Absolute paths and ".." stop at the
// root. Symlinks in the middle are always followed; the last only with follow.
func (v *Vfs) Resolve(at *Node, path string, follow bool) (*Node, error) {
	return v.resolve(at, path, follow, 0)
}

func (v *Vfs) resolve(at *Node, path string, follow bool, hops int) (*Node, error) {
	dir, name, err := v.resolveParent(at, path, hops)
	if err != nil {
		return nil, err
	}
	switch name {
	case "", ".":
		return dir, nil
	case "..":
		return parentOr(dir), nil
	}
	m, err := v.Dir(dir)
	if err != nil {
		return nil, err
	}
	n := m[name]
	if n == nil {
		return nil, ENOENT
	}
	if n.Kind == KLink && follow {
		return v.followLink(dir, n, hops)
	}
	return n, nil
}

func parentOr(d *Node) *Node {
	if d.Parent != nil {
		return d.Parent
	}
	return d
}

func (v *Vfs) followLink(dir, l *Node, hops int) (*Node, error) {
	if hops >= maxLinks {
		return nil, ELOOP
	}
	t, err := v.Content(l)
	if err != nil {
		return nil, err
	}
	from := dir
	if strings.HasPrefix(string(t), "/") {
		from = v.Root
	}
	return v.resolve(from, string(t), true, hops+1)
}

// ResolveParent returns the directory holding the last component, and its name.
func (v *Vfs) ResolveParent(at *Node, path string) (*Node, string, error) {
	return v.resolveParent(at, path, 0)
}

func (v *Vfs) resolveParent(at *Node, path string, hops int) (*Node, string, error) {
	if strings.Contains(path, "\x00") {
		return nil, "", EINVAL
	}
	dir := at
	if strings.HasPrefix(path, "/") {
		dir = v.Root
	}
	var parts []string
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	name := ""
	if len(parts) > 0 {
		name, parts = parts[len(parts)-1], parts[:len(parts)-1]
	}
	for _, p := range parts {
		switch p {
		case ".":
			continue
		case "..":
			dir = parentOr(dir)
			continue
		}
		m, err := v.Dir(dir)
		if err != nil {
			return nil, "", err
		}
		n := m[p]
		if n == nil {
			return nil, "", ENOENT
		}
		if n.Kind == KLink {
			if n, err = v.followLink(dir, n, hops); err != nil {
				return nil, "", err
			}
		}
		if n.Kind == KModule {
			n = moduleDir(n)
		}
		if n.Kind != KDir {
			return nil, "", ENOTDIR
		}
		dir = n
	}
	return dir, name, nil
}

// moduleDir: a submodule reads as an empty directory that refuses writes.
func moduleDir(m *Node) *Node {
	return &Node{Kind: KDir, Entries: map[string]*Node{}, Ino: m.Ino, Parent: m.Parent, Readonly: true}
}

// PathOf is a directory's absolute path.
func (v *Vfs) PathOf(n *Node) string {
	var parts []string
	for x := n; x.Parent != nil; x = x.Parent {
		name, ok := "", false
		for k, c := range x.Parent.Entries {
			if c == x {
				name, ok = k, true
				break
			}
		}
		if !ok {
			break
		}
		parts = append([]string{name}, parts...)
	}
	return "/" + strings.Join(parts, "/")
}

// ---------------------------------------------------------------- mutation

func (v *Vfs) Link(dir *Node, name string, n *Node) error {
	if err := CheckName(name); err != nil {
		return err
	}
	if dir.Readonly {
		return EROFS
	}
	m, err := v.Dir(dir)
	if err != nil {
		return err
	}
	m[name] = n
	n.Parent = dir
	v.Dirty(dir)
	return nil
}

func (v *Vfs) Unlink(dir *Node, name string) error {
	m, err := v.Dir(dir)
	if err != nil {
		return err
	}
	n := m[name]
	if n == nil {
		return nil
	}
	delete(m, name)
	v.Dirty(dir)
	n.Parent = nil
	return nil
}

// ---------------------------------------------------------------- commit

// Commit hashes every changed directory bottom-up, stores new objects, and
// returns the root CID.
func (v *Vfs) Commit() (CID, error) { return v.hashDir(v.Root) }

func (v *Vfs) put(c CID, obj []byte) error {
	has, err := v.store.Has(c)
	if err != nil || has {
		return err
	}
	return v.store.Put(c, obj)
}

func (v *Vfs) hashDir(d *Node) (CID, error) {
	if d.CID != "" {
		return d.CID, nil
	}
	out := make([]Entry, 0, len(d.Entries))
	for name, n := range d.Entries { // HashTree sorts
		var e Entry
		var err error
		switch n.Kind {
		case KDir:
			e.Mode = "40000"
			e.CID, err = v.hashDir(n)
		case KModule:
			e.Mode, e.CID = "160000", n.CID
		case KLink:
			e.Mode = "120000"
			e.CID, err = v.hashLeaf(n)
		case KFile:
			e.Mode = "100644"
			if n.Exec {
				e.Mode = "100755"
			}
			e.CID, err = v.hashLeaf(n)
		}
		if err != nil {
			return "", err
		}
		e.Name = name
		out = append(out, e)
	}
	c, obj, err := HashTree(out)
	if err != nil {
		return "", err
	}
	if err := v.put(c, obj); err != nil {
		return "", err
	}
	d.CID = c
	return c, nil
}

func (v *Vfs) hashLeaf(n *Node) (CID, error) {
	if n.CID != "" {
		return n.CID, nil
	}
	c, obj := HashBlob(n.Data)
	if err := v.put(c, obj); err != nil {
		return "", err
	}
	n.CID = c
	return c, nil
}

func CheckName(name string) error {
	if name == "" || name == "." || name == ".." || strings.Contains(name, "/") {
		return EINVAL
	}
	if len(name) > 255 {
		return ENAMETOOLONG
	}
	return nil
}

// errnoOf maps an error from the filesystem to a wasi errno; anything else is
// not the program's business and ends the run.
func errnoOf(err error) (Errno, bool) {
	var e Errno
	if errors.As(err, &e) {
		return e, true
	}
	var nf NotFound
	if errors.As(err, &nf) {
		return EIO, true // a record missing from the store
	}
	return 0, false
}
