# RouteFi

**Intelligent payment routing with secure blockchain settlement.** An educational FinTech simulator:
a routing engine picks the best of several simulated payment providers (fee, speed, reliability),
and a Solidity smart contract holds the payment in escrow until it is settled, rerouted or refunded.

> Educational project. Test ETH only, simulated providers - no real payments.

CS2614 Fundamentals of Blockchain · Mini Project · Team 02, RV University

## How it works

1. The **routing engine** scores every available provider: `score = 0.4 × fee + 0.3 × latency + 0.3 × failure`
   (each normalised 0-1 among available providers; lowest score wins).
2. The payer locks test ETH in the **`RouteFiEscrow`** contract (`createPayment`).
3. If the provider fails, the operator **reroutes** to the next-best untried provider (max 3 attempts).
4. On success the contract **settles** to the merchant; otherwise it **refunds** the payer.
   If the operator never acts, the payer can **`claimRefund`** after a one-hour deadline.
5. Every step emits an **event** - the dashboard rebuilds and verifies the full history from them.

## Tech stack

Solidity 0.8.24 · OpenZeppelin 5 (Ownable2Step, ReentrancyGuard) · Hardhat 2 · React 18 + Vite · ethers.js v6 · Chart.js

## Project structure

```
RouteFi/
├── start.bat / start.js         one-click launcher (blockchain + deploy + demo data + dashboard)
├── blockchain/                  Solidity + Hardhat
│   ├── contracts/RouteFiEscrow.sol   the escrow smart contract
│   ├── test/                         72 automated tests (features + security regressions)
│   └── scripts/                      deploy.js · seed.js (demo payments) · demo.js (terminal walkthrough)
└── frontend/                    React dashboard (Vite + ethers.js + Chart.js)
    ├── scripts/benchmark.js     terminal benchmark
    └── src/
        ├── routing/             routing engine, provider simulator, benchmark (pure JS)
        ├── lib/                 blockchain connection + payment flow
        └── components/          dashboard pages
```

## Quick start (Windows, one click)

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone <this-repo-url>
cd RouteFi
```

Then double-click **`start.bat`**. On the first run it installs packages; then it starts a local
blockchain, deploys the contract, creates four demo payments and opens **http://localhost:5173**
with a test wallet already connected. Press **Ctrl + C** in its window to stop.

On macOS / Linux, run `npm --prefix blockchain install && npm --prefix frontend install`, then `node start.js`.

## Manual run (3 terminals)

```bash
# Terminal 1 - local blockchain (leave running)
cd blockchain && npm install && npm run node

# Terminal 2 - deploy the contract (repeat after every restart of Terminal 1)
cd blockchain && npm run deploy:local

# Terminal 3 - dashboard (leave running)
cd frontend && npm install && npm run dev
```

## Dashboard

| Page | What it shows |
|---|---|
| **Make Payment** | Live provider ranking. Tick *"force the first provider to fail"* to see automatic rerouting; each step shows its block and transaction hash. |
| **Provider Analytics** | Live fee, latency and failure rates with outages and charts. **Disable** switches a provider off *on-chain*. |
| **Transactions** | Every payment rebuilt from the contract's event log. **Verify** re-checks each transaction; **Fast-forward 1 hour** + **Claim refund** shows the payer safety net. |
| **Benchmark** | Thousands of simulated payments through 5 strategies on identical conditions. |

MetaMask is optional (**Use MetaMask** in the top bar). To pay from MetaMask, import the Hardhat
**Account #1** private key printed by `npm run node` - a publicly known test key; never send real funds to it.

## Testing

```bash
cd blockchain
npm test        # 72 tests: escrow flow, access control, reentrancy, expiry boundaries, accounting
npm run demo    # 10-step terminal walkthrough of every contract feature
```

## Benchmark results

5,000 simulated payments (5 runs × 1,000, seed 42); every strategy faces identical network conditions and random outcomes.

| Strategy | Success | Failed | Avg fee | Avg time | p95 time | Retried |
|---|---:|---:|---:|---:|---:|---:|
| Fixed (always FastPay) | 88.02% | 599 | 2.90% | 400 ms | 543 ms | 0 |
| Random provider | 100.00% | 0 | 2.01% | 1369 ms | 2765 ms | 264 |
| Cheapest only | 100.00% | 0 | 1.21% | 2264 ms | 3496 ms | 423 |
| Fastest only | 100.00% | 0 | 2.82% | 507 ms | 1326 ms | 197 |
| **RouteFi (balanced)** | **100.00%** | **0** | **2.23%** | **1126 ms** | **1655 ms** | **90** |

- vs a fixed provider: 599 failed payments → 0 and 23% lower fees (the fixed provider is faster when it works).
- vs random routing: 18% faster on average, 40% lower p95 time, 66% fewer retries; random is slightly cheaper.

Reproduce with `cd frontend && npm run benchmark` (also writes `docs/benchmark-results.md`).

## Limitations

Simulated providers · local test network only · a single trusted operator reports provider outcomes (it can
never redirect funds) · gas cost would be significant on mainnet.
