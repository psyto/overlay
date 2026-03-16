# Backtests

3-year backtests (Jun 2023 — Mar 2026) using daily candles from Drift Data API.

## Running

```bash
# Individual
npx ts-node src/regime-leverage-backtest.ts
npx ts-node src/jlp-gamma-hedge-backtest.ts
npx ts-node src/liquidation-density-backtest.ts
```

Each backtest outputs a comparison table to the terminal and exports a CSV file for charting.

## Data Source

- **Price data:** Drift Data API (`data.api.drift.trade`) — 1000 daily candles
- **Volatility:** Parkinson estimator with 30-day rolling window
- **Signals:** Estimated from price moves, volume spikes, and intraday range

## Model Notes

**Regime-Adaptive Leverage:**
- JitoSOL/SOL depeg events simulated based on vol regime (probability + severity)
- Kamino borrow rate varies by vol regime (2-10%)
- Liquidation modeled when depeg exceeds margin-to-liquidation

**JLP Gamma Hedge:**
- JLP fee yield: 25% APY (conservative estimate)
- Basket exposure: 65% non-stable, modeled via SOL price proxy
- Gamma loss: -0.5 × basket_weight × daily_return² (JLP underperforms on big moves)
- Trend detection: 30/60-day SMA crossover
- VolSwap: weekly epochs, 4% premium, payout capped at 2x premium

**Liquidation Density:**
- Synthetic clusters from swing highs/lows + round numbers
- Density score 1-5 based on proximity and recency
- Asymmetric TP/SL: 3% / 1.5%, max 5-day hold
- Vol-based position sizing: reduced in high/extreme regimes
