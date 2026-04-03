/**
 * Grant ORACLE_ROLE to a new wallet address.
 *
 * Usage:
 *   ORACLE_ADDRESS=0xYourNewOracleWallet npx hardhat run scripts/grant-oracle-role.ts --network avalanche
 *
 * The wallet running this script (set via PRIVATE_KEY in .env) must have DEFAULT_ADMIN_ROLE.
 * By default, only the original deployer has this role.
 */

import { ethers } from "hardhat";

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function getRoleAdmin(bytes32 role) external view returns (bytes32)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const marketAddress = process.env.MARKET_CONTRACT_ADDRESS;
  const newOracleAddress = process.env.ORACLE_ADDRESS;

  if (!marketAddress || marketAddress === ethers.ZeroAddress) {
    throw new Error("Set MARKET_CONTRACT_ADDRESS in .env");
  }
  if (!newOracleAddress) {
    throw new Error("Set ORACLE_ADDRESS=0x... env var to the new oracle wallet");
  }

  console.log(`Signer (must be admin): ${signer.address}`);
  console.log(`Market contract:        ${marketAddress}`);
  console.log(`New oracle address:     ${newOracleAddress}`);

  const market = new ethers.Contract(marketAddress, MARKET_ABI, signer);

  const ORACLE_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash; // 0x000...000

  const alreadyHasRole = await market.hasRole(ORACLE_ROLE, newOracleAddress);
  if (alreadyHasRole) {
    console.log("✓ Address already has ORACLE_ROLE — nothing to do.");
    return;
  }

  // Verify signer actually has admin rights
  const signerIsAdmin = await market.hasRole(DEFAULT_ADMIN_ROLE, signer.address);
  if (!signerIsAdmin) {
    throw new Error(`${signer.address} does not have DEFAULT_ADMIN_ROLE. Use the deployer key.`);
  }

  console.log("\nGranting ORACLE_ROLE...");
  const tx = await market.grantRole(ORACLE_ROLE, newOracleAddress);
  console.log(`TX hash: ${tx.hash}`);
  await tx.wait();

  const confirmed = await market.hasRole(ORACLE_ROLE, newOracleAddress);
  console.log(`\n✓ ORACLE_ROLE granted: ${confirmed}`);
  console.log(`\nUpdate ORACLE_PRIVATE_KEY in trendzap-oracle/.env to the key for ${newOracleAddress}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
