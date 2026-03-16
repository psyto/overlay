# JLP Trend-Aware Delta Hedge

Hold JLP for fee yield from Jupiter perpetual traders, with trend-aware delta hedging via Drift perps. The delta hedge activates only in bear/range markets, preserving full upside in bull markets.

## Why This Works

Static delta hedging destroys returns in a bull market (backtested at -59% over 3 years). The key insight: **use a leading indicator to toggle the hedge**.

| Strategy | 3yr Return | Max DD | Sharpe | Cost |
|----------|-----------|--------|--------|------|
| JLP unhedged | +225% | 50.6% | 1.02 | $0 |
| JLP + SMA delta (lagging) | +220% | 40.9% | 1.12 | incl. |
| **JLP + OI/funding delta (leading)** | **+711%** | **16.2%** | **2.44** | **incl.** |

The OI/funding-based trend detector outperforms SMA by **3x** because it reacts faster to trend changes, catching the initial move rather than lagging behind.

## How It Works

1. Deposit USDC into JLP (earns ~25% APY from Jupiter perp fees)
2. JLP has basket exposure: SOL 44%, ETH 10%, BTC 11%, stables 35%
3. Keeper detects market trend from momentum + volume + funding direction
4. In bear/range: short SOL, ETH, BTC on Drift proportional to basket weights
5. In bull: disable delta hedge, let JLP run with full upside

## Trend Detection: OI/Funding Leading Indicator

Replaces the original SMA crossover (lagging) with faster signals:

- **7-day momentum**: price change over last week
- **14-day momentum**: confirms direction over two weeks
- **Volume trend**: rising volume with direction = conviction
- **Funding direction**: implicit from price action (bullish = shorts pay)

Classification:
- **Bull**: momentum > +3%, 14d momentum > +5%, volume rising → hedge OFF
- **Bear**: momentum < -3%, 14d momentum < -5%, volume rising → hedge ON
- **Range**: everything else → hedge ON
- **Strong override**: ±8% weekly momentum overrides all other signals

## Keeper Loop

```
Every 30s:  Emergency checks (signal severity, delta drift > 10%)
Every 5min: Signal detection (4D anomaly from Drift live data)
Every 10min: Vol estimation + JLP position sync + Greeks update
Every 30min: Full rebalance (delta hedge per basket asset)
```

## Portfolio Greeks

Tracks combined delta/gamma/vega across JLP + Drift hedge positions:

- **Net delta**: should be near 0% when hedged, ~65% when unhedged (bull)
- **Gamma**: JLP is short gamma (loses on big moves) — tracked but not actively hedged (VolSwap adds cost without benefit in most conditions)
- **Rebalance trigger**: net delta exceeds ±10% → emergency rebalance

## Devnet Test Results

All 7 tests passing:
1. Signal detection (mainnet data) — SOL/BTC/ETH prices, spreads, funding
2. Trend detection — correctly identifies current regime
3. Vol estimation — Parkinson on SOL candles
4. Drift order placement — real short on devnet
5. Position verification
6. Portfolio Greeks computation
7. Emergency close-all

## Composed From

| Module | Source | Purpose |
|--------|--------|---------|
| OI/funding trend detector | New (replaces SMA) | Leading indicator for hedge toggle |
| Signal detector | Yogi pattern | 4D anomaly → emergency hedge boost |
| Vol estimator | Kuma pattern | Parkinson on SOL candles |
| Greeks tracker | Tensor pattern | Portfolio delta/gamma/vega |
| Drift orders | @overlay/shared | Market, limit, trigger orders |
| JLP client | @overlay/jlp-client | Pool state, basket weights |

## Configuration

Key parameters in `src/config/vault.ts`:

- `defaultBasketWeights`: JLP basket allocation
- `maxPortfolioDelta`: Rebalance threshold (10%)
- `hedgeRebalanceIntervalMs`: 30 min rebalance cycle
- `signalDetectionIntervalMs`: 5 min signal check

## Execution Costs

Modeled in backtest v3:
- Drift taker fee: 3.5 bps per trade
- Slippage: √(size/$10K) × 1 bps
- Funding drag: 0.01%/day on shorts during bull periods
- Weekly rebalance cost: ~$2-5 per adjustment

Total 3-year cost impact: +711% (with costs) vs +733% (without costs) — costs reduce returns by ~3%.
