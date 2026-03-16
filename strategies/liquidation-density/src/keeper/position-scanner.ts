/**
 * Position Scanner — Reads real leveraged positions from Kamino and Marginfi.
 *
 * Uses on-chain data via:
 * - @overlay/kamino-client: batchGetAllObligationsForMarket (streaming GPA)
 * - @overlay/marginfi-client: getAllMarginfiAccountAddresses + batch hydrate
 *
 * Computes liquidation prices using Tensor margin math pattern.
 */

import { LeveragedPosition } from "./heatmap-builder";
import { STRATEGY_CONFIG } from "../config/vault";
import { KaminoClient, KaminoPosition } from "@overlay/kamino-client";
import { MarginfiClientWrapper, MarginfiPosition } from "@overlay/marginfi-client";

// --- Liquidation Price Math (Tensor margin math pattern) ---

/**
 * Compute liquidation price for a collateralized borrow.
 *
 * Liquidation triggers when:
 *   collateralValue × liquidationThreshold < debtValue
 *   collateralAmount × price × liqThreshold < debtUsd
 *   price < debtUsd / (collateralAmount × liqThreshold)
 */
export function computeLiquidationPrice(
  collateralAmount: number,
  debtUsd: number,
  liquidationThreshold: number // e.g., 0.85
): number {
  if (collateralAmount <= 0 || liquidationThreshold <= 0) return 0;
  return debtUsd / (collateralAmount * liquidationThreshold);
}

// --- Kamino Scanner ---

export async function scanKaminoPositions(
  kaminoClient: KaminoClient,
  asset: string,
  currentPrice: number,
  minPositionUsd: number = STRATEGY_CONFIG.minPositionSizeUsd,
  maxPositions: number = STRATEGY_CONFIG.maxPositionsPerProtocol
): Promise<LeveragedPosition[]> {
  console.log("  [kamino] Scanning on-chain obligations...");

  const obligations = await kaminoClient.getAllPositions(minPositionUsd, maxPositions);

  const positions: LeveragedPosition[] = [];

  for (const obl of obligations) {
    // Find SOL-denominated collateral
    const collateral = obl.reserves.find(
      (r) => r.depositedValueUsd > 0 && isSolAsset(r.symbol, r.mint)
    );
    if (!collateral) continue;

    // Compute liquidation price from on-chain LTV data
    const collateralAmountInSol = collateral.depositedValueUsd / currentPrice;
    const liquidationPrice = computeLiquidationPrice(
      collateralAmountInSol,
      obl.totalBorrowedUsd,
      obl.liquidationLtv / 100
    );

    if (liquidationPrice <= 0 || liquidationPrice > currentPrice * 2) continue;

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
    `  [kamino] Result: ${obligations.length} obligations scanned, ` +
    `${positions.length} with ${asset} collateral`
  );

  return positions;
}

// --- Marginfi Scanner ---

export async function scanMarginfiPositions(
  marginfiClient: MarginfiClientWrapper,
  asset: string,
  currentPrice: number,
  minPositionUsd: number = STRATEGY_CONFIG.minPositionSizeUsd,
  maxPositions: number = STRATEGY_CONFIG.maxPositionsPerProtocol
): Promise<LeveragedPosition[]> {
  console.log("  [marginfi] Scanning on-chain accounts...");

  const accounts = await marginfiClient.getAllPositions(
    minPositionUsd,
    10000, // Scan up to 10K addresses
    maxPositions
  );

  const positions: LeveragedPosition[] = [];

  for (const acct of accounts) {
    // Find SOL-denominated collateral
    const collateral = acct.balances.find(
      (b) => b.assetValueUsd > 0 && isSolAsset(b.symbol, b.mint)
    );
    if (!collateral) continue;

    // Compute liquidation price
    // Marginfi maintenance weight ~0.80 for SOL
    const collateralAmountInSol = collateral.assetValueUsd / currentPrice;
    const liquidationPrice = computeLiquidationPrice(
      collateralAmountInSol,
      acct.totalLiabilitiesUsd,
      0.80 // Marginfi SOL maintenance weight
    );

    if (liquidationPrice <= 0 || liquidationPrice > currentPrice * 2) continue;

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
    `  [marginfi] Result: ${accounts.length} accounts scanned, ` +
    `${positions.length} with ${asset} collateral`
  );

  return positions;
}

// --- Helpers ---

function isSolAsset(symbol: string, mint: string): boolean {
  const solSymbols = ["SOL", "JitoSOL", "mSOL", "bSOL", "jitoSOL", "JITOSOL"];
  if (solSymbols.some((s) => symbol.includes(s))) return true;
  // Known SOL-related mints
  const solMints = [
    "So11111111111111111111111111111111111111112",   // wSOL
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
    "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",  // bSOL
  ];
  return solMints.some((m) => mint.startsWith(m.slice(0, 10)));
}

// --- Unified Scanner ---

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
          if (!kaminoClient) {
            console.warn("  [kamino] Client not initialized — skipping");
            continue;
          }
          positions = await scanKaminoPositions(kaminoClient, asset, currentPrice);
          break;
        case "marginfi":
          if (!marginfiClient) {
            console.warn("  [marginfi] Client not initialized — skipping");
            continue;
          }
          positions = await scanMarginfiPositions(marginfiClient, asset, currentPrice);
          break;
        default:
          continue;
      }

      allPositions.push(...positions);
    } catch (err) {
      console.error(`  [${protocol}] Scan failed:`, err);
    }
  }

  // Sort by position size descending and cap total
  return allPositions
    .sort((a, b) => b.positionSizeUsd - a.positionSizeUsd)
    .slice(0, STRATEGY_CONFIG.maxPositionsPerProtocol * STRATEGY_CONFIG.protocols.length);
}
