import { ethers, network } from "hardhat";
import * as fs from "fs";

async function main() {
  console.log(`\n🚀 Deploying TrendZap contracts to ${network.name}...\n`);

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Deploy Treasury (using deployer as treasury for now)
  const treasury = deployer.address;
  console.log("Treasury address:", treasury);

  // Deploy a placeholder oracle (will be replaced with Chainlink in production)
  const oracle = deployer.address;
  console.log("Oracle address:", oracle);

  // Deploy MarketFactory
  console.log("\n📦 Deploying MarketFactory...");
  const MarketFactory = await ethers.getContractFactory("MarketFactory");
  const marketFactory = await MarketFactory.deploy(treasury, oracle);
  await marketFactory.waitForDeployment();
  const marketFactoryAddress = await marketFactory.getAddress();
  console.log("✅ MarketFactory deployed to:", marketFactoryAddress);

  // Deploy a ViralityMarket via factory
  console.log("\n📦 Deploying ViralityMarket via factory...");
  const tx = await marketFactory.deployMarket();
  const receipt = await tx.wait();
  
  // Get the deployed market address from events
  const marketDeployedEvent = receipt?.logs.find((log: any) => {
    try {
      const parsed = marketFactory.interface.parseLog(log);
      return parsed?.name === "MarketDeployed";
    } catch {
      return false;
    }
  });

  let viralityMarketAddress = "";
  if (marketDeployedEvent) {
    const parsed = marketFactory.interface.parseLog(marketDeployedEvent);
    viralityMarketAddress = parsed?.args[0];
    console.log("✅ ViralityMarket deployed to:", viralityMarketAddress);
  }

  // Save deployment addresses
  const deployments = {
    network: network.name,
    chainId: network.config.chainId,
    deployer: deployer.address,
    contracts: {
      MarketFactory: marketFactoryAddress,
      ViralityMarket: viralityMarketAddress,
      Treasury: treasury,
      Oracle: oracle,
    },
    timestamp: new Date().toISOString(),
  };

  const deploymentsDir = "./deployments";
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir);
  }

  const filename = `${deploymentsDir}/${network.name}.json`;
  fs.writeFileSync(filename, JSON.stringify(deployments, null, 2));
  console.log(`\n📝 Deployment addresses saved to ${filename}`);

  console.log("\n=== Deployment Summary ===");
  console.log("Network:", network.name);
  console.log("Chain ID:", network.config.chainId);
  console.log("MarketFactory:", marketFactoryAddress);
  console.log("ViralityMarket:", viralityMarketAddress);
  console.log("Treasury:", treasury);
  console.log("Oracle:", oracle);

  // Verification instructions
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\n=== Verification Commands ===");
    console.log(`npx hardhat verify --network ${network.name} ${marketFactoryAddress} ${treasury} ${oracle}`);
    if (viralityMarketAddress) {
      console.log(`npx hardhat verify --network ${network.name} ${viralityMarketAddress} ${treasury} ${oracle}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
