/**
 * Loop Manager — Kamino JitoSOL leverage loop management.
 *
 * This is the primary new code in this strategy. It manages:
 * - JitoSOL → Kamino eMode deposit → borrow SOL → mint JitoSOL → repeat
 * - Dynamic leverage adjustment (add/remove loop iterations)
 * - LTV monitoring and emergency deleveraging
 *
 * New code — no direct port from existing repos.
 * Uses: @overlay/kamino-client (once implemented)
 */

import { STRATEGY_CONFIG } from "../config/vault";

export interface LoopState {
  depositedJitoSol: number;  // Total JitoSOL deposited in Kamino
  borrowedSol: number;       // Total SOL borrowed
  currentLtv: number;        // Current loan-to-value ratio (%)
  effectiveLeverage: number; // Actual leverage (deposited / initial)
  loopDepth: number;         // Number of loop iterations executed
  estimatedApy: number;      // Estimated APY from leveraged staking
  healthStatus: "healthy" | "warning" | "critical";
}

// JitoSOL staking APY estimate (updated periodically)
const JITOSOL_BASE_APY = 7.5; // ~7.5% base + MEV tips

/**
 * Calculate the effective APY at a given leverage.
 * APY = (stakingAPY × leverage) - (borrowCostAPY × (leverage - 1))
 */
export function calculateEffectiveApy(
  leverage: number,
  stakingApyPct: number = JITOSOL_BASE_APY,
  borrowCostApyPct: number = 4.0 // Kamino SOL borrow rate
): number {
  if (leverage <= 1) return stakingApyPct;
  return stakingApyPct * leverage - borrowCostApyPct * (leverage - 1);
}

/**
 * Calculate the LTV for a given leverage at Kamino eMode.
 * leverage = 1 / (1 - LTV)
 * LTV = 1 - (1 / leverage)
 */
export function leverageToLtv(leverage: number): number {
  if (leverage <= 1) return 0;
  return (1 - 1 / leverage) * 100;
}

/**
 * Determine the target loop state based on regime leverage.
 */
export function computeTargetLoopState(
  currentState: LoopState | null,
  targetLeverage: number,
  availableCapital: number
): {
  action: "increase" | "decrease" | "unwind" | "hold";
  targetLeverage: number;
  targetLtv: number;
  estimatedApy: number;
  reason: string;
} {
  const targetLtv = leverageToLtv(targetLeverage);
  const estimatedApy = calculateEffectiveApy(targetLeverage);

  // Safety cap: never exceed configured max LTV
  if (targetLtv > STRATEGY_CONFIG.targetLtvPct) {
    const cappedLeverage = 1 / (1 - STRATEGY_CONFIG.targetLtvPct / 100);
    return {
      action: "hold",
      targetLeverage: cappedLeverage,
      targetLtv: STRATEGY_CONFIG.targetLtvPct,
      estimatedApy: calculateEffectiveApy(cappedLeverage),
      reason: `LTV ${targetLtv.toFixed(1)}% exceeds cap ${STRATEGY_CONFIG.targetLtvPct}% — capping at ${cappedLeverage.toFixed(1)}x`,
    };
  }

  if (!currentState) {
    return {
      action: targetLeverage > 1 ? "increase" : "hold",
      targetLeverage,
      targetLtv,
      estimatedApy,
      reason: `Initial loop: ${targetLeverage.toFixed(1)}x → ~${estimatedApy.toFixed(1)}% APY`,
    };
  }

  // Emergency deleverage check
  if (currentState.currentLtv >= STRATEGY_CONFIG.criticalLtvPct) {
    return {
      action: "unwind",
      targetLeverage: 1.0,
      targetLtv: 0,
      estimatedApy: JITOSOL_BASE_APY,
      reason: `CRITICAL: LTV ${currentState.currentLtv.toFixed(1)}% >= ${STRATEGY_CONFIG.criticalLtvPct}% — full unwind`,
    };
  }

  if (currentState.currentLtv >= STRATEGY_CONFIG.emergencyDeleverageLtvPct) {
    const safeLeverage = Math.max(1.0, targetLeverage * 0.5);
    return {
      action: "decrease",
      targetLeverage: safeLeverage,
      targetLtv: leverageToLtv(safeLeverage),
      estimatedApy: calculateEffectiveApy(safeLeverage),
      reason: `WARNING: LTV ${currentState.currentLtv.toFixed(1)}% — deleveraging to ${safeLeverage.toFixed(1)}x`,
    };
  }

  // Normal adjustment
  const leverageDiff = targetLeverage - currentState.effectiveLeverage;
  const threshold = 0.2; // Only adjust if >0.2x difference

  if (Math.abs(leverageDiff) < threshold) {
    return {
      action: "hold",
      targetLeverage: currentState.effectiveLeverage,
      targetLtv: currentState.currentLtv,
      estimatedApy: calculateEffectiveApy(currentState.effectiveLeverage),
      reason: `Leverage ${currentState.effectiveLeverage.toFixed(1)}x within threshold of target ${targetLeverage.toFixed(1)}x`,
    };
  }

  if (leverageDiff > 0) {
    return {
      action: "increase",
      targetLeverage,
      targetLtv,
      estimatedApy,
      reason: `Increasing ${currentState.effectiveLeverage.toFixed(1)}x → ${targetLeverage.toFixed(1)}x (~${estimatedApy.toFixed(1)}% APY)`,
    };
  }

  return {
    action: "decrease",
    targetLeverage,
    targetLtv,
    estimatedApy,
    reason: `Decreasing ${currentState.effectiveLeverage.toFixed(1)}x → ${targetLeverage.toFixed(1)}x (~${estimatedApy.toFixed(1)}% APY)`,
  };
}

/**
 * Format loop state for logging.
 */
export function formatLoopState(state: LoopState): string {
  return (
    `Loop: ${state.effectiveLeverage.toFixed(1)}x (depth=${state.loopDepth}) | ` +
    `LTV: ${state.currentLtv.toFixed(1)}% | ` +
    `Deposited: ${state.depositedJitoSol.toFixed(4)} JitoSOL | ` +
    `Borrowed: ${state.borrowedSol.toFixed(4)} SOL | ` +
    `APY: ~${state.estimatedApy.toFixed(1)}% | ` +
    `Health: ${state.healthStatus}`
  );
}
