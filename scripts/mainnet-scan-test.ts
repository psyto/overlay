/**
 * Mainnet Scanner Test — Read real leveraged positions from Kamino and Marginfi.
 *
 * This is READ-ONLY. No transactions, no signing needed.
 * Uses public RPC to scan on-chain positions and build a liquidation heatmap.
 *
 * Usage:
 *   RPC_URL="https://your-rpc.com" npx ts-node --transpile-only scripts/mainnet-scan-test.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  MarginfiClient,
  getConfig,
  MarginRequirementType,
} from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import { Keypair } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

// Known SOL-related bank addresses on Marginfi
const SOL_BANKS = {
  SOL: "DD3AeAssFvjqTvRTrRAtpfjkBF8FpVKnFuwnMLN9haXD",
  JitoSOL: "7Ng54qf7BrCcZLqXmKA9WSR7SVRn4q6RX1YpLksBQ21A",
};

interface ScannedPosition {
  protocol: string;
  owner: string;
  totalAssetsUsd: number;
  totalDebtUsd: number;
  ltv: number;
  healthFactor: number;
  isLiquidatable: boolean;
  liquidationPrice: number | null;
  collateralType: string;
}

// --- Marginfi Scanner ---

async function scanMarginfi(): Promise<ScannedPosition[]> {
  console.log("\n=== Scanning Marginfi ===\n");

  const connection = new Connection(RPC_URL, "confirmed");
  // Read-only — use a throwaway keypair (no signing needed)
  const dummyKeypair = Keypair.generate();
  const wallet = new NodeWallet(dummyKeypair);
  const config = getConfig("production");

  console.log("Initializing Marginfi client...");
  const client = await MarginfiClient.fetch(config, wallet, connection);
  console.log("Client ready.\n");

  // Step 1: Get all account addresses
  console.log("Fetching all account addresses (lightweight GPA)...");
  const allAddresses = await client.getAllMarginfiAccountAddresses();
  console.log(`Total marginfi accounts: ${allAddresses.length}\n`);

  // Step 2: Scan a sample (first 2000 accounts) to find leveraged positions
  const SCAN_LIMIT = 2000;
  const CHUNK_SIZE = 100;
  const positions: ScannedPosition[] = [];
  let scanned = 0;

  console.log(`Scanning ${Math.min(allAddresses.length, SCAN_LIMIT)} accounts in chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < Math.min(allAddresses.length, SCAN_LIMIT); i += CHUNK_SIZE) {
    const chunk = allAddresses.slice(i, i + CHUNK_SIZE);

    try {
      const accounts = await client.getMultipleMarginfiAccounts(chunk);
      scanned += chunk.length;

      for (const acct of accounts) {
        try {
          const pure = acct.pureAccount;
          const activeBalances = pure.activeBalances?.filter((b: any) => b.active) ?? [];
          if (activeBalances.length === 0) continue;

          let totalAssets = 0;
          let totalLiabs = 0;
          let collateralType = "unknown";
          let hasSolCollateral = false;

          for (const bal of activeBalances) {
            const bank = client.getBankByPk(bal.bankPk);
            if (!bank) continue;

            const oraclePrice = client.getOraclePriceByBank(bal.bankPk);
            const usdValue = bal.computeUsdValue(bank, oraclePrice);

            const assetUsd = usdValue?.assets?.toNumber() ?? 0;
            const liabUsd = usdValue?.liabilities?.toNumber() ?? 0;

            totalAssets += assetUsd;
            totalLiabs += liabUsd;

            if (assetUsd > 0) {
              const symbol = bank.tokenSymbol ?? "";
              if (symbol.includes("SOL") || symbol.includes("Jito")) {
                hasSolCollateral = true;
                collateralType = symbol;
              }
            }
          }

          // Only include leveraged positions with SOL collateral
          if (totalLiabs < 1000 || !hasSolCollateral) continue;

          let isLiquidatable = false;
          try {
            const { assets, liabilities } = pure.computeHealthComponents(
              MarginRequirementType.Maintenance
            );
            isLiquidatable = assets.lt(liabilities);
          } catch {}

          const ltv = totalAssets > 0 ? (totalLiabs / totalAssets) * 100 : 0;
          const hf = totalLiabs > 0 ? totalAssets / totalLiabs : Infinity;

          // Estimate liquidation price
          // SOL price at which this position gets liquidated
          const solCollateralAmount = totalAssets / (getDriftSolPrice() || 100);
          const liqPrice = totalLiabs / (solCollateralAmount * 0.8); // 80% maintenance

          positions.push({
            protocol: "marginfi",
            owner: pure.authority?.toBase58() ?? "?",
            totalAssetsUsd: totalAssets,
            totalDebtUsd: totalLiabs,
            ltv,
            healthFactor: hf,
            isLiquidatable,
            liquidationPrice: liqPrice,
            collateralType,
          });
        } catch {
          // Skip
        }
      }
    } catch (err) {
      // RPC errors — continue
    }

    if ((i / CHUNK_SIZE) % 5 === 0 && i > 0) {
      console.log(`  Scanned ${scanned} accounts, found ${positions.length} leveraged positions`);
    }
  }

  console.log(`\nMarginfi scan complete: ${scanned} checked, ${positions.length} leveraged positions\n`);
  return positions;
}

// Cached SOL price
let cachedSolPrice = 0;
async function fetchSolPrice(): Promise<number> {
  try {
    const res = await fetch("https://data.api.drift.trade/stats/markets");
    if (!res.ok) return 100;
    const body = (await res.json()) as { success: boolean; markets: Array<{ symbol: string; marketType: string; oraclePrice: string }> };
    const sol = body.markets?.find((m) => m.symbol === "SOL-PERP" && m.marketType === "perp");
    cachedSolPrice = sol ? parseFloat(sol.oraclePrice) : 100;
    return cachedSolPrice;
  } catch { return 100; }
}
function getDriftSolPrice(): number { return cachedSolPrice || 100; }

// --- Heatmap Builder ---

function buildHeatmap(positions: ScannedPosition[], currentPrice: number): void {
  const BUCKET_PCT = 1.0; // 1% buckets
  const RANGE_PCT = 30;   // ±30%

  const low = currentPrice * (1 - RANGE_PCT / 100);
  const high = currentPrice * (1 + RANGE_PCT / 100);
  const bucketCount = Math.ceil(RANGE_PCT * 2 / BUCKET_PCT);

  const buckets: Array<{ priceLow: number; priceHigh: number; totalUsd: number; count: number }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const bl = low + (high - low) * (i / bucketCount);
    const bh = low + (high - low) * ((i + 1) / bucketCount);
    buckets.push({ priceLow: bl, priceHigh: bh, totalUsd: 0, count: 0 });
  }

  for (const pos of positions) {
    if (!pos.liquidationPrice || pos.liquidationPrice < low || pos.liquidationPrice > high) continue;
    const idx = Math.floor(((pos.liquidationPrice - low) / (high - low)) * bucketCount);
    if (idx >= 0 && idx < bucketCount) {
      buckets[idx].totalUsd += pos.totalAssetsUsd;
      buckets[idx].count++;
    }
  }

  // Print heatmap
  console.log("=== LIQUIDATION HEATMAP ===");
  console.log(`SOL: $${currentPrice.toFixed(2)} | Range: $${low.toFixed(0)} — $${high.toFixed(0)}\n`);

  const maxUsd = Math.max(...buckets.map((b) => b.totalUsd));

  for (const bucket of buckets) {
    if (bucket.totalUsd < 10000) continue; // Skip empty buckets

    const mid = (bucket.priceLow + bucket.priceHigh) / 2;
    const distPct = ((mid - currentPrice) / currentPrice * 100);
    const barLen = maxUsd > 0 ? Math.round((bucket.totalUsd / maxUsd) * 40) : 0;
    const bar = "█".repeat(barLen);
    const marker = Math.abs(distPct) < BUCKET_PCT ? " ◄ CURRENT" : "";

    let density = "    ";
    if (bucket.totalUsd >= 5_000_000) density = "CRIT";
    else if (bucket.totalUsd >= 2_000_000) density = "HIGH";
    else if (bucket.totalUsd >= 500_000) density = " MED";
    else density = " LOW";

    console.log(
      `$${mid.toFixed(0).padStart(4)} (${distPct >= 0 ? "+" : ""}${distPct.toFixed(1).padStart(5)}%) ` +
      `[${density}] $${(bucket.totalUsd / 1e6).toFixed(1).padStart(5)}M (${String(bucket.count).padStart(3)}) ${bar}${marker}`
    );
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Mainnet Liquidation Density Scanner ===\n");
  console.log(`RPC: ${RPC_URL}\n`);

  // Get SOL price
  const solPrice = await fetchSolPrice();
  console.log(`SOL price: $${solPrice.toFixed(2)}`);

  // Scan Marginfi (Kamino requires @solana/kit signer — skip for read-only test)
  const marginfiPositions = await scanMarginfi();

  // Stats
  const totalCollateral = marginfiPositions.reduce((s, p) => s + p.totalAssetsUsd, 0);
  const totalDebt = marginfiPositions.reduce((s, p) => s + p.totalDebtUsd, 0);
  const liquidatable = marginfiPositions.filter((p) => p.isLiquidatable);

  console.log("=== SUMMARY ===");
  console.log(`Positions: ${marginfiPositions.length}`);
  console.log(`Total collateral: $${(totalCollateral / 1e6).toFixed(1)}M`);
  console.log(`Total debt: $${(totalDebt / 1e6).toFixed(1)}M`);
  console.log(`Average LTV: ${(totalDebt / totalCollateral * 100).toFixed(1)}%`);
  console.log(`Liquidatable now: ${liquidatable.length}`);
  console.log("");

  // Top 10 largest positions
  const sorted = marginfiPositions.sort((a, b) => b.totalAssetsUsd - a.totalAssetsUsd);
  console.log("Top 10 largest leveraged positions:");
  for (const pos of sorted.slice(0, 10)) {
    console.log(
      `  $${(pos.totalAssetsUsd / 1000).toFixed(0)}K collateral | ` +
      `$${(pos.totalDebtUsd / 1000).toFixed(0)}K debt | ` +
      `LTV: ${pos.ltv.toFixed(1)}% | ` +
      `HF: ${pos.healthFactor.toFixed(2)} | ` +
      `Liq: $${pos.liquidationPrice?.toFixed(2) ?? "?"} | ` +
      `${pos.collateralType} | ` +
      `${pos.isLiquidatable ? "LIQUIDATABLE!" : "healthy"}`
    );
  }
  console.log("");

  // Build and print heatmap
  buildHeatmap(marginfiPositions, solPrice);

  // Positions near current price
  const nearbyPct = 5;
  const nearby = marginfiPositions.filter((p) => {
    if (!p.liquidationPrice) return false;
    const dist = Math.abs((p.liquidationPrice - solPrice) / solPrice * 100);
    return dist < nearbyPct;
  });
  console.log(`\n${nearby.length} positions with liquidation within ${nearbyPct}% of current price ($${(solPrice * (1 - nearbyPct / 100)).toFixed(0)} — $${(solPrice * (1 + nearbyPct / 100)).toFixed(0)})`);
}

main().catch(console.error);
