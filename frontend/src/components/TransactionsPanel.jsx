import { Fragment, useCallback, useEffect, useState } from "react";
import { STATUS, explainError, fastForward, fromId, loadHistory, verifyEvents } from "../lib/chain.js";
import { duration, eth, short, shortHash } from "../lib/format.js";

function describe(e) {
  const a = e.args;
  switch (e.name) {
    case "PaymentCreated":
      return `Created - ${eth(a.amount)} locked via ${fromId(a.provider)}`;
    case "PaymentRerouted":
      return `Rerouted ${fromId(a.fromProvider)} → ${fromId(a.toProvider)} (attempt ${a.attempt})`;
    case "PaymentSettled":
      return `Settled - ${eth(a.amount)} released to merchant via ${fromId(a.provider)}`;
    case "PaymentRefunded":
      return `Refunded - ${eth(a.amount)} returned to payer (${a.reason})`;
    default:
      return e.name;
  }
}

export default function TransactionsPanel({ wallet, refreshKey, onChanged }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [verified, setVerified] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(() => {
    loadHistory()
      .then(setData)
      .catch((e) => setMessage(explainError(e)));
  }, []);
  useEffect(load, [load, refreshKey]);

  async function act(fn, done) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      setMessage(done);
      onChanged();
    } catch (e) {
      setMessage(explainError(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify(row) {
    const results = await verifyEvents(row.events);
    setVerified((v) => ({ ...v, [row.id]: results }));
    setOpen(row.id);
  }

  const rows = data?.rows ?? [];
  const counts = rows.reduce((c, r) => ({ ...c, [STATUS[r.payment.status]]: (c[STATUS[r.payment.status]] ?? 0) + 1 }), {});

  return (
    <section className="card">
      <div className="card-head">
        <h2>On-chain payments</h2>
        <div className="actions">
          <button className="btn small" onClick={load}>
            Refresh
          </button>
          <button
            className="btn small"
            disabled={busy}
            onClick={() => act(() => fastForward(3600), "Blockchain clock moved forward 1 hour.")}
            title="Test chains only: lets you try the payer refund without waiting an hour"
          >
            Fast-forward 1 hour
          </button>
        </div>
      </div>
      <p className="muted">
        Rebuilt from the contract's event log - the public audit trail.
        {data && ` ${rows.length} payments${Object.entries(counts).map(([k, v]) => ` · ${v} ${k.toLowerCase()}`).join("")}.`}
      </p>
      {message && <p className="banner">{message}</p>}

      {!data ? (
        <p className="muted">Loading payments from the blockchain…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No payments yet - make one on the Make Payment tab.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Amount</th>
                <th>Provider</th>
                <th>Attempts</th>
                <th>Status</th>
                <th>Payer → Merchant</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const p = row.payment;
                const status = STATUS[p.status];
                const expired = data.now >= row.deadline;
                const isMine = wallet && wallet.address.toLowerCase() === p.payer.toLowerCase();
                return (
                  <Fragment key={row.id}>
                    <tr>
                      <td>#{row.id.toString()}</td>
                      <td>{eth(p.amount)}</td>
                      <td>{fromId(p.provider)}</td>
                      <td>{p.attempts.toString()}</td>
                      <td>
                        <span className={`pill ${status === "Settled" ? "good" : status === "Refunded" ? "warn" : "neutral"}`}>{status}</span>
                        {status === "Pending" && (
                          <div className="meta">{expired ? "expired - payer can claim refund" : `expires in ${duration(row.deadline - data.now)}`}</div>
                        )}
                      </td>
                      <td className="mono">
                        {short(p.payer)} → {short(p.merchant)}
                      </td>
                      <td className="actions">
                        <button className="btn small" onClick={() => setOpen(open === row.id ? null : row.id)}>
                          {open === row.id ? "Hide" : "History"}
                        </button>
                        <button className="btn small" onClick={() => verify(row)}>
                          Verify
                        </button>
                        {status === "Pending" && expired && isMine && (
                          <button
                            className="btn small primary"
                            disabled={busy}
                            onClick={() => act(async () => (await wallet.contract.claimRefund(row.id)).wait(), `Refund for payment #${row.id} claimed.`)}
                          >
                            Claim refund
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === row.id && (
                      <tr className="detail">
                        <td colSpan={7}>
                          <ol className="timeline">
                            {row.events.map((e, i) => (
                              <li key={i} className={e.name === "PaymentSettled" ? "t-ok" : e.name === "PaymentRefunded" ? "t-fail" : "t-tx"}>
                                <span>{describe(e)}</span>
                                <span className="meta">
                                  block {e.block} · tx {shortHash(e.hash)}
                                  {verified[row.id] && (verified[row.id][i] ? " · ✓ verified on-chain" : " · ✗ NOT verified")}
                                </span>
                              </li>
                            ))}
                          </ol>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
