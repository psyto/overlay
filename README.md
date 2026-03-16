# Overlay

On-top DeFi strategies on Solana, built by composing modular infrastructure primitives.

Each strategy is a thin keeper that wires together existing protocol SDKs and reusable signal/risk modules — demonstrating that new yield strategies can be assembled from composable building blocks with minimal new code.

## Strategies

### Regime-Adaptive Leverage

Leveraged JitoSOL loop on Kamino with dynamic leverage driven by multi-dimensional signal detection and volatility regime classification.

- **Yield source:** JitoSOL staking (~7.5%) amplified by Kamino eMode leverage loop
- **Edge:** Leverage scales inversely with risk — high in calm markets, low in volatile ones
- **Signal detection:** 4-dimensional anomaly scoring (OI shift, liquidation cascade, funding volatility, spread blow-out)
- **Safety:** Pre-extreme wind-down deleverages early at 65% vol before regime flips

| Regime | Signal Clear | Signal Low | Signal High | Signal Critical |
|--------|-------------|-----------|-------------|-----------------|
| veryLow | 3.5x | 3.0x | 2.0x | 1.0x |
| low | 3.0x | 2.5x | 1.5x | 1.0x |
| normal | 2.5x | 2.0x | 1.5x | 1.0x |
| high | 1.5x | 1.0x | 1.0x | 1.0x |
| extreme | 1.0x | 1.0x | 1.0x | 1.0x |

### JLP Trend-Aware Delta Hedge

Hold JLP for fee yield (~25% APY from Jupiter perp volume), with trend-aware delta hedging on Drift to reduce drawdowns.

- **Yield source:** JLP fee income from Jupiter perpetual traders
- **Edge:** Delta hedge active in bear/range markets, disabled in bull — captures upside while reducing downside
- **Trend detection:** 30/60-day SMA crossover classifies bull/bear/range
- **Backtest:** +270% over 3 years with 1.30 Sharpe (vs +225% unhedged with 1.02 Sharpe)

### Liquidation Density

Map leveraged positions across Kamino and Marginfi, build a liquidation heatmap, and trade around cascade events.

- **Yield source:** Counter-trading liquidation cascades (short into forced selling, close after flush)
- **Edge:** On-chain position scanning identifies where cascades will trigger before they happen
- **Execution:** Drift perp orders with take-profit/stop-loss triggers, Jito Bundles for atomicity
- **Risk:** Asymmetric TP/SL (3% / 1.5%), max 3 concurrent trades, vol-based position sizing

## Architecture

```
overlay/
├── packages/
│   ├── shared/           Keypair loading, Drift client, order helpers
│   ├── kamino-client/    Kamino Lend SDK wrapper (loop mgmt, position scanning)
│   ├── jlp-client/       Jupiter JLP wrapper (pool state, deposit/withdraw)
│   └── marginfi-client/  Marginfi wrapper (position scanning, liquidation)
├── strategies/
│   ├── regime-leverage/  Keeper: signal → regime → Kamino loop adjustment
│   ├── jlp-gamma-hedge/  Keeper: trend → delta hedge → Greeks monitoring
│   └── liquidation-density/  Keeper: scan → heatmap → counter-trade
├── backtests/            3-year daily backtests with comparison tables + CSV
└── scripts/              Devnet setup, funding, and integration tests
```

## Composability

Each strategy reuses modules from a shared infrastructure toolkit:

| Module | Origin | Used by |
|--------|--------|---------|
| Signal detector (4D anomaly) | Vigil/Yogi pattern | All three |
| Vol estimator (Parkinson) | Kuma/Tempest pattern | regime-leverage, jlp-gamma-hedge |
| Regime engine (vol × severity matrix) | Yogi pattern | regime-leverage |
| Pre-extreme wind-down | Arashi pattern | regime-leverage |
| Health monitor (LTV + drawdown) | Kuma pattern | regime-leverage |
| Portfolio Greeks (delta/gamma/vega) | Tensor pattern | jlp-gamma-hedge |
| Heatmap density classification | Kalshify pattern | liquidation-density |
| Drift order helpers | Shared package | jlp-gamma-hedge, liquidation-density |
| Jito Bundle execution | Sentinel pattern | liquidation-density |

## Backtest Results (Jun 2023 — Mar 2026)

### Regime-Adaptive Leverage

| Strategy | Return | Ann. Return | Max DD | Sharpe |
|----------|--------|-------------|--------|--------|
| 1x JitoSOL | +12.7% | 4.6% | 2.3% | 0.01 |
| Fixed 2x | +3.7% | 1.4% | 6.2% | -0.93 |
| Fixed 3x | -4.7% | -1.8% | 12.2% | -1.24 |
| **Regime-adaptive** | **+13.0%** | **4.7%** | **2.3%** | **0.08** |

### JLP Trend-Aware Delta Hedge

| Strategy | Return | Ann. Return | Max DD | Sharpe |
|----------|--------|-------------|--------|--------|
| USDC only | +12.3% | 4.6% | 0.0% | 44.2 |
| JLP unhedged | +224.6% | 58.1% | 50.6% | 1.02 |
| JLP + always delta | -58.6% | -29.0% | 68.9% | -1.00 |
| **JLP + trend-aware delta** | **+270.5%** | **66.4%** | **38.5%** | **1.30** |

### Liquidation Density

| Strategy | Return | Ann. Return | Max DD | Trades | Win% |
|----------|--------|-------------|--------|--------|------|
| USDC only | +12.3% | 4.6% | 0.0% | — | — |
| Naive momentum | +48.8% | 16.7% | 0.8% | 199 | 56% |
| **Density-targeted** | **+34.2%** | **12.1%** | **0.9%** | **192** | **55%** |

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
# Run all backtests
npx ts-node backtests/src/regime-leverage-backtest.ts
npx ts-node backtests/src/jlp-gamma-hedge-backtest.ts
npx ts-node backtests/src/liquidation-density-backtest.ts
```

### Devnet Test

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

# 5. Run integration test
npx ts-node --transpile-only scripts/devnet-jlp-hedge-test.ts
```

### Mainnet

```bash
# Edit .env with mainnet RPC and keypair
# Start the JLP trend-aware delta hedge keeper
npx ts-node --transpile-only strategies/jlp-gamma-hedge/src/keeper/index.ts
```

## Technical Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| Solana | @solana/web3.js v1, @solana/kit v2 |
| DEX | Drift Protocol v2 (perps, oracle) |
| Lending | Kamino Lend (@kamino-finance/klend-sdk) |
| Lending | Marginfi (@mrgnlabs/marginfi-client-v2) |
| LP | Jupiter JLP (Swap API + Earn API) |
| Execution | Jito Bundles (via Sentinel pattern) |
| Monorepo | pnpm workspaces |

## License

MIT
