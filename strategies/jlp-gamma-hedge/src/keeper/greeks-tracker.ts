/**
 * Greeks Tracker — Portfolio-level Greeks for JLP + hedge positions.
 *
 * Tracks delta, gamma, vega across JLP basket exposure and hedge positions
 * to ensure the combined portfolio stays within risk bounds.
 *
 * Inspired by: Tensor's portfolio Greeks aggregation (tensor-math)
 * Simplified: No cross-margin netting — just JLP basket + VolSwap/Drift hedge.
 */

import { STRATEGY_CONFIG } from "../config/vault";

export interface PortfolioGreeks {
  // Per-asset delta exposure (as fraction of portfolio)
  assetDeltas: Record<string, number>;
  // Net portfolio delta (should be near 0 if hedged)
  netDelta: number;
  // Gamma exposure from JLP (negative = short gamma)
  gamma: number;
  // Vega exposure (positive if hedged via VolSwap)
  vega: number;
  // Status
  status: "balanced" | "delta_drift" | "gamma_exposed" | "rebalance_needed";
}

/**
 * Compute portfolio Greeks from JLP position and hedge positions.
 */
export function computePortfolioGreeks(
  jlpValueUsd: number,
  basketWeights: Record<string, number>,
  hedgePositions: Array<{
    asset: string;
    deltaUsd: number;  // Negative = short
  }>,
  volswapNotional: number // Positive = long variance (long gamma)
): PortfolioGreeks {
  const totalValue = jlpValueUsd;
  if (totalValue <= 0) {
    return {
      assetDeltas: {},
      netDelta: 0,
      gamma: 0,
      vega: 0,
      status: "balanced",
    };
  }

  // JLP delta = basket weight × JLP value (long exposure)
  const assetDeltas: Record<string, number> = {};
  for (const [asset, weight] of Object.entries(basketWeights)) {
    if (asset === "USDC" || asset === "USDT") continue; // Stables have no delta
    assetDeltas[asset] = (weight * jlpValueUsd) / totalValue;
  }

  // Subtract hedge deltas
  for (const hedge of hedgePositions) {
    const current = assetDeltas[hedge.asset] ?? 0;
    assetDeltas[hedge.asset] = current + hedge.deltaUsd / totalValue;
  }

  // Net delta
  const netDelta = Object.values(assetDeltas).reduce((sum, d) => sum + d, 0);

  // JLP gamma: negative (JLP loses on big moves)
  // Simplified: gamma ∝ basket non-stable weight × -1
  const nonStableWeight = Object.entries(basketWeights)
    .filter(([asset]) => asset !== "USDC" && asset !== "USDT")
    .reduce((sum, [, w]) => sum + w, 0);
  const jlpGamma = -nonStableWeight;

  // VolSwap gamma: positive (long variance = long gamma)
  const volswapGamma = volswapNotional > 0
    ? (volswapNotional / totalValue) * 0.5 // Simplified gamma estimate
    : 0;

  const gamma = jlpGamma + volswapGamma;
  const vega = volswapNotional / totalValue; // Long VolSwap = long vega

  // Status
  let status: PortfolioGreeks["status"];
  const absDelta = Math.abs(netDelta);
  const absGamma = Math.abs(gamma);

  if (absDelta > STRATEGY_CONFIG.maxPortfolioDelta) {
    status = "rebalance_needed";
  } else if (absGamma > STRATEGY_CONFIG.maxPortfolioGamma) {
    status = "gamma_exposed";
  } else if (absDelta > STRATEGY_CONFIG.maxPortfolioDelta * 0.7) {
    status = "delta_drift";
  } else {
    status = "balanced";
  }

  return { assetDeltas, netDelta, gamma, vega, status };
}

export function formatGreeks(greeks: PortfolioGreeks): string {
  const deltas = Object.entries(greeks.assetDeltas)
    .map(([asset, d]) => `${asset}=${(d * 100).toFixed(1)}%`)
    .join(", ");

  return (
    `Greeks: delta=${(greeks.netDelta * 100).toFixed(1)}% [${deltas}] | ` +
    `gamma=${(greeks.gamma * 100).toFixed(1)}% | ` +
    `vega=${(greeks.vega * 100).toFixed(1)}% | ` +
    `${greeks.status}`
  );
}
