import { expect } from "chai";
import { ethers } from "hardhat";
import { ViralityMarket, MarketFactory } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ViralityMarket", function () {
  let marketFactory: MarketFactory;
  let viralityMarket: ViralityMarket;
  let owner: SignerWithAddress;
  let oracle: SignerWithAddress;
  let treasury: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const ONE_DAY = 24 * 60 * 60;
  const ONE_HOUR = 60 * 60;

  beforeEach(async function () {
    [owner, oracle, treasury, user1, user2] = await ethers.getSigners();

    // Deploy MarketFactory
    const MarketFactory = await ethers.getContractFactory("MarketFactory");
    marketFactory = await MarketFactory.deploy(treasury.address, oracle.address);
    await marketFactory.waitForDeployment();

    // Deploy ViralityMarket via factory
    const tx = await marketFactory.deployMarket();
    const receipt = await tx.wait();
    
    const event = receipt?.logs.find((log: any) => {
      try {
        const parsed = marketFactory.interface.parseLog(log);
        return parsed?.name === "MarketDeployed";
      } catch {
        return false;
      }
    });

    const parsed = marketFactory.interface.parseLog(event!);
    const marketAddress = parsed?.args[0];

    viralityMarket = await ethers.getContractAt("ViralityMarket", marketAddress);
  });

  describe("Deployment", function () {
    it("Should set the correct treasury", async function () {
      expect(await viralityMarket.treasury()).to.equal(treasury.address);
    });

    it("Should grant ORACLE_ROLE to oracle address", async function () {
      const ORACLE_ROLE = await viralityMarket.ORACLE_ROLE();
      expect(await viralityMarket.hasRole(ORACLE_ROLE, oracle.address)).to.be.true;
    });

    it("Should grant ADMIN_ROLE to deployer", async function () {
      const ADMIN_ROLE = await viralityMarket.ADMIN_ROLE();
      expect(await viralityMarket.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });
  });

  describe("Market Creation", function () {
    it("Should create a market with valid parameters", async function () {
      const now = await time.latest();
      const params = {
        postUrl: "https://twitter.com/elonmusk/status/123456",
        platform: 0, // TWITTER
        metricType: 0, // LIKES
        threshold: 100000,
        startTime: now + ONE_HOUR,
        endTime: now + ONE_DAY,
        resolutionTime: now + ONE_DAY + ONE_HOUR,
      };

      await expect(viralityMarket.createMarket(params))
        .to.emit(viralityMarket, "MarketCreated");

      const market = await viralityMarket.getMarket(0);
      expect(market.params.postUrl).to.equal(params.postUrl);
      expect(market.params.threshold).to.equal(params.threshold);
      expect(market.status).to.equal(0); // PENDING
    });

    it("Should revert with invalid threshold", async function () {
      const now = await time.latest();
      const params = {
        postUrl: "https://twitter.com/test",
        platform: 0,
        metricType: 0,
        threshold: 0, // Invalid
        startTime: now + ONE_HOUR,
        endTime: now + ONE_DAY,
        resolutionTime: now + ONE_DAY + ONE_HOUR,
      };

      await expect(viralityMarket.createMarket(params))
        .to.be.revertedWith("Invalid threshold");
    });

    it("Should revert with invalid time parameters", async function () {
      const now = await time.latest();
      const params = {
        postUrl: "https://twitter.com/test",
        platform: 0,
        metricType: 0,
        threshold: 1000,
        startTime: now + ONE_DAY,
        endTime: now + ONE_HOUR, // End before start
        resolutionTime: now + ONE_DAY + ONE_HOUR,
      };

      await expect(viralityMarket.createMarket(params))
        .to.be.revertedWith("Invalid end time");
    });
  });

  describe("Betting", function () {
    let marketId: number;

    beforeEach(async function () {
      const now = await time.latest();
      const params = {
        postUrl: "https://twitter.com/test",
        platform: 0,
        metricType: 0,
        threshold: 100000,
        startTime: now + 1, // Start almost immediately
        endTime: now + ONE_DAY,
        resolutionTime: now + ONE_DAY + ONE_HOUR,
      };

      await viralityMarket.createMarket(params);
      marketId = 0;

      // Activate the market
      await time.increase(2);
      await viralityMarket.activateMarket(marketId);
    });

    it("Should place a bet on OVER", async function () {
      const betAmount = ethers.parseEther("0.1");

      await expect(viralityMarket.connect(user1).placeBet(marketId, 1, { value: betAmount })) // 1 = OVER
        .to.emit(viralityMarket, "BetPlaced")
        .withArgs(marketId, user1.address, 1, betAmount);

      const position = await viralityMarket.getPosition(marketId, user1.address);
      expect(position.overStake).to.equal(betAmount);
    });

    it("Should place a bet on UNDER", async function () {
      const betAmount = ethers.parseEther("0.05");

      await viralityMarket.connect(user2).placeBet(marketId, 2, { value: betAmount }); // 2 = UNDER

      const position = await viralityMarket.getPosition(marketId, user2.address);
      expect(position.underStake).to.equal(betAmount);
    });

    it("Should revert bet below minimum", async function () {
      const betAmount = ethers.parseEther("0.0001"); // Below MIN_BET_AMOUNT

      await expect(viralityMarket.connect(user1).placeBet(marketId, 1, { value: betAmount }))
        .to.be.revertedWith("Bet too small");
    });

    it("Should revert bet above maximum", async function () {
      const betAmount = ethers.parseEther("200"); // Above MAX_BET_AMOUNT

      await expect(viralityMarket.connect(user1).placeBet(marketId, 1, { value: betAmount }))
        .to.be.revertedWith("Bet too large");
    });
  });

  describe("Resolution", function () {
    let marketId: number;

    beforeEach(async function () {
      const now = await time.latest();
      const params = {
        postUrl: "https://twitter.com/test",
        platform: 0,
        metricType: 0,
        threshold: 100000,
        startTime: now + 1,
        endTime: now + ONE_HOUR,
        resolutionTime: now + ONE_HOUR + 60,
      };

      await viralityMarket.createMarket(params);
      marketId = 0;

      // Activate market
      await time.increase(2);
      await viralityMarket.activateMarket(marketId);

      // Place bets
      await viralityMarket.connect(user1).placeBet(marketId, 1, { value: ethers.parseEther("1") }); // OVER
      await viralityMarket.connect(user2).placeBet(marketId, 2, { value: ethers.parseEther("1") }); // UNDER

      // Close market
      await time.increase(ONE_HOUR);
      await viralityMarket.closeMarket(marketId);
    });

    it("Should resolve market with OVER outcome", async function () {
      await time.increase(120); // Past resolution time

      await expect(viralityMarket.connect(oracle).resolveMarket(marketId, 150000)) // Above threshold
        .to.emit(viralityMarket, "MarketResolved")
        .withArgs(marketId, 1, 150000); // 1 = OVER

      const market = await viralityMarket.getMarket(marketId);
      expect(market.outcome).to.equal(1); // OVER
      expect(market.status).to.equal(3); // RESOLVED
    });

    it("Should resolve market with UNDER outcome", async function () {
      await time.increase(120);

      await viralityMarket.connect(oracle).resolveMarket(marketId, 50000); // Below threshold

      const market = await viralityMarket.getMarket(marketId);
      expect(market.outcome).to.equal(2); // UNDER
    });

    it("Should only allow oracle to resolve", async function () {
      await time.increase(120);

      await expect(viralityMarket.connect(user1).resolveMarket(marketId, 150000))
        .to.be.reverted; // AccessControl revert
    });
  });

  describe("Claiming", function () {
    let marketId: number;

    beforeEach(async function () {
      const now = await time.latest();
      const params = {
        postUrl: "https://twitter.com/test",
        platform: 0,
        metricType: 0,
        threshold: 100000,
        startTime: now + 1,
        endTime: now + ONE_HOUR,
        resolutionTime: now + ONE_HOUR + 60,
      };

      await viralityMarket.createMarket(params);
      marketId = 0;

      await time.increase(2);
      await viralityMarket.activateMarket(marketId);

      // User1 bets 1 ETH on OVER
      await viralityMarket.connect(user1).placeBet(marketId, 1, { value: ethers.parseEther("1") });
      // User2 bets 1 ETH on UNDER
      await viralityMarket.connect(user2).placeBet(marketId, 2, { value: ethers.parseEther("1") });

      await time.increase(ONE_HOUR);
      await viralityMarket.closeMarket(marketId);

      await time.increase(120);
      // Resolve as OVER
      await viralityMarket.connect(oracle).resolveMarket(marketId, 150000);
    });

    it("Should allow winner to claim", async function () {
      const balanceBefore = await ethers.provider.getBalance(user1.address);

      await viralityMarket.connect(user1).claimWinnings(marketId);

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should revert if already claimed", async function () {
      await viralityMarket.connect(user1).claimWinnings(marketId);

      await expect(viralityMarket.connect(user1).claimWinnings(marketId))
        .to.be.revertedWith("Already claimed");
    });

    it("Should revert if no winnings", async function () {
      await expect(viralityMarket.connect(user2).claimWinnings(marketId))
        .to.be.revertedWith("No winnings");
    });
  });
});
