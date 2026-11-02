import { useState } from "react";
import { BarElement, CategoryScale, Chart as ChartJS, LinearScale, Tooltip } from "chart.js";
import { Bar } from "react-chartjs-2";
import { runBenchmark } from "../routing/benchmark.js";
import { ms, pct } from "../lib/format.js";

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip);

const SHORT = { fixed: "Fixed", random: "Random", cheapest: "Cheapest", fastest: "Fastest", routefi: "RouteFi" };
const COLORS = { fixed: "#3a4659", random: "#4a5770", cheapest: "#5a6884", fastest: "#6b7a98", routefi: "#d4a94f" };

function MetricChart({ results, title, value, format, note }) {
  const data = {
    labels: results.map((r) => SHORT[r.key]),
    datasets: [{ data: results.map(value), backgroundColor: results.map((r) => COLORS[r.key]), borderRadius: 5, maxBarThickness: 46 }],
  };
  const options = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => format(c.parsed.y) } } },
    scales: { y: { beginAtZero: true, ticks: { callback: (v) => format(v) } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false, font: { size: 10.5 } } } },
  };
  return (
    <section className="card">
      <h2>{title}</h2>
      {note && <p className="muted small">{note}</p>}
      <div className="chart short">
        <Bar data={data} options={options} />
      </div>
    </section>
  );
}

export default function BenchmarkPanel() {
  const [payments, setPayments] = useState(1000);
  const [runs, setRuns] = useState(5);
  const [seed, setSeed] = useState(42);
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);

  function run() {
    setRunning(true);
    // Let the button re-render as "Running…" before the (synchronous) simulation starts.
    setTimeout(() => {
      setReport(runBenchmark({ payments: Number(payments), runs: Number(runs), seed: Number(seed) }));
      setRunning(false);
    }, 20);
  }

  const results = report?.results ?? [];

  return (
    <>
      <section className="card">
        <h2>Routing benchmark</h2>
        <p className="muted">
          Simulates many payments and compares strategies. Every strategy faces <b>identical</b> network conditions and random outcomes, so differences come only from the routing
          decision. Up to 3 attempts per payment (same limit as the smart contract); the fixed strategy has no failover. Off-chain simulation - no blockchain needed.
        </p>
        <div className="bench-controls">
          <label>
            Payments per run
            <input type="number" min="10" max="20000" value={payments} onChange={(e) => setPayments(e.target.value)} />
          </label>
          <label>
            Runs
            <input type="number" min="1" max="50" value={runs} onChange={(e) => setRuns(e.target.value)} />
          </label>
          <label>
            Seed
            <input type="number" value={seed} onChange={(e) => setSeed(e.target.value)} />
          </label>
          <button className="btn primary" onClick={run} disabled={running}>
            {running ? "Running…" : "Run benchmark"}
          </button>
        </div>
      </section>

      {report && (
        <>
          <section className="card">
            <h2>
              Results - {report.config.payments * report.config.runs} payments (seed {report.config.seed})
            </h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Success</th>
                    <th>Failed</th>
                    <th>Avg fee</th>
                    <th>Avg time</th>
                    <th>p95 time</th>
                    <th>Retried</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.key} className={r.key === "routefi" ? "best" : ""}>
                      <td>
                        <span className="dot" style={{ background: COLORS[r.key] }} /> {r.label}
                      </td>
                      <td>{pct(r.successRate, 2)}</td>
                      <td>{r.failed}</td>
                      <td>{r.avgFeePct.toFixed(2)}%</td>
                      <td>{ms(r.avgTimeMs)}</td>
                      <td>{ms(r.p95TimeMs)}</td>
                      <td>{r.retried}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h2 className="spaced">Key findings</h2>
            <ul className="findings">
              {report.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </section>

          <div className="grid three">
            <MetricChart results={results} title="Success rate" value={(r) => r.successRate * 100} format={(v) => `${Number(v).toFixed(1)}%`} note="Higher is better" />
            <MetricChart results={results} title="Average fee" value={(r) => r.avgFeePct} format={(v) => `${Number(v).toFixed(2)}%`} note="Lower is better" />
            <MetricChart results={results} title="Average processing time" value={(r) => r.avgTimeMs} format={(v) => `${Math.round(v)} ms`} note="Lower is better" />
          </div>
        </>
      )}
    </>
  );
}
