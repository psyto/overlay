# Backtests

Version 3 backtests with realistic execution costs, OI-based signals, and gap risk modeling.

## Data

- **Source:** Drift Data API (`data.api.drift.trade`)
- **Range:** 1000 daily candles (Jun 2023 — Mar 2026, ~2.7 years)
- **SOL price range:** $15.99 — $261.57
- **Volatility:** Parkinson estimator, 30-day rolling window

## Running

```bash
npx ts-node backtests/src/jlp-gamma-hedge-backtest.ts
npx ts-node backtests/src/regime-leverage-backtest.ts
npx ts-node backtests/src/liquidation-density-backtest.ts
```

Each outputs a comparison table and exports a CSV to the backtests directory.

## Execution Cost Model (`execution-costs.ts`)

| Cost | Model | Rationale |
|------|-------|-----------|
| Drift taker fee | 3.5 bps | Per Drift fee schedule |
| Slippage | √(size/$10K) × 1 bps | Sqrt model for deep orderbooks |
| Jito tips | ~$0.01/bundle | 0.0001 SOL × price |
| Priority fees | ~$0.005/tx | 50K microlamports |
| Funding drag | 0.01%/day (shorts in bull) | Asymmetric: shorts pay in bull, receive in bear |
| Kamino borrow | 1.5-12% (by vol regime) | Correlated with market utilization |

## v3 Improvements Over v2

1. **Execution costs** modeled for all strategies (v2 assumed ideal execution)
2. **OI/funding leading indicator** replaces SMA crossover for JLP hedge
3. **Directional sizing** added as alternative to Kamino loop
4. **Gap risk** modeled for liquidation density (SL slips in flash crashes)
5. **Depeg events** modeled for regime-leverage (probability + severity by vol regime)
6. **Variable borrow rates** correlated with vol regime (not fixed 4%)

## Strategy-Specific Notes

### JLP Delta Hedge
- JLP fee yield: 25% APY (conservative)
- Basket: 65% non-stable, modeled via SOL price proxy
- Gamma loss: -0.5 × basket_weight × daily_return²
- OI/funding trend: 7d/14d momentum + volume trend
- VolSwap: weekly epochs, 4% premium, 2x payout cap (tested but not recommended)

### Regime-Adaptive Leverage / Directional Sizing
- JitoSOL/SOL depeg: 0-2% probability per day by vol regime, 0.1-1.5% severity
- Borrow rate: 1.5% (veryLow) to 12% (extreme)
- Directional sizing: SOL allocation 0-80% by regime, halved on high signal severity
- Rebalance cost: only when allocation changes > 10%, weekly cap

### Liquidation Density
- Synthetic clusters from swing highs/lows + round numbers (score 1-5)
- Density filter: score ≥ 4
- TP: 5%, SL: 2%, max hold: 5 days, cooldown: 5 days
- Gap risk: if daily range > 8%, SL slips by 50% of excess range
- Max 1 concurrent trade (down from 3 — correlation risk)
- Vol-based sizing: 30-70% of max depending on regime
