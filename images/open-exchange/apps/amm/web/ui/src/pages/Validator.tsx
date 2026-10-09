/**
 * The Validator page: root's view of their own skein instance as an AMM
 * validator — who it is (handle, identity, peer ID), whether a peer hears its
 * heartbeat, the token topics registered with its engine, its policy and the
 * two roles in effect (market, validator: root's switch on the Tokens
 * page (mandala/tokens/), kept in `<app>/topics`, over `config.overlay.market` / `.validator`;
 * skein-amm 0.6.2) when root can read them (through the wallet-backed
 * AuthFetch), the pools it serves and the validators it sees. Nothing is sent
 * from here: the two switches are on the Token topics page (mandala/tokens/).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PoolState } from "@amm-poc/matching-engine";
import { useAuthFetch } from "../wallet/authFetch";
import { AMM_OVERLAY, AMM_PEER_OVERLAY, appName } from "../lib/config";
import { fetchLiveByToken, listTokenTopics, mergeLive, queryPools, type LiveAnswer } from "../lib/overlay";
import { ago } from "../lp/validators";
import { marginalPrice, shortKey } from "../market/view";
import { Id } from "../components/Id";
import { livenessLine, loadThisInstance, poolsServedBy, type ServedPool, type ThisInstance } from "../validator/instance";
import { readAppPolicy, readGenesis, type GenesisRead } from "../validator/control";
import { LiveTable } from "./LiveTable";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function NotBuilt({ children }: { children: ReactNode }) {
  return (
    <p className="not-built">
      <strong>Not built.</strong> {children}
    </p>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <tr>
      <th>{k}</th>
      <td>{children}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

function ThisInstanceSection({ t, error }: { t: ThisInstance | null; error: string | null }) {
  return (
    <section>
      <h2>This instance</h2>
      {error && <p className="bad" role="alert">{error}</p>}
      {!t ? (
        <p><small>Reading…</small></p>
      ) : (
        <table className="tokens kv">
          <tbody>
            <Row k="Origin"><code>{t.address.origin}</code></Row>
            <Row k="AMM routes"><code>{AMM_OVERLAY}</code></Row>
            <Row k="Handle">{t.handle ? <code>{t.handle}</code> : <span className="warn">unknown</span>}</Row>
            <Row k="Identity key">
              {t.identityKey ? (
                <>
                  <code>{t.identityKey}</code>
                  <br />
                  <small>BRC-169: {t.resolved?.resolveUrl}</small>
                </>
              ) : (
                <span className="bad">{t.resolveError ?? "unknown"}</span>
              )}
            </Row>
            <Row k="Peer ID">
              {t.peerId ? (
                <>
                  <code>{t.peerId}</code>
                  <br />
                  <small>as {t.peer?.label} reports it</small>
                </>
              ) : (
                <span className="warn">unknown until a peer sees us</span>
              )}
            </Row>
            <Row k="Liveness">
              <span className={`dot ${t.peer?.entry?.live ? "dot-live" : "dot-off"}`} /> {livenessLine(t, ago)}
              <br />
              <small>
                Read from the peer&apos;s liveness read of this instance&apos;s token topics,{" "}
                <code>{AMM_PEER_OVERLAY ? `${AMM_PEER_OVERLAY}/.live/tm_mandala_<txid>_0-live` : "(no peer)"}</code> (kept where the peer is a market for the token).
              </small>
            </Row>
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function RegisteredSection({ refreshKey }: { refreshKey: number }) {
  const [topics, setTopics] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = (await listTokenTopics(AMM_OVERLAY)).filter((x) => x.kind === "native").map((x) => x.topic);
        if (!cancelled) {
          setTopics(t);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(errText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section>
      <h2>Registered tokens</h2>
      <p>
        <small>
          The token topics registered with this instance&apos;s engine (the Token topics page registers them). Registering a
          token&apos;s topic is the one act that drives both roles: with the market on the engine asks for the
          topic&apos;s liveness (<code>tm_mandala_&lt;txid&gt;_0-live</code>, read at <code>/amm/.live/…</code>); with the validator on
          it beacons <code>tm_mandala_&lt;txid&gt;_0-live</code> and this instance signs the token&apos;s swaps and takes on its new
          liquidity (addLiquidity, pool deploys). Deregistering reverses both. Both roles are off until you turn one on:
          the Market and Validator switches on the Token topics page (<a href="mandala/tokens/">mandala/tokens/</a>; or <code>--config</code> at install). They are shown under
          Policy.
        </small>
      </p>
      {error && <p className="bad" role="alert">{error}</p>}
      {topics === null ? (
        !error && <p>Reading…</p>
      ) : topics.length === 0 ? (
        <p><small>No token topics are registered.</small></p>
      ) : (
        <table className="tokens">
          <thead>
            <tr>
              <th>Topic</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((topic) => (
              <tr key={topic}>
                <td><Id value={topic} kind="topic" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function PolicySection(props: { genesis: GenesisRead | null; onRead: (g: GenesisRead) => void; origin: string | undefined }) {
  const { genesis, onRead, origin } = props;
  const authFetch = useAuthFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read() {
    if (!authFetch || !origin) return;
    setBusy(true);
    setError(null);
    try {
      const g = await readGenesis(authFetch, origin);
      // The installed app's config.amm, which the programs read before the genesis defaults.
      const app = appName(AMM_OVERLAY);
      const fromApp = app ? await readAppPolicy(authFetch, origin, app).catch(() => undefined) : undefined;
      onRead(fromApp && g.ok ? { ...g, policy: { ...g.policy, ...fromApp } } : g);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const p = genesis?.ok ? genesis.policy : undefined;
  const show = (v: number | undefined, unit: string) => (v === undefined ? <span className="warn">not configured</span> : `${v} ${unit}`);
  const role = (v: number | undefined, what: string) => (v === undefined ? <span className="warn">off</span> : `on: ${what} ${v / 1000} s`);
  return (
    <section>
      <h2>Policy</h2>
      {p ? (
        <table className="tokens kv">
          <tbody>
            <Row k="Min validator fee">{show(p.minValidatorFeeBps, "bps")}</Row>
            <Row k="Max LP fee">{show(p.maxLpFeeBps, "bps")}</Row>
            <Row k="Market">{role(p.marketWindowMs, "liveness window")}</Row>
            <Row k="Validator">{role(p.validatorEveryMs, "a beat every")}</Row>
          </tbody>
        </table>
      ) : (
        <p className="warn">
          Not readable from the instance: min validator fee, max LP fee (the app record's <code>config.amm.ammValidator</code>) and
          the two roles (root&apos;s switch in <code>&lt;app&gt;/topics</code>, else <code>config.overlay.market</code> /{" "}
          <code>config.overlay.validator</code>) are not exposed by any open route.
        </p>
      )}
      <p>
        <small>
          Root can read them through the explorer (<code>/explore</code>, BRC-104, root only), signed by the wallet.
        </small>
      </p>
      <button type="button" disabled={!authFetch || !origin || busy} onClick={() => void read()}>
        {busy ? "Reading…" : "Read through the explorer (root only)"}
      </button>
      {!authFetch && <small> connect a wallet first</small>}
      {genesis && !genesis.ok && <p className="bad">{genesis.error}</p>}
      {error && <p className="bad" role="alert">{error}</p>}
      <NotBuilt>
        Editing the fees: they are the manifest's <code>config.amm</code>, changed by installing the app again with a new
        manifest; the app offers no <code>writes: true</code> function for them. The two roles are not edited here: they are
        the Market and Validator switches on the Token topics page (<code>mandala/tokens/</code>).
      </NotBuilt>
    </section>
  );
}

// ---------------------------------------------------------------------------

function PoolsServedSection(props: { identityKey: string | undefined; peerLive: boolean | undefined; refreshKey: number }) {
  const { identityKey, peerLive, refreshKey } = props;
  const authFetch = useAuthFetch();
  const [served, setServed] = useState<ServedPool[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!identityKey) return;
    let cancelled = false;
    void (async () => {
      const errs: string[] = [];
      try {
        const topics = await listTokenTopics(AMM_OVERLAY);
        const pools = new Map<string, PoolState[] | Error>();
        await Promise.all(
          topics.map(async (t) => {
            try {
              pools.set(t.tokenId, await queryPools(authFetch, AMM_OVERLAY, t.tokenId));
            } catch (e) {
              pools.set(t.tokenId, e instanceof Error ? e : new Error(String(e)));
              errs.push(`${t.tokenId}: ${errText(e)}`);
            }
          }),
        );
        let total = 0;
        for (const a of pools.values()) if (Array.isArray(a)) total += a.length;
        if (!cancelled) {
          setServed(poolsServedBy(identityKey, topics, pools));
          setCount(total);
        }
      } catch (e) {
        errs.push(errText(e));
      }
      if (!cancelled) setErrors(errs);
    })();
    return () => {
      cancelled = true;
    };
  }, [identityKey, refreshKey, authFetch]);

  return (
    <section>
      <h2>Pools served</h2>
      <p><small>The pools in this instance's lookup whose validator identity is this instance's.</small></p>
      {!identityKey && <p className="warn">Unknown: this instance's identity key is unknown.</p>}
      {errors.map((e) => (
        <p key={e} className="bad">{e}</p>
      ))}
      {served && served.length === 0 && (
        <p>
          None. The lookup holds {count} pool{count === 1 ? "" : "s"}, none naming this instance as validator (on v2 the
          seeded pool names the fixture validator, not amm2).
        </p>
      )}
      {served && served.length > 0 && (
        <div className="scroll">
          <table className="tokens">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Token</th>
                <th className="num">BSV reserve</th>
                <th className="num">Token reserve</th>
                <th className="num">Price</th>
                <th className="num">LP / val. / comm. (bps)</th>
                <th>Validator</th>
              </tr>
            </thead>
            <tbody>
              {served.map(({ topic, pool }) => (
                <tr key={pool.outpoint}>
                  <td><Id value={pool.outpoint} kind="outpoint" /></td>
                  <td><Id value={topic.tokenId} kind="token" /></td>
                  <td className="num">{pool.bsvReserve.toString()}</td>
                  <td className="num">{pool.tokenReserve.toString()}</td>
                  <td className="num">{marginalPrice(pool)}</td>
                  <td className="num">{`${pool.liquidityFeeBps} / ${pool.validationFeeBps} / ${pool.commissionBps}`}</td>
                  <td>
                    <span className={`dot ${peerLive ? "dot-live" : "dot-off"}`} /> {peerLive ? "live" : "not seen live"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p><small>Price: sats per token base unit. Liveness: this instance's heartbeat as the peer sees it.</small></p>
        </div>
      )}
    </section>
  );
}

function PeersSection({ live, error }: { live: LiveAnswer | null; error: string | null }) {
  return (
    <section>
      <h2>Peers</h2>
      <p>
        <small>
          The validators live in this node&apos;s liveness read (<code>{AMM_OVERLAY}/.live/tm_mandala_&lt;txid&gt;_0-live</code>, each token it
          serves, merged; kept when this node is a market, <code>config.overlay.market</code>).
        </small>
      </p>
      {error && <p className="bad">{error}</p>}
      {live && live.validators.length > 0 ? (
        <LiveTable live={live} />
      ) : (
        live && <p>None{live.kept ? ` within ${Math.round(live.windowMs / 1000)} s` : ": this node keeps no liveness for its tokens"}.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function ValidatorPage() {
  const [t, setT] = useState<ThisInstance | null>(null);
  const [tError, setTError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveAnswer | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [genesis, setGenesis] = useState<GenesisRead | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    setTError(null);
    setLiveError(null);
    let topics: Awaited<ReturnType<typeof listTokenTopics>> = [];
    try {
      topics = await listTokenTopics(AMM_OVERLAY);
    } catch (e) {
      setLiveError(`${AMM_OVERLAY}/listTopicManagers: ${errText(e)}`);
    }
    try {
      setT(await loadThisInstance(AMM_OVERLAY, AMM_PEER_OVERLAY, topics.map((x) => x.topic)));
    } catch (e) {
      setTError(errText(e));
    }
    try {
      const reads = await fetchLiveByToken(AMM_OVERLAY, topics);
      setLive(mergeLive([...reads.values()].filter((r): r is LiveAnswer => !(r instanceof Error))));
      const failed = [...reads.values()].filter((r): r is Error => r instanceof Error);
      if (failed.length) setLiveError(`${AMM_OVERLAY}/.live: ${failed.map((e) => e.message).join("; ")}`);
    } catch (e) {
      setLiveError(`${AMM_OVERLAY}/.live: ${errText(e)}`);
    }
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <section>
        <div className="section-head">
          <h2>Validator</h2>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        <p>
          <small>
            Your own skein instance as an AMM validator. Instance: <code>{AMM_OVERLAY}</code>; peer:{" "}
            <code>{AMM_PEER_OVERLAY || "none"}</code>.
          </small>
        </p>
      </section>
      <ThisInstanceSection t={t} error={tError} />
      <RegisteredSection refreshKey={refreshKey} />
      <PolicySection genesis={genesis} onRead={setGenesis} origin={t?.address.origin} />
      <PoolsServedSection identityKey={t?.identityKey} peerLive={t?.peer?.entry?.live} refreshKey={refreshKey} />
      <PeersSection live={live} error={liveError} />
    </>
  );
}
