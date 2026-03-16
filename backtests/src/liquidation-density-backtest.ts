/**
 * Backtest: Liquidation Density (v3)
 *
 * Fixes:
 * - Execution costs: Drift fees, slippage, Jito tips
 * - Max 1 concurrent trade (correlation risk)
 * - Gap risk modeling: SL doesn't execute at target during flash crashes
 * - Wider TP/SL to account for friction: TP 5% / SL 2%
 * - Cooldown: 5 days between trades
 */

import {
  fetchCandles,
  computeRollingVol,
  classifyVolRegime,
  Candle,
} from "./data-fetcher";
import { computeStats, printComparison, exportCsv, EquityPoint } from "./reporting";
import { calculateTradeCost, jitoTipUsd } from "./execution-costs";

const STARTING_CAPITAL = 100_000;
const MAX_TRADE_SIZE = 20_000;   // Reduced from 30K
const MAX_CONCURRENT = 1;        // Down from 3 — correlation risk
const TP_PCT = 5.0;              // Wider TP to account for costs
const SL_PCT = 2.0;              // Wider SL to account for gap risk
const MAX_HOLD_DAYS = 5;
const COOLDOWN_DAYS = 5;         // Longer cooldown
const MIN_DENSITY = 4;
const USDC_YIELD = 0.045;

// Gap risk: during flash crashes, SL executes worse than target
// Model: if daily range > 8%, SL slips by 50% of the excess
const GAP_THRESHOLD_PCT = 8.0;
const GAP_SLIP_FACTOR = 0.5;

interface Cluster {
  price: number;
  score: number;
  direction: "long_liq" | "short_liq";
}

interface Trade {
  entryPrice: number;
  direction: "short" | "long";
  sizeUsd: number;
  tpPrice: number;
  slPrice: number;
  entryIdx: number;
  entryCost: number;
}

function generateClusters(candles: Candle[], idx: number, lookback: number = 60): Cluster[] {
  if (idx < lookback) return [];
  const window = candles.slice(idx - lookback, idx);
  const current = candles[idx].close;
  if (current <= 0) return [];

  const clusters: Cluster[] = [];

  for (let i = 3; i < window.length - 3; i++) {
    const isLow = window[i].low < window[i - 1].low && window[i].low < window[i + 1].low &&
                  window[i].low < window[i - 2].low && window[i].low < window[i + 2].low;
    const isHigh = window[i].high > window[i - 1].high && window[i].high > window[i + 1].high &&
                   window[i].high > window[i - 2].high && window[i].high > window[i + 2].high;

    if (isLow) {
      const liqPrice = window[i].low * 0.93;
      const dist = ((current - liqPrice) / current) * 100;
      if (dist > 0 && dist < 15) {
        const recencyBonus = Math.min(2, (lookback - i) / 20);
        const score = Math.min(5, Math.max(1, Math.round(5 - dist / 3)) + Math.round(recencyBonus));
        clusters.push({ price: liqPrice, score, direction: "long_liq" });
      }
    }
    if (isHigh) {
      const liqPrice = window[i].high * 1.07;
      const dist = ((liqPrice - current) / current) * 100;
      if (dist > 0 && dist < 15) {
        const recencyBonus = Math.min(2, (lookback - i) / 20);
        const score = Math.min(5, Math.max(1, Math.round(5 - dist / 3)) + Math.round(recencyBonus));
        clusters.push({ price: liqPrice, score, direction: "short_liq" });
      }
    }
  }

  // Recent support/resistance
  const recentLow = Math.min(...candles.slice(idx - 10, idx).map((c) => c.low));
  const recentHigh = Math.max(...candles.slice(idx - 10, idx).map((c) => c.high));

  if (recentLow > 0) {
    const liqPrice = recentLow * 0.95;
    const dist = ((current - liqPrice) / current) * 100;
    if (dist > 0 && dist < 10)
      clusters.push({ price: liqPrice, score: 4, direction: "long_liq" });
  }
  if (recentHigh > 0) {
    const liqPrice = recentHigh * 1.05;
    const dist = ((liqPrice - current) / current) * 100;
    if (dist > 0 && dist < 10)
      clusters.push({ price: liqPrice, score: 4, direction: "short_liq" });
  }

  return clusters;
}

function simulateTrading(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>,
  useDensityFilter: boolean,
  withCosts: boolean
): { equity: EquityPoint[]; trades: number; wins: number; totalCosts: number } {
  const equity: EquityPoint[] = [];
  let capital = STARTING_CAPITAL;
  const active: Trade[] = [];
  let totalTrades = 0, wins = 0, totalCosts = 0;
  let lastEntryIdx = -999;

  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));

  for (let i = 60; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.close <= 0 || prev.close <= 0) continue;

    const volBps = volMap.get(c.timestamp) ?? 3500;
    const volRegime = classifyVolRegime(volBps);
    const dailyRange = c.high > 0 ? ((c.high - c.low) / c.high) * 100 : 0;

    // Check exits
    for (let j = active.length - 1; j >= 0; j--) {
      const t = active[j];
      let exit = false, pnlPct = 0, reason = "";

      if (t.direction === "short") {
        if (c.low <= t.tpPrice) { pnlPct = TP_PCT; exit = true; reason = "TP"; }
        else if (c.high >= t.slPrice) {
          pnlPct = -SL_PCT;
          // Gap risk: if daily range is extreme, SL slips
          if (dailyRange > GAP_THRESHOLD_PCT) {
            const extraSlip = (dailyRange - GAP_THRESHOLD_PCT) * GAP_SLIP_FACTOR;
            pnlPct -= extraSlip;
            reason = `SL+gap(${extraSlip.toFixed(1)}%)`;
          } else {
            reason = "SL";
          }
          exit = true;
        }
      } else {
        if (c.high >= t.tpPrice) { pnlPct = TP_PCT; exit = true; reason = "TP"; }
        else if (c.low <= t.slPrice) {
          pnlPct = -SL_PCT;
          if (dailyRange > GAP_THRESHOLD_PCT) {
            const extraSlip = (dailyRange - GAP_THRESHOLD_PCT) * GAP_SLIP_FACTOR;
            pnlPct -= extraSlip;
            reason = `SL+gap(${extraSlip.toFixed(1)}%)`;
          } else {
            reason = "SL";
          }
          exit = true;
        }
      }

      // Time exit
      if (!exit && i - t.entryIdx >= MAX_HOLD_DAYS) {
        if (t.direction === "short") {
          pnlPct = ((t.entryPrice - c.close) / t.entryPrice) * 100;
        } else {
          pnlPct = ((c.close - t.entryPrice) / t.entryPrice) * 100;
        }
        exit = true;
        reason = "timeout";
      }

      if (exit) {
        const pnlUsd = t.sizeUsd * (pnlPct / 100);
        let exitCost = 0;
        if (withCosts) {
          const cost = calculateTradeCost(t.sizeUsd, c.close);
          exitCost = cost.totalUsd + jitoTipUsd(c.close);
        }
        capital += pnlUsd - t.entryCost - exitCost;
        totalCosts += t.entryCost + exitCost;
        if (pnlUsd > t.entryCost + exitCost) wins++;
        totalTrades++;
        active.splice(j, 1);
      }
    }

    // New entries
    if (active.length < MAX_CONCURRENT && i - lastEntryIdx >= COOLDOWN_DAYS) {
      if (useDensityFilter) {
        const clusters = generateClusters(candles, i);
        const nearby = clusters.filter((cl) => {
          const dist = Math.abs((c.close - cl.price) / c.close) * 100;
          return dist <= 3.0 && cl.score >= MIN_DENSITY;
        });

        if (nearby.length > 0) {
          const best = nearby.sort((a, b) => b.score - a.score)[0];
          const dir: "short" | "long" = best.direction === "long_liq" ? "short" : "long";

          const volMult = volRegime === "extreme" ? 0.3 : volRegime === "high" ? 0.5 : 0.7;
          const size = Math.min(MAX_TRADE_SIZE * (best.score / 5) * volMult, capital * 0.1);

          if (size >= 500) {
            let entryCost = 0;
            if (withCosts) {
              const cost = calculateTradeCost(size, c.close);
              entryCost = cost.totalUsd + jitoTipUsd(c.close);
            }

            const tp = dir === "short" ? c.close * (1 - TP_PCT / 100) : c.close * (1 + TP_PCT / 100);
            const sl = dir === "short" ? c.close * (1 + SL_PCT / 100) : c.close * (1 - SL_PCT / 100);
            active.push({
              entryPrice: c.close, direction: dir, sizeUsd: size,
              tpPrice: tp, slPrice: sl, entryIdx: i, entryCost,
            });
            lastEntryIdx = i;
          }
        }
      } else {
        // Naive: short on 3%+ daily drop
        const dailyReturn = (c.close - prev.close) / prev.close;
        if (dailyReturn < -0.03) {
          const size = Math.min(MAX_TRADE_SIZE, capital * 0.1);
          let entryCost = 0;
          if (withCosts) {
            const cost = calculateTradeCost(size, c.close);
            entryCost = cost.totalUsd + jitoTipUsd(c.close);
          }

          const tp = c.close * (1 - TP_PCT / 100);
          const sl = c.close * (1 + SL_PCT / 100);
          active.push({
            entryPrice: c.close, direction: "short", sizeUsd: size,
            tpPrice: tp, slPrice: sl, entryIdx: i, entryCost,
          });
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

  return { equity, trades: totalTrades, wins, totalCosts };
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
  console.log("=== Liquidation Density Backtest (v3 — costs + gap risk) ===\n");

  const candles = await fetchCandles("SOL-PERP", "D", 1000);
  console.log(`Loaded ${candles.length} daily candles`);
  const s = new Date(candles[0].timestamp * 1000).toISOString().split("T")[0];
  const e = new Date(candles[candles.length - 1].timestamp * 1000).toISOString().split("T")[0];
  console.log(`Range: ${s} to ${e}`);
  console.log(`TP: ${TP_PCT}% | SL: ${SL_PCT}% | Max hold: ${MAX_HOLD_DAYS}d | Cooldown: ${COOLDOWN_DAYS}d`);
  console.log(`Max concurrent: ${MAX_CONCURRENT} | Gap threshold: ${GAP_THRESHOLD_PCT}%\n`);

  const volData = computeRollingVol(candles, 30);

  const naiveNoCost = simulateTrading(candles, volData, false, false);
  const naiveCost = simulateTrading(candles, volData, false, true);
  const densityNoCost = simulateTrading(candles, volData, true, false);
  const densityCost = simulateTrading(candles, volData, true, true);

  const results = [
    computeStats("USDC only (4.5%)", simulateUsdc(candles)),
    (() => {
      const r = computeStats("Naive momentum (no costs)", naiveNoCost.equity);
      r.metadata = { Trades: naiveNoCost.trades, Wins: naiveNoCost.wins, "Win%": `${((naiveNoCost.wins / Math.max(naiveNoCost.trades, 1)) * 100).toFixed(0)}%` };
      return r;
    })(),
    (() => {
      const r = computeStats("Naive momentum (with costs)", naiveCost.equity);
      r.metadata = { Trades: naiveCost.trades, Wins: naiveCost.wins, "Win%": `${((naiveCost.wins / Math.max(naiveCost.trades, 1)) * 100).toFixed(0)}%`, Costs: `$${naiveCost.totalCosts.toFixed(0)}` };
      return r;
    })(),
    (() => {
      const r = computeStats("Density-targeted (no costs)", densityNoCost.equity);
      r.metadata = { Trades: densityNoCost.trades, Wins: densityNoCost.wins, "Win%": `${((densityNoCost.wins / Math.max(densityNoCost.trades, 1)) * 100).toFixed(0)}%` };
      return r;
    })(),
    (() => {
      const r = computeStats("Density-targeted (with costs)", densityCost.equity);
      r.metadata = { Trades: densityCost.trades, Wins: densityCost.wins, "Win%": `${((densityCost.wins / Math.max(densityCost.trades, 1)) * 100).toFixed(0)}%`, Costs: `$${densityCost.totalCosts.toFixed(0)}` };
      return r;
    })(),
  ];

  printComparison(results);
  exportCsv(results, "/Users/hiroyusai/src/overlay/backtests/liquidation-density-results.csv");
}

main().catch(console.error);
