/**
 * EMERGENCY: Transfer all admin + oracle roles to new safe wallets.
 *
 * Run this IMMEDIATELY if your deployer key is compromised.
 * This script grants roles to new wallets and revokes them from the old (compromised) one.
 *
 * Usage:
 *   NEW_ADMIN=0xYourSafeAdmin NEW_ORACLE=0xYourOracleWallet npx hardhat run scripts/transfer-admin.ts --network avalanche
 *
 * IMPORTANT: The PRIVATE_KEY in .env must be the *current* admin (compromised wallet).
 * Act fast — run this before the attacker can front-run you.
 */

import { ethers } from "hardhat";

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
];

async function main() {
  const [compromisedSigner] = await ethers.getSigners();
  const marketAddress = process.env.MARKET_CONTRACT_ADDRESS;
  const newAdminAddress = process.env.NEW_ADMIN;
  const newOracleAddress = process.env.NEW_ORACLE;

  if (!marketAddress) throw new Error("Set MARKET_CONTRACT_ADDRESS in .env");
  if (!newAdminAddress) throw new Error("Set NEW_ADMIN=0x... env var");
  if (!newOracleAddress) throw new Error("Set NEW_ORACLE=0x... env var");

  const market = new ethers.Contract(marketAddress, MARKET_ABI, compromisedSigner);

  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
  const KEEPER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

  console.log("=".repeat(60));
  console.log("EMERGENCY ADMIN TRANSFER");
  console.log("=".repeat(60));
  console.log(`Compromised admin: ${compromisedSigner.address}`);
  console.log(`New admin:         ${newAdminAddress}`);
  console.log(`New oracle:        ${newOracleAddress}`);
  console.log("=".repeat(60));

  // Step 1: Grant DEFAULT_ADMIN_ROLE to new admin FIRST
  console.log("\n[1/5] Granting DEFAULT_ADMIN_ROLE to new admin...");
  const tx1 = await market.grantRole(DEFAULT_ADMIN_ROLE, newAdminAddress);
  await tx1.wait();
  console.log(`  ✓ TX: ${tx1.hash}`);

  // Step 2: Grant ORACLE_ROLE to new oracle wallet
  console.log("[2/5] Granting ORACLE_ROLE to new oracle...");
  const tx2 = await market.grantRole(ORACLE_ROLE, newOracleAddress);
  await tx2.wait();
  console.log(`  ✓ TX: ${tx2.hash}`);

  // Step 3: Grant ADMIN_ROLE and KEEPER_ROLE to new admin
  console.log("[3/5] Granting ADMIN_ROLE + KEEPER_ROLE to new admin...");
  const tx3 = await market.grantRole(ADMIN_ROLE, newAdminAddress);
  await tx3.wait();
  const tx3b = await market.grantRole(KEEPER_ROLE, newAdminAddress);
  await tx3b.wait();
  console.log(`  ✓ ADMIN_ROLE TX: ${tx3.hash}`);

  // Step 4: Update treasury to new admin (so protocol fees go to safe address)
  console.log("[4/5] Updating treasury address to new admin...");
  const tx4 = await market.setTreasury(newAdminAddress);
  await tx4.wait();
  console.log(`  ✓ TX: ${tx4.hash}`);

  // Step 5: Revoke all roles from compromised address
  console.log("[5/5] Revoking all roles from compromised address...");
  for (const [name, role] of [
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE],
    ["ORACLE_ROLE", ORACLE_ROLE],
    ["ADMIN_ROLE", ADMIN_ROLE],
    ["KEEPER_ROLE", KEEPER_ROLE],
  ] as const) {
    const hasIt = await market.hasRole(role, compromisedSigner.address);
    if (hasIt) {
      const tx = await market.revokeRole(role, compromisedSigner.address);
      await tx.wait();
      console.log(`  ✓ Revoked ${name}: ${tx.hash}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("✓ TRANSFER COMPLETE");
  console.log("=".repeat(60));
  console.log(`New admin has control:  ${newAdminAddress}`);
  console.log(`New oracle can resolve: ${newOracleAddress}`);
  console.log("\nNext steps:");
  console.log("1. Update ORACLE_PRIVATE_KEY in trendzap-oracle/.env to the new oracle key");
  console.log("2. Never send AVAX to the old compromised address again");
  console.log("3. Notify the AVAX team that treasury/admin address has changed");
}

main().catch((e) => { console.error(e); process.exit(1); });
