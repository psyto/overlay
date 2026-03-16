/**
 * Marginfi Client — Wrapper for Marginfi lending operations.
 *
 * Uses @mrgnlabs/marginfi-client-v2 + @mrgnlabs/mrgn-common.
 *
 * Provides:
 * - Position reading (collateral, debt, health)
 * - Leveraged position scanning (for liquidation density strategy)
 * - Rate monitoring (supply APY, borrow APY)
 * - Liquidation execution
 *
 * Used by:
 * - liquidation-density: position scanning + liquidation price computation
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  MarginfiClient,
  getConfig,
  MarginRequirementType,
} from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";

// --- Constants ---

const MARGINFI_PROGRAM_ID = new PublicKey(
  "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
);
const MARGINFI_GROUP = new PublicKey(
  "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"
);

// Liquidation discount (5%)
const LIQUIDATION_DISCOUNT = 0.95;

// --- Types ---

export interface MarginfiPosition {
  address: string;
  owner: string;
  balances: Array<{
    bankAddress: string;
    mint: string;
    symbol: string;
    assetValueUsd: number;
    liabilityValueUsd: number;
  }>;
  totalAssetsUsd: number;
  totalLiabilitiesUsd: number;
  maintenanceHealth: number; // positive = healthy, negative = liquidatable
  healthFactor: number;      // assets / liabilities ratio
  isLiquidatable: boolean;
}

export interface MarginfiRates {
  bankAddress: string;
  symbol: string;
  lendingApy: number;
  borrowingApy: number;
  utilization: number;
}

export interface LiquidationOpportunity {
  account: string;
  owner: string;
  assetBank: string;
  liabilityBank: string;
  maxLiquidatableUsd: number;
  estimatedProfitUsd: number;
}

// --- Client ---

export class MarginfiClientWrapper {
  private client: MarginfiClient | null = null;
  private connection: Connection;
  private wallet: NodeWallet;

  constructor(connection: Connection, wallet: NodeWallet) {
    this.connection = connection;
    this.wallet = wallet;
  }

  /**
   * Initialize the underlying MarginfiClient.
   */
  async init(): Promise<void> {
    if (this.client) return;

    const config = getConfig("production");
    this.client = await MarginfiClient.fetch(
      config,
      this.wallet,
      this.connection
    );
  }

  private getClient(): MarginfiClient {
    if (!this.client) {
      throw new Error("MarginfiClient not initialized — call init() first");
    }
    return this.client;
  }

  // --- Position Reading ---

  /**
   * Get positions for a specific wallet.
   */
  async getPosition(owner: string): Promise<MarginfiPosition[]> {
    const client = this.getClient();
    const ownerPk = new PublicKey(owner);

    const accounts = await client.getMarginfiAccountsForAuthority(ownerPk);
    if (accounts.length === 0) return [];

    return accounts.map((acct) => this.parseAccount(acct));
  }

  /**
   * Parse a MarginfiAccountWrapper into our normalized format.
   */
  private parseAccount(acct: any): MarginfiPosition {
    const client = this.getClient();
    const pure = acct.pureAccount;

    const balances: MarginfiPosition["balances"] = [];

    for (const balance of pure.activeBalances ?? []) {
      if (!balance.active) continue;

      const bank = client.getBankByPk(balance.bankPk);
      if (!bank) continue;

      const oraclePrice = client.getOraclePriceByBank(balance.bankPk);
      const usdValue = balance.computeUsdValue(bank, oraclePrice);

      balances.push({
        bankAddress: balance.bankPk.toBase58(),
        mint: bank.mint.toBase58(),
        symbol: bank.tokenSymbol ?? bank.mint.toBase58().slice(0, 6),
        assetValueUsd: usdValue?.assets?.toNumber() ?? 0,
        liabilityValueUsd: usdValue?.liabilities?.toNumber() ?? 0,
      });
    }

    const totalAssetsUsd = balances.reduce((s, b) => s + b.assetValueUsd, 0);
    const totalLiabilitiesUsd = balances.reduce(
      (s, b) => s + b.liabilityValueUsd,
      0
    );

    // Maintenance health
    let maintenanceHealth = 0;
    let isLiquidatable = false;
    try {
      const { assets, liabilities } = pure.computeHealthComponents(
        MarginRequirementType.Maintenance
      );
      maintenanceHealth = assets.minus(liabilities).toNumber();
      isLiquidatable = maintenanceHealth < 0;
    } catch {
      // Health computation may fail for empty accounts
    }

    const healthFactor =
      totalLiabilitiesUsd > 0 ? totalAssetsUsd / totalLiabilitiesUsd : Infinity;

    return {
      address: acct.address.toBase58(),
      owner: pure.authority?.toBase58() ?? "",
      balances,
      totalAssetsUsd,
      totalLiabilitiesUsd,
      maintenanceHealth,
      healthFactor,
      isLiquidatable,
    };
  }

  // --- Bulk Scanning ---

  /**
   * Scan all marginfi accounts for the liquidation density strategy.
   *
   * Strategy: fetch all pubkeys (lightweight GPA), then batch-hydrate in chunks.
   * Filters for accounts with meaningful positions (>$minAssetsUsd).
   *
   * @param minAssetsUsd - Minimum total assets to include
   * @param maxAccounts - Stop scanning after this many addresses checked
   * @param maxPositions - Stop collecting after this many qualifying positions
   */
  async getAllPositions(
    minAssetsUsd: number = 1000,
    maxAccounts: number = 10000,
    maxPositions: number = 500
  ): Promise<MarginfiPosition[]> {
    const client = this.getClient();

    // Step 1: Get all account pubkeys (zero-length dataSlice — very fast)
    console.log("  [marginfi] Fetching account addresses...");
    const allAddresses = await client.getAllMarginfiAccountAddresses();
    console.log(`  [marginfi] Total accounts on-chain: ${allAddresses.length}`);

    // Step 2: Batch-fetch and parse in chunks of 100
    const positions: MarginfiPosition[] = [];
    const chunkSize = 100;
    const scanLimit = Math.min(allAddresses.length, maxAccounts);
    let scanned = 0;
    let errors = 0;

    for (let i = 0; i < scanLimit; i += chunkSize) {
      if (positions.length >= maxPositions) break;

      const chunk = allAddresses.slice(i, i + chunkSize);

      try {
        const accounts = await client.getMultipleMarginfiAccounts(chunk);
        scanned += chunk.length;

        for (const acct of accounts) {
          if (positions.length >= maxPositions) break;

          try {
            const pos = this.parseAccount(acct);

            // Filter: must have meaningful assets AND liabilities (leveraged)
            if (pos.totalAssetsUsd < minAssetsUsd) continue;
            if (pos.totalLiabilitiesUsd < 100) continue; // Skip lending-only

            positions.push(pos);
          } catch {
            // Skip individual unparseable accounts
          }
        }
      } catch (err) {
        errors++;
        if (errors > 10) {
          console.error(`  [marginfi] Too many errors (${errors}), stopping scan`);
          break;
        }
      }

      // Progress every 20 chunks
      if ((i / chunkSize) % 20 === 0 && i > 0) {
        console.log(
          `  [marginfi] Scanned ${scanned}/${scanLimit} accounts, ` +
          `${positions.length} qualifying positions`
        );
      }
    }

    console.log(
      `  [marginfi] Scan complete: ${scanned} checked, ` +
      `${positions.length} positions (${errors} errors)`
    );

    return positions;
  }

  /**
   * Compute liquidation prices for all positions in a batch.
   * Returns positions enriched with per-bank liquidation prices.
   */
  async enrichWithLiquidationPrices(
    positions: MarginfiPosition[]
  ): Promise<Array<MarginfiPosition & { liquidationPrices: Record<string, number | null> }>> {
    const client = this.getClient();
    const enriched = [];

    for (const pos of positions) {
      const liqPrices: Record<string, number | null> = {};

      for (const bal of pos.balances) {
        if (bal.assetValueUsd > 0 || bal.liabilityValueUsd > 0) {
          try {
            // Fetch the account wrapper to access computeLiquidationPriceForBank
            const bankPk = new PublicKey(bal.bankAddress);
            const acctPk = new PublicKey(pos.address);

            // Use the client to get the wrapper
            const accounts = await client.getMultipleMarginfiAccounts([acctPk]);
            if (accounts.length > 0) {
              const price = accounts[0].computeLiquidationPriceForBank(bankPk);
              liqPrices[bal.bankAddress] = price;
            }
          } catch {
            liqPrices[bal.bankAddress] = null;
          }
        }
      }

      enriched.push({ ...pos, liquidationPrices: liqPrices });
    }

    return enriched;
  }

  /**
   * Find liquidatable accounts.
   */
  async findLiquidatable(maxAccounts: number = 1000): Promise<MarginfiPosition[]> {
    const positions = await this.getAllPositions(maxAccounts);
    return positions.filter((p) => p.isLiquidatable);
  }

  // --- Liquidation Price Computation ---

  /**
   * Compute the liquidation price for a specific bank position.
   * Uses marginfi SDK's built-in computation.
   */
  async computeLiquidationPrice(
    accountAddress: string,
    bankAddress: string
  ): Promise<number | null> {
    const client = this.getClient();
    const acctPk = new PublicKey(accountAddress);
    const bankPk = new PublicKey(bankAddress);

    // Fetch the specific account
    const accounts = await client.getMarginfiAccountsForAuthority(acctPk);
    if (accounts.length === 0) return null;

    const pure = accounts[0].pureAccount;

    try {
      return pure.computeLiquidationPriceForBank(
        client.banks,
        client.oraclePrices,
        bankPk
      );
    } catch {
      return null;
    }
  }

  // --- Rate Monitoring ---

  /**
   * Get lending/borrowing rates for a bank by token symbol.
   */
  async getRates(tokenSymbol: string): Promise<MarginfiRates | null> {
    const client = this.getClient();
    const bank = client.getBankByTokenSymbol(tokenSymbol);
    if (!bank) return null;

    return {
      bankAddress: bank.address.toBase58(),
      symbol: tokenSymbol,
      lendingApy: bank.computeInterestRates().lendingRate.toNumber(),
      borrowingApy: bank.computeInterestRates().borrowingRate.toNumber(),
      utilization: bank.computeUtilizationRate().toNumber(),
    };
  }

  /**
   * Get all bank rates for comparison.
   */
  async getAllRates(): Promise<MarginfiRates[]> {
    const client = this.getClient();
    const rates: MarginfiRates[] = [];

    for (const [, bank] of client.banks) {
      try {
        const interestRates = bank.computeInterestRates();
        rates.push({
          bankAddress: bank.address.toBase58(),
          symbol: bank.tokenSymbol ?? bank.mint.toBase58().slice(0, 6),
          lendingApy: interestRates.lendingRate.toNumber(),
          borrowingApy: interestRates.borrowingRate.toNumber(),
          utilization: bank.computeUtilizationRate().toNumber(),
        });
      } catch {
        // Skip banks with computation errors
      }
    }

    return rates;
  }

  // --- Liquidation Execution ---

  /**
   * Find liquidation opportunities with estimated profit.
   */
  async findLiquidationOpportunities(
    maxAccounts: number = 500
  ): Promise<LiquidationOpportunity[]> {
    const client = this.getClient();
    const liquidatable = await this.findLiquidatable(maxAccounts);
    const opportunities: LiquidationOpportunity[] = [];

    for (const pos of liquidatable) {
      const assetBanks = pos.balances.filter((b) => b.assetValueUsd > 0);
      const liabBanks = pos.balances.filter((b) => b.liabilityValueUsd > 0);

      for (const asset of assetBanks) {
        for (const liab of liabBanks) {
          // Simplified profit estimate: 5% liquidation discount on seized collateral
          const maxLiquidatableUsd = Math.min(
            asset.assetValueUsd,
            liab.liabilityValueUsd
          );
          const estimatedProfitUsd = maxLiquidatableUsd * (1 - LIQUIDATION_DISCOUNT);

          if (estimatedProfitUsd < 1) continue; // Skip dust

          opportunities.push({
            account: pos.address,
            owner: pos.owner,
            assetBank: asset.bankAddress,
            liabilityBank: liab.bankAddress,
            maxLiquidatableUsd,
            estimatedProfitUsd,
          });
        }
      }
    }

    // Sort by profit descending
    return opportunities.sort(
      (a, b) => b.estimatedProfitUsd - a.estimatedProfitUsd
    );
  }

  /**
   * Execute a liquidation.
   *
   * The liquidator must have a marginfi account with deposits to receive
   * the seized collateral.
   */
  async executeLiquidation(
    liquidateeAccountAddress: string,
    assetBankAddress: string,
    liabilityBankAddress: string,
    amountUsd: number
  ): Promise<string> {
    const client = this.getClient();

    // Get liquidator's account
    const liquidatorAccounts = await client.getMarginfiAccountsForAuthority();
    if (liquidatorAccounts.length === 0) {
      throw new Error("Liquidator has no marginfi account");
    }

    const liquidatorAccount = liquidatorAccounts[0].pureAccount;

    // Fetch liquidatee account
    const liquidateePk = new PublicKey(liquidateeAccountAddress);
    // Need to load the target account
    const allAccounts = await client.getMarginfiAccountsForAuthority(liquidateePk);
    if (allAccounts.length === 0) {
      throw new Error(`Liquidatee account not found: ${liquidateeAccountAddress}`);
    }

    const liquidateeAccount = allAccounts[0].pureAccount;
    const assetBankPk = new PublicKey(assetBankAddress);
    const liabBankPk = new PublicKey(liabilityBankAddress);

    // Build liquidation instruction
    const { instructions, keys } =
      await liquidatorAccount.makeLendingAccountLiquidateIx(
        liquidateeAccount,
        client.program,
        client.banks,
        client.mintDatas,
        client.bankMetadataMap,
        assetBankPk,
        amountUsd,
        liabBankPk
      );

    // Send transaction
    const tx = await client.processTransaction(instructions, keys);
    return tx;
  }
}

// --- Factory ---

export function createMarginfiClient(
  connection: Connection,
  wallet: NodeWallet
): MarginfiClientWrapper {
  return new MarginfiClientWrapper(connection, wallet);
}

export { MARGINFI_PROGRAM_ID, MARGINFI_GROUP };
