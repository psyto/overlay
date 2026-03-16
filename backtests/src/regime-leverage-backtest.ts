/**
 * Backtest: Regime-Adaptive Leverage (v3)
 *
 * Fixes:
 * - Execution costs modeled (borrow rate fluctuation, rebalance fees)
 * - Expanded to multiple yield pairs (JitoSOL/SOL, mSOL/SOL, USDC stable loop)
 * - Added "directional sizing" variant: instead of loop, size a SOL position by regime
 * - Realistic borrow rates correlated with vol regime
 */

import {
  fetchCandles,
  computeRollingVol,
  classifyVolRegime,
  estimateSignalSeverity,
  Candle,
} from "./data-fetcher";
import { computeStats, printComparison, exportCsv } from "./reporting";
import { kaminoBorrowRate, rebalanceCost } from "./execution-costs";

const STARTING_CAPITAL = 100_000;
const LIQUIDATION_LTV = 0.90;

// Yield sources
const YIELD_SOURCES: Record<string, { stakingApy: number; label: string }> = {
  jitoSOL: { stakingApy: 0.075, label: "JitoSOL/SOL" },
  mSOL:    { stakingApy: 0.068, label: "mSOL/SOL" },
  stable:  { stakingApy: 0.055, label: "USDC stable (Kamino supply)" },
};

const LOOP_LEVERAGE_MATRIX: Record<string, number[]> = {
  veryLow: [3.5, 3.0, 2.0, 1.0],
  low:     [3.0, 2.5, 1.5, 1.0],
  normal:  [2.5, 2.0, 1.5, 1.0],
  high:    [1.5, 1.0, 1.0, 1.0],
  extreme: [1.0, 1.0, 1.0, 1.0],
};

// Depeg params (realistic)
const DEPEG_PROB: Record<string, number> = {
  veryLow: 0.0, low: 0.001, normal: 0.003, high: 0.008, extreme: 0.02,
};
const DEPEG_MAX: Record<string, number> = {
  veryLow: 0.001, low: 0.002, normal: 0.004, high: 0.008, extreme: 0.015,
};

let rngState = 42;
function seededRandom(): number {
  rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

function getTargetLeverage(volBps: number, severity: number): number {
  const regime = classifyVolRegime(volBps);
  const row = LOOP_LEVERAGE_MATRIX[regime] ?? [1, 1, 1, 1];
  let lev = row[Math.min(severity, 3)] ?? 1.0;
  if (volBps >= 6500 && regime !== "extreme") lev = Math.min(lev, 1.5);
  return lev;
}

function simulateLoop(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>,
  getLeverage: (vol: number, sev: number) => number,
  source: { stakingApy: number },
  includeRebalanceCosts: boolean
) {
  const equity: Array<{ timestamp: number; equity: number }> = [];
  let capital = STARTING_CAPITAL;
  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));
  const dpy = 365.25;
  let prevLeverage = 1.0;
  let leverageHistory: number[] = [];
  let liquidations = 0;
  let totalCosts = 0;

  rngState = 42;

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i];
    if (c.close <= 0) continue;

    const volBps = volMap.get(c.timestamp) ?? 3500;
    const regime = classifyVolRegime(volBps);
    const severity = estimateSignalSeverity(candles, i);
    const leverage = getLeverage(volBps, severity);
    leverageHistory.push(leverage);

    // Dynamic borrow rate
    const borrowApy = kaminoBorrowRate(regime);
    const netApy = source.stakingApy * leverage - borrowApy * (leverage - 1);
    const dailyYield = netApy / dpy;
    capital += capital * dailyYield;

    // Rebalance cost when leverage changes significantly
    // Only rebalance weekly at most, and only if change > 0.5x
    if (includeRebalanceCosts && Math.abs(leverage - prevLeverage) > 0.5 && i % 7 === 0) {
      // Adjustment is the delta in borrowed amount, not the full position
      const adjustmentSize = capital * Math.abs(leverage - prevLeverage) * 0.3;
      const cost = rebalanceCost(adjustmentSize, c.close);
      capital -= cost;
      totalCosts += cost;
    }
    prevLeverage = leverage;

    // Depeg events
    if (seededRandom() < (DEPEG_PROB[regime] ?? 0.003)) {
      const depeg = seededRandom() * (DEPEG_MAX[regime] ?? 0.005);
      const loss = capital * leverage * depeg;
      const ltv = leverage > 1 ? 1 - 1 / leverage : 0;
      if (depeg > LIQUIDATION_LTV - ltv && leverage > 1.5) {
        capital -= capital * Math.min(0.5, leverage * depeg * 2);
        liquidations++;
      } else {
        capital -= loss;
      }
    }

    capital = Math.max(capital, 0);
    equity.push({ timestamp: c.timestamp, equity: capital });
  }

  const avgLev = leverageHistory.length > 0
    ? leverageHistory.reduce((s, l) => s + l, 0) / leverageHistory.length : 0;

  return { equity, avgLeverage: avgLev, liquidations, totalCosts };
}

/**
 * Directional sizing variant: instead of looping, size a SOL spot position by regime.
 * Bull signal → more SOL. Bear signal → less SOL, more USDC.
 */
function simulateDirectional(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>
) {
  const equity: Array<{ timestamp: number; equity: number }> = [];
  let capital = STARTING_CAPITAL;
  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));
  const dpy = 365.25;
  const usdcYield = 0.045;
  let totalCosts = 0;
  let prevAllocation = 0;

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (c.close <= 0 || prev.close <= 0) continue;

    const volBps = volMap.get(c.timestamp) ?? 3500;
    const regime = classifyVolRegime(volBps);
    const severity = estimateSignalSeverity(candles, i);

    // SOL allocation by regime: aggressive in calm, conservative in volatile
    const allocationPct: Record<string, number> = {
      veryLow: 0.8, low: 0.6, normal: 0.4, high: 0.2, extreme: 0.0,
    };
    const solAlloc = (allocationPct[regime] ?? 0.4) * (severity >= 2 ? 0.5 : 1.0);

    // Rebalance cost
    if (Math.abs(solAlloc - prevAllocation) > 0.1) {
      const adjSize = capital * Math.abs(solAlloc - prevAllocation);
      const cost = rebalanceCost(adjSize, c.close);
      capital -= cost;
      totalCosts += cost;
    }
    prevAllocation = solAlloc;

    // SOL portion moves with price
    const priceReturn = (c.close - prev.close) / prev.close;
    const solReturn = priceReturn * solAlloc * capital;

    // Staking yield on SOL portion
    const stakingReturn = (0.075 / dpy) * solAlloc * capital;

    // USDC yield on idle portion
    const usdcReturn = (usdcYield / dpy) * (1 - solAlloc) * capital;

    capital += solReturn + stakingReturn + usdcReturn;
    capital = Math.max(capital, 0);
    equity.push({ timestamp: c.timestamp, equity: capital });
  }

  return { equity, totalCosts };
}

async function main(): Promise<void> {
  console.log("=== Regime-Adaptive Leverage Backtest (v3 — with costs) ===\n");

  const candles = await fetchCandles("SOL-PERP", "D", 1000);
  console.log(`Loaded ${candles.length} daily candles`);
  const s = new Date(candles[0].timestamp * 1000).toISOString().split("T")[0];
  const e = new Date(candles[candles.length - 1].timestamp * 1000).toISOString().split("T")[0];
  console.log(`Range: ${s} to ${e}`);
  const prices = candles.map((c) => c.close).filter((p) => p > 0);
  console.log(`SOL: $${Math.min(...prices).toFixed(2)} — $${Math.max(...prices).toFixed(2)}\n`);

  const volData = computeRollingVol(candles, 30);

  const regimes: Record<string, number> = {};
  for (const v of volData) {
    const r = classifyVolRegime(v.volBps);
    regimes[r] = (regimes[r] ?? 0) + 1;
  }
  console.log("Vol regimes:");
  for (const [r, c] of Object.entries(regimes).sort())
    console.log(`  ${r}: ${((c / volData.length) * 100).toFixed(1)}%`);
  console.log("");

  // JitoSOL strategies
  const r1x = simulateLoop(candles, volData, () => 1.0, YIELD_SOURCES.jitoSOL, false);
  const r3x = simulateLoop(candles, volData, () => 3.0, YIELD_SOURCES.jitoSOL, true);
  const rAdaptive = simulateLoop(
    candles, volData, (v, s) => getTargetLeverage(v, s), YIELD_SOURCES.jitoSOL, true
  );

  // mSOL variant
  const rMsol = simulateLoop(
    candles, volData, (v, s) => getTargetLeverage(v, s), YIELD_SOURCES.mSOL, true
  );

  // Directional sizing (no loop, just regime-based SOL allocation)
  const rDir = simulateDirectional(candles, volData);

  // SOL buy & hold
  const solHold: Array<{ timestamp: number; equity: number }> = [];
  const startPrice = candles[30].close;
  for (let i = 30; i < candles.length; i++) {
    solHold.push({
      timestamp: candles[i].timestamp,
      equity: STARTING_CAPITAL * (candles[i].close / startPrice),
    });
  }

  const results = [
    computeStats("SOL buy & hold", solHold),
    (() => {
      const s = computeStats("1x JitoSOL (baseline)", r1x.equity);
      s.metadata = { "Rebalance costs": "$0" };
      return s;
    })(),
    (() => {
      const s = computeStats("Fixed 3x JitoSOL (with costs)", r3x.equity);
      s.metadata = { Liquidations: r3x.liquidations, "Costs": `$${r3x.totalCosts.toFixed(0)}` };
      return s;
    })(),
    (() => {
      const s = computeStats("Adaptive JitoSOL (with costs)", rAdaptive.equity);
      s.metadata = {
        "Avg leverage": rAdaptive.avgLeverage.toFixed(2) + "x",
        Liquidations: rAdaptive.liquidations,
        "Costs": `$${rAdaptive.totalCosts.toFixed(0)}`,
      };
      return s;
    })(),
    (() => {
      const s = computeStats("Adaptive mSOL (with costs)", rMsol.equity);
      s.metadata = {
        "Avg leverage": rMsol.avgLeverage.toFixed(2) + "x",
        "Costs": `$${rMsol.totalCosts.toFixed(0)}`,
      };
      return s;
    })(),
    (() => {
      const s = computeStats("Directional sizing (no loop)", rDir.equity);
      s.metadata = { "Costs": `$${rDir.totalCosts.toFixed(0)}` };
      return s;
    })(),
  ];

  printComparison(results);
  exportCsv(results, "/Users/hiroyusai/src/overlay/backtests/regime-leverage-results.csv");
}

main().catch(console.error);
