/**
 * Liquidation Density — Strategy Configuration
 *
 * Components composed from:
 * - Position scanning: Tensor margin math (liquidation price computation)
 * - Consensus: Vigil multi-reporter oracle (aggregation from multiple RPCs)
 * - Signal detection: Yogi (liquidation cascade dimension, extended)
 * - Anomaly classification: Kalshify (severity-based threshold pattern)
 * - Pre-execution simulation: Sentinel simulation sandbox
 * - Atomic execution: Sentinel Jito Bundle manager
 * - State storage: Stratum (efficient heatmap state, optional)
 */

export const STRATEGY_CONFIG = {
  // --- Position Scanning ---
  // Which protocols to scan for leveraged positions
  protocols: ["kamino", "marginfi"] as string[],

  // Minimum position size to track (USD)
  minPositionSizeUsd: 10_000,

  // Maximum positions to track per protocol
  maxPositionsPerProtocol: 500,

  // --- Liquidation Heatmap ---
  // Price buckets: group liquidation levels into bins
  priceBucketSizePct: 0.5,  // 0.5% price buckets
  heatmapRangePct: 20,      // ±20% from current price

  // Density threshold: minimum USD at a price level to consider "dense"
  minDensityUsd: 500_000,    // $500K+ at a single level
  highDensityUsd: 2_000_000, // $2M+ = high density
  criticalDensityUsd: 5_000_000, // $5M+ = critical

  // --- Trigger Logic ---
  // How close price must be to dense zone to trigger (%)
  triggerProximityPct: 2.0,  // Within 2% of dense zone
  warningProximityPct: 5.0,  // Within 5% = warning

  // --- Execution ---
  // What to do when cascade is imminent
  executionModes: ["liquidator", "counter_trade", "liquidity_provision"] as string[],
  defaultMode: "counter_trade" as string,

  // Counter-trade: short into the cascade on Drift, close after flush
  counterTradeMaxSizeUsd: 50_000,
  counterTradeTakeProfitPct: 2.0,
  counterTradeStopLossPct: 1.0,

  // Liquidator: directly call liquidate instructions
  liquidatorMinProfitUsd: 50,

  // --- Signal Detection (from Yogi pattern) ---
  monitoredMarkets: ["SOL-PERP", "BTC-PERP", "ETH-PERP"] as string[],
  signalHistorySize: 12,
  fundingHistorySize: 168,
  fundingVolWindow: 24,

  signalThresholds: {
    oiShift:    { low: 5, high: 15, critical: 30 },
    oiDrop:     { low: 5, high: 15, critical: 30 },
    fundingVol: { low: 500, high: 1500, critical: 3000 },
    spread:     { low: 0.5, high: 1.5, critical: 3.0 },
  },

  // --- Multi-Reporter Consensus (from Vigil pattern) ---
  // Use multiple RPC endpoints to validate position data
  minReporters: 2,
  maxStalenessSlots: 100,

  // --- Health / Risk ---
  maxDrawdownPct: 5,
  severeDrawdownPct: 10,
  maxConcurrentTrades: 3,

  // --- Timing ---
  positionScanIntervalMs: 2 * 60 * 1000,     // 2 min — needs to be fast
  heatmapUpdateIntervalMs: 1 * 60 * 1000,     // 1 min
  signalDetectionIntervalMs: 5 * 60 * 1000,
  emergencyCheckIntervalMs: 15 * 1000,         // 15s — tighter than other strategies

  // --- Jito Bundle (from Sentinel pattern) ---
  jitoTipLamports: 10_000,  // 0.00001 SOL default tip
  jitoRegion: "tokyo" as string,
};
