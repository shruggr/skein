/**
 * The validators live in an instance's liveness read (`GET <base>/.live/tm_mandala_<txid>_0-live`), as the
 * pool form's validator picker lists them; with `onSelect`, a radio per row.
 */
import type { LiveAnswer } from "../lib/overlay";
import { ago } from "../lp/validators";
import { shortKey } from "../market/view";

export function LiveTable(props: { live: LiveAnswer; selected?: string; onSelect?: (identityKey: string) => void; highlight?: string }) {
  const { live, selected, onSelect, highlight } = props;
  return (
    <table className="tokens">
      <thead>
        <tr>
          {onSelect && <th />}
          <th>Identity key</th>
          <th>Peer ID</th>
          <th>Last seen</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {live.validators.map((v) => (
          <tr key={v.identityKey} data-highlight={highlight === v.identityKey ? "true" : undefined}>
            {onSelect && (
              <td>
                <input
                  type="radio"
                  name="validator"
                  checked={selected === v.identityKey}
                  onChange={() => onSelect(v.identityKey)}
                  aria-label={`choose ${v.identityKey}`}
                />
              </td>
            )}
            <td><code title={v.identityKey}>{shortKey(v.identityKey)}</code></td>
            <td><code title={v.peerId}>{shortKey(v.peerId)}</code></td>
            <td>{ago(v.ageMs)}</td>
            <td><span className={`dot ${v.live ? "dot-live" : "dot-off"}`} /> {v.live ? "live" : "offline"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
