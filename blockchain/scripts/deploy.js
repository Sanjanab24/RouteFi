// Deploys RouteFiEscrow and saves its address + ABI for the frontend.
// Usage (with `npx hardhat node` running in another terminal):
//   npx hardhat run scripts/deploy.js --network localhost
const fs = require("fs");
const path = require("path");
const { ethers, network, artifacts } = require("hardhat");

// Simulated providers registered on-chain at deployment. Keep in sync with the frontend simulator.
const PROVIDERS = ["FastPay", "CheapPay", "SafePay", "GlobalPay"];

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log(`Deploying RouteFiEscrow to "${network.name}" (chain ${chainId}) from ${deployer.address}...`);

  const providerIds = PROVIDERS.map((name) => ethers.encodeBytes32String(name));
  const escrow = await ethers.deployContract("RouteFiEscrow", [providerIds]);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log(`RouteFiEscrow deployed at ${address}`);
  console.log(`Registered providers: ${PROVIDERS.join(", ")}`);

  // The in-memory "hardhat" network disappears when this script exits, so an address from it
  // would be useless (and misleading) to the frontend.
  if (network.name === "hardhat") {
    console.log('Skipped writing frontend config: in-memory network. Use "--network localhost".');
    return;
  }

  // The frontend reads this file to know where the contract lives and how to call it.
  const outDir = path.join(__dirname, "..", "..", "frontend", "src", "contracts");
  fs.mkdirSync(outDir, { recursive: true });
  const { abi } = await artifacts.readArtifact("RouteFiEscrow");
  fs.writeFileSync(
    path.join(outDir, "RouteFiEscrow.json"),
    JSON.stringify(
      { address, chainId: Number(chainId), network: network.name, owner: deployer.address, providers: PROVIDERS, abi },
      null,
      2
    )
  );
  console.log(`Saved address + ABI to ${path.relative(process.cwd(), outDir)}${path.sep}RouteFiEscrow.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
