// One-command RouteFi demo: local blockchain + contract + demo payments + dashboard.
// Usage:  double-click start.bat   (or: node start.js)        Stop: Ctrl + C
const { spawn, spawnSync } = require("child_process");
const net = require("net");

const ROOT = __dirname;
const children = [];
const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// "localhost" may be served on IPv4 (Hardhat) or IPv6 (Vite on Windows) - check both.
async function isPortOpen(port) {
  return (await canConnect(port, "127.0.0.1")) || (await canConnect(port, "::1"));
}

async function waitForPort(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startBackground(command) {
  const child = spawn(command, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

// The port being open is not enough - another RouteFi window could own it. Make sure OUR process is still alive.
async function ensureAlive(child, what) {
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode !== null) {
    throw new Error(`The ${what} stopped unexpectedly - RouteFi may already be running in another window. Close it and try again.`);
  }
}

function runStep(command) {
  const r = spawnSync(command, { cwd: ROOT, shell: true, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`Step failed: ${command}`);
  }
  return r.stdout;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}

// Turn the node's multi-line transaction logs into one readable line per transaction.
function showChainActivity(child) {
  let tx = null;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const call = line.match(/Contract call:\s+\S+#(\w+)/);
      const from = line.match(/From:\s+(0x[0-9a-fA-F]{40})/);
      const value = line.match(/Value:\s+([\d.]+) ETH/);
      const block = line.match(/Block #(\d+)/);
      const error = line.match(/Error: (.*)/);
      if (call) tx = { fn: call[1] };
      else if (tx && from) tx.from = from[1];
      else if (tx && value) tx.value = value[1];
      else if (tx && error) tx.error = error[1];
      else if (tx && block) {
        if (ready) {
          const eth = tx.value && tx.value !== "0" ? ` · ${tx.value} ETH` : "";
          const status = tx.error ? ` · REJECTED: ${tx.error}` : "";
          console.log(`  [blockchain] block ${block[1].padEnd(3)} ${tx.fn.padEnd(17)} from ${short(tx.from ?? "0x0000000000000000000000000000000000000000")}${eth}${status}`);
        }
        tx = null;
      }
    }
  });
}

let ready = false; // only echo transactions once setup is done (keeps the demo output clean)

async function main() {
  console.log("\n  RouteFi - starting demo\n");
  for (const port of [8545, 5173]) {
    if (await isPortOpen(port)) {
      console.error(`  Port ${port} is already in use - RouteFi (or another app) is already running.`);
      console.error("  Close the other window first, then start again.\n");
      process.exit(1);
    }
  }

  process.stdout.write("  [1/4] Starting local blockchain...      ");
  const chain = startBackground("npm --prefix blockchain run node");
  showChainActivity(chain);
  if (!(await waitForPort(8545, 60000))) throw new Error("The blockchain did not start within 60 s.");
  await ensureAlive(chain, "blockchain");
  console.log("done");

  process.stdout.write("  [2/4] Deploying RouteFi smart contract... ");
  const deployOut = runStep("npm --prefix blockchain run deploy:local");
  console.log(`done (${deployOut.match(/deployed at (0x[0-9a-fA-F]+)/)?.[1] ?? "?"})`);

  process.stdout.write("  [3/4] Creating demo payments...          ");
  runStep("npm --prefix blockchain run seed:local");
  console.log("done (4 payments)");

  process.stdout.write("  [4/4] Starting dashboard...              ");
  const open = process.env.ROUTEFI_NO_OPEN ? "" : " -- --open";
  const web = startBackground(`npm --prefix frontend run dev${open}`);
  web.stderr.on("data", (d) => process.stderr.write(d));
  if (!(await waitForPort(5173, 60000))) throw new Error("The dashboard did not start within 60 s.");
  await ensureAlive(web, "dashboard");
  console.log("done");

  ready = true;
  console.log("\n  ==========================================================");
  console.log("   RouteFi is running:  http://localhost:5173");
  console.log("   Live blockchain transactions appear below.");
  console.log("   Press Ctrl + C to stop.");
  console.log("  ==========================================================\n");
}

process.on("SIGINT", () => {
  console.log("\n  Stopping RouteFi...");
  stopAll();
  process.exit(0);
});
process.on("exit", stopAll);

main().catch((err) => {
  console.error(`\n  ${err.message}`);
  stopAll();
  process.exit(1);
});
