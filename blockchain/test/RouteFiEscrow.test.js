const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const ONE_ETH = ethers.parseEther("1");
const Status = { None: 0n, Pending: 1n, Settled: 2n, Refunded: 3n };
const id = (name) => ethers.encodeBytes32String(name); // provider name -> bytes32 ID
const FAST = id("FastPay");
const CHEAP = id("CheapPay");
const SAFE = id("SafePay");
const GLOBAL = id("GlobalPay");

describe("RouteFiEscrow", function () {
  // Fresh contract + named test accounts for every test.
  async function deployFixture() {
    const [owner, payer, merchant, operator, stranger] = await ethers.getSigners();
    const escrow = await ethers.deployContract("RouteFiEscrow", [[FAST, CHEAP, SAFE, GLOBAL]]);
    return { escrow, owner, payer, merchant, operator, stranger };
  }

  // Deploy and create one pending 1 ETH payment (ID 1) via FastPay.
  async function pendingPaymentFixture() {
    const ctx = await deployFixture();
    await ctx.escrow.connect(ctx.payer).createPayment(ctx.merchant.address, FAST, { value: ONE_ETH });
    const deadline = await ctx.escrow.refundAvailableAt(1);
    return { ...ctx, deadline };
  }

  describe("Deployment", function () {
    it("makes the deployer the owner and registers the initial providers", async function () {
      const { escrow, owner } = await loadFixture(deployFixture);
      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.paymentCount()).to.equal(0n);

      const [ids, active] = await escrow.getProviders();
      expect(ids).to.deep.equal([FAST, CHEAP, SAFE, GLOBAL]);
      expect(active).to.deep.equal([true, true, true, true]);
    });

    it("rejects duplicate or empty provider IDs at deployment", async function () {
      const Escrow = await ethers.getContractFactory("RouteFiEscrow");
      await expect(ethers.deployContract("RouteFiEscrow", [[FAST, FAST]])).to.be.revertedWithCustomError(
        Escrow,
        "ProviderAlreadyRegistered"
      );
      await expect(ethers.deployContract("RouteFiEscrow", [[ethers.ZeroHash]])).to.be.revertedWithCustomError(
        Escrow,
        "InvalidProvider"
      );
    });
  });

  describe("createPayment", function () {
    it("locks ETH in escrow and records the payment", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);

      await expect(escrow.connect(payer).createPayment(merchant.address, FAST, { value: ONE_ETH }))
        .to.emit(escrow, "PaymentCreated")
        .withArgs(1n, payer.address, merchant.address, ONE_ETH, FAST);

      const p = await escrow.getPayment(1);
      expect(p.payer).to.equal(payer.address);
      expect(p.merchant).to.equal(merchant.address);
      expect(p.amount).to.equal(ONE_ETH);
      expect(p.provider).to.equal(FAST);
      expect(ethers.decodeBytes32String(p.provider)).to.equal("FastPay");
      expect(p.attempts).to.equal(1n);
      expect(p.status).to.equal(Status.Pending);
      expect(await escrow.escrowBalance()).to.equal(ONE_ETH);
      expect(await escrow.wasTried(1, FAST)).to.equal(true);
    });

    it("rejects a zero-value payment", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      await expect(
        escrow.connect(payer).createPayment(merchant.address, FAST, { value: 0 })
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    });

    it("rejects the zero address, paying yourself, or the escrow contract as merchant", async function () {
      const { escrow, payer } = await loadFixture(deployFixture);
      for (const bad of [ethers.ZeroAddress, payer.address, await escrow.getAddress()]) {
        await expect(
          escrow.connect(payer).createPayment(bad, FAST, { value: ONE_ETH })
        ).to.be.revertedWithCustomError(escrow, "InvalidMerchant");
      }
    });

    it("rejects an unregistered provider", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      await expect(escrow.connect(payer).createPayment(merchant.address, id("MadeUpPay"), { value: ONE_ETH }))
        .to.be.revertedWithCustomError(escrow, "ProviderUnavailable")
        .withArgs(id("MadeUpPay"));
    });

    it("rejects a registered but inactive provider", async function () {
      const { escrow, payer, merchant } = await loadFixture(deployFixture);
      await escrow.setProviderActive(FAST, false);
      await expect(
        escrow.connect(payer).createPayment(merchant.address, FAST, { value: ONE_ETH })
      ).to.be.revertedWithCustomError(escrow, "ProviderUnavailable");
    });
  });

  describe("settle", function () {
    it("releases escrowed ETH to the merchant", async function () {
      const { escrow, merchant } = await loadFixture(pendingPaymentFixture);

      const tx = escrow.settle(1);
      await expect(tx).to.emit(escrow, "PaymentSettled").withArgs(1n, merchant.address, ONE_ETH, FAST);
      await expect(tx).to.changeEtherBalances([escrow, merchant], [-ONE_ETH, ONE_ETH]);
      expect((await escrow.getPayment(1)).status).to.equal(Status.Settled);
      expect(await escrow.escrowBalance()).to.equal(0n);
    });

    it("cannot be called by a non-operator", async function () {
      const { escrow, stranger, payer } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.connect(stranger).settle(1)).to.be.revertedWithCustomError(escrow, "NotOperator");
      // Not even the payer can release funds.
      await expect(escrow.connect(payer).settle(1)).to.be.revertedWithCustomError(escrow, "NotOperator");
    });

    it("cannot settle the same payment twice", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await escrow.settle(1);
      await expect(escrow.settle(1)).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
    });

    it("cannot settle a payment that does not exist", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.settle(99)).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
    });

    it("cannot settle an expired payment", async function () {
      const { escrow, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline);
      await expect(escrow.settle(1)).to.be.revertedWithCustomError(escrow, "PaymentExpired");
    });
  });

  describe("reroute (failure recovery)", function () {
    it("switches provider and keeps ETH locked", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);

      await expect(escrow.reroute(1, CHEAP)).to.emit(escrow, "PaymentRerouted").withArgs(1n, FAST, CHEAP, 2n);

      const p = await escrow.getPayment(1);
      expect(p.provider).to.equal(CHEAP);
      expect(p.attempts).to.equal(2n);
      expect(p.status).to.equal(Status.Pending);
      expect(await escrow.escrowBalance()).to.equal(ONE_ETH);
      expect(await escrow.wasTried(1, CHEAP)).to.equal(true);
    });

    it("stops after MAX_ATTEMPTS providers", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await escrow.reroute(1, CHEAP); // attempt 2
      await escrow.reroute(1, SAFE); // attempt 3
      await expect(escrow.reroute(1, GLOBAL)).to.be.revertedWithCustomError(escrow, "TooManyAttempts");
    });

    it("rejects the current or a previously tried provider", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.reroute(1, FAST))
        .to.be.revertedWithCustomError(escrow, "ProviderAlreadyTried")
        .withArgs(FAST);
      await escrow.reroute(1, CHEAP);
      await expect(escrow.reroute(1, FAST)).to.be.revertedWithCustomError(escrow, "ProviderAlreadyTried");
    });

    it("rejects an unregistered or inactive provider", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.reroute(1, id("MadeUpPay"))).to.be.revertedWithCustomError(escrow, "ProviderUnavailable");
      await escrow.setProviderActive(CHEAP, false);
      await expect(escrow.reroute(1, CHEAP)).to.be.revertedWithCustomError(escrow, "ProviderUnavailable");
    });

    it("cannot reroute an expired payment", async function () {
      const { escrow, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline);
      await expect(escrow.reroute(1, CHEAP)).to.be.revertedWithCustomError(escrow, "PaymentExpired");
    });

    it("cannot be called by a non-operator", async function () {
      const { escrow, stranger } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.connect(stranger).reroute(1, CHEAP)).to.be.revertedWithCustomError(escrow, "NotOperator");
    });
  });

  describe("refund", function () {
    it("operator refund returns ETH to the payer", async function () {
      const { escrow, payer } = await loadFixture(pendingPaymentFixture);

      const tx = escrow.refund(1, "all providers failed");
      await expect(tx)
        .to.emit(escrow, "PaymentRefunded")
        .withArgs(1n, payer.address, ONE_ETH, "all providers failed");
      await expect(tx).to.changeEtherBalances([escrow, payer], [-ONE_ETH, ONE_ETH]);
      expect((await escrow.getPayment(1)).status).to.equal(Status.Refunded);
      expect(await escrow.escrowBalance()).to.equal(0n);
    });

    it("operator can still refund after expiry", async function () {
      const { escrow, payer, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline + 100n);
      await expect(escrow.refund(1, "expired")).to.changeEtherBalance(payer, ONE_ETH);
    });

    it("a refunded payment cannot then be settled", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      await escrow.refund(1, "cancelled");
      await expect(escrow.settle(1)).to.be.revertedWithCustomError(escrow, "PaymentNotPending");
    });
  });

  describe("claimRefund (payer safety net)", function () {
    it("is blocked before the deadline", async function () {
      const { escrow, payer } = await loadFixture(pendingPaymentFixture);
      await expect(escrow.connect(payer).claimRefund(1)).to.be.revertedWithCustomError(
        escrow,
        "RefundNotYetAvailable"
      );
    });

    it("lets the payer reclaim ETH after the deadline", async function () {
      const { escrow, payer, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline);

      const tx = escrow.connect(payer).claimRefund(1);
      await expect(tx).to.emit(escrow, "PaymentRefunded").withArgs(1n, payer.address, ONE_ETH, "timeout");
      await expect(tx).to.changeEtherBalances([escrow, payer], [-ONE_ETH, ONE_ETH]);
    });

    it("only the payer can claim", async function () {
      const { escrow, stranger, deadline } = await loadFixture(pendingPaymentFixture);
      await time.increaseTo(deadline);
      await expect(escrow.connect(stranger).claimRefund(1)).to.be.revertedWithCustomError(escrow, "NotPayer");
    });

    it("refundAvailableAt reports createdAt + REFUND_TIMEOUT, or 0 for unknown IDs", async function () {
      const { escrow } = await loadFixture(pendingPaymentFixture);
      const p = await escrow.getPayment(1);
      expect(await escrow.refundAvailableAt(1)).to.equal(p.createdAt + (await escrow.REFUND_TIMEOUT()));
      expect(await escrow.refundAvailableAt(99)).to.equal(0n);
    });
  });

  describe("Provider registry", function () {
    it("owner can add a provider; duplicates rejected", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.addProvider(id("NewPay"))).to.emit(escrow, "ProviderAdded").withArgs(id("NewPay"));
      expect(await escrow.providerActive(id("NewPay"))).to.equal(true);
      await expect(escrow.addProvider(id("NewPay"))).to.be.revertedWithCustomError(escrow, "ProviderAlreadyRegistered");
    });

    it("non-owner cannot add providers", async function () {
      const { escrow, operator } = await loadFixture(deployFixture);
      await escrow.setOperator(operator.address, true);
      await expect(escrow.connect(operator).addProvider(id("NewPay"))).to.be.revertedWithCustomError(
        escrow,
        "OwnableUnauthorizedAccount"
      );
    });

    it("operator can toggle provider availability; strangers and unknown IDs rejected", async function () {
      const { escrow, operator, stranger } = await loadFixture(deployFixture);
      await escrow.setOperator(operator.address, true);

      await expect(escrow.connect(operator).setProviderActive(SAFE, false))
        .to.emit(escrow, "ProviderStatusChanged")
        .withArgs(SAFE, false);
      const [, active] = await escrow.getProviders();
      expect(active).to.deep.equal([true, true, false, true]);

      await expect(escrow.connect(stranger).setProviderActive(SAFE, true)).to.be.revertedWithCustomError(
        escrow,
        "NotOperator"
      );
      await expect(escrow.setProviderActive(id("MadeUpPay"), true)).to.be.revertedWithCustomError(
        escrow,
        "InvalidProvider"
      );
    });

    it("deactivating a provider does not block settling a payment already on it", async function () {
      const { escrow, merchant } = await loadFixture(pendingPaymentFixture);
      await escrow.setProviderActive(FAST, false);
      await expect(escrow.settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
    });
  });

  describe("Access control", function () {
    it("owner can add an operator who can then settle", async function () {
      const { escrow, operator, merchant } = await loadFixture(pendingPaymentFixture);

      await expect(escrow.setOperator(operator.address, true))
        .to.emit(escrow, "OperatorUpdated")
        .withArgs(operator.address, true);

      await expect(escrow.connect(operator).settle(1)).to.changeEtherBalance(merchant, ONE_ETH);
    });

    it("removed operator loses access", async function () {
      const { escrow, operator } = await loadFixture(pendingPaymentFixture);
      await escrow.setOperator(operator.address, true);
      await escrow.setOperator(operator.address, false);
      await expect(escrow.connect(operator).settle(1)).to.be.revertedWithCustomError(escrow, "NotOperator");
    });

    it("non-owner cannot add operators", async function () {
      const { escrow, stranger } = await loadFixture(deployFixture);
      await expect(escrow.connect(stranger).setOperator(stranger.address, true)).to.be.revertedWithCustomError(
        escrow,
        "OwnableUnauthorizedAccount"
      );
    });

    it("rejects the zero address as operator", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.setOperator(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(
        escrow,
        "InvalidOperator"
      );
    });

    it("ownership transfer is two-step: new owner must accept", async function () {
      const { escrow, owner, stranger: newOwner } = await loadFixture(deployFixture);
      await escrow.transferOwnership(newOwner.address);
      expect(await escrow.owner()).to.equal(owner.address); // not yet transferred
      expect(await escrow.pendingOwner()).to.equal(newOwner.address);

      await escrow.connect(newOwner).acceptOwnership();
      expect(await escrow.owner()).to.equal(newOwner.address);
    });

    it("renounceOwnership is disabled", async function () {
      const { escrow } = await loadFixture(deployFixture);
      await expect(escrow.renounceOwnership()).to.be.revertedWithCustomError(escrow, "RenounceDisabled");
    });
  });
});
