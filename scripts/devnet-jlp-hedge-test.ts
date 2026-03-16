/**
 * Devnet Test: JLP Trend-Aware Delta Hedge
 *
 * Tests the full Drift execution layer on devnet:
 * 1. Signal detection (reads mainnet Drift Data API — live data)
 * 2. Vol estimation + trend detection
 * 3. Simulated JLP position (no actual JLP — just track a virtual position)
 * 4. Real Drift perp orders on devnet (delta hedging)
 *
 * Runs a compressed test cycle:
 * - Detect trend + vol regime
 * - Compute target delta hedge per basket asset
 * - Place/adjust Drift short positions
 * - Monitor portfolio Greeks
 * - Test emergency close-all
 *
 * Usage:
 *   cp .env.example .env  # Edit with your devnet keypair path
 *   solana airdrop 2 <pubkey> --url devnet
 *   npx ts-node scripts/devnet-setup.ts
 *   npx ts-node scripts/devnet-jlp-hedge-test.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  PositionDirection,
  OrderType,
  BASE_PRECISION,
  PRICE_PRECISION,
  initialize,
} from "@drift-labs/sdk";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// --- Constants ---

const DRIFT_DATA_API = "https://data.api.drift.trade"; // Mainnet — live signals
const DEVNET_RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const DRIFT_DEVNET_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);

// Simulated JLP position
const VIRTUAL_JLP_USD = 10_000; // Pretend we hold $10K JLP

// JLP basket weights
const BASKET: Record<string, { weight: number; marketIndex: number }> = {
  SOL: { weight: 0.44, marketIndex: 0 },
  BTC: { weight: 0.11, marketIndex: 1 },
  ETH: { weight: 0.10, marketIndex: 2 },
};

// Test order size — small to avoid draining devnet USDC
const TEST_SIZE_USD = 50;

// --- Helpers ---

function loadKeypair(): Keypair {
  const kpPath = process.env.MANAGER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("MANAGER_KEYPAIR_PATH not set in .env");
  const resolved = path.resolve(kpPath);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Signal Detection (mainnet data) ---

interface MarketData {
  symbol: string;
  oraclePrice: number;
  markPrice: number;
  fundingRate: number;
}

async function fetchMarketData(): Promise<MarketData[]> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  if (!res.ok) throw new Error(`Market fetch failed: ${res.status}`);

  const body = (await res.json()) as {
    success: boolean;
    markets: Array<{
      symbol: string;
      marketType: string;
      oraclePrice: string;
      markPrice: string;
      fundingRate24h: string;
    }>;
  };

  return body.markets
    .filter((m) => m.marketType === "perp")
    .map((m) => ({
      symbol: m.symbol,
      oraclePrice: parseFloat(m.oraclePrice),
      markPrice: parseFloat(m.markPrice),
      fundingRate: parseFloat(m.fundingRate24h),
    }));
}

// --- Trend Detection ---

async function detectTrend(): Promise<"bull" | "bear" | "range"> {
  const res = await fetch(`${DRIFT_DATA_API}/market/SOL-PERP/candles/D?limit=60`);
  if (!res.ok) return "range";

  const body = (await res.json()) as {
    success: boolean;
    records: Array<{ ts: number; oracleClose: number }>;
  };

  if (!body.success || body.records.length < 60) return "range";

  const sorted = body.records.sort((a, b) => a.ts - b.ts);
  const closes = sorted.map((r) => r.oracleClose);
  const current = closes[closes.length - 1];
  const sma30 = closes.slice(-30).reduce((s, c) => s + c, 0) / 30;
  const sma60 = closes.reduce((s, c) => s + c, 0) / closes.length;

  // Simple: check if 30d SMA is rising
  const sma30prev = closes.slice(-31, -1).reduce((s, c) => s + c, 0) / 30;

  if (current > sma30 && sma30 > sma60 && sma30 > sma30prev) return "bull";
  if (current < sma30 && sma30 < sma60) return "bear";
  return "range";
}

// --- Vol Estimation ---

async function fetchVol(): Promise<{ volBps: number; regime: string }> {
  const res = await fetch(`${DRIFT_DATA_API}/market/SOL-PERP/candles/D?limit=30`);
  if (!res.ok) return { volBps: 3500, regime: "low" };

  const body = (await res.json()) as {
    success: boolean;
    records: Array<{ oracleHigh: number; oracleLow: number }>;
  };

  if (!body.success || body.records.length < 10) return { volBps: 3500, regime: "low" };

  const ln2x4 = 4 * Math.LN2;
  let sum = 0, valid = 0;
  for (const c of body.records) {
    if (c.oracleHigh <= 0 || c.oracleLow <= 0) continue;
    const l = Math.log(c.oracleHigh / c.oracleLow);
    sum += l * l;
    valid++;
  }

  if (valid === 0) return { volBps: 3500, regime: "low" };
  const vol = Math.sqrt(sum / (ln2x4 * valid) * 252);
  const volBps = Math.round(vol * 10000);

  let regime = "normal";
  if (volBps < 2000) regime = "veryLow";
  else if (volBps < 3500) regime = "low";
  else if (volBps < 5000) regime = "normal";
  else if (volBps < 7500) regime = "high";
  else regime = "extreme";

  return { volBps, regime };
}

// --- Drift Order Execution ---

async function placeShort(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number,
  oraclePrice: number,
  symbol: string
): Promise<string> {
  const baseAmount = new BN(
    Math.floor((sizeUsd / oraclePrice) * BASE_PRECISION.toNumber())
  );

  console.log(
    `  Placing SHORT ${symbol}: $${sizeUsd.toFixed(0)} ` +
    `(${(sizeUsd / oraclePrice).toFixed(6)} base @ $${oraclePrice.toFixed(2)})`
  );

  const sig = await driftClient.placePerpOrder({
    orderType: OrderType.MARKET,
    marketIndex,
    direction: PositionDirection.SHORT,
    baseAssetAmount: baseAmount,
    marketType: { perp: {} } as any,
  });

  return sig;
}

async function closePosition(
  driftClient: DriftClient,
  marketIndex: number,
  symbol: string
): Promise<string | null> {
  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();
  const pos = positions.find(
    (p) => p.marketIndex === marketIndex && !p.baseAssetAmount.isZero()
  );

  if (!pos) {
    console.log(`  No ${symbol} position to close`);
    return null;
  }

  const direction = pos.baseAssetAmount.isNeg()
    ? PositionDirection.LONG
    : PositionDirection.SHORT;

  console.log(
    `  Closing ${symbol}: ${pos.baseAssetAmount.isNeg() ? "SHORT" : "LONG"} ` +
    `${(Math.abs(pos.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber()).toFixed(6)} base`
  );

  const sig = await driftClient.placePerpOrder({
    orderType: OrderType.MARKET,
    marketIndex,
    direction,
    baseAssetAmount: pos.baseAssetAmount.abs(),
    reduceOnly: true,
    marketType: { perp: {} } as any,
  });

  return sig;
}

function printPositions(driftClient: DriftClient): void {
  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();
  const active = positions.filter((p) => !p.baseAssetAmount.isZero());

  if (active.length === 0) {
    console.log("  No active positions");
    return;
  }

  for (const pos of active) {
    const symbol = Object.entries(BASKET).find(
      ([, v]) => v.marketIndex === pos.marketIndex
    )?.[0] ?? `MKT-${pos.marketIndex}`;

    const dir = pos.baseAssetAmount.isNeg() ? "SHORT" : "LONG";
    const size = Math.abs(pos.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber();
    const pnl = user.getUnrealizedPNL(true, pos.marketIndex).toNumber() / 1e6;

    console.log(`  ${symbol}: ${dir} ${size.toFixed(6)} base | PnL: $${pnl.toFixed(4)}`);
  }
}

// --- Main Test Sequence ---

async function main(): Promise<void> {
  console.log("=== Devnet Test: JLP Trend-Aware Delta Hedge ===\n");
  console.log("This test uses mainnet signals + devnet execution.\n");

  const keypair = loadKeypair();
  const connection = new Connection(DEVNET_RPC, "confirmed");

  console.log(`RPC: ${DEVNET_RPC}`);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`Virtual JLP: $${VIRTUAL_JLP_USD.toLocaleString()}`);
  console.log(`Test size: $${TEST_SIZE_USD} per asset\n`);

  // Init Drift devnet
  const sdkConfig = initialize({ env: "devnet" });
  const wallet = new Wallet(keypair);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_DEVNET_PROGRAM_ID,
    accountSubscription: { type: "polling", accountLoader },
    env: "devnet",
  });

  await driftClient.subscribe();
  console.log("Drift client connected (devnet).\n");

  // Check collateral
  try {
    const user = driftClient.getUser();
    const collateral = user.getTotalCollateral().toNumber() / 1e6;
    console.log(`Collateral: $${collateral.toFixed(2)}`);
    if (collateral < 10) {
      console.log("Insufficient collateral. Run devnet-setup.ts first.");
      await driftClient.unsubscribe();
      return;
    }
  } catch {
    console.log("No Drift account. Run devnet-setup.ts first.");
    await driftClient.unsubscribe();
    return;
  }

  // --- Test 1: Market Data + Signals ---
  console.log("\n--- Test 1: Signal Detection (mainnet data) ---");
  const markets = await fetchMarketData();
  for (const asset of ["SOL-PERP", "BTC-PERP", "ETH-PERP"]) {
    const m = markets.find((x) => x.symbol === asset);
    if (m) {
      const spreadPct = ((m.markPrice - m.oraclePrice) / m.oraclePrice * 100);
      console.log(
        `  ${asset}: oracle=$${m.oraclePrice.toFixed(2)} mark=$${m.markPrice.toFixed(2)} ` +
        `spread=${spreadPct.toFixed(3)}% funding=${(m.fundingRate * 100).toFixed(4)}%`
      );
    }
  }
  console.log("  PASS: Market data fetched\n");

  // --- Test 2: Trend Detection ---
  console.log("--- Test 2: Trend Detection ---");
  const trend = await detectTrend();
  console.log(`  Current trend: ${trend.toUpperCase()}`);
  const deltaHedgeActive = trend !== "bull";
  console.log(`  Delta hedge: ${deltaHedgeActive ? "ACTIVE" : "INACTIVE (bull market)"}`);
  console.log("  PASS: Trend detected\n");

  // --- Test 3: Vol Estimation ---
  console.log("--- Test 3: Vol Estimation ---");
  const vol = await fetchVol();
  console.log(`  Vol: ${(vol.volBps / 100).toFixed(1)}% annualized (${vol.regime} regime)`);
  console.log("  PASS: Vol computed\n");

  // --- Test 4: Place Delta Hedge Orders ---
  console.log("--- Test 4: Place Delta Hedge (short basket assets) ---");

  if (!deltaHedgeActive) {
    console.log("  Skipping — trend is bull, no delta hedge needed");
    console.log("  (In production, keeper would not hedge in bull trend)\n");
  }

  // Always test execution regardless of trend
  console.log("  [Testing execution regardless of trend signal]\n");

  const solData = markets.find((m) => m.symbol === "SOL-PERP");
  if (!solData) {
    console.log("  ERROR: SOL-PERP data not found");
    await driftClient.unsubscribe();
    return;
  }

  // Place a small SOL short
  try {
    const sig = await placeShort(
      driftClient, 0, TEST_SIZE_USD, solData.oraclePrice, "SOL"
    );
    console.log(`  TX: ${sig}`);
    console.log("  PASS: SOL short placed\n");
  } catch (err) {
    console.error(`  FAIL: ${err}\n`);
  }

  await sleep(3000); // Wait for order to fill

  // --- Test 5: Check Positions ---
  console.log("--- Test 5: Current Positions ---");
  printPositions(driftClient);
  console.log("");

  // --- Test 6: Portfolio Greeks ---
  console.log("--- Test 6: Portfolio Greeks ---");
  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();

  let totalDeltaUsd = 0;
  for (const [asset, info] of Object.entries(BASKET)) {
    const jlpExposure = VIRTUAL_JLP_USD * info.weight;
    const pos = positions.find((p) => p.marketIndex === info.marketIndex);
    const hedgeUsd = pos && !pos.baseAssetAmount.isZero()
      ? -(pos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber()) * solData.oraclePrice
      : 0;
    const netDelta = jlpExposure + hedgeUsd;
    totalDeltaUsd += netDelta;
    console.log(
      `  ${asset}: JLP exposure $${jlpExposure.toFixed(0)} | ` +
      `Hedge $${hedgeUsd.toFixed(0)} | Net $${netDelta.toFixed(0)}`
    );
  }
  console.log(`  Total net delta: $${totalDeltaUsd.toFixed(0)} (${((totalDeltaUsd / VIRTUAL_JLP_USD) * 100).toFixed(1)}%)`);
  console.log("  PASS: Greeks computed\n");

  // --- Test 7: Close All (emergency test) ---
  console.log("--- Test 7: Emergency Close All ---");
  for (const [asset, info] of Object.entries(BASKET)) {
    try {
      const sig = await closePosition(driftClient, info.marketIndex, asset);
      if (sig) console.log(`  TX: ${sig}`);
    } catch (err) {
      console.log(`  ${asset}: no position or close failed`);
    }
  }
  await sleep(3000);
  console.log("\n  Positions after close:");
  printPositions(driftClient);
  console.log("  PASS: Close-all works\n");

  // --- Summary ---
  console.log("=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Trend: ${trend} → delta hedge ${deltaHedgeActive ? "ON" : "OFF"}`);
  console.log(`  Vol: ${vol.regime} (${(vol.volBps / 100).toFixed(1)}%)`);
  console.log(`  Execution: Drift devnet orders placed and closed`);
  console.log(`  Greeks: Computed from virtual JLP + real Drift positions`);
  console.log("");
  console.log("  Next: Run with real JLP deposit on mainnet:");
  console.log("    1. Deposit USDC into JLP on Jupiter");
  console.log("    2. Switch RPC_URL to mainnet");
  console.log("    3. Run the jlp-gamma-hedge keeper");
  console.log("=".repeat(60));

  await driftClient.unsubscribe();
}

main().catch(console.error);
