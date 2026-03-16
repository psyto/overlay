# Regime-Adaptive Leverage

Leveraged JitoSOL loop on Kamino with dynamic leverage driven by multi-dimensional signal detection and volatility regime classification.

## How It Works

1. Deposit JitoSOL on Kamino (Jito market, eMode)
2. Borrow SOL against JitoSOL collateral
3. Mint more JitoSOL with borrowed SOL
4. Repeat until target leverage reached
5. Keeper adjusts leverage every 30 minutes based on regime

The regime is determined by two inputs:

- **Volatility regime** (backward-looking): Parkinson estimator on SOL hourly candles
- **Signal severity** (forward-looking): 4-dimensional anomaly detection on Drift markets

## Keeper Loop

```
Every 30s:  Emergency checks (LTV, drawdown, signal severity)
Every 5min: Signal detection (OI shift, liquidation cascade, funding vol, spread)
Every 10min: Vol estimation update
Every 30min: Rebalance loop leverage to match regime target
```

## Composed From

| Module | Source | Purpose |
|--------|--------|---------|
| Signal detector | Yogi (`drift-signal-detector.ts`) | 4D anomaly scoring |
| Regime engine | Yogi (`regime-engine.ts`) | Vol × severity → leverage matrix |
| Vol estimator | Kuma (`leverage-controller.ts`) | Parkinson on SOL candles |
| Health monitor | Kuma (`health-monitor.ts`) | LTV + drawdown checks |
| Pre-extreme wind-down | Arashi | Early deleverage at 65% vol |
| Loop manager | New | Kamino-specific loop operations |

## Configuration

Key parameters in `src/config/vault.ts`:

- `targetLtvPct`: Conservative LTV cap (default: 80%, eMode allows 95%)
- `loopLeverageMatrix`: Regime × severity → target leverage
- `preExtremeWindDownVolBps`: Early deleverage threshold (6500 bps)
- `enableDriftHedge`: Optional SOL short for delta-neutral mode

## Risk Model

- JitoSOL/SOL depeg is the primary risk at high leverage
- At 3x leverage, a 1.5% depeg causes ~4.5% equity loss
- Strategy stays at 1x during extreme vol to avoid this
- Emergency unwind triggers at 92% LTV or 10% drawdown
