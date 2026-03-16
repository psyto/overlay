/**
 * Liquidation Density — Main Keeper Loop
 *
 * Composed from:
 * - Position scanning: Tensor margin math pattern via Kamino + Marginfi clients
 * - Heatmap: Kalshify severity-based density classification
 * - Execution: Drift perps (counter-trade, liquidity provision)
 * - Atomic execution: Sentinel Jito Bundles
 * - Price oracle: Drift on-chain oracle
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { STRATEGY_CONFIG } from "../config/vault";
import { scanAllPositions } from "./position-scanner";
import {
  buildHeatmap,
  getActionableZones,
  getWarningZones,
  formatHeatmap,
  LiquidationHeatmap,
  LeveragedPosition,
} from "./heatmap-builder";
import {
  buildExecutionPlan,
  executePlan,
  formatPlan,
  ExecutionResult,
} from "./executor";
import { KaminoClient, createKaminoClient } from "@overlay/kamino-client";
import { MarginfiClientWrapper, createMarginfiClient } from "@overlay/marginfi-client";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import {
  loadKeypair,
  getConnection,
  initDriftClient,
  getDriftOraclePrice,
  getDriftPositionsSummary,
  closeAllDriftPositions,
  sleep,
  DriftClient,
} from "@overlay/shared";

const SOL_PERP_INDEX = 0;

// --- Global State ---
let driftClient: DriftClient;
let kaminoClient: KaminoClient | null = null;
let marginfiClient: MarginfiClientWrapper | null = null;
let connection: Connection;
let positions: LeveragedPosition[] = [];
let heatmaps: Map<string, LiquidationHeatmap> = new Map();
let activeTrades: ExecutionResult[] = [];
let currentSolPrice = 0;

// --- Core Functions ---

async function updateSolPrice(): Promise<void> {
  const price = getDriftOraclePrice(driftClient, SOL_PERP_INDEX);
  if (price > 0) currentSolPrice = price;
}

async function runPositionScan(): Promise<void> {
  console.log("\n--- Position Scan ---");
  await updateSolPrice();
  console.log(`  SOL: $${currentSolPrice.toFixed(2)}`);

  positions = await scanAllPositions(
    kaminoClient, marginfiClient, "SOL", currentSolPrice
  );

  const total = positions.reduce((s, p) => s + p.positionSizeUsd, 0);
  const kamino = positions.filter((p) => p.protocol === "kamino").length;
  const marginfi = positions.filter((p) => p.protocol === "marginfi").length;
  console.log(
    `  Total: ${positions.length} positions ($${(total / 1e6).toFixed(1)}M) | ` +
    `K:${kamino} M:${marginfi}`
  );
}

async function runHeatmapUpdate(): Promise<void> {
  if (positions.length === 0 || currentSolPrice <= 0) return;
  const heatmap = buildHeatmap("SOL", currentSolPrice, positions);
  heatmaps.set("SOL", heatmap);
  console.log(formatHeatmap(heatmap));
}

async function runTriggerCheck(): Promise<void> {
  for (const [, heatmap] of heatmaps) {
    const actionable = getActionableZones(heatmap);
    if (actionable.length === 0) continue;

    const activeCount = activeTrades.filter((t) => t.success).length;
    if (activeCount >= STRATEGY_CONFIG.maxConcurrentTrades) {
      console.log(`  Max trades (${STRATEGY_CONFIG.maxConcurrentTrades}) reached`);
      continue;
    }

    const sorted = actionable.sort((a, b) => b.totalLiquidationUsd - a.totalLiquidationUsd);

    for (const zone of sorted) {
      if (activeCount + activeTrades.length >= STRATEGY_CONFIG.maxConcurrentTrades) break;

      const plan = buildExecutionPlan(zone, heatmap.currentPrice);
      console.log(`  ${formatPlan(plan)}`);

      const result = await executePlan(plan, driftClient);
      activeTrades.push(result);

      if (result.success) {
        console.log(`  EXECUTED: ${result.txSignature?.slice(0, 12) ?? result.bundleId}...`);
      } else {
        console.log(`  SKIPPED: ${result.error}`);
      }
    }
  }
}

async function runEmergencyChecks(): Promise<boolean> {
  await updateSolPrice();

  // Check for rapid price movement toward dense zones
  for (const [, heatmap] of heatmaps) {
    // Recalculate proximity with fresh price
    const freshHeatmap = buildHeatmap("SOL", currentSolPrice, positions);
    heatmaps.set("SOL", freshHeatmap);

    const critical = getActionableZones(freshHeatmap).filter((z) => z.density === "critical");
    if (critical.length > 0) {
      console.log(`CRITICAL: ${critical.length} critical zones in range`);
      await runTriggerCheck();
      return true;
    }
  }

  // Check active trade P&L
  const driftPositions = getDriftPositionsSummary(driftClient);
  let totalPnl = 0;
  for (const pos of driftPositions) {
    totalPnl += pos.unrealizedPnl;
  }

  if (totalPnl < -(STRATEGY_CONFIG.maxDrawdownPct / 100) * STRATEGY_CONFIG.counterTradeMaxSizeUsd * STRATEGY_CONFIG.maxConcurrentTrades) {
    console.log(`DRAWDOWN: Total PnL $${totalPnl.toFixed(2)} — closing all`);
    try {
      const sigs = await closeAllDriftPositions(driftClient);
      console.log(`  Closed ${sigs.length} positions`);
      activeTrades = [];
    } catch (err) {
      console.error("  Close all failed:", err);
    }
    return true;
  }

  return false;
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Liquidation Density Keeper ===\n");

  connection = getConnection();
  const keypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`RPC: ${process.env.RPC_URL ?? "default"}`);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Region: ${STRATEGY_CONFIG.jitoRegion}\n`);

  // Init Drift for price oracle + trade execution
  driftClient = await initDriftClient(connection, keypair);
  console.log("Drift client connected.");

  // Init Kamino (read-only scanning)
  try {
    const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const wsUrl = rpcUrl.replace("https://", "wss://");
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const kaminoSigner = await createKeyPairSignerFromBytes(keypair.secretKey);
    kaminoClient = createKaminoClient(rpcUrl, wsUrl, kaminoSigner, "jito");
    await kaminoClient.loadMarket();
    console.log("Kamino client connected.");
  } catch (err) {
    console.warn("Kamino init failed (will use REST API):", err);
  }

  // Init Marginfi
  try {
    const wallet = new NodeWallet(keypair);
    marginfiClient = createMarginfiClient(connection, wallet);
    await marginfiClient.init();
    console.log("Marginfi client connected.");
  } catch (err) {
    console.warn("Marginfi init failed:", err);
  }

  console.log("");

  // Initialize
  await updateSolPrice();
  console.log(`SOL: $${currentSolPrice.toFixed(2)}`);
  await runPositionScan();
  await runHeatmapUpdate();

  let lastEmergency = 0;
  let lastPositionScan = Date.now();
  let lastHeatmapUpdate = Date.now();

  while (true) {
    const now = Date.now();

    // Emergency (every 15s)
    if (now - lastEmergency >= STRATEGY_CONFIG.emergencyCheckIntervalMs) {
      try { await runEmergencyChecks(); }
      catch (err) { console.error("Emergency:", err); }
      lastEmergency = now;
    }

    // Heatmap + trigger (every 1 min)
    if (now - lastHeatmapUpdate >= STRATEGY_CONFIG.heatmapUpdateIntervalMs) {
      try {
        await updateSolPrice();
        await runHeatmapUpdate();
        await runTriggerCheck();
      } catch (err) { console.error("Heatmap:", err); }
      lastHeatmapUpdate = now;
    }

    // Position scan (every 2 min)
    if (now - lastPositionScan >= STRATEGY_CONFIG.positionScanIntervalMs) {
      try { await runPositionScan(); }
      catch (err) { console.error("Scan:", err); }
      lastPositionScan = now;
    }

    // Heartbeat
    const solHeatmap = heatmaps.get("SOL");
    const nearest = solHeatmap?.nearestDenseBucketPct;
    const dense = solHeatmap?.buckets.filter((b) => b.density !== "low").length ?? 0;
    const driftPos = getDriftPositionsSummary(driftClient);
    const totalPnl = driftPos.reduce((s, p) => s + p.unrealizedPnl, 0);
    console.log(
      `[${new Date().toISOString()}] ` +
      `SOL: $${currentSolPrice.toFixed(2)} | ` +
      `Pos: ${positions.length} (K:${positions.filter((p) => p.protocol === "kamino").length} M:${positions.filter((p) => p.protocol === "marginfi").length}) | ` +
      `Dense: ${dense} | Nearest: ${nearest?.toFixed(1) ?? "-"}% | ` +
      `Trades: ${driftPos.length}/${STRATEGY_CONFIG.maxConcurrentTrades} ($${totalPnl.toFixed(0)} PnL)`
    );

    await sleep(15_000);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
