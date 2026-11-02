// One complete RouteFi payment: route -> escrow deposit -> provider attempts -> settle / reroute / refund.
import { formatEther } from "ethers";
import { rankProviders } from "../routing/router.js";
import { simulateAttempt } from "../routing/simulator.js";
import { toId } from "./chain.js";

const MAX_ATTEMPTS = 3; // must match RouteFiEscrow.MAX_ATTEMPTS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * @param o.payerContract     contract connected to the payer's wallet
 * @param o.operatorContract  contract connected to the operator
 * @param o.getProviders      () => latest provider list (conditions keep changing while we run)
 * @param o.forceFailFirst    demo switch: make the first attempt fail to show rerouting
 * @param o.onAttempt         (name, success) => void, for observed stats
 * @param o.log               (kind, text, receipt?) => void
 */
export async function runPayment({ payerContract, operatorContract, merchant, amountWei, weights, getProviders, rng, forceFailFirst, onAttempt, log }) {
  const tried = new Set();
  const pickNext = () => rankProviders(getProviders(), weights, tried).ranked[0] ?? null;

  let route = pickNext();
  if (!route) throw new Error("No provider is available right now - wait a few seconds for an outage to end.");
  log(
    "route",
    `Routing engine chose ${route.name} (score ${route.score.toFixed(3)} · fee ${route.feePct.toFixed(2)}% · ~${Math.round(route.latencyMs)} ms · ${pct(route.failureRate)} failure)`
  );

  log("info", "Waiting for the payer to approve the escrow deposit…");
  const tx = await payerContract.createPayment(merchant, toId(route.name), { value: amountWei });
  const receipt = await tx.wait();
  const created = receipt.logs
    .map((l) => {
      try {
        return payerContract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e?.name === "PaymentCreated");
  const id = created.args.id;
  log("tx", `Payment #${id}: ${formatEther(amountWei)} ETH locked in escrow`, receipt);
  tried.add(route.name);

  for (let attempt = 1; ; attempt++) {
    const live = getProviders().find((p) => p.name === route.name);
    log("info", `Attempt ${attempt}/${MAX_ATTEMPTS}: sending through ${route.name}…`);
    const result = simulateAttempt(live, rng);
    if (forceFailFirst && attempt === 1) result.success = false;
    await sleep(Math.min(result.latencyMs, 3000)); // visible "processing" delay, capped at 3 s
    onAttempt(route.name, result.success);

    if (result.success) {
      const feeWei = (amountWei * BigInt(Math.round(live.feePct * 100))) / 10000n;
      log("ok", `${route.name} confirmed in ${Math.round(result.latencyMs)} ms (simulated fee ${formatEther(feeWei)} ETH)`);
      const r = await (await operatorContract.settle(id)).wait();
      log("tx", `Operator settled payment #${id} - ETH released to the merchant`, r);
      return { id, outcome: "settled", attempts: attempt };
    }

    log("fail", `${route.name} ${live.up ? "declined the payment" : "is in an outage"} (simulated failure)`);
    const next = attempt < MAX_ATTEMPTS ? pickNext() : null;
    if (!next) {
      const reason = attempt >= MAX_ATTEMPTS ? `all ${MAX_ATTEMPTS} attempts failed` : "no other provider available";
      const r = await (await operatorContract.refund(id, reason)).wait();
      log("tx", `Operator refunded payment #${id} to the payer (${reason})`, r);
      return { id, outcome: "refunded", attempts: attempt };
    }

    const r = await (await operatorContract.reroute(id, toId(next.name))).wait();
    log("tx", `Operator rerouted payment #${id}: ${route.name} → ${next.name}`, r);
    route = next;
    tried.add(next.name);
  }
}
