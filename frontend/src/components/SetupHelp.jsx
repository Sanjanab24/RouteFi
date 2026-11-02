const MESSAGES = {
  checking: "Connecting to the local blockchain…",
  "no-node": "The local blockchain isn't running.",
  "not-deployed": "The blockchain is running, but the RouteFi contract isn't deployed on it yet (this happens every time the node restarts).",
  "no-deployment": "The RouteFi contract hasn't been deployed yet.",
};

export default function SetupHelp({ status, onRetry }) {
  return (
    <section className="card setup">
      <h2>Almost there</h2>
      <p>{MESSAGES[status] ?? "Unknown state."}</p>
      {status !== "checking" && (
        <>
          <ol>
            <li>
              Terminal 1 - start the blockchain (leave it running):
              <pre>cd blockchain{"\n"}npm run node</pre>
            </li>
            <li>
              Terminal 2 - deploy the contract:
              <pre>cd blockchain{"\n"}npm run deploy:local</pre>
            </li>
          </ol>
          <button className="btn primary" onClick={onRetry}>
            Check again
          </button>
        </>
      )}
    </section>
  );
}
