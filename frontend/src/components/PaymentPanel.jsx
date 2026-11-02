import { useEffect, useState } from "react";
import { isAddress, parseEther } from "ethers";
import { PRESETS, rankProviders } from "../routing/router.js";
import { runPayment } from "../lib/flow.js";
import { explainError } from "../lib/chain.js";
import { ms, pct, shortHash } from "../lib/format.js";

export default function PaymentPanel({ wallet, operator, providers, getProviders, rng, merchantDefault, onAttempt, onDone }) {
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("0.1");
  const [preset, setPreset] = useState("balanced");
  const [forceFail, setForceFail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);

  useEffect(() => {
    if (!merchant && merchantDefault) setMerchant(merchantDefault);
  }, [merchant, merchantDefault]);

  const { ranked, skipped } = rankProviders(providers, PRESETS[preset]);

  async function pay() {
    setBusy(true);
    setLog([]);
    const add = (kind, text, receipt) => setLog((l) => [...l, { kind, text, block: receipt?.blockNumber, hash: receipt?.hash }]);
    try {
      if (!isAddress(merchant)) throw new Error("The merchant address is not a valid Ethereum address.");
      const amountWei = parseEther(amount || "0");
      if (amountWei <= 0n) throw new Error("Enter an amount greater than 0.");
      await runPayment({
        payerContract: wallet.contract,
        operatorContract: operator,
        merchant,
        amountWei,
        weights: PRESETS[preset],
        getProviders,
        rng,
        forceFailFirst: forceFail,
        onAttempt,
        log: add,
      });
    } catch (e) {
      add("fail", explainError(e));
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="grid two">
      <section className="card">
        <h2>New payment</h2>
        <label>
          Merchant address
          <input value={merchant} onChange={(e) => setMerchant(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
        </label>
        <label>
          Amount (test ETH)
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          Routing priority
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {Object.entries(PRESETS).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label} - fee {p.fee * 100}% · speed {p.latency * 100}% · reliability {p.failure * 100}%
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={forceFail} onChange={(e) => setForceFail(e.target.checked)} />
          Demo: force the first provider to fail (shows automatic rerouting)
        </label>

        <button className="btn primary wide" disabled={!wallet || !operator || busy} onClick={pay}>
          {busy ? "Processing…" : wallet ? "Pay with RouteFi" : "Connect a wallet first"}
        </button>

        {log.length > 0 && (
          <ol className="timeline" aria-live="polite">
            {log.map((entry, i) => (
              <li key={i} className={`t-${entry.kind}`}>
                <span>{entry.text}</span>
                {entry.hash && (
                  <span className="meta">
                    block {entry.block} · tx {shortHash(entry.hash)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <h2>Live route ranking</h2>
        <p className="muted">Recalculated every few seconds as simulated network conditions change. Lower score is better.</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Provider</th>
                <th>Fee</th>
                <th>Latency</th>
                <th>Failure</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((p, i) => (
                <tr key={p.name} className={i === 0 ? "best" : ""}>
                  <td>{i + 1}</td>
                  <td>
                    <span className="dot" style={{ background: p.color }} /> {p.name}
                    {i === 0 && <span className="tag">chosen</span>}
                  </td>
                  <td>{p.feePct.toFixed(2)}%</td>
                  <td>{ms(p.latencyMs)}</td>
                  <td>{pct(p.failureRate)}</td>
                  <td>
                    <div className="score">
                      <div className="score-track">
                        <div className="score-bar" style={{ width: `${Math.max(4, (1 - p.score) * 100)}%` }} />
                      </div>
                      <span>{p.score.toFixed(3)}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {skipped.map((s) => (
                <tr key={s.name} className="skipped">
                  <td>-</td>
                  <td>{s.name}</td>
                  <td colSpan={4}>skipped: {s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          score = {PRESETS[preset].fee} × fee + {PRESETS[preset].latency} × latency + {PRESETS[preset].failure} × failure, each normalised 0 (best) to 1 (worst) among available
          providers.
        </p>
      </section>
    </div>
  );
}
