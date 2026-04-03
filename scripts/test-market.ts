import { ethers } from "hardhat";

/**
 * Script to create a test market and place bets
 * Run after deployment to verify everything works
 */
async function main() {
  const [deployer, user1, user2] = await ethers.getSigners();
  
  console.log("=".repeat(60));
  console.log("TrendZap Test Market Creation");
  console.log("=".repeat(60));

  // Get deployed contracts (update these addresses after deployment)
  const MARKET_ADDRESS = process.env.MARKET_ADDRESS || "";
  
  if (!MARKET_ADDRESS) {
    console.error("Please set MARKET_ADDRESS environment variable");
    process.exit(1);
  }

  const market = await ethers.getContractAt("ViralityMarketV2", MARKET_ADDRESS);
  
  console.log(`\nUsing ViralityMarketV2 at: ${MARKET_ADDRESS}`);
  console.log(`Deployer: ${deployer.address}`);

  // Create a test market
  console.log("\n1. Creating test market...");
  
  const now = Math.floor(Date.now() / 1000);
  const marketParams = {
    postUrl: "https://twitter.com/elonmusk/status/1234567890",
    platform: 0, // TWITTER
    metricType: 0, // LIKES
    threshold: ethers.parseEther("100000"), // 100k likes
    startTime: now,
    endTime: now + 3600, // 1 hour
    resolutionTime: now + 3660, // 1 hour + 1 minute
  };

  const initialBet = ethers.parseEther("0.1"); // 0.1 ETH initial bet
  
  const tx1 = await market.createMarket(
    marketParams,
    initialBet,
    true, // bet on OVER
    { value: initialBet }
  );
  const receipt1 = await tx1.wait();
  
  // Get market ID from event
  const marketCreatedEvent = receipt1?.logs.find(
    (log: any) => log.fragment?.name === "MarketCreated"
  );
  const marketId = marketCreatedEvent?.args?.[0] || 0;
  
  console.log(`   ✓ Market created with ID: ${marketId}`);

  // Check prices
  console.log("\n2. Checking initial prices...");
  const [priceOver, priceUnder] = await market.getPrices(marketId);
  console.log(`   OVER price:  ${ethers.formatEther(priceOver)} (${Number(priceOver) / 1e16}%)`);
  console.log(`   UNDER price: ${ethers.formatEther(priceUnder)} (${Number(priceUnder) / 1e16}%)`);

  // Place some bets
  console.log("\n3. Placing additional bets...");
  
  // Buy OVER shares
  const bet1 = ethers.parseEther("0.05");
  const tx2 = await market.buyShares(marketId, true, { value: bet1 });
  await tx2.wait();
  console.log(`   ✓ Bought OVER shares for ${ethers.formatEther(bet1)} ETH`);

  // Buy UNDER shares
  const bet2 = ethers.parseEther("0.03");
  const tx3 = await market.buyShares(marketId, false, { value: bet2 });
  await tx3.wait();
  console.log(`   ✓ Bought UNDER shares for ${ethers.formatEther(bet2)} ETH`);

  // Check updated prices
  console.log("\n4. Checking updated prices...");
  const [priceOver2, priceUnder2] = await market.getPrices(marketId);
  console.log(`   OVER price:  ${ethers.formatEther(priceOver2)} (${Number(priceOver2) / 1e16}%)`);
  console.log(`   UNDER price: ${ethers.formatEther(priceUnder2)} (${Number(priceUnder2) / 1e16}%)`);

  // Check user position
  console.log("\n5. Checking user position...");
  const position = await market.getPosition(marketId, deployer.address);
  console.log(`   OVER shares:  ${ethers.formatEther(position.overShares)}`);
  console.log(`   UNDER shares: ${ethers.formatEther(position.underShares)}`);
  console.log(`   OVER cost:    ${ethers.formatEther(position.overCost)} ETH`);
  console.log(`   UNDER cost:   ${ethers.formatEther(position.underCost)} ETH`);

  // Get market details
  console.log("\n6. Market details...");
  const marketData = await market.getMarket(marketId);
  console.log(`   Total Volume: ${ethers.formatEther(marketData.state.totalVolume)} ETH`);
  console.log(`   Fees Collected: ${ethers.formatEther(marketData.state.feesCollected)} ETH`);
  console.log(`   Status: ${["PENDING", "ACTIVE", "CLOSED", "RESOLVED", "CANCELLED", "DISPUTED"][marketData.status]}`);

  console.log("\n" + "=".repeat(60));
  console.log("TEST COMPLETE");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
