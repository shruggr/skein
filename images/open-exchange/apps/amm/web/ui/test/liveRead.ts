/**
 * The runtime's liveness read as the host answers it (skein docs/MESSAGES.md
 * "Liveness (#138)"): `GET <base>/.live/<topic>` → `[{sender, at, body, from}]`
 * newest first. The beat has no body (skein-amm 0.6.0: the overlay engine's
 * beacon): `sender` is the validator's identity key, `from` its peer ID.
 */
import { parseLiveBeats, type LiveAnswer } from "../src/lib/overlay";

/** A validator's peer ID (recorded from the v2 instance). */
export const PEER = "16Uiu2HAm6mP74uTowae2xMtAKJpqw1Dt2NhcgSdXgyDoyfmkwGqq";

export interface BeatEntry {
  sender: string;
  at: number;
  body: string;
  from: string;
}

/** One entry of the read: `identityKey` beat at `at` from the peer `peerId`, no body. */
export function beatEntry(identityKey: string, peerId: string, at: number): BeatEntry {
  return { sender: identityKey, at, body: "", from: peerId };
}

/** The read's answer for `keys`, each beating 5 s before `now`, as the page parses it. */
export function liveFor(keys: string[], now = 1_000_000, peerId: string = PEER): LiveAnswer {
  return parseLiveBeats(
    keys.map((k) => beatEntry(k, peerId, now - 5_000)),
    now,
  );
}
