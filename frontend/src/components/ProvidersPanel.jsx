import { useState } from "react";
import { CategoryScale, Chart as ChartJS, Legend, LineElement, LinearScale, PointElement, Tooltip } from "chart.js";
import { Line } from "react-chartjs-2";
import { explainError, toId } from "../lib/chain.js";
import { ms, pct } from "../lib/format.js";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

function HistoryChart({ providers, field, title, format }) {
  const len = Math.max(...providers.map((p) => p[field].length));
  const data = {
    labels: Array.from({ length: len }, (_, i) => i - len + 1),
    datasets: providers.map((p) => ({
      label: p.name,
      data: p[field],
      borderColor: p.color,
      backgroundColor: p.color,
      pointRadius: 0,
      borderWidth: 2,
      tension: 0.3,
    })),
  };
  const options = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "bottom", labels: { padding: 16 } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${format(c.parsed.y)}` } },
    },
    scales: {
      x: { title: { display: true, text: "ticks ago (1 tick ≈ 2.5 s)" }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { callback: (v) => format(v) } },
    },
  };
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="chart">
        <Line data={data} options={options} />
      </div>
    </section>
  );
}

export default function ProvidersPanel({ providers, operator, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");

  async function toggle(p) {
    setBusy(p.name);
    setMessage("");
    try {
      const receipt = await (await operator.setProviderActive(toId(p.name), !p.onChainActive)).wait();
      setMessage(`${p.name} ${p.onChainActive ? "disabled" : "enabled"} on-chain (block ${receipt.blockNumber}).`);
      onChanged();
    } catch (e) {
      setMessage(explainError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Providers right now</h2>
        <p className="muted">
          <b>Live status</b> comes from the simulator (random outages). <b>On-chain</b> is the contract's provider registry - the operator can switch a provider off, and the contract will
          then refuse new payments and reroutes to it.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Live status</th>
                <th>On-chain</th>
                <th>Fee</th>
                <th>Latency</th>
                <th>Failure rate</th>
                <th>Observed success</th>
                <th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.name}>
                  <td>
                    <span className="dot" style={{ background: p.color }} /> {p.name}
                  </td>
                  <td>{p.up ? <span className="pill good">up</span> : <span className="pill bad">outage</span>}</td>
                  <td>{p.onChainActive ? <span className="pill good">active</span> : <span className="pill bad">disabled</span>}</td>
                  <td>{p.feePct.toFixed(2)}%</td>
                  <td>{ms(p.latencyMs)}</td>
                  <td>{pct(p.failureRate)}</td>
                  <td>{p.attempts ? `${pct(p.successes / p.attempts, 0)} of ${p.attempts}` : "-"}</td>
                  <td>
                    <button className="btn small" disabled={!operator || busy !== null} onClick={() => toggle(p)}>
                      {busy === p.name ? "…" : p.onChainActive ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {message && <p className="banner">{message}</p>}
      </section>

      <div className="grid two">
        <HistoryChart providers={providers} field="latencyHistory" title="Latency over time" format={(v) => `${Math.round(v)} ms`} />
        <HistoryChart providers={providers} field="failureHistory" title="Failure probability over time" format={(v) => pct(v)} />
      </div>
    </>
  );
}
