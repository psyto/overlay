/**
 * Regime-Adaptive Leverage — Strategy Configuration
 *
 * Components composed from:
 * - Signal detection thresholds: adapted from Yogi (drift-signal-detector)
 * - Vol regime classification: adapted from Kuma (leverage-controller)
 * - Deployment matrix: adapted from Yogi (regime-engine)
 * - Health monitoring: adapted from Kuma (health-monitor)
 */

export const STRATEGY_CONFIG = {
  // --- Kamino Loop Parameters ---
  // JitoSOL → Kamino eMode → borrow SOL → mint JitoSOL → repeat
  maxLoopIterations: 4,          // Max loop depth (4x leverage at 95% LTV)
  targetLtvPct: 80,              // Conservative default (Kamino eMode allows 95%)
  emergencyDeleverageLtvPct: 88, // Start unwinding above this
  criticalLtvPct: 92,            // Emergency full unwind

  // --- Drift Hedge (optional SOL short to go market-neutral) ---
  enableDriftHedge: false,       // Set true for delta-neutral mode
  hedgeMarket: "SOL-PERP",
  hedgeRebalanceThresholdPct: 5, // Re-hedge when exposure drifts ±5%

  // --- Vol Regime Classification (from Kuma/Tempest pattern) ---
  volRegimeThresholds: {
    veryLow: 2000,   // < 20% annualized
    low: 3500,       // < 35%
    normal: 5000,    // < 50%
    high: 7500,      // < 75%
  },

  // --- Signal Detection Thresholds (from Yogi pattern) ---
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

  // --- Regime → Loop Leverage Matrix ---
  // volRegime × signalSeverity → target Kamino loop multiplier
  // Unlike Yogi (which sizes Drift perp leverage), this sizes Kamino loop depth
  loopLeverageMatrix: {
    //              [NONE,  LOW,  HIGH, CRITICAL]
    veryLow: [3.5,  3.0,  2.0,  1.0],
    low:     [3.0,  2.5,  1.5,  1.0],
    normal:  [2.5,  2.0,  1.5,  1.0],
    high:    [1.5,  1.0,  1.0,  1.0],
    extreme: [1.0,  1.0,  1.0,  1.0],
  } as Record<string, number[]>,

  // --- Pre-Extreme Wind-Down (from Arashi pattern) ---
  // Start deleveraging at 65% vol before regime flips to "extreme"
  preExtremeWindDownVolBps: 6500,
  preExtremeTargetLeverage: 1.5,

  // --- Health Monitoring (from Kuma pattern) ---
  healthCheckIntervalMs: 30 * 1000,
  maxDrawdownPct: 5,
  severeDrawdownPct: 10,

  // --- Timing ---
  signalDetectionIntervalMs: 5 * 60 * 1000,   // 5 min
  leverageScanIntervalMs: 10 * 60 * 1000,      // 10 min
  rebalanceIntervalMs: 30 * 60 * 1000,         // 30 min
  emergencyCheckIntervalMs: 30 * 1000,         // 30s

  // --- Emergency Rebalance Trigger (from Yogi pattern) ---
  emergencyLeverageDropMultiplier: 0.5, // Trigger if target drops by >50%

  // --- Yield Tracking ---
  enableYieldTracking: true,
};
