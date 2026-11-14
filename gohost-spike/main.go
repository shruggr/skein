// Feasibility spike, not a host: skein's wasm kernel (kernel-zig/zig-out/web/skein-kernel.wasm)
// loaded by Go through wasmtime-go, with the three import namespaces kernel-zig/web/kernel.js gives
// it (skein_engine, skein_store, skein_peer) written here one for one, over an in-memory store.
// It replays one captured COMMIT (gohost-spike/capture.ts): before.bundle into store 1, open,
// start, drain, then the frame. Writes go-reply.cbor, go-after.bundle, go-notices.txt.
//
//	go run . <fixture dir> <kernel wasm> [reps]
package main

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/bytecodealliance/wasmtime-go/v49"
)

// ---------------------------------------------------------------- the store (kernel.js MemoryStore)

type batch struct {
	blocks map[string][]byte
	ptrs   map[string][]byte
	order  []string
}

type memStore struct {
	blocks map[string][]byte
	order  []string // insertion order, as a JS Map keeps it (writeBundle's order)
	ptrs   map[string][]byte
	tx     *batch
}

func newMemStore() *memStore {
	return &memStore{blocks: map[string][]byte{}, ptrs: map[string][]byte{}}
}

func (s *memStore) get(cid []byte) ([]byte, bool) {
	k := string(cid)
	if s.tx != nil {
		if b, ok := s.tx.blocks[k]; ok {
			return b, true
		}
	}
	b, ok := s.blocks[k]
	return b, ok
}
func (s *memStore) put(cid, b []byte) bool {
	if _, ok := s.get(cid); ok {
		return true
	}
	k := string(cid)
	if s.tx != nil {
		s.tx.blocks[k] = b
		s.tx.order = append(s.tx.order, k)
	} else {
		s.apply(&batch{blocks: map[string][]byte{k: b}, ptrs: map[string][]byte{}, order: []string{k}})
	}
	return true
}
func (s *memStore) ptrGet(name string) ([]byte, bool) {
	if s.tx != nil {
		if c, ok := s.tx.ptrs[name]; ok {
			return c, true
		}
	}
	c, ok := s.ptrs[name]
	return c, ok
}
func (s *memStore) ptrSet(name string, cid []byte) bool {
	if s.tx != nil {
		s.tx.ptrs[name] = cid
	} else {
		s.apply(&batch{blocks: map[string][]byte{}, ptrs: map[string][]byte{name: cid}})
	}
	return true
}
func (s *memStore) begin()    { s.tx = &batch{blocks: map[string][]byte{}, ptrs: map[string][]byte{}} }
func (s *memStore) rollback() { s.tx = nil }
func (s *memStore) commit() bool {
	t := s.tx
	s.tx = nil
	if t != nil {
		s.apply(t)
	}
	return true
}
func (s *memStore) apply(b *batch) {
	for _, k := range b.order {
		if _, had := s.blocks[k]; !had {
			s.order = append(s.order, k)
		}
		s.blocks[k] = b.blocks[k]
	}
	for n, c := range b.ptrs {
		s.ptrs[n] = c
	}
}

func readBundle(buf []byte, s *memStore) {
	i := 0
	u32 := func() int { v := binary.LittleEndian.Uint32(buf[i:]); i += 4; return int(v) }
	for {
		cn := u32()
		if cn == 0 {
			break
		}
		cid := string(buf[i : i+cn])
		i += cn
		bn := u32()
		s.blocks[cid] = append([]byte(nil), buf[i:i+bn]...)
		s.order = append(s.order, cid)
		i += bn
	}
	for i < len(buf) {
		nn := u32()
		name := string(buf[i : i+nn])
		i += nn
		cn := u32()
		s.ptrs[name] = append([]byte(nil), buf[i:i+cn]...)
		i += cn
	}
}

func writeBundle(s *memStore) []byte {
	var out []byte
	put := func(b []byte) { out = binary.LittleEndian.AppendUint32(out, uint32(len(b))); out = append(out, b...) }
	for _, k := range s.order {
		put([]byte(k))
		put(s.blocks[k])
	}
	out = binary.LittleEndian.AppendUint32(out, 0)
	names := make([]string, 0, len(s.ptrs))
	for n := range s.ptrs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		put([]byte(n))
		put(s.ptrs[n])
	}
	return out
}

// ---------------------------------------------------------------- the kernel (kernel.js Kernel)

type importKind struct {
	result int // 0 none, 1 i32, 2 i64
	first  int
}

type appModule struct {
	module *wasmtime.Module
	kinds  []importKind
	types  []*wasmtime.FuncType // the function imports, in order
	nimp   int                  // all imports (must all be functions, as in kernel.js)
}

type appInstance struct {
	inst *wasmtime.Instance
	mem  *wasmtime.Memory
	fuel *wasmtime.Global
	oog  *wasmtime.Global
}

type Kernel struct {
	engine      *wasmtime.Engine
	store       *wasmtime.Store
	inst        *wasmtime.Instance
	mem         *wasmtime.Memory
	x           map[string]*wasmtime.Func
	stores      map[uint32]*memStore
	held        []byte
	modules     []*appModule
	instances   map[int32]*appInstance
	next        int32
	engineErr   string
	abort       bool
	fault       error
	notices     []string
	t0          time.Time
	compiled    int
	instCount   int
	hostCalls   int
	compileTime time.Duration
	outcomes    []int32 // each run's code, for the report
}

type abortErr struct{}

func (abortErr) Error() string { return "skein: abort" }

func i32(v wasmtime.Val) uint32 { return uint32(v.I32()) }

// kbytes: the kernel's memory [p, p+n), fresh (a grow moves it).
func (k *Kernel) kbytes(s wasmtime.Storelike, p, n uint32) []byte {
	d := k.mem.UnsafeData(s)
	return d[p : p+n]
}

func (k *Kernel) hold(b []byte) int32 { k.held = b; return int32(len(b)) }

func (k *Kernel) call(s wasmtime.Storelike, name string, args ...interface{}) (int32, error) {
	r, err := k.x[name].Call(s, args...)
	if err != nil {
		return 0, err
	}
	if r == nil {
		return 0, nil
	}
	return r.(int32), nil
}

func fn(params []wasmtime.ValKind, results []wasmtime.ValKind) *wasmtime.FuncType {
	p := make([]*wasmtime.ValType, len(params))
	for i, k := range params {
		p[i] = wasmtime.NewValType(k)
	}
	r := make([]*wasmtime.ValType, len(results))
	for i, k := range results {
		r[i] = wasmtime.NewValType(k)
	}
	return wasmtime.NewFuncType(p, r)
}

var (
	I32 = wasmtime.KindI32
	I64 = wasmtime.KindI64
	F64 = wasmtime.KindF64
)

func ret32(v int32) ([]wasmtime.Val, *wasmtime.Trap) { return []wasmtime.Val{wasmtime.ValI32(v)}, nil }

func NewKernel(engine *wasmtime.Engine, module *wasmtime.Module, stores map[uint32]*memStore) (*Kernel, error) {
	k := &Kernel{engine: engine, store: wasmtime.NewStore(engine), stores: stores, instances: map[int32]*appInstance{}, next: 1, x: map[string]*wasmtime.Func{}, t0: time.Now()}
	l := wasmtime.NewLinker(engine)
	def := func(mod, name string, ty *wasmtime.FuncType, f func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap)) {
		if err := l.FuncNew(mod, name, ty, f); err != nil {
			panic(err)
		}
	}
	st := func(id uint32) (*memStore, *wasmtime.Trap) {
		s := k.stores[id]
		if s == nil {
			return nil, wasmtime.NewTrap(fmt.Sprintf("kernel: no store %d", id))
		}
		return s, nil
	}
	guest := func(h int32) (*appInstance, *wasmtime.Trap) {
		g := k.instances[h]
		if g == nil {
			return nil, wasmtime.NewTrap(fmt.Sprintf("kernel: no instance %d", h))
		}
		return g, nil
	}

	// skein_store
	def("skein_store", "get", fn([]wasmtime.ValKind{I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		b, ok := s.get(k.kbytes(c, i32(a[1]), i32(a[2])))
		if !ok {
			return ret32(-1)
		}
		return ret32(k.hold(b))
	})
	take := func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		copy(k.kbytes(c, i32(a[0]), uint32(len(k.held))), k.held)
		return nil, nil
	}
	def("skein_store", "take", fn([]wasmtime.ValKind{I32}, nil), take)
	def("skein_store", "has", fn([]wasmtime.ValKind{I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		if _, ok := s.get(k.kbytes(c, i32(a[1]), i32(a[2]))); ok {
			return ret32(1)
		}
		return ret32(0)
	})
	def("skein_store", "put", fn([]wasmtime.ValKind{I32, I32, I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		cid := append([]byte(nil), k.kbytes(c, i32(a[1]), i32(a[2]))...)
		b := append([]byte(nil), k.kbytes(c, i32(a[3]), i32(a[4]))...)
		if s.put(cid, b) {
			return ret32(0)
		}
		return ret32(-1)
	})
	def("skein_store", "begin", fn([]wasmtime.ValKind{I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		s.begin()
		return nil, nil
	})
	def("skein_store", "commit", fn([]wasmtime.ValKind{I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		if s.commit() {
			return ret32(0)
		}
		return ret32(-1)
	})
	def("skein_store", "rollback", fn([]wasmtime.ValKind{I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		s.rollback()
		return nil, nil
	})
	def("skein_store", "pointer_get", fn([]wasmtime.ValKind{I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		cid, ok := s.ptrGet(string(k.kbytes(c, i32(a[1]), i32(a[2]))))
		if !ok {
			return ret32(-1)
		}
		return ret32(k.hold(cid))
	})
	def("skein_store", "pointer_set", fn([]wasmtime.ValKind{I32, I32, I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		s, t := st(i32(a[0]))
		if t != nil {
			return nil, t
		}
		name := string(k.kbytes(c, i32(a[1]), i32(a[2])))
		if s.ptrSet(name, append([]byte(nil), k.kbytes(c, i32(a[3]), i32(a[4]))...)) {
			return ret32(0)
		}
		return ret32(-1)
	})

	// skein_engine
	def("skein_engine", "compile", fn([]wasmtime.ValKind{I32, I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		return ret32(k.compile(append([]byte(nil), k.kbytes(c, i32(a[0]), i32(a[1]))...), append([]byte(nil), k.kbytes(c, i32(a[2]), i32(a[3]))...)))
	})
	def("skein_engine", "instantiate", fn([]wasmtime.ValKind{I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		return ret32(k.instantiate(c, a[0].I32()))
	})
	def("skein_engine", "run", fn([]wasmtime.ValKind{I32, I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		r, fault := k.run(c, a[0].I32(), a[1].I32() != 0, string(k.kbytes(c, i32(a[2]), i32(a[3]))))
		k.outcomes = append(k.outcomes, r)
		if fault != nil {
			// kernel.js: a KernelFault is rethrown out of `run`, through the kernel's own frames.
			return nil, wasmtime.NewTrap("kernel fault: " + fault.Error())
		}
		return ret32(r)
	})
	def("skein_engine", "release", fn([]wasmtime.ValKind{I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		delete(k.instances, a[0].I32())
		return nil, nil
	})
	def("skein_engine", "fuel_get", fn([]wasmtime.ValKind{I32}, []wasmtime.ValKind{I64}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		g, t := guest(a[0].I32())
		if t != nil {
			return nil, t
		}
		return []wasmtime.Val{wasmtime.ValI64(g.fuel.Get(c).I64())}, nil
	})
	def("skein_engine", "fuel_set", fn([]wasmtime.ValKind{I32, I64}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		g, t := guest(a[0].I32())
		if t != nil {
			return nil, t
		}
		if err := g.fuel.Set(c, wasmtime.ValI64(a[1].I64())); err != nil {
			return nil, wasmtime.NewTrap(err.Error())
		}
		return nil, nil
	})
	def("skein_engine", "mem_read", fn([]wasmtime.ValKind{I32, I32, I32, I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		g, t := guest(a[0].I32())
		if t != nil {
			return nil, t
		}
		at, n, p := i32(a[1]), i32(a[2]), i32(a[3])
		src := g.mem.UnsafeData(c)
		if uint64(at)+uint64(n) > uint64(len(src)) {
			return nil, wasmtime.NewTrap("mem_read: out of bounds")
		}
		copy(k.kbytes(c, p, n), src[at:at+n])
		return nil, nil
	})
	def("skein_engine", "mem_write", fn([]wasmtime.ValKind{I32, I32, I32, I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		g, t := guest(a[0].I32())
		if t != nil {
			return nil, t
		}
		at, n, p := i32(a[1]), i32(a[2]), i32(a[3])
		dst := g.mem.UnsafeData(c)
		if uint64(at)+uint64(n) > uint64(len(dst)) {
			return nil, wasmtime.NewTrap("mem_write: out of bounds")
		}
		copy(dst[at:at+n], k.kbytes(c, p, n))
		return nil, nil
	})
	def("skein_engine", "error_len", fn(nil, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		return ret32(int32(len(k.engineErr)))
	})
	def("skein_engine", "error_take", fn([]wasmtime.ValKind{I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		copy(k.kbytes(c, i32(a[0]), uint32(len(k.engineErr))), k.engineErr)
		return nil, nil
	})

	// skein_peer
	def("skein_peer", "request", fn([]wasmtime.ValKind{I32, I32, I32, I32}, []wasmtime.ValKind{I32}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		op := string(k.kbytes(c, i32(a[0]), i32(a[1])))
		k.notices = append(k.notices, "request "+op)
		msg := []byte("this host answers no " + op)
		return ret32(-k.hold(msg) - 1)
	})
	def("skein_peer", "notify", fn([]wasmtime.ValKind{I32, I32, I32, I32}, nil), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		op := string(k.kbytes(c, i32(a[0]), i32(a[1])))
		b := k.kbytes(c, i32(a[2]), i32(a[3]))
		if op == "say" || op == "panic" {
			k.notices = append(k.notices, "notify "+op+" "+string(b))
		} else {
			k.notices = append(k.notices, "notify "+op+" "+hex.EncodeToString(b))
		}
		return nil, nil
	})
	def("skein_peer", "take", fn([]wasmtime.ValKind{I32}, nil), take)
	def("skein_peer", "now_ms", fn(nil, []wasmtime.ValKind{F64}), func(c *wasmtime.Caller, a []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
		return []wasmtime.Val{wasmtime.ValF64(float64(time.Since(k.t0).Nanoseconds()) / 1e6)}, nil
	})

	inst, err := l.Instantiate(k.store, module)
	if err != nil {
		return nil, err
	}
	k.inst = inst
	k.mem = inst.GetExport(k.store, "memory").Memory()
	for _, n := range []string{"skein_alloc", "skein_free", "skein_result", "skein_args", "skein_host_call", "skein_open", "skein_start", "skein_drain", "skein_call", "skein_state"} {
		e := inst.GetExport(k.store, n)
		if e == nil || e.Func() == nil {
			return nil, fmt.Errorf("kernel: no export %s", n)
		}
		k.x[n] = e.Func()
	}
	return k, nil
}

// ---------------------------------------------------------------- the engine: programs on wasmtime

func (k *Kernel) compile(bytes, desc []byte) int32 {
	tc := time.Now()
	m, err := wasmtime.NewModule(k.engine, bytes)
	k.compileTime += time.Since(tc)
	if err != nil {
		k.engineErr = err.Error()
		return -1
	}
	am := &appModule{module: m}
	for i := 0; i+5 <= len(desc); i += 5 {
		am.kinds = append(am.kinds, importKind{result: int(desc[i]), first: int(binary.LittleEndian.Uint32(desc[i+1:]))})
	}
	imps := m.Imports()
	am.nimp = len(imps)
	for _, imp := range imps {
		ft := imp.Type().FuncType()
		if ft == nil {
			k.engineErr = fmt.Sprintf("a non-function import %s.%s", imp.Module(), *imp.Name())
			return -1
		}
		am.types = append(am.types, ft)
	}
	k.modules = append(k.modules, am)
	k.compiled++
	return int32(len(k.modules) - 1)
}

func (k *Kernel) instantiate(s wasmtime.Storelike, h int32) int32 {
	m := k.modules[h]
	id := k.next
	k.next++
	fns := make([]*wasmtime.Func, len(m.types))
	ext := make([]wasmtime.AsExtern, len(m.types))
	for i, ft := range m.types {
		kind := importKind{result: 0, first: i}
		if i < len(m.kinds) {
			kind = m.kinds[i]
		}
		if kind.first != i {
			fns[i] = fns[kind.first]
			ext[i] = fns[i]
			continue
		}
		index, result, nres := uint32(i), kind.result, len(ft.Results())
		fns[i] = wasmtime.NewFunc(s, ft, func(c *wasmtime.Caller, args []wasmtime.Val) ([]wasmtime.Val, *wasmtime.Trap) {
			ap, err := k.call(c, "skein_args")
			if err != nil {
				k.fault = err
				return nil, wasmtime.NewTrap("kernel fault")
			}
			n := len(args)
			if n > 16 {
				n = 16
			}
			buf := k.kbytes(c, uint32(ap), 16*8)
			for j := 0; j < n; j++ {
				var v int64
				switch args[j].Kind() {
				case wasmtime.KindI32:
					v = int64(args[j].I32())
				case wasmtime.KindI64:
					v = args[j].I64()
				case wasmtime.KindF32:
					v = int64(math.Trunc(float64(args[j].F32())))
				case wasmtime.KindF64:
					v = int64(math.Trunc(args[j].F64()))
				}
				binary.LittleEndian.PutUint64(buf[j*8:], uint64(v))
			}
			var memLen int32
			if g := k.instances[id]; g != nil && g.mem != nil {
				memLen = int32(g.mem.DataSize(c))
			}
			k.hostCalls++
			r, err := k.call(c, "skein_host_call", id, int32(index), int32(n), memLen)
			if err != nil {
				k.fault = err
				return nil, wasmtime.NewTrap("kernel fault")
			}
			if r != 0 {
				k.abort = true
				return nil, wasmtime.NewTrap("skein: abort")
			}
			v := int64(binary.LittleEndian.Uint64(k.kbytes(c, uint32(ap), 8)))
			if nres == 0 {
				return nil, nil
			}
			switch result {
			case 2:
				return []wasmtime.Val{wasmtime.ValI64(v)}, nil
			case 1:
				return []wasmtime.Val{wasmtime.ValI32(int32(v))}, nil
			}
			return nil, wasmtime.NewTrap("an import with a result the kernel does not describe")
		})
		ext[i] = fns[i]
	}
	inst, err := wasmtime.NewInstance(s, m.module, ext)
	if err != nil {
		k.engineErr = err.Error()
		return -1
	}
	g := &appInstance{inst: inst}
	if e := inst.GetExport(s, "memory"); e != nil {
		g.mem = e.Memory()
	}
	if e := inst.GetExport(s, "__skein_fuel"); e != nil {
		g.fuel = e.Global()
	}
	if e := inst.GetExport(s, "__skein_oog"); e != nil {
		g.oog = e.Global()
	}
	k.instances[id] = g
	k.instCount++
	return id
}

// run: 0 returned; 1 aborted; 2 trapped; 3 out of fuel; < 0 another failure. A non-nil error is a
// kernel fault (the kernel failed inside a host call), passed up through the kernel's frames.
func (k *Kernel) run(s wasmtime.Storelike, id int32, hasStart bool, entry string) (int32, error) {
	g := k.instances[id]
	k.abort, k.fault = false, nil
	call := func(name string) (bool, error) {
		e := g.inst.GetExport(s, name)
		if e == nil || e.Func() == nil {
			return false, nil
		}
		_, err := e.Func().Call(s)
		return true, err
	}
	var err error
	if hasStart {
		_, err = call("__skein_start")
	}
	if err == nil {
		var found bool
		found, err = call(entry)
		if !found {
			k.engineErr = "no " + entry
			return -2, nil
		}
	}
	if err == nil {
		return 0, nil
	}
	if k.fault != nil {
		return 0, k.fault
	}
	if k.abort {
		return 1, nil
	}
	if g.oog != nil && g.oog.Get(s).I32() != 0 {
		return 3, nil
	}
	var trap *wasmtime.Trap
	if errors.As(err, &trap) {
		k.engineErr = trap.Message()
		return 2, nil
	}
	k.engineErr = err.Error()
	return -1, nil
}

// ---------------------------------------------------------------- the kernel's exports

func (k *Kernel) push(b []byte) (int32, int32, error) {
	if len(b) == 0 {
		return 0, 0, nil
	}
	p, err := k.call(k.store, "skein_alloc", int32(len(b)))
	if err != nil {
		return 0, 0, err
	}
	if p == 0 {
		return 0, 0, errors.New("kernel: out of memory")
	}
	copy(k.kbytes(k.store, uint32(p), uint32(len(b))), b)
	return p, int32(len(b)), nil
}

func (k *Kernel) result(n int32) ([]byte, error) {
	if n < 0 {
		return nil, nil
	}
	p, err := k.call(k.store, "skein_result")
	if err != nil {
		return nil, err
	}
	return append([]byte(nil), k.kbytes(k.store, uint32(p), uint32(n))...), nil
}

func (k *Kernel) check(r int32) error {
	if r < 0 {
		b, _ := k.result(-r - 1)
		return fmt.Errorf("kernel: %s", b)
	}
	return nil
}

func (k *Kernel) Open(id int32) error {
	r, err := k.call(k.store, "skein_open", id)
	if err != nil {
		return err
	}
	return k.check(r)
}

func (k *Kernel) Op(name string) ([]byte, error) {
	n, err := k.call(k.store, name)
	if err != nil {
		return nil, err
	}
	return k.result(n)
}

func (k *Kernel) Call(frame []byte) ([]byte, error) {
	p, n, err := k.push(frame)
	if err != nil {
		return nil, err
	}
	r, err := k.call(k.store, "skein_call", p, n)
	if err != nil {
		return nil, err
	}
	out, err := k.result(r)
	if n > 0 {
		if _, e := k.call(k.store, "skein_free", p, n); e != nil {
			return nil, e
		}
	}
	return out, err
}

// ---------------------------------------------------------------- the replay

func main() {
	dir, wasmPath := os.Args[1], os.Args[2]
	reps := 5
	if len(os.Args) > 3 {
		reps, _ = strconv.Atoi(os.Args[3])
	}
	must := func(err error) {
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(1)
		}
	}
	wasm, err := os.ReadFile(wasmPath)
	must(err)
	before, err := os.ReadFile(filepath.Join(dir, "before.bundle"))
	must(err)
	frame, err := os.ReadFile(filepath.Join(dir, "frame.cbor"))
	must(err)

	// GOSPIKE_CACHE=1: wasmtime's on-disk compilation cache (machine code by module bytes; the
	// native kernel turns the same cache on). Off by default.
	cfg := wasmtime.NewConfig()
	if os.Getenv("GOSPIKE_CACHE") == "1" {
		must(cfg.CacheConfigLoadDefault())
	}
	engine := wasmtime.NewEngineWithConfig(cfg)
	tc := time.Now()
	module, err := wasmtime.NewModule(engine, wasm)
	must(err)
	fmt.Printf("kernel module compiled in %.1f ms\n", float64(time.Since(tc).Microseconds())/1000)

	var times []string
	for i := 0; i < reps; i++ {
		s := newMemStore()
		readBundle(before, s)
		k, err := NewKernel(engine, module, map[uint32]*memStore{1: s})
		must(err)
		must(k.Open(1))
		started, err := k.Op("skein_start")
		must(err)
		_, err = k.Op("skein_drain")
		must(err)
		t0 := time.Now()
		reply, err := k.Call(frame)
		must(err)
		times = append(times, fmt.Sprintf("%.2f (app compile %.2f)", float64(time.Since(t0).Microseconds())/1000, float64(k.compileTime.Microseconds())/1000))
		if i == 0 {
			must(os.WriteFile(filepath.Join(dir, "go-start.cbor"), started, 0o644))
			must(os.WriteFile(filepath.Join(dir, "go-reply.cbor"), reply, 0o644))
			must(os.WriteFile(filepath.Join(dir, "go-after.bundle"), writeBundle(s), 0o644))
			must(os.WriteFile(filepath.Join(dir, "go-notices.txt"), []byte(strings.Join(k.notices, "\n")+"\n"), 0o644))
			fmt.Printf("stats compiled=%d instances=%d hostCalls=%d run outcomes=%v\n", k.compiled, k.instCount, k.hostCalls, k.outcomes)
		}
	}
	fmt.Println("go commit ms", strings.Join(times, " "))
}
