/**
 * Backtest: Regime-Adaptive Leverage (v2 — with realistic depeg events)
 *
 * Model improvements:
 * - JitoSOL/SOL depeg events: 0.5-3% depegs during high vol periods
 * - Depeg frequency scales with vol regime
 * - At high leverage, depeg causes partial liquidation
 * - Kamino borrow rate varies with utilization (higher in volatile markets)
 */

import {
  fetchCandles,
  computeRollingVol,
  classifyVolRegime,
  estimateSignalSeverity,
  Candle,
} from "./data-fetcher";
import { computeStats, printComparison, exportCsv } from "./reporting";

const STARTING_CAPITAL = 100_000;
const JITOSOL_BASE_APY = 0.075;
const LIQUIDATION_LTV = 0.90;

// Borrow rate varies by vol regime (higher utilization in volatile markets)
const BORROW_APY_BY_REGIME: Record<string, number> = {
  veryLow: 0.02,   // 2% — calm, low demand
  low: 0.03,       // 3%
  normal: 0.04,    // 4%
  high: 0.06,      // 6% — high demand for leverage
  extreme: 0.10,   // 10% — extreme utilization spikes
};

// Depeg probability per day by vol regime
// Real-world: JitoSOL/SOL depegs are infrequent, mostly <0.5%
const DEPEG_PROB_BY_REGIME: Record<string, number> = {
  veryLow: 0.0,     // Essentially never
  low: 0.001,       // ~0.4/year
  normal: 0.003,    // ~1/year
  high: 0.008,      // ~3/year
  extreme: 0.02,    // ~7/year
};

// Depeg severity by vol regime (max % deviation)
// Real-world: JitoSOL has strong peg mechanics, depegs are small
const DEPEG_SEVERITY_BY_REGIME: Record<string, number> = {
  veryLow: 0.001,   // 0.1%
  low: 0.002,       // 0.2%
  normal: 0.004,    // 0.4%
  high: 0.008,      // 0.8%
  extreme: 0.015,   // 1.5%
};

const LOOP_LEVERAGE_MATRIX: Record<string, number[]> = {
  veryLow: [3.5, 3.0, 2.0, 1.0],
  low:     [3.0, 2.5, 1.5, 1.0],
  normal:  [2.5, 2.0, 1.5, 1.0],
  high:    [1.5, 1.0, 1.0, 1.0],
  extreme: [1.0, 1.0, 1.0, 1.0],
};

function getTargetLeverage(volBps: number, severity: number): number {
  const regime = classifyVolRegime(volBps);
  const row = LOOP_LEVERAGE_MATRIX[regime] ?? [1, 1, 1, 1];
  let lev = row[Math.min(severity, 3)] ?? 1.0;
  if (volBps >= 6500 && regime !== "extreme") lev = Math.min(lev, 1.5);
  return lev;
}

function effectiveApy(leverage: number, borrowApy: number): number {
  if (leverage <= 1) return JITOSOL_BASE_APY;
  return JITOSOL_BASE_APY * leverage - borrowApy * (leverage - 1);
}

// Seeded RNG for reproducibility
let rngState = 42;
function seededRandom(): number {
  rngState = (rngState * 1664525 + 1013904223) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

function simulate(
  candles: Candle[],
  volData: Array<{ timestamp: number; volBps: number }>,
  getLeverage: (vol: number, sev: number) => number,
  label: string
) {
  const equity: Array<{ timestamp: number; equity: number }> = [];
  let capital = STARTING_CAPITAL;
  const volMap = new Map(volData.map((v) => [v.timestamp, v.volBps]));
  const dpy = 365.25;

  let leverageHistory: number[] = [];
  let liquidationEvents = 0;
  let depegEvents = 0;

  rngState = 42; // Reset for reproducibility

  for (let i = 30; i < candles.length; i++) {
    const c = candles[i];
    if (c.close <= 0) continue;

    const volBps = volMap.get(c.timestamp) ?? 3500;
    const regime = classifyVolRegime(volBps);
    const severity = estimateSignalSeverity(candles, i);
    const leverage = getLeverage(volBps, severity);
    leverageHistory.push(leverage);

    const borrowApy = BORROW_APY_BY_REGIME[regime] ?? 0.04;

    // Daily yield
    const dailyYield = effectiveApy(leverage, borrowApy) / dpy;
    capital += capital * dailyYield;

    // Depeg event simulation
    const depegProb = DEPEG_PROB_BY_REGIME[regime] ?? 0.01;
    const depegMax = DEPEG_SEVERITY_BY_REGIME[regime] ?? 0.01;

    if (seededRandom() < depegProb) {
      const depegPct = seededRandom() * depegMax;
      depegEvents++;

      // Impact: at leverage L, a depeg of D% causes L×D% loss on equity
      // Because collateral (JitoSOL) drops but debt (SOL) doesn't
      const lossMultiplier = leverage * depegPct;
      const loss = capital * lossMultiplier;

      // Check if this triggers liquidation
      const ltv = leverage > 1 ? 1 - 1 / leverage : 0;
      const marginToLiq = LIQUIDATION_LTV - ltv;

      if (depegPct > marginToLiq && leverage > 1.5) {
        // Partial liquidation: lose the leveraged portion
        const liqLoss = capital * Math.min(0.5, lossMultiplier * 2);
        capital -= liqLoss;
        liquidationEvents++;
      } else {
        capital -= loss;
      }
    }

    capital = Math.max(capital, 0);
    equity.push({ timestamp: c.timestamp, equity: capital });
  }

  const avgLeverage = leverageHistory.length > 0
    ? leverageHistory.reduce((s, l) => s + l, 0) / leverageHistory.length : 0;

  return { equity, avgLeverage, liquidationEvents, depegEvents };
}

async function main(): Promise<void> {
  console.log("=== Regime-Adaptive Leverage Backtest (v2) ===\n");

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

  const r1 = simulate(candles, volData, () => 1.0, "1x");
  const r2 = simulate(candles, volData, () => 2.0, "2x");
  const r3 = simulate(candles, volData, () => 3.0, "3x");
  const r4 = simulate(candles, volData, (v, s) => getTargetLeverage(v, s), "adaptive");

  const results = [
    (() => {
      const s = computeStats("1x JitoSOL", r1.equity);
      s.metadata = { Depegs: r1.depegEvents, Liquidations: r1.liquidationEvents };
      return s;
    })(),
    (() => {
      const s = computeStats("Fixed 2x loop", r2.equity);
      s.metadata = { Depegs: r2.depegEvents, Liquidations: r2.liquidationEvents };
      return s;
    })(),
    (() => {
      const s = computeStats("Fixed 3x loop", r3.equity);
      s.metadata = { Depegs: r3.depegEvents, Liquidations: r3.liquidationEvents };
      return s;
    })(),
    (() => {
      const s = computeStats("Regime-adaptive", r4.equity);
      s.metadata = {
        "Avg leverage": r4.avgLeverage.toFixed(2) + "x",
        Depegs: r4.depegEvents,
        Liquidations: r4.liquidationEvents,
      };
      return s;
    })(),
  ];

  printComparison(results);
  exportCsv(results, "/Users/hiroyusai/src/overlay/backtests/regime-leverage-results.csv");
}

main().catch(console.error);
