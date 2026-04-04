/**
 * EMERGENCY: Transfer admin + oracle roles to new safe wallet.
 * Uses high gas price to front-run any sweeper bot on the compromised wallet.
 *
 * Usage:
 *   NEW_ADMIN=0x... NEW_ORACLE=0x... npx hardhat run scripts/transfer-admin.ts --network avalancheMainnet
 *
 * PRIVATE_KEY in .env must be the compromised deployer key.
 * Fund the deployer wallet with 0.05 AVAX, then run immediately.
 */

import { ethers } from "hardhat";

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
];

// High gas override — competes with sweeper bots
// Avalanche base fee ~25 nAVAX; we set 10x to ensure priority
const GAS_OVERRIDE = {
  maxFeePerGas: ethers.parseUnits("250", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("100", "gwei"),
  gasLimit: 100_000,
};

async function main() {
  const [signer] = await ethers.getSigners();
  const marketAddress = process.env.MARKET_CONTRACT_ADDRESS;
  const newAdminAddress = process.env.NEW_ADMIN;
  const newOracleAddress = process.env.NEW_ORACLE;

  if (!marketAddress) throw new Error("Set MARKET_CONTRACT_ADDRESS in .env");
  if (!newAdminAddress) throw new Error("Set NEW_ADMIN=0x... env var");
  if (!newOracleAddress) throw new Error("Set NEW_ORACLE=0x... env var");

  const balance = await ethers.provider.getBalance(signer.address);
  console.log("=".repeat(60));
  console.log("EMERGENCY ADMIN TRANSFER");
  console.log("=".repeat(60));
  console.log(`Signing from (compromised): ${signer.address}`);
  console.log(`Balance:                    ${ethers.formatEther(balance)} AVAX`);
  console.log(`New admin + oracle:         ${newAdminAddress}`);
  console.log("=".repeat(60));

  if (balance < ethers.parseEther("0.005")) {
    throw new Error(
      `Insufficient balance. Fund ${signer.address} with at least 0.05 AVAX then run again.`
    );
  }

  const market = new ethers.Contract(marketAddress, MARKET_ABI, signer);

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

  // Fetch starting nonce once (prevents nonce issues across rapid TXs)
  let nonce = await ethers.provider.getTransactionCount(signer.address, "pending");

  async function send(description: string, fn: () => Promise<any>) {
    console.log(`\n→ ${description}`);
    const tx = await fn();
    console.log(`  TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  ✓ Confirmed (block ${receipt.blockNumber})`);
    nonce++;
    return tx;
  }

  // 1. Grant DEFAULT_ADMIN_ROLE — most critical, do first
  await send("Grant DEFAULT_ADMIN_ROLE to new wallet", () =>
    market.grantRole(DEFAULT_ADMIN_ROLE, newAdminAddress, { ...GAS_OVERRIDE, nonce: nonce })
  );

  // 2. Grant ORACLE_ROLE
  await send("Grant ORACLE_ROLE to new wallet", () =>
    market.grantRole(ORACLE_ROLE, newOracleAddress, { ...GAS_OVERRIDE, nonce: nonce })
  );

  // 3. Grant ADMIN_ROLE + KEEPER_ROLE
  await send("Grant ADMIN_ROLE to new wallet", () =>
    market.grantRole(ADMIN_ROLE, newAdminAddress, { ...GAS_OVERRIDE, nonce: nonce })
  );
  await send("Grant KEEPER_ROLE to new wallet", () =>
    market.grantRole(KEEPER_ROLE, newAdminAddress, { ...GAS_OVERRIDE, nonce: nonce })
  );

  // 4. Move treasury so protocol fees go to new wallet
  await send("Update treasury to new wallet", () =>
    market.setTreasury(newAdminAddress, { ...GAS_OVERRIDE, nonce: nonce })
  );

  // 5. Revoke all from compromised address
  for (const [name, role] of [
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
    ["ORACLE_ROLE", ORACLE_ROLE],
    ["ADMIN_ROLE", ADMIN_ROLE],
    ["KEEPER_ROLE", KEEPER_ROLE],
  ] as const) {
    const hasIt = await market.hasRole(role, signer.address);
    if (hasIt) {
      await send(`Revoke ${name} from compromised wallet`, () =>
        market.revokeRole(role, signer.address, { ...GAS_OVERRIDE, nonce: nonce })
      );
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("✓ DONE — all roles transferred");
  console.log("=".repeat(60));
  console.log(`Your new wallet ${newAdminAddress} now controls the contracts.`);
  console.log("Protocol fees (treasury) now flow to your new wallet.");
  console.log("Never send AVAX to the old compromised address again.");
}

main().catch((e) => { console.error(e); process.exit(1); });
