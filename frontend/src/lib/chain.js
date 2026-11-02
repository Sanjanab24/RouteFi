// Everything that talks to the blockchain.
//
// Two roles:
//   - Payer:    the user. Either a built-in Hardhat test account or their MetaMask wallet.
//   - Operator: the RouteFi routing service (settle / reroute / refund). In this local demo it is
//               the contract owner, Hardhat account #0, which the local node unlocks for us -
//               no private key is stored in this code. A real system would run it on a server.
import { BrowserProvider, Contract, JsonRpcProvider, Network, decodeBytes32String, encodeBytes32String } from "ethers";

// Written by `npm run deploy:local` in the blockchain folder. Missing until the first deploy.
const found = import.meta.glob("../contracts/RouteFiEscrow.json", { eager: true, import: "default" });
export const deployment = Object.values(found)[0] ?? null;

export const RPC_URL = "http://127.0.0.1:8545";
const CHAIN_ID = deployment?.chainId ?? 31337;
export const STATUS = ["None", "Pending", "Settled", "Refunded"];

export const toId = (name) => encodeBytes32String(name);
export const fromId = (id) => decodeBytes32String(id);

let rpc;
export function getRpc() {
  // staticNetwork: don't keep retrying network detection if the node is down.
  if (!rpc) rpc = new JsonRpcProvider(RPC_URL, Network.from(CHAIN_ID), { staticNetwork: true, pollingInterval: 1000 });
  return rpc;
}

export function getReadContract() {
  return new Contract(deployment.address, deployment.abi, getRpc());
}

/** Is the local node running and the contract deployed at the saved address? */
export async function checkChain() {
  if (!deployment) return { status: "no-deployment" };
  try {
    const code = await getRpc().getCode(deployment.address);
    return { status: code === "0x" ? "not-deployed" : "ready" };
  } catch {
    return { status: "no-node" };
  }
}

/** Operator = contract owner (Hardhat account #0), signing through the local node. */
export async function getOperatorContract() {
  const signer = await getRpc().getSigner(deployment.owner);
  return new Contract(deployment.address, deployment.abi, signer);
}

/** Built-in payer: Hardhat account #1 (10,000 test ETH). */
export async function connectBuiltin() {
  const signer = await getRpc().getSigner(1);
  return { mode: "builtin", signer, address: await signer.getAddress(), contract: new Contract(deployment.address, deployment.abi, signer) };
}

/** MetaMask payer. Switches (or adds) MetaMask to the local Hardhat network first. */
export async function connectMetaMask() {
  const eth = window.ethereum;
  if (!eth) throw new Error("MetaMask was not found in this browser. Install it, or use the built-in test account.");
  await eth.request({ method: "eth_requestAccounts" });

  const chainHex = "0x" + CHAIN_ID.toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (err) {
    if (err.code !== 4902) throw err; // 4902 = MetaMask doesn't know this network yet
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: chainHex, chainName: "Hardhat Localhost", rpcUrls: [RPC_URL], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
    });
  }

  // Create the provider only after the network switch, so ethers sees the right chain.
  const signer = await new BrowserProvider(eth).getSigner();
  return { mode: "metamask", signer, address: await signer.getAddress(), contract: new Contract(deployment.address, deployment.abi, signer) };
}

/** On-chain provider registry as { name: active }. */
export async function readProviderStatus() {
  const [ids, active] = await getReadContract().getProviders();
  return Object.fromEntries(ids.map((id, i) => [fromId(id), active[i]]));
}

export async function chainTime() {
  return BigInt((await getRpc().getBlock("latest")).timestamp);
}

/** Test chains only: move the blockchain clock forward and mine a block. */
export async function fastForward(seconds) {
  await getRpc().send("evm_increaseTime", [seconds]);
  await getRpc().send("evm_mine", []);
}

/** Rebuild every payment's history from the contract's events (the on-chain audit trail). */
export async function loadHistory() {
  const c = getReadContract();
  const logs = await c.queryFilter("*", 0, "latest");
  const byId = new Map();
  for (const log of logs) {
    if (!log.fragment?.name.startsWith("Payment")) continue;
    const id = log.args[0];
    if (!byId.has(id)) byId.set(id, { id, events: [] });
    byId.get(id).events.push({ name: log.fragment.name, block: log.blockNumber, hash: log.transactionHash, args: log.args });
  }
  const rows = await Promise.all(
    [...byId.values()].map(async (row) => ({
      ...row,
      payment: await c.getPayment(row.id),
      deadline: await c.refundAvailableAt(row.id),
    }))
  );
  rows.sort((a, b) => Number(b.id - a.id));
  return { now: await chainTime(), rows };
}

/** Independently re-check that each event's transaction is really in the chain and succeeded. */
export async function verifyEvents(events) {
  const rpc = getRpc();
  return Promise.all(
    events.map(async (e) => {
      const receipt = await rpc.getTransactionReceipt(e.hash);
      return Boolean(receipt && receipt.status === 1 && receipt.blockNumber === e.block);
    })
  );
}

/** Turn any wallet/contract error into a short human-readable sentence. */
export function explainError(err) {
  if (err?.code === "ACTION_REJECTED" || err?.info?.error?.code === 4001 || err?.code === 4001) {
    return "You rejected the request in your wallet.";
  }
  if (err?.revert?.name) return `Contract rejected it: ${err.revert.name}`;
  const data = err?.data ?? err?.info?.error?.data?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (typeof data === "string" && deployment) {
    try {
      const parsed = getReadContract().interface.parseError(data);
      if (parsed) return `Contract rejected it: ${parsed.name}`;
    } catch {
      /* not a RouteFi error */
    }
  }
  const msg = err?.shortMessage || err?.message || String(err);
  if (/nonce/i.test(msg)) return `${msg} - in MetaMask: Settings > Advanced > Clear activity tab data, then retry.`;
  return msg;
}
