/**
 * Backtest: Liquidation Density
 *
 * 1000 daily candles (~3 years)
 * Starting capital: $100,000
 *
 * Improved model:
 * - Liquidation clusters generated from support/resistance + round numbers
 * - Counter-trades triggered only when price rapidly approaches dense zones
 * - Asymmetric TP/SL: TP 3% / SL 1.5% (cascade flush gives larger moves)
 * - Max hold time: 5 days
 * - Density filter: only trade when cluster score >= 3
 *
 * Compares:
 * 1. USDC only
 * 2. Naive: short on any 3%+ daily drop
 * 3. Density-targeted with vol regime sizing (our strategy)
 */

import {
  fetchCandles,
  computeRollingVol,
  classifyVolRegime,
  Candle,
} from "./data-fetcher";
import { computeStats, printComparison, exportCsv, EquityPoint } from "./reporting";

const STARTING_CAPITAL = 100_000;
const MAX_TRADE_SIZE = 30_000;
const MAX_CONCURRENT = 3;
const TP_PCT = 3.0;
const SL_PCT = 1.5;
const MAX_HOLD_DAYS = 5;
const DRIFT_FEE_BPS = 3.5;
const USDC_YIELD = 0.045;
const MIN_DENSITY = 4;
const COOLDOWN_DAYS = 3; // Wait 3 days between new entries

interface Cluster {
  price: number;
  score: number; // 1-5
  direction: "long_liq" | "short_liq";
}

interface Trade {
  entryPrice: number;
  direction: "short" | "long";
  sizeUsd: number;
  tpPrice: number;
  slPrice: number;
  entryIdx: number;
}

function generateClusters(candles: Candle[], idx: number, lookback: number = 60): Cluster[] {
  if (idx < lookback) return [];
  const window = candles.slice(idx - lookback, idx);
  const current = candles[idx].close;
  if (current <= 0) return [];

  const clusters: Cluster[] = [];

  // Find swing lows (support) and swing highs (resistance)
  for (let i = 3; i < window.length - 3; i++) {
    const isSwingLow = window[i].low < window[i - 1].low && window[i].low < window[i + 1].low &&
                       window[i].low < window[i - 2].low && window[i].low < window[i + 2].low;
    const isSwingHigh = window[i].high > window[i - 1].high && window[i].high > window[i + 1].high &&
                        window[i].high > window[i - 2].high && window[i].high > window[i + 2].high;

    if (isSwingLow) {
      const liqPrice = window[i].low * 0.93; // 7% below support (leveraged long liquidation)
      const dist = ((current - liqPrice) / current) * 100;
      if (dist > 0 && dist < 15) {
        // Score: closer = denser, more recent = denser
        const recencyBonus = Math.min(2, (lookback - i) / 20);
        const proximityScore = Math.max(1, Math.round(5 - dist / 3));
        clusters.push({
          price: liqPrice,
          score: Math.min(5, proximityScore + Math.round(recencyBonus)),
          direction: "long_liq",
        });
      }
    }

    if (isSwingHigh) {
      const liqPrice = window[i].high * 1.07;
      const dist = ((liqPrice - current) / current) * 100;
      if (dist > 0 && dist < 15) {
        const recencyBonus = Math.min(2, (lookback - i) / 20);
        const proximityScore = Math.max(1, Math.round(5 - dist / 3));
        clusters.push({
          price: liqPrice,
          score: Math.min(5, proximityScore + Math.round(recencyBonus)),
          direction: "short_liq",
        });
      }
    }
  }

  // Volume-weighted recent low clusters
  const recentLow = Math.min(...candles.slice(idx - 10, idx).map((c) => c.low));
  const recentHigh = Math.max(...candles.slice(idx - 10, idx).map((c) => c.high));

  if (recentLow > 0) {
    const liqPrice = recentLow * 0.95;
    const dist = ((current - liqPrice) / current) * 100;
    if (dist > 0 && dist < 10) {
      clusters.push({ price: liqPrice, score: 4, direction: "long_liq" });
    }
  }
  if (recentHigh > 0) {
    const liqPrice = recentHigh * 1.05;
    const dist = ((liqPrice - current) / current) * 100;
    if (dist > 0 && dist < 10) {
      clusters.push({ price: liqPrice, score: 4, direction: "short_liq" });
    }
  }

  return clusters;
}

function simulateTrading(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>,
  useDensityFilter: boolean,
  useVolSizing: boolean
): { equity: EquityPoint[]; trades: number; wins: number } {
  const equity: EquityPoint[] = [];
  let capital = STARTING_CAPITAL;
  const active: Trade[] = [];
  let totalTrades = 0, wins = 0;
  let lastEntryIdx = -999;

  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));

  for (let i = 60; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.close <= 0 || prev.close <= 0) continue;

    const volBps = volMap.get(c.timestamp) ?? 3500;
    const volRegime = classifyVolRegime(volBps);
    const dailyReturn = (c.close - prev.close) / prev.close;

    // Check exits
    for (let j = active.length - 1; j >= 0; j--) {
      const t = active[j];
      let exit = false, pnlPct = 0;

      if (t.direction === "short") {
        if (c.low <= t.tpPrice) { pnlPct = TP_PCT; exit = true; }
        else if (c.high >= t.slPrice) { pnlPct = -SL_PCT; exit = true; }
      } else {
        if (c.high >= t.tpPrice) { pnlPct = TP_PCT; exit = true; }
        else if (c.low <= t.slPrice) { pnlPct = -SL_PCT; exit = true; }
      }

      // Time-based exit
      if (!exit && i - t.entryIdx >= MAX_HOLD_DAYS) {
        if (t.direction === "short") {
          pnlPct = ((t.entryPrice - c.close) / t.entryPrice) * 100;
        } else {
          pnlPct = ((c.close - t.entryPrice) / t.entryPrice) * 100;
        }
        exit = true;
      }

      if (exit) {
        const pnlUsd = t.sizeUsd * (pnlPct / 100);
        const fee = t.sizeUsd * 2 * DRIFT_FEE_BPS / 10000;
        capital += pnlUsd - fee;
        if (pnlUsd > fee) wins++;
        totalTrades++;
        active.splice(j, 1);
      }
    }

    // New entries (with cooldown)
    if (active.length < MAX_CONCURRENT && i - lastEntryIdx >= (useDensityFilter ? COOLDOWN_DAYS : 1)) {
      if (useDensityFilter) {
        // Density-targeted: only trade near dense clusters
        const clusters = generateClusters(candles, i);
        const nearby = clusters.filter((cl) => {
          const dist = Math.abs((c.close - cl.price) / c.close) * 100;
          return dist <= 3.0 && cl.score >= MIN_DENSITY;
        });

        if (nearby.length > 0) {
          const best = nearby.sort((a, b) => b.score - a.score)[0];
          const dir: "short" | "long" = best.direction === "long_liq" ? "short" : "long";

          // Vol-based sizing
          const volMult = useVolSizing
            ? (volRegime === "extreme" ? 0.3 : volRegime === "high" ? 0.5 : volRegime === "normal" ? 0.7 : 1.0)
            : 1.0;
          const size = Math.min(MAX_TRADE_SIZE * (best.score / 5) * volMult, capital * 0.15);

          if (size >= 500) {
            const tp = dir === "short" ? c.close * (1 - TP_PCT / 100) : c.close * (1 + TP_PCT / 100);
            const sl = dir === "short" ? c.close * (1 + SL_PCT / 100) : c.close * (1 - SL_PCT / 100);
            active.push({ entryPrice: c.close, direction: dir, sizeUsd: size, tpPrice: tp, slPrice: sl, entryIdx: i });
            lastEntryIdx = i;
          }
        }
      } else {
        // Naive: short on any significant daily drop
        if (dailyReturn < -0.03) {
          const size = Math.min(MAX_TRADE_SIZE, capital * 0.15);
          const tp = c.close * (1 - TP_PCT / 100);
          const sl = c.close * (1 + SL_PCT / 100);
          active.push({ entryPrice: c.close, direction: "short", sizeUsd: size, tpPrice: tp, slPrice: sl, entryIdx: i });
          lastEntryIdx = i;
        }
      }
    }

    // Idle yield
    const deployed = active.reduce((s, t) => s + t.sizeUsd, 0);
    const idle = Math.max(0, capital - deployed);
    capital += idle * (USDC_YIELD / 365.25);

    equity.push({ timestamp: c.timestamp, equity: Math.max(capital, 0) });
  }

  return { equity, trades: totalTrades, wins };
}

function simulateUsdc(candles: Candle[]): EquityPoint[] {
  const equity: EquityPoint[] = [];
  let capital = STARTING_CAPITAL;
  for (let i = 60; i < candles.length; i++) {
    capital *= (1 + USDC_YIELD / 365.25);
    equity.push({ timestamp: candles[i].timestamp, equity: capital });
  }
  return equity;
}

async function main(): Promise<void> {
  console.log("=== Liquidation Density Backtest ===\n");

  const candles = await fetchCandles("SOL-PERP", "D", 1000);
  console.log(`Loaded ${candles.length} daily candles`);
  const startDate = new Date(candles[0].timestamp * 1000).toISOString().split("T")[0];
  const endDate = new Date(candles[candles.length - 1].timestamp * 1000).toISOString().split("T")[0];
  console.log(`Range: ${startDate} to ${endDate}`);
  const prices = candles.map((c) => c.close).filter((p) => p > 0);
  console.log(`SOL: $${Math.min(...prices).toFixed(2)} — $${Math.max(...prices).toFixed(2)}`);
  console.log(`TP: ${TP_PCT}% | SL: ${SL_PCT}% | Max hold: ${MAX_HOLD_DAYS}d\n`);

  const volData = computeRollingVol(candles, 30);

  const naive = simulateTrading(candles, volData, false, false);
  const density = simulateTrading(candles, volData, true, true);

  const results = [
    computeStats("USDC only (4.5%)", simulateUsdc(candles)),
    (() => {
      const s = computeStats("Naive momentum short", naive.equity);
      s.metadata = { Trades: naive.trades, Wins: naive.wins, "Win%": `${((naive.wins / Math.max(naive.trades, 1)) * 100).toFixed(0)}%` };
      return s;
    })(),
    (() => {
      const s = computeStats("Density-targeted + vol sizing", density.equity);
      s.metadata = { Trades: density.trades, Wins: density.wins, "Win%": `${((density.wins / Math.max(density.trades, 1)) * 100).toFixed(0)}%` };
      return s;
    })(),
  ];

  printComparison(results);
  exportCsv(results, "/Users/hiroyusai/src/overlay/backtests/liquidation-density-results.csv");
}

main().catch(console.error);
