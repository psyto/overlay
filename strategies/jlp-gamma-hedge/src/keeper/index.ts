/**
 * JLP Gamma Hedge — Main Keeper Loop
 *
 * Composed from:
 * - Hedge instrument: Sigma VolSwap (long variance = long gamma)
 * - Vol estimation: Kuma's Parkinson estimator
 * - Portfolio Greeks: Tensor pattern (delta/gamma/vega tracking)
 * - Signal detection: Yogi (4D anomaly → hedge boost)
 * - Drift perps: Delta hedging for JLP basket exposure
 * - JLP client: @overlay/jlp-client
 */

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { STRATEGY_CONFIG } from "../config/vault";
import { VOLSWAP_PROGRAM_ID, DEFAULT_RPC_URL } from "../config/constants";
import {
  detectSignals,
  formatSignalState,
  SignalState,
  SIGNAL_NONE,
  SIGNAL_CRITICAL,
} from "./signal-detector";
import {
  computeHedgeTarget,
  shouldRebalanceHedge,
  classifyVolRegime,
  VolRegime,
} from "./hedge-sizer";
import {
  computePortfolioGreeks,
  formatGreeks,
  PortfolioGreeks,
} from "./greeks-tracker";
import { JlpClient, createJlpClient, JlpPoolState } from "@overlay/jlp-client";
import {
  loadKeypair,
  getConnection,
  initDriftClient,
  getDriftOraclePrice,
  placeDriftMarketOrder,
  getDriftPositionsSummary,
  closeAllDriftPositions,
  sleep,
  DriftClient,
} from "@overlay/shared";

// Sigma SDK (from existing repo)
// import { SigmaClient, VolswapClient, OracleClient } from "@sigma-protocol/sdk";

// Market indices on Drift
const MARKET_INDICES: Record<string, number> = {
  SOL: 0,
  BTC: 1,
  ETH: 2,
};

// --- Global State ---
let jlpClient: JlpClient;
let driftClient: DriftClient;
// let volswapClient: VolswapClient;
let currentVolRegime: VolRegime = "normal";
let currentVolBps: number = 3500;
let currentSignals: SignalState = {
  severity: SIGNAL_NONE, events: [], timestamp: Date.now(),
};
let currentGreeks: PortfolioGreeks | null = null;
let jlpValueUsd: number = 0;
let volswapNotionalUsd: number = 0;
let poolState: JlpPoolState | null = null;

// --- Vol Estimation (from Kuma pattern) ---

const DRIFT_DATA_API = "https://data.api.drift.trade";

async function updateVol(): Promise<void> {
  try {
    const res = await fetch(`${DRIFT_DATA_API}/market/SOL-PERP/candles/60?limit=168`);
    if (!res.ok) return;
    const body = (await res.json()) as {
      success: boolean;
      records: Array<{ oracleHigh: number; oracleLow: number }>;
    };
    if (!body.success || !body.records || body.records.length < 10) return;

    const ln2x4 = 4 * Math.LN2;
    let sum = 0, valid = 0;
    for (const c of body.records) {
      if (c.oracleHigh <= 0 || c.oracleLow <= 0 || c.oracleHigh < c.oracleLow) continue;
      const l = Math.log(c.oracleHigh / c.oracleLow);
      sum += l * l;
      valid++;
    }
    if (valid === 0) return;
    currentVolBps = Math.round(Math.sqrt(sum / (ln2x4 * valid) * 365.25 * 24) * 10000);
    currentVolRegime = classifyVolRegime(currentVolBps);
    console.log(`Vol: ${(currentVolBps / 100).toFixed(1)}% (${currentVolRegime})`);
  } catch (err) {
    console.error("Vol update failed:", err);
  }
}

// --- JLP Sync ---

async function syncJlpPosition(): Promise<void> {
  try {
    poolState = await jlpClient.getPoolState();
    const position = await jlpClient.getPosition();
    jlpValueUsd = position?.valueUsd ?? 0;

    if (poolState) {
      console.log(
        `JLP: $${(poolState.totalValueUsd / 1e9).toFixed(2)}B AUM | ` +
        `APY: ${poolState.feeApyPct.toFixed(1)}% | ` +
        `Position: $${jlpValueUsd.toFixed(0)}`
      );
    }
  } catch (err) {
    console.error("JLP sync failed:", err);
  }
}

// --- Delta Hedging via Drift ---

async function syncDeltaHedge(): Promise<void> {
  if (jlpValueUsd <= 0) return;

  const basketWeights = poolState?.basketWeights ?? STRATEGY_CONFIG.defaultBasketWeights;

  // For each non-stable basket asset, ensure we have a short on Drift
  for (const [asset, weight] of Object.entries(basketWeights)) {
    if (asset === "USDC" || asset === "USDT") continue;
    const marketIndex = MARKET_INDICES[asset];
    if (marketIndex === undefined) continue;

    const exposureUsd = jlpValueUsd * weight;
    const oraclePrice = getDriftOraclePrice(driftClient, marketIndex);
    if (oraclePrice <= 0) continue;

    // Check current position
    const positions = getDriftPositionsSummary(driftClient);
    const pos = positions.find((p) => p.marketIndex === marketIndex);
    const currentShortUsd = pos && pos.direction === "short"
      ? pos.sizeBase * oraclePrice
      : 0;

    const targetShortUsd = exposureUsd;
    const diffPct = targetShortUsd > 0
      ? Math.abs(targetShortUsd - currentShortUsd) / targetShortUsd * 100
      : 0;

    if (diffPct < STRATEGY_CONFIG.maxPortfolioDelta * 100) continue;

    const diffUsd = targetShortUsd - currentShortUsd;
    if (Math.abs(diffUsd) < 10) continue;

    try {
      if (diffUsd > 0) {
        const sig = await placeDriftMarketOrder(
          driftClient, marketIndex, diffUsd, "short", oraclePrice
        );
        console.log(`  Delta hedge ${asset}: +$${diffUsd.toFixed(0)} short (${sig.slice(0, 8)}...)`);
      } else {
        const sig = await placeDriftMarketOrder(
          driftClient, marketIndex, Math.abs(diffUsd), "long", oraclePrice
        );
        console.log(`  Delta hedge ${asset}: -$${Math.abs(diffUsd).toFixed(0)} short reduced (${sig.slice(0, 8)}...)`);
      }
    } catch (err) {
      console.error(`  Delta hedge ${asset} failed:`, err);
    }
  }
}

// --- Gamma Hedging via Sigma VolSwap ---

async function syncGammaHedge(): Promise<void> {
  const basketWeights = poolState?.basketWeights ?? STRATEGY_CONFIG.defaultBasketWeights;

  const target = computeHedgeTarget(
    jlpValueUsd, basketWeights, currentVolRegime, currentSignals.severity
  );
  console.log(`Gamma hedge target: ${target.reason}`);

  if (!shouldRebalanceHedge(volswapNotionalUsd, target.volswapNotionalUsd)) {
    console.log("  -> Within threshold");
    return;
  }

  const diff = target.volswapNotionalUsd - volswapNotionalUsd;

  if (diff > 0) {
    console.log(`  -> Increasing VolSwap by $${diff.toFixed(0)}`);
    // Sigma VolSwap: open long variance position
    // const solMint = new PublicKey("So11111111111111111111111111111111111111112");
    // const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    // const notional = new BN(Math.floor(diff * 1e6));
    // const maxPremium = new BN(Math.floor(diff * 0.04 * 1e6)); // 4% cap
    // const sig = await volswapClient.openLong(solMint, usdcMint, userUsdcAta, notional, maxPremium);
    // console.log(`  VolSwap long opened: ${sig}`);
    volswapNotionalUsd = target.volswapNotionalUsd;
  } else {
    console.log(`  -> Decreasing VolSwap by $${Math.abs(diff).toFixed(0)}`);
    // const sig = await volswapClient.closePositionEarly(solMint, usdcMint, userUsdcAta, currentEpoch);
    // console.log(`  VolSwap reduced: ${sig}`);
    volswapNotionalUsd = target.volswapNotionalUsd;
  }
}

// --- Greeks Update ---

async function updateGreeks(): Promise<void> {
  const basketWeights = poolState?.basketWeights ?? STRATEGY_CONFIG.defaultBasketWeights;

  // Read actual Drift hedge positions
  const driftPositions = getDriftPositionsSummary(driftClient);
  const hedgePositions = driftPositions.map((p) => {
    const asset = Object.entries(MARKET_INDICES).find(([, idx]) => idx === p.marketIndex)?.[0] ?? "?";
    const oraclePrice = getDriftOraclePrice(driftClient, p.marketIndex);
    const deltaUsd = p.direction === "short"
      ? -p.sizeBase * oraclePrice
      : p.sizeBase * oraclePrice;
    return { asset, deltaUsd };
  });

  currentGreeks = computePortfolioGreeks(
    jlpValueUsd, basketWeights, hedgePositions, volswapNotionalUsd
  );
  console.log(formatGreeks(currentGreeks));
}

// --- Signal Detection ---

async function runSignalDetection(): Promise<void> {
  console.log("\n--- Signal Detection ---");
  try {
    currentSignals = await detectSignals(STRATEGY_CONFIG.monitoredMarkets);
    console.log(formatSignalState(currentSignals));
  } catch (err) {
    console.error("Signal detection error:", err);
  }
}

// --- Full Rebalance ---

async function runRebalance(): Promise<void> {
  console.log("\n--- Rebalance Cycle ---");
  await syncJlpPosition();
  await syncDeltaHedge();
  await syncGammaHedge();
  await updateGreeks();
}

// --- Emergency ---

async function runEmergencyChecks(): Promise<boolean> {
  if (currentSignals.severity >= SIGNAL_CRITICAL) {
    console.log("SIGNAL CRITICAL: Boosting hedge + tightening delta");
    await syncGammaHedge();
    await syncDeltaHedge();
    return true;
  }
  if (currentGreeks?.status === "rebalance_needed") {
    console.log("DELTA DRIFT: Emergency rebalance");
    await syncDeltaHedge();
    return true;
  }
  return false;
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== JLP Gamma Hedge Keeper ===\n");

  const connection = getConnection();
  const keypair = loadKeypair("MANAGER_KEYPAIR_PATH");
  const walletPubkey = keypair.publicKey;

  console.log(`RPC: ${process.env.RPC_URL ?? "default"}`);
  console.log(`Wallet: ${walletPubkey.toBase58()}\n`);

  // Init Drift for delta hedging
  driftClient = await initDriftClient(connection, keypair);
  console.log("Drift client connected.");

  // Init JLP client
  jlpClient = createJlpClient(connection, walletPubkey);
  console.log("JLP client ready.");

  // Init Sigma VolSwap (when deployed on mainnet)
  // const sigmaClient = SigmaClient.mainnet(connection, wallet);
  // volswapClient = sigmaClient.volswap;
  // console.log("Sigma VolSwap client connected.");

  console.log("");

  await updateVol();
  await syncJlpPosition();
  await runSignalDetection();
  await updateGreeks();

  let lastEmergency = 0;
  let lastSignal = Date.now();
  let lastGreeks = Date.now();
  let lastRebalance = 0;

  while (true) {
    const now = Date.now();

    if (now - lastEmergency >= STRATEGY_CONFIG.emergencyCheckIntervalMs) {
      try { await runEmergencyChecks(); } catch (err) { console.error("Emergency:", err); }
      lastEmergency = now;
    }

    if (now - lastSignal >= STRATEGY_CONFIG.signalDetectionIntervalMs) {
      await runSignalDetection();
      lastSignal = now;
    }

    if (now - lastGreeks >= STRATEGY_CONFIG.greeksUpdateIntervalMs) {
      await updateVol();
      await syncJlpPosition();
      await updateGreeks();
      lastGreeks = now;
    }

    if (now - lastRebalance >= STRATEGY_CONFIG.hedgeRebalanceIntervalMs) {
      try { await runRebalance(); } catch (err) { console.error("Rebalance:", err); }
      lastRebalance = now;
    }

    const labels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
    const driftPos = getDriftPositionsSummary(driftClient);
    console.log(
      `[${new Date().toISOString()}] ` +
      `JLP: $${jlpValueUsd.toFixed(0)} | ` +
      `VolSwap: $${volswapNotionalUsd.toFixed(0)} | ` +
      `Drift hedges: ${driftPos.length} | ` +
      `Delta: ${((currentGreeks?.netDelta ?? 0) * 100).toFixed(1)}% | ` +
      `Gamma: ${((currentGreeks?.gamma ?? 0) * 100).toFixed(1)}% | ` +
      `Signal: ${labels[currentSignals.severity]} | ` +
      `Vol: ${(currentVolBps / 100).toFixed(1)}% | ` +
      `APY: ${poolState?.feeApyPct.toFixed(1) ?? "?"}%`
    );

    await sleep(30_000);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
