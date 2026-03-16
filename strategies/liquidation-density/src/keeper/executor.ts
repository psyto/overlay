/**
 * Executor — Executes trades when liquidation cascade is imminent.
 *
 * Composed from:
 * - Drift perps: Counter-trade and liquidity provision via @overlay/shared
 * - Atomic execution: Sentinel Jito Bundle manager
 * - Pre-execution simulation: Sentinel simulation sandbox
 */

import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { PriceBucket } from "./heatmap-builder";
import { STRATEGY_CONFIG } from "../config/vault";
import { JITO_BLOCK_ENGINE_URLS } from "../config/constants";
import {
  DriftClient,
  placeDriftMarketOrder,
  placeDriftTriggerOrder,
  placeDriftLimitOrder,
  getDriftOraclePrice,
} from "@overlay/shared";

// Sentinel imports (from existing repo)
// import { BundleManager } from "@fabrknt/sentinel-core/bundle/jito";
// import { SimulationSandbox } from "@fabrknt/sentinel-core/simulation";

// SOL-PERP market index
const SOL_PERP_INDEX = 0;

// --- Types ---

export interface ExecutionPlan {
  mode: "counter_trade" | "liquidator" | "liquidity_provision";
  targetZone: PriceBucket;
  sizeUsd: number;
  direction: "short" | "long";
  takeProfitPrice: number;
  stopLossPrice: number;
  reason: string;
}

export interface ExecutionResult {
  success: boolean;
  plan: ExecutionPlan;
  txSignature?: string;
  bundleId?: string;
  pnlUsd?: number;
  error?: string;
}

// --- Plan Building ---

export function buildExecutionPlan(
  zone: PriceBucket,
  currentPrice: number
): ExecutionPlan {
  const direction: "short" | "long" =
    zone.priceMid < currentPrice ? "short" : "long";

  const sizeUsd = Math.min(
    zone.totalLiquidationUsd * 0.01,
    STRATEGY_CONFIG.counterTradeMaxSizeUsd
  );

  const tpPct = STRATEGY_CONFIG.counterTradeTakeProfitPct / 100;
  const slPct = STRATEGY_CONFIG.counterTradeStopLossPct / 100;

  const takeProfitPrice = direction === "short"
    ? currentPrice * (1 - tpPct) : currentPrice * (1 + tpPct);
  const stopLossPrice = direction === "short"
    ? currentPrice * (1 + slPct) : currentPrice * (1 - slPct);

  return {
    mode: STRATEGY_CONFIG.defaultMode as ExecutionPlan["mode"],
    targetZone: zone,
    sizeUsd,
    direction,
    takeProfitPrice,
    stopLossPrice,
    reason:
      `${zone.density} at $${zone.priceMid.toFixed(2)} ` +
      `(${zone.distanceFromCurrentPct.toFixed(1)}%, ` +
      `$${(zone.totalLiquidationUsd / 1e6).toFixed(1)}M) -> ` +
      `${direction} $${sizeUsd.toFixed(0)}`,
  };
}

// --- Execution ---

export async function executePlan(
  plan: ExecutionPlan,
  driftClient: DriftClient
): Promise<ExecutionResult> {
  console.log(`  Executing: ${plan.reason}`);

  try {
    switch (plan.mode) {
      case "counter_trade":
        return await executeCounterTrade(plan, driftClient);
      case "liquidity_provision":
        return await executeLiquidityProvision(plan, driftClient);
      case "liquidator":
        return { success: false, plan, error: "Liquidator mode requires Kamino/Marginfi wiring" };
      default:
        return { success: false, plan, error: `Unknown mode: ${plan.mode}` };
    }
  } catch (err) {
    return {
      success: false, plan,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Counter-trade: Open Drift perp position in direction of expected cascade,
 * with take-profit and stop-loss triggers.
 */
async function executeCounterTrade(
  plan: ExecutionPlan,
  driftClient: DriftClient
): Promise<ExecutionResult> {
  const oraclePrice = getDriftOraclePrice(driftClient, SOL_PERP_INDEX);
  if (oraclePrice <= 0) {
    return { success: false, plan, error: "No oracle price available" };
  }

  // 1. Place market entry order
  console.log(
    `  [counter_trade] ${plan.direction.toUpperCase()} $${plan.sizeUsd.toFixed(0)} SOL-PERP`
  );
  const entrySig = await placeDriftMarketOrder(
    driftClient, SOL_PERP_INDEX, plan.sizeUsd, plan.direction, oraclePrice
  );
  console.log(`  Entry: ${entrySig.slice(0, 12)}...`);

  // 2. Place take-profit trigger
  const tpDirection = plan.direction === "short" ? "long" : "short";
  const tpCondition = plan.direction === "short" ? "below" : "above";
  try {
    const tpSig = await placeDriftTriggerOrder(
      driftClient, SOL_PERP_INDEX, plan.sizeUsd, tpDirection as "long" | "short",
      plan.takeProfitPrice, tpCondition as "above" | "below"
    );
    console.log(`  TP @ $${plan.takeProfitPrice.toFixed(2)}: ${tpSig.slice(0, 12)}...`);
  } catch (err) {
    console.error(`  TP order failed (entry still active):`, err);
  }

  // 3. Place stop-loss trigger
  const slDirection = plan.direction === "short" ? "long" : "short";
  const slCondition = plan.direction === "short" ? "above" : "below";
  try {
    const slSig = await placeDriftTriggerOrder(
      driftClient, SOL_PERP_INDEX, plan.sizeUsd, slDirection as "long" | "short",
      plan.stopLossPrice, slCondition as "above" | "below"
    );
    console.log(`  SL @ $${plan.stopLossPrice.toFixed(2)}: ${slSig.slice(0, 12)}...`);
  } catch (err) {
    console.error(`  SL order failed (entry still active):`, err);
  }

  return {
    success: true,
    plan,
    txSignature: entrySig,
  };

  // NOTE: For Jito Bundle atomicity, wrap all three orders in a single bundle:
  // const bundleManager = new BundleManager({
  //   endpoint: connection.rpcEndpoint,
  //   jitoBlockEngineUrl: JITO_BLOCK_ENGINE_URLS[STRATEGY_CONFIG.jitoRegion],
  // });
  // const bundle = { transactions: [entryTx, tpTx, slTx], tip: STRATEGY_CONFIG.jitoTipLamports };
  // const result = await bundleManager.sendBundle(bundle);
  // await bundleManager.confirmBundle(result.bundleId);
}

/**
 * Liquidity provision: Place Drift limit buy orders at cascade levels.
 * Buy the forced selling at a discount, with maker rebates.
 */
async function executeLiquidityProvision(
  plan: ExecutionPlan,
  driftClient: DriftClient
): Promise<ExecutionResult> {
  // Place limit order at 1% below the cascade zone (buy the dip)
  const limitPrice = plan.direction === "long"
    ? plan.targetZone.priceMid * 1.01  // Buy above zone for short squeeze
    : plan.targetZone.priceMid * 0.99; // Buy below zone for liquidation cascade

  console.log(
    `  [liquidity] Limit ${plan.direction.toUpperCase()} $${plan.sizeUsd.toFixed(0)} @ $${limitPrice.toFixed(2)}`
  );

  const sig = await placeDriftLimitOrder(
    driftClient, SOL_PERP_INDEX, plan.sizeUsd,
    plan.direction === "short" ? "long" : "long", // Always buying into cascade
    limitPrice
  );
  console.log(`  Limit order: ${sig.slice(0, 12)}...`);

  return {
    success: true,
    plan,
    txSignature: sig,
  };
}

// --- Utilities ---

export function formatPlan(plan: ExecutionPlan): string {
  return (
    `${plan.mode} ${plan.direction.toUpperCase()} $${plan.sizeUsd.toFixed(0)} | ` +
    `Zone: $${plan.targetZone.priceMid.toFixed(2)} [${plan.targetZone.density}] | ` +
    `TP: $${plan.takeProfitPrice.toFixed(2)} SL: $${plan.stopLossPrice.toFixed(2)}`
  );
}
