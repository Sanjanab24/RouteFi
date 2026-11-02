import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import SetupHelp from "./components/SetupHelp.jsx";
import PaymentPanel from "./components/PaymentPanel.jsx";
import ProvidersPanel from "./components/ProvidersPanel.jsx";
import TransactionsPanel from "./components/TransactionsPanel.jsx";
import BenchmarkPanel from "./components/BenchmarkPanel.jsx";
import { AnalyticsIcon, BenchIcon, ListIcon, PayIcon } from "./components/Icons.jsx";
import { createRng, initialState, recordAttempt, tick } from "./routing/simulator.js";
import {
  checkChain,
  connectBuiltin,
  connectMetaMask,
  explainError,
  getOperatorContract,
  getReadContract,
  getRpc,
  readProviderStatus,
} from "./lib/chain.js";

const TICK_MS = 2500; // how often simulated network conditions change
const TABS = [
  { key: "pay", label: "Make Payment", Icon: PayIcon, subtitle: "Route a payment through the best provider and settle it on-chain" },
  { key: "providers", label: "Provider Analytics", Icon: AnalyticsIcon, subtitle: "Live provider conditions and the on-chain provider registry" },
  { key: "history", label: "Transactions", Icon: ListIcon, subtitle: "Every payment, rebuilt from the contract's public event log" },
  { key: "benchmark", label: "Benchmark", Icon: BenchIcon, subtitle: "Compare routing strategies on thousands of simulated payments" },
];

export default function App() {
  const rngRef = useRef(createRng(Date.now() >>> 0));
  const [sim, setSim] = useState(() => initialState());
  const [onChain, setOnChain] = useState({}); // provider name -> active in the on-chain registry
  const [chain, setChain] = useState({ status: "checking" });
  const [operator, setOperator] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [merchantDefault, setMerchantDefault] = useState("");
  const [balances, setBalances] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("pay");
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Simulated network conditions drift continuously.
  useEffect(() => {
    const t = setInterval(() => setSim((s) => tick(s, rngRef.current)), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const recheck = useCallback(() => {
    setChain({ status: "checking" });
    checkChain().then(setChain);
  }, []);
  useEffect(recheck, [recheck]);

  useEffect(() => {
    if (chain.status !== "ready") return;
    getOperatorContract().then(setOperator).catch((e) => setError(explainError(e)));
    getRpc()
      .listAccounts()
      .then((accounts) => setMerchantDefault(accounts[2]?.address ?? ""))
      .catch(() => {});
  }, [chain.status]);

  useEffect(() => {
    if (chain.status !== "ready") return;
    readProviderStatus().then(setOnChain).catch(() => {});
  }, [chain.status, refreshKey]);

  // Balances: refresh after every action and every few seconds.
  useEffect(() => {
    if (chain.status !== "ready") return;
    let alive = true;
    const load = async () => {
      const [escrowOwed, payer] = await Promise.all([
        getReadContract().escrowBalance(),
        wallet ? getRpc().getBalance(wallet.address) : null,
      ]);
      if (alive) setBalances({ escrowOwed, payer });
    };
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [chain.status, wallet, refreshKey]);

  const connect = useCallback(
    async (mode) => {
      setError("");
      try {
        setWallet(mode === "metamask" ? await connectMetaMask() : await connectBuiltin());
        refresh();
      } catch (e) {
        setError(explainError(e));
      }
    },
    [refresh]
  );

  // Demo-friendly: connect the built-in test wallet automatically (MetaMask stays optional).
  const autoConnected = useRef(false);
  useEffect(() => {
    if (chain.status !== "ready" || wallet || autoConnected.current) return;
    autoConnected.current = true;
    connect("builtin");
  }, [chain.status, wallet, connect]);

  // Follow MetaMask account switches; drop the connection if the user changes network.
  useEffect(() => {
    const eth = window.ethereum;
    if (wallet?.mode !== "metamask" || !eth?.on) return;
    const onAccounts = () => connect("metamask");
    const onChainChanged = () => {
      setWallet(null);
      setError("MetaMask switched network - click Connect MetaMask again.");
    };
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChainChanged);
    return () => {
      eth.removeListener("accountsChanged", onAccounts);
      eth.removeListener("chainChanged", onChainChanged);
    };
  }, [wallet?.mode, connect]);

  const providers = useMemo(
    () => sim.providers.map((p) => ({ ...p, onChainActive: onChain[p.name] ?? false })),
    [sim, onChain]
  );
  // The payment flow runs for several seconds and must always see the LATEST conditions.
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const getProviders = useCallback(() => providersRef.current, []);
  const onAttempt = useCallback((name, success) => setSim((s) => recordAttempt(s, name, success)), []);

  const current = TABS.find((t) => t.key === tab);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">R</div>
          <div>
            <div className="brand-name">RouteFi</div>
            <div className="brand-sub">Payment routing</div>
          </div>
        </div>

        <nav className="nav" role="tablist" aria-label="Sections">
          <div className="nav-label">Workspace</div>
          {TABS.map(({ key, label, Icon }) => (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "nav-item active" : "nav-item"} onClick={() => setTab(key)}>
              <Icon />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="net">
            <span className={`pill ${chain.status === "ready" ? "good" : "bad"}`}>{chain.status === "ready" ? "Hardhat · 31337" : "Offline"}</span>
          </div>
          Educational simulator · test ETH only · simulated providers
        </div>
      </aside>

      <div className="main">
        <Header title={current.label} subtitle={current.subtitle} chain={chain} wallet={wallet} balances={balances} error={error} onConnect={connect} />

        <main className="content">
          {tab === "benchmark" ? (
            <BenchmarkPanel />
          ) : chain.status !== "ready" ? (
            <SetupHelp status={chain.status} onRetry={recheck} />
          ) : (
            <>
              {tab === "pay" && (
                <PaymentPanel
                  wallet={wallet}
                  operator={operator}
                  providers={providers}
                  getProviders={getProviders}
                  rng={rngRef.current}
                  merchantDefault={merchantDefault}
                  onAttempt={onAttempt}
                  onDone={refresh}
                />
              )}
              {tab === "providers" && <ProvidersPanel providers={providers} operator={operator} onChanged={refresh} />}
              {tab === "history" && <TransactionsPanel wallet={wallet} refreshKey={refreshKey} onChanged={refresh} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
