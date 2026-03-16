/**
 * Mainnet Scanner Test — Using Marginfi SDK with proper initialization.
 *
 * The SDK handles deserialization of the complex account layout.
 * Uses Helius RPC with retry logic for rate limits.
 *
 * READ-ONLY.
 *
 * Usage:
 *   RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" \
 *     npx ts-node --transpile-only scripts/mainnet-scan-test.ts
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  MarginfiClient,
  getConfig,
  MarginRequirementType,
} from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

// SOL-related bank symbols
const SOL_SYMBOLS = ["SOL", "JitoSOL", "mSOL", "bSOL", "jitoSOL"];

interface AnalyzedPosition {
  address: string;
  owner: string;
  collateralUsd: number;
  debtUsd: number;
  ltv: number;
  healthFactor: number;
  isLiquidatable: boolean;
  liquidationPrice: number;
  collateralType: string;
}

// --- SOL Price ---

async function fetchSolPrice(): Promise<number> {
  try {
    const res = await fetch("https://data.api.drift.trade/stats/markets");
    if (!res.ok) return 100;
    const body = (await res.json()) as {
      success: boolean;
      markets: Array<{ symbol: string; marketType: string; oraclePrice: string }>;
    };
    const sol = body.markets?.find((m) => m.symbol === "SOL-PERP" && m.marketType === "perp");
    return sol ? parseFloat(sol.oraclePrice) : 100;
  } catch {
    return 100;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Mainnet Liquidation Density Scanner ===\n");
  console.log(`RPC: ${RPC_URL}\n`);

  const solPrice = await fetchSolPrice();
  console.log(`SOL price: $${solPrice.toFixed(2)}\n`);

  // Initialize Marginfi with retry
  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000,
  });
  const wallet = new NodeWallet(Keypair.generate());
  const config = getConfig("production");

  console.log("Initializing Marginfi client (this loads all banks + oracles)...");
  let client: MarginfiClient;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      client = await MarginfiClient.fetch(config, wallet, connection);
      console.log("Marginfi client initialized.\n");
      break;
    } catch (err) {
      console.log(`  Attempt ${attempt}/3 failed, waiting ${attempt * 5}s...`);
      await sleep(attempt * 5000);
      if (attempt === 3) {
        console.error("Failed to initialize Marginfi client after 3 attempts.");
        console.error("This requires a paid RPC with higher rate limits.");
        return;
      }
    }
  }

  // Print available banks
  console.log("Available banks:");
  for (const [, bank] of client!.banks) {
    const symbol = bank.tokenSymbol ?? bank.mint.toBase58().slice(0, 8);
    const rates = bank.computeInterestRates();
    console.log(
      `  ${symbol.padEnd(10)} | ` +
      `Supply: ${(rates.lendingRate.toNumber() * 100).toFixed(2)}% | ` +
      `Borrow: ${(rates.borrowingRate.toNumber() * 100).toFixed(2)}% | ` +
      `Util: ${(bank.computeUtilizationRate().toNumber() * 100).toFixed(1)}%`
    );
  }
  console.log("");

  // Step 1: Get all account addresses
  console.log("Fetching all account addresses...");
  const allAddresses = await client!.getAllMarginfiAccountAddresses();
  console.log(`Total accounts: ${allAddresses.length}\n`);

  // Step 2: Scan accounts in batches
  const SCAN_LIMIT = 3000;
  const CHUNK_SIZE = 50; // Smaller chunks for rate limits
  const positions: AnalyzedPosition[] = [];
  let scanned = 0;

  console.log(`Scanning ${Math.min(allAddresses.length, SCAN_LIMIT)} accounts...\n`);

  for (let i = 0; i < Math.min(allAddresses.length, SCAN_LIMIT); i += CHUNK_SIZE) {
    const chunk = allAddresses.slice(i, i + CHUNK_SIZE);

    try {
      const accounts = await client!.getMultipleMarginfiAccounts(chunk);
      scanned += chunk.length;

      for (const acct of accounts) {
        try {
          const pure = acct.pureAccount;
          const balances = pure.activeBalances?.filter((b: any) => b.active) ?? [];
          if (balances.length === 0) continue;

          let totalAssets = 0;
          let totalLiabs = 0;
          let solCollateralUsd = 0;
          let collateralType = "";

          for (const bal of balances) {
            const bank = client!.getBankByPk(bal.bankPk);
            if (!bank) continue;
            const oraclePrice = client!.getOraclePriceByBank(bal.bankPk);
            const usdValue = bal.computeUsdValue(bank, oraclePrice);

            const assetUsd = usdValue?.assets?.toNumber() ?? 0;
            const liabUsd = usdValue?.liabilities?.toNumber() ?? 0;

            totalAssets += assetUsd;
            totalLiabs += liabUsd;

            const sym = bank.tokenSymbol ?? "";
            if (assetUsd > 0 && SOL_SYMBOLS.some((s) => sym.includes(s))) {
              solCollateralUsd += assetUsd;
              collateralType = sym;
            }
          }

          // Must have both assets and liabilities (leveraged)
          if (totalLiabs < 500 || solCollateralUsd < 500) continue;

          const ltv = totalAssets > 0 ? (totalLiabs / totalAssets) * 100 : 0;
          const hf = totalLiabs > 0 ? totalAssets / totalLiabs : Infinity;

          let isLiq = false;
          try {
            const h = pure.computeHealthComponents(MarginRequirementType.Maintenance);
            isLiq = h.assets.lt(h.liabilities);
          } catch {}

          // Liquidation price estimate
          const solAmount = solCollateralUsd / solPrice;
          const liqPrice = solAmount > 0 ? totalLiabs / (solAmount * 0.80) : 0;

          positions.push({
            address: acct.address.toBase58(),
            owner: pure.authority?.toBase58() ?? "?",
            collateralUsd: totalAssets,
            debtUsd: totalLiabs,
            ltv,
            healthFactor: hf,
            isLiquidatable: isLiq,
            liquidationPrice: liqPrice,
            collateralType,
          });
        } catch {
          // Skip
        }
      }

      // Rate limit protection
      await sleep(200);
    } catch (err) {
      console.log(`  Chunk at ${i} failed, waiting 5s...`);
      await sleep(5000);
    }

    if ((i / CHUNK_SIZE) % 10 === 0 && i > 0) {
      console.log(`  Scanned ${scanned} | Leveraged SOL positions: ${positions.length}`);
    }
  }

  console.log(`\nScan complete: ${scanned} accounts, ${positions.length} leveraged SOL positions\n`);

  if (positions.length === 0) {
    console.log("No leveraged SOL positions found in sample. Try scanning more accounts.");
    return;
  }

  // Summary
  const totalCol = positions.reduce((s, p) => s + p.collateralUsd, 0);
  const totalDebt = positions.reduce((s, p) => s + p.debtUsd, 0);
  const liquidatable = positions.filter((p) => p.isLiquidatable);

  console.log("=== SUMMARY ===");
  console.log(`Positions: ${positions.length}`);
  console.log(`Total collateral: $${(totalCol / 1e6).toFixed(2)}M`);
  console.log(`Total debt: $${(totalDebt / 1e6).toFixed(2)}M`);
  console.log(`Avg LTV: ${(totalDebt / totalCol * 100).toFixed(1)}%`);
  console.log(`Liquidatable: ${liquidatable.length}`);
  console.log("");

  // Top 10
  const sorted = positions.sort((a, b) => b.collateralUsd - a.collateralUsd);
  console.log("Top 10 positions:");
  for (const p of sorted.slice(0, 10)) {
    console.log(
      `  $${(p.collateralUsd / 1000).toFixed(0).padStart(6)}K col | ` +
      `$${(p.debtUsd / 1000).toFixed(0).padStart(6)}K debt | ` +
      `LTV: ${p.ltv.toFixed(1).padStart(5)}% | ` +
      `HF: ${p.healthFactor.toFixed(2).padStart(5)} | ` +
      `Liq: $${p.liquidationPrice.toFixed(0).padStart(4)} | ` +
      `${p.collateralType.padEnd(8)} | ` +
      `${p.isLiquidatable ? "LIQUIDATABLE!" : "healthy"}`
    );
  }

  // Heatmap
  console.log("\n=== LIQUIDATION HEATMAP ===");
  console.log(`SOL: $${solPrice.toFixed(2)}\n`);

  const low = solPrice * 0.7;
  const high = solPrice * 1.3;
  const buckets = Array.from({ length: 30 }, (_, i) => ({
    mid: low + (high - low) * ((i + 0.5) / 30),
    totalUsd: 0,
    count: 0,
  }));

  for (const p of positions) {
    if (p.liquidationPrice < low || p.liquidationPrice > high) continue;
    const idx = Math.floor(((p.liquidationPrice - low) / (high - low)) * 30);
    if (idx >= 0 && idx < 30) {
      buckets[idx].totalUsd += p.collateralUsd;
      buckets[idx].count++;
    }
  }

  const maxUsd = Math.max(...buckets.map((b) => b.totalUsd), 1);
  for (const b of buckets) {
    if (b.count === 0) continue;
    const dist = ((b.mid - solPrice) / solPrice * 100);
    const bar = "█".repeat(Math.max(1, Math.round((b.totalUsd / maxUsd) * 40)));
    const marker = Math.abs(dist) < 2 ? " ◄" : "";
    let tag = "    ";
    if (b.totalUsd >= 5e6) tag = "CRIT";
    else if (b.totalUsd >= 2e6) tag = "HIGH";
    else if (b.totalUsd >= 500e3) tag = " MED";
    else tag = " LOW";

    console.log(
      `$${b.mid.toFixed(0).padStart(4)} (${dist >= 0 ? "+" : ""}${dist.toFixed(0).padStart(4)}%) ` +
      `[${tag}] $${(b.totalUsd / 1e6).toFixed(2).padStart(6)}M (${String(b.count).padStart(3)}) ${bar}${marker}`
    );
  }

  // Nearby positions
  const nearby = positions.filter((p) => {
    return Math.abs((p.liquidationPrice - solPrice) / solPrice * 100) < 10;
  });
  console.log(
    `\n${nearby.length} positions within 10% of current price ` +
    `($${(solPrice * 0.9).toFixed(0)} — $${(solPrice * 1.1).toFixed(0)})`
  );
}

main().catch(console.error);
