# Liquidation Density

Map leveraged positions across Kamino and Marginfi, build a liquidation heatmap, and trade around cascade events using Drift perps.

## How It Works

1. Scan Kamino and Marginfi for leveraged positions
2. Compute liquidation prices for each position
3. Build a price-bucketed heatmap showing where liquidations cluster
4. When price approaches a dense zone, counter-trade the expected cascade
5. Execute via Drift perps with take-profit and stop-loss triggers

## Execution Modes

**Counter-trade (default):** Short into a downward cascade (or long into a short squeeze), close after the flush. TP: 3%, SL: 1.5%.

**Liquidity provision:** Place Drift limit orders at cascade levels to buy the forced selling at a discount with maker rebates.

**Liquidator:** Directly call liquidate on unhealthy Kamino/Marginfi positions for the 5% liquidation discount.

## Keeper Loop

```
Every 15s:  Emergency checks (price movement, drawdown, critical zones)
Every 1min: Heatmap update + trigger check
Every 2min: Position scan (Kamino + Marginfi)
```

Tighter timing than other strategies — liquidation cascades happen fast.

## Composed From

| Module | Source | Purpose |
|--------|--------|---------|
| Position scanner | Tensor margin math pattern | Liquidation price computation |
| Heatmap builder | Kalshify severity pattern | Density classification |
| Multi-source validation | Vigil multi-reporter pattern | Consensus from multiple RPCs |
| Executor | Drift SDK via `@overlay/shared` | Market + trigger orders |
| Atomic execution | Sentinel Jito Bundle pattern | Bundle entry + TP + SL atomically |
| Kamino scanning | `@overlay/kamino-client` | Obligation reading |
| Marginfi scanning | `@overlay/marginfi-client` | Account scanning + liquidation |

## Heatmap

Positions are grouped into price buckets (0.5% width, ±20% range from current price):

| Density | Threshold | Meaning |
|---------|-----------|---------|
| Low | < $500K | Not actionable |
| Medium | $500K+ | Watch zone |
| High | $2M+ | Prepare to trade |
| Critical | $5M+ | Immediate action |

## Configuration

Key parameters in `src/config/vault.ts`:

- `triggerProximityPct`: How close price must be to dense zone (default: 2%)
- `counterTradeMaxSizeUsd`: Max per-trade size (default: $50K)
- `maxConcurrentTrades`: Concurrent trade limit (default: 3)
- `counterTradeTakeProfitPct / StopLossPct`: 3% / 1.5% (asymmetric)
- `jitoRegion`: Jito Block Engine region for lowest latency (default: tokyo)

## Limitations

The backtest uses synthetic liquidation clusters generated from price support/resistance levels. Real on-chain position data from Kamino/Marginfi would significantly improve signal quality. The strategy becomes meaningfully differentiated from naive momentum trading only with real position scanning.
