/**
 * JLP Gamma Hedge — Strategy Configuration
 *
 * Components composed from:
 * - Vol computation: Tempest VolatilityEngine (realized vol from price data)
 * - Vol regime: Sigma SVI (regime classification)
 * - Gamma hedge: Sigma VolSwap (long variance position)
 * - Portfolio Greeks: Tensor (delta/gamma/vega aggregation)
 * - MEV protection: Veil (encrypted orders for hedge execution)
 * - Signal detection: Yogi (anomaly triggers for hedge increases)
 * - Keeper loop: Arashi (event loop pattern)
 */

export const STRATEGY_CONFIG = {
  // --- JLP Configuration ---
  // JLP basket weights (approximate, updated by keeper)
  defaultBasketWeights: {
    SOL: 0.45,
    ETH: 0.10,
    BTC: 0.10,
    USDC: 0.25,
    USDT: 0.10,
  } as Record<string, number>,

  // --- Gamma Hedge Sizing ---
  // Hedge ratio: what fraction of JLP gamma exposure to hedge
  baseHedgeRatio: 0.8,          // 80% of gamma hedged by default

  // Regime-adjusted hedge ratios
  hedgeRatioByRegime: {
    veryLow: 1.0,    // Max hedge in low vol — cheap to buy, maximum protection
    low: 0.9,
    normal: 0.7,
    high: 0.5,        // Expensive to hedge, reduce ratio
    extreme: 0.3,     // Very expensive, minimal hedge only
  } as Record<string, number>,

  // --- Vol Regime (from Sigma SVI / Tempest pattern) ---
  volRegimeThresholds: {
    veryLow: 2000,
    low: 3500,
    normal: 5000,
    high: 7500,
  },

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

  // Signal-driven hedge boost: multiply hedge ratio on anomaly
  signalHedgeBoost: {
    0: 1.0,   // NONE: no boost
    1: 1.1,   // LOW: +10%
    2: 1.3,   // HIGH: +30%
    3: 1.5,   // CRITICAL: +50%
  } as Record<number, number>,

  // --- Portfolio Greeks Thresholds (from Tensor pattern) ---
  maxPortfolioDelta: 0.10,       // Rebalance if net delta > ±10%
  maxPortfolioGamma: 0.05,       // Warn if gamma exposure > 5%
  targetNetDelta: 0.0,           // Delta-neutral target

  // --- Health / Risk ---
  maxDrawdownPct: 8,
  severeDrawdownPct: 15,
  maxJlpAllocationPct: 90,      // Keep 10% as reserve

  // --- Timing ---
  signalDetectionIntervalMs: 5 * 60 * 1000,
  greeksUpdateIntervalMs: 10 * 60 * 1000,
  hedgeRebalanceIntervalMs: 30 * 60 * 1000,
  emergencyCheckIntervalMs: 30 * 1000,

  // --- Emergency ---
  emergencyHedgeRatioDropPct: 30,
};
