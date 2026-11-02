// Terminal benchmark. Usage (from frontend/):
//   npm run benchmark
//   npm run benchmark -- --payments 2000 --runs 10 --seed 7
// Writes docs/benchmark-results.md and docs/benchmark-results.json for the project report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "../src/routing/benchmark.js";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map((a) => a.trim().split(/\s+/))
    .map(([k, v]) => [k, Number(v)])
);

const started = performance.now();
const report = runBenchmark({ payments: args.payments ?? 1000, runs: args.runs ?? 5, seed: args.seed ?? 42 });
const elapsed = Math.round(performance.now() - started);
const { payments, runs, seed } = report.config;

const rows = report.results.map((r) => [
  r.label,
  `${(r.successRate * 100).toFixed(2)}%`,
  String(r.failed),
  `${r.avgFeePct.toFixed(2)}%`,
  `${Math.round(r.avgTimeMs)} ms`,
  `${Math.round(r.p95TimeMs)} ms`,
  r.avgAttempts.toFixed(2),
  String(r.retried),
]);
const header = ["Strategy", "Success", "Failed", "Avg fee", "Avg time", "p95 time", "Attempts", "Retried"];

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

console.log(`\nRouteFi routing benchmark - ${payments * runs} payments (${runs} runs x ${payments}, seed ${seed}), ${elapsed} ms\n`);
console.log(line(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
rows.forEach((r) => console.log(line(r)));
console.log("\nKey findings:");
report.findings.forEach((f) => console.log(`  - ${f}`));

// Save for the report.
const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, "benchmark-results.json"), JSON.stringify(report, null, 2));
const md = [
  "# RouteFi routing benchmark",
  "",
  `${payments * runs} simulated payments (${runs} runs × ${payments}, seed ${seed}). Every strategy faces identical network conditions and random outcomes.`,
  "Max 3 provider attempts per payment (same as the smart contract); the fixed strategy has no failover.",
  "Avg fee and time are over successful payments; time includes attempts that failed first.",
  "",
  `| ${header.join(" | ")} |`,
  `| ${header.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
  "",
  "## Key findings",
  "",
  ...report.findings.map((f) => `- ${f}`),
  "",
  `Reproduce: \`cd frontend && npm run benchmark -- --payments ${payments} --runs ${runs} --seed ${seed}\``,
  "",
].join("\n");
fs.writeFileSync(path.join(docs, "benchmark-results.md"), md);
console.log(`\nSaved docs/benchmark-results.md and docs/benchmark-results.json`);
