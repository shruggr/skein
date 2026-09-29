package main

import (
	"fmt"
	"unsafe"
)

// The kernel's `deadline` import (docs/VM.md; wit/skein.wit): the step ends
// waiting and the thread rests until `until` (ms since the epoch, after the
// step's time) at most; the host's wake entry then runs the next step with
// Woke set. Declared here rather than in package skein, so the other Go
// handlers' modules (and their pins) stay as they are.
//
//go:wasmimport skein deadline
func _deadline(until int64) int32

//go:wasmimport skein error
func _lastError(out unsafe.Pointer, cap uint32) int32

func deadline(until int64) error {
	if _deadline(until) >= 0 {
		return nil
	}
	buf := make([]byte, 512)
	n := _lastError(unsafe.Pointer(&buf[0]), uint32(len(buf)))
	if n > 0 && int(n) <= len(buf) {
		return fmt.Errorf("deadline: %s", buf[:n])
	}
	return fmt.Errorf("deadline %d refused", until)
}
