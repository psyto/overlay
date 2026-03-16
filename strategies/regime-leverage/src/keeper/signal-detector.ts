/**
 * Signal Detector — Ported from Yogi's drift-signal-detector.
 *
 * Detects 4 anomaly dimensions on Drift markets as regime signals
 * for Kamino loop leverage management:
 *
 * 1. OI Imbalance Shift — rapid long/short ratio change
 * 2. Liquidation Cascade — sudden OI drop (forced selling proxy)
 * 3. Funding Rate Volatility — unstable funding = regime transition
 * 4. Spread Blow-out — mark/oracle divergence = stress
 *
 * Origin: yogi/src/keeper/drift-signal-detector.ts
 * Adapted: Unchanged logic — same thresholds, same detection, different consumer.
 * In Yogi this drives Drift perp deployment. Here it drives Kamino loop leverage.
 */

import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

export const SIGNAL_NONE = 0;
export const SIGNAL_LOW = 1;
export const SIGNAL_HIGH = 2;
export const SIGNAL_CRITICAL = 3;

export type SignalSeverity = 0 | 1 | 2 | 3;

export interface SignalEvent {
  dimension: "oi_shift" | "liquidation_cascade" | "funding_volatility" | "spread_blowout";
  severity: SignalSeverity;
  reason: string;
  timestamp: number;
  metrics: Record<string, number>;
}

export interface SignalState {
  severity: SignalSeverity;
  events: SignalEvent[];
  timestamp: number;
}

interface MarketSnapshot {
  market: string;
  marketIndex: number;
  longOI: number;
  shortOI: number;
  oiImbalancePct: number;
  markPrice: number;
  oraclePrice: number;
  spreadPct: number;
  fundingRate24h: number;
}

const snapshotHistory: MarketSnapshot[][] = [];
const fundingHistory: Map<string, number[]> = new Map();

function classifySeverity(
  value: number,
  thresholds: { low: number; high: number; critical: number }
): SignalSeverity {
  if (value >= thresholds.critical) return SIGNAL_CRITICAL;
  if (value >= thresholds.high) return SIGNAL_HIGH;
  if (value >= thresholds.low) return SIGNAL_LOW;
  return SIGNAL_NONE;
}

async function fetchMarketSnapshots(): Promise<MarketSnapshot[]> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  if (!res.ok) throw new Error(`Failed to fetch markets: ${res.status}`);

  const body = (await res.json()) as {
    success: boolean;
    markets: Array<{
      symbol: string;
      marketIndex: number;
      marketType: string;
      oraclePrice: string;
      markPrice: string;
      openInterest: { long: string; short: string };
      fundingRate24h: string;
    }>;
  };

  if (!body.success || !body.markets) {
    throw new Error("Unexpected market stats response");
  }

  return body.markets
    .filter((m) => m.marketType === "perp")
    .map((m) => {
      const oracle = parseFloat(m.oraclePrice);
      const mark = parseFloat(m.markPrice);
      const longOI = parseFloat(m.openInterest.long);
      const shortOI = Math.abs(parseFloat(m.openInterest.short));
      const totalOI = longOI + shortOI;

      return {
        market: m.symbol,
        marketIndex: m.marketIndex,
        longOI,
        shortOI,
        oiImbalancePct: totalOI > 0 ? ((longOI - shortOI) / totalOI) * 100 : 0,
        markPrice: mark,
        oraclePrice: oracle,
        spreadPct: oracle > 0 ? ((mark - oracle) / oracle) * 100 : 0,
        fundingRate24h: parseFloat(m.fundingRate24h),
      };
    });
}

function detectOIShift(
  current: MarketSnapshot[],
  history: MarketSnapshot[][]
): SignalEvent | null {
  if (history.length < 2) return null;

  const oldest = history[0];
  let maxShift = 0;
  let worstMarket = "";

  for (const curr of current) {
    const prev = oldest.find((s) => s.marketIndex === curr.marketIndex);
    if (!prev) continue;
    const shift = Math.abs(curr.oiImbalancePct - prev.oiImbalancePct);
    if (shift > maxShift) {
      maxShift = shift;
      worstMarket = curr.market;
    }
  }

  const severity = classifySeverity(maxShift, STRATEGY_CONFIG.signalThresholds.oiShift);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "oi_shift",
    severity,
    reason: `OI imbalance shifted ${maxShift.toFixed(1)}% on ${worstMarket}`,
    timestamp: Date.now(),
    metrics: { maxShift },
  };
}

function detectLiquidationCascade(
  current: MarketSnapshot[],
  history: MarketSnapshot[][]
): SignalEvent | null {
  if (history.length < 2) return null;

  const oldest = history[0];
  let maxDrop = 0;
  let worstMarket = "";

  for (const curr of current) {
    const prev = oldest.find((s) => s.marketIndex === curr.marketIndex);
    if (!prev) continue;
    const prevTotalOI = prev.longOI + prev.shortOI;
    const currTotalOI = curr.longOI + curr.shortOI;
    if (prevTotalOI <= 0) continue;
    const dropPct = ((prevTotalOI - currTotalOI) / prevTotalOI) * 100;
    if (dropPct > maxDrop) {
      maxDrop = dropPct;
      worstMarket = curr.market;
    }
  }

  const severity = classifySeverity(maxDrop, STRATEGY_CONFIG.signalThresholds.oiDrop);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "liquidation_cascade",
    severity,
    reason: `OI dropped ${maxDrop.toFixed(1)}% on ${worstMarket} — likely liquidation cascade`,
    timestamp: Date.now(),
    metrics: { maxDrop },
  };
}

async function detectFundingVolatility(
  markets: string[]
): Promise<SignalEvent | null> {
  let maxFundingVol = 0;
  let worstMarket = "";

  for (const market of markets) {
    let history = fundingHistory.get(market);
    if (!history || history.length < 10) continue;

    const recent = history.slice(-STRATEGY_CONFIG.fundingVolWindow);
    const mean = recent.reduce((s, r) => s + r, 0) / recent.length;
    const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    const annualizedVolBps = stdDev * Math.sqrt(3 * 365) * 10000;

    if (annualizedVolBps > maxFundingVol) {
      maxFundingVol = annualizedVolBps;
      worstMarket = market;
    }
  }

  const severity = classifySeverity(maxFundingVol, STRATEGY_CONFIG.signalThresholds.fundingVol);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "funding_volatility",
    severity,
    reason: `Funding rate vol ${maxFundingVol.toFixed(0)} bps (annualized) on ${worstMarket}`,
    timestamp: Date.now(),
    metrics: { maxFundingVol },
  };
}

function detectSpreadBlowout(current: MarketSnapshot[]): SignalEvent | null {
  let maxSpread = 0;
  let worstMarket = "";

  for (const snap of current) {
    const absSpread = Math.abs(snap.spreadPct);
    if (absSpread > maxSpread) {
      maxSpread = absSpread;
      worstMarket = snap.market;
    }
  }

  const severity = classifySeverity(maxSpread, STRATEGY_CONFIG.signalThresholds.spread);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "spread_blowout",
    severity,
    reason: `Mark/oracle spread ${maxSpread.toFixed(2)}% on ${worstMarket}`,
    timestamp: Date.now(),
    metrics: { maxSpread },
  };
}

/**
 * Run all 4 signal dimensions and return aggregate state.
 */
export async function detectSignals(
  monitoredMarkets: string[] = STRATEGY_CONFIG.monitoredMarkets
): Promise<SignalState> {
  const snapshots = await fetchMarketSnapshots();
  const monitored = snapshots.filter((s) => monitoredMarkets.includes(s.market));

  const events: SignalEvent[] = [];

  const oiShift = detectOIShift(monitored, snapshotHistory);
  if (oiShift) events.push(oiShift);

  const liquidation = detectLiquidationCascade(monitored, snapshotHistory);
  if (liquidation) events.push(liquidation);

  const fundingVol = await detectFundingVolatility(monitoredMarkets);
  if (fundingVol) events.push(fundingVol);

  const spread = detectSpreadBlowout(monitored);
  if (spread) events.push(spread);

  // Update rolling history
  snapshotHistory.push(monitored);
  if (snapshotHistory.length > STRATEGY_CONFIG.signalHistorySize) {
    snapshotHistory.shift();
  }

  // Update funding history
  for (const snap of monitored) {
    const history = fundingHistory.get(snap.market) ?? [];
    history.push(snap.fundingRate24h);
    if (history.length > STRATEGY_CONFIG.fundingHistorySize) history.shift();
    fundingHistory.set(snap.market, history);
  }

  const severity = events.reduce(
    (max, e) => Math.max(max, e.severity) as SignalSeverity,
    SIGNAL_NONE as SignalSeverity
  );

  return { severity, events, timestamp: Date.now() };
}

export function formatSignalState(state: SignalState): string {
  const labels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
  if (state.events.length === 0) {
    return `Signal: ${labels[state.severity]} — no anomalies detected`;
  }
  const details = state.events
    .map((e) => `  [${labels[e.severity]}] ${e.reason}`)
    .join("\n");
  return `Signal: ${labels[state.severity]} (${state.events.length} anomalies)\n${details}`;
}
