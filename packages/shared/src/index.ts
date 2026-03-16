/**
 * Shared utilities for Overlay strategies.
 *
 * - Keypair loading (both @solana/web3.js v1 and @solana/kit v2)
 * - Drift client initialization
 * - Common helpers
 *
 * Pattern from: kuma/src/utils/helpers.ts, yogi/src/utils/helpers.ts
 */

import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize,
  PositionDirection,
  OrderType,
  OrderParams,
  BASE_PRECISION,
  PRICE_PRECISION,
} from "@drift-labs/sdk";
import BN from "bn.js";

// --- Keypair Loading (from Kuma/Yogi pattern) ---

/**
 * Load a Keypair from a JSON file path specified by an environment variable.
 */
export function loadKeypair(envVar: string): Keypair {
  const filePath = process.env[envVar];
  if (!filePath) {
    throw new Error(`Environment variable ${envVar} not set`);
  }
  const resolved = path.resolve(filePath);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/**
 * Load a Keypair directly from a file path.
 */
export function loadKeypairFromPath(filePath: string): Keypair {
  const resolved = path.resolve(filePath);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/**
 * Get RPC connection from environment.
 */
export function getConnection(): Connection {
  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  return new Connection(rpcUrl, "confirmed");
}

// --- Drift Client (shared across strategies) ---

const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);

/**
 * Initialize a Drift client from a keypair.
 * Used by all strategies for perp trading and oracle reads.
 */
export async function initDriftClient(
  connection: Connection,
  keypair: Keypair
): Promise<DriftClient> {
  const wallet = new Wallet(keypair);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
  });

  await driftClient.subscribe();
  return driftClient;
}

/**
 * Get the current oracle price for a market from Drift.
 */
export function getDriftOraclePrice(
  driftClient: DriftClient,
  marketIndex: number
): number {
  const market = driftClient.getPerpMarketAccount(marketIndex);
  if (!market) return 0;
  const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
  return oracleData.price.toNumber() / PRICE_PRECISION.toNumber();
}

// --- Drift Order Helpers ---

/**
 * Place a market order on Drift perps.
 */
export async function placeDriftMarketOrder(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number,
  direction: "long" | "short",
  oraclePrice: number
): Promise<string> {
  const baseAssetAmount = new BN(
    Math.floor((sizeUsd / oraclePrice) * BASE_PRECISION.toNumber())
  );

  const orderParams: OrderParams = {
    orderType: OrderType.MARKET,
    marketIndex,
    direction:
      direction === "long"
        ? PositionDirection.LONG
        : PositionDirection.SHORT,
    baseAssetAmount,
    marketType: { perp: {} } as any,
  };

  const sig = await driftClient.placePerpOrder(orderParams);
  return sig;
}

/**
 * Place a limit order on Drift perps (maker, for rebates).
 */
export async function placeDriftLimitOrder(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number,
  direction: "long" | "short",
  limitPrice: number
): Promise<string> {
  const baseAssetAmount = new BN(
    Math.floor((sizeUsd / limitPrice) * BASE_PRECISION.toNumber())
  );

  const orderParams: OrderParams = {
    orderType: OrderType.LIMIT,
    marketIndex,
    direction:
      direction === "long"
        ? PositionDirection.LONG
        : PositionDirection.SHORT,
    baseAssetAmount,
    price: new BN(Math.floor(limitPrice * PRICE_PRECISION.toNumber())),
    postOnly: true,
    marketType: { perp: {} } as any,
  };

  const sig = await driftClient.placePerpOrder(orderParams);
  return sig;
}

/**
 * Place a trigger order (take-profit or stop-loss) on Drift.
 */
export async function placeDriftTriggerOrder(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number,
  direction: "long" | "short",
  triggerPrice: number,
  triggerCondition: "above" | "below"
): Promise<string> {
  const baseAssetAmount = new BN(
    Math.floor((sizeUsd / triggerPrice) * BASE_PRECISION.toNumber())
  );

  const orderParams: OrderParams = {
    orderType: OrderType.TRIGGER_MARKET,
    marketIndex,
    direction:
      direction === "long"
        ? PositionDirection.LONG
        : PositionDirection.SHORT,
    baseAssetAmount,
    triggerPrice: new BN(
      Math.floor(triggerPrice * PRICE_PRECISION.toNumber())
    ),
    triggerCondition:
      triggerCondition === "above"
        ? { above: {} } as any
        : { below: {} } as any,
    marketType: { perp: {} } as any,
  };

  const sig = await driftClient.placePerpOrder(orderParams);
  return sig;
}

/**
 * Close all Drift perp positions.
 */
export async function closeAllDriftPositions(
  driftClient: DriftClient
): Promise<string[]> {
  const user = driftClient.getUser();
  const positions = user.getPerpPositions();
  const sigs: string[] = [];

  for (const pos of positions) {
    if (pos.baseAssetAmount.isZero()) continue;

    const direction = pos.baseAssetAmount.isNeg()
      ? PositionDirection.LONG  // Close short by going long
      : PositionDirection.SHORT; // Close long by going short

    const orderParams: OrderParams = {
      orderType: OrderType.MARKET,
      marketIndex: pos.marketIndex,
      direction,
      baseAssetAmount: pos.baseAssetAmount.abs(),
      reduceOnly: true,
      marketType: { perp: {} } as any,
    };

    const sig = await driftClient.placePerpOrder(orderParams);
    sigs.push(sig);
  }

  return sigs;
}

/**
 * Get current perp positions summary.
 */
export function getDriftPositionsSummary(
  driftClient: DriftClient
): Array<{
  marketIndex: number;
  direction: "long" | "short";
  sizeBase: number;
  entryPrice: number;
  unrealizedPnl: number;
}> {
  const user = driftClient.getUser();
  const positions = user.getPerpPositions();
  const results = [];

  for (const pos of positions) {
    if (pos.baseAssetAmount.isZero()) continue;

    results.push({
      marketIndex: pos.marketIndex,
      direction: pos.baseAssetAmount.isNeg() ? "short" as const : "long" as const,
      sizeBase: Math.abs(pos.baseAssetAmount.toNumber()) / BASE_PRECISION.toNumber(),
      entryPrice: pos.quoteEntryAmount.abs().toNumber() /
        (pos.baseAssetAmount.abs().toNumber() || 1) *
        (BASE_PRECISION.toNumber() / PRICE_PRECISION.toNumber()),
      unrealizedPnl: user.getUnrealizedPNL(true, pos.marketIndex).toNumber() / 1e6,
    });
  }

  return results;
}

// --- Common Helpers ---

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Keypair, Connection, PublicKey } from "@solana/web3.js";
export { DriftClient } from "@drift-labs/sdk";
