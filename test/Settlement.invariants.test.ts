import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Regression tests for the settlement and pricing bugs found in the 2026-09-01 audit.
 *
 * Each block below fails against the pre-audit contract. The existing V2 suite passed
 * throughout because it only ever exercised a single winner, never called sellShares or
 * claimRefund, and never asserted a share count or drove q/b far enough to matter.
 */
describe("Settlement invariants", function () {
  async function fixture() {
    const [owner, treasury, oracle, alice, bob, carol] = await ethers.getSigners();

    const ViralityMarketV2 = await ethers.getContractFactory("ViralityMarketV2");
    const market = await ViralityMarketV2.deploy(
      treasury.address,
      oracle.address,
      ethers.ZeroAddress // native settlement
    );

    const KEEPER_ROLE = await market.KEEPER_ROLE();
    await market.grantRole(KEEPER_ROLE, owner.address);

    return { market, owner, treasury, oracle, alice, bob, carol };
  }

  async function createMarket(market: any, signer: any, seed: bigint) {
    const now = await time.latest();
    const startTime = now + 60;
    const params = {
      postUrl: "https://twitter.com/test/status/123",
      platform: 0,
      metricType: 0,
      threshold: 10_000n,
      startTime,
      endTime: startTime + 3600,
      resolutionTime: startTime + 3660,
    };
    await time.setNextBlockTimestamp(startTime);
    await market.connect(signer).createMarket(params, seed, true, { value: seed });
    return params;
  }

  // ── TZ-05 ──────────────────────────────────────────────────────────────────
  describe("claimWinnings", function () {
    it("pays out strictly in proportion to shares held, whatever the claim order", async function () {
      const { market, oracle, alice, bob, carol } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      // Equal payments, but each buy moves the LMSR price, so the three end up with
      // different share counts. That is correct — what must hold is that payout is
      // proportional to shares, independent of who claims first.
      const bet = ethers.parseEther("1");
      for (const user of [bob, carol]) {
        await market.connect(user)["buyShares(uint256,bool)"](0, true, { value: bet });
      }

      const m0 = await market.getMarket(0);
      await time.increaseTo(m0.params.endTime + 1n);
      await market.connect(oracle).resolveMarket(0, 20_000n);

      const shares: Record<string, bigint> = {};
      for (const user of [alice, bob, carol]) {
        shares[user.address] = (await market.getPosition(0, user.address)).overShares;
      }

      // Deliberately not the order they bought in.
      const ratios: bigint[] = [];
      for (const user of [carol, alice, bob]) {
        const before = await ethers.provider.getBalance(user.address);
        const tx = await market.connect(user).claimWinnings(0);
        const receipt = await tx.wait();
        const gas = receipt!.gasUsed * receipt!.gasPrice;
        const payout = (await ethers.provider.getBalance(user.address)) - before + gas;

        // Scale up before dividing so integer truncation doesn't swamp the comparison.
        ratios.push((payout * ethers.parseEther("1")) / shares[user.address]);
      }

      // Pre-fix the pool shrank per claim while the share total stayed fixed, so this
      // ratio fell with each successive claimant (100 / 66.7 / 44.4 for equal holders).
      const [first, second, third] = ratios;
      for (const r of [second, third]) {
        const diff = r > first ? r - first : first - r;
        expect(diff).to.be.lessThan(first / 10_000n); // within 0.01%
      }
    });

    it("distributes the entire settlement pool, leaving nothing stranded", async function () {
      const { market, oracle, alice, bob, carol } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      const bet = ethers.parseEther("1");
      for (const user of [bob, carol]) {
        await market.connect(user)["buyShares(uint256,bool)"](0, true, { value: bet });
      }
      // A losing position, so the pot is larger than the winners paid in.
      await market.connect(bob)["buyShares(uint256,bool)"](0, false, { value: bet });

      const m0 = await market.getMarket(0);
      await time.increaseTo(m0.params.endTime + 1n);
      await market.connect(oracle).resolveMarket(0, 20_000n);

      const resolved = await market.getMarket(0);
      const pot = resolved.state.settlementPool;
      expect(pot).to.be.greaterThan(0n);

      for (const user of [alice, bob, carol]) {
        await market.connect(user).claimWinnings(0);
      }

      // Pre-fix, roughly 30% of the pot was unreachable.
      const after = await market.getMarket(0);
      expect(after.state.poolBalance).to.be.lessThan(pot / 1000n);
    });
  });

  // ── TZ-06 ──────────────────────────────────────────────────────────────────
  describe("claimRefund", function () {
    it("keeps the contract solvent when a cancelled market is fully refunded", async function () {
      const { market, owner, alice, bob } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      await market.connect(bob)["buyShares(uint256,bool)"](0, true, { value: ethers.parseEther("2") });

      await market.connect(owner).cancelMarket(0, "post deleted");

      // Every refund must succeed — pre-fix, refunds summed to more than the pool held
      // and the last claimant was left short.
      await market.connect(alice).claimRefund(0);
      await market.connect(bob).claimRefund(0);

      const after = await market.getMarket(0);
      expect(after.state.poolBalance).to.be.lessThan(ethers.parseEther("0.001"));
    });

    it("reports the previous status when a market is cancelled", async function () {
      const { market, owner, alice } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      // Pre-fix this emitted CANCELLED -> CANCELLED because oldStatus was read after
      // the assignment.
      await expect(market.connect(owner).cancelMarket(0, "spam"))
        .to.emit(market, "MarketStatusChanged")
        .withArgs(0, 1 /* ACTIVE */, 4 /* CANCELLED */);
    });
  });

  // ── TZ-23 ──────────────────────────────────────────────────────────────────
  describe("sellShares", function () {
    it("keeps working after enough fee accrual to underflow the old pool accounting", async function () {
      const { market, alice, bob } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      const bet = ethers.parseEther("1");
      for (let i = 0; i < 8; i++) {
        await market.connect(bob)["buyShares(uint256,bool)"](0, true, { value: bet });
        const pos = await market.getPosition(0, bob.address);
        // Sell most of it back, so fees accumulate against the pool each round.
        await market.connect(bob)["sellShares(uint256,uint256,bool)"](
          0,
          (pos.overShares * 90n) / 100n,
          true
        );
      }

      const state = (await market.getMarket(0)).state;
      expect(state.poolBalance).to.be.greaterThanOrEqual(state.feesCollected);
    });

    it("reduces cost basis on sell so a round trip cannot be refunded twice", async function () {
      const { market, owner, alice, bob } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      await market.connect(bob)["buyShares(uint256,bool)"](0, true, { value: ethers.parseEther("1") });
      const pos = await market.getPosition(0, bob.address);
      await market.connect(bob)["sellShares(uint256,uint256,bool)"](0, pos.overShares, true);

      // Bob exited completely, so there is nothing left to refund. Pre-fix his cost
      // basis was untouched by the sell and he could claim the full original stake.
      await market.connect(owner).cancelMarket(0, "test");
      await expect(market.connect(bob).claimRefund(0)).to.be.revertedWith("Nothing to refund");
    });
  });

  // ── TZ-16 ──────────────────────────────────────────────────────────────────
  describe("share pricing", function () {
    it("delivers more than 2x payment in shares when the outcome trades below 0.50", async function () {
      const { market, alice, bob } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      // Push OVER well above 0.5, so UNDER becomes the cheap side.
      await market.connect(alice)["buyShares(uint256,bool)"](0, true, { value: ethers.parseEther("50") });

      const [priceOver] = await market.getPrices(0);
      expect(priceOver).to.be.greaterThan(ethers.parseEther("0.6"));

      const payment = ethers.parseEther("1");
      const shares = await market.quoteSharesForPayment(0, payment, false);

      // The old binary search capped at payment*2 regardless of price, silently
      // short-changing anyone buying the cheaper side.
      expect(shares).to.be.greaterThan(payment * 2n);
    });
  });

  // ── TZ-18 ──────────────────────────────────────────────────────────────────
  describe("price reads", function () {
    it("stays readable and tradeable at extreme one-sided volume", async function () {
      const { market, alice } = await loadFixture(fixture);
      // Minimum seed produces the smallest permitted liquidity parameter.
      await createMarket(market, alice, ethers.parseEther("0.001"));

      // Drive q/b far past the old exp() ceiling of 130.
      for (let i = 0; i < 6; i++) {
        await market.connect(alice)["buyShares(uint256,bool)"](0, true, {
          value: ethers.parseEther("100"),
        });
      }

      // Pre-fix every one of these reverted with "exp: overflow", freezing the market.
      const [priceOver, priceUnder] = await market.getPrices(0);
      expect(priceOver + priceUnder).to.equal(ethers.parseEther("1"));
      expect(await market.quoteSharesForPayment(0, ethers.parseEther("1"), true)).to.be.greaterThan(0n);
    });
  });

  // ── TZ-21 / TZ-37 ──────────────────────────────────────────────────────────
  describe("trade safety", function () {
    it("reverts a buy that would fill below minSharesOut", async function () {
      const { market, alice } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      const payment = ethers.parseEther("1");
      const expected = await market.quoteSharesForPayment(0, payment, true);
      const deadline = (await time.latest()) + 600;

      await expect(
        market.connect(alice)["buyShares(uint256,bool,uint256,uint256,uint256)"](
          0, true, payment, expected * 2n, deadline, { value: payment }
        )
      ).to.be.revertedWith("Slippage: too few shares");
    });

    it("reverts a buy past its deadline", async function () {
      const { market, alice } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));

      const payment = ethers.parseEther("1");
      const past = (await time.latest()) - 1;

      await expect(
        market.connect(alice)["buyShares(uint256,bool,uint256,uint256,uint256)"](
          0, true, payment, 0, past, { value: payment }
        )
      ).to.be.revertedWith("Transaction expired");
    });

    it("refunds native change sent above the seed bet", async function () {
      const { market, alice } = await loadFixture(fixture);
      const now = await time.latest();
      const startTime = now + 60;
      const params = {
        postUrl: "https://twitter.com/test/status/1",
        platform: 0, metricType: 0, threshold: 10_000n,
        startTime, endTime: startTime + 3600, resolutionTime: startTime + 3660,
      };

      const seed = ethers.parseEther("1");
      const sent = ethers.parseEther("3");

      await time.setNextBlockTimestamp(startTime);
      const before = await ethers.provider.getBalance(alice.address);
      const tx = await market.connect(alice).createMarket(params, seed, true, { value: sent });
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const spent = before - (await ethers.provider.getBalance(alice.address)) - gas;

      // Pre-fix the full 3 ETH was absorbed into the market.
      expect(spent).to.equal(seed);
    });

    it("rejects a seed bet below the minimum", async function () {
      const { market, alice } = await loadFixture(fixture);
      const now = await time.latest();
      const startTime = now + 60;
      const params = {
        postUrl: "https://twitter.com/test/status/1",
        platform: 0, metricType: 0, threshold: 10_000n,
        startTime, endTime: startTime + 3600, resolutionTime: startTime + 3660,
      };
      const dust = 1n; // far below MIN_BET_AMOUNT_NATIVE

      await time.setNextBlockTimestamp(startTime);
      await expect(
        market.connect(alice).createMarket(params, dust, true, { value: dust })
      ).to.be.revertedWith("Bet too small");
    });
  });

  // ── View guards ────────────────────────────────────────────────────────────
  describe("view guards", function () {
    it("gives a clear error for a market that does not exist", async function () {
      const { market } = await loadFixture(fixture);
      await expect(market.getPrices(99)).to.be.revertedWith("Market does not exist");
    });
  });

  // ── Fee withdrawal ─────────────────────────────────────────────────────────
  describe("fee withdrawal", function () {
    it("credits fees for pull withdrawal instead of pushing them", async function () {
      const { market, oracle, treasury, alice } = await loadFixture(fixture);
      await createMarket(market, alice, ethers.parseEther("10"));
      await market.connect(alice)["buyShares(uint256,bool)"](0, true, { value: ethers.parseEther("1") });

      const m0 = await market.getMarket(0);
      await time.increaseTo(m0.params.endTime + 1n);
      await market.connect(oracle).resolveMarket(0, 20_000n);

      const owed = await market.pendingWithdrawals(treasury.address);
      expect(owed).to.be.greaterThan(0n);

      const before = await ethers.provider.getBalance(treasury.address);
      await market.connect(treasury).withdraw();
      expect(await ethers.provider.getBalance(treasury.address)).to.be.greaterThan(before);
    });
  });
});
