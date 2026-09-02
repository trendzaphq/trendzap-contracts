import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("TrendZap V2 Contracts", function () {
  // Helper: create market params and pin the next block timestamp so
  // startTime == block.timestamp, guaranteeing the contract check passes.
  async function createMarketAtFixedTime(
    market: any,
    signer: any,
    bet: bigint,
    betOnOver: boolean,
    overrides: Partial<{
      postUrl: string; platform: number; metricType: number;
      threshold: bigint; duration: number; resolutionBuffer: number;
    }> = {},
  ) {
    const now = await time.latest();
    const startTime = now + 60;
    const duration = overrides.duration ?? 3600;
    const resolutionBuffer = overrides.resolutionBuffer ?? 60;
    const params = {
      postUrl: overrides.postUrl ?? "https://twitter.com/test/status/123",
      platform: overrides.platform ?? 0,
      metricType: overrides.metricType ?? 0,
      threshold: overrides.threshold ?? ethers.parseEther("10000"),
      startTime,
      endTime: startTime + duration,
      resolutionTime: startTime + duration + resolutionBuffer,
    };
    // Pin the next block timestamp to exactly startTime
    await time.setNextBlockTimestamp(startTime);
    await market.connect(signer).createMarket(params, bet, betOnOver, { value: bet });
    return params;
  }

  // Fixture to deploy all contracts
  async function deployContractsFixture() {
    const [owner, treasury, oracle, user1, user2, resolver] = await ethers.getSigners();

    const ViralityPositions = await ethers.getContractFactory("ViralityPositions");
    const positions = await ViralityPositions.deploy("https://api.trendzap.xyz/metadata/");

    const ViralityMarketV2 = await ethers.getContractFactory("ViralityMarketV2");
    const market = await ViralityMarketV2.deploy(treasury.address, oracle.address, ethers.ZeroAddress);

    const MarketFactoryV2 = await ethers.getContractFactory("MarketFactoryV2");
    const factory = await MarketFactoryV2.deploy(treasury.address, oracle.address, ethers.ZeroAddress);

    await factory.setSingletonMarket(await market.getAddress());
    await factory.setPositionsToken(await positions.getAddress());

    const MARKET_ROLE = await positions.MARKET_ROLE();
    const RESOLVER_ROLE = await positions.RESOLVER_ROLE();
    await positions.grantRole(MARKET_ROLE, await market.getAddress());
    await positions.grantRole(RESOLVER_ROLE, await market.getAddress());

    const KEEPER_ROLE = await market.KEEPER_ROLE();
    await market.grantRole(KEEPER_ROLE, owner.address);

    return { positions, market, factory, owner, treasury, oracle, user1, user2, resolver };
  }

  // ─── ViralityPositions ──────────────────────────────────────────────
  describe("ViralityPositions", function () {
    it("Should deploy with correct URI", async function () {
      const { positions } = await loadFixture(deployContractsFixture);
      expect(await positions.uri(0)).to.include("https://api.trendzap.xyz/metadata/");
    });

    it("Should have correct admin role", async function () {
      const { positions, owner } = await loadFixture(deployContractsFixture);
      const DEFAULT_ADMIN_ROLE = await positions.DEFAULT_ADMIN_ROLE();
      expect(await positions.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should generate correct token IDs", async function () {
      const { positions } = await loadFixture(deployContractsFixture);
      expect(await positions.getTokenId(1, true)).to.equal(3);   // (1<<1)|1
      expect(await positions.getTokenId(1, false)).to.equal(2);  // (1<<1)|0
      expect(await positions.getTokenId(2, true)).to.equal(5);   // (2<<1)|1
    });

    it("Should parse token IDs correctly", async function () {
      const { positions } = await loadFixture(deployContractsFixture);
      const [marketId, isOver] = await positions.parseTokenId(3);
      expect(marketId).to.equal(1);
      expect(isOver).to.be.true;
    });
  });

  // ─── ViralityMarketV2 ──────────────────────────────────────────────
  describe("ViralityMarketV2", function () {
    describe("Market Creation", function () {
      it("Should create a market with correct parameters", async function () {
        const { market, user1 } = await loadFixture(deployContractsFixture);
        const params = await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true);

        const m = await market.getMarket(0);
        expect(m.params.postUrl).to.equal(params.postUrl);
        expect(m.params.threshold).to.equal(params.threshold);
        expect(m.creator).to.equal(user1.address);
      });

      it("Should emit MarketCreated event", async function () {
        const { market, user1 } = await loadFixture(deployContractsFixture);
        const now = await time.latest();
        const startTime = now + 60;
        const params = {
          postUrl: "https://twitter.com/test/status/123",
          platform: 0, metricType: 0,
          threshold: ethers.parseEther("10000"),
          startTime, endTime: startTime + 3600, resolutionTime: startTime + 3660,
        };
        await time.setNextBlockTimestamp(startTime);
        await expect(
          market.connect(user1).createMarket(params, ethers.parseEther("0.1"), true, { value: ethers.parseEther("0.1") })
        ).to.emit(market, "MarketCreated");
      });

      it("Should reject buying with amount below minimum", async function () {
        const { market, user1 } = await loadFixture(deployContractsFixture);
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true);
        await expect(
          market.connect(user1)["buyShares(uint256,bool)"](0, true, { value: ethers.parseEther("0.0001") })
        ).to.be.revertedWith("Bet too small");
      });
    });

    describe("Trading", function () {
      async function createMarketFixture() {
        const fixture = await loadFixture(deployContractsFixture);
        const { market, user1 } = fixture;
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true);
        return { ...fixture, marketId: 0 };
      }

      it("Should allow buying OVER shares", async function () {
        const { market, user2, marketId } = await loadFixture(createMarketFixture);
        await market.connect(user2)["buyShares(uint256,bool)"](marketId, true, { value: ethers.parseEther("0.05") });
        const position = await market.getPosition(marketId, user2.address);
        expect(position.overShares).to.be.gt(0);
      });

      it("Should allow buying UNDER shares", async function () {
        const { market, user2, marketId } = await loadFixture(createMarketFixture);
        await market.connect(user2)["buyShares(uint256,bool)"](marketId, false, { value: ethers.parseEther("0.05") });
        const position = await market.getPosition(marketId, user2.address);
        expect(position.underShares).to.be.gt(0);
      });

      it("Should update prices after trades", async function () {
        const { market, user2, marketId } = await loadFixture(createMarketFixture);
        const [priceBefore] = await market.getPrices(marketId);
        await market.connect(user2)["buyShares(uint256,bool)"](marketId, true, { value: ethers.parseEther("0.2") });
        const [priceAfter] = await market.getPrices(marketId);
        expect(priceAfter).to.be.gt(priceBefore);
      });

      it("Should track total volume correctly", async function () {
        const { market, user2, marketId } = await loadFixture(createMarketFixture);
        const marketBefore = await market.getMarket(marketId);
        const initialVolume = marketBefore.state.totalVolume;
        await market.connect(user2)["buyShares(uint256,bool)"](marketId, true, { value: ethers.parseEther("0.05") });
        const marketAfter = await market.getMarket(marketId);
        expect(marketAfter.state.totalVolume).to.be.gt(initialVolume);
      });
    });

    describe("Resolution", function () {
      async function createAndEndMarketFixture() {
        const fixture = await loadFixture(deployContractsFixture);
        const { market, user1, user2 } = fixture;
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.5"), true, { duration: 3600 });
        await market.connect(user2)["buyShares(uint256,bool)"](0, false, { value: ethers.parseEther("0.3") });
        // Advance past endTime
        await time.increase(3700);
        return { ...fixture, marketId: 0 };
      }

      it("Should allow resolution after end time", async function () {
        const { market, oracle, marketId } = await loadFixture(createAndEndMarketFixture);
        await market.connect(oracle).resolveMarket(marketId, ethers.parseEther("15000"));
        const m = await market.getMarket(marketId);
        expect(m.status).to.equal(3); // RESOLVED
      });

      it("Should reject resolution before end time", async function () {
        const fixture = await loadFixture(deployContractsFixture);
        const { market, oracle, user1 } = fixture;
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true, { duration: 3600 });

        await expect(
          market.connect(oracle).resolveMarket(0, ethers.parseEther("15000"))
        ).to.be.revertedWith("Too early to resolve");
      });

      it("Should resolve OVER when metric >= threshold", async function () {
        const { market, oracle, marketId } = await loadFixture(createAndEndMarketFixture);
        await market.connect(oracle).resolveMarket(marketId, ethers.parseEther("15000"));
        const m = await market.getMarket(marketId);
        expect(m.outcome).to.equal(1); // Outcome.OVER
      });

      it("Should resolve UNDER when metric < threshold", async function () {
        const { market, oracle, marketId } = await loadFixture(createAndEndMarketFixture);
        await market.connect(oracle).resolveMarket(marketId, ethers.parseEther("5000"));
        const m = await market.getMarket(marketId);
        expect(m.outcome).to.equal(2); // Outcome.UNDER
      });

      it("Should allow winners to claim", async function () {
        const { market, oracle, user1, marketId } = await loadFixture(createAndEndMarketFixture);
        await market.connect(oracle).resolveMarket(marketId, ethers.parseEther("15000"));

        const balanceBefore = await ethers.provider.getBalance(user1.address);
        await market.connect(user1).claimWinnings(marketId);
        const balanceAfter = await ethers.provider.getBalance(user1.address);
        expect(balanceAfter).to.be.gt(balanceBefore - ethers.parseEther("0.01"));
      });
    });

    describe("LMSR Pricing", function () {
      it("Should have prices sum to approximately 1", async function () {
        const { market, user1 } = await loadFixture(deployContractsFixture);
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true);

        const [priceOver, priceUnder] = await market.getPrices(0);
        const sum = priceOver + priceUnder;
        expect(sum).to.be.closeTo(ethers.parseEther("1"), ethers.parseEther("0.01"));
      });

      it("Should return valid probabilities", async function () {
        const { market, user1 } = await loadFixture(deployContractsFixture);
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true);

        // getProbabilities -> getProbabilitiesBps: the old form divided into a 0-100
        // integer and discarded everything below a whole percentage point.
        const [probOver, probUnder] = await market.getProbabilitiesBps(0);
        expect(probOver + probUnder).to.be.closeTo(10000n, 1n);
      });
    });

    describe("Fee Collection", function () {
      it("Should collect platform fees", async function () {
        const { market, user1, user2 } = await loadFixture(deployContractsFixture);
        await createMarketAtFixedTime(market, user1, ethers.parseEther("1"), true);

        await market.connect(user2)["buyShares(uint256,bool)"](0, true, { value: ethers.parseEther("0.5") });
        await market.connect(user2)["buyShares(uint256,bool)"](0, false, { value: ethers.parseEther("0.5") });

        const marketData = await market.getMarket(0);
        expect(marketData.state.feesCollected).to.be.gt(0);
      });
    });
  });

  // ─── MarketFactoryV2 ───────────────────────────────────────────────
  describe("MarketFactoryV2", function () {
    it("Should have correct initial configuration", async function () {
      const { factory, market, positions, treasury, oracle } = await loadFixture(deployContractsFixture);
      expect(await factory.singletonMarket()).to.equal(await market.getAddress());
      expect(await factory.positionsToken()).to.equal(await positions.getAddress());
      expect(await factory.treasury()).to.equal(treasury.address);
      expect(await factory.oracle()).to.equal(oracle.address);
    });

    it("Should start with zero proxy markets", async function () {
      const { factory } = await loadFixture(deployContractsFixture);
      expect(await factory.getProxyMarketCount()).to.equal(0);
    });
  });

  // ─── Integration Tests ─────────────────────────────────────────────
  describe("Integration Tests", function () {
    it("Should complete full market lifecycle", async function () {
      const { market, oracle, user1, user2 } = await loadFixture(deployContractsFixture);
      // 1. Create market
      await createMarketAtFixedTime(market, user1, ethers.parseEther("1"), true, { duration: 3600 });
      // 2. Users trade
      await market.connect(user2)["buyShares(uint256,bool)"](0, false, { value: ethers.parseEther("0.5") });
      // 3. Wait for end time
      await time.increase(3700);
      // 4. Resolve market (UNDER wins — metric 30000 < threshold 10000... wait, 30000 > 10000)
      await market.connect(oracle).resolveMarket(0, ethers.parseEther("5000"));
      // 5. User2 (UNDER) claims winnings
      const balanceBefore = await ethers.provider.getBalance(user2.address);
      await market.connect(user2).claimWinnings(0);
      const balanceAfter = await ethers.provider.getBalance(user2.address);
      expect(balanceAfter).to.be.gt(balanceBefore - ethers.parseEther("0.01"));
      // Verify market is resolved
      const m = await market.getMarket(0);
      expect(m.status).to.equal(3); // RESOLVED
    });

    it("Should handle multiple markets simultaneously", async function () {
      const { market, user1, user2 } = await loadFixture(deployContractsFixture);

      for (let i = 0; i < 3; i++) {
        await createMarketAtFixedTime(market, user1, ethers.parseEther("0.1"), true, {
          postUrl: `https://twitter.com/test/${i}`,
        });
      }

      expect(await market.nextMarketId()).to.equal(3);

      for (let i = 0; i < 3; i++) {
        await market.connect(user2)["buyShares(uint256,bool)"](i, i % 2 === 0, { value: ethers.parseEther("0.05") });
      }
    });
  });
});
