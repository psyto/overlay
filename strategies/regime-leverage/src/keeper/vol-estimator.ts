/**
 * Volatility Estimator — Ported from Kuma's leverage-controller.
 *
 * Parkinson estimator on SOL hourly candles → annualized vol in bps.
 * Used to classify vol regime for Kamino loop leverage decisions.
 *
 * Origin: kuma/src/keeper/leverage-controller.ts (fetchReferenceVol + classifyVolRegime)
 * Also used in: arashi/src/keeper/vol-engine.ts (Yang-Zhang variant)
 */

import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

export type VolRegime = "veryLow" | "low" | "normal" | "high" | "extreme";

export interface VolState {
  volBps: number;
  volPct: number;
  regime: VolRegime;
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
 * Fetch realized vol via Parkinson estimator on SOL-PERP hourly candles.
 */
export async function fetchReferenceVol(): Promise<VolState> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/SOL-PERP/candles/60?limit=168`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch candles: ${res.status}`);
  }

  const body = (await res.json()) as {
    success: boolean;
    records: Array<{ oracleHigh: number; oracleLow: number }>;
  };

  if (!body.success || !body.records || body.records.length < 10) {
    throw new Error("Insufficient candle data for vol calculation");
  }

  const ln2x4 = 4 * Math.LN2;
  let sumLogHL2 = 0;
  let validCount = 0;

  for (const c of body.records) {
    if (c.oracleHigh <= 0 || c.oracleLow <= 0 || c.oracleHigh < c.oracleLow)
      continue;
    const logHL = Math.log(c.oracleHigh / c.oracleLow);
    sumLogHL2 += logHL * logHL;
    validCount++;
  }

  if (validCount === 0) {
    return { volBps: 3000, volPct: 30, regime: "low" };
  }

  const variance = sumLogHL2 / (ln2x4 * validCount);
  const hoursPerYear = 365.25 * 24;
  const annualizedVol = Math.sqrt(variance * hoursPerYear);
  const volBps = Math.round(annualizedVol * 10000);

  return {
    volBps,
    volPct: volBps / 100,
    regime: classifyVolRegime(volBps),
  };
}
