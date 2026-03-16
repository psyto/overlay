/**
 * Backtest: JLP Trend-Aware Delta Hedge (v3)
 *
 * Fixes:
 * - Execution costs: Drift fees, slippage, funding rate drag on shorts
 * - Replace SMA crossover with leading indicators: OI skew + funding rate direction
 * - Compare: SMA-based vs OI-based trend detection
 * - Funding rate drag on short positions modeled explicitly
 */

import {
  fetchCandles,
  computeRollingVol,
  classifyVolRegime,
  estimateSignalSeverity,
  Candle,
} from "./data-fetcher";
import { computeStats, printComparison, exportCsv, EquityPoint } from "./reporting";
import { calculateTradeCost, fundingRateDrag } from "./execution-costs";

const STARTING_CAPITAL = 100_000;
const JLP_FEE_APY = 0.25;
const USDC_YIELD = 0.045;
const BASKET_NON_STABLE = 0.65;
const GAMMA_COEFFICIENT = 0.5;

type TrendMethod = "sma" | "oi_funding" | "none" | "always";

// --- SMA Trend Detection (lagging — original) ---

function detectTrendSMA(candles: Candle[], idx: number): "bull" | "bear" | "range" {
  if (idx < 60) return "range";
  const sma30 = candles.slice(idx - 30, idx).reduce((s, c) => s + c.close, 0) / 30;
  const sma30prev = candles.slice(idx - 31, idx - 1).reduce((s, c) => s + c.close, 0) / 30;
  const sma60 = candles.slice(idx - 60, idx).reduce((s, c) => s + c.close, 0) / 60;
  const current = candles[idx].close;

  if (current > sma30 && sma30 > sma60 && sma30 > sma30prev) return "bull";
  if (current < sma30 && sma30 < sma60) return "bear";
  return "range";
}

// --- OI + Funding Leading Indicator (new) ---
// Uses price momentum + volume as proxy for OI skew
// (real implementation would read Drift OI directly)

function detectTrendOIFunding(candles: Candle[], idx: number): "bull" | "bear" | "range" {
  if (idx < 14) return "range";

  // 7-day momentum (leading vs 30-day SMA)
  const current = candles[idx].close;
  const weekAgo = candles[idx - 7].close;
  const twoWeeksAgo = candles[idx - 14].close;

  const momentum7d = (current - weekAgo) / weekAgo;
  const momentum14d = (current - twoWeeksAgo) / twoWeeksAgo;

  // Volume trend as OI proxy: rising volume + rising price = bullish OI skew
  const recentVolume = candles.slice(idx - 7, idx).reduce((s, c) => s + c.volume, 0) / 7;
  const priorVolume = candles.slice(idx - 14, idx - 7).reduce((s, c) => s + c.volume, 0) / 7;
  const volumeTrend = priorVolume > 0 ? recentVolume / priorVolume : 1;

  // Funding rate proxy: use price range compression/expansion
  // Narrow range = funding neutral, expanding range = directional funding
  const recentRange = candles.slice(idx - 3, idx).reduce(
    (s, c) => s + (c.high - c.low) / c.close, 0
  ) / 3;

  // Bull: positive momentum + rising volume
  if (momentum7d > 0.03 && momentum14d > 0.05 && volumeTrend > 1.0) return "bull";

  // Bear: negative momentum + rising volume (panic selling)
  if (momentum7d < -0.03 && momentum14d < -0.05 && volumeTrend > 1.0) return "bear";

  // Strong momentum override
  if (momentum7d > 0.08) return "bull";
  if (momentum7d < -0.08) return "bear";

  return "range";
}

// --- Simulation ---

function simulateJlp(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>,
  trendMethod: TrendMethod,
  withCosts: boolean
): EquityPoint[] {
  const equity: EquityPoint[] = [];
  let capital = STARTING_CAPITAL;
  let jlpValue = STARTING_CAPITAL;
  let cumHedgePnl = 0;
  let cumCost = 0;

  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));
  const dpy = 365.25;

  let deltaHedgeSize = 0;
  let deltaActive = false;

  for (let i = 60; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0 || c.close <= 0) continue;

    const dailyReturn = (c.close - prev.close) / prev.close;

    // Determine trend
    switch (trendMethod) {
      case "sma":
        deltaActive = detectTrendSMA(candles, i) !== "bull";
        break;
      case "oi_funding":
        deltaActive = detectTrendOIFunding(candles, i) !== "bull";
        break;
      case "always":
        deltaActive = true;
        break;
      case "none":
        deltaActive = false;
        break;
    }

    // JLP: fee yield + basket exposure + gamma loss
    const dailyFee = (JLP_FEE_APY / dpy) * jlpValue;
    const basketReturn = dailyReturn * BASKET_NON_STABLE;
    const gammaLoss = -GAMMA_COEFFICIENT * BASKET_NON_STABLE * dailyReturn * dailyReturn * jlpValue;
    jlpValue = jlpValue * (1 + basketReturn) + dailyFee + gammaLoss;

    // Delta hedge
    if (deltaActive) {
      // Weekly rebalance
      if (i % 7 === 0) {
        const target = jlpValue * BASKET_NON_STABLE;
        const adjustment = Math.abs(target - deltaHedgeSize);

        if (withCosts && adjustment > 100) {
          const cost = calculateTradeCost(adjustment, c.close);
          cumCost += cost.totalUsd;
        }
        deltaHedgeSize = target;
      }

      // Short P&L
      cumHedgePnl += -dailyReturn * deltaHedgeSize;

      // Funding rate drag: shorts pay when funding is negative (bullish bias)
      // Real SOL-PERP funding averages ~0.003% per 8h period = ~0.001% per day
      if (withCosts && deltaHedgeSize > 0) {
        // Only pay funding when market is bullish (shorts pay longs)
        const fundingDrag = dailyReturn > 0
          ? deltaHedgeSize * 0.0001  // ~0.01% per day in bull
          : 0;                        // No drag in bear (shorts receive)
        cumCost += fundingDrag;
      }
    } else {
      // Unwind
      if (deltaHedgeSize > 0) {
        if (withCosts) {
          const cost = calculateTradeCost(deltaHedgeSize, c.close);
          cumCost += cost.totalUsd;
        }
        deltaHedgeSize = 0;
      }
    }

    capital = jlpValue + cumHedgePnl - cumCost;
    capital = Math.max(capital, 0);
    equity.push({ timestamp: c.timestamp, equity: capital });
  }

  return equity;
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
  console.log("=== JLP Delta Hedge Backtest (v3 — OI signals + costs) ===\n");

  const candles = await fetchCandles("SOL-PERP", "D", 1000);
  console.log(`Loaded ${candles.length} daily candles`);
  const s = new Date(candles[0].timestamp * 1000).toISOString().split("T")[0];
  const e = new Date(candles[candles.length - 1].timestamp * 1000).toISOString().split("T")[0];
  console.log(`Range: ${s} to ${e}`);
  const prices = candles.map((c) => c.close).filter((p) => p > 0);
  console.log(`SOL: $${Math.min(...prices).toFixed(2)} — $${Math.max(...prices).toFixed(2)}\n`);

  const volData = computeRollingVol(candles, 30);

  // Trend distribution comparison
  let smaBull = 0, smaBear = 0, smaRange = 0;
  let oiBull = 0, oiBear = 0, oiRange = 0;
  for (let i = 60; i < candles.length; i++) {
    const t1 = detectTrendSMA(candles, i);
    const t2 = detectTrendOIFunding(candles, i);
    if (t1 === "bull") smaBull++; else if (t1 === "bear") smaBear++; else smaRange++;
    if (t2 === "bull") oiBull++; else if (t2 === "bear") oiBear++; else oiRange++;
  }
  const total = candles.length - 60;
  console.log("Trend detection comparison:");
  console.log(`  SMA:        bull ${((smaBull / total) * 100).toFixed(0)}% | bear ${((smaBear / total) * 100).toFixed(0)}% | range ${((smaRange / total) * 100).toFixed(0)}%`);
  console.log(`  OI/Funding: bull ${((oiBull / total) * 100).toFixed(0)}% | bear ${((oiBear / total) * 100).toFixed(0)}% | range ${((oiRange / total) * 100).toFixed(0)}%`);
  console.log("");

  const results = [
    computeStats("USDC only (4.5%)", simulateUsdc(candles)),
    computeStats("JLP unhedged", simulateJlp(candles, volData, "none", false)),
    computeStats("JLP + SMA delta (no costs)", simulateJlp(candles, volData, "sma", false)),
    computeStats("JLP + SMA delta (with costs)", simulateJlp(candles, volData, "sma", true)),
    computeStats("JLP + OI/funding delta (no costs)", simulateJlp(candles, volData, "oi_funding", false)),
    computeStats("JLP + OI/funding delta (with costs)", simulateJlp(candles, volData, "oi_funding", true)),
  ];

  printComparison(results);
  exportCsv(results, "/Users/hiroyusai/src/overlay/backtests/jlp-gamma-hedge-results.csv");
}

main().catch(console.error);
