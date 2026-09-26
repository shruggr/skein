package host

// wasi_snapshot_preview1 over a Vfs, for one process (one wasm instance), plus
// the `skein` imports the patched brush uses (cmd_exists, pipe, spawn). A port
// of src/runtime/wasi/host.ts: nothing here touches the host; the filesystem
// is the tree, stdio are in-memory pipes, and clock/random come from the run.
//
// Every import is bound by name to a handler taking its arguments as int64s,
// with the signature the module declares; an import with no handler returns
// ENOSYS, as on the Node host.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/bytecodealliance/wasmtime-go/v49"
)

// ---------------------------------------------------------------- pipes and descriptions

// Pipe is a byte queue between processes. Processes run one at a time, so an
// empty pipe reads as end of file.
type Pipe struct {
	buf   []byte
	head  int
	limit int
}

func NewPipe(limit int, initial []byte) *Pipe {
	p := &Pipe{limit: limit}
	p.Write(initial)
	return p
}

func (p *Pipe) Size() int { return len(p.buf) - p.head }

// Write appends b, or refuses all of it if that would pass the limit.
func (p *Pipe) Write(b []byte) bool {
	if p.Size()+len(b) > p.limit {
		return false
	}
	if p.head > 0 && p.head >= len(p.buf)/2 {
		p.buf = append(p.buf[:0], p.buf[p.head:]...)
		p.head = 0
	}
	p.buf = append(p.buf, b...)
	return true
}

func (p *Pipe) Read(max int) []byte {
	n := min(max, p.Size())
	b := p.buf[p.head : p.head+n]
	p.head += n
	return b
}

func (p *Pipe) Drain() []byte { return append([]byte{}, p.Read(p.Size())...) }

type descKind int

const (
	dFile descKind = iota
	dDir
	dPipe
	dNull
)

// Desc is an open file description; fds of parent and child share them.
type Desc struct {
	t       descKind
	ino     uint64
	node    *Node  // file, dir
	pos     int    // file
	append  bool   // file
	read    bool   // file
	write   bool   // file; for a pipe, the write end
	preopen string // dir
	pipe    *Pipe
}

// ---------------------------------------------------------------- constants

const (
	ftUnknown = 0
	ftChar    = 2
	ftDir     = 3
	ftFile    = 4
	ftLink    = 7

	oCreat     = 1
	oDirectory = 2
	oExcl      = 4
	oTrunc     = 8

	fdflagAppend = 1
	rightRead    = 1 << 1
	rightWrite   = 1 << 6
	allRights    = 1<<30 - 1
)

// exit is proc_exit unwinding the instance.
type exit struct{ code int32 }

func (e exit) Error() string { return "exit " + strconv.Itoa(int(e.code)) }

// SpawnRequest is what brush's skein.spawn asks for.
type SpawnRequest struct {
	Program string
	Cwd     string
	Argv    []string
	Env     []string
	Stdio   [3]*Desc
}

// ---------------------------------------------------------------- the process

type Process struct {
	run   *run
	args  []string
	env   []string
	fds   map[int]*Desc
	store *wasmtime.Store
	mem   []byte // the instance's memory, fetched afresh on each import call
	exit  *int32
	fatal error
}

func newProcess(r *run, args, env []string, stdio [3]*Desc) *Process {
	p := &Process{run: r, args: args, env: env, fds: map[int]*Desc{}}
	for i, d := range stdio {
		p.fds[i] = d
	}
	p.fds[3] = &Desc{t: dDir, node: r.vfs.Root, preopen: "/", ino: r.vfs.Root.Ino}
	return p
}

func (p *Process) add(d *Desc) int {
	fd := 3
	for p.fds[fd] != nil {
		fd++
	}
	p.fds[fd] = d
	return fd
}

func (p *Process) desc(fd int64) (*Desc, error) {
	d := p.fds[int(int32(fd))]
	if d == nil {
		return nil, EBADF
	}
	return d, nil
}

func (p *Process) dirDesc(fd int64) (*Node, error) {
	d, err := p.desc(fd)
	if err != nil {
		return nil, err
	}
	if d.t != dDir {
		if d.t == dFile {
			return nil, ENOTDIR
		}
		return nil, EBADF
	}
	return d.node, nil
}

// memory access; pointers are u32

func (p *Process) u32(ptr int64) uint32     { return binary.LittleEndian.Uint32(p.mem[uint32(ptr):]) }
func (p *Process) u64(ptr int64) uint64     { return binary.LittleEndian.Uint64(p.mem[uint32(ptr):]) }
func (p *Process) setU8(ptr int64, v uint8) { p.mem[uint32(ptr)] = v }
func (p *Process) setU16(ptr int64, v uint16) {
	binary.LittleEndian.PutUint16(p.mem[uint32(ptr):], v)
}
func (p *Process) setU32(ptr int64, v uint32) {
	binary.LittleEndian.PutUint32(p.mem[uint32(ptr):], v)
}
func (p *Process) setU64(ptr int64, v uint64) {
	binary.LittleEndian.PutUint64(p.mem[uint32(ptr):], v)
}
func (p *Process) bytes(ptr, n int64) []byte { return p.mem[uint32(ptr) : uint32(ptr)+uint32(n)] }
func (p *Process) str(ptr, n int64) string   { return string(p.bytes(ptr, n)) }

func (p *Process) iovs(iovs, n int64) [][2]int64 {
	out := make([][2]int64, n)
	for i := range out {
		out[i] = [2]int64{int64(p.u32(iovs + int64(i)*8)), int64(p.u32(iovs + int64(i)*8 + 4))}
	}
	return out
}

// Git records no times, so every file reads as the epoch.
func (p *Process) writeStat(buf int64, ino uint64, ft uint8, size int) {
	p.setU64(buf, 1)
	p.setU64(buf+8, ino)
	p.setU8(buf+16, ft)
	p.setU64(buf+24, 1)
	p.setU64(buf+32, uint64(size))
	p.setU64(buf+40, 0)
	p.setU64(buf+48, 0)
	p.setU64(buf+56, 0)
}

func (p *Process) nodeStat(n *Node) (uint8, int, error) {
	switch n.Kind {
	case KFile, KLink:
		b, err := p.run.vfs.Content(n)
		if n.Kind == KLink {
			return ftLink, len(b), err
		}
		return ftFile, len(b), err
	}
	return ftDir, 0, nil
}

// ---------------------------------------------------------------- the import table

type handler func(p *Process, a []int64) (int32, error)

var ok = func(*Process, []int64) (int32, error) { return 0, nil }
var notsup = func(*Process, []int64) (int32, error) { return int32(ENOTSUP), nil }

var imports map[string]map[string]handler

func init() { imports = importTable() } // spawn reaches back into link: no initialization cycle

func importTable() map[string]map[string]handler {
	return map[string]map[string]handler{
		"wasi_snapshot_preview1": {
			"args_sizes_get":    func(p *Process, a []int64) (int32, error) { return p.sizes(p.args, a[0], a[1]) },
			"args_get":          func(p *Process, a []int64) (int32, error) { return p.strings(p.args, a[0], a[1]) },
			"environ_sizes_get": func(p *Process, a []int64) (int32, error) { return p.sizes(p.env, a[0], a[1]) },
			"environ_get":       func(p *Process, a []int64) (int32, error) { return p.strings(p.env, a[0], a[1]) },
			"clock_res_get":     func(p *Process, a []int64) (int32, error) { p.setU64(a[1], 1); return 0, nil },
			"clock_time_get": func(p *Process, a []int64) (int32, error) {
				p.setU64(a[2], p.run.clock(int32(a[0])))
				return 0, nil
			},
			"random_get": func(p *Process, a []int64) (int32, error) {
				copy(p.bytes(a[0], a[1]), p.run.random(int(uint32(a[1]))))
				return 0, nil
			},
			"proc_exit":   func(p *Process, a []int64) (int32, error) { return 0, exit{int32(a[0])} },
			"proc_raise":  func(*Process, []int64) (int32, error) { return int32(ENOSYS), nil },
			"sched_yield": ok,
			"poll_oneoff": (*Process).pollOneoff,
			"fd_write":    (*Process).fdWrite,
			"fd_read":     func(p *Process, a []int64) (int32, error) { return p.fdRead(a[0], a[1], a[2], a[3], -1) },
			"fd_pread":    func(p *Process, a []int64) (int32, error) { return p.fdRead(a[0], a[1], a[2], a[4], a[3]) },
			"fd_pwrite":   notsup,
			"fd_seek":     func(p *Process, a []int64) (int32, error) { return p.fdSeek(a[0], a[1], a[2], a[3]) },
			"fd_tell":     func(p *Process, a []int64) (int32, error) { return p.fdSeek(a[0], 0, 1, a[1]) },
			"fd_close": func(p *Process, a []int64) (int32, error) {
				if _, err := p.desc(a[0]); err != nil {
					return 0, err
				}
				delete(p.fds, int(int32(a[0])))
				return 0, nil
			},
			"fd_fdstat_get": (*Process).fdstat,
			"fd_fdstat_set_flags": func(p *Process, a []int64) (int32, error) {
				d, err := p.desc(a[0])
				if err != nil {
					return 0, err
				}
				if d.t == dFile {
					d.append = a[1]&fdflagAppend != 0
				}
				return 0, nil
			},
			"fd_fdstat_set_rights": ok,
			"fd_prestat_get": func(p *Process, a []int64) (int32, error) {
				d := p.fds[int(int32(a[0]))]
				if d == nil || d.t != dDir || d.preopen == "" {
					return int32(EBADF), nil
				}
				p.setU8(a[1], 0)
				p.setU32(a[1]+4, uint32(len(d.preopen)))
				return 0, nil
			},
			"fd_prestat_dir_name": func(p *Process, a []int64) (int32, error) {
				d := p.fds[int(int32(a[0]))]
				if d == nil || d.t != dDir || d.preopen == "" {
					return int32(EBADF), nil
				}
				pre := d.preopen[:min(len(d.preopen), int(uint32(a[2])))]
				copy(p.bytes(a[1], int64(len(pre))), pre)
				return 0, nil
			},
			"fd_filestat_set_size": func(p *Process, a []int64) (int32, error) {
				d, err := p.desc(a[0])
				if err != nil {
					return 0, err
				}
				if d.t != dFile || !d.write {
					return int32(EBADF), nil
				}
				p.setData(d.node, resize(d.node.Data, int(a[1])))
				return 0, nil
			},
			"fd_filestat_set_times": ok, // git records no times
			"fd_advise":             ok,
			"fd_allocate":           ok,
			"fd_datasync":           ok,
			"fd_sync":               ok,
			"fd_renumber": func(p *Process, a []int64) (int32, error) {
				d, err := p.desc(a[0])
				if err != nil {
					return 0, err
				}
				p.fds[int(int32(a[1]))] = d
				delete(p.fds, int(int32(a[0])))
				return 0, nil
			},
			"path_filestat_set_times": ok,
			"sock_accept":             notsup,
			"sock_recv":               notsup,
			"sock_send":               notsup,
			"sock_shutdown":           notsup,
			"fd_filestat_get":         (*Process).fdFilestat,
			"fd_readdir":              (*Process).fdReaddir,
			"path_open": func(p *Process, a []int64) (int32, error) {
				return p.pathOpen(a[0], a[1], p.str(a[2], a[3]), a[4], uint64(a[5]), a[7], a[8])
			},
			"path_filestat_get": func(p *Process, a []int64) (int32, error) {
				return p.pathFilestat(a[0], a[1], p.str(a[2], a[3]), a[4])
			},
			"path_create_directory": func(p *Process, a []int64) (int32, error) { return p.mkdir(a[0], p.str(a[1], a[2])) },
			"path_remove_directory": func(p *Process, a []int64) (int32, error) { return p.rmdir(a[0], p.str(a[1], a[2])) },
			"path_unlink_file":      func(p *Process, a []int64) (int32, error) { return p.unlinkFile(a[0], p.str(a[1], a[2])) },
			"path_rename": func(p *Process, a []int64) (int32, error) {
				return p.rename(a[0], p.str(a[1], a[2]), a[3], p.str(a[4], a[5]))
			},
			"path_symlink": func(p *Process, a []int64) (int32, error) {
				return p.symlink(append([]byte{}, p.bytes(a[0], a[1])...), a[2], p.str(a[3], a[4]))
			},
			"path_readlink": func(p *Process, a []int64) (int32, error) {
				return p.readlink(a[0], p.str(a[1], a[2]), a[3], a[4], a[5])
			},
			"path_link": func(p *Process, a []int64) (int32, error) {
				return p.hardlink(a[0], p.str(a[2], a[3]), a[4], p.str(a[5], a[6]))
			},
		},
		"skein": {
			"cmd_exists": func(p *Process, a []int64) (int32, error) {
				if p.run.exists(p.str(a[0], a[1])) {
					return 1, nil
				}
				return 0, nil
			},
			"pipe": func(p *Process, a []int64) (int32, error) {
				pipe := NewPipe(64<<20, nil)
				r := p.add(p.run.pipeDesc(pipe, false))
				w := p.add(p.run.pipeDesc(pipe, true))
				p.setU32(a[0], uint32(r))
				p.setU32(a[0]+4, uint32(w))
				return 0, nil
			},
			"spawn": (*Process).spawn,
		},
	}
}

// link defines every function the module imports on a fresh linker, bound to p.
func (p *Process) link(l *wasmtime.Linker, m *wasmtime.Module, mem func(*wasmtime.Caller) []byte) error {
	for _, imp := range m.Imports() {
		ft := imp.Type().FuncType()
		if ft == nil || imp.Name() == nil {
			continue
		}
		name := *imp.Name()
		h := imports[imp.Module()][name]
		if h == nil {
			h = func(*Process, []int64) (int32, error) { return int32(ENOSYS), nil }
		}
		results := len(ft.Results())
		err := l.FuncNew(imp.Module(), name, ft, func(c *wasmtime.Caller, args []wasmtime.Val) (res []wasmtime.Val, trap *wasmtime.Trap) {
			a := make([]int64, len(args))
			for i, v := range args {
				if v.Kind() == wasmtime.KindI64 {
					a[i] = v.I64()
				} else {
					a[i] = int64(v.I32())
				}
			}
			defer func() {
				if x := recover(); x != nil {
					p.fatal = fmt.Errorf("%s: %s: host fault: %v", p.args[0], name, x)
					res, trap = nil, wasmtime.NewTrap("host fault")
				}
			}()
			p.mem = mem(c)
			r, err := h(p, a)
			if err != nil {
				var ex exit
				if errors.As(err, &ex) {
					p.exit = &ex.code
					return nil, wasmtime.NewTrap("exit")
				}
				e, isErrno := errnoOf(err)
				if !isErrno {
					if p.fatal == nil {
						p.fatal = err
					}
					return nil, wasmtime.NewTrap(err.Error())
				}
				r = int32(e)
			}
			if results == 0 {
				return nil, nil
			}
			return []wasmtime.Val{wasmtime.ValI32(r)}, nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------- args, env

func (p *Process) sizes(list []string, count, size int64) (int32, error) {
	n := 0
	for _, s := range list {
		n += len(s) + 1
	}
	p.setU32(count, uint32(len(list)))
	p.setU32(size, uint32(n))
	return 0, nil
}

func (p *Process) strings(list []string, ptrs, buf int64) (int32, error) {
	for i, s := range list {
		p.setU32(ptrs+int64(i)*4, uint32(buf))
		copy(p.mem[uint32(buf):], s+"\x00")
		buf += int64(len(s) + 1)
	}
	return 0, nil
}

// ---------------------------------------------------------------- fd io

func (p *Process) setData(n *Node, data []byte) {
	n.Data = data
	p.run.vfs.Dirty(n)
}

func (p *Process) fdWrite(a []int64) (int32, error) {
	d, err := p.desc(a[0])
	if err != nil {
		return 0, err
	}
	var bufs [][]byte
	total := 0
	for _, io := range p.iovs(a[1], a[2]) {
		bufs = append(bufs, append([]byte{}, p.bytes(io[0], io[1])...))
		total += int(io[1])
	}
	switch d.t {
	case dNull:
	case dPipe:
		if !d.write {
			return int32(EBADF), nil
		}
		for _, b := range bufs {
			if !d.pipe.Write(b) {
				return int32(EPIPE), nil
			}
		}
	case dFile:
		if !d.write {
			return int32(EBADF), nil
		}
		data := d.node.Data
		at := d.pos
		if d.append {
			at = len(data)
		}
		next := resize(data, max(len(data), at+total))
		off := at
		for _, b := range bufs {
			off += copy(next[off:], b)
		}
		p.setData(d.node, next)
		d.pos = off
	case dDir:
		return int32(EBADF), nil
	}
	p.setU32(a[3], uint32(total))
	return 0, nil
}

// fdRead reads into iovecs; at >= 0 is a pread at that offset.
func (p *Process) fdRead(fd, iovs, n, nr, at int64) (int32, error) {
	d, err := p.desc(fd)
	if err != nil {
		return 0, err
	}
	got := 0
	for _, io := range p.iovs(iovs, n) {
		l := int(io[1])
		var chunk []byte
		switch d.t {
		case dNull:
		case dPipe:
			if d.write {
				return int32(EBADF), nil
			}
			chunk = d.pipe.Read(l)
		case dFile:
			if !d.read {
				return int32(EBADF), nil
			}
			pos := d.pos
			if at >= 0 {
				pos = int(at) + got
			}
			data := d.node.Data
			if pos < len(data) {
				chunk = data[pos:min(len(data), pos+l)]
			}
			if at < 0 {
				d.pos += len(chunk)
			}
		default:
			return int32(EISDIR), nil
		}
		copy(p.mem[uint32(io[0]):], chunk)
		got += len(chunk)
		if len(chunk) < l {
			break
		}
	}
	p.setU32(nr, uint32(got))
	return 0, nil
}

func (p *Process) fdSeek(fd, off, whence, out int64) (int32, error) {
	d, err := p.desc(fd)
	if err != nil {
		return 0, err
	}
	if d.t != dFile {
		if d.t == dDir {
			return int32(EBADF), nil
		}
		return int32(ESPIPE), nil
	}
	base := 0
	switch int32(whence) {
	case 1:
		base = d.pos
	case 2:
		base = len(d.node.Data)
	}
	pos := int64(base) + off
	if pos < 0 {
		return int32(EINVAL), nil
	}
	d.pos = int(pos)
	p.setU64(out, uint64(pos))
	return 0, nil
}

// Nothing is a terminal: a char device must lack seek/tell rights to count as
// a tty, and ours has them all.
func (p *Process) fdstat(a []int64) (int32, error) {
	d, err := p.desc(a[0])
	if err != nil {
		return 0, err
	}
	ft := uint8(ftUnknown)
	switch d.t {
	case dFile:
		ft = ftFile
	case dDir:
		ft = ftDir
	case dNull:
		ft = ftChar
	}
	flags := uint16(0)
	if d.t == dFile && d.append {
		flags = fdflagAppend
	}
	p.setU8(a[1], ft)
	p.setU16(a[1]+2, flags)
	p.setU64(a[1]+8, allRights)
	p.setU64(a[1]+16, allRights)
	return 0, nil
}

func (p *Process) fdFilestat(a []int64) (int32, error) {
	d, err := p.desc(a[0])
	if err != nil {
		return 0, err
	}
	switch d.t {
	case dFile:
		p.writeStat(a[1], d.ino, ftFile, len(d.node.Data))
	case dDir:
		p.writeStat(a[1], d.ino, ftDir, 0)
	case dNull:
		p.writeStat(a[1], d.ino, ftChar, 0)
	case dPipe:
		p.writeStat(a[1], d.ino, ftUnknown, d.pipe.Size())
	}
	return 0, nil
}

func (p *Process) fdReaddir(a []int64) (int32, error) {
	fd, buf, size, cookie, used := a[0], a[1], int(uint32(a[2])), uint64(a[3]), a[4]
	dir, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	m, err := p.run.vfs.Dir(dir)
	if err != nil {
		return 0, err
	}
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return utf16Less(names[i], names[j]) })
	type ent struct {
		name string
		ino  uint64
		ft   uint8
	}
	list := []ent{{".", dir.Ino, ftDir}, {"..", parentOr(dir).Ino, ftDir}}
	for _, name := range names {
		n := m[name]
		ft := uint8(ftDir)
		switch n.Kind {
		case KFile:
			ft = ftFile
		case KLink:
			ft = ftLink
		}
		list = append(list, ent{name, n.Ino, ft})
	}
	var out []byte
	for i := cookie; i < uint64(len(list)) && len(out) < size; i++ {
		e := list[i]
		h := make([]byte, 24)
		binary.LittleEndian.PutUint64(h, i+1)
		binary.LittleEndian.PutUint64(h[8:], e.ino)
		binary.LittleEndian.PutUint32(h[16:], uint32(len(e.name)))
		h[20] = e.ft
		out = append(append(out, h...), e.name...)
	}
	out = out[:min(len(out), size)] // a truncated last entry tells libc to retry bigger
	copy(p.mem[uint32(buf):], out)
	p.setU32(used, uint32(len(out)))
	return 0, nil
}

// utf16Less orders as JavaScript's string < does (UTF-16 code units), which
// differs from byte order only above U+FFFF against U+E000–U+FFFF.
func utf16Less(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	unit := func(r rune) int {
		if r >= 0x10000 {
			return 0xD800 + int((r-0x10000)>>10)
		}
		return int(r)
	}
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if ra[i] != rb[i] {
			if ua, ub := unit(ra[i]), unit(rb[i]); ua != ub {
				return ua < ub
			}
			return ra[i] < rb[i]
		}
	}
	return len(ra) < len(rb)
}

// ---------------------------------------------------------------- paths

func (p *Process) pathOpen(dirfd, dirflags int64, path string, oflags int64, rights uint64, fdflags, out int64) (int32, error) {
	v := p.run.vfs
	base, err := p.dirDesc(dirfd)
	if err != nil {
		return 0, err
	}
	if dev := p.device(base, path); dev != nil {
		p.setU32(out, uint32(p.add(dev)))
		return 0, nil
	}
	follow := dirflags&1 != 0
	wantWrite := rights&rightWrite != 0 || oflags&oTrunc != 0
	dir, name, err := v.ResolveParent(base, path)
	if err != nil {
		return 0, err
	}
	var node *Node
	switch name {
	case "", ".":
		node = dir
	case "..":
		node = parentOr(dir)
	default:
		m, err := v.Dir(dir)
		if err != nil {
			return 0, err
		}
		node = m[name]
		if node != nil && node.Kind == KLink && follow {
			target, err := v.Resolve(dir, name, true)
			if err != nil {
				// A dangling symlink with O_CREAT creates its target, as on unix.
				if !errors.Is(err, ENOENT) || oflags&oCreat == 0 {
					return 0, err
				}
				t, err := v.Content(node)
				if err != nil {
					return 0, err
				}
				s := string(t)
				if !strings.HasPrefix(s, "/") {
					s = v.PathOf(dir) + "/" + s
				}
				return p.pathOpen(dirfd, dirflags, s, oflags, rights, fdflags, out)
			}
			node = target
		}
	}
	if node != nil && oflags&oCreat != 0 && oflags&oExcl != 0 {
		return int32(EEXIST), nil
	}
	if node == nil {
		if oflags&oCreat == 0 {
			return int32(ENOENT), nil
		}
		if oflags&oDirectory != 0 {
			return int32(EINVAL), nil
		}
		if err := CheckName(name); err != nil {
			return 0, err
		}
		if dir.Readonly {
			return int32(EROFS), nil
		}
		node = v.NewFile(dir, nil, false)
		if err := v.Link(dir, name, node); err != nil {
			return 0, err
		}
	}
	if node.Kind == KLink {
		return int32(ELOOP), nil
	}
	if node.Kind == KDir || node.Kind == KModule {
		if wantWrite {
			return int32(EISDIR), nil
		}
		d := node
		if node.Kind == KModule {
			d = moduleDir(node)
		}
		p.setU32(out, uint32(p.add(&Desc{t: dDir, node: d, ino: node.Ino})))
		return 0, nil
	}
	if oflags&oDirectory != 0 {
		return int32(ENOTDIR), nil
	}
	if _, err := v.Content(node); err != nil {
		return 0, err
	}
	if oflags&oTrunc != 0 && len(node.Data) > 0 {
		p.setData(node, []byte{})
	}
	d := &Desc{
		t: dFile, node: node, ino: node.Ino,
		append: fdflags&fdflagAppend != 0,
		read:   rights&rightRead != 0 || !wantWrite,
		write:  wantWrite,
	}
	p.setU32(out, uint32(p.add(d)))
	return 0, nil
}

// device: /dev/null and /dev/std{in,out,err} exist whatever the tree holds
// (unless it has its own /dev, among entries already loaded — as on the Node host).
func (p *Process) device(base *Node, path string) *Desc {
	root := p.run.vfs.Root
	if base != root && !strings.HasPrefix(path, "/") {
		return nil
	}
	var parts []string
	for _, x := range strings.Split(path, "/") {
		if x != "" && x != "." {
			parts = append(parts, x)
		}
	}
	s := strings.Join(parts, "/")
	if !strings.HasPrefix(s, "dev/") || (root.Entries != nil && root.Entries["dev"] != nil) {
		return nil
	}
	switch s {
	case "dev/null":
		return p.run.nullDesc()
	case "dev/stdin":
		return p.fds[0]
	case "dev/stdout":
		return p.fds[1]
	case "dev/stderr":
		return p.fds[2]
	}
	return nil
}

func (p *Process) pathFilestat(fd, flags int64, path string, buf int64) (int32, error) {
	base, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	if dev := p.device(base, path); dev != nil {
		p.writeStat(buf, dev.ino, ftChar, 0)
		return 0, nil
	}
	n, err := p.run.vfs.Resolve(base, path, flags&1 != 0)
	if err != nil {
		return 0, err
	}
	ft, size, err := p.nodeStat(n)
	if err != nil {
		return 0, err
	}
	p.writeStat(buf, n.Ino, ft, size)
	return 0, nil
}

// parentAndEntries resolves the directory holding path's last component.
func (p *Process) parentAndEntries(fd int64, path string) (*Node, string, map[string]*Node, error) {
	base, err := p.dirDesc(fd)
	if err != nil {
		return nil, "", nil, err
	}
	dir, name, err := p.run.vfs.ResolveParent(base, path)
	if err != nil {
		return nil, "", nil, err
	}
	m, err := p.run.vfs.Dir(dir)
	return dir, name, m, err
}

func (p *Process) mkdir(fd int64, path string) (int32, error) {
	base, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	v := p.run.vfs
	dir, name, err := v.ResolveParent(base, path)
	if err != nil {
		return 0, err
	}
	if name == "" || name == "." || name == ".." {
		return int32(EEXIST), nil
	}
	m, err := v.Dir(dir)
	if err != nil {
		return 0, err
	}
	if m[name] != nil {
		return int32(EEXIST), nil
	}
	if dir.Readonly {
		return int32(EROFS), nil
	}
	return 0, v.Link(dir, name, v.NewDir(dir))
}

func (p *Process) rmdir(fd int64, path string) (int32, error) {
	base, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	v := p.run.vfs
	dir, name, err := v.ResolveParent(base, path)
	if err != nil {
		return 0, err
	}
	if name == "" || name == "." || name == ".." {
		return int32(EINVAL), nil
	}
	m, err := v.Dir(dir)
	if err != nil {
		return 0, err
	}
	n := m[name]
	if n == nil {
		return int32(ENOENT), nil
	}
	if n.Kind != KDir && n.Kind != KModule {
		return int32(ENOTDIR), nil
	}
	if n.Kind == KDir {
		sub, err := v.Dir(n)
		if err != nil {
			return 0, err
		}
		if len(sub) > 0 {
			return int32(ENOTEMPTY), nil
		}
	}
	return 0, v.Unlink(dir, name)
}

func (p *Process) unlinkFile(fd int64, path string) (int32, error) {
	base, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	v := p.run.vfs
	dir, name, err := v.ResolveParent(base, path)
	if err != nil {
		return 0, err
	}
	if name == "" || name == "." || name == ".." {
		return int32(EISDIR), nil
	}
	m, err := v.Dir(dir)
	if err != nil {
		return 0, err
	}
	n := m[name]
	if n == nil {
		return int32(ENOENT), nil
	}
	if n.Kind == KDir || n.Kind == KModule {
		return int32(EISDIR), nil
	}
	return 0, v.Unlink(dir, name)
}

func (p *Process) rename(fd int64, from string, fd2 int64, to string) (int32, error) {
	v := p.run.vfs
	baseA, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	aDir, aName, err := v.ResolveParent(baseA, from)
	if err != nil {
		return 0, err
	}
	baseB, err := p.dirDesc(fd2)
	if err != nil {
		return 0, err
	}
	bDir, bName, err := v.ResolveParent(baseB, to)
	if err != nil {
		return 0, err
	}
	for _, x := range []string{aName, bName} {
		if x == "" || x == "." || x == ".." {
			return int32(EINVAL), nil
		}
	}
	ma, err := v.Dir(aDir)
	if err != nil {
		return 0, err
	}
	src := ma[aName]
	if src == nil {
		return int32(ENOENT), nil
	}
	mb, err := v.Dir(bDir)
	if err != nil {
		return 0, err
	}
	dst := mb[bName]
	if dst == src {
		return 0, nil
	}
	if bDir.Readonly {
		return int32(EROFS), nil
	}
	if src.Kind == KDir {
		for x := bDir; x != nil; x = x.Parent {
			if x == src {
				return int32(EINVAL), nil // into itself
			}
		}
		if dst != nil && dst.Kind != KDir {
			return int32(ENOTDIR), nil
		}
		if dst != nil {
			sub, err := v.Dir(dst)
			if err != nil {
				return 0, err
			}
			if len(sub) > 0 {
				return int32(ENOTEMPTY), nil
			}
		}
	} else if dst != nil && dst.Kind == KDir {
		return int32(EISDIR), nil
	}
	if err := CheckName(bName); err != nil {
		return 0, err
	}
	if err := v.Unlink(aDir, aName); err != nil {
		return 0, err
	}
	return 0, v.Link(bDir, bName, src)
}

func (p *Process) symlink(target []byte, fd int64, path string) (int32, error) {
	dir, name, m, err := p.parentAndEntries(fd, path)
	if err != nil {
		return 0, err
	}
	if m[name] != nil {
		return int32(EEXIST), nil
	}
	if dir.Readonly {
		return int32(EROFS), nil
	}
	if err := CheckName(name); err != nil {
		return 0, err
	}
	v := p.run.vfs
	return 0, v.Link(dir, name, v.NewLink(dir, target))
}

func (p *Process) readlink(fd int64, path string, buf, size, used int64) (int32, error) {
	base, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	n, err := p.run.vfs.Resolve(base, path, false)
	if err != nil {
		return 0, err
	}
	if n.Kind != KLink {
		return int32(EINVAL), nil
	}
	t, err := p.run.vfs.Content(n)
	if err != nil {
		return 0, err
	}
	t = t[:min(len(t), int(uint32(size)))]
	copy(p.mem[uint32(buf):], t)
	p.setU32(used, uint32(len(t)))
	return 0, nil
}

// hardlink: git has no hard links, so a link is a copy that shares nothing afterwards.
func (p *Process) hardlink(fd int64, from string, fd2 int64, to string) (int32, error) {
	v := p.run.vfs
	base, err := p.dirDesc(fd)
	if err != nil {
		return 0, err
	}
	src, err := v.Resolve(base, from, false)
	if err != nil {
		return 0, err
	}
	if src.Kind != KFile {
		return int32(EPERM), nil
	}
	dir, name, m, err := p.parentAndEntries(fd2, to)
	if err != nil {
		return 0, err
	}
	if m[name] != nil {
		return int32(EEXIST), nil
	}
	if dir.Readonly {
		return int32(EROFS), nil
	}
	if err := CheckName(name); err != nil {
		return 0, err
	}
	data, err := v.Content(src)
	if err != nil {
		return 0, err
	}
	return 0, v.Link(dir, name, v.NewFile(dir, append([]byte{}, data...), src.Exec))
}

// ---------------------------------------------------------------- time

// pollOneoff: fd subscriptions are ready at once (reads never block: processes
// run one at a time). A poll on clocks only is a sleep, and outside a thread a
// sleep returns at once, as runShell's default does.
func (p *Process) pollOneoff(a []int64) (int32, error) {
	in, out, n, nout := a[0], a[1], a[2], a[3]
	for i := int64(0); i < n; i++ {
		s, e := in+i*48, out+i*32
		tag := p.mem[uint32(s+8)]
		p.setU64(e, p.u64(s))
		p.setU16(e+8, 0)
		p.setU8(e+10, tag)
		var nbytes uint64
		if tag == 1 {
			if d := p.fds[int(int32(p.u32(s+16)))]; d != nil {
				switch d.t {
				case dPipe:
					nbytes = uint64(d.pipe.Size())
				case dFile:
					nbytes = uint64(max(0, len(d.node.Data)-d.pos))
				}
			}
		}
		p.setU64(e+16, nbytes)
		p.setU16(e+24, 0)
	}
	p.setU32(nout, uint32(n))
	return 0, nil
}

// ---------------------------------------------------------------- spawn

func (p *Process) spawn(a []int64) (int32, error) {
	fields := strings.Split(p.str(a[0], a[1]), "\x00")
	next := func() string {
		if len(fields) == 0 {
			return ""
		}
		f := fields[0]
		fields = fields[1:]
		return f
	}
	take := func() []string {
		n, _ := strconv.Atoi(next())
		n = min(max(n, 0), len(fields))
		out := fields[:n]
		fields = fields[n:]
		return out
	}
	req := SpawnRequest{Program: next(), Cwd: next()}
	req.Argv = take()
	req.Env = take()
	for i, fd := range a[2:5] {
		d := p.fds[int(int32(fd))]
		if int32(fd) < 0 || d == nil {
			d = p.run.nullDesc()
		}
		req.Stdio[i] = d
	}
	rc, found, err := p.run.spawn(p, req)
	if err != nil {
		return 0, err
	}
	if !found {
		return int32(ENOENT), nil
	}
	p.setU32(a[5], uint32(rc))
	return 0, nil
}

// resize returns data at n bytes, zero-extended. Buffers belong to one node
// (the store hands out fresh copies), so growing in place is safe.
func resize(data []byte, n int) []byte {
	if n <= cap(data) {
		old := len(data)
		data = data[:n]
		if n > old {
			clear(data[old:])
		}
		return data
	}
	b := make([]byte, n, max(n, min(n*2, n+16<<20), 4096))
	copy(b, data)
	return b
}
