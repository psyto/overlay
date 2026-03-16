# Liquidation Density

Map leveraged positions across Marginfi (and Kamino) in real-time, build a liquidation heatmap, and trade around cascade events using Drift perps.

## Real On-Chain Data

This strategy scans **real Marginfi accounts on mainnet** — not synthetic data.

From a 20K account sample (out of 509K total):
- **260 leveraged SOL positions** identified
- **$545K total collateral, $228K total debt**
- Critical density zone at **$52 (-45%)** with $133K at risk
- Only $13.6K within 10% of current price — no immediate cascade risk

With a full scan (paid RPC), expect ~6,500 positions and ~$14M tracked.

## How It Works

1. **Scan**: Read all Marginfi accounts via `getProgramAccounts` + batch `getMultipleAccountsInfo`
2. **Parse**: Decode binary layout (72-byte header + 16 × 104-byte balance entries + i80f48 share values)
3. **Convert**: Fetch bank share rates on-chain → shares to token amounts → USD at current SOL price
4. **Heatmap**: Group liquidation prices into 1% buckets, classify density (LOW/MED/HIGH/CRIT)
5. **Trade**: When price approaches a dense zone, counter-trade on Drift with TP/SL

## Binary Layout (discovered from mainnet)

```
MarginfiAccount (2312 bytes):
├── [0-7]    Discriminator
├── [8-39]   Group (Pubkey)
├── [40-71]  Authority (Pubkey)
└── [72+]    16 × Balance entries (104 bytes each):
             ├── [+0]    active (u8)
             ├── [+1]    bank_pk (Pubkey, 32 bytes)
             ├── [+33]   bank_asset_tag (u8)
             ├── [+34]   _pad (6 bytes)
             ├── [+40]   asset_shares (WrappedI80F48, 16 bytes)
             ├── [+56]   liability_shares (WrappedI80F48, 16 bytes)
             ├── [+72]   emissions_outstanding (16 bytes)
             ├── [+88]   last_update (u64, 8 bytes)
             └── [+96]   _padding (8 bytes)

Bank accounts (1864 bytes):
├── [8]      mint (Pubkey)
├── [328]    asset_share_value (WrappedI80F48) — converts shares to tokens
└── [344]    liability_share_value (WrappedI80F48)
```

## Real Bank Addresses (mainnet)

| Token | Bank Address |
|-------|-------------|
| SOL | `CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh` |
| USDC | `2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB` |
| JitoSOL | `Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8` |
| mSOL | `22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE` |
| bSOL | `6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K` |
| USDT | `HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV` |

## Execution

**Counter-trade (default):** Short into a downward cascade, close after flush.
- TP: 5%, SL: 2% (asymmetric — cascades give larger moves)
- Max 1 concurrent trade (correlation risk)
- 5-day cooldown between entries
- Vol-based sizing: reduced in high/extreme regimes

**Gap risk modeled:** If daily range > 8%, stop-loss slips by 50% of the excess.

## Backtest (v3, with costs)

| Strategy | Return | Ann. Return | Trades | Win% | Costs |
|----------|--------|-------------|--------|------|-------|
| USDC only | +12% | 4.6% | — | — | — |
| Naive momentum | +19% | 7.1% | 105 | 42% | $1,042 |
| Density-targeted | +16% | 5.9% | 132 | 38% | $1,005 |

Note: Backtest used synthetic clusters. Real on-chain data expected to improve differentiation significantly — the heatmap reveals actual position clustering that synthetic models miss.

## RPC Requirements

| Operation | Credits/call | Calls needed | Tier |
|-----------|-------------|-------------|------|
| Get all pubkeys | ~1 | 1 | Free |
| Batch fetch 100 accounts | ~1 | 5,092 (full scan) | Paid |
| Fetch 6 bank accounts | ~1 | 1 | Free |

Helius Developer ($49/mo, 1M credits/day) is sufficient for full scanning every 2 minutes.

## Composed From

| Module | Source | Purpose |
|--------|--------|---------|
| Position scanner | Marginfi binary parser (new) | Real on-chain position reading |
| Liquidation math | Tensor margin math pattern | Price at which LTV hits maintenance |
| Heatmap builder | Kalshify severity pattern | Density classification |
| Executor | Drift SDK via @overlay/shared | Counter-trade + trigger orders |
| Atomic execution | Sentinel Jito Bundle pattern | Bundle entry + TP + SL |

## Limitations

- **Share rate precision**: i80f48 decoding may lose precision for very large positions
- **Stale data**: positions change between scans (2 min interval) — cascades can happen faster
- **Backtest gap**: synthetic clusters don't capture real density patterns — re-backtest needed with real heatmap snapshots
- **Public RPC insufficient**: Helius free tier handles 20K accounts; full 509K scan needs paid tier
