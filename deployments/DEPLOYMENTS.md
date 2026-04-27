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
**Treasury:** `0x05394029EA22767D2283bcd0bE03B13353781212` *(updated 2026-04-27 — emergency admin migration)*
**Oracle:** `0x05394029EA22767D2283bcd0bE03B13353781212`
**Deployed:** 2026-04-02 · **Admin migrated:** 2026-04-27

---

## Configuration

- **Solidity:** 0.8.20 (optimizer 200 runs, viaIR)
- **Pricing Model:** LMSR (Logarithmic Market Scoring Rule)
- **Settlement:** Dual mode - Native AVAX + ERC-20 USDC
- **Fee:** 2% platform fee on trades
- **Min Bet (Native):** 0.001 AVAX
- **Min Bet (Token):** 1 USDC
- **Access Control:** OpenZeppelin AccessControl (ORACLE_ROLE, KEEPER_ROLE, ADMIN_ROLE)
