/**
 * Backtest: JLP Gamma Hedge (v2 — regime-aware delta toggle)
 *
 * Model improvements:
 * - Delta hedge toggled by trend regime: OFF in bull, ON in range/bear
 * - Trend detection: 30-day SMA crossover
 * - Gamma hedge premium scaled more conservatively
 * - VolSwap payout capped at 2x premium
 * - Added: JLP + trend-aware delta + gamma (our strategy)
 */

import {
  fetchCandles,
  computeRollingVol,
  classifyVolRegime,
  estimateSignalSeverity,
  Candle,
} from "./data-fetcher";
import { computeStats, printComparison, exportCsv, EquityPoint } from "./reporting";

const STARTING_CAPITAL = 100_000;
const JLP_FEE_APY = 0.25;
const USDC_YIELD = 0.045;
const BASKET_NON_STABLE = 0.65;
const GAMMA_COEFFICIENT = 0.5;
const DRIFT_FEE_BPS = 3.5;

const VOLSWAP_PREMIUM_PCT = 0.04;
const VOLSWAP_MAX_PAYOUT_MULT = 2; // Capped at 2x (was 3x)
const VOLSWAP_EPOCH_DAYS = 7;

const HEDGE_RATIO: Record<string, number> = {
  veryLow: 1.0, low: 0.9, normal: 0.7, high: 0.5, extreme: 0.3,
};

type DeltaMode = "always" | "never" | "trend_aware";

/**
 * Detect trend regime from SMA crossover.
 * Bull: price > 30d SMA AND 30d SMA rising
 * Bear/Range: otherwise
 */
function detectTrend(candles: Candle[], idx: number): "bull" | "bear" | "range" {
  if (idx < 60) return "range";

  const sma30 = candles.slice(idx - 30, idx).reduce((s, c) => s + c.close, 0) / 30;
  const sma30prev = candles.slice(idx - 31, idx - 1).reduce((s, c) => s + c.close, 0) / 30;
  const sma60 = candles.slice(idx - 60, idx).reduce((s, c) => s + c.close, 0) / 60;

  const current = candles[idx].close;
  const smaRising = sma30 > sma30prev;

  if (current > sma30 && sma30 > sma60 && smaRising) return "bull";
  if (current < sma30 && sma30 < sma60) return "bear";
  return "range";
}

function simulateJlp(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>,
  deltaMode: DeltaMode,
  gammaHedge: boolean,
  name: string
): EquityPoint[] {
  const equity: EquityPoint[] = [];
  let capital = STARTING_CAPITAL;
  let jlpValue = STARTING_CAPITAL;
  let cumHedgePnl = 0;
  let cumGammaPnl = 0;
  let cumCost = 0;

  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));
  const dpy = 365.25;

  let deltaHedgeSize = 0;
  let vsNotional = 0, vsStrikeVol = 0, vsPremium = 0;
  let daysSinceEpoch = 0;
  let epochReturns: number[] = [];
  let deltaActive = false;

  for (let i = 60; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (prev.close <= 0 || c.close <= 0) continue;

    const volBps = volMap.get(c.timestamp) ?? 3500;
    const volRegime = classifyVolRegime(volBps);
    const severity = estimateSignalSeverity(candles, i);
    const dailyReturn = (c.close - prev.close) / prev.close;
    const trend = detectTrend(candles, i);

    // Determine if delta hedge should be active
    switch (deltaMode) {
      case "always": deltaActive = true; break;
      case "never": deltaActive = false; break;
      case "trend_aware":
        // Delta hedge ON in bear/range, OFF in bull
        deltaActive = trend !== "bull";
        break;
    }

    // 1. JLP fee yield
    const dailyFee = (JLP_FEE_APY / dpy) * jlpValue;

    // 2. Basket exposure
    const basketReturn = dailyReturn * BASKET_NON_STABLE;

    // 3. Gamma loss
    const gammaLoss = -GAMMA_COEFFICIENT * BASKET_NON_STABLE * dailyReturn * dailyReturn * jlpValue;

    jlpValue = jlpValue * (1 + basketReturn) + dailyFee + gammaLoss;

    // 4. Delta hedge
    if (deltaActive) {
      if (i % 7 === 0) {
        const target = jlpValue * BASKET_NON_STABLE;
        const adj = Math.abs(target - deltaHedgeSize);
        cumCost += adj * DRIFT_FEE_BPS / 10000;
        deltaHedgeSize = target;
      }
      cumHedgePnl += -dailyReturn * deltaHedgeSize;
    } else {
      // Unwind delta hedge gradually
      if (deltaHedgeSize > 0 && i % 7 === 0) {
        cumCost += deltaHedgeSize * DRIFT_FEE_BPS / 10000;
        deltaHedgeSize = 0;
      }
    }

    // 5. Gamma hedge
    if (gammaHedge) {
      epochReturns.push(dailyReturn);
      daysSinceEpoch++;

      if (daysSinceEpoch >= VOLSWAP_EPOCH_DAYS) {
        if (vsNotional > 0 && vsStrikeVol > 0) {
          const mean = epochReturns.reduce((s, r) => s + r, 0) / epochReturns.length;
          const variance = epochReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / epochReturns.length;
          const realVol = Math.sqrt(variance * 252);
          const strikeVol = vsStrikeVol / 10000;

          if (strikeVol > 0) {
            let payout = vsNotional * (realVol ** 2 - strikeVol ** 2) / (strikeVol ** 2);
            payout = Math.max(-vsPremium, Math.min(payout, vsPremium * VOLSWAP_MAX_PAYOUT_MULT));
            cumGammaPnl += payout;
          }
        }

        // New epoch — only open if delta hedge is active AND vol is elevated
        // In low vol, the premium cost isn't worth it
        if (deltaActive && volBps >= 3500) {
          const ratio = Math.min((HEDGE_RATIO[volRegime] ?? 0.7) * 0.5, 0.8); // More conservative sizing
          vsNotional = jlpValue * BASKET_NON_STABLE * ratio;
          vsStrikeVol = volBps;
          vsPremium = vsNotional * VOLSWAP_PREMIUM_PCT;
          cumCost += vsPremium;
        } else {
          vsNotional = 0;
        }

        daysSinceEpoch = 0;
        epochReturns = [];
      }
    }

    capital = jlpValue + cumHedgePnl + cumGammaPnl - cumCost;
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
  console.log("=== JLP Gamma Hedge Backtest (v2 — trend-aware) ===\n");

  const candles = await fetchCandles("SOL-PERP", "D", 1000);
  console.log(`Loaded ${candles.length} daily candles`);
  const s = new Date(candles[0].timestamp * 1000).toISOString().split("T")[0];
  const e = new Date(candles[candles.length - 1].timestamp * 1000).toISOString().split("T")[0];
  console.log(`Range: ${s} to ${e}`);
  const prices = candles.map((c) => c.close).filter((p) => p > 0);
  console.log(`SOL: $${Math.min(...prices).toFixed(2)} — $${Math.max(...prices).toFixed(2)}\n`);

  const volData = computeRollingVol(candles, 30);

  // Trend distribution
  let bullDays = 0, bearDays = 0, rangeDays = 0;
  for (let i = 60; i < candles.length; i++) {
    const t = detectTrend(candles, i);
    if (t === "bull") bullDays++;
    else if (t === "bear") bearDays++;
    else rangeDays++;
  }
  const total = bullDays + bearDays + rangeDays;
  console.log(`Trend: bull ${((bullDays / total) * 100).toFixed(0)}% | bear ${((bearDays / total) * 100).toFixed(0)}% | range ${((rangeDays / total) * 100).toFixed(0)}%\n`);

  const results = [
    computeStats("USDC only (4.5%)", simulateUsdc(candles)),
    computeStats("JLP unhedged", simulateJlp(candles, volData, "never", false, "unhedged")),
    computeStats("JLP + always delta", simulateJlp(candles, volData, "always", false, "always-delta")),
    computeStats("JLP + trend-aware delta", simulateJlp(candles, volData, "trend_aware", false, "trend-delta")),
    computeStats("JLP + trend delta + gamma", simulateJlp(candles, volData, "trend_aware", true, "full")),
  ];

  printComparison(results);
  exportCsv(results, "/Users/hiroyusai/src/overlay/backtests/jlp-gamma-hedge-results.csv");
}

main().catch(console.error);
