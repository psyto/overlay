# Regime-Adaptive Leverage / Directional Sizing

Two approaches to using the 4D signal detection + vol regime engine for yield:

## Approach 1: Directional Sizing (Recommended)

Regime-based SOL allocation — no Kamino loop, just adjust SOL vs USDC weighting.

- **Bull-friendly**: more SOL in calm markets, more USDC in volatile
- **Simple**: no leverage, no liquidation risk, minimal costs
- **Backtest**: +27%, 9.5% annualized, $443 costs over 3 years

| Regime | Signal Clear | Signal High | Signal Critical |
|--------|-------------|------------|-----------------|
| veryLow | 80% SOL | 40% SOL | 0% SOL |
| low | 60% SOL | 30% SOL | 0% SOL |
| normal | 40% SOL | 20% SOL | 0% SOL |
| high | 20% SOL | 10% SOL | 0% SOL |
| extreme | 0% SOL | 0% SOL | 0% SOL |

## Approach 2: Kamino Leverage Loop (Not Recommended)

Leveraged JitoSOL loop on Kamino with dynamic leverage.

**Why it underperforms**: The JitoSOL/SOL spread (~3.5% net) is too thin. After borrow rate fluctuation (4-12% depending on vol), rebalance costs, and depeg events, the loop barely beats simple 1x staking (+13% vs +12.7% over 3 years). The regime engine correctly stays near 1x in high-vol environments, which makes the loop pointless.

| Strategy | Return | Ann. Return | Max DD |
|----------|--------|-------------|--------|
| SOL buy & hold | +266% | 63.1% | 70.2% |
| 1x JitoSOL | +13% | 4.6% | 2.3% |
| Fixed 3x loop | -11% | -4.5% | 15.0% |
| Adaptive loop | +13% | 4.7% | 2.3% |
| **Directional sizing** | **+27%** | **9.5%** | **11.8%** |

## Signal Detection (Shared)

Both approaches use the same 4D anomaly detector from Yogi:

1. **OI Imbalance Shift** — rapid long/short ratio change
2. **Liquidation Cascade** — sudden OI drop (forced selling proxy)
3. **Funding Rate Volatility** — unstable funding = regime transition
4. **Spread Blow-out** — mark/oracle divergence = stress

## Composed From

| Module | Source | Purpose |
|--------|--------|---------|
| Signal detector | Yogi pattern | 4D anomaly scoring |
| Regime engine | Yogi pattern | Vol × severity → allocation matrix |
| Vol estimator | Kuma pattern | Parkinson on SOL candles |
| Health monitor | Kuma pattern | LTV + drawdown (loop only) |
| Pre-extreme wind-down | Arashi pattern | Early deleverage at 65% vol |
| Kamino loop | @overlay/kamino-client | Deposit/borrow/repay (loop only) |
