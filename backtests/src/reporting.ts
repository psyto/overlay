/**
 * Backtest reporting — summary stats, comparison tables, CSV export.
 */

import * as fs from "fs";

export interface EquityPoint {
  timestamp: number;
  equity: number;
  label?: string;
}

export interface BacktestResult {
  name: string;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  totalTrades: number;
  durationDays: number;
  equityCurve: EquityPoint[];
  metadata: Record<string, string | number>;
}

/**
 * Compute stats from an equity curve.
 */
export function computeStats(
  name: string,
  equityCurve: EquityPoint[],
  riskFreeRate: number = 0.045 // ~4.5% T-bill
): BacktestResult {
  if (equityCurve.length < 2) {
    return {
      name, startEquity: 0, endEquity: 0, totalReturnPct: 0,
      annualizedReturnPct: 0, maxDrawdownPct: 0, sharpeRatio: 0,
      winRate: 0, totalTrades: 0, durationDays: 0, equityCurve, metadata: {},
    };
  }

  const start = equityCurve[0];
  const end = equityCurve[equityCurve.length - 1];
  const durationMs = (end.timestamp - start.timestamp) * 1000; // timestamps are in seconds
  const durationDays = durationMs / (1000 * 60 * 60 * 24);
  const durationYears = durationDays / 365.25;

  const totalReturnPct = ((end.equity - start.equity) / start.equity) * 100;
  const annualizedReturnPct = durationYears > 0
    ? (Math.pow(end.equity / start.equity, 1 / durationYears) - 1) * 100
    : totalReturnPct;

  // Max drawdown
  let peak = start.equity;
  let maxDrawdownPct = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = ((peak - pt.equity) / peak) * 100;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Daily returns for Sharpe
  const dailyReturns: number[] = [];
  const secPerDay = 24 * 60 * 60;
  let lastDayEquity = start.equity;
  let lastDayTs = start.timestamp;

  for (const pt of equityCurve) {
    if (pt.timestamp - lastDayTs >= secPerDay) {
      dailyReturns.push((pt.equity - lastDayEquity) / lastDayEquity);
      lastDayEquity = pt.equity;
      lastDayTs = pt.timestamp;
    }
  }

  const meanDailyReturn = dailyReturns.length > 0
    ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
    : 0;
  const dailyStdDev = dailyReturns.length > 1
    ? Math.sqrt(
        dailyReturns.reduce((s, r) => s + (r - meanDailyReturn) ** 2, 0) /
          (dailyReturns.length - 1)
      )
    : 0;
  const dailyRiskFree = riskFreeRate / 365.25;
  const sharpeRatio = dailyStdDev > 0
    ? ((meanDailyReturn - dailyRiskFree) / dailyStdDev) * Math.sqrt(365.25)
    : 0;

  // Win rate from daily returns
  const wins = dailyReturns.filter((r) => r > 0).length;
  const winRate = dailyReturns.length > 0 ? wins / dailyReturns.length : 0;

  return {
    name,
    startEquity: start.equity,
    endEquity: end.equity,
    totalReturnPct,
    annualizedReturnPct,
    maxDrawdownPct,
    sharpeRatio,
    winRate,
    totalTrades: dailyReturns.length,
    durationDays,
    equityCurve,
    metadata: {},
  };
}

/**
 * Print a comparison table of multiple backtest results.
 */
export function printComparison(results: BacktestResult[]): void {
  console.log("\n" + "=".repeat(90));
  console.log("BACKTEST COMPARISON");
  console.log("=".repeat(90));

  const header = [
    "Strategy".padEnd(30),
    "Return".padStart(9),
    "Ann.Ret".padStart(9),
    "MaxDD".padStart(8),
    "Sharpe".padStart(8),
    "WinRate".padStart(8),
    "Days".padStart(6),
  ].join(" | ");

  console.log(header);
  console.log("-".repeat(90));

  for (const r of results) {
    const row = [
      r.name.padEnd(30),
      `${r.totalReturnPct.toFixed(1)}%`.padStart(9),
      `${r.annualizedReturnPct.toFixed(1)}%`.padStart(9),
      `${r.maxDrawdownPct.toFixed(1)}%`.padStart(8),
      r.sharpeRatio.toFixed(2).padStart(8),
      `${(r.winRate * 100).toFixed(0)}%`.padStart(8),
      r.durationDays.toFixed(0).padStart(6),
    ].join(" | ");
    console.log(row);
  }

  console.log("=".repeat(90));

  // Print metadata
  for (const r of results) {
    if (Object.keys(r.metadata).length > 0) {
      console.log(`\n${r.name}:`);
      for (const [k, v] of Object.entries(r.metadata)) {
        console.log(`  ${k}: ${v}`);
      }
    }
  }
}

/**
 * Export equity curves to CSV.
 */
export function exportCsv(
  results: BacktestResult[],
  filePath: string
): void {
  const allTimestamps = new Set<number>();
  for (const r of results) {
    for (const pt of r.equityCurve) {
      allTimestamps.add(pt.timestamp);
    }
  }

  const sorted = Array.from(allTimestamps).sort((a, b) => a - b);
  const headers = ["timestamp", "date", ...results.map((r) => r.name)];
  const rows: string[] = [headers.join(",")];

  for (const ts of sorted) {
    const date = new Date(ts * 1000).toISOString().split("T")[0];
    const values = results.map((r) => {
      const pt = r.equityCurve.find((p) => p.timestamp === ts);
      return pt ? pt.equity.toFixed(2) : "";
    });
    rows.push([ts, date, ...values].join(","));
  }

  fs.writeFileSync(filePath, rows.join("\n"));
  console.log(`\nCSV exported: ${filePath}`);
}
