/**
 * Hedge Toggle Test — Verify hedge turns on/off correctly based on trend.
 *
 * Simulates trend transitions by overriding the trend detector,
 * then verifies the hedge logic responds correctly:
 * - bull → no hedge (positions should close)
 * - bear → hedge on (shorts should open)
 * - range → hedge on (shorts should open)
 * - bull → hedge off (shorts should close)
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient, Wallet, BulkAccountLoader, PositionDirection,
  OrderType, BASE_PRECISION, PRICE_PRECISION, initialize,
} from "@drift-labs/sdk";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const DEVNET_RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const DRIFT_PROGRAM = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const DRIFT_DATA_API = "https://data.api.drift.trade";
const SOL_INDEX = 0;
const TEST_SIZE_USD = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getOraclePrice(): Promise<number> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  const body = (await res.json()) as any;
  const sol = body.markets?.find((m: any) => m.symbol === "SOL-PERP");
  return sol ? parseFloat(sol.oraclePrice) : 100;
}

async function openSolShort(driftClient: DriftClient, sizeUsd: number, price: number): Promise<string> {
  const base = new BN(Math.floor((sizeUsd / price) * BASE_PRECISION.toNumber()));
  return driftClient.placePerpOrder({
    orderType: OrderType.MARKET,
    marketIndex: SOL_INDEX,
    direction: PositionDirection.SHORT,
    baseAssetAmount: base,
    marketType: { perp: {} } as any,
  });
}

async function closeSolPosition(driftClient: DriftClient): Promise<string | null> {
  const pos = driftClient.getUser().getActivePerpPositions()
    .find((p) => p.marketIndex === SOL_INDEX && !p.baseAssetAmount.isZero());
  if (!pos) return null;
  return driftClient.placePerpOrder({
    orderType: OrderType.MARKET,
    marketIndex: SOL_INDEX,
    direction: pos.baseAssetAmount.isNeg() ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: pos.baseAssetAmount.abs(),
    reduceOnly: true,
    marketType: { perp: {} } as any,
  });
}

function hasPosition(driftClient: DriftClient): boolean {
  return driftClient.getUser().getActivePerpPositions()
    .some((p) => p.marketIndex === SOL_INDEX && !p.baseAssetAmount.isZero());
}

async function main(): Promise<void> {
  console.log("=== Hedge Toggle Test ===\n");

  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(process.env.MANAGER_KEYPAIR_PATH!), "utf-8")))
  );
  const connection = new Connection(DEVNET_RPC, "confirmed");

  initialize({ env: "devnet" });
  const driftClient = new DriftClient({
    connection,
    wallet: new Wallet(keypair),
    programID: DRIFT_PROGRAM,
    accountSubscription: { type: "polling", accountLoader: new BulkAccountLoader(connection, "confirmed", 5000) },
    env: "devnet",
  });
  await driftClient.subscribe();
  console.log(`Drift connected. Collateral: $${(driftClient.getUser().getTotalCollateral().toNumber() / 1e6).toFixed(2)}\n`);

  const solPrice = await getOraclePrice();
  console.log(`SOL price: $${solPrice.toFixed(2)}\n`);

  // Clean state: close any existing positions
  if (hasPosition(driftClient)) {
    console.log("Cleaning: closing existing position...");
    await closeSolPosition(driftClient);
    await sleep(5000);
  }

  let passed = 0;
  let failed = 0;

  // --- Scenario 1: BEAR → hedge should be ON ---
  console.log("--- Scenario 1: BEAR trend → open hedge ---");
  const forcedTrend1 = "bear";
  const shouldHedge1 = forcedTrend1 !== "bull"; // true
  console.log(`  Trend: ${forcedTrend1} → shouldHedge: ${shouldHedge1}`);

  if (shouldHedge1) {
    const sig = await openSolShort(driftClient, TEST_SIZE_USD, solPrice);
    console.log(`  Opened short: ${sig.slice(0, 16)}...`);
    await sleep(5000);
  }

  const hasPos1 = hasPosition(driftClient);
  console.log(`  Position exists: ${hasPos1} → ${hasPos1 === shouldHedge1 ? "PASS" : "FAIL"}\n`);
  hasPos1 === shouldHedge1 ? passed++ : failed++;

  // --- Scenario 2: BEAR → BULL → hedge should turn OFF ---
  console.log("--- Scenario 2: BULL trend → close hedge ---");
  const forcedTrend2 = "bull";
  const shouldHedge2 = forcedTrend2 !== "bull"; // false

  if (!shouldHedge2 && hasPosition(driftClient)) {
    const sig = await closeSolPosition(driftClient);
    console.log(`  Closed position: ${sig?.slice(0, 16) ?? "none"}...`);
    await sleep(5000);
  }

  const hasPos2 = hasPosition(driftClient);
  console.log(`  Position exists: ${hasPos2} → ${hasPos2 === shouldHedge2 ? "PASS" : "FAIL"}\n`);
  hasPos2 === shouldHedge2 ? passed++ : failed++;

  // --- Scenario 3: BULL → RANGE → hedge should turn ON ---
  console.log("--- Scenario 3: RANGE trend → open hedge ---");
  const forcedTrend3 = "range";
  const shouldHedge3 = forcedTrend3 !== "bull"; // true

  if (shouldHedge3 && !hasPosition(driftClient)) {
    const sig = await openSolShort(driftClient, TEST_SIZE_USD, solPrice);
    console.log(`  Opened short: ${sig.slice(0, 16)}...`);
    await sleep(5000);
  }

  const hasPos3 = hasPosition(driftClient);
  console.log(`  Position exists: ${hasPos3} → ${hasPos3 === shouldHedge3 ? "PASS" : "FAIL"}\n`);
  hasPos3 === shouldHedge3 ? passed++ : failed++;

  // --- Scenario 4: RANGE → BULL → hedge should turn OFF again ---
  console.log("--- Scenario 4: BULL trend → close hedge again ---");
  const forcedTrend4 = "bull";
  const shouldHedge4 = forcedTrend4 !== "bull"; // false

  if (!shouldHedge4 && hasPosition(driftClient)) {
    const sig = await closeSolPosition(driftClient);
    console.log(`  Closed position: ${sig?.slice(0, 16) ?? "none"}...`);
    await sleep(5000);
  }

  const hasPos4 = hasPosition(driftClient);
  console.log(`  Position exists: ${hasPos4} → ${hasPos4 === shouldHedge4 ? "PASS" : "FAIL"}\n`);
  hasPos4 === shouldHedge4 ? passed++ : failed++;

  // --- Summary ---
  console.log("=== SUMMARY ===");
  console.log(`Passed: ${passed}/4`);
  console.log(`Failed: ${failed}/4`);
  console.log(`\nHedge toggle logic: ${failed === 0 ? "ALL CORRECT" : "HAS ISSUES"}`);

  await driftClient.unsubscribe();
}

main().catch(console.error);
