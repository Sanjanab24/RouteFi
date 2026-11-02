// Provider simulator: makes fees, latency and failure rates drift over time, injects
// random outages, and decides whether an individual payment attempt succeeds.
// Pure functions with no browser dependencies, so the benchmark script can reuse them.
import { BASE_PROVIDERS } from "./providers.js";

const HISTORY_LENGTH = 30; // ticks of history kept for charts
const OUTAGE_CHANCE = 0.02; // per provider, per tick
const REVERT = 0.3; // how strongly values are pulled back toward the baseline each tick

/** Seeded random number generator (mulberry32) so simulations are reproducible. Returns 0..1. */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const noise = (rng) => (rng() + rng() + rng() - 1.5) / 1.5; // bell-shaped, roughly -1..1
const pushHistory = (arr, v) => [...arr, v].slice(-HISTORY_LENGTH);

export function initialState(baseProviders = BASE_PROVIDERS) {
  return {
    tick: 0,
    providers: baseProviders.map((b) => ({
      ...b,
      base: b,
      up: true,
      downFor: 0,
      latencyHistory: [b.latencyMs],
      failureHistory: [b.failureRate],
      attempts: 0,
      successes: 0,
    })),
  };
}

/** Advance network conditions by one tick. Returns a new state (never mutates). */
export function tick(state, rng) {
  return { ...state, tick: state.tick + 1, providers: state.providers.map((p) => stepProvider(p, rng)) };
}

function stepProvider(p, rng) {
  const b = p.base;
  // Mean-reverting random walk: drift back toward the baseline, plus random noise.
  const latencyMs = clamp(
    p.latencyMs + REVERT * (b.latencyMs - p.latencyMs) + 0.25 * b.latencyMs * noise(rng),
    0.4 * b.latencyMs,
    3 * b.latencyMs
  );
  const failureRate = clamp(
    p.failureRate + REVERT * (b.failureRate - p.failureRate) + 0.5 * b.failureRate * noise(rng),
    0.002,
    0.5
  );
  const feePct = clamp(p.feePct + REVERT * (b.feePct - p.feePct) + 0.05 * noise(rng), b.feePct - 0.4, b.feePct + 0.4);

  let { up, downFor } = p;
  if (up && rng() < OUTAGE_CHANCE) {
    up = false;
    downFor = 3 + Math.floor(rng() * 4); // outage lasts 3-6 ticks
  } else if (!up) {
    downFor -= 1;
    if (downFor <= 0) up = true;
  }

  return {
    ...p,
    latencyMs,
    failureRate,
    feePct,
    up,
    downFor,
    latencyHistory: pushHistory(p.latencyHistory, latencyMs),
    failureHistory: pushHistory(p.failureHistory, failureRate),
  };
}

/** Simulate one payment attempt through `provider`. A provider in outage always fails. */
export function simulateAttempt(provider, rng) {
  const latencyMs = provider.latencyMs * (0.7 + 0.6 * rng());
  const success = provider.up && rng() >= provider.failureRate;
  return { success, latencyMs };
}

/** Record an observed attempt outcome (for the "observed success rate" stats). */
export function recordAttempt(state, name, success) {
  return {
    ...state,
    providers: state.providers.map((p) =>
      p.name === name ? { ...p, attempts: p.attempts + 1, successes: p.successes + (success ? 1 : 0) } : p
    ),
  };
}
