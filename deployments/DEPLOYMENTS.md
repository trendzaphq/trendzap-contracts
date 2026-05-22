# TrendZap V2 Smart Contract Deployments

## Avalanche Fuji Testnet (Chain ID: 43113)

| Contract | Address | Explorer |
|----------|---------|----------|
| ViralityPositions | `0x0fE424b731bfAe1a15574016887Cf2d28707275D` | [View](https://testnet.snowtrace.io/address/0x0fE424b731bfAe1a15574016887Cf2d28707275D) |
| ViralityMarketV2 | `0xCA2Fc8C0363B0bF26C602A17B403cEaD2322EFe1` | [View](https://testnet.snowtrace.io/address/0xCA2Fc8C0363B0bF26C602A17B403cEaD2322EFe1) |
| MarketFactoryV2 | `0xC1BA091eDD50AD9106f1F4B47C9Fb373602aF0BD` | [View](https://testnet.snowtrace.io/address/0xC1BA091eDD50AD9106f1F4B47C9Fb373602aF0BD) |

**Settlement Token (USDC):** `0x5425890298aed601595a70AB815c96711a31Bc65`
**Treasury:** `0x05394029EA22767D2283bcd0bE03B13353781212`
**Oracle:** `0x05394029EA22767D2283bcd0bE03B13353781212`
**Deployed:** 2026-04-02

---

## Avalanche C-Chain Mainnet (Chain ID: 43114)

| Contract | Address | Explorer |
|----------|---------|----------|
| ViralityPositions | `0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE` | [View](https://snowtrace.io/address/0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE) |
| ViralityMarketV2 | `0xbB898682B2BbD8cF19c33179b783ed172168BB6d` *(active)* | [View](https://snowtrace.io/address/0xbB898682B2BbD8cF19c33179b783ed172168BB6d) |
| ViralityMarketV2 | `0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8` *(deprecated)* | [View](https://snowtrace.io/address/0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8) |
| MarketFactoryV2 | `0x55Ed74dFD27E16bd69decf473b524379A588a427` | [View](https://snowtrace.io/address/0x55Ed74dFD27E16bd69decf473b524379A588a427) |

**Settlement Token (USDC):** `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` (Native USDC on Avalanche)
**Treasury:** `0xd84e458e84AD7d16F436c1e2e34e8A2eE462d5B9` *(updated 2026-05-22 — emergency admin migration)*
**Oracle:** `0xd84e458e84AD7d16F436c1e2e34e8A2eE462d5B9` *(updated 2026-05-22)*
**Deployed:** 2026-04-02 · **Admin migrated:** 2026-05-22

---

## Configuration

- **Solidity:** 0.8.20 (optimizer 200 runs, viaIR)
- **Pricing Model:** LMSR (Logarithmic Market Scoring Rule)
- **Settlement:** Dual mode - Native AVAX + ERC-20 USDC
- **Fee:** 2% platform fee on trades
- **Min Bet (Native):** 0.001 AVAX
- **Min Bet (Token):** 1 USDC
- **Access Control:** OpenZeppelin AccessControl (ORACLE_ROLE, KEEPER_ROLE, ADMIN_ROLE)

---

## Admin Migration Plan — 2026-05-22

### Background

The admin/treasury wallet previously used (`0x05394029EA22767D2283bcd0bE03B13353781212`) was compromised — the seed phrase was exposed and the wallet contents were drained. This is the second incident; the original deployer (`0x8f0E9b15028311F263be1B71c1D5d8Ae8a35294e`) was compromised in April 2026, and that first migration wallet was subsequently compromised as well.

All contract logic and on-chain state (markets, positions, balances) is unaffected. The contracts themselves are not exploited — only the admin key that governs them needs to be rotated.

---

### Why This Migration Is Necessary

| Reason | Detail |
|---|---|
| Compromised admin key | Attacker controls `0x05394029...` and can drain AVAX sent to it |
| Treasury exposure | Protocol fees route to the old treasury address, which the attacker can access |
| Role exposure | All privileged roles (DEFAULT_ADMIN, ORACLE, ADMIN, KEEPER) currently held by compromised wallet |
| Grant verification | Avalanche Foundation Retro9000 requires a clean, verifiable admin wallet for KYC/KYB |

---

### What the Migration Does

The script `scripts/migrate-all-contracts.js` performs the following across all 4 mainnet contracts in a single atomic burst:

**Grants to new wallet `0xB901c7a50BC25ec3A7f0DB6A90cadB76F297934E`:**
- `DEFAULT_ADMIN_ROLE` — top-level contract governance
- `ADMIN_ROLE` — platform configuration (fees, settlement, treasury)
- `ORACLE_ROLE` — market resolution authority
- `KEEPER_ROLE` — market lifecycle management (open/close)
- `MARKET_ROLE` — position minting authority (ViralityPositions)
- `RESOLVER_ROLE` — dispute resolution authority (ViralityPositions)
- `setTreasury(new)` — redirects all future protocol fee revenue to clean wallet
- `setOracle(new)` — updates oracle reference in factory

**Revokes from old wallet `0x05394029EA22767D2283bcd0bE03B13353781212`:**
- All of the above roles across all 4 contracts

**Contracts covered:**
1. `ViralityMarketV2` (active) — `0xbB898682B2BbD8cF19c33179b783ed172168BB6d`
2. `ViralityMarketV2` (deprecated) — `0x5C13B24ae55fE5CaF8B694E6ff4478bfC0C22DB8`
3. `MarketFactoryV2` — `0x55Ed74dFD27E16bd69decf473b524379A588a427`
4. `ViralityPositions` — `0x837dD8Ce4E3CDd4d408d3B5D83998B110632bEaE`

---

### Step-by-Step Execution

#### Step 1 — Prepare the new wallet
The new clean admin wallet `0xB901c7a50BC25ec3A7f0DB6A90cadB76F297934E` must:
- Be generated from a fresh seed phrase on a clean device or hardware wallet
- Never have been imported into any previously compromised environment
- Have no AVAX sent to it yet (receive funds only after migration confirms)

#### Step 2 — Export the compromised wallet's private key
You need the private key for `0x05394029EA22767D2283bcd0bE03B13353781212` to sign the migration transactions. This wallet is used only to authorize the role transfers — not to receive any funds.

To export from MetaMask:
1. Open MetaMask → select account `0x05394029...`
2. Click the three-dot menu → Account details → Show private key
3. Enter your MetaMask password
4. Copy the private key (starts with `0x` or raw 64-hex chars)

#### Step 3 — Set environment variables
Create or update `trendzap-contracts/.env`:
```
PRIVATE_KEY=<private key exported above>
NEW_ADMIN=0xB901c7a50BC25ec3A7f0DB6A90cadB76F297934E
AVALANCHE_MAINNET_RPC=https://api.avax.network/ext/bc/C/rpc
```

> **Security note:** Never commit `.env` to git. Confirm `.gitignore` contains `.env`.

#### Step 4 — Run the migration script
```bash
cd trendzap-contracts
node scripts/migrate-all-contracts.js
```

The script will start and print:
```
Send at least 0.003 AVAX to: 0x05394029EA22767D2283bcd0bE03B13353781212
Script fires the instant funds land.
```

#### Step 5 — Fund gas
Send **exactly 0.003–0.005 AVAX** to the compromised wallet `0x05394029...`. Do not send more — anything excess is at risk of being drained.

The script detects the balance and immediately fires all **28 transactions simultaneously** at 500 gwei gas — high enough to be included in the next block and outpace sweeper bots.

#### Step 6 — Confirm output
The script will print each transaction hash and then confirmation for each. Successful completion looks like:
```
ALL DONE — new admin controls all contracts.
New admin wallet: 0xB901c7a50BC25ec3A7f0DB6A90cadB76F297934E
```

Verify a few key transactions on [Snowtrace](https://snowtrace.io) to confirm role grants.

---

### What Happens After Migration

| Item | Before | After |
|---|---|---|
| Admin control | Compromised wallet | `0xB901c7a50BC25ec3A7f0DB6A90cadB76F297934E` |
| Treasury / fee revenue | Routes to compromised address | Routes to new clean address |
| Oracle role | Compromised wallet | New wallet (update oracle service env too) |
| Compromised wallet permissions | All roles | Zero roles on all contracts |
| Avalanche grant KYC | Blocked — old wallet unusable | Can proceed with new clean address |

#### After migration, also update:
- `trendzap-oracle/.env` — set `ORACLE_PRIVATE_KEY` to new wallet key or a dedicated oracle key
- `trendzap-risk/.env` / `trendzap-intelligence/.env` — any service using the old key
- `DEPLOYMENTS.md` (this file) — update Treasury and Oracle fields with new address
- Notify Avalanche Foundation grants team of the new confirmed admin wallet

---

### New Admin Wallet (Post-Migration)

**Admin / Treasury:** `0xd84e458e84AD7d16F436c1e2e34e8A2eE462d5B9`
**Migration date:** 2026-05-22 *(pending execution)*
**Migration scripts:** `scripts/migrate-all-contracts.js`, `scripts/migrate-original-contracts.js`, `scripts/finish-migration-new-wallet.js`, `scripts/migrate-positions.js`, `scripts/cleanup-positions.js`

---

## Migration Execution Results — 2026-05-22

### Summary

All four mainnet contracts successfully migrated to new clean admin wallet `0xd84e458e84AD7d16F436c1e2e34e8A2eE462d5B9`. Both previously compromised wallets hold zero privileged roles across all contracts.

### Final Role State

| Contract | New Wallet Has All Roles | Old Admin (`0x05394029...`) | Orig Deployer (`0x8f0E9b15...`) |
|---|---|---|---|
| ViralityMarketV2 (active) | ✅ DEFAULT_ADMIN, ORACLE, ADMIN, KEEPER | ✅ All revoked | ✅ All revoked |
| ViralityMarketV2 (deprecated) | ✅ DEFAULT_ADMIN, ORACLE, ADMIN, KEEPER | ✅ All revoked | ✅ All revoked |
| MarketFactoryV2 | ✅ DEFAULT_ADMIN, ADMIN + treasury + oracle set | ✅ All revoked | ✅ All revoked |
| ViralityPositions | ✅ DEFAULT_ADMIN, MARKET, RESOLVER | ✅ All revoked | ✅ All revoked |

### Execution Notes

- **Root cause of multi-script execution:** The second admin wallet (`0x05394029...`) was only ever granted roles on ViralityMarketV2 (active) during the April 2026 migration — not on the other three contracts. The original deployer (`0x8f0E9b15...`) retained DEFAULT_ADMIN on the remaining contracts, requiring a separate fast-transfer pattern to defeat its active sweeper bot.
- **Sweeper bot active** on `0x8f0E9b15...` — all transactions to that wallet were fired at 150 gwei immediately upon balance detection, beating the bot on every run.
- **Gas constraint:** Each run was intentionally funded with the minimum AVAX needed (0.02–0.05 AVAX) to limit exposure. Some batches required re-runs due to mid-batch gas exhaustion; role checks at script start ensured idempotency.
- **setOracle on factory** required a dedicated re-run after the initial batch ran out of gas; confirmed at block 86073556.
- **ViralityPositions** required two-phase execution: sweeper wallet granted DEFAULT_ADMIN + MARKET_ROLE (blocks 86073813), then new wallet completed RESOLVER_ROLE grant and final DEFAULT_ADMIN revoke (block 86073934).

### Verified On-Chain

| Action | Block | Tx |
|---|---|---|
| [Factory] setTreasury → new wallet | 86073556 | `0xb020e80b...` |
| [Factory] setOracle → new wallet | 86073556 | `0xa6014843...` |
| [Positions] Grant DEFAULT_ADMIN → new wallet | 86073813 | `0xbfde562a...` |
| [Positions] Grant MARKET_ROLE → new wallet | 86073813 | `0xc22a8cd6...` |
| [Positions] Grant RESOLVER_ROLE → new wallet | 86073934 | `0x355caeb8...` |
| [Positions] Revoke DEFAULT_ADMIN from orig deployer | 86073934 | `0x80c84684...` |
