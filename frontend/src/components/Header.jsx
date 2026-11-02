import { short, eth } from "../lib/format.js";

const CHAIN_LABEL = {
  checking: ["Connecting…", "neutral"],
  ready: ["Blockchain connected", "good"],
  "no-node": ["Blockchain offline", "bad"],
  "not-deployed": ["Contract not deployed", "bad"],
  "no-deployment": ["Contract not deployed", "bad"],
};

export default function Header({ title, subtitle, chain, wallet, balances, error, onConnect }) {
  const [label, tone] = CHAIN_LABEL[chain.status] ?? ["Unknown", "neutral"];
  const ready = chain.status === "ready";

  return (
    <header className="topbar">
      <div>
        <h1 className="page-title">{title}</h1>
        <p className="page-sub">{subtitle}</p>
      </div>

      <div className="topbar-right">
        <span className={`pill ${tone}`}>{label}</span>

        {ready && balances && (
          <div className="metric">
            <span className="metric-label">Held in escrow</span>
            <span className="metric-value">{eth(balances.escrowOwed)}</span>
          </div>
        )}

        {wallet ? (
          <>
            <div className="metric">
              <span className="metric-label">
                {wallet.mode === "metamask" ? "MetaMask" : "Test wallet"} · {short(wallet.address)}
              </span>
              <span className="metric-value">{eth(balances?.payer, 3)}</span>
            </div>
            <button
              className="btn small"
              onClick={() => onConnect(wallet.mode === "metamask" ? "builtin" : "metamask")}
              title={wallet.mode === "metamask" ? "Switch back to the built-in test wallet" : "Optional: pay from your MetaMask wallet instead"}
            >
              {wallet.mode === "metamask" ? "Use test wallet" : "Use MetaMask"}
            </button>
          </>
        ) : (
          ready && (
            <>
              <button className="btn primary small" onClick={() => onConnect("metamask")}>
                Connect MetaMask
              </button>
              <button className="btn small" onClick={() => onConnect("builtin")}>
                Use test wallet
              </button>
            </>
          )
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
    </header>
  );
}
