/**
 * Signal Detector — Ported from Yogi's drift-signal-detector.
 *
 * Full implementation (same as regime-leverage).
 * Detects 4 anomaly dimensions on Drift markets as signals for hedge adjustment.
 *
 * Origin: yogi/src/keeper/drift-signal-detector.ts
 */

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

const DRIFT_DATA_API = "https://data.api.drift.trade";
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

function detectOIShift(current: MarketSnapshot[], history: MarketSnapshot[][]): SignalEvent | null {
  if (history.length < 2) return null;
  const oldest = history[0];
  let maxShift = 0;
  let worstMarket = "";
  for (const curr of current) {
    const prev = oldest.find((s) => s.marketIndex === curr.marketIndex);
    if (!prev) continue;
    const shift = Math.abs(curr.oiImbalancePct - prev.oiImbalancePct);
    if (shift > maxShift) { maxShift = shift; worstMarket = curr.market; }
  }
  const severity = classifySeverity(maxShift, STRATEGY_CONFIG.signalThresholds.oiShift);
  if (severity === SIGNAL_NONE) return null;
  return { dimension: "oi_shift", severity, reason: `OI imbalance shifted ${maxShift.toFixed(1)}% on ${worstMarket}`, timestamp: Date.now(), metrics: { maxShift } };
}

function detectLiquidationCascade(current: MarketSnapshot[], history: MarketSnapshot[][]): SignalEvent | null {
  if (history.length < 2) return null;
  const oldest = history[0];
  let maxDrop = 0;
  let worstMarket = "";
  for (const curr of current) {
    const prev = oldest.find((s) => s.marketIndex === curr.marketIndex);
    if (!prev) continue;
    const prevTotal = prev.longOI + prev.shortOI;
    const currTotal = curr.longOI + curr.shortOI;
    if (prevTotal <= 0) continue;
    const drop = ((prevTotal - currTotal) / prevTotal) * 100;
    if (drop > maxDrop) { maxDrop = drop; worstMarket = curr.market; }
  }
  const severity = classifySeverity(maxDrop, STRATEGY_CONFIG.signalThresholds.oiDrop);
  if (severity === SIGNAL_NONE) return null;
  return { dimension: "liquidation_cascade", severity, reason: `OI dropped ${maxDrop.toFixed(1)}% on ${worstMarket}`, timestamp: Date.now(), metrics: { maxDrop } };
}

async function detectFundingVolatility(markets: string[]): Promise<SignalEvent | null> {
  let maxVol = 0;
  let worstMarket = "";
  for (const market of markets) {
    const history = fundingHistory.get(market);
    if (!history || history.length < 10) continue;
    const recent = history.slice(-STRATEGY_CONFIG.fundingVolWindow);
    const mean = recent.reduce((s, r) => s + r, 0) / recent.length;
    const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
    const annBps = Math.sqrt(variance) * Math.sqrt(3 * 365) * 10000;
    if (annBps > maxVol) { maxVol = annBps; worstMarket = market; }
  }
  const severity = classifySeverity(maxVol, STRATEGY_CONFIG.signalThresholds.fundingVol);
  if (severity === SIGNAL_NONE) return null;
  return { dimension: "funding_volatility", severity, reason: `Funding vol ${maxVol.toFixed(0)} bps on ${worstMarket}`, timestamp: Date.now(), metrics: { maxVol } };
}

function detectSpreadBlowout(current: MarketSnapshot[]): SignalEvent | null {
  let maxSpread = 0;
  let worstMarket = "";
  for (const snap of current) {
    const abs = Math.abs(snap.spreadPct);
    if (abs > maxSpread) { maxSpread = abs; worstMarket = snap.market; }
  }
  const severity = classifySeverity(maxSpread, STRATEGY_CONFIG.signalThresholds.spread);
  if (severity === SIGNAL_NONE) return null;
  return { dimension: "spread_blowout", severity, reason: `Spread ${maxSpread.toFixed(2)}% on ${worstMarket}`, timestamp: Date.now(), metrics: { maxSpread } };
}

export async function detectSignals(
  monitoredMarkets: string[] = STRATEGY_CONFIG.monitoredMarkets
): Promise<SignalState> {
  const snapshots = await fetchMarketSnapshots();
  const monitored = snapshots.filter((s) => monitoredMarkets.includes(s.market));
  const events: SignalEvent[] = [];

  const e1 = detectOIShift(monitored, snapshotHistory);
  if (e1) events.push(e1);
  const e2 = detectLiquidationCascade(monitored, snapshotHistory);
  if (e2) events.push(e2);
  const e3 = await detectFundingVolatility(monitoredMarkets);
  if (e3) events.push(e3);
  const e4 = detectSpreadBlowout(monitored);
  if (e4) events.push(e4);

  snapshotHistory.push(monitored);
  if (snapshotHistory.length > STRATEGY_CONFIG.signalHistorySize) snapshotHistory.shift();

  for (const snap of monitored) {
    const h = fundingHistory.get(snap.market) ?? [];
    h.push(snap.fundingRate24h);
    if (h.length > STRATEGY_CONFIG.fundingHistorySize) h.shift();
    fundingHistory.set(snap.market, h);
  }

  const severity = events.reduce(
    (max, e) => Math.max(max, e.severity) as SignalSeverity,
    SIGNAL_NONE as SignalSeverity
  );
  return { severity, events, timestamp: Date.now() };
}

export function formatSignalState(state: SignalState): string {
  const labels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
  if (state.events.length === 0) return `Signal: ${labels[state.severity]} — no anomalies`;
  const details = state.events.map((e) => `  [${labels[e.severity]}] ${e.reason}`).join("\n");
  return `Signal: ${labels[state.severity]} (${state.events.length} anomalies)\n${details}`;
}
