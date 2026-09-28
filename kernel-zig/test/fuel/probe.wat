;; The fuel probe (issue #35, src/wasm_fuel_test.zig): every construct the
;; instrumentation handles, with a host call (`h.probe`) between them so the
;; test can compare the fuel read at each point under wasmtime's own metering
;; and under the instrumented counter. Built with
;;   wasm-tools parse test/fuel/probe.wat -o test/fuel/probe.wasm
(module
  (import "h" "probe" (func $probe))
  (import "h" "arg" (func $arg (param i32) (result i32)))
  (memory 1 4)
  (table 4 8 funcref)
  (elem (i32.const 0) $leaf $sum $leaf)
  (global $g (mut i32) (i32.const 0))
  (data $d "0123456789abcdef0123456789abcdef")
  (type $v (func))
  (type $ii (func (param i32) (result i32)))

  (func $leaf)
  (func $sum (param $n i32) (result i32) (local $s i32)
    (block $out
      (loop $l
        (br_if $out (i32.eqz (local.get $n)))
        (local.set $s (i32.add (local.get $s) (local.get $n)))
        (local.set $n (i32.sub (local.get $n) (i32.const 1)))
        (br $l)))
    (local.get $s))

  ;; if/else with results, select, nested blocks, a branch to the function's label
  (func $branchy (param $x i32) (result i32)
    (if (result i32) (i32.gt_s (local.get $x) (i32.const 5))
      (then (i32.mul (local.get $x) (i32.const 2)))
      (else
        (block $b (result i32)
          (drop (br_if $b (i32.const 7) (i32.eqz (local.get $x))))
          (drop (select (i32.const 1) (i32.const 2) (local.get $x)))
          (if (i32.eq (local.get $x) (i32.const 3)) (then (return (i32.const 33))))
          (if (i32.eq (local.get $x) (i32.const 4)) (then (br 2 (i32.const 44))))
          (nop)
          (i32.const 9)))))

  ;; br_table, including to the function's label, and code after an unconditional branch
  (func $table (param $x i32) (result i32)
    (block $a
      (block $b
        (block $c
          (br_table $a $b $c (local.get $x))
          (drop (i32.const 99)) (unreachable))
        (return (i32.const 3)))
      (return (i32.const 2)))
    (i32.const 1))
  (func $tofunc (param $x i32) (result i32)
    (i32.add (local.get $x) (i32.const 1))
    (br_table 0 0 (local.get $x)))

  (func $bulk (param $n i32) (result i32)
    ;; memory.grow: a runtime count, a small constant, a large constant (fails: max 4 pages), a runtime failure
    (drop (memory.grow (local.get $n)))
    (drop (memory.grow (i32.const 1)))
    (drop (memory.grow (i32.const 200)))
    (drop (memory.grow (i32.add (local.get $n) (i32.const 1000))))
    ;; memory.copy/fill/init: runtime, small constant, large constant
    (memory.copy (i32.const 100) (i32.const 0) (local.get $n))
    (memory.copy (i32.const 200) (i32.const 0) (i32.const 16))
    (memory.copy (i32.const 1000) (i32.const 0) (i32.const 300))
    (memory.fill (i32.const 0) (i32.const 7) (i32.add (local.get $n) (i32.const 50)))
    (memory.fill (i32.const 0) (i32.const 7) (i32.const 129))
    (memory.init $d (i32.const 0) (i32.const 0) (i32.const 32))
    (memory.init $d (i32.const 64) (i32.const 0) (local.get $n))
    ;; tables
    (drop (table.grow (ref.null func) (local.get $n)))
    (drop (table.grow (ref.null func) (i32.const 1)))
    (table.fill (i32.const 0) (ref.func $leaf) (local.get $n))
    (table.copy (i32.const 1) (i32.const 0) (i32.const 2))
    (memory.size))

  (func $work (param $n i32) (result i32) (local $i i32) (local $acc i32)
    (call $probe)
    (local.set $acc (call $sum (local.get $n)))
    (call $probe)
    (local.set $acc (i32.add (local.get $acc) (call $branchy (i32.const 0))))
    (local.set $acc (i32.add (local.get $acc) (call $branchy (i32.const 3))))
    (local.set $acc (i32.add (local.get $acc) (call $branchy (i32.const 4))))
    (local.set $acc (i32.add (local.get $acc) (call $branchy (i32.const 2))))
    (local.set $acc (i32.add (local.get $acc) (call $branchy (i32.const 9))))
    (call $probe)
    (loop $l
      (local.set $acc (i32.add (local.get $acc) (call $table (local.get $i))))
      (local.set $acc (i32.add (local.get $acc) (call $tofunc (local.get $i))))
      (local.set $acc (i32.add (local.get $acc) (call_indirect (type $ii) (local.get $i) (i32.const 1))))
      (call_indirect (type $v) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (i32.const 6))))
    (call $probe)
    (global.set $g (call $bulk (call $arg (i32.const 3))))
    (call $probe)
    (local.get $acc))

  (func (export "f")
    (drop (call $work (i32.const 50)))
    (call $probe)
    (drop (call $work (call $arg (i32.const 20))))
    (call $probe))

  ;; a trap in the middle of straight-line code: what is left is the last save
  (func (export "trap")
    (call $probe)
    (drop (i32.add (i32.const 1) (i32.const 2)))
    (drop (i32.div_u (i32.const 1) (call $arg (i32.const 0))))
    (call $probe))

  ;; a start function runs under the fuel too (wasmtime: through a trampoline that costs 2)
  (func $init (global.set $g (i32.const 1)) (call $probe))
  (start $init)
)
