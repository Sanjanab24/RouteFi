// RouteFi routing engine: scores providers on fee, latency and failure probability
// and picks the best one. Pure functions, reused by the benchmark script.
//
// Scoring (lower is better):
//   1. Keep only eligible providers: not in outage, active on-chain, not already tried.
//   2. Min-max normalise each metric across eligible providers to 0..1
//      (0 = best among them, 1 = worst).
//   3. score = wFee * fee + wLatency * latency + wFailure * failure
import { FIXED_PROVIDER } from "./providers.js";

export const PRESETS = {
  balanced: { label: "Balanced", fee: 0.4, latency: 0.3, failure: 0.3 },
  cheapest: { label: "Lowest fee", fee: 0.7, latency: 0.1, failure: 0.2 },
  fastest: { label: "Fastest", fee: 0.1, latency: 0.7, failure: 0.2 },
  reliable: { label: "Most reliable", fee: 0.15, latency: 0.15, failure: 0.7 },
};

function skipReason(p, exclude) {
  if (exclude.has(p.name)) return "already tried";
  if (!p.up) return "outage";
  if (p.onChainActive === false) return "disabled on-chain";
  return null;
}

/**
 * Rank providers for a payment.
 * @returns {{ ranked: Array, skipped: Array<{name, reason}> }} ranked best-first, each with `score` and `parts`.
 */
export function rankProviders(providers, weights, exclude = new Set()) {
  const eligible = providers.filter((p) => !skipReason(p, exclude));
  const skipped = providers
    .filter((p) => skipReason(p, exclude))
    .map((p) => ({ name: p.name, reason: skipReason(p, exclude) }));

  const range = (key) => {
    const values = eligible.map((p) => p[key]);
    return [Math.min(...values), Math.max(...values)];
  };
  const norm = (v, [lo, hi]) => (hi === lo ? 0 : (v - lo) / (hi - lo));
  const ranges = { fee: range("feePct"), latency: range("latencyMs"), failure: range("failureRate") };

  const ranked = eligible
    .map((p) => {
      const parts = {
        fee: norm(p.feePct, ranges.fee),
        latency: norm(p.latencyMs, ranges.latency),
        failure: norm(p.failureRate, ranges.failure),
      };
      const score = weights.fee * parts.fee + weights.latency * parts.latency + weights.failure * parts.failure;
      return { ...p, parts, score };
    })
    .sort((a, b) => a.score - b.score);

  return { ranked, skipped };
}

/**
 * Pick a provider using a strategy:
 *   "smart"  - RouteFi: best score among eligible providers
 *   "fixed"  - always FIXED_PROVIDER, even during outages (no failover) - the traditional baseline
 *   "random" - any eligible provider at random
 * @returns the chosen provider, or null if none can be used.
 */
export function chooseProvider(strategy, providers, weights, exclude, rng) {
  if (strategy === "fixed") {
    if (exclude.has(FIXED_PROVIDER)) return null;
    return providers.find((p) => p.name === FIXED_PROVIDER) ?? null;
  }
  const { ranked } = rankProviders(providers, weights, exclude);
  if (ranked.length === 0) return null;
  if (strategy === "random") return ranked[Math.floor(rng() * ranked.length)];
  return ranked[0];
}
