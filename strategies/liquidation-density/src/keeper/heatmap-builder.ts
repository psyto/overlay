/**
 * Heatmap Builder — Maps leveraged positions to liquidation price levels.
 *
 * Reads positions from Kamino/Marginfi, computes liquidation prices,
 * and builds a density heatmap showing where cascades will trigger.
 *
 * Composed from:
 * - Liquidation math: Tensor margin math pattern (position → liquidation price)
 * - Anomaly classification: Kalshify severity thresholds (density levels)
 * - Multi-source validation: Vigil multi-reporter consensus pattern
 *
 * New code: Heatmap data structure and density analysis.
 */

import { STRATEGY_CONFIG } from "../config/vault";

export interface LeveragedPosition {
  protocol: "kamino" | "marginfi";
  owner: string;
  asset: string;           // e.g., "SOL", "JitoSOL"
  collateralUsd: number;
  debtUsd: number;
  ltv: number;             // Current LTV (%)
  liquidationPrice: number; // Price at which this position gets liquidated
  positionSizeUsd: number;  // Total position value
}

export interface PriceBucket {
  priceLow: number;
  priceHigh: number;
  priceMid: number;
  totalLiquidationUsd: number; // Sum of positions that liquidate in this bucket
  positionCount: number;
  density: "low" | "medium" | "high" | "critical";
  distanceFromCurrentPct: number; // How far from current price (%)
}

export interface LiquidationHeatmap {
  asset: string;
  currentPrice: number;
  buckets: PriceBucket[];
  totalTrackedUsd: number;
  nearestDenseBucketPct: number | null; // Distance to nearest dense zone
  timestamp: number;
}

/**
 * Classify density level (Kalshify-style severity pattern).
 */
function classifyDensity(totalUsd: number): PriceBucket["density"] {
  if (totalUsd >= STRATEGY_CONFIG.criticalDensityUsd) return "critical";
  if (totalUsd >= STRATEGY_CONFIG.highDensityUsd) return "high";
  if (totalUsd >= STRATEGY_CONFIG.minDensityUsd) return "medium";
  return "low";
}

/**
 * Build liquidation heatmap from a set of leveraged positions.
 */
export function buildHeatmap(
  asset: string,
  currentPrice: number,
  positions: LeveragedPosition[]
): LiquidationHeatmap {
  const rangePct = STRATEGY_CONFIG.heatmapRangePct;
  const bucketSizePct = STRATEGY_CONFIG.priceBucketSizePct;

  const priceLow = currentPrice * (1 - rangePct / 100);
  const priceHigh = currentPrice * (1 + rangePct / 100);
  const bucketCount = Math.ceil((rangePct * 2) / bucketSizePct);

  // Initialize buckets
  const buckets: PriceBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const low = priceLow + (priceHigh - priceLow) * (i / bucketCount);
    const high = priceLow + (priceHigh - priceLow) * ((i + 1) / bucketCount);
    const mid = (low + high) / 2;
    buckets.push({
      priceLow: low,
      priceHigh: high,
      priceMid: mid,
      totalLiquidationUsd: 0,
      positionCount: 0,
      density: "low",
      distanceFromCurrentPct: ((mid - currentPrice) / currentPrice) * 100,
    });
  }

  // Place positions into buckets
  let totalTrackedUsd = 0;
  for (const pos of positions) {
    if (pos.liquidationPrice < priceLow || pos.liquidationPrice > priceHigh) continue;

    totalTrackedUsd += pos.positionSizeUsd;

    const bucketIdx = Math.floor(
      ((pos.liquidationPrice - priceLow) / (priceHigh - priceLow)) * bucketCount
    );
    if (bucketIdx >= 0 && bucketIdx < bucketCount) {
      buckets[bucketIdx].totalLiquidationUsd += pos.positionSizeUsd;
      buckets[bucketIdx].positionCount++;
    }
  }

  // Classify density
  for (const bucket of buckets) {
    bucket.density = classifyDensity(bucket.totalLiquidationUsd);
  }

  // Find nearest dense zone
  const denseBuckets = buckets.filter((b) => b.density !== "low");
  let nearestDenseBucketPct: number | null = null;
  if (denseBuckets.length > 0) {
    nearestDenseBucketPct = denseBuckets.reduce(
      (min, b) => Math.min(min, Math.abs(b.distanceFromCurrentPct)),
      Infinity
    );
  }

  return {
    asset,
    currentPrice,
    buckets,
    totalTrackedUsd,
    nearestDenseBucketPct,
    timestamp: Date.now(),
  };
}

/**
 * Get actionable zones — dense buckets within trigger proximity.
 */
export function getActionableZones(heatmap: LiquidationHeatmap): PriceBucket[] {
  return heatmap.buckets.filter(
    (b) =>
      b.density !== "low" &&
      Math.abs(b.distanceFromCurrentPct) <= STRATEGY_CONFIG.triggerProximityPct
  );
}

/**
 * Get warning zones — dense buckets approaching trigger proximity.
 */
export function getWarningZones(heatmap: LiquidationHeatmap): PriceBucket[] {
  return heatmap.buckets.filter(
    (b) =>
      b.density !== "low" &&
      Math.abs(b.distanceFromCurrentPct) <= STRATEGY_CONFIG.warningProximityPct &&
      Math.abs(b.distanceFromCurrentPct) > STRATEGY_CONFIG.triggerProximityPct
  );
}

export function formatHeatmap(heatmap: LiquidationHeatmap): string {
  const actionable = getActionableZones(heatmap);
  const warnings = getWarningZones(heatmap);
  const denseBuckets = heatmap.buckets.filter((b) => b.density !== "low");

  let out =
    `Heatmap: ${heatmap.asset} @ $${heatmap.currentPrice.toFixed(2)} | ` +
    `Tracked: $${(heatmap.totalTrackedUsd / 1e6).toFixed(1)}M | ` +
    `Dense zones: ${denseBuckets.length} | ` +
    `Nearest: ${heatmap.nearestDenseBucketPct?.toFixed(1) ?? "none"}%`;

  if (actionable.length > 0) {
    out += "\n  ACTIONABLE:";
    for (const z of actionable) {
      out += `\n    $${z.priceMid.toFixed(2)} (${z.distanceFromCurrentPct.toFixed(1)}%): ` +
        `$${(z.totalLiquidationUsd / 1e6).toFixed(1)}M [${z.density}] (${z.positionCount} positions)`;
    }
  }

  if (warnings.length > 0) {
    out += "\n  WARNING:";
    for (const z of warnings) {
      out += `\n    $${z.priceMid.toFixed(2)} (${z.distanceFromCurrentPct.toFixed(1)}%): ` +
        `$${(z.totalLiquidationUsd / 1e6).toFixed(1)}M [${z.density}]`;
    }
  }

  return out;
}
