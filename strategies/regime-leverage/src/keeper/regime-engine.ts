/**
 * Regime Engine — Ported from Yogi's regime-engine.
 *
 * Combines vol regime (backward-looking) with signal severity (forward-looking)
 * to determine target Kamino loop leverage.
 *
 * Origin: yogi/src/keeper/regime-engine.ts
 * Adapted: Output is loop leverage multiplier instead of Drift perp deployment %.
 * Added: Pre-extreme wind-down from Arashi (deleverage early at 65% vol).
 */

import { SignalSeverity, SIGNAL_NONE, SIGNAL_LOW, SIGNAL_CRITICAL } from "./signal-detector";
import { VolRegime } from "./vol-estimator";
import { STRATEGY_CONFIG } from "../config/vault";

export type RebalanceMode = "aggressive" | "normal" | "cautious" | "defensive";

export interface LeverageRegime {
  volRegime: VolRegime;
  signalSeverity: SignalSeverity;
  targetLoopLeverage: number;
  rebalanceMode: RebalanceMode;
  reason: string;
}

/**
 * Compute target Kamino loop leverage from vol regime × signal severity.
 */
export function computeLeverageRegime(
  volRegime: VolRegime,
  signalSeverity: SignalSeverity,
  currentVolBps: number
): LeverageRegime {
  const leverageRow = STRATEGY_CONFIG.loopLeverageMatrix[volRegime] ?? [1, 1, 1, 1];
  let targetLoopLeverage = leverageRow[signalSeverity] ?? 1.0;

  // Pre-extreme wind-down (from Arashi pattern):
  // If vol is approaching extreme but hasn't crossed yet, start deleveraging early
  if (
    currentVolBps >= STRATEGY_CONFIG.preExtremeWindDownVolBps &&
    volRegime !== "extreme"
  ) {
    targetLoopLeverage = Math.min(
      targetLoopLeverage,
      STRATEGY_CONFIG.preExtremeTargetLeverage
    );
  }

  let rebalanceMode: RebalanceMode;
  if (targetLoopLeverage >= 3.0) {
    rebalanceMode = "aggressive";
  } else if (targetLoopLeverage >= 2.0) {
    rebalanceMode = "normal";
  } else if (targetLoopLeverage >= 1.5) {
    rebalanceMode = "cautious";
  } else {
    rebalanceMode = "defensive";
  }

  const severityLabels = ["clear", "low", "high", "critical"];
  const reason =
    signalSeverity === SIGNAL_NONE
      ? `${volRegime} vol → ${targetLoopLeverage}x loop`
      : `${volRegime} vol + ${severityLabels[signalSeverity]} signal → ${targetLoopLeverage}x loop (${rebalanceMode})`;

  return {
    volRegime,
    signalSeverity,
    targetLoopLeverage,
    rebalanceMode,
    reason,
  };
}

/**
 * Determine if leverage change warrants immediate rebalance.
 * Adapted from Yogi's shouldTriggerEmergencyRebalance.
 */
export function shouldTriggerEmergencyRebalance(
  previous: LeverageRegime | undefined,
  current: LeverageRegime
): boolean {
  if (!previous) return false;

  // Large leverage drop
  if (
    previous.targetLoopLeverage > 0 &&
    current.targetLoopLeverage / previous.targetLoopLeverage <
      STRATEGY_CONFIG.emergencyLeverageDropMultiplier
  ) {
    return true;
  }

  // Jump from clear to critical
  if (
    previous.signalSeverity <= SIGNAL_LOW &&
    current.signalSeverity >= SIGNAL_CRITICAL
  ) {
    return true;
  }

  // Mode shift to defensive
  if (
    previous.rebalanceMode !== "defensive" &&
    current.rebalanceMode === "defensive"
  ) {
    return true;
  }

  return false;
}

export function formatRegime(regime: LeverageRegime): string {
  const modeIcon: Record<RebalanceMode, string> = {
    aggressive: ">>",
    normal: "->",
    cautious: "~~",
    defensive: "!!",
  };
  return `[${modeIcon[regime.rebalanceMode]}] ${regime.reason}`;
}
