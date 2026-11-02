// Benchmark: compares routing strategies on the SAME simulated network conditions.
// Pure JS - used by both the dashboard's Benchmark tab and `npm run benchmark`.
//
// Fairness ("common random numbers"): for every payment, the network state and the random
// draw that decides each provider's success/latency are generated ONCE and shared by all
// strategies. If two strategies send the same payment through the same provider, they get the
// same outcome - so differences come only from the routing decisions.
import { BASE_PROVIDERS } from "./providers.js";
import { createRng, initialState, tick } from "./simulator.js";
import { PRESETS, chooseProvider } from "./router.js";

const MAX_ATTEMPTS = 3; // same limit as the smart contract

export const STRATEGIES = [
  { key: "fixed", label: "Fixed (always FastPay)", strategy: "fixed", weights: PRESETS.balanced, failover: false },
  { key: "random", label: "Random provider", strategy: "random", weights: PRESETS.balanced, failover: true },
  { key: "cheapest", label: "Cheapest only", strategy: "smart", weights: { fee: 1, latency: 0, failure: 0 }, failover: true },
  { key: "fastest", label: "Fastest only", strategy: "smart", weights: { fee: 0, latency: 1, failure: 0 }, failover: true },
  { key: "routefi", label: "RouteFi smart (balanced)", strategy: "smart", weights: PRESETS.balanced, failover: true },
];

/** One payment under one strategy: up to MAX_ATTEMPTS providers (1 if no failover). */
function simulatePayment(s, providers, draws, rng) {
  const tried = new Set();
  let timeMs = 0;
  const maxAttempts = s.failover ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const p = chooseProvider(s.strategy, providers, s.weights, tried, rng);
    if (!p) break;
    tried.add(p.name);
    const d = draws[p.name];
    timeMs += p.latencyMs * d.jitter;
    if (p.up && d.u >= p.failureRate) return { success: true, attempts: attempt, timeMs, feePct: p.feePct };
  }
  return { success: false, attempts: tried.size, timeMs, feePct: 0 };
}

const emptyTotals = () => ({ payments: 0, successes: 0, attempts: 0, retried: 0, feeSum: 0, timeSum: 0, times: [] });

function record(t, r) {
  t.payments += 1;
  t.attempts += r.attempts;
  if (r.attempts > 1) t.retried += 1;
  if (r.success) {
    t.successes += 1;
    t.feeSum += r.feePct;
    t.timeSum += r.timeMs;
    t.times.push(r.timeMs);
  }
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarize(s, t) {
  const times = [...t.times].sort((a, b) => a - b);
  return {
    key: s.key,
    label: s.label,
    payments: t.payments,
    successRate: t.successes / t.payments,
    failed: t.payments - t.successes,
    avgFeePct: t.successes ? t.feeSum / t.successes : 0, // fees are only charged on success
    avgTimeMs: t.successes ? t.timeSum / t.successes : 0, // includes time lost on failed attempts
    p95TimeMs: percentile(times, 0.95),
    avgAttempts: t.attempts / t.payments,
    retried: t.retried, // payments that needed more than one provider (customer-visible delay)
  };
}

/**
 * @param o.payments  payments per run
 * @param o.runs      independent runs (different network histories), results pooled
 * @param o.seed      base seed - same seed always gives the same results
 */
export function runBenchmark({ payments = 1000, runs = 5, seed = 42 } = {}) {
  const totals = Object.fromEntries(STRATEGIES.map((s) => [s.key, emptyTotals()]));

  for (let run = 0; run < runs; run++) {
    const rng = createRng(seed + run * 7919);
    let state = initialState(BASE_PROVIDERS);
    for (let i = 0; i < payments; i++) {
      state = tick(state, rng); // network conditions move on between payments
      const providers = state.providers.map((p) => ({ ...p, onChainActive: true }));
      const draws = Object.fromEntries(providers.map((p) => [p.name, { u: rng(), jitter: 0.7 + 0.6 * rng() }]));
      const pickRng = createRng(seed * 31 + run * 1000003 + i); // only used by the random strategy
      for (const s of STRATEGIES) record(totals[s.key], simulatePayment(s, providers, draws, pickRng));
    }
  }

  const results = STRATEGIES.map((s) => summarize(s, totals[s.key]));
  return { config: { payments, runs, seed }, results, findings: findings(results) };
}

/** Plain-English comparison of RouteFi against the other strategies. Wording follows the actual numbers. */
function findings(results) {
  const by = Object.fromEntries(results.map((r) => [r.key, r]));
  const { routefi: rf, fixed: fx, random: rd, cheapest: ch, fastest: fs } = by;
  const pp = (x) => (x * 100).toFixed(2);
  const fee = (r) => `${r.avgFeePct.toFixed(2)}%`;
  const ms = (x) => `${Math.round(x)} ms`;
  // "23% lower" / "12% higher": RouteFi's value `a` relative to the other strategy's `b`.
  const rel = (a, b) => (b === 0 ? "n/a" : `${Math.round((Math.abs(a - b) / b) * 100)}% ${a <= b ? "lower" : "higher"}`);

  return [
    `vs fixed provider: success ${pp(rf.successRate)}% vs ${pp(fx.successRate)}% (${fx.failed} failed payments → ${rf.failed}); ` +
      `average fee ${rel(rf.avgFeePct, fx.avgFeePct)} (${fee(rf)} vs ${fee(fx)}). ` +
      `Fixed is faster when it works (${ms(fx.avgTimeMs)} vs ${ms(rf.avgTimeMs)}) because FastPay is the quickest provider, but it has no failover.`,
    `vs random routing: average time ${rel(rf.avgTimeMs, rd.avgTimeMs)}, p95 time ${rel(rf.p95TimeMs, rd.p95TimeMs)}, ` +
      `${rf.retried} vs ${rd.retried} payments needed a retry; fee ${fee(rf)} vs ${fee(rd)} (${rel(rf.avgFeePct, rd.avgFeePct)}).`,
    `Single-metric routing is extreme: cheapest-only has the lowest fee (${fee(ch)}) but is slowest (${ms(ch.avgTimeMs)}); ` +
      `fastest-only is quick (${ms(fs.avgTimeMs)}) but expensive (${fee(fs)}). ` +
      `RouteFi's balanced preset sits between them (${fee(rf)}, ${ms(rf.avgTimeMs)}); merchants can choose another preset.`,
  ];
}
