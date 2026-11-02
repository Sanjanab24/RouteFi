// Simulated payment providers and their baseline behaviour.
// Names must match the provider IDs registered on-chain (blockchain/scripts/deploy.js).
//   feePct      - fee charged, as % of the payment amount
//   latencyMs   - typical processing time
//   failureRate - probability a payment attempt fails (0..1)
export const BASE_PROVIDERS = [
  { name: "FastPay", feePct: 2.9, latencyMs: 400, failureRate: 0.04, color: "#7aa2f7" },
  { name: "CheapPay", feePct: 1.1, latencyMs: 2200, failureRate: 0.09, color: "#73c991" },
  { name: "SafePay", feePct: 2.3, latencyMs: 1100, failureRate: 0.015, color: "#b69cf0" },
  { name: "GlobalPay", feePct: 1.7, latencyMs: 1500, failureRate: 0.05, color: "#e8a267" },
];

// What a merchant without RouteFi would use for every payment (baseline for benchmarks).
export const FIXED_PROVIDER = "FastPay";
