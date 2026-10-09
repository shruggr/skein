//! The catch-up tick under skein#69 (docs/MESSAGES.md "Scheduling: the
//! waker and the cron provider"): a schedule is a message to the cron
//! provider (the address book's entry at `local` `cron`, box `cron`),
//! emitted from a step, never host configuration. A tick comes back as a
//! message from the provider's key into box `amm-p2p`, its body
//! `{kind: "amm-p2p-tick", job: "catchup", name, due}`, and launches a
//! thread of this program: a catch-up pass.
//!
//! A utility since 0.6.0: nothing schedules it. The heartbeat job and the
//! start / stop that asked the cron provider are gone (the beacons are the
//! overlay engine's, emitted at `register`: skein-overlay 0.9.0,
//! shruggr/skein#120).
//! No VM imports.
const std = @import("std");
const w = @import("chain");

const cbor = w.cbor;
const Value = cbor.Value;

pub const Job = enum { catchup };

pub const tick_kind = "amm-p2p-tick";

/// The job a tick's body names.
pub fn jobOf(body: Value) !Job {
    if (!std.mem.eql(u8, body.getText("kind") orelse "", tick_kind)) return error.NotATick;
    return std.meta.stringToEnum(Job, body.getText("job") orelse return error.BadTick) orelse error.BadTick;
}
