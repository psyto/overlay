/**
 * Mainnet Dry Run — Run the keeper on mainnet but log-only, no orders.
 *
 * Reads real JLP position and mainnet Drift data.
 * Computes what the keeper WOULD do, but doesn't execute.
 * Run for 2-3 days before enabling real execution.
 *
 * Usage:
 *   RPC_URL="https://mainnet-rpc" WALLET_ADDRESS="your-pubkey" \
 *     npx ts-node --transpile-only scripts/mainnet-dry-run.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const DRIFT_DATA_API = "https://data.api.drift.trade";

const JLP_MINT = new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");
const BASKET_WEIGHTS = { SOL: 0.44, BTC: 0.11, ETH: 0.10 };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Data Fetchers ---

async function fetchMarketPrices(): Promise<Record<string, number>> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  if (!res.ok) return {};
  const body = (await res.json()) as any;
  const prices: Record<string, number> = {};
  for (const m of body.markets || []) {
    if (m.marketType === "perp") {
      prices[m.symbol] = parseFloat(m.oraclePrice);
    }
  }
  return prices;
}

async function detectTrend(): Promise<{ trend: string; mom7d: number; mom14d: number }> {
  try {
    const res = await fetch(`${DRIFT_DATA_API}/market/SOL-PERP/candles/D?limit=14`);
    if (!res.ok) return { trend: "range", mom7d: 0, mom14d: 0 };
    const body = (await res.json()) as any;
    if (!body.success || body.records.length < 14) return { trend: "range", mom7d: 0, mom14d: 0 };

    const sorted = body.records.sort((a: any, b: any) => a.ts - b.ts);
    const closes = sorted.map((r: any) => r.oracleClose);
    const current = closes[closes.length - 1];
    const weekAgo = closes[closes.length - 8] || closes[0];
    const twoWeeksAgo = closes[0];

    const mom7d = (current - weekAgo) / weekAgo;
    const mom14d = (current - twoWeeksAgo) / twoWeeksAgo;

    const recentVol = sorted.slice(-7).reduce((s: number, r: any) => s + (r.quoteVolume || 0), 0) / 7;
    const priorVol = sorted.slice(0, 7).reduce((s: number, r: any) => s + (r.quoteVolume || 0), 0) / 7;
    const volTrend = priorVol > 0 ? recentVol / priorVol : 1;

    let trend = "range";
    if (mom7d > 0.03 && mom14d > 0.05 && volTrend > 1.0) trend = "bull";
    else if (mom7d < -0.03 && mom14d < -0.05 && volTrend > 1.0) trend = "bear";
    else if (mom7d > 0.08) trend = "bull";
    else if (mom7d < -0.08) trend = "bear";

    return { trend, mom7d, mom14d };
  } catch {
    return { trend: "range", mom7d: 0, mom14d: 0 };
  }
}

async function fetchVol(): Promise<{ volBps: number; regime: string }> {
  try {
    const res = await fetch(`${DRIFT_DATA_API}/market/SOL-PERP/candles/D?limit=30`);
    if (!res.ok) return { volBps: 3500, regime: "low" };
    const body = (await res.json()) as any;
    if (!body.success) return { volBps: 3500, regime: "low" };

    const ln2x4 = 4 * Math.LN2;
    let sum = 0, valid = 0;
    for (const c of body.records) {
      if (c.oracleHigh <= 0 || c.oracleLow <= 0) continue;
      const l = Math.log(c.oracleHigh / c.oracleLow);
      sum += l * l;
      valid++;
    }
    if (valid === 0) return { volBps: 3500, regime: "low" };

    const volBps = Math.round(Math.sqrt(sum / (ln2x4 * valid) * 252) * 10000);
    let regime = "normal";
    if (volBps < 2000) regime = "veryLow";
    else if (volBps < 3500) regime = "low";
    else if (volBps < 5000) regime = "normal";
    else if (volBps < 7500) regime = "high";
    else regime = "extreme";

    return { volBps, regime };
  } catch {
    return { volBps: 3500, regime: "low" };
  }
}

async function fetchJlpPosition(
  connection: Connection,
  walletPubkey: PublicKey
): Promise<{ shares: number; valueUsd: number } | null> {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      walletPubkey, { mint: JLP_MINT }
    );
    if (tokenAccounts.value.length === 0) return null;

    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    const shares = parseFloat(balance.amount) / 1e6;
    if (shares <= 0) return null;

    // Estimate value from Jupiter pool
    try {
      const poolRes = await fetch("https://perps-api.jup.ag/v1/pool/info");
      if (poolRes.ok) {
        const poolData = (await poolRes.json()) as any;
        const pricePerShare = poolData.aum_usd ? poolData.aum_usd / (poolData.total_supply || 1) : 2.0;
        return { shares, valueUsd: shares * pricePerShare };
      }
    } catch {}

    return { shares, valueUsd: shares * 2.0 }; // Fallback estimate
  } catch {
    return null;
  }
}

// --- Main Loop ---

async function main(): Promise<void> {
  console.log("=== Mainnet Dry Run — JLP Delta Hedge ===\n");
  console.log("MODE: LOG-ONLY — no orders will be placed\n");

  if (!WALLET_ADDRESS) {
    throw new Error("WALLET_ADDRESS required");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const walletPubkey = new PublicKey(WALLET_ADDRESS);

  console.log(`RPC: ${RPC_URL}`);
  console.log(`Wallet: ${WALLET_ADDRESS}\n`);

  let iteration = 0;

  while (true) {
    iteration++;
    const now = new Date().toISOString();

    try {
      // Fetch all data
      const [prices, trendData, vol, jlpPos] = await Promise.all([
        fetchMarketPrices(),
        detectTrend(),
        fetchVol(),
        fetchJlpPosition(connection, walletPubkey),
      ]);

      const solPrice = prices["SOL-PERP"] ?? 0;
      const btcPrice = prices["BTC-PERP"] ?? 0;
      const ethPrice = prices["ETH-PERP"] ?? 0;

      const shouldHedge = trendData.trend !== "bull";
      const jlpValue = jlpPos?.valueUsd ?? 0;

      // Compute what we WOULD do
      const targetHedges: Array<{ asset: string; shortUsd: number }> = [];
      if (shouldHedge && jlpValue > 0) {
        for (const [asset, weight] of Object.entries(BASKET_WEIGHTS)) {
          targetHedges.push({ asset, shortUsd: jlpValue * weight });
        }
      }

      // Greeks
      const totalExposure = jlpValue * 0.65;
      const totalHedge = targetHedges.reduce((s, h) => s + h.shortUsd, 0);
      const netDelta = totalExposure - totalHedge;
      const netDeltaPct = jlpValue > 0 ? (netDelta / jlpValue) * 100 : 0;

      // Print status
      console.log(`\n[${now}] Iteration ${iteration}`);
      console.log(`  Prices: SOL=$${solPrice.toFixed(2)} BTC=$${btcPrice.toFixed(0)} ETH=$${ethPrice.toFixed(2)}`);
      console.log(`  Vol: ${(vol.volBps / 100).toFixed(1)}% (${vol.regime})`);
      console.log(`  Trend: ${trendData.trend.toUpperCase()} (7d: ${(trendData.mom7d * 100).toFixed(1)}%, 14d: ${(trendData.mom14d * 100).toFixed(1)}%)`);
      console.log(`  JLP: ${jlpPos ? `${jlpPos.shares.toFixed(4)} shares ($${jlpValue.toFixed(0)})` : "no position"}`);
      console.log(`  Hedge: ${shouldHedge ? "WOULD HEDGE" : "WOULD NOT HEDGE (bull)"}`);

      if (targetHedges.length > 0) {
        console.log(`  Target shorts:`);
        for (const h of targetHedges) {
          console.log(`    ${h.asset}: SHORT $${h.shortUsd.toFixed(0)}`);
        }
      }

      console.log(`  Greeks: delta=${netDeltaPct.toFixed(1)}% (${shouldHedge ? "hedged" : "unhedged"})`);
      console.log(`  ACTION: [DRY RUN — no orders placed]`);

    } catch (err) {
      console.error(`[${now}] Error: ${err}`);
    }

    // Run every 10 minutes
    await sleep(10 * 60 * 1000);
  }
}

main().catch(console.error);
