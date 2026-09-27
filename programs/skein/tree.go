package skein

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Trees are git objects byte for byte (src/runtime/tree.ts): "tree <len>\0"
// then entries "<mode> <name>\0<20-byte sha1>"; a file is "blob <len>\0<bytes>".
// An entry's CID is CIDv1 git-raw (0x78) sha1 (0x11) over its sha1.

// gitBody checks a git object's header and returns its body.
func gitBody(obj []byte, kind string) ([]byte, error) {
	nul := bytes.IndexByte(obj, 0)
	if nul < 0 {
		return nil, fmt.Errorf("not a git %s", kind)
	}
	head := string(obj[:nul])
	n, err := strconv.Atoi(strings.TrimPrefix(head, kind+" "))
	if !strings.HasPrefix(head, kind+" ") || err != nil || n != len(obj)-nul-1 {
		return nil, fmt.Errorf("not a git %s", kind)
	}
	return obj[nul+1:], nil
}

// TreeEntry is one entry of a git tree.
type TreeEntry struct {
	Mode string
	Name string
	CID  CID
}

// ReadTree lists a tree record's entries.
func ReadTree(tree CID) ([]TreeEntry, error) {
	obj, err := Get(tree)
	if err != nil {
		return nil, err
	}
	b, err := gitBody(obj, "tree")
	if err != nil {
		return nil, err
	}
	var out []TreeEntry
	for len(b) > 0 {
		sp := bytes.IndexByte(b, ' ')
		z := bytes.IndexByte(b, 0)
		if sp < 0 || z < sp || z+21 > len(b) {
			return nil, errors.New("truncated git tree")
		}
		out = append(out, TreeEntry{Mode: string(b[:sp]), Name: string(b[sp+1 : z]), CID: append(CID{0x01, 0x78, 0x11, 0x14}, b[z+1:z+21]...)})
		b = b[z+21:]
	}
	return out, nil
}

// ReadFile is the content of the regular file at path ("a/b.md") in tree;
// ok is false when there is no such file (a missing entry, or not a file).
func ReadFile(tree CID, path string) (data []byte, ok bool, err error) {
	at := tree
	segs := strings.Split(strings.Trim(path, "/"), "/")
	for i, seg := range segs {
		entries, err := ReadTree(at)
		if err != nil {
			return nil, false, err
		}
		var found *TreeEntry
		for j := range entries {
			if entries[j].Name == seg {
				found = &entries[j]
				break
			}
		}
		last := i == len(segs)-1
		switch {
		case found == nil:
			return nil, false, nil
		case !last && found.Mode != "40000":
			return nil, false, nil
		case last && found.Mode != "100644" && found.Mode != "100755":
			return nil, false, nil
		}
		at = found.CID
	}
	obj, err := Get(at)
	if err != nil {
		return nil, false, err
	}
	b, err := gitBody(obj, "blob")
	if err != nil {
		return nil, false, err
	}
	return b, true, nil
}
