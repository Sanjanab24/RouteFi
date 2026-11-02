// Audit regression tests. Numbers like (#1) refer to items in AUDIT.md.
//   [FIXED]       - the audit finding was fixed; the test proves the fix.
//   [BY DESIGN]   - intentional, documented rule; the test pins the behavior.
//   [KNOWN, P2]   - accepted limitation deferred to P2; the test documents it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ONE_ETH = ethers.parseEther("1");
const Status = { None: 0n, Pending: 1n, Settled: 2n, Refunded: 3n };
const GAS = { gasLimit: 1_000_000 }; // skip eth_estimateGas so the tx is mined at an exact timestamp
const id = (name) => ethers.encodeBytes32String(name);
const FAST = id("FastPay");
const CHEAP = id("CheapPay");
const SAFE = id("SafePay");
const GLOBAL = id("GlobalPay");

describe("Audit regressions", function () {
  async function deployFixture() {
    const [owner, payer, merchant, operator, stranger, newOwner] = await ethers.getSigners();
    const escrow = await ethers.deployContract("RouteFiEscrow", [[FAST, CHEAP, SAFE, GLOBAL]]);
    return { escrow, owner, payer, merchant, operator, stranger, newOwner };
  }

  async function pendingPaymentFixture() {
    const ctx = await deployFixture();
    await ctx.escrow.connect(ctx.payer).createPayment(ctx.merchant.address, FAST, { value: ONE_ETH });
    const deadline = await ctx.escrow.refundAvailableAt(1);
    return { ...ctx, deadline };
  }

  describe("Timeout / expiry semantics", function () {
    it("(#1) [FIXED] operator cannot settle after the deadline", async function () {
      const { escrow, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline + 100n);
      await expect(escrow.settle(1)).to.be.revertedWithCustomError(escrow, "PaymentExpired");
    });

    it("(#1) [FIXED] no race: at the deadline only the payer's refund is possible", async function () {
      const { escrow, payer, deadline } = await loadFixture(pendingPaymentFixture);
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.settle(1, GAS)).to.be.revertedWithCustomError(escrow, "PaymentExpired");
      await expect(escrow.connect(payer).claimRefund(1)).to.changeEtherBalance(payer, ONE_ETH);
    });

    it("(#2) [FIXED] operator cannot reroute after the deadline", async function () {
      const { escrow, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline + 10n);
      await expect(escrow.reroute(1, CHEAP)).to.be.revertedWithCustomError(escrow, "PaymentExpired");
    });

    it("(#25) claimRefund reverts at deadline - 1s", async function () {
      const { escrow, payer, deadline } = await loadFixture(pendingPaymentFixture);
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(escrow.connect(payer).claimRefund(1, GAS)).to.be.revertedWithCustomError(
        escrow,
        "RefundNotYetAvailable"
      );
    });

    it("(#25) settle succeeds at deadline - 1s", async function () {
      const { escrow, merchant, deadline } = await loadFixture(pendingPaymentFixture);
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(escrow.settle(1, GAS)).to.changeEtherBalance(merchant, ONE_ETH);
    });

    it("(#25) claimRefund succeeds at exactly the deadline", async function () {
      const { escrow, payer, deadline } = await loadFixture(pendingPaymentFixture);
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.connect(payer).claimRefund(1, GAS)).to.changeEtherBalance(payer, ONE_ETH);
    });

    it("(#20) [FIXED] refundAvailableAt exposes the deadline on-chain", async function () {
      const { escrow, deadline } = await loadFixture(pendingPaymentFixture);
      const p = await escrow.getPayment(1);
      expect(deadline).to.equal(p.createdAt + (await escrow.REFUND_TIMEOUT()));
    });
  });

  describe("Provider routing rules", function () {
    it("(#3) [FIXED] reroute to the SAME provider is rejected", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.reroute(1, FAST)).to.be.revertedWithCustomError(escrow, "ProviderAlreadyTried");
      expect((await escrow.getPayment(1)).attempts).to.equal(1n); // no attempt burned
    });

    it("(#4) [FIXED] a previously failed provider cannot be retried (A -> B -> A)", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await escrow.reroute(1, CHEAP);
      await expect(escrow.reroute(1, FAST)).to.be.revertedWithCustomError(escrow, "ProviderAlreadyTried");
    });

    it("(#6/#15) [FIXED] unknown providers and case variants are rejected", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      for (const name of ["TotallyMadeUpPay", "fastpay"]) {
        await expect(
          escrow.connect(payer).createPayment(merchant.address, id(name), { value: ONE_ETH })
        ).to.be.revertedWithCustomError(escrow, "ProviderUnavailable");
      }
    });

    it("(#15) [FIXED] an unavailable provider cannot be chosen", async function () {
      const { escrow, payer, merchant } = await loadFixture(pendingPaymentFixture);
      await escrow.setProviderActive(CHEAP, false);
      await expect(escrow.reroute(1, CHEAP)).to.be.revertedWithCustomError(escrow, "ProviderUnavailable");
      await expect(
        escrow.connect(payer).createPayment(merchant.address, CHEAP, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(escrow, "ProviderUnavailable");
    });

    it("(#10) [FIXED] provider IDs are fixed-size, so settle gas no longer depends on caller input", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      await escrow.connect(payer).createPayment(merchant.address, FAST, { value: ONE_ETH });
      await escrow.connect(payer).createPayment(merchant.address, GLOBAL, { value: ONE_ETH });

      const gasA = (await (await escrow.settle(1)).wait()).gasUsed;
      const gasB = (await (await escrow.settle(2)).wait()).gasUsed;
      console.log(`        settle gas: FastPay = ${gasA}, GlobalPay = ${gasB}`);
      // A caller can no longer submit a long name at all (bytes32), so settle stays bounded.
      expect(gasA).to.be.lessThan(80_000n); // was 364,141 with a 4 KB string before the fix
      expect(gasB).to.be.lessThan(80_000n);
    });
  });

  describe("Max attempts boundary (#19, #27)", function () {
    it("third provider (attempt 3) can still settle", async function () {
      const { escrow, merchant } = await loadFixture(pendingPaymentFixture);
      await escrow.reroute(1, CHEAP);
      await escrow.reroute(1, SAFE);
      expect((await escrow.getPayment(1)).attempts).to.equal(3n);
      await expect(escrow.settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
    });

    it("after max attempts, operator refund still works", async function () {
      const { escrow, payer } = await loadFixture(pendingPaymentFixture);
      await escrow.reroute(1, CHEAP);
      await escrow.reroute(1, SAFE);
      await expect(escrow.reroute(1, GLOBAL)).to.be.revertedWithCustomError(escrow, "TooManyAttempts");
      await expect(escrow.refund(1, "all providers failed")).to.changeEtherBalance(payer, ONE_ETH);
    });

    it("(#19) [BY DESIGN] after max attempts nothing auto-refunds; payer can claim after the deadline", async function () {
      const { escrow, payer, deadline } = await loadFixture(pendingPaymentFixture);
      await escrow.reroute(1, CHEAP);
      await escrow.reroute(1, SAFE);
      expect((await escrow.getPayment(1)).status).to.equal(Status.Pending);
      await time.increaseTo(deadline);
      await expect(escrow.connect(payer).claimRefund(1)).to.changeEtherBalance(payer, ONE_ETH);
    });
  });

  describe("Operator / owner privileges", function () {
    it("(#5/#17) [BY DESIGN] operator may refund at any time", async function () {
      const { escrow, payer } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.refund(1, "")).to.changeEtherBalance(payer, ONE_ETH);
    });

    it("(#17) [BY DESIGN] payer cannot cancel before the deadline", async function () {
      const { escrow, payer } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.connect(payer).refund(1, "changed my mind")).to.be.revertedWithCustomError(
        escrow,
        "NotOperator"
      );
    });

    it("(#8) [FIXED] zero address cannot be set as an operator", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.setOperator(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        escrow,
        "InvalidOperator"
      );
    });

    it("(#26) [FIXED] ownership transfer requires acceptance - a typo'd address cannot take over", async function () {
      const { escrow, owner, newOwner, stranger } = await loadFixture(deployFixture);
      await escrow.transferOwnership(newOwner.address);
      await expect(escrow.connect(stranger).acceptOwnership()).to.be.revertedWithCustomError(
        escrow,
        "OwnableUnauthorizedAccount"
      );
      expect(await escrow.owner()).to.equal(owner.address);
    });

    it("(#26) without an explicit operator flag, old owner loses rights once the new owner accepts", async function () {
      const { escrow, owner, newOwner, merchant } = await loadFixture(pendingPaymentFixture);
      await escrow.transferOwnership(newOwner.address);
      await escrow.connect(newOwner).acceptOwnership();
      await expect(escrow.connect(owner).settle(1)).to.be.revertedWithCustomError(escrow, "NotOperator");
      await expect(escrow.connect(newOwner).settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
    });

    it("(#26) [KNOWN, P2] an old owner that was ALSO an explicit operator keeps operator rights", async function () {
      const { escrow, owner, newOwner, merchant } = await loadFixture(pendingPaymentFixture);
      await escrow.setOperator(owner.address, true);
      await escrow.transferOwnership(newOwner.address);
      await escrow.connect(newOwner).acceptOwnership();
      await expect(escrow.connect(owner).settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
    });

    it("(#26) [BY DESIGN] operators survive an ownership transfer; new owner can revoke them", async function () {
      const { escrow, operator, newOwner } = await loadFixture(pendingPaymentFixture);
      await escrow.setOperator(operator.address, true);
      await escrow.transferOwnership(newOwner.address);
      await escrow.connect(newOwner).acceptOwnership();
      expect(await escrow.operators(operator.address)).to.equal(true);
      await escrow.connect(newOwner).setOperator(operator.address, false);
      await expect(escrow.connect(operator).settle(1)).to.be.revertedWithCustomError(escrow, "NotOperator");
    });

    it("(#16) [FIXED] renounceOwnership is disabled", async function () {
      const { escrow, owner } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.renounceOwnership()).to.be.revertedWithCustomError(escrow, "RenounceDisabled");
      expect(await escrow.owner()).to.equal(owner.address);
    });

    it("operator cannot redirect funds - settle always pays the merchant fixed at creation", async function () {
      const { escrow, operator, merchant } = await loadFixture(pendingPaymentFixture);
      await escrow.setOperator(operator.address, true);
      await expect(escrow.connect(operator).settle(1)).to.changeEtherBalances(
        [operator, merchant],
        [0n, ONE_ETH] // gas fees are excluded by default
      );
    });
  });

  describe("Input validation", function () {
    it("(#9) every state-changing function rejects a nonexistent payment ID", async function () {
      const { escrow, payer } = await loadFixture(deployFixture);
      await expect(escrow.reroute(99, CHEAP)).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
      await expect(escrow.refund(99, "x")).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
      await expect(escrow.connect(payer).claimRefund(99)).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
      await expect(escrow.settle(0)).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
      expect((await escrow.getPayment(99)).status).to.equal(Status.None);
      expect(await escrow.refundAvailableAt(99)).to.equal(0n);
    });

    it("(#18) [KNOWN, P2] 1-wei dust payments are accepted", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      await escrow.connect(payer).createPayment(merchant.address, FAST, { value: 1n });
      expect((await escrow.getPayment(1)).amount).to.equal(1n);
    });

    it("(extra A) [FIXED] the escrow contract itself cannot be the merchant", async function () {
      const { escrow, payer } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(payer).createPayment(await escrow.getAddress(), FAST, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(escrow, "InvalidMerchant");
    });
  });

  describe("Failed transfers & atomicity (#21, #22, #28)", function () {
    it("merchant contract that rejects ETH blocks settle; state rolls back; refund still works", async function () {
      const { escrow, payer } = await loadFixture(deployFixture);
      const badMerchant = await ethers.deployContract("RejectingParty");
      await escrow.connect(payer).createPayment(await badMerchant.getAddress(), FAST, { value: ONE_ETH });

      await expect(escrow.settle(1)).to.be.revertedWithCustomError(escrow, "TransferFailed");
      // Atomicity: status and accounting were changed inside settle(), but the revert undid both.
      expect((await escrow.getPayment(1)).status).to.equal(Status.Pending);
      expect(await escrow.escrowBalance()).to.equal(ONE_ETH);

      await expect(escrow.refund(1, "merchant rejected")).to.changeEtherBalance(payer, ONE_ETH);
    });

    it("(#21) [KNOWN, P2] payer AND merchant both reject ETH -> funds locked (self-inflicted only)", async function () {
      const { escrow } = await loadFixture(deployFixture);
      const badPayer = await ethers.deployContract("RejectingParty");
      const badMerchant = await ethers.deployContract("RejectingParty");
      const escrowAddr = await escrow.getAddress();

      await badPayer.pay(escrowAddr, await badMerchant.getAddress(), FAST, { value: ONE_ETH });
      const pid = await badPayer.lastPaymentId();

      await expect(escrow.settle(pid)).to.be.revertedWithCustomError(escrow, "TransferFailed");
      await expect(escrow.refund(pid, "x")).to.be.revertedWithCustomError(escrow, "TransferFailed");
      await time.increaseTo(await escrow.refundAvailableAt(pid));
      await expect(badPayer.claim(escrowAddr, pid)).to.be.revertedWithCustomError(escrow, "TransferFailed");

      expect((await escrow.getPayment(pid)).status).to.equal(Status.Pending);
      expect(await escrow.escrowBalance()).to.equal(ONE_ETH);
    });

    it("payer contract that rejects ETH can still be settled to a normal merchant", async function () {
      const { escrow, merchant } = await loadFixture(deployFixture);
      const badPayer = await ethers.deployContract("RejectingParty");
      await badPayer.pay(await escrow.getAddress(), merchant.address, FAST, { value: ONE_ETH });
      await expect(escrow.settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
    });
  });

  describe("Reentrancy (#23)", function () {
    it("payer contract cannot double-claim by re-entering claimRefund from receive()", async function () {
      const { escrow, merchant } = await loadFixture(deployFixture);
      const attacker = await ethers.deployContract("ReentrantPayer", [await escrow.getAddress()]);
      await attacker.pay(merchant.address, { value: ONE_ETH });
      // A second, honest payment so there is extra ETH in the contract worth stealing.
      await escrow.connect(merchant).createPayment(await attacker.getAddress(), FAST, { value: ONE_ETH });

      await time.increase(await escrow.REFUND_TIMEOUT());
      await expect(attacker.claim()).to.changeEtherBalances([attacker, escrow], [ONE_ETH, -ONE_ETH]);

      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await escrow.escrowBalance()).to.equal(ONE_ETH); // honest payment untouched
    });

    it("payer contract cannot re-enter during an operator refund either", async function () {
      const { escrow, merchant } = await loadFixture(deployFixture);
      const attacker = await ethers.deployContract("ReentrantPayer", [await escrow.getAddress()]);
      await attacker.pay(merchant.address, { value: ONE_ETH });

      await expect(escrow.refund(1, "x")).to.changeEtherBalance(attacker, ONE_ETH);
      expect(await attacker.reentrySucceeded()).to.equal(false);
    });
  });

  describe("Escrow accounting (#7, #24, #29)", function () {
    it("(#29) liabilities == sum of Pending payments == actual ETH held, across mixed outcomes", async function () {
      const { escrow, payer, merchant, stranger } = await loadFixture(deployFixture);
      const amounts = [ONE_ETH, ethers.parseEther("2"), ethers.parseEther("0.5"), ethers.parseEther("3")];
      for (const [i, value] of amounts.entries()) {
        const from = i % 2 === 0 ? payer : stranger;
        await escrow.connect(from).createPayment(merchant.address, FAST, { value });
      }
      await escrow.settle(1);
      await escrow.refund(2, "failed");
      await escrow.reroute(3, CHEAP);
      // payment 4 untouched

      let pendingSum = 0n;
      for (let pid = 1n; pid <= (await escrow.paymentCount()); pid++) {
        const p = await escrow.getPayment(pid);
        if (p.status === Status.Pending) pendingSum += p.amount;
      }
      expect(pendingSum).to.equal(ethers.parseEther("3.5"));
      expect(await escrow.escrowBalance()).to.equal(pendingSum);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(pendingSum);
      expect(await escrow.surplus()).to.equal(0n);
    });

    it("(#7/#24) direct ETH transfers are rejected (no receive function)", async function () {
      const { escrow, payer } = await loadFixture(deployFixture);
      await expect(payer.sendTransaction({ to: await escrow.getAddress(), value: ONE_ETH })).to.be.reverted;
    });

    it("(#7/#24) [FIXED] forced ETH does not inflate escrowBalance() and can be swept by the owner", async function () {
      const { escrow, owner, payer, merchant } = await loadFixture(deployFixture);
      await escrow.connect(payer).createPayment(merchant.address, FAST, { value: ONE_ETH });

      const bomb = await ethers.deployContract("ForceSend", { value: ethers.parseEther("5") });
      await bomb.boom(await escrow.getAddress());

      expect(await escrow.escrowBalance()).to.equal(ONE_ETH); // liabilities only
      expect(await escrow.surplus()).to.equal(ethers.parseEther("5"));

      // Sweep takes ONLY the surplus - the pending 1 ETH stays owed and settleable.
      await expect(escrow.sweepSurplus(owner.address))
        .to.emit(escrow, "SurplusSwept")
        .withArgs(owner.address, ethers.parseEther("5"));
      await expect(escrow.settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("(#7) sweepSurplus guards: owner only, non-zero recipient, something to sweep", async function () {
      const { escrow, owner, stranger } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.connect(stranger).sweepSurplus(stranger.address)).to.be.revertedWithCustomError(
        escrow,
        "OwnableUnauthorizedAccount"
      );
      await expect(escrow.sweepSurplus(ethers.ZeroAddress)).to.be.revertedWithCustomError(escrow, "InvalidRecipient");
      // 1 ETH is pending but there is no surplus - the owner cannot touch escrowed funds.
      await expect(escrow.sweepSurplus(owner.address)).to.be.revertedWithCustomError(escrow, "NoSurplus");
    });
  });

  describe("Gas snapshot (#30)", function () {
    it("records gas for each main action", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      const gas = async (txPromise) => (await (await txPromise).wait()).gasUsed;

      const create = await gas(escrow.connect(payer).createPayment(merchant.address, FAST, { value: ONE_ETH }));
      await escrow.connect(payer).createPayment(merchant.address, FAST, { value: ONE_ETH });
      const reroute = await gas(escrow.reroute(1, CHEAP));
      const settle = await gas(escrow.settle(1));
      const refund = await gas(escrow.refund(2, "failed"));

      console.log(`        createPayment=${create} reroute=${reroute} settle=${settle} refund=${refund}`);
      expect(create).to.be.lessThan(250_000n);
    });
  });
});
