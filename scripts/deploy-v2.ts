import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Known USDC addresses per chain
const USDC_ADDRESSES: Record<number, string> = {
  43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // Avalanche Mainnet (native USDC)
  43113: "0x5425890298aed601595a70AB815c96711a31Bc65", // Avalanche Fuji testnet USDC
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Arbitrum One USDC
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Arbitrum Sepolia USDC
  31337: ethers.ZeroAddress, // Hardhat — native settlement
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const chainIdNum = Number(chainId);

  console.log("=".repeat(60));
  console.log("TrendZap V2 Contract Deployment");
  console.log("=".repeat(60));
  console.log(`Network: ${network.name} (Chain ID: ${chainIdNum})`);
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} AVAX`);
  console.log("=".repeat(60));

  // Resolve configuration
  const TREASURY = process.env.TREASURY_ADDRESS || deployer.address;
  const ORACLE = process.env.ORACLE_ADDRESS || deployer.address;
  const SETTLEMENT_TOKEN =
    process.env.SETTLEMENT_TOKEN ||
    USDC_ADDRESSES[chainIdNum] ||
    ethers.ZeroAddress;

  const isNativeSettlement = SETTLEMENT_TOKEN === ethers.ZeroAddress;
  console.log(`\nSettlement: ${isNativeSettlement ? "Native AVAX" : `ERC-20 (${SETTLEMENT_TOKEN})`}`);
  console.log(`Treasury: ${TREASURY}`);
  console.log(`Oracle: ${ORACLE}`);

  // 1. Deploy ViralityPositions (ERC1155)
  console.log("\n1. Deploying ViralityPositions...");
  const ViralityPositions = await ethers.getContractFactory("ViralityPositions");
  const baseURI = process.env.METADATA_BASE_URI || "https://api.trendzap.xyz/metadata/";
  const positions = await ViralityPositions.deploy(baseURI);
  await positions.waitForDeployment();
  const positionsAddress = await positions.getAddress();
  console.log(`   ViralityPositions deployed at: ${positionsAddress}`);

  // 2. Deploy ViralityMarketV2 (LMSR market)
  console.log("\n2. Deploying ViralityMarketV2...");
  const ViralityMarketV2 = await ethers.getContractFactory("ViralityMarketV2");
  const market = await ViralityMarketV2.deploy(TREASURY, ORACLE, SETTLEMENT_TOKEN);
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  console.log(`   ViralityMarketV2 deployed at: ${marketAddress}`);

  // 3. Deploy MarketFactoryV2
  console.log("\n3. Deploying MarketFactoryV2...");
  const MarketFactoryV2 = await ethers.getContractFactory("MarketFactoryV2");
  const factory = await MarketFactoryV2.deploy(TREASURY, ORACLE, SETTLEMENT_TOKEN);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`   MarketFactoryV2 deployed at: ${factoryAddress}`);

  // 4. Configure Factory
  console.log("\n4. Configuring MarketFactoryV2...");
  let tx = await factory.setSingletonMarket(marketAddress);
  await tx.wait();
  console.log("   Set singleton market");

  tx = await factory.setPositionsToken(positionsAddress);
  await tx.wait();
  console.log("   Set positions token");

  // 5. Grant roles on ViralityPositions
  console.log("\n5. Setting up roles on ViralityPositions...");
  const MARKET_ROLE = await positions.MARKET_ROLE();
  const RESOLVER_ROLE = await positions.RESOLVER_ROLE();

  tx = await positions.grantRole(MARKET_ROLE, marketAddress);
  await tx.wait();
  console.log("   Granted MARKET_ROLE to ViralityMarketV2");

  tx = await positions.grantRole(RESOLVER_ROLE, marketAddress);
  await tx.wait();
  console.log("   Granted RESOLVER_ROLE to ViralityMarketV2");

  // 6. Grant roles on ViralityMarketV2
  console.log("\n6. Setting up roles on ViralityMarketV2...");
  const KEEPER_ROLE = await market.KEEPER_ROLE();

  tx = await market.grantRole(KEEPER_ROLE, deployer.address);
  await tx.wait();
  console.log("   Granted KEEPER_ROLE to deployer");

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nContract Addresses:");
  console.log(`  ViralityPositions: ${positionsAddress}`);
  console.log(`  ViralityMarketV2:  ${marketAddress}`);
  console.log(`  MarketFactoryV2:   ${factoryAddress}`);
  console.log(`  Treasury:          ${TREASURY}`);
  console.log(`  Oracle:            ${ORACLE}`);
  console.log(`  Settlement Token:  ${SETTLEMENT_TOKEN || "Native AVAX"}`);

  console.log("\nVerification Commands:");
  console.log(`  npx hardhat verify --network ${network.name} ${positionsAddress} "${baseURI}"`);
  console.log(`  npx hardhat verify --network ${network.name} ${marketAddress} ${TREASURY} ${ORACLE} ${SETTLEMENT_TOKEN}`);
  console.log(`  npx hardhat verify --network ${network.name} ${factoryAddress} ${TREASURY} ${ORACLE} ${SETTLEMENT_TOKEN}`);
  console.log("=".repeat(60));

  // Save deployment info to file
  const deployment = {
    network: network.name,
    chainId: chainIdNum,
    timestamp: new Date().toISOString(),
    contracts: {
      ViralityPositions: positionsAddress,
      ViralityMarketV2: marketAddress,
      MarketFactoryV2: factoryAddress,
    },
    configuration: {
      treasury: TREASURY,
      oracle: ORACLE,
      settlementToken: SETTLEMENT_TOKEN,
      settlementMode: isNativeSettlement ? "native_avax" : "erc20_usdc",
      baseURI,
    },
    deployer: deployer.address,
  };

  // Write deployment file
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const filename = `${network.name}-${chainIdNum}-${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment saved to: ${filepath}`);

  return deployment;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
