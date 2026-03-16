/**
 * Lightweight Mainnet Scanner v2 — Real on-chain liquidation heatmap.
 *
 * 1. Fetch bank share rates (6 RPC calls)
 * 2. Scan 509K Marginfi accounts in batches
 * 3. Convert shares → tokens → USD
 * 4. Compute liquidation prices
 * 5. Build and print heatmap
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const ACCOUNT_SIZE = 2312;

// Real bank addresses from on-chain discovery
const BANK_CONFIG: Record<string, {
  address: string;
  decimals: number;
  isSolLike: boolean;  // Tracks SOL price
  priceMultiplier: number; // Relative to SOL (JitoSOL ≈ 1.08x, mSOL ≈ 1.07x)
}> = {
  SOL:     { address: "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh", decimals: 9, isSolLike: true, priceMultiplier: 1.0 },
  JitoSOL: { address: "Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8", decimals: 9, isSolLike: true, priceMultiplier: 1.08 },
  mSOL:    { address: "22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE", decimals: 9, isSolLike: true, priceMultiplier: 1.07 },
  bSOL:    { address: "6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K", decimals: 9, isSolLike: true, priceMultiplier: 1.05 },
  USDC:    { address: "2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB", decimals: 6, isSolLike: false, priceMultiplier: 0 },
  USDT:    { address: "HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV", decimals: 6, isSolLike: false, priceMultiplier: 0 },
};

// Build reverse lookup
const bankLookup = new Map<string, string>();
for (const [sym, cfg] of Object.entries(BANK_CONFIG)) {
  bankLookup.set(cfg.address, sym);
}

// Share rates loaded from on-chain bank accounts
const shareRates: Record<string, { asset: number; liab: number }> = {};

// --- i80f48 ---
function readI80F48(buf: Buffer, off: number): number {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigInt64LE(off + 8);
  return Number(hi) * (2 ** 16) + Number(lo) / (2 ** 48);
}

// --- Load share rates from bank accounts ---
async function loadShareRates(connection: Connection): Promise<void> {
  console.log("Loading bank share rates...");
  const bankAddrs = Object.entries(BANK_CONFIG).map(([sym, cfg]) => ({
    sym,
    pk: new PublicKey(cfg.address),
  }));

  const infos = await connection.getMultipleAccountsInfo(
    bankAddrs.map((b) => b.pk)
  );

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    const sym = bankAddrs[i].sym;
    if (!info) {
      console.log(`  ${sym}: NOT FOUND — using default 1.0`);
      shareRates[sym] = { asset: 1.0, liab: 1.0 };
      continue;
    }
    // asset_share_value at offset 328, liability_share_value at offset 344
    const assetRate = readI80F48(info.data, 328);
    const liabRate = readI80F48(info.data, 344);
    shareRates[sym] = { asset: assetRate, liab: liabRate };
    console.log(`  ${sym}: asset=${assetRate.toFixed(6)} liab=${liabRate.toFixed(6)}`);
  }
}

// --- Convert shares to USD ---
function sharesToUsd(
  shares: number,
  sym: string,
  type: "asset" | "liab",
  solPrice: number
): number {
  const cfg = BANK_CONFIG[sym];
  if (!cfg) return 0;
  const rate = shareRates[sym]?.[type] ?? 1.0;
  const tokenAmount = (shares * rate) / 10 ** cfg.decimals;
  if (cfg.isSolLike) {
    return tokenAmount * solPrice * cfg.priceMultiplier;
  }
  return tokenAmount; // Stablecoins = USD
}

// --- Position Types ---
interface Position {
  address: string;
  owner: string;
  collateralUsd: number;
  debtUsd: number;
  solCollateralTokens: number; // In SOL-equivalent terms
  ltv: number;
  liquidationPrice: number;
  collateralType: string;
}

// --- SOL Price ---
async function fetchSolPrice(): Promise<number> {
  try {
    const res = await fetch("https://data.api.drift.trade/stats/markets");
    if (!res.ok) return 100;
    const body = (await res.json()) as any;
    const sol = body.markets?.find((m: any) => m.symbol === "SOL-PERP");
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
  console.log("=== Mainnet Liquidation Heatmap ===\n");
  const connection = new Connection(RPC_URL, "confirmed");
  const solPrice = await fetchSolPrice();
  console.log(`SOL: $${solPrice.toFixed(2)}\n`);

  await loadShareRates(connection);
  console.log("");

  // Get all pubkeys
  console.log("Fetching account addresses...");
  const allPubkeys = await connection.getProgramAccounts(MARGINFI_PROGRAM, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 8, bytes: MARGINFI_GROUP.toBase58() } },
      { dataSize: ACCOUNT_SIZE },
    ],
  });
  console.log(`Total: ${allPubkeys.length}\n`);

  // Scan in batches
  const CHUNK = 100;
  const LIMIT = Math.min(allPubkeys.length, 20000);
  const positions: Position[] = [];
  let scanned = 0;
  let withKnownBank = 0;

  console.log(`Scanning ${LIMIT} accounts...\n`);

  for (let i = 0; i < LIMIT; i += CHUNK) {
    const chunk = allPubkeys.slice(i, i + CHUNK).map((a) => a.pubkey);

    try {
      const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
      scanned += chunk.length;

      for (let j = 0; j < infos.length; j++) {
        const info = infos[j];
        if (!info?.data) continue;
        const d = info.data;

        let totalAssetUsd = 0;
        let totalLiabUsd = 0;
        let solCollateralTokens = 0;
        let collateralType = "";
        let hasSolCollateral = false;
        let hasDebt = false;

        for (let b = 0; b < 16; b++) {
          const off = 72 + b * 104;
          if (off + 104 > d.length) break;
          if (d[off] !== 1) continue;

          const bankPk = new PublicKey(d.slice(off + 1, off + 33)).toBase58();
          const sym = bankLookup.get(bankPk);
          if (!sym) continue;

          withKnownBank++;
          const assetShares = readI80F48(d, off + 40);
          const liabShares = readI80F48(d, off + 56);

          const assetUsd = sharesToUsd(assetShares, sym, "asset", solPrice);
          const liabUsd = sharesToUsd(liabShares, sym, "liab", solPrice);

          totalAssetUsd += assetUsd;
          totalLiabUsd += liabUsd;

          if (BANK_CONFIG[sym]?.isSolLike && assetUsd > 0) {
            hasSolCollateral = true;
            const cfg = BANK_CONFIG[sym];
            solCollateralTokens += (assetShares * (shareRates[sym]?.asset ?? 1)) / 10 ** cfg.decimals;
            collateralType = sym;
          }
          if (liabUsd > 0) hasDebt = true;
        }

        // Filter: must have SOL-like collateral AND debt, minimum $100
        if (!hasSolCollateral || !hasDebt || totalAssetUsd < 100 || totalLiabUsd < 50) continue;

        const ltv = totalAssetUsd > 0 ? (totalLiabUsd / totalAssetUsd) * 100 : 0;

        // Liquidation price: the SOL price at which LTV hits 80% maintenance threshold
        // At liquidation: totalLiabUsd / (solCollateralTokens × liqPrice × multiplier + stableAssets) = 0.80
        // Simplified (assuming mostly SOL collateral):
        const liqPrice = solCollateralTokens > 0
          ? totalLiabUsd / (solCollateralTokens * 0.80)
          : 0;

        if (liqPrice <= 0 || liqPrice > solPrice * 3) continue;

        positions.push({
          address: chunk[j].toBase58(),
          owner: new PublicKey(d.slice(40, 72)).toBase58(),
          collateralUsd: totalAssetUsd,
          debtUsd: totalLiabUsd,
          solCollateralTokens,
          ltv,
          liquidationPrice: liqPrice,
          collateralType,
        });
      }

      await sleep(100);
    } catch {
      await sleep(3000);
    }

    if ((i / CHUNK) % 20 === 0 && i > 0) {
      console.log(
        `  ${scanned}/${LIMIT} scanned | ${positions.length} leveraged SOL positions`
      );
    }
  }

  console.log(
    `\nScan: ${scanned} accounts | ${positions.length} leveraged SOL positions\n`
  );

  if (positions.length === 0) {
    console.log("No leveraged SOL positions found in sample.");
    return;
  }

  // Summary
  const totalCol = positions.reduce((s, p) => s + p.collateralUsd, 0);
  const totalDebt = positions.reduce((s, p) => s + p.debtUsd, 0);
  console.log("=== SUMMARY ===");
  console.log(`Positions: ${positions.length}`);
  console.log(`Collateral: $${(totalCol / 1e6).toFixed(3)}M`);
  console.log(`Debt: $${(totalDebt / 1e6).toFixed(3)}M`);
  console.log(`Avg LTV: ${(totalDebt / totalCol * 100).toFixed(1)}%\n`);

  // Top 10
  const sorted = positions.sort((a, b) => b.collateralUsd - a.collateralUsd);
  console.log("Top 10 positions:");
  for (const p of sorted.slice(0, 10)) {
    console.log(
      `  $${(p.collateralUsd).toFixed(0).padStart(8)} col | ` +
      `$${(p.debtUsd).toFixed(0).padStart(8)} debt | ` +
      `LTV ${p.ltv.toFixed(1).padStart(5)}% | ` +
      `Liq $${p.liquidationPrice.toFixed(2).padStart(7)} | ` +
      `${p.collateralType}`
    );
  }

  // Heatmap
  console.log("\n=== LIQUIDATION HEATMAP ===");
  console.log(`SOL: $${solPrice.toFixed(2)}\n`);

  const lo = solPrice * 0.3;
  const hi = solPrice * 2.0;
  const BUCKETS = 30;
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    mid: lo + (hi - lo) * ((i + 0.5) / BUCKETS),
    usd: 0,
    n: 0,
  }));

  for (const p of positions) {
    if (p.liquidationPrice < lo || p.liquidationPrice > hi) continue;
    const idx = Math.floor(((p.liquidationPrice - lo) / (hi - lo)) * BUCKETS);
    if (idx >= 0 && idx < BUCKETS) {
      buckets[idx].usd += p.collateralUsd;
      buckets[idx].n++;
    }
  }

  const mx = Math.max(...buckets.map((b) => b.usd), 1);
  for (const b of buckets) {
    if (b.n === 0) continue;
    const d = ((b.mid - solPrice) / solPrice) * 100;
    const bar = "█".repeat(Math.max(1, Math.round((b.usd / mx) * 50)));
    const tag = b.usd >= 100000 ? "CRIT" : b.usd >= 50000 ? "HIGH" : b.usd >= 10000 ? " MED" : " LOW";
    const cur = Math.abs(d) < 4 ? " ◄" : "";
    console.log(
      `$${b.mid.toFixed(0).padStart(4)} (${d >= 0 ? "+" : ""}${d.toFixed(0).padStart(4)}%) ` +
      `[${tag}] $${(b.usd / 1e3).toFixed(1).padStart(7)}K (${String(b.n).padStart(3)}) ${bar}${cur}`
    );
  }

  // Nearby
  const near = positions.filter(
    (p) => Math.abs((p.liquidationPrice - solPrice) / solPrice) < 0.1
  );
  const nearUsd = near.reduce((s, p) => s + p.collateralUsd, 0);
  console.log(
    `\n${near.length} positions ($${(nearUsd / 1e3).toFixed(1)}K) within 10% of current price`
  );
}

main().catch(console.error);
