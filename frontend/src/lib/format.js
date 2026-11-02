import { formatEther } from "ethers";

export const short = (addr) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "-");
export const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "-");

export function eth(wei, digits = 4) {
  if (wei === null || wei === undefined) return "-";
  const n = Number(formatEther(wei));
  return `${n.toLocaleString(undefined, { maximumFractionDigits: digits })} ETH`;
}

export const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)}%`;
export const ms = (x) => `${Math.round(x).toLocaleString()} ms`;

export function duration(seconds) {
  const s = Math.max(0, Number(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
