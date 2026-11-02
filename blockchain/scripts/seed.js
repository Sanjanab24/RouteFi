// Creates example payments so every dashboard feature has something to show.
// Usage (after deploy):  npx hardhat run scripts/seed.js --network localhost
//   #1 rerouted once, then settled   #2 three providers failed, refunded
//   #3 settled first time             #4 left pending - for the "Claim refund" demo
const { ethers } = require("hardhat");
const deployment = require("../../frontend/src/contracts/RouteFiEscrow.json");

const id = (name) => ethers.encodeBytes32String(name);

async function main() {
  const [operator, payer, merchant] = await ethers.getSigners(); // accounts #0, #1, #2
  const escrow = await ethers.getContractAt("RouteFiEscrow", deployment.address, operator);
  const pay = async (eth, provider) => {
    const receipt = await (await escrow.connect(payer).createPayment(merchant.address, id(provider), { value: ethers.parseEther(eth) })).wait();
    return escrow.interface.parseLog(receipt.logs.find((l) => escrow.interface.parseLog(l)?.name === "PaymentCreated")).args.id;
  };

  const p1 = await pay("0.5", "SafePay");
  await (await escrow.reroute(p1, id("GlobalPay"))).wait();
  await (await escrow.settle(p1)).wait();

  const p2 = await pay("0.2", "CheapPay");
  await (await escrow.reroute(p2, id("FastPay"))).wait();
  await (await escrow.reroute(p2, id("GlobalPay"))).wait();
  await (await escrow.refund(p2, "all 3 attempts failed")).wait();

  const p3 = await pay("0.3", "FastPay");
  await (await escrow.settle(p3)).wait();

  await pay("0.25", "SafePay"); // stays Pending: Fast-forward 1 hour, then Claim refund

  console.log(`Demo payments created: #${p1} settled after reroute, #${p2} refunded, #${p3} settled, #4 pending.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
