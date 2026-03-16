# JLP Trend-Aware Delta Hedge

Hold JLP for fee yield from Jupiter perpetual traders, with trend-aware delta hedging via Drift perps to reduce drawdowns without sacrificing bull market upside.

## How It Works

1. Deposit USDC into JLP (earns ~25% APY from Jupiter perp fees)
2. JLP has basket exposure: SOL 44%, ETH 10%, BTC 11%, stables 35%
3. Keeper detects market trend (bull/bear/range) from SMA crossover
4. In bear/range: short SOL, ETH, BTC on Drift proportional to basket weights
5. In bull: disable delta hedge, let JLP run with full upside

## Why Trend-Aware

Static delta hedging (always short) destroys returns in a bull market — backtested at -58% over 3 years. Trend-aware hedging captures the upside during bull markets while protecting during bear/range.

| Strategy | 3yr Return | Max Drawdown | Sharpe |
|----------|-----------|--------------|--------|
| JLP unhedged | +225% | 50.6% | 1.02 |
| JLP + always delta | -59% | 68.9% | -1.00 |
| **JLP + trend-aware** | **+271%** | **38.5%** | **1.30** |

## Keeper Loop

```
Every 30s:  Emergency checks (signal severity, delta drift)
Every 5min: Signal detection (4D anomaly from Drift data)
Every 10min: Vol estimation + JLP position sync + Greeks update
Every 30min: Full rebalance (delta hedge + gamma hedge adjustment)
```

## Composed From

| Module | Source | Purpose |
|--------|--------|---------|
| Signal detector | Yogi (`drift-signal-detector.ts`) | 4D anomaly scoring |
| Vol estimator | Kuma (`leverage-controller.ts`) | Parkinson on SOL candles |
| Hedge sizer | New | Vol regime × signal → VolSwap notional |
| Greeks tracker | Tensor pattern | Portfolio delta/gamma/vega monitoring |
| Delta hedging | Drift SDK via `@overlay/shared` | Per-asset shorts on Drift perps |
| Gamma hedging | Sigma VolSwap (when deployed) | Long variance position |
| JLP client | `@overlay/jlp-client` | Pool state, basket weights, deposit/withdraw |

## Trend Detection

Uses 30-day and 60-day simple moving averages:

- **Bull:** Price > SMA30, SMA30 > SMA60, SMA30 rising → delta hedge OFF
- **Bear:** Price < SMA30, SMA30 < SMA60 → delta hedge ON
- **Range:** Everything else → delta hedge ON

## Configuration

Key parameters in `src/config/vault.ts`:

- `defaultBasketWeights`: JLP basket allocation (updates from pool state)
- `maxPortfolioDelta`: Rebalance threshold (default: 10%)
- `hedgeRatioByRegime`: Gamma hedge sizing by vol regime
- `signalHedgeBoost`: Multiply hedge ratio on anomaly signals
