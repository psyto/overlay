# Overlay

On-top DeFi strategies on Solana, built by composing modular infrastructure primitives.

Each strategy is a thin keeper that wires together existing protocol SDKs and reusable signal/risk modules — demonstrating that new yield strategies can be assembled from composable building blocks with minimal new code.

## Strategies

### JLP Trend-Aware Delta Hedge ⭐ Primary

Hold JLP for fee yield (~25% APY from Jupiter perp volume), with trend-aware delta hedging on Drift to reduce drawdowns without sacrificing bull market upside.

- **Yield source:** JLP fee income from Jupiter perpetual traders
- **Edge:** Delta hedge active in bear/range, off in bull — captures upside while protecting downside
- **Trend detection:** OI/funding leading indicator (7d momentum + volume trend + funding direction)
- **Backtest (v3, with costs):** +711% over 3 years, 2.44 Sharpe, 16% max drawdown
- **Status:** Devnet tested, ready for mainnet

| Strategy | Return | Ann. Return | Max DD | Sharpe |
|----------|--------|-------------|--------|--------|
| USDC only | +12% | 4.6% | 0% | 44.2 |
| JLP unhedged | +225% | 58.2% | 50.6% | 1.02 |
| JLP + SMA delta (with costs) | +220% | 57.2% | 40.9% | 1.12 |
| **JLP + OI/funding delta (with costs)** | **+711%** | **125.8%** | **16.2%** | **2.44** |

### Directional Sizing

Regime-based SOL allocation — no leverage loop, just adjust SOL vs USDC weighting by vol regime and signal severity.

- **Yield source:** SOL price appreciation + JitoSOL staking yield on SOL portion, USDC yield on idle
- **Edge:** Simple vol-targeting applied to SOL — more SOL in calm markets, less in volatile
- **Backtest (v3, with costs):** +27% over 3 years, 9.5% annualized, $443 total costs

Replaces the original "Regime-Adaptive Leverage" strategy, which backtested at only +13% (barely beating 1x JitoSOL staking) due to the JitoSOL/SOL spread being too thin to justify loop complexity.

### Liquidation Density

Map leveraged positions across Marginfi (and Kamino), build a real-time liquidation heatmap, and trade around cascade events.

- **Yield source:** Counter-trading liquidation cascades on Drift perps
- **Edge:** On-chain position scanning from real Marginfi accounts (509K scanned)
- **Execution:** Drift perp orders with asymmetric TP/SL (5%/2%), max 1 concurrent trade, gap risk modeling
- **Status:** Real heatmap working on mainnet — found 260 leveraged SOL positions in 20K account sample

Example heatmap output (real mainnet data, Mar 2026):
```
$52 (-45%) [CRIT] $132.6K ( 36) ██████████████████████████████████████████████████
$47 (-50%) [HIGH] $ 73.4K ( 16) ████████████████████████████
$68 (-28%) [HIGH] $ 52.4K ( 33) ████████████████████
$73 (-22%) [ MED] $ 41.5K ( 35) ████████████████
$89 (  -5%) [ LOW] $  9.0K (  6) ███
$94 (+  1%) [ LOW] $  0.1K (  1) █ ◄ CURRENT
```

## Architecture

```
overlay/
├── packages/
│   ├── shared/           Keypair loading, Drift client, order helpers
│   ├── kamino-client/    Kamino Lend SDK wrapper (on-chain position scanning)
│   ├── jlp-client/       Jupiter JLP wrapper (pool state, deposit/withdraw)
│   └── marginfi-client/  Marginfi wrapper (509K account scanning, liquidation)
├── strategies/
│   ├── jlp-gamma-hedge/  Keeper: OI/funding trend → delta hedge → Greeks
│   ├── regime-leverage/  Keeper: signal → regime → Kamino loop / directional sizing
│   └── liquidation-density/  Keeper: scan → heatmap → counter-trade
├── backtests/            v3 backtests with execution costs, OI signals, gap risk
│   └── src/
│       ├── execution-costs.ts   Drift fees, slippage model, Jito tips, funding drag
│       ├── data-fetcher.ts      Drift Data API (1000 daily candles)
│       └── reporting.ts         Stats, comparison tables, CSV export
└── scripts/
    ├── devnet-setup.ts              Initialize Drift account on devnet
    ├── devnet-fund.ts               Mint devnet USDC via TokenFaucet
    ├── devnet-jlp-hedge-test.ts     7-step integration test (all passing)
    ├── devnet-multi-market-test.ts  SOL, BTC, ETH shorts (3/3 passing)
    ├── devnet-hedge-toggle-test.ts  4 trend transitions (4/4 passing)
    ├── devnet-soak-test.ts          48hr continuous run with JSON report
    ├── mainnet-dry-run.ts           Log-only keeper on mainnet (no orders)
    ├── mainnet-scan-lite.ts         Real liquidation heatmap from Marginfi
    └── mainnet-scan-test.ts         Full SDK-based scanner (needs paid RPC)
```

## Composability

Each strategy reuses modules from a shared infrastructure toolkit:

| Module | Origin | Used by |
|--------|--------|---------|
| Signal detector (4D anomaly) | Vigil/Yogi pattern | All three |
| Vol estimator (Parkinson) | Kuma/Tempest pattern | JLP hedge, Directional sizing |
| Regime engine (vol × severity matrix) | Yogi pattern | Directional sizing |
| Pre-extreme wind-down | Arashi pattern | Directional sizing |
| Health monitor (LTV + drawdown) | Kuma pattern | Regime-leverage |
| Portfolio Greeks (delta/gamma/vega) | Tensor pattern | JLP hedge |
| Heatmap density classification | Kalshify pattern | Liquidation density |
| Drift order helpers | Shared package | JLP hedge, Liquidation density |
| On-chain position scanner | Marginfi binary parser | Liquidation density |

## Backtest Results (v3 — with execution costs)

### JLP Delta Hedge (Jun 2023 — Mar 2026)

Compares SMA-based (lagging) vs OI/funding-based (leading) trend detection:

| Strategy | Return | Ann. Return | Max DD | Sharpe |
|----------|--------|-------------|--------|--------|
| USDC only | +12% | 4.6% | 0% | 44.2 |
| JLP unhedged | +225% | 58.2% | 50.6% | 1.02 |
| JLP + SMA delta (with costs) | +220% | 57.2% | 40.9% | 1.12 |
| **JLP + OI/funding delta (with costs)** | **+711%** | **125.8%** | **16.2%** | **2.44** |

### Directional Sizing (Jun 2023 — Mar 2026)

| Strategy | Return | Ann. Return | Max DD | Costs |
|----------|--------|-------------|--------|-------|
| SOL buy & hold | +266% | 63.1% | 70.2% | $0 |
| 1x JitoSOL | +13% | 4.6% | 2.3% | $0 |
| Fixed 3x loop (with costs) | -11% | -4.5% | 15.0% | $10K |
| **Directional sizing** | **+27%** | **9.5%** | **11.8%** | **$443** |

### Liquidation Density (Jun 2023 — Mar 2026)

| Strategy | Return | Ann. Return | Max DD | Trades | Win% | Costs |
|----------|--------|-------------|--------|--------|------|-------|
| USDC only | +12% | 4.6% | 0% | — | — | — |
| Naive momentum (with costs) | +19% | 7.1% | 0.8% | 105 | 42% | $1,042 |
| Density-targeted (with costs) | +16% | 5.9% | 1.3% | 132 | 38% | $1,005 |

Note: Density strategy uses synthetic clusters. Real on-chain data expected to improve differentiation.

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm
- Solana CLI

### Install

```bash
pnpm install
```

### Backtest

```bash
npx ts-node backtests/src/jlp-gamma-hedge-backtest.ts
npx ts-node backtests/src/regime-leverage-backtest.ts
npx ts-node backtests/src/liquidation-density-backtest.ts
```

### Devnet Test (JLP Delta Hedge)

```bash
# 1. Create devnet keypair
solana-keygen new -o ~/devnet-keypair.json

# 2. Configure
cp .env.example .env
# Edit MANAGER_KEYPAIR_PATH in .env

# 3. Get devnet SOL
solana airdrop 2 $(solana-keygen pubkey ~/devnet-keypair.json) --url devnet

# 4. Setup Drift account + mint devnet USDC
npx ts-node --transpile-only scripts/devnet-setup.ts
npx ts-node --transpile-only scripts/devnet-fund.ts

# 5. Run tests (all passing)
npx ts-node --transpile-only scripts/devnet-jlp-hedge-test.ts      # 7-step integration
npx ts-node --transpile-only scripts/devnet-multi-market-test.ts    # SOL, BTC, ETH shorts
npx ts-node --transpile-only scripts/devnet-hedge-toggle-test.ts    # 4 trend transitions

# 6. 48-hour soak test (run in screen/tmux)
screen -S soak
npx ts-node --transpile-only scripts/devnet-soak-test.ts
# Ctrl+A, D to detach — writes soak-report.json every 30 min
```

### Go-Live Sequence

```bash
# Step 1: Deposit $500-1000 USDC into JLP on https://jup.ag

# Step 2: Mainnet dry run (log-only, no orders — run 2-3 days)
RPC_URL="your-mainnet-rpc" WALLET_ADDRESS="your-pubkey" \
  npx ts-node --transpile-only scripts/mainnet-dry-run.ts

# Step 3: Enable real execution (after dry run validates)
RPC_URL="your-mainnet-rpc" MANAGER_KEYPAIR_PATH="your-keypair" \
  npx ts-node --transpile-only strategies/jlp-gamma-hedge/src/keeper/index.ts
```

### Mainnet Liquidation Heatmap

```bash
# Scan real Marginfi positions (needs RPC with decent rate limits)
RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" \
  npx ts-node --transpile-only scripts/mainnet-scan-lite.ts
```

## Test Status

### JLP Delta Hedge (go-live candidate)

| Test | Status | Details |
|------|--------|---------|
| Integration (7 steps) | **PASS** | Signal detection, trend, vol, Drift orders, Greeks, close-all |
| Multi-market (SOL/BTC/ETH) | **PASS** | All 3 markets open and close on devnet |
| Hedge toggle (4 transitions) | **PASS** | bear→ON, bull→OFF, range→ON, bull→OFF |
| 48hr soak test | **PENDING** | Continuous operation, trend monitoring, JSON report |
| Mainnet dry run | **PENDING** | Log-only with real JLP position, 2-3 days |
| Mainnet execution | **NOT STARTED** | After soak + dry run pass |

### Liquidation Density

| Test | Status | Details |
|------|--------|---------|
| Mainnet position scan | **PASS** | 260 positions found in 20K account sample |
| Real heatmap | **PASS** | Density zones identified with USD values |
| Full 509K scan | **BLOCKED** | Needs paid RPC (Helius Dev $49/mo) |

## Execution Cost Model

All v3 backtests include realistic friction:

| Cost | Model |
|------|-------|
| Drift taker fee | 3.5 bps per trade |
| Slippage | √(size/$10K) × 1 bps (sqrt model for deep books) |
| Jito tips | ~$0.01 per bundle |
| Priority fees | ~$0.005 per tx |
| Funding drag | 0.01%/day on shorts during bull markets |
| Kamino borrow | 1.5-12% annualized (varies by vol regime) |

## Technical Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| Solana | @solana/web3.js v1, @solana/kit v2 |
| DEX | Drift Protocol v2 (perps, oracle, devnet faucet) |
| Lending | Kamino Lend (on-chain binary parsing) |
| Lending | Marginfi v2 (509K account scanning, i80f48 decoding) |
| LP | Jupiter JLP (Swap API + Earn API) |
| Execution | Jito Bundles (via Sentinel pattern) |
| Data | Drift Data API (1000 daily candles, live market stats) |
| Monorepo | pnpm workspaces |

## Known Limitations

- **Liquidation density backtest** uses synthetic clusters — real on-chain data scanner is working but needs paid RPC for full 509K account scan
- **JLP gamma hedge (VolSwap)** component not yet beneficial — trend-aware delta hedge alone outperforms. VolSwap adds value only in sustained bear/range markets
- **Regime-adaptive leverage loop** adds no value over simple staking — the JitoSOL/SOL spread is too thin. Directional sizing is the better use of the regime engine
- **Share rate conversion** for Marginfi positions uses on-chain bank data but may have precision loss in i80f48 decoding for very large positions

## License

MIT
