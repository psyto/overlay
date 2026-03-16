/**
 * Health Monitor — Ported from Kuma's health-monitor.
 *
 * Monitors Kamino loop health (LTV) and overall equity drawdown.
 * Triggers reduce/close actions when thresholds are breached.
 *
 * Origin: kuma/src/keeper/health-monitor.ts
 * Adapted: Monitors Kamino LTV instead of Drift health ratio.
 * Same drawdown logic — peak equity tracking with configurable thresholds.
 */

import { STRATEGY_CONFIG } from "../config/vault";
import { LoopState } from "./loop-manager";

export interface HealthState {
  loopLtv: number;
  equityUsd: number;
  drawdownPct: number;
  status: "healthy" | "warning" | "critical" | "liquidatable";
  action: "none" | "reduce" | "close_all";
}

let peakEquity = 0;

/**
 * Compute health from Kamino loop state.
 */
export function computeHealthState(
  loopState: LoopState | null,
  equityUsd: number
): HealthState {
  // Track peak equity for drawdown
  if (equityUsd > peakEquity) peakEquity = equityUsd;

  const drawdownPct =
    peakEquity > 0 ? ((peakEquity - equityUsd) / peakEquity) * 100 : 0;

  // Determine status from LTV
  const ltv = loopState?.currentLtv ?? 0;

  let status: HealthState["status"];
  let action: HealthState["action"];

  if (ltv >= STRATEGY_CONFIG.criticalLtvPct) {
    status = "liquidatable";
    action = "close_all";
  } else if (ltv >= STRATEGY_CONFIG.emergencyDeleverageLtvPct) {
    status = "critical";
    action = "reduce";
  } else if (drawdownPct >= STRATEGY_CONFIG.severeDrawdownPct) {
    status = "critical";
    action = "close_all";
  } else if (drawdownPct >= STRATEGY_CONFIG.maxDrawdownPct) {
    status = "warning";
    action = "reduce";
  } else {
    status = "healthy";
    action = "none";
  }

  return { loopLtv: ltv, equityUsd, drawdownPct, status, action };
}

export function resetPeakEquity(equity: number): void {
  peakEquity = equity;
}

export function formatHealthState(state: HealthState): string {
  return (
    `Health: ${state.status.toUpperCase()} | ` +
    `LTV: ${state.loopLtv.toFixed(1)}% | ` +
    `Equity: $${state.equityUsd.toFixed(2)} | ` +
    `Drawdown: ${state.drawdownPct.toFixed(2)}% | ` +
    `Action: ${state.action}`
  );
}
