/**
 * The Tokens page: the inventory (wallet `bsv21` basket) and the
 * Mandala deploy form. Wallet only; no overlay (docs/notes.md "Token deploy
 * and the LP page").
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet, ConnectButton } from "../wallet/AppWalletProvider";
import { loadWalletAssets, type WalletAssets } from "../lp/wallet";
import { buildInventory, type IconRef, type TokenSummary } from "../lp/inventory";
import { imageOrdinals, type OrdinalImage } from "../lp/ordinals";
import { imageDataUrl } from "../lp/images";
import { formatAmount, parseAmount } from "../lp/amounts";
import { deployToken, type DeployRequest, type DeployResult, type IconChoice } from "../lp/deploy";
import { outpointText } from "../lib/tokenId";
import { Id } from "../components/Id";

export function Icon({ icon }: { icon?: IconRef }) {
  const src = useMemo(() => (icon?.image ? imageDataUrl(icon.image) : undefined), [icon]);
  if (!icon) return <span className="icon icon-empty" />;
  if (src) return <img className="icon" src={src} alt="" title={icon.image?.via === "embedded" ? "embedded in the deploy" : outpointText(icon.outpoint)} />;
  return (
    <span className="icon icon-empty" title={`icon at ${outpointText(icon.outpoint)} (not held by this wallet)`}>
      ?
    </span>
  );
}

function TokenTable({ tokens }: { tokens: TokenSummary[] }) {
  if (tokens.length === 0) return <p><small>No tokens in this wallet's bsv21 basket.</small></p>;
  return (
    <table className="tokens">
      <thead>
        <tr>
          <th />
          <th>Symbol</th>
          <th>Token id</th>
          <th className="num">Balance</th>
          <th>Outputs</th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => (
          <tr key={t.tokenId}>
            <td><Icon icon={t.icon} /></td>
            <td>{t.sym ?? <small>—</small>}</td>
            <td>
              <Id value={t.tokenId} kind="token" />
              {t.icon && !t.icon.image && (
                <div><small>icon: <Id value={t.icon.outpoint} kind="outpoint" /></small></div>
              )}
            </td>
            <td className="num">
              {formatAmount(t.balance, t.dec ?? 0)}
              {t.dec === undefined && t.balance > 0n && <div><small>base units</small></div>}
            </td>
            <td>
              <small>
                {t.valueOutputs} value{t.authorities > 0 && `, ${t.authorities} authority`}
                {t.deployInWallet && ", deploy"} · {t.encodings.join("+")}
              </small>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrdinalGrid(props: { items: OrdinalImage[]; selected?: string; onSelect: (o: OrdinalImage) => void }) {
  if (props.items.length === 0) return <p><small>No image ordinals in this wallet.</small></p>;
  return (
    <div className="ord-grid">
      {props.items.map((o) => (
        <div className="ord-item" key={o.outpoint}>
          <button
            type="button"
            className="ord-cell"
            data-selected={props.selected === o.iconOutpoint}
            onClick={() => props.onSelect(o)}
            title={`${o.contentType}\nicon → ${outpointText(o.iconOutpoint)}`}
          >
            {o.image ? <img src={imageDataUrl(o.image)} alt="" /> : <span className="ord-noimg">{o.contentType}</span>}
          </button>
          <small><Id value={o.outpoint} kind="outpoint" /></small>
        </div>
      ))}
    </div>
  );
}

type IconMode = "none" | "ordinal" | "upload";

function DeployForm(props: { ordinals: OrdinalImage[]; onDeployed: (r: DeployResult) => void }) {
  const { wallet } = useWallet();
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("0");
  const [supplyKind, setSupplyKind] = useState<"fixed" | "authority">("fixed");
  const [supply, setSupply] = useState("");
  const [iconMode, setIconMode] = useState<IconMode>("none");
  const [ordinal, setOrdinal] = useState<OrdinalImage | null>(null);
  const [file, setFile] = useState<{ content: Uint8Array; contentType: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeployResult | null>(null);

  const filePreview = useMemo(
    () => (file ? URL.createObjectURL(new Blob([file.content as BlobPart], { type: file.contentType })) : undefined),
    [file],
  );
  useEffect(() => () => { if (filePreview) URL.revokeObjectURL(filePreview); }, [filePreview]);

  const dec = Number(decimals);
  const request: DeployRequest | string = useMemo(() => {
    if (!symbol.trim()) return "symbol is required";
    if (!Number.isInteger(dec) || dec < 0 || dec > 18) return "decimals: 0-18";
    let supplyModel: DeployRequest["supply"];
    if (supplyKind === "fixed") {
      let amount: bigint;
      try {
        amount = parseAmount(supply, dec);
      } catch (e) {
        return `supply: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (amount <= 0n) return "supply must be positive";
      if (amount > 0xffff_ffff_ffff_ffffn) return "supply exceeds 2^64-1 base units";
      supplyModel = { kind: "fixed", amount };
    } else supplyModel = { kind: "authority" };
    let icon: IconChoice = { kind: "none" };
    // The icon is embedded in the deploy (BRC-162 draft BRCs#308): its bytes, an ordinal's or a file's.
    if (iconMode === "ordinal") {
      if (!ordinal) return "pick an ordinal for the icon";
      if (!ordinal.image) return "this ordinal's image is not in this wallet (its bytes are embedded): upload it instead";
      icon = { kind: "ordinal", content: ordinal.image.bytes, contentType: ordinal.image.contentType };
    } else if (iconMode === "upload") {
      if (!file) return "choose an image file";
      icon = { kind: "upload", content: file.content, contentType: file.contentType };
    }
    return { symbol: symbol.trim(), decimals: dec, supply: supplyModel, icon };
  }, [symbol, dec, supplyKind, supply, iconMode, ordinal, file]);

  async function onFile(f: File | undefined) {
    setFile(f ? { content: new Uint8Array(await f.arrayBuffer()), contentType: f.type || "application/octet-stream", name: f.name } : null);
  }

  async function submit() {
    if (!wallet || typeof request === "string") return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await deployToken(wallet, request);
      setResult(r);
      props.onDeployed(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Deploy a Mandala token</h2>
      <div className="form-row">
        <label>
          Symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="GOLD" />
        </label>
        <label>
          Decimals
          <input type="number" min={0} max={18} value={decimals} onChange={(e) => setDecimals(e.target.value)} />
        </label>
      </div>

      <fieldset>
        <legend>Supply</legend>
        <label>
          <input type="radio" name="supply" checked={supplyKind === "fixed"} onChange={() => setSupplyKind("fixed")} />
          Fixed supply, all in the deploy output
        </label>
        {supplyKind === "fixed" && (
          <label>
            Amount{dec > 0 ? ` (in units of 10^-${dec})` : ""}
            <input value={supply} onChange={(e) => setSupply(e.target.value)} placeholder="21000000" inputMode="decimal" />
          </label>
        )}
        <label>
          <input type="radio" name="supply" checked={supplyKind === "authority"} onChange={() => setSupplyKind("authority")} />
          Authority: the deploy output is the first minting authority (no supply yet)
        </label>
      </fieldset>

      <fieldset>
        <legend>Icon</legend>
        <label>
          <input type="radio" name="icon" checked={iconMode === "none"} onChange={() => setIconMode("none")} />
          None
        </label>
        <label>
          <input type="radio" name="icon" checked={iconMode === "ordinal"} onChange={() => setIconMode("ordinal")} />
          One of my ordinals (its image, embedded in the deploy)
        </label>
        {iconMode === "ordinal" && (
          <OrdinalGrid items={props.ordinals} selected={ordinal?.iconOutpoint} onSelect={setOrdinal} />
        )}
        <label>
          <input type="radio" name="icon" checked={iconMode === "upload"} onChange={() => setIconMode("upload")} />
          Upload an image, embedded in the deploy
        </label>
        {iconMode === "upload" && (
          <div className="upload">
            <input type="file" accept="image/*" onChange={(e) => void onFile(e.target.files?.[0])} />
            {filePreview && <img className="icon icon-lg" src={filePreview} alt="" />}
          </div>
        )}
      </fieldset>

      <button type="button" onClick={submit} disabled={!wallet || busy || typeof request === "string"}>
        {busy ? "Waiting for the wallet…" : "Deploy"}
      </button>
      {!wallet && <small>Connect a wallet to deploy.</small>}
      {wallet && typeof request === "string" && <small>{request}</small>}
      {error && <p className="bad" role="alert">{error}</p>}
      {result && (
        <p className="ok">
          Deployed. txid <Id value={result.txid} kind="txid" />, token id <Id value={result.tokenId} kind="token" />
        </p>
      )}
    </section>
  );
}

export function TokensSection() {
  const { wallet, status } = useWallet();
  const [assets, setAssets] = useState<WalletAssets | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      setAssets(await loadWalletAssets(wallet));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet && status === "connected") void refresh();
    else setAssets(null);
  }, [wallet, status, refresh]);

  const inventory = useMemo(
    () => (assets ? buildInventory(assets.tokenRows, { ordinalRows: assets.ordinalRows, txs: assets.txs }) : null),
    [assets],
  );
  const ordinals = useMemo(() => (assets ? imageOrdinals(assets.ordinalRows) : []), [assets]);

  return (
    <>
      <section>
        <div className="section-head">
          <h2>Your tokens</h2>
          {wallet && (
            <button type="button" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Loading…" : "Refresh"}
            </button>
          )}
        </div>
        {!wallet && (
          <p>
            Connect your wallet to see your tokens. <ConnectButton />
          </p>
        )}
        {error && <p className="bad" role="alert">{error}</p>}
        {inventory && <TokenTable tokens={inventory.tokens} />}
        {inventory && inventory.unrecognized.length > 0 && (
          <p><small>{inventory.unrecognized.length} output(s) in the bsv21 basket are not Mandala or BSV-21 tokens.</small></p>
        )}
        {assets?.warnings.map((w) => <p key={w} className="warn"><small>{w}</small></p>)}
      </section>
      <DeployForm ordinals={ordinals} onDeployed={() => void refresh()} />
    </>
  );
}
