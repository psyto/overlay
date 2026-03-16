/**
 * Lightweight Mainnet Scanner — bypasses Marginfi SDK heavy initialization.
 *
 * Instead of loading all 50+ banks and oracles, we:
 * 1. Fetch only the 3 banks we care about (SOL, USDC, JitoSOL)
 * 2. Use getProgramAccounts with memcmp to find accounts containing those banks
 * 3. Decode account data with a minimal parser
 *
 * This uses ~10x fewer RPC credits than the full SDK approach.
 *
 * Usage:
 *   RPC_URL="https://mainnet.helius-rpc.com/?api-key=KEY" \
 *     npx ts-node --transpile-only scripts/mainnet-scan-lite.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";

const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const MARGINFI_GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");

// Banks we care about
// REAL bank addresses discovered from on-chain data
const TARGET_BANKS: Record<string, { address: PublicKey; decimals: number; isCollateral: boolean }> = {
  SOL:     { address: new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"), decimals: 9, isCollateral: true },
  JitoSOL: { address: new PublicKey("Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8"), decimals: 9, isCollateral: true },
  mSOL:    { address: new PublicKey("22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE"), decimals: 9, isCollateral: true },
  bSOL:    { address: new PublicKey("6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K"), decimals: 9, isCollateral: true },
  USDC:    { address: new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"), decimals: 6, isCollateral: false },
  USDT:    { address: new PublicKey("HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV"), decimals: 6, isCollateral: false },
};

// Marginfi account layout (from IDL):
// 0-7: discriminator (8 bytes)
// 8-39: group (Pubkey)
// 40-71: authority (Pubkey)
// 72-73: account_flags (u64) — but may be part of lending_account struct
// Then lending_account.balances: array of Balance entries
//
// Each Balance (from IDL):
//   active: bool (1 byte)
//   bank_pk: Pubkey (32 bytes)
//   [padding: 7 bytes to align to 8-byte boundary]
//   asset_shares: WrappedI80F48 (16 bytes)
//   liability_shares: WrappedI80F48 (16 bytes)
//   emissions_outstanding: WrappedI80F48 (16 bytes)
//   last_update: u64 (8 bytes)
//   padding: [u64; 1] (8 bytes)
//   = 1 + 32 + 7 + 16 + 16 + 16 + 8 + 8 = 104 bytes per balance
//
// Max 16 balance slots → 16 × 104 = 1664 bytes for balances
// + header (72 bytes) + account_flags etc = ~2312 total (matches observed)

const BALANCE_START = 72; // After header: 8(disc) + 32(group) + 32(authority) = 72
const BALANCE_SIZE = 140; // Actual size per entry (to be determined empirically)
const MAX_BALANCES = 16;
const ACCOUNT_SIZE = 2312;

interface ParsedBalance {
  active: boolean;
  bankPk: string;
  bankSymbol: string;
  assetShares: number;
  liabilityShares: number;
}

interface ParsedAccount {
  address: string;
  authority: string;
  balances: ParsedBalance[];
}

interface AnalyzedPosition {
  address: string;
  owner: string;
  collateralUsd: number;
  debtUsd: number;
  ltv: number;
  liquidationPrice: number;
  collateralType: string;
}

// --- i80f48 decoder ---
// Marginfi uses WrappedI80F48: a 128-bit fixed-point number
// Stored as 16 bytes little-endian. The value = raw_bits / 2^48

function readI80F48(buf: Buffer, offset: number): number {
  // Read as two 64-bit integers (lo, hi)
  const lo = buf.readBigUInt64LE(offset);
  const hi = buf.readBigInt64LE(offset + 8);
  // Combine: value = (hi << 64 | lo) / 2^48
  // For most practical values, lo/2^48 is sufficient (hi is sign extension)
  const combined = Number(hi) * 2 ** 16 + Number(lo) / 2 ** 48;
  return combined;
}

// --- Account Parser ---

function findBalanceLayout(data: Buffer): { start: number; size: number } | null {
  // Search for a known bank pubkey to determine the exact layout
  for (const [, bank] of Object.entries(TARGET_BANKS)) {
    const bankBytes = bank.address.toBuffer();
    const idx = data.indexOf(bankBytes);
    if (idx >= 0) {
      // The active flag should be 1 byte before (with possible padding)
      // Find the nearest position before idx where active=1
      for (let back = 1; back <= 8; back++) {
        if (data[idx - back] === 1) {
          const entryStart = idx - back;
          const bankOffset = back; // Bank is at +back from entry start
          return { start: entryStart, size: 0 }; // Size TBD
        }
      }
      // If no active flag found, bank_pk is at a fixed offset from entry start
      return { start: idx - 8, size: 0 }; // Guess: 8 bytes before bank (active + padding)
    }
  }
  return null;
}

function parseAccount(data: Buffer, address: string): ParsedAccount | null {
  if (data.length < ACCOUNT_SIZE - 100) return null;

  const authority = new PublicKey(data.slice(40, 72)).toBase58();
  const balances: ParsedBalance[] = [];

  const bankLookup = new Map<string, string>();
  for (const [sym, bank] of Object.entries(TARGET_BANKS)) {
    bankLookup.set(bank.address.toBase58(), sym);
  }

  // Parse balance entries at known offsets
  // Layout: HDR(72) + Balance[16] × 104 bytes each
  // Balance: active(1) + bank_pk(32) + tag(1) + pad(6) + asset_shares(16) + liab_shares(16) + emissions(16) + last_update(8) + pad(8)
  for (let b = 0; b < MAX_BALANCES; b++) {
    const off = BALANCE_START + b * BALANCE_SIZE;
    if (off + BALANCE_SIZE > data.length) break;

    const active = data[off];
    if (active !== 1) continue;

    const bankPk = new PublicKey(data.slice(off + 1, off + 33)).toBase58();
    const sym = bankLookup.get(bankPk);
    if (!sym) continue; // Skip unknown banks

    // asset_shares at offset +40 (after active+bank_pk+tag+pad = 1+32+1+6 = 40)
    const assetShares = readI80F48(data, off + 40);
    // liability_shares at offset +56
    const liabilityShares = readI80F48(data, off + 56);

    balances.push({
      active: true,
      bankPk,
      bankSymbol: sym,
      assetShares: Math.max(0, assetShares),
      liabilityShares: Math.max(0, liabilityShares),
    });
  }

  if (balances.length === 0) return null;
  return { address, authority, balances };
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
    const sol = body.markets?.find((m) => m.symbol === "SOL-PERP");
    return sol ? parseFloat(sol.oraclePrice) : 100;
  } catch { return 100; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Lightweight Mainnet Scanner ===\n");
  console.log(`RPC: ${RPC_URL}\n`);

  const connection = new Connection(RPC_URL, "confirmed");
  const solPrice = await fetchSolPrice();
  console.log(`SOL: $${solPrice.toFixed(2)}\n`);

  // Step 1: Get all account pubkeys (lightweight — no data)
  console.log("Step 1: Fetching account addresses...");
  const allPubkeys = await connection.getProgramAccounts(MARGINFI_PROGRAM, {
    commitment: "confirmed",
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 8, bytes: MARGINFI_GROUP.toBase58() } },
      { dataSize: ACCOUNT_SIZE },
    ],
  });
  console.log(`Total accounts: ${allPubkeys.length}\n`);

  // Step 2: Batch fetch and parse
  const CHUNK = 100;
  const LIMIT = Math.min(allPubkeys.length, 10000);
  const positions: AnalyzedPosition[] = [];
  let scanned = 0;
  let parsed = 0;

  console.log(`Step 2: Scanning ${LIMIT} accounts...\n`);

  for (let i = 0; i < LIMIT; i += CHUNK) {
    const chunk = allPubkeys.slice(i, i + CHUNK).map((a) => a.pubkey);

    try {
      const infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
      scanned += chunk.length;

      for (let j = 0; j < infos.length; j++) {
        const info = infos[j];
        if (!info?.data) continue;

        const account = parseAccount(info.data, chunk[j].toBase58());
        if (!account) continue;
        parsed++;

        // Analyze: find SOL collateral + debt
        const solBals = account.balances.filter(
          (b) => TARGET_BANKS[b.bankSymbol]?.isCollateral && b.assetShares > 0
        );
        const debtBals = account.balances.filter((b) => b.liabilityShares > 0);

        if (solBals.length === 0 || debtBals.length === 0) continue;

        // Estimate USD values from shares
        // Shares ≈ token amount (simplified — real conversion needs bank share rate)
        const solBal = solBals[0];
        const collateralTokens = solBal.assetShares;
        const collateralUsd = collateralTokens * solPrice;

        let debtUsd = 0;
        for (const d of debtBals) {
          if (TARGET_BANKS[d.bankSymbol]?.isCollateral) {
            debtUsd += d.liabilityShares * solPrice; // SOL-denominated debt
          } else {
            debtUsd += d.liabilityShares; // Stable debt (USDC = 1:1)
          }
        }

        if (collateralUsd < 1000 || debtUsd < 500) continue;

        const ltv = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;
        const liqPrice = collateralTokens > 0
          ? debtUsd / (collateralTokens * 0.80) // 80% maintenance
          : 0;

        positions.push({
          address: account.address,
          owner: account.authority,
          collateralUsd,
          debtUsd,
          ltv,
          liquidationPrice: liqPrice,
          collateralType: solBal.bankSymbol,
        });
      }

      await sleep(100); // Rate limit protection
    } catch (err) {
      console.log(`  Chunk ${Math.floor(i / CHUNK)} failed, waiting 3s...`);
      await sleep(3000);
    }

    if ((i / CHUNK) % 10 === 0 && i > 0) {
      console.log(
        `  Scanned: ${scanned} | Parsed: ${parsed} | SOL positions: ${positions.length}`
      );
    }
  }

  console.log(
    `\nDone: ${scanned} scanned, ${parsed} with known banks, ${positions.length} leveraged SOL positions\n`
  );

  if (positions.length === 0) {
    console.log("No positions found. The shares→value conversion may need calibration.");
    console.log(`Parsed ${parsed} accounts with known bank pubkeys.`);
    return;
  }

  // Summary
  const totalCol = positions.reduce((s, p) => s + p.collateralUsd, 0);
  const totalDebt = positions.reduce((s, p) => s + p.debtUsd, 0);

  console.log("=== SUMMARY ===");
  console.log(`Positions: ${positions.length}`);
  console.log(`Total collateral: $${(totalCol / 1e6).toFixed(2)}M`);
  console.log(`Total debt: $${(totalDebt / 1e6).toFixed(2)}M`);
  console.log(`Avg LTV: ${totalCol > 0 ? (totalDebt / totalCol * 100).toFixed(1) : 0}%\n`);

  // Top positions
  const sorted = positions.sort((a, b) => b.collateralUsd - a.collateralUsd);
  console.log("Top 10:");
  for (const p of sorted.slice(0, 10)) {
    console.log(
      `  $${(p.collateralUsd / 1000).toFixed(0).padStart(6)}K col | ` +
      `$${(p.debtUsd / 1000).toFixed(0).padStart(6)}K debt | ` +
      `LTV ${p.ltv.toFixed(1).padStart(5)}% | ` +
      `Liq $${p.liquidationPrice.toFixed(0).padStart(4)} | ` +
      `${p.collateralType}`
    );
  }

  // Heatmap
  console.log("\n=== LIQUIDATION HEATMAP ===\n");
  const lo = solPrice * 0.5, hi = solPrice * 1.5;
  const buckets = Array.from({ length: 20 }, (_, i) => ({
    mid: lo + (hi - lo) * ((i + 0.5) / 20),
    usd: 0,
    n: 0,
  }));

  for (const p of positions) {
    if (p.liquidationPrice < lo || p.liquidationPrice > hi) continue;
    const idx = Math.floor(((p.liquidationPrice - lo) / (hi - lo)) * 20);
    if (idx >= 0 && idx < 20) { buckets[idx].usd += p.collateralUsd; buckets[idx].n++; }
  }

  const mx = Math.max(...buckets.map((b) => b.usd), 1);
  for (const b of buckets) {
    if (b.n === 0) continue;
    const d = ((b.mid - solPrice) / solPrice * 100);
    const bar = "█".repeat(Math.max(1, Math.round((b.usd / mx) * 40)));
    const tag = b.usd >= 5e6 ? "CRIT" : b.usd >= 2e6 ? "HIGH" : b.usd >= 5e5 ? " MED" : " LOW";
    const cur = Math.abs(d) < 3 ? " ◄" : "";
    console.log(
      `$${b.mid.toFixed(0).padStart(4)} (${d >= 0 ? "+" : ""}${d.toFixed(0).padStart(4)}%) ` +
      `[${tag}] $${(b.usd / 1e6).toFixed(2).padStart(6)}M (${String(b.n).padStart(3)}) ${bar}${cur}`
    );
  }
}

main().catch(console.error);
