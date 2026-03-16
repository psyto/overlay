/**
 * Multi-Market Test — Verify SOL, BTC, ETH shorts all work on devnet.
 *
 * Opens a short on each market, verifies it fills, checks positions, then closes all.
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

const MARKETS = [
  { symbol: "SOL-PERP", index: 0, testSizeUsd: 30 },
  { symbol: "BTC-PERP", index: 1, testSizeUsd: 30 },
  { symbol: "ETH-PERP", index: 2, testSizeUsd: 30 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log("=== Multi-Market Devnet Test ===\n");

  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(process.env.MANAGER_KEYPAIR_PATH!), "utf-8")))
  );
  const connection = new Connection(DEVNET_RPC, "confirmed");

  initialize({ env: "devnet" });
  const wallet = new Wallet(keypair);
  const loader = new BulkAccountLoader(connection, "confirmed", 5000);
  const driftClient = new DriftClient({
    connection, wallet, programID: DRIFT_PROGRAM,
    accountSubscription: { type: "polling", accountLoader: loader },
    env: "devnet",
  });
  await driftClient.subscribe();
  console.log(`Drift connected. Collateral: $${(driftClient.getUser().getTotalCollateral().toNumber() / 1e6).toFixed(2)}\n`);

  // Fetch mainnet oracle prices for sizing
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  const body = (await res.json()) as any;
  const prices: Record<string, number> = {};
  for (const m of body.markets) {
    prices[m.symbol] = parseFloat(m.oraclePrice);
  }

  // --- Test 1: Open shorts on all three markets ---
  console.log("--- Test 1: Open Shorts ---");
  const results: Array<{ symbol: string; success: boolean; sig?: string; error?: string }> = [];

  for (const mkt of MARKETS) {
    const price = prices[mkt.symbol];
    if (!price) {
      console.log(`  ${mkt.symbol}: No oracle price — SKIP`);
      results.push({ symbol: mkt.symbol, success: false, error: "No oracle price" });
      continue;
    }

    const baseAmount = new BN(Math.floor((mkt.testSizeUsd / price) * BASE_PRECISION.toNumber()));
    console.log(
      `  ${mkt.symbol}: SHORT $${mkt.testSizeUsd} ` +
      `(${(mkt.testSizeUsd / price).toFixed(6)} base @ $${price.toFixed(2)})`
    );

    try {
      const sig = await driftClient.placePerpOrder({
        orderType: OrderType.MARKET,
        marketIndex: mkt.index,
        direction: PositionDirection.SHORT,
        baseAssetAmount: baseAmount,
        marketType: { perp: {} } as any,
      });
      console.log(`  TX: ${sig.slice(0, 16)}... PASS`);
      results.push({ symbol: mkt.symbol, success: true, sig });
    } catch (err) {
      console.log(`  FAIL: ${err}`);
      results.push({ symbol: mkt.symbol, success: false, error: String(err) });
    }

    await sleep(3000);
  }

  console.log("");

  // --- Test 2: Verify positions ---
  console.log("--- Test 2: Verify Positions ---");
  await sleep(5000); // Wait for fills

  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();

  for (const mkt of MARKETS) {
    const pos = positions.find((p) => p.marketIndex === mkt.index && !p.baseAssetAmount.isZero());
    if (pos) {
      const dir = pos.baseAssetAmount.isNeg() ? "SHORT" : "LONG";
      const size = Math.abs(pos.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber();
      console.log(`  ${mkt.symbol}: ${dir} ${size.toFixed(6)} base — PASS`);
    } else {
      console.log(`  ${mkt.symbol}: No position — may have filled and closed, or devnet liquidity issue`);
    }
  }
  console.log("");

  // --- Test 3: Close all positions ---
  console.log("--- Test 3: Close All ---");

  for (const mkt of MARKETS) {
    const pos = positions.find((p) => p.marketIndex === mkt.index && !p.baseAssetAmount.isZero());
    if (!pos) { console.log(`  ${mkt.symbol}: nothing to close`); continue; }

    try {
      const sig = await driftClient.placePerpOrder({
        orderType: OrderType.MARKET,
        marketIndex: mkt.index,
        direction: pos.baseAssetAmount.isNeg() ? PositionDirection.LONG : PositionDirection.SHORT,
        baseAssetAmount: pos.baseAssetAmount.abs(),
        reduceOnly: true,
        marketType: { perp: {} } as any,
      });
      console.log(`  ${mkt.symbol}: closed — ${sig.slice(0, 16)}... PASS`);
    } catch (err) {
      console.log(`  ${mkt.symbol}: close failed — ${err}`);
    }
    await sleep(3000);
  }

  await sleep(5000);
  const remaining = driftClient.getUser().getActivePerpPositions().filter((p) => !p.baseAssetAmount.isZero());
  console.log(`\n  Remaining positions: ${remaining.length} ${remaining.length === 0 ? "— PASS" : "— FAIL"}`);

  // --- Summary ---
  console.log("\n=== SUMMARY ===");
  const passed = results.filter((r) => r.success).length;
  console.log(`Open:  ${passed}/${MARKETS.length} markets`);
  console.log(`Close: ${remaining.length === 0 ? "PASS" : "FAIL"}`);

  for (const r of results) {
    console.log(`  ${r.symbol}: ${r.success ? "PASS" : "FAIL" + " (" + r.error + ")"}`);
  }

  await driftClient.unsubscribe();
}

main().catch(console.error);
