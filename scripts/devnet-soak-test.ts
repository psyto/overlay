/**
 * Devnet Soak Test — Run the JLP delta hedge keeper for 48 hours on devnet.
 *
 * Tests:
 * - Continuous operation without crashes
 * - Signal detection every 5 minutes (mainnet data)
 * - Trend transitions detected and logged
 * - Hedge toggle: opens shorts in bear/range, closes in bull
 * - All three markets: SOL, BTC, ETH
 * - Emergency close-all on CRITICAL signals
 * - Position tracking and P&L reporting
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/devnet-soak-test.ts
 *
 * Output: logs to console + writes JSON report to scripts/soak-report.json
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

// --- Config ---

const DEVNET_RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const DRIFT_DATA_API = "https://data.api.drift.trade"; // Mainnet signals
const DRIFT_PROGRAM_ID = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

const VIRTUAL_JLP_USD = 10_000;
const TEST_SIZE_USD = 20; // Small size per asset

const MARKETS = [
  { symbol: "SOL", index: 0, weight: 0.44 },
  { symbol: "BTC", index: 1, weight: 0.11 },
  { symbol: "ETH", index: 2, weight: 0.10 },
];

// Timing (compressed for testing — real keeper uses longer intervals)
const SIGNAL_INTERVAL_MS = 5 * 60 * 1000;   // 5 min
const HEDGE_INTERVAL_MS = 15 * 60 * 1000;    // 15 min
const REPORT_INTERVAL_MS = 30 * 60 * 1000;   // 30 min status report
const HEARTBEAT_MS = 60 * 1000;              // 1 min heartbeat

// --- Types ---

interface MarketData {
  symbol: string;
  oraclePrice: number;
  markPrice: number;
  fundingRate: number;
}

interface SoakEvent {
  timestamp: string;
  type: "signal" | "trend_change" | "hedge_open" | "hedge_close" | "emergency" | "error" | "heartbeat";
  message: string;
  data?: any;
}

interface SoakReport {
  startTime: string;
  endTime: string;
  durationHours: number;
  totalEvents: number;
  signalChecks: number;
  trendChanges: number;
  hedgeOpens: number;
  hedgeCloses: number;
  emergencies: number;
  errors: number;
  trendHistory: Array<{ timestamp: string; trend: string }>;
  events: SoakEvent[];
}

// --- State ---

let driftClient: DriftClient;
const events: SoakEvent[] = [];
const trendHistory: Array<{ timestamp: string; trend: string }> = [];
let currentTrend: "bull" | "bear" | "range" = "range";
let hedgeActive = false;
let signalChecks = 0;
let trendChanges = 0;
let hedgeOpens = 0;
let hedgeCloses = 0;
let emergencies = 0;
let errors = 0;

function log(type: SoakEvent["type"], message: string, data?: any): void {
  const ts = new Date().toISOString();
  events.push({ timestamp: ts, type, message, data });
  const prefix = {
    signal: "📡", trend_change: "🔄", hedge_open: "📉",
    hedge_close: "📈", emergency: "🚨", error: "❌", heartbeat: "💓",
  };
  console.log(`[${ts}] ${prefix[type] ?? "•"} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Market Data (mainnet) ---

async function fetchMarketData(): Promise<MarketData[]> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  if (!res.ok) throw new Error(`Market fetch: ${res.status}`);
  const body = (await res.json()) as any;
  return body.markets
    .filter((m: any) => m.marketType === "perp")
    .map((m: any) => ({
      symbol: m.symbol,
      oraclePrice: parseFloat(m.oraclePrice),
      markPrice: parseFloat(m.markPrice),
      fundingRate: parseFloat(m.fundingRate24h),
    }));
}

// --- Trend Detection (OI/funding leading indicator) ---

async function detectTrend(): Promise<"bull" | "bear" | "range"> {
  try {
    const res = await fetch(`${DRIFT_DATA_API}/market/SOL-PERP/candles/D?limit=14`);
    if (!res.ok) return "range";
    const body = (await res.json()) as any;
    if (!body.success || body.records.length < 14) return "range";

    const sorted = body.records.sort((a: any, b: any) => a.ts - b.ts);
    const closes = sorted.map((r: any) => r.oracleClose);
    const current = closes[closes.length - 1];
    const weekAgo = closes[closes.length - 8] || closes[0];
    const twoWeeksAgo = closes[0];

    const mom7d = (current - weekAgo) / weekAgo;
    const mom14d = (current - twoWeeksAgo) / twoWeeksAgo;

    // Volume trend
    const recentVol = sorted.slice(-7).reduce((s: number, r: any) => s + (r.quoteVolume || 0), 0) / 7;
    const priorVol = sorted.slice(0, 7).reduce((s: number, r: any) => s + (r.quoteVolume || 0), 0) / 7;
    const volTrend = priorVol > 0 ? recentVol / priorVol : 1;

    if (mom7d > 0.03 && mom14d > 0.05 && volTrend > 1.0) return "bull";
    if (mom7d < -0.03 && mom14d < -0.05 && volTrend > 1.0) return "bear";
    if (mom7d > 0.08) return "bull";
    if (mom7d < -0.08) return "bear";
    return "range";
  } catch {
    return "range";
  }
}

// --- Signal Severity ---

async function detectSignalSeverity(): Promise<number> {
  try {
    const markets = await fetchMarketData();
    const sol = markets.find((m) => m.symbol === "SOL-PERP");
    if (!sol) return 0;

    const spreadPct = Math.abs((sol.markPrice - sol.oraclePrice) / sol.oraclePrice * 100);
    if (spreadPct > 3.0) return 3;
    if (spreadPct > 1.5) return 2;
    if (spreadPct > 0.5) return 1;
    return 0;
  } catch {
    return 0;
  }
}

// --- Drift Execution ---

async function getOraclePrice(marketIndex: number): Promise<number> {
  try {
    const market = driftClient.getPerpMarketAccount(marketIndex);
    if (!market) return 0;
    const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
    return oracle.price.toNumber() / PRICE_PRECISION.toNumber();
  } catch {
    return 0;
  }
}

async function openShort(marketIndex: number, sizeUsd: number, symbol: string): Promise<string | null> {
  const price = await getOraclePrice(marketIndex);
  if (price <= 0) return null;

  const baseAmount = new BN(Math.floor((sizeUsd / price) * BASE_PRECISION.toNumber()));
  try {
    const sig = await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketIndex,
      direction: PositionDirection.SHORT,
      baseAssetAmount: baseAmount,
      marketType: { perp: {} } as any,
    });
    return sig;
  } catch (err) {
    log("error", `Failed to open ${symbol} short: ${err}`);
    errors++;
    return null;
  }
}

async function closePosition(marketIndex: number, symbol: string): Promise<string | null> {
  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();
  const pos = positions.find((p) => p.marketIndex === marketIndex && !p.baseAssetAmount.isZero());
  if (!pos) return null;

  try {
    const sig = await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketIndex,
      direction: pos.baseAssetAmount.isNeg() ? PositionDirection.LONG : PositionDirection.SHORT,
      baseAssetAmount: pos.baseAssetAmount.abs(),
      reduceOnly: true,
      marketType: { perp: {} } as any,
    });
    return sig;
  } catch (err) {
    log("error", `Failed to close ${symbol}: ${err}`);
    errors++;
    return null;
  }
}

function getActivePositions(): Array<{ symbol: string; direction: string; sizeBase: number }> {
  const user = driftClient.getUser();
  const positions = user.getActivePerpPositions();
  return positions
    .filter((p) => !p.baseAssetAmount.isZero())
    .map((p) => {
      const mkt = MARKETS.find((m) => m.index === p.marketIndex);
      return {
        symbol: mkt?.symbol ?? `MKT-${p.marketIndex}`,
        direction: p.baseAssetAmount.isNeg() ? "SHORT" : "LONG",
        sizeBase: Math.abs(p.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber(),
      };
    });
}

// --- Core Loop Functions ---

async function runSignalCheck(): Promise<void> {
  signalChecks++;
  const severity = await detectSignalSeverity();
  const labels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
  log("signal", `Signal: ${labels[severity]}`, { severity });

  // Emergency on CRITICAL
  if (severity >= 3) {
    log("emergency", "CRITICAL signal — closing all hedges");
    emergencies++;
    for (const mkt of MARKETS) {
      await closePosition(mkt.index, mkt.symbol);
    }
    hedgeActive = false;
  }
}

async function runTrendCheck(): Promise<void> {
  const newTrend = await detectTrend();

  if (newTrend !== currentTrend) {
    trendChanges++;
    log("trend_change", `Trend: ${currentTrend} → ${newTrend}`);
    trendHistory.push({ timestamp: new Date().toISOString(), trend: newTrend });
    currentTrend = newTrend;
  }
}

async function runHedgeRebalance(): Promise<void> {
  const shouldHedge = currentTrend !== "bull";

  if (shouldHedge && !hedgeActive) {
    // Open hedges for all three markets
    log("hedge_open", `Opening delta hedges (trend: ${currentTrend})`);
    for (const mkt of MARKETS) {
      const size = VIRTUAL_JLP_USD * mkt.weight * 0.01; // 1% of exposure for test
      const adjustedSize = Math.max(TEST_SIZE_USD, size);
      const sig = await openShort(mkt.index, adjustedSize, mkt.symbol);
      if (sig) {
        log("hedge_open", `  ${mkt.symbol} short $${adjustedSize.toFixed(0)}: ${sig.slice(0, 12)}...`);
      }
      await sleep(2000);
    }
    hedgeActive = true;
    hedgeOpens++;
  } else if (!shouldHedge && hedgeActive) {
    // Close hedges
    log("hedge_close", `Closing delta hedges (trend: ${currentTrend})`);
    for (const mkt of MARKETS) {
      const sig = await closePosition(mkt.index, mkt.symbol);
      if (sig) {
        log("hedge_close", `  ${mkt.symbol} closed: ${sig.slice(0, 12)}...`);
      }
      await sleep(2000);
    }
    hedgeActive = false;
    hedgeCloses++;
  } else {
    log("heartbeat", `Hedge: ${hedgeActive ? "active" : "inactive"} (trend: ${currentTrend})`);
  }
}

// --- Report ---

function writeReport(): void {
  const report: SoakReport = {
    startTime: events[0]?.timestamp ?? new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationHours: events.length > 0
      ? (Date.now() - new Date(events[0].timestamp).getTime()) / 3600000
      : 0,
    totalEvents: events.length,
    signalChecks,
    trendChanges,
    hedgeOpens,
    hedgeCloses,
    emergencies,
    errors,
    trendHistory,
    events: events.slice(-100), // Last 100 events
  };

  const reportPath = path.join(__dirname, "soak-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);
}

function printStatus(): void {
  const positions = getActivePositions();
  const posStr = positions.length > 0
    ? positions.map((p) => `${p.symbol}:${p.direction}`).join(", ")
    : "none";

  log("heartbeat",
    `Checks: ${signalChecks} | Trend: ${currentTrend} | ` +
    `Hedge: ${hedgeActive ? "ON" : "OFF"} | Positions: ${posStr} | ` +
    `Changes: ${trendChanges} | Opens: ${hedgeOpens} | Closes: ${hedgeCloses} | ` +
    `Emergencies: ${emergencies} | Errors: ${errors}`
  );
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== JLP Delta Hedge — Devnet Soak Test ===\n");
  console.log("Duration: runs until stopped (Ctrl+C)");
  console.log("Signals: live from mainnet Drift | Execution: devnet\n");

  const keypairPath = process.env.MANAGER_KEYPAIR_PATH;
  if (!keypairPath) throw new Error("MANAGER_KEYPAIR_PATH not set");
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(keypairPath), "utf-8")))
  );

  const connection = new Connection(DEVNET_RPC, "confirmed");
  console.log(`RPC: ${DEVNET_RPC}`);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}\n`);

  // Init Drift
  initialize({ env: "devnet" });
  const wallet = new Wallet(keypair);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);
  driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    accountSubscription: { type: "polling", accountLoader },
    env: "devnet",
  });
  await driftClient.subscribe();
  console.log("Drift connected.\n");

  // Verify collateral
  const collateral = driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
  console.log(`Collateral: $${collateral.toFixed(2)}`);
  if (collateral < 10) {
    console.log("Insufficient collateral. Run devnet-fund.ts first.");
    return;
  }

  // Initial state
  currentTrend = await detectTrend();
  log("heartbeat", `Initial trend: ${currentTrend}`);
  trendHistory.push({ timestamp: new Date().toISOString(), trend: currentTrend });

  // Save report on exit
  process.on("SIGINT", () => {
    console.log("\n\nShutting down...");
    writeReport();
    printStatus();
    process.exit(0);
  });

  // Main loop
  let lastSignal = 0;
  let lastHedge = 0;
  let lastReport = 0;
  let lastHeartbeat = 0;

  while (true) {
    const now = Date.now();

    try {
      // Signal check (every 5 min)
      if (now - lastSignal >= SIGNAL_INTERVAL_MS) {
        await runSignalCheck();
        await runTrendCheck();
        lastSignal = now;
      }

      // Hedge rebalance (every 15 min)
      if (now - lastHedge >= HEDGE_INTERVAL_MS) {
        await runHedgeRebalance();
        lastHedge = now;
      }

      // Status report (every 30 min)
      if (now - lastReport >= REPORT_INTERVAL_MS) {
        printStatus();
        writeReport();
        lastReport = now;
      }

      // Heartbeat (every 1 min)
      if (now - lastHeartbeat >= HEARTBEAT_MS) {
        // Light heartbeat — just verify connection
        try {
          driftClient.getUser().getTotalCollateral();
        } catch {
          log("error", "Lost Drift connection, resubscribing...");
          errors++;
          await driftClient.subscribe();
        }
        lastHeartbeat = now;
      }
    } catch (err) {
      log("error", `Loop error: ${err}`);
      errors++;
    }

    await sleep(10_000); // 10s base loop
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  writeReport();
  process.exit(1);
});
