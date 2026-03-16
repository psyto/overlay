/**
 * Regime-Adaptive Leverage — Main Keeper Loop
 *
 * Composed from:
 * - Signal detection: Yogi's drift-signal-detector (4D anomaly pattern)
 * - Regime engine: Yogi's regime-engine (vol × severity → action matrix)
 * - Vol estimation: Kuma's leverage-controller (Parkinson estimator)
 * - Health monitoring: Kuma's health-monitor (drawdown + health ratio)
 * - Pre-extreme wind-down: Arashi's early deleverage at 65% vol
 * - Loop management: Kamino-specific leverage loop
 * - Drift hedge: Optional SOL short for delta-neutral mode
 */

import { STRATEGY_CONFIG } from "../config/vault";
import {
  detectSignals,
  formatSignalState,
  SignalState,
  SIGNAL_NONE,
  SIGNAL_CRITICAL,
} from "./signal-detector";
import {
  fetchReferenceVol,
  classifyVolRegime,
  VolState,
} from "./vol-estimator";
import {
  computeLeverageRegime,
  shouldTriggerEmergencyRebalance,
  formatRegime,
  LeverageRegime,
} from "./regime-engine";
import {
  computeTargetLoopState,
  formatLoopState,
  calculateEffectiveApy,
  leverageToLtv,
  LoopState,
} from "./loop-manager";
import {
  computeHealthState,
  formatHealthState,
  resetPeakEquity,
} from "./health-monitor";
import {
  loadKeypair,
  getConnection,
  initDriftClient,
  getDriftOraclePrice,
  placeDriftMarketOrder,
  closeAllDriftPositions,
  getDriftPositionsSummary,
  sleep,
  DriftClient,
} from "@overlay/shared";
import { KaminoClient, createKaminoClient } from "@overlay/kamino-client";
import BN from "bn.js";

// --- Global State ---
let kamino: KaminoClient;
let driftClient: DriftClient;
let currentVol: VolState | undefined;
let currentSignals: SignalState = {
  severity: SIGNAL_NONE,
  events: [],
  timestamp: Date.now(),
};
let currentRegime: LeverageRegime | undefined;
let currentLoop: LoopState | null = null;
let ownerAddress: string;

// SOL-PERP market index on Drift
const SOL_PERP_INDEX = 0;

// --- Kamino Position Sync ---

async function syncLoopState(): Promise<void> {
  const position = await kamino.getPosition(ownerAddress);

  if (!position || position.totalDepositedUsd === 0) {
    currentLoop = null;
    return;
  }

  const jitosolDeposit = position.reserves.find(
    (r) => r.symbol === "JitoSOL" || r.mint.startsWith("J1toso")
  );
  const solBorrow = position.reserves.find(
    (r) => r.symbol === "SOL" || r.mint.startsWith("So111")
  );

  const depositedJitoSol = jitosolDeposit?.depositedAmount ?? 0;
  const borrowedSol = solBorrow?.borrowedAmount ?? 0;

  const netValue = position.totalDepositedUsd - position.totalBorrowedUsd;
  const effectiveLeverage =
    netValue > 0 ? position.totalDepositedUsd / netValue : 1.0;

  currentLoop = {
    depositedJitoSol,
    borrowedSol,
    currentLtv: position.currentLtv,
    effectiveLeverage,
    loopDepth: Math.max(1, Math.round(Math.log(effectiveLeverage) / Math.log(1.25))),
    estimatedApy: calculateEffectiveApy(effectiveLeverage),
    healthStatus:
      position.currentLtv >= STRATEGY_CONFIG.criticalLtvPct
        ? "critical"
        : position.currentLtv >= STRATEGY_CONFIG.emergencyDeleverageLtvPct
        ? "warning"
        : "healthy",
  };
}

// --- Drift Hedge Management ---

async function syncDriftHedge(): Promise<void> {
  if (!STRATEGY_CONFIG.enableDriftHedge || !currentLoop) return;

  const solPrice = getDriftOraclePrice(driftClient, SOL_PERP_INDEX);
  if (solPrice <= 0) return;

  // Target hedge: short SOL equal to our JitoSOL exposure
  const exposureSol = currentLoop.depositedJitoSol;
  const exposureUsd = exposureSol * solPrice;

  // Check current Drift positions
  const positions = getDriftPositionsSummary(driftClient);
  const solPosition = positions.find((p) => p.marketIndex === SOL_PERP_INDEX);
  const currentHedgeUsd = solPosition
    ? (solPosition.direction === "short" ? solPosition.sizeBase * solPrice : -solPosition.sizeBase * solPrice)
    : 0;

  const targetHedgeUsd = -exposureUsd; // Negative = short
  const diffUsd = targetHedgeUsd - currentHedgeUsd;
  const diffPct = exposureUsd > 0 ? Math.abs(diffUsd / exposureUsd) * 100 : 0;

  if (diffPct < STRATEGY_CONFIG.hedgeRebalanceThresholdPct) return;

  console.log(
    `  Drift hedge: current=$${currentHedgeUsd.toFixed(0)} target=$${targetHedgeUsd.toFixed(0)} diff=${diffPct.toFixed(1)}%`
  );

  try {
    if (diffUsd < 0) {
      // Need more short
      const sig = await placeDriftMarketOrder(
        driftClient, SOL_PERP_INDEX, Math.abs(diffUsd), "short", solPrice
      );
      console.log(`  Hedge short opened: ${sig}`);
    } else {
      // Need less short (reduce)
      const sig = await placeDriftMarketOrder(
        driftClient, SOL_PERP_INDEX, Math.abs(diffUsd), "long", solPrice
      );
      console.log(`  Hedge reduced: ${sig}`);
    }
  } catch (err) {
    console.error("  Hedge adjustment failed:", err);
  }
}

// --- Core Loop Functions ---

async function updateVol(): Promise<void> {
  try {
    currentVol = await fetchReferenceVol();
    console.log(
      `Vol: ${currentVol.volPct.toFixed(1)}% annualized (${currentVol.regime} regime)`
    );
  } catch (err) {
    console.error("Failed to update vol:", err);
  }
}

async function runSignalDetection(): Promise<boolean> {
  console.log("\n--- Signal Detection ---");
  try {
    currentSignals = await detectSignals(STRATEGY_CONFIG.monitoredMarkets);
    console.log(formatSignalState(currentSignals));

    const volRegime = currentVol ? currentVol.regime : classifyVolRegime(3000);
    const previousRegime = currentRegime;
    currentRegime = computeLeverageRegime(
      volRegime, currentSignals.severity, currentVol?.volBps ?? 3000
    );
    console.log(`Regime: ${formatRegime(currentRegime)}`);

    if (shouldTriggerEmergencyRebalance(previousRegime, currentRegime)) {
      console.log(
        `REGIME SHIFT: Emergency — ` +
        `${previousRegime?.targetLoopLeverage.toFixed(1) ?? "?"}x -> ${currentRegime.targetLoopLeverage.toFixed(1)}x`
      );
      return true;
    }
    return false;
  } catch (err) {
    console.error("Signal detection error:", err);
    return false;
  }
}

async function runEmergencyChecks(): Promise<boolean> {
  await syncLoopState();

  const solPrice = getDriftOraclePrice(driftClient, SOL_PERP_INDEX);
  const equityUsd = currentLoop
    ? currentLoop.depositedJitoSol * (solPrice || 150)
    : 0;

  const health = computeHealthState(currentLoop, equityUsd);

  if (health.action !== "none") {
    console.log(formatHealthState(health));

    if (health.action === "close_all") {
      console.log("EMERGENCY: Full unwind");
      if (currentLoop && currentLoop.borrowedSol > 0) {
        try {
          const repay = new BN(Math.floor(currentLoop.borrowedSol * 1e9));
          const withdraw = new BN(Math.floor(currentLoop.depositedJitoSol * 1e9));
          await kamino.executeDeleverageStep(repay, withdraw);
          console.log("  Kamino unwind complete");
        } catch (err) {
          console.error("  Kamino unwind failed:", err);
        }
      }
      // Close Drift hedge too
      if (STRATEGY_CONFIG.enableDriftHedge) {
        try {
          const sigs = await closeAllDriftPositions(driftClient);
          console.log(`  Drift hedge closed: ${sigs.length} positions`);
        } catch (err) {
          console.error("  Drift hedge close failed:", err);
        }
      }
      currentLoop = null;
      return true;
    }

    if (health.action === "reduce") {
      console.log("WARNING: Deleveraging");
      if (currentLoop && currentLoop.borrowedSol > 0) {
        try {
          const repay = new BN(Math.floor(currentLoop.borrowedSol * 0.5 * 1e9));
          const withdraw = new BN(Math.floor(currentLoop.depositedJitoSol * 0.3 * 1e9));
          await kamino.executeDeleverageStep(repay, withdraw);
          console.log("  Partial deleverage complete");
        } catch (err) {
          console.error("  Partial deleverage failed:", err);
        }
      }
    }
  }

  // Signal-driven emergency
  if (currentSignals.severity >= SIGNAL_CRITICAL && currentLoop) {
    console.log("SIGNAL CRITICAL: Emergency deleverage to 1.5x");
    if (currentLoop.effectiveLeverage > 1.5 && currentLoop.borrowedSol > 0) {
      const targetBorrow = currentLoop.depositedJitoSol * 0.33;
      const excess = currentLoop.borrowedSol - targetBorrow;
      if (excess > 0) {
        try {
          await kamino.repaySol(new BN(Math.floor(excess * 1e9)));
          console.log(`  Emergency repay: ${excess.toFixed(4)} SOL`);
        } catch (err) {
          console.error("  Emergency repay failed:", err);
        }
      }
    }
  }

  return false;
}

async function runRebalance(): Promise<void> {
  console.log("\n--- Rebalance Cycle ---");
  await syncLoopState();

  const targetLeverage = currentRegime?.targetLoopLeverage ?? 1.0;
  const target = computeTargetLoopState(currentLoop, targetLeverage, 0);
  console.log(`Target: ${target.reason}`);

  // Show rates
  const solRates = await kamino.getRates("SOL");
  const jitoRates = await kamino.getRates("JitoSOL");
  if (solRates) {
    console.log(
      `  Rates: SOL borrow ${(solRates.borrowApy * 100).toFixed(2)}% | ` +
      `JitoSOL supply ${((jitoRates?.supplyApy ?? 0) * 100).toFixed(2)}%`
    );
  }

  switch (target.action) {
    case "increase": {
      console.log(
        `  -> Increasing to ${target.targetLeverage.toFixed(1)}x ` +
        `(LTV ${target.targetLtv.toFixed(1)}%, ~${target.estimatedApy.toFixed(1)}% APY)`
      );
      const currentLev = currentLoop?.effectiveLeverage ?? 1.0;
      const currentDeposit = currentLoop?.depositedJitoSol ?? 0;
      if (currentDeposit <= 0) {
        console.log("  No initial deposit — deposit JitoSOL manually first");
        break;
      }
      const borrowFraction = Math.min(
        STRATEGY_CONFIG.targetLtvPct / 100,
        leverageToLtv(target.targetLeverage) / 100
      );
      const additional = currentDeposit * (target.targetLeverage / currentLev - 1);
      if (additional > 0.001) {
        try {
          const { borrowedAmount } = await kamino.executeLoopStep(
            new BN(Math.floor(additional * 1e9)), borrowFraction
          );
          console.log(
            `  Loop step: deposited ${additional.toFixed(4)} JitoSOL, ` +
            `borrowed ${(borrowedAmount.toNumber() / 1e9).toFixed(4)} SOL`
          );
        } catch (err) {
          console.error("  Loop step failed:", err);
        }
      }
      break;
    }

    case "decrease": {
      console.log(
        `  -> Decreasing to ${target.targetLeverage.toFixed(1)}x`
      );
      if (currentLoop && currentLoop.borrowedSol > 0) {
        const targetBorrowRatio = 1 - 1 / target.targetLeverage;
        const targetBorrow = currentLoop.depositedJitoSol * targetBorrowRatio;
        const excess = currentLoop.borrowedSol - targetBorrow;
        if (excess > 0.001) {
          try {
            await kamino.executeDeleverageStep(
              new BN(Math.floor(excess * 1e9)),
              new BN(Math.floor(excess * 0.9 * 1e9))
            );
            console.log(`  Deleveraged: repaid ${excess.toFixed(4)} SOL`);
          } catch (err) {
            console.error("  Deleverage failed:", err);
          }
        }
      }
      break;
    }

    case "unwind": {
      console.log("  -> Full unwind to 1x");
      if (currentLoop && currentLoop.borrowedSol > 0) {
        try {
          await kamino.executeDeleverageStep(
            new BN(Math.floor(currentLoop.borrowedSol * 1e9)),
            new BN(Math.floor(currentLoop.depositedJitoSol * 0.95 * 1e9))
          );
          console.log("  Full unwind complete");
        } catch (err) {
          console.error("  Full unwind failed:", err);
        }
      }
      if (STRATEGY_CONFIG.enableDriftHedge) {
        try {
          await closeAllDriftPositions(driftClient);
        } catch (err) {
          console.error("  Drift close failed:", err);
        }
      }
      currentLoop = null;
      break;
    }

    case "hold":
      console.log(`  -> Hold at ${target.targetLeverage.toFixed(1)}x`);
      break;
  }

  // Sync Drift hedge after Kamino rebalance
  if (STRATEGY_CONFIG.enableDriftHedge) {
    await syncDriftHedge();
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Regime-Adaptive Leverage Keeper ===\n");

  const connection = getConnection();
  const keypair = loadKeypair("MANAGER_KEYPAIR_PATH");
  ownerAddress = keypair.publicKey.toBase58();

  console.log(`RPC: ${process.env.RPC_URL ?? "default"}`);
  console.log(`Manager: ${ownerAddress}`);
  console.log(`Drift hedge: ${STRATEGY_CONFIG.enableDriftHedge ? "enabled" : "disabled"}\n`);

  // Init Drift
  driftClient = await initDriftClient(connection, keypair);
  console.log("Drift client connected.");

  // Init Kamino (needs @solana/kit TransactionSigner)
  // For @solana/kit v2, convert keypair:
  // import { createKeyPairSignerFromBytes } from "@solana/kit";
  // const signer = await createKeyPairSignerFromBytes(keypair.secretKey);
  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const wsUrl = rpcUrl.replace("https://", "wss://");

  // Kamino uses @solana/kit signer — create from keypair bytes
  const { createKeyPairSignerFromBytes } = await import("@solana/kit");
  const kaminoSigner = await createKeyPairSignerFromBytes(keypair.secretKey);
  kamino = createKaminoClient(rpcUrl, wsUrl, kaminoSigner, "jito");
  await kamino.loadMarket();
  console.log("Kamino client connected (Jito market).\n");

  // Initialize all systems
  await updateVol();
  await runSignalDetection();
  await syncLoopState();
  if (currentLoop) console.log(formatLoopState(currentLoop));

  let lastEmergencyCheck = 0;
  let lastSignalDetection = Date.now();
  let lastVolUpdate = Date.now();
  let lastRebalance = 0;

  while (true) {
    const now = Date.now();

    if (now - lastEmergencyCheck >= STRATEGY_CONFIG.emergencyCheckIntervalMs) {
      try {
        const emergency = await runEmergencyChecks();
        if (emergency) { lastRebalance = now; }
      } catch (err) {
        console.error("Emergency check error:", err);
      }
      lastEmergencyCheck = now;
    }

    if (now - lastSignalDetection >= STRATEGY_CONFIG.signalDetectionIntervalMs) {
      const emergency = await runSignalDetection();
      if (emergency) {
        try { await runRebalance(); } catch (err) { console.error("Emergency rebalance:", err); }
        lastRebalance = now;
      }
      lastSignalDetection = now;
    }

    if (now - lastVolUpdate >= STRATEGY_CONFIG.leverageScanIntervalMs) {
      await updateVol();
      lastVolUpdate = now;
    }

    if (now - lastRebalance >= STRATEGY_CONFIG.rebalanceIntervalMs) {
      try { await runRebalance(); } catch (err) { console.error("Rebalance error:", err); }
      lastRebalance = now;
    }

    const labels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
    const loopInfo = currentLoop
      ? `${currentLoop.effectiveLeverage.toFixed(1)}x @ ${currentLoop.currentLtv.toFixed(1)}% LTV (~${currentLoop.estimatedApy.toFixed(1)}% APY)`
      : "no position";
    const hedgeInfo = STRATEGY_CONFIG.enableDriftHedge
      ? ` | Hedge: ${getDriftPositionsSummary(driftClient).length} positions`
      : "";
    console.log(
      `[${new Date().toISOString()}] ` +
      `Loop: ${loopInfo} | ` +
      `Regime: ${currentRegime?.rebalanceMode ?? "?"} (${currentRegime?.targetLoopLeverage.toFixed(1) ?? "?"}x) | ` +
      `Signal: ${labels[currentSignals.severity]} | ` +
      `Vol: ${currentVol?.volPct.toFixed(1) ?? "?"}%${hedgeInfo}`
    );

    await sleep(30_000);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
