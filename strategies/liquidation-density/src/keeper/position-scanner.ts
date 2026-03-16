/**
 * Position Scanner — Reads leveraged positions from Kamino and Marginfi.
 *
 * Composed from:
 * - Liquidation price math: Tensor margin math pattern
 * - Protocol clients: @overlay/kamino-client, @overlay/marginfi-client
 *
 * Scans on-chain accounts, computes liquidation prices, feeds to heatmap builder.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { LeveragedPosition } from "./heatmap-builder";
import { STRATEGY_CONFIG } from "../config/vault";
import {
  KaminoClient,
  KaminoPosition,
} from "@overlay/kamino-client";
import {
  MarginfiClientWrapper,
  MarginfiPosition,
} from "@overlay/marginfi-client";

// --- Liquidation Price Math (from Tensor margin math pattern) ---

/**
 * Compute liquidation price for a Kamino position.
 * Liquidation triggers when: collateralValue × liquidationThreshold < debtValue
 * → price < debtUsd / (collateralAmount × liquidationThreshold)
 */
export function computeKaminoLiquidationPrice(
  collateralAmount: number,
  debtUsd: number,
  liquidationThreshold: number
): number {
  if (collateralAmount <= 0 || liquidationThreshold <= 0) return 0;
  return debtUsd / (collateralAmount * liquidationThreshold);
}

/**
 * Compute liquidation price for a Marginfi position.
 */
export function computeMarginfiLiquidationPrice(
  collateralAmount: number,
  debtUsd: number,
  maintenanceLtvRatio: number
): number {
  if (collateralAmount <= 0 || maintenanceLtvRatio <= 0) return 0;
  return debtUsd / (collateralAmount * maintenanceLtvRatio);
}

// --- Kamino Scanner ---

/**
 * Scan Kamino for leveraged positions and compute liquidation prices.
 */
export async function scanKaminoPositions(
  kaminoClient: KaminoClient,
  asset: string,
  currentPrice: number
): Promise<LeveragedPosition[]> {
  console.log("  [kamino] Scanning positions...");

  const obligations = await kaminoClient.getAllPositions();

  const positions: LeveragedPosition[] = [];

  for (const obl of obligations) {
    if (obl.totalBorrowedUsd < STRATEGY_CONFIG.minPositionSizeUsd) continue;

    // Find the primary collateral (SOL-denominated asset)
    const collateral = obl.reserves.find(
      (r) =>
        r.depositedValueUsd > 0 &&
        (r.symbol.includes("SOL") || r.symbol.includes("Jito"))
    );
    if (!collateral) continue;

    // Compute liquidation price
    const liquidationPrice = computeKaminoLiquidationPrice(
      collateral.depositedAmount,
      obl.totalBorrowedUsd,
      obl.liquidationLtv / 100 // Convert from % to ratio
    );

    if (liquidationPrice <= 0) continue;

    positions.push({
      protocol: "kamino",
      owner: obl.owner,
      asset,
      collateralUsd: obl.totalDepositedUsd,
      debtUsd: obl.totalBorrowedUsd,
      ltv: obl.currentLtv,
      liquidationPrice,
      positionSizeUsd: obl.totalDepositedUsd,
    });
  }

  console.log(
    `  [kamino] Found ${obligations.length} obligations, ` +
    `${positions.length} with ${asset} collateral above $${STRATEGY_CONFIG.minPositionSizeUsd}`
  );

  return positions;
}

// --- Marginfi Scanner ---

/**
 * Scan Marginfi for leveraged positions and compute liquidation prices.
 */
export async function scanMarginfiPositions(
  marginfiClient: MarginfiClientWrapper,
  asset: string,
  currentPrice: number
): Promise<LeveragedPosition[]> {
  console.log("  [marginfi] Scanning positions...");

  const accounts = await marginfiClient.getAllPositions(
    STRATEGY_CONFIG.maxPositionsPerProtocol
  );

  const positions: LeveragedPosition[] = [];

  for (const acct of accounts) {
    if (acct.totalLiabilitiesUsd < STRATEGY_CONFIG.minPositionSizeUsd) continue;

    // Find SOL-denominated collateral
    const collateral = acct.balances.find(
      (b) =>
        b.assetValueUsd > 0 &&
        (b.symbol.includes("SOL") || b.symbol.includes("Jito"))
    );
    if (!collateral) continue;

    // Use marginfi's built-in liquidation price if available
    // Otherwise estimate from position data
    const estimatedCollateralAmount = collateral.assetValueUsd / currentPrice;
    const liquidationPrice = computeMarginfiLiquidationPrice(
      estimatedCollateralAmount,
      acct.totalLiabilitiesUsd,
      0.80 // Marginfi maintenance LTV ~80%
    );

    if (liquidationPrice <= 0) continue;

    positions.push({
      protocol: "marginfi",
      owner: acct.owner,
      asset,
      collateralUsd: acct.totalAssetsUsd,
      debtUsd: acct.totalLiabilitiesUsd,
      ltv: acct.totalAssetsUsd > 0
        ? (acct.totalLiabilitiesUsd / acct.totalAssetsUsd) * 100
        : 0,
      liquidationPrice,
      positionSizeUsd: acct.totalAssetsUsd,
    });
  }

  console.log(
    `  [marginfi] Found ${accounts.length} accounts, ` +
    `${positions.length} with ${asset} collateral above $${STRATEGY_CONFIG.minPositionSizeUsd}`
  );

  return positions;
}

// --- Unified Scanner ---

/**
 * Scan all configured protocols and merge results.
 */
export async function scanAllPositions(
  kaminoClient: KaminoClient | null,
  marginfiClient: MarginfiClientWrapper | null,
  asset: string,
  currentPrice: number
): Promise<LeveragedPosition[]> {
  const allPositions: LeveragedPosition[] = [];

  for (const protocol of STRATEGY_CONFIG.protocols) {
    try {
      let positions: LeveragedPosition[];

      switch (protocol) {
        case "kamino":
          if (!kaminoClient) { console.warn("  [kamino] Client not initialized"); continue; }
          positions = await scanKaminoPositions(kaminoClient, asset, currentPrice);
          break;
        case "marginfi":
          if (!marginfiClient) { console.warn("  [marginfi] Client not initialized"); continue; }
          positions = await scanMarginfiPositions(marginfiClient, asset, currentPrice);
          break;
        default:
          console.warn(`  Unknown protocol: ${protocol}`);
          continue;
      }

      // Cap per protocol
      const capped = positions
        .sort((a, b) => b.positionSizeUsd - a.positionSizeUsd)
        .slice(0, STRATEGY_CONFIG.maxPositionsPerProtocol);

      allPositions.push(...capped);
    } catch (err) {
      console.error(`  [${protocol}] Scan failed:`, err);
    }
  }

  return allPositions;
}
