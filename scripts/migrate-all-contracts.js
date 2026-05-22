/**
 * migrate-all-contracts.js
 *
 * Full emergency role + treasury migration across ALL TrendZap mainnet contracts.
 * Fires every transaction simultaneously with ultra-high gas to beat sweeper bots.
 *
 * Contracts covered:
 *   - ViralityMarketV2 (active)     0xbB898682B2BbD8cF19c33179b783ed172168BB6d
 *   - ViralityMarketV2 (deprecated) 0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8
 *   - MarketFactoryV2               0x55Ed74dFD27E16bd69decf473b524379A588a427
 *   - ViralityPositions             0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE
 *
 * Required env vars:
 *   PRIVATE_KEY              — current (compromised) admin private key
 *   NEW_ADMIN                — new clean wallet address to receive all roles
 *   AVALANCHE_MAINNET_RPC    — Avalanche C-Chain RPC URL
 *
 * Run:
 *   node scripts/migrate-all-contracts.js
 * Then immediately send a small amount of AVAX to the compromised wallet to fund gas.
 * The script fires the instant it detects a balance.
 */

const { ethers } = require("ethers");
require("dotenv/config");

const CURRENT_ADMIN_KEY = process.env.PRIVATE_KEY;
const NEW_ADMIN         = process.env.NEW_ADMIN;
const RPC_URL           = process.env.AVALANCHE_MAINNET_RPC;

if (!CURRENT_ADMIN_KEY || !NEW_ADMIN || !RPC_URL) {
  console.error(
    "Missing env vars. Set PRIVATE_KEY, NEW_ADMIN, AVALANCHE_MAINNET_RPC"
  );
  process.exit(1);
}

// ── Contract addresses ────────────────────────────────────────────────────────
const CONTRACTS = {
  MARKET_V2_ACTIVE:      "0xbB898682B2BbD8cF19c33179b783ed172168BB6d",
  MARKET_V2_DEPRECATED:  "0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8",
  FACTORY_V2:            "0x55Ed74dFD27E16bd69decf473b524379A588a427",
  POSITIONS:             "0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE",
};

// ── ABIs ──────────────────────────────────────────────────────────────────────
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

const POSITIONS_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function revokeRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
];

// ── Role hashes ───────────────────────────────────────────────────────────────
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ORACLE_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
const ADMIN_ROLE         = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const KEEPER_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("KEEPER_ROLE"));
const MARKET_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("MARKET_ROLE"));
const RESOLVER_ROLE      = ethers.keccak256(ethers.toUtf8Bytes("RESOLVER_ROLE"));

// ── Gas settings ─────────────────────────────────────────────────────────────
// 50 gwei maxFee × 80k gasLimit = 0.004 AVAX max per tx (fits in 0.019 AVAX balance)
// Actual cost per tx is ~0.0015–0.002 AVAX at current Avalanche base fees.
// Total for 29 txs ≈ 0.05 AVAX. Fund the wallet with at least 0.06 AVAX.
const GAS = {
  maxFeePerGas:         ethers.parseUnits("50", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("5",  "gwei"),
  gasLimit: 80_000,
};

// ── Build all operations ──────────────────────────────────────────────────────
function buildOps(provider, signer) {
  const marketActive     = new ethers.Contract(CONTRACTS.MARKET_V2_ACTIVE,     MARKET_ABI,    signer);
  const marketDeprecated = new ethers.Contract(CONTRACTS.MARKET_V2_DEPRECATED, MARKET_ABI,    signer);
  const factory          = new ethers.Contract(CONTRACTS.FACTORY_V2,           FACTORY_ABI,   signer);
  const positions        = new ethers.Contract(CONTRACTS.POSITIONS,            POSITIONS_ABI, signer);

  const old = signer.address;

  return [
    // ── ViralityMarketV2 (active) — grant ─────────────────────────────────────
    ["[Market Active] Grant DEFAULT_ADMIN_ROLE", () => marketActive.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Market Active] Grant ORACLE_ROLE",        () => marketActive.grantRole(ORACLE_ROLE,        NEW_ADMIN, GAS)],
    ["[Market Active] Grant ADMIN_ROLE",         () => marketActive.grantRole(ADMIN_ROLE,         NEW_ADMIN, GAS)],
    ["[Market Active] Grant KEEPER_ROLE",        () => marketActive.grantRole(KEEPER_ROLE,        NEW_ADMIN, GAS)],
    ["[Market Active] Set treasury",             () => marketActive.setTreasury(NEW_ADMIN,                   GAS)],

    // ── ViralityMarketV2 (deprecated) — grant ────────────────────────────────
    ["[Market Deprecated] Grant DEFAULT_ADMIN_ROLE", () => marketDeprecated.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Market Deprecated] Grant ORACLE_ROLE",        () => marketDeprecated.grantRole(ORACLE_ROLE,        NEW_ADMIN, GAS)],
    ["[Market Deprecated] Grant ADMIN_ROLE",         () => marketDeprecated.grantRole(ADMIN_ROLE,         NEW_ADMIN, GAS)],
    ["[Market Deprecated] Grant KEEPER_ROLE",        () => marketDeprecated.grantRole(KEEPER_ROLE,        NEW_ADMIN, GAS)],

    // ── MarketFactoryV2 — grant ───────────────────────────────────────────────
    ["[Factory] Grant DEFAULT_ADMIN_ROLE", () => factory.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Factory] Grant ADMIN_ROLE",         () => factory.grantRole(ADMIN_ROLE,         NEW_ADMIN, GAS)],
    ["[Factory] Set treasury",             () => factory.setTreasury(NEW_ADMIN,                   GAS)],
    ["[Factory] Set oracle",               () => factory.setOracle(NEW_ADMIN,                     GAS)],

    // ── ViralityPositions — grant ─────────────────────────────────────────────
    ["[Positions] Grant DEFAULT_ADMIN_ROLE", () => positions.grantRole(DEFAULT_ADMIN_ROLE, NEW_ADMIN, GAS)],
    ["[Positions] Grant MARKET_ROLE",        () => positions.grantRole(MARKET_ROLE,        NEW_ADMIN, GAS)],
    ["[Positions] Grant RESOLVER_ROLE",      () => positions.grantRole(RESOLVER_ROLE,      NEW_ADMIN, GAS)],

    // ── Revoke old wallet from all contracts ──────────────────────────────────
    ["[Market Active] Revoke DEFAULT_ADMIN_ROLE", () => marketActive.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Market Active] Revoke ORACLE_ROLE",        () => marketActive.revokeRole(ORACLE_ROLE,        old, GAS)],
    ["[Market Active] Revoke ADMIN_ROLE",         () => marketActive.revokeRole(ADMIN_ROLE,         old, GAS)],
    ["[Market Active] Revoke KEEPER_ROLE",        () => marketActive.revokeRole(KEEPER_ROLE,        old, GAS)],

    ["[Market Deprecated] Revoke DEFAULT_ADMIN_ROLE", () => marketDeprecated.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Market Deprecated] Revoke ORACLE_ROLE",        () => marketDeprecated.revokeRole(ORACLE_ROLE,        old, GAS)],
    ["[Market Deprecated] Revoke ADMIN_ROLE",         () => marketDeprecated.revokeRole(ADMIN_ROLE,         old, GAS)],
    ["[Market Deprecated] Revoke KEEPER_ROLE",        () => marketDeprecated.revokeRole(KEEPER_ROLE,        old, GAS)],

    ["[Factory] Revoke DEFAULT_ADMIN_ROLE", () => factory.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Factory] Revoke ADMIN_ROLE",         () => factory.revokeRole(ADMIN_ROLE,         old, GAS)],

    ["[Positions] Revoke DEFAULT_ADMIN_ROLE", () => positions.revokeRole(DEFAULT_ADMIN_ROLE, old, GAS)],
    ["[Positions] Revoke MARKET_ROLE",        () => positions.revokeRole(MARKET_ROLE,        old, GAS)],
    ["[Positions] Revoke RESOLVER_ROLE",      () => positions.revokeRole(RESOLVER_ROLE,      old, GAS)],
  ];
}

// ── Fire all transactions simultaneously ─────────────────────────────────────
async function fireAll(provider, signer) {
  const ops   = buildOps(provider, signer);
  let   nonce = await provider.getTransactionCount(signer.address, "pending");

  console.log(`\nFiring ${ops.length} transactions simultaneously...\n`);

  const pending = [];
  for (const [label, fn] of ops) {
    try {
      const tx = await fn({ ...GAS, nonce: nonce++ });
      pending.push({ label, tx });
      console.log(`  ✓ Submitted — ${label}`);
      console.log(`    tx: ${tx.hash}`);
    } catch (e) {
      console.log(`  ✗ Failed   — ${label}`);
      console.log(`    ${e.message.slice(0, 120)}`);
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
  if (failed === 0) {
    console.log("ALL DONE — new admin controls all contracts.");
  } else {
    console.log(`Done with ${failed} failure(s). Check above for details.`);
  }
  console.log("New admin wallet:", NEW_ADMIN);
  console.log("=".repeat(55));
}

// ── Main: poll for balance then fire ─────────────────────────────────────────
async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(CURRENT_ADMIN_KEY, provider);

  console.log("=".repeat(55));
  console.log("TrendZap — Full Contract Admin Migration");
  console.log("=".repeat(55));
  console.log("Current (compromised) admin:", signer.address);
  console.log("New safe admin:            ", NEW_ADMIN);
  console.log("=".repeat(55));

  const balance = await provider.getBalance(signer.address);
  if (balance > 0n) {
    console.log(`\nBalance: ${ethers.formatEther(balance)} AVAX — firing immediately.`);
    await fireAll(provider, signer);
    return;
  }

  console.log(`\nNo AVAX balance. Waiting...`);
  console.log(`Send at least 0.06 AVAX to: ${signer.address}`);
  console.log("Script fires the instant funds land.\n");

  while (true) {
    await new Promise(r => setTimeout(r, 500));
    const bal = await provider.getBalance(signer.address);
    if (bal > 0n) {
      console.log(`\nBalance detected: ${ethers.formatEther(bal)} AVAX — firing NOW!`);
      await fireAll(provider, signer);
      break;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
