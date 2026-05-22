/**
 * finish-migration-new-wallet.js
 *
 * Completes migration on ViralityMarketV2 (active + deprecated) and MarketFactoryV2
 * using the NEW safe wallet (which now has DEFAULT_ADMIN_ROLE on all three).
 *
 * What this does:
 *   Active Market:     Revoke ORACLE/ADMIN/KEEPER from old compromised wallet (0x05394029...)
 *   Deprecated Market: Grant ADMIN_ROLE to new wallet; revoke remaining roles from original deployer
 *   Factory:           Grant ADMIN_ROLE to new wallet; setTreasury; setOracle; revoke from original deployer
 *
 * Required env vars:
 *   NEW_WALLET_KEY          — private key for the new safe wallet
 *   NEW_ADMIN               — new safe wallet address
 *   AVALANCHE_MAINNET_RPC
 *
 * Run: node scripts/finish-migration-new-wallet.js
 */

const { ethers } = require("ethers");
require("dotenv/config");

const NEW_WALLET_KEY = process.env.NEW_WALLET_KEY;
const NEW_ADMIN      = process.env.NEW_ADMIN;
const RPC_URL        = process.env.AVALANCHE_MAINNET_RPC;

const OLD_ADMIN      = "0x05394029EA22767D2283bcd0bE03B13353781212"; // 2nd compromised admin
const ORIG_DEPLOYER  = "0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e"; // original deployer

const CONTRACTS = {
  MARKET_ACTIVE:     "0xbB898682B2BbD8cF19c33179b783ed172168BB6d",
  MARKET_DEPRECATED: "0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8",
  FACTORY:           "0x55Ed74dFD27E16bd69decf473b524379A588a427",
};

if (!NEW_WALLET_KEY || !NEW_ADMIN || !RPC_URL) {
  console.error("Missing env vars: NEW_WALLET_KEY, NEW_ADMIN, AVALANCHE_MAINNET_RPC");
  process.exit(1);
}

const MARKET_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
];

const FACTORY_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function setTreasury(address _treasury) external",
  "function setOracle(address _oracle) external",
];

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ORACLE_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
const ADMIN_ROLE         = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const KEEPER_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));

const GAS = {
  maxFeePerGas:         ethers.parseUnits("50", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("5",  "gwei"),
  gasLimit: 80_000,
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(NEW_WALLET_KEY, provider);

  if (signer.address.toLowerCase() !== NEW_ADMIN.toLowerCase()) {
    console.error(`Key mismatch: key => ${signer.address}, expected ${NEW_ADMIN}`);
    process.exit(1);
  }

  const balance = await provider.getBalance(signer.address);
  console.log("=".repeat(55));
  console.log("TrendZap — Finish Migration (New Wallet)");
  console.log("=".repeat(55));
  console.log("Signer:", signer.address);
  console.log("Balance:", ethers.formatEther(balance), "AVAX");
  console.log("=".repeat(55));

  const marketActive     = new ethers.Contract(CONTRACTS.MARKET_ACTIVE,     MARKET_ABI,  signer);
  const marketDeprecated = new ethers.Contract(CONTRACTS.MARKET_DEPRECATED, MARKET_ABI,  signer);
  const factory          = new ethers.Contract(CONTRACTS.FACTORY,           FACTORY_ABI, signer);

  // Build only the ops that are still needed (check roles first)
  const checks = await Promise.all([
    // Active market — revoke from OLD_ADMIN
    marketActive.hasRole(ORACLE_ROLE, OLD_ADMIN),
    marketActive.hasRole(ADMIN_ROLE,  OLD_ADMIN),
    marketActive.hasRole(KEEPER_ROLE, OLD_ADMIN),
    // Deprecated market — grant ADMIN_ROLE to new wallet
    marketDeprecated.hasRole(ADMIN_ROLE, NEW_ADMIN),
    // Deprecated market — revoke from ORIG_DEPLOYER
    marketDeprecated.hasRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER),
    marketDeprecated.hasRole(ORACLE_ROLE,         ORIG_DEPLOYER),
    marketDeprecated.hasRole(KEEPER_ROLE,         ORIG_DEPLOYER),
    // Factory — grant ADMIN_ROLE to new wallet
    factory.hasRole(ADMIN_ROLE, NEW_ADMIN),
    // Factory — revoke from ORIG_DEPLOYER
    factory.hasRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER),
    factory.hasRole(ADMIN_ROLE,         ORIG_DEPLOYER),
  ]);

  const [
    activeOldOracle, activeOldAdmin, activeOldKeeper,
    deprecatedNewAdmin,
    deprecatedOrigDefault, deprecatedOrigOracle, deprecatedOrigKeeper,
    factoryNewAdmin,
    factoryOrigDefault, factoryOrigAdmin,
  ] = checks;

  console.log("\nRole status check:");
  console.log(`  Active Market — OLD_ADMIN still has ORACLE:  ${activeOldOracle}`);
  console.log(`  Active Market — OLD_ADMIN still has ADMIN:   ${activeOldAdmin}`);
  console.log(`  Active Market — OLD_ADMIN still has KEEPER:  ${activeOldKeeper}`);
  console.log(`  Deprecated    — NEW_ADMIN has ADMIN_ROLE:    ${deprecatedNewAdmin}`);
  console.log(`  Deprecated    — ORIG still has DEFAULT_ADMIN:${deprecatedOrigDefault}`);
  console.log(`  Deprecated    — ORIG still has ORACLE:       ${deprecatedOrigOracle}`);
  console.log(`  Deprecated    — ORIG still has KEEPER:       ${deprecatedOrigKeeper}`);
  console.log(`  Factory       — NEW_ADMIN has ADMIN_ROLE:    ${factoryNewAdmin}`);
  console.log(`  Factory       — ORIG still has DEFAULT_ADMIN:${factoryOrigDefault}`);
  console.log(`  Factory       — ORIG still has ADMIN:        ${factoryOrigAdmin}`);

  const ops = [];
  let nonce = await provider.getTransactionCount(signer.address, "pending");

  // Active market cleanup
  if (activeOldOracle) ops.push(["[Active] Revoke ORACLE from old admin",  () => marketActive.revokeRole(ORACLE_ROLE, OLD_ADMIN, { ...GAS, nonce: nonce++ })]);
  if (activeOldAdmin)  ops.push(["[Active] Revoke ADMIN from old admin",   () => marketActive.revokeRole(ADMIN_ROLE,  OLD_ADMIN, { ...GAS, nonce: nonce++ })]);
  if (activeOldKeeper) ops.push(["[Active] Revoke KEEPER from old admin",  () => marketActive.revokeRole(KEEPER_ROLE, OLD_ADMIN, { ...GAS, nonce: nonce++ })]);

  // Deprecated market
  if (!deprecatedNewAdmin)    ops.push(["[Deprecated] Grant ADMIN_ROLE to new wallet",         () => marketDeprecated.grantRole(ADMIN_ROLE,         NEW_ADMIN,      { ...GAS, nonce: nonce++ })]);
  if (deprecatedOrigDefault)  ops.push(["[Deprecated] Revoke DEFAULT_ADMIN from orig deployer",() => marketDeprecated.revokeRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER, { ...GAS, nonce: nonce++ })]);
  if (deprecatedOrigOracle)   ops.push(["[Deprecated] Revoke ORACLE from orig deployer",       () => marketDeprecated.revokeRole(ORACLE_ROLE,        ORIG_DEPLOYER, { ...GAS, nonce: nonce++ })]);
  if (deprecatedOrigKeeper)   ops.push(["[Deprecated] Revoke KEEPER from orig deployer",       () => marketDeprecated.revokeRole(KEEPER_ROLE,        ORIG_DEPLOYER, { ...GAS, nonce: nonce++ })]);

  // Factory
  if (!factoryNewAdmin)       ops.push(["[Factory] Grant ADMIN_ROLE to new wallet",            () => factory.grantRole(ADMIN_ROLE, NEW_ADMIN,                   { ...GAS, nonce: nonce++ })]);
  ops.push(                           ["[Factory] setTreasury to new wallet",                  () => factory.setTreasury(NEW_ADMIN,                             { ...GAS, nonce: nonce++ })]);
  ops.push(                           ["[Factory] setOracle to new wallet",                    () => factory.setOracle(NEW_ADMIN,                               { ...GAS, nonce: nonce++ })]);
  if (factoryOrigDefault)     ops.push(["[Factory] Revoke DEFAULT_ADMIN from orig deployer",   () => factory.revokeRole(DEFAULT_ADMIN_ROLE, ORIG_DEPLOYER,      { ...GAS, nonce: nonce++ })]);
  if (factoryOrigAdmin)       ops.push(["[Factory] Revoke ADMIN from orig deployer",           () => factory.revokeRole(ADMIN_ROLE,         ORIG_DEPLOYER,      { ...GAS, nonce: nonce++ })]);

  if (ops.length === 0) {
    console.log("\nAll clean — nothing to do.");
    return;
  }

  console.log(`\nSubmitting ${ops.length} transactions...\n`);
  const pending = [];
  for (const [label, fn] of ops) {
    try {
      const tx = await fn();
      pending.push({ label, tx });
      console.log(`  ✓ Submitted — ${label}`);
      console.log(`    tx: ${tx.hash}`);
    } catch (e) {
      console.log(`  ✗ Failed   — ${label}: ${e.message.slice(0, 120)}`);
    }
  }

  console.log(`\nWaiting for ${pending.length} confirmations...\n`);
  let failed = 0;
  for (const { label, tx } of pending) {
    try {
      const receipt = await tx.wait();
      console.log(`  ✓ Confirmed — ${label} (block ${receipt.blockNumber})`);
    } catch (e) {
      console.log(`  ✗ Reverted  — ${label}: ${e.message.slice(0, 100)}`);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(55));
  console.log(failed === 0 ? "DONE — Active, Deprecated, Factory fully migrated." : `Done with ${failed} failure(s).`);
  console.log("Remaining: run migrate-positions.js for ViralityPositions.");
  console.log("=".repeat(55));
}

main().catch(e => { console.error(e); process.exit(1); });
