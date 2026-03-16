/**
 * Execution Cost Model — realistic friction for all strategies.
 *
 * Models:
 * - Drift trading fees (maker/taker)
 * - Slippage based on trade size and market depth
 * - Jito Bundle tips
 * - Kamino borrow rate fluctuation (correlated with vol)
 * - Priority fees on Solana
 * - Funding rate drag on open Drift positions
 */

// --- Drift Fees ---
export const DRIFT_TAKER_FEE_BPS = 3.5;   // 0.035%
export const DRIFT_MAKER_FEE_BPS = -0.2;  // -0.002% rebate
export const DRIFT_LIMIT_ORDER_FILL_RATE = 0.7; // 70% of limit orders fill

// --- Slippage Model ---
// Slippage: sqrt model (realistic for deep books like Drift SOL-PERP)
// Base: ~0.01% for $10K, scales as sqrt(size/$10K) × base
// $10K = 0.01%, $100K = 0.032%, $1M = 0.1%
export function estimateSlippage(tradeSizeUsd: number, market: string = "SOL"): number {
  const baseBps: Record<string, number> = {
    SOL: 1.0,   // 0.01% base
    BTC: 0.8,   // 0.008% base (deeper)
    ETH: 1.2,   // 0.012% base
  };
  const base = (baseBps[market] ?? 1.0) / 10000;
  return base * Math.sqrt(tradeSizeUsd / 10_000);
}

// --- Jito Tips ---
export const JITO_TIP_SOL = 0.0001;       // ~0.0001 SOL per bundle
export const JITO_TIP_USD_AT_100 = 0.01;  // ~$0.01 at SOL=$100

export function jitoTipUsd(solPrice: number): number {
  return JITO_TIP_SOL * solPrice;
}

// --- Solana Priority Fees ---
export const PRIORITY_FEE_SOL = 0.00005;  // ~50K microlamports
export function priorityFeeUsd(solPrice: number): number {
  return PRIORITY_FEE_SOL * solPrice;
}

// --- Kamino Borrow Rate Model ---
// Borrow rate spikes with utilization, which correlates with vol
export function kaminoBorrowRate(volRegime: string): number {
  const rates: Record<string, number> = {
    veryLow: 0.015,  // 1.5%
    low: 0.025,      // 2.5%
    normal: 0.04,    // 4%
    high: 0.07,      // 7%
    extreme: 0.12,   // 12%
  };
  return rates[volRegime] ?? 0.04;
}

// --- Funding Rate Drag ---
// Holding a Drift short position costs funding when funding is negative (shorts pay)
// Average SOL-PERP funding: varies, but shorts often pay in bull markets
export function fundingRateDrag(
  positionSizeUsd: number,
  dailyFundingRate: number, // As decimal, e.g., -0.001
  isShort: boolean
): number {
  // Short pays when funding is negative, receives when positive
  // Long pays when funding is positive, receives when negative
  if (isShort) {
    return positionSizeUsd * dailyFundingRate; // Negative funding = shorts pay (drag)
  }
  return -positionSizeUsd * dailyFundingRate; // Positive funding = longs pay
}

// --- Combined Trade Cost ---
export interface TradeCost {
  feeUsd: number;
  slippageUsd: number;
  tipUsd: number;
  priorityFeeUsd: number;
  totalUsd: number;
  totalPct: number;
}

export function calculateTradeCost(
  tradeSizeUsd: number,
  solPrice: number,
  market: string = "SOL",
  useMakerOrder: boolean = false
): TradeCost {
  const feeBps = useMakerOrder ? DRIFT_MAKER_FEE_BPS : DRIFT_TAKER_FEE_BPS;
  const feeUsd = tradeSizeUsd * (feeBps / 10000);
  const slippagePct = estimateSlippage(tradeSizeUsd, market);
  const slippageUsd = tradeSizeUsd * slippagePct;
  const tipUsd = jitoTipUsd(solPrice);
  const pfUsd = priorityFeeUsd(solPrice);

  const totalUsd = feeUsd + slippageUsd + tipUsd + pfUsd;
  const totalPct = tradeSizeUsd > 0 ? (totalUsd / tradeSizeUsd) * 100 : 0;

  return { feeUsd, slippageUsd, tipUsd, priorityFeeUsd: pfUsd, totalUsd, totalPct };
}

// --- Rebalance Cost (round-trip) ---
export function rebalanceCost(
  adjustmentSizeUsd: number,
  solPrice: number,
  market: string = "SOL"
): number {
  // Entry + exit = 2 trades
  const entry = calculateTradeCost(adjustmentSizeUsd, solPrice, market);
  const exit = calculateTradeCost(adjustmentSizeUsd, solPrice, market);
  return entry.totalUsd + exit.totalUsd;
}
