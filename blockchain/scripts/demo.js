// Walks through every RouteFiEscrow feature with readable output.
// Usage:  npm run demo      (runs on a throwaway in-memory blockchain - nothing to set up)
const { ethers, network } = require("hardhat");

const fmt = (wei) => `${ethers.formatEther(wei)} ETH`;
const name = (bytes32) => ethers.decodeBytes32String(bytes32);
const STATUS = ["None", "Pending", "Settled", "Refunded"];
const step = (n, text) => console.log(`\n=== Step ${n}: ${text} ===`);

async function main() {
  const [owner, payer, merchant, stranger] = await ethers.getSigners();
  console.log(`Network: ${network.name}`);
  console.log(`Owner/operator: ${owner.address}`);
  console.log(`Payer:          ${payer.address}`);
  console.log(`Merchant:       ${merchant.address}`);

  step(1, "Deploy the escrow contract with 4 providers");
  const providers = ["FastPay", "CheapPay", "SafePay", "GlobalPay"].map(ethers.encodeBytes32String);
  const escrow = await ethers.deployContract("RouteFiEscrow", [providers]);
  await escrow.waitForDeployment();
  console.log(`Contract address: ${await escrow.getAddress()}`);
  const [ids, active] = await escrow.getProviders();
  ids.forEach((id, i) => console.log(`  ${name(id).padEnd(10)} active=${active[i]}`));

  step(2, "Payer locks 1 ETH in escrow via FastPay");
  const merchantStart = await ethers.provider.getBalance(merchant.address);
  await (await escrow.connect(payer).createPayment(merchant.address, providers[0], { value: ethers.parseEther("1") })).wait();
  let p = await escrow.getPayment(1);
  console.log(`Payment #1: ${fmt(p.amount)} via ${name(p.provider)}, status=${STATUS[p.status]}`);
  console.log(`Escrow now holds: ${fmt(await escrow.escrowBalance())}`);

  step(3, "FastPay 'fails' -> operator reroutes to CheapPay (ETH stays locked)");
  await (await escrow.reroute(1, providers[1])).wait();
  p = await escrow.getPayment(1);
  console.log(`Payment #1 now on ${name(p.provider)}, attempt ${p.attempts} of ${await escrow.MAX_ATTEMPTS()}`);

  step(4, "Try to reroute back to FastPay (should be rejected)");
  await tryIt(() => escrow.reroute(1, providers[0]), escrow);

  step(5, "CheapPay succeeds -> operator settles, merchant gets paid");
  await (await escrow.settle(1)).wait();
  const merchantGain = (await ethers.provider.getBalance(merchant.address)) - merchantStart;
  console.log(`Payment #1 status=${STATUS[(await escrow.getPayment(1)).status]}, merchant received ${fmt(merchantGain)}`);

  step(6, "Try to settle the same payment twice (should be rejected)");
  await tryIt(() => escrow.settle(1), escrow);

  step(7, "A stranger tries to settle someone's payment (should be rejected)");
  await (await escrow.connect(payer).createPayment(merchant.address, providers[2], { value: ethers.parseEther("0.5") })).wait();
  await tryIt(() => escrow.connect(stranger).settle(2), escrow);

  step(8, "All providers fail -> operator refunds payment #2");
  await (await escrow.refund(2, "all providers failed")).wait();
  console.log(`Payment #2 status=${STATUS[(await escrow.getPayment(2)).status]}`);

  step(9, "Operator goes silent -> payer claims refund after the 1-hour deadline");
  await (await escrow.connect(payer).createPayment(merchant.address, providers[3], { value: ethers.parseEther("0.25") })).wait();
  console.log("Payer tries to claim immediately:");
  await tryIt(() => escrow.connect(payer).claimRefund(3), escrow);
  const deadline = await escrow.refundAvailableAt(3);
  await network.provider.send("evm_setNextBlockTimestamp", [Number(deadline)]); // time travel (test chains only)
  console.log("...fast-forwarding the blockchain clock by 1 hour...");
  await tryIt(() => escrow.settle(3), escrow, "Operator tries to settle after expiry:");
  await (await escrow.connect(payer).claimRefund(3)).wait();
  console.log(`Payer claimed refund. Payment #3 status=${STATUS[(await escrow.getPayment(3)).status]}`);

  step(10, "Final check - the on-chain audit trail");
  console.log(`Escrow owes: ${fmt(await escrow.escrowBalance())} (should be 0)`);
  const events = await escrow.queryFilter("*");
  for (const e of events.filter((e) => e.fragment && e.fragment.name.startsWith("Payment"))) {
    console.log(`  block ${e.blockNumber}  ${e.fragment.name.padEnd(16)} payment #${e.args[0]}`);
  }
  console.log("\nDemo complete.");
}

// Sends a transaction we expect to FAIL and prints the contract's error name.
async function tryIt(fn, escrow, label) {
  if (label) console.log(label);
  try {
    await (await fn()).wait();
    console.log("  !! unexpectedly succeeded");
  } catch (err) {
    const data = err.data ?? err.error?.data ?? err.info?.error?.data;
    const decoded = data ? escrow.interface.parseError(data) : null;
    console.log(`  Rejected as expected: ${decoded ? decoded.name : err.shortMessage || err.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
