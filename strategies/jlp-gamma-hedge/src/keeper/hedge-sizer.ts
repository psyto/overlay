/**
 * Hedge Sizer — Determines VolSwap notional for gamma hedging.
 *
 * JLP is structurally short gamma (loses when perp traders win big moves).
 * Sigma VolSwap long position is long gamma (profits when realized vol > strike).
 * This module sizes the VolSwap position to offset JLP's gamma exposure.
 *
 * Composed from:
 * - Vol regime: Sigma SVI classification
 * - Signal boost: Yogi signal severity → hedge multiplier
 * - Sizing logic: New code, specific to JLP/VolSwap pairing
 */

import { STRATEGY_CONFIG } from "../config/vault";
import { SignalSeverity } from "./signal-detector";

export type VolRegime = "veryLow" | "low" | "normal" | "high" | "extreme";

export interface HedgeTarget {
  hedgeRatio: number;          // 0-1, fraction of gamma to hedge
  volswapNotionalUsd: number;  // VolSwap position size in USD
  reason: string;
}

export function classifyVolRegime(volBps: number): VolRegime {
  const t = STRATEGY_CONFIG.volRegimeThresholds;
  if (volBps < t.veryLow) return "veryLow";
  if (volBps < t.low) return "low";
  if (volBps < t.normal) return "normal";
  if (volBps < t.high) return "high";
  return "extreme";
}

/**
 * Compute target VolSwap hedge size.
 *
 * Logic:
 * 1. Base hedge ratio from vol regime (cheap to hedge in low vol)
 * 2. Boost multiplier from signal severity (increase hedge on anomaly)
 * 3. Scale by JLP non-stable exposure (only hedge directional portion)
 */
export function computeHedgeTarget(
  jlpValueUsd: number,
  basketWeights: Record<string, number>,
  volRegime: VolRegime,
  signalSeverity: SignalSeverity
): HedgeTarget {
  // Non-stable portion of JLP (this is the gamma-exposed part)
  const nonStableWeight = Object.entries(basketWeights)
    .filter(([asset]) => asset !== "USDC" && asset !== "USDT")
    .reduce((sum, [, w]) => sum + w, 0);

  const gammaExposureUsd = jlpValueUsd * nonStableWeight;

  // Base hedge ratio from regime
  const baseRatio = STRATEGY_CONFIG.hedgeRatioByRegime[volRegime]
    ?? STRATEGY_CONFIG.baseHedgeRatio;

  // Signal boost
  const boost = STRATEGY_CONFIG.signalHedgeBoost[signalSeverity] ?? 1.0;

  // Final hedge ratio (capped at 1.5x — don't over-hedge)
  const hedgeRatio = Math.min(baseRatio * boost, 1.5);

  // VolSwap notional = gamma exposure × hedge ratio
  // Simplified: VolSwap notional maps roughly 1:1 to gamma offset
  const volswapNotionalUsd = gammaExposureUsd * hedgeRatio;

  const severityLabels = ["clear", "low", "high", "critical"];
  const reason =
    `${volRegime} vol → ${(baseRatio * 100).toFixed(0)}% base ratio` +
    (boost > 1 ? ` × ${boost.toFixed(1)} (${severityLabels[signalSeverity]} signal)` : "") +
    ` → $${volswapNotionalUsd.toFixed(0)} VolSwap notional`;

  return { hedgeRatio, volswapNotionalUsd, reason };
}

/**
 * Check if current hedge needs adjustment.
 */
export function shouldRebalanceHedge(
  currentNotional: number,
  targetNotional: number,
  thresholdPct: number = 15
): boolean {
  if (currentNotional === 0 && targetNotional > 0) return true;
  if (targetNotional === 0) return currentNotional > 0;

  const diffPct = Math.abs(currentNotional - targetNotional) / targetNotional * 100;
  return diffPct > thresholdPct;
}
