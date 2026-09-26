package host

// The filesystem as records (src/runtime/tree.ts): a blob is a git blob
// object, a tree a git tree object, each under CIDv1(git-raw, sha1 of the
// whole object), so a tree's CID is its git id.

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
)

// Entry is one line of a git tree.
type Entry struct {
	Mode string // 100644 100755 120000 40000 160000
	Name string
	CID  CID
}

var modes = map[string]bool{"100644": true, "100755": true, "120000": true, "40000": true, "160000": true}

func header(typ string, n int) []byte { return []byte(typ + " " + strconv.Itoa(n) + "\x00") }

// HashBlob returns a blob's CID and its object bytes.
func HashBlob(data []byte) (CID, []byte) {
	obj := append(header("blob", len(data)), data...)
	return gitCID(obj), obj
}

// HashTree returns a tree's CID and its object bytes. Entries are sorted as git
// does: as if a directory's name ended in "/".
func HashTree(entries []Entry) (CID, []byte, error) {
	type keyed struct {
		e   Entry
		key []byte
	}
	seen := map[string]bool{}
	ks := make([]keyed, 0, len(entries))
	for _, e := range entries {
		if !modes[e.Mode] {
			return "", nil, fmt.Errorf("bad mode %s for %s", e.Mode, e.Name)
		}
		if e.Name == "" || bytes.ContainsAny([]byte(e.Name), "/\x00") {
			return "", nil, fmt.Errorf("bad entry name: %q", e.Name)
		}
		if seen[e.Name] {
			return "", nil, fmt.Errorf("duplicate entry: %s", e.Name)
		}
		seen[e.Name] = true
		if _, err := e.CID.gitDigest(); err != nil {
			return "", nil, err
		}
		k := e.Name
		if e.Mode == "40000" {
			k += "/"
		}
		ks = append(ks, keyed{e, []byte(k)})
	}
	sort.Slice(ks, func(i, j int) bool { return bytes.Compare(ks[i].key, ks[j].key) < 0 })
	var body []byte
	for _, k := range ks {
		d, _ := k.e.CID.gitDigest()
		body = append(body, k.e.Mode+" "+k.e.Name+"\x00"...)
		body = append(body, d...)
	}
	obj := append(header("tree", len(body)), body...)
	return gitCID(obj), obj, nil
}

// objectBody checks the "<type> <len>\0" header and returns what follows.
func objectBody(obj []byte, typ string, c CID) ([]byte, error) {
	nul := bytes.IndexByte(obj, 0)
	if nul < 0 || string(obj[:nul]) != typ+" "+strconv.Itoa(len(obj)-nul-1) {
		return nil, fmt.Errorf("not a git %s: %s", typ, c)
	}
	return obj[nul+1:], nil
}

// ParseTree reads a tree object's entries, in stored order.
func ParseTree(obj []byte, c CID) ([]Entry, error) {
	b, err := objectBody(obj, "tree", c)
	if err != nil {
		return nil, err
	}
	var out []Entry
	for i := 0; i < len(b); {
		sp := bytes.IndexByte(b[i:], ' ')
		z := -1
		if sp >= 0 {
			sp += i
			if z = bytes.IndexByte(b[sp:], 0); z >= 0 {
				z += sp
			}
		}
		if z < 0 || z+21 > len(b) {
			return nil, fmt.Errorf("truncated tree: %s", c)
		}
		mode := string(b[i:sp])
		if !modes[mode] {
			return nil, fmt.Errorf("unsupported mode %s in %s", mode, c)
		}
		out = append(out, Entry{mode, string(b[sp+1 : z]), newCID(codecGitRaw, mhSHA1, bytes.Clone(b[z+1:z+21]))})
		i = z + 21
	}
	return out, nil
}

// ReadBlob returns a blob's contents.
func ReadBlob(s *Store, c CID) ([]byte, error) {
	if _, err := c.gitDigest(); err != nil {
		return nil, err
	}
	obj, err := s.Get(c)
	if err != nil {
		return nil, err
	}
	return objectBody(obj, "blob", c)
}

// ReadTree returns a tree's entries.
func ReadTree(s *Store, c CID) ([]Entry, error) {
	if _, err := c.gitDigest(); err != nil {
		return nil, err
	}
	obj, err := s.Get(c)
	if err != nil {
		return nil, err
	}
	return ParseTree(obj, c)
}
