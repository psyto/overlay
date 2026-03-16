/**
 * Kamino Lend Client — Wrapper for Kamino lending operations.
 *
 * Uses @kamino-finance/klend-sdk (v7.x) with @solana/kit (web3.js v2).
 *
 * Provides:
 * - JitoSOL loop management (deposit → borrow → mint → repeat)
 * - Position reading (collateral, debt, LTV, health)
 * - Leveraged position scanning (for liquidation density strategy)
 * - Rate monitoring (supply APY, borrow APY, utilization)
 *
 * Used by:
 * - regime-leverage: loop management + health monitoring
 * - liquidation-density: position scanning + liquidation price computation
 */

import {
  KaminoMarket,
  KaminoAction,
  VanillaObligation,
  PROGRAM_ID,
  getFlashLoanInstructions,
} from "@kamino-finance/klend-sdk";
import {
  createSolanaRpc,
  address,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  createSolanaRpcSubscriptions,
  type TransactionSigner,
  type Address,
  type Rpc,
  type RpcSubscriptions,
} from "@solana/kit";
import BN from "bn.js";

// --- Constants ---

// Kamino markets
const JITO_MARKET = address("H6rHXmXoCQvq8Ue81MqNh7ow5ysPa1dSozwW3PU1dDH6");
const MAIN_MARKET = address("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

// Token mints
const JITOSOL_MINT = address("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const SOL_MINT = address("So11111111111111111111111111111111111111112");

const DEFAULT_PRIORITY_FEE = 1_000_000; // microlamports
const SLOT_DURATION_MS = 400;

// --- Types ---

export interface KaminoPosition {
  owner: string;
  reserves: Array<{
    mint: string;
    symbol: string;
    depositedAmount: number;
    depositedValueUsd: number;
    borrowedAmount: number;
    borrowedValueUsd: number;
  }>;
  totalDepositedUsd: number;
  totalBorrowedUsd: number;
  currentLtv: number;
  liquidationLtv: number;
  healthFactor: number;
}

export interface KaminoRates {
  reserve: string;
  supplyApy: number;
  borrowApy: number;
  utilization: number;
}

export interface LoopParams {
  initialAmount: BN;       // JitoSOL amount in lamports
  targetLeverage: number;  // e.g., 3.0 for 3x
  maxLtvPct: number;       // Safety cap, e.g., 80
}

// --- Client ---

export class KaminoClient {
  private rpc: Rpc<any>;
  private rpcSubscriptions: RpcSubscriptions<any>;
  private signer: TransactionSigner;
  private market: KaminoMarket | null = null;
  private marketAddress: Address;

  constructor(
    rpcUrl: string,
    wsUrl: string,
    signer: TransactionSigner,
    marketAddress: Address = JITO_MARKET
  ) {
    this.rpc = createSolanaRpc(rpcUrl);
    this.rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    this.signer = signer;
    this.marketAddress = marketAddress;
  }

  /**
   * Load and cache the Kamino market.
   */
  async loadMarket(): Promise<KaminoMarket> {
    if (!this.market) {
      this.market = await KaminoMarket.load(
        this.rpc,
        this.marketAddress,
        SLOT_DURATION_MS
      );
      if (!this.market) {
        throw new Error(`Failed to load Kamino market: ${this.marketAddress}`);
      }
    }
    await this.market.loadReserves();
    return this.market;
  }

  /**
   * Send a KaminoAction transaction (setup + lending + cleanup).
   */
  private async sendAction(action: KaminoAction): Promise<string> {
    const instructions = [
      ...action.setupIxs,
      ...action.lendingIxs,
      ...action.cleanupIxs,
    ];

    const { value: blockhash } = await this.rpc
      .getLatestBlockhash({ commitment: "finalized" })
      .send();

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(this.signer, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(blockhash, tx),
      (tx) => appendTransactionMessageInstructions(instructions, tx)
    );

    const signed = await signTransactionMessageWithSigners(tx);
    const sig = getSignatureFromTransaction(signed);

    await sendAndConfirmTransactionFactory({
      rpc: this.rpc,
      rpcSubscriptions: this.rpcSubscriptions,
    })(signed, {
      commitment: "confirmed",
      skipPreflight: true,
    });

    return sig;
  }

  // --- Position Reading ---

  /**
   * Get a user's obligation (position) from the loaded market.
   */
  async getPosition(owner: string): Promise<KaminoPosition | null> {
    const market = await this.loadMarket();
    const ownerAddr = address(owner);

    const obligation = await market.getObligationByWallet(
      ownerAddr,
      new VanillaObligation(PROGRAM_ID)
    );

    if (!obligation) return null;

    const reserves: KaminoPosition["reserves"] = [];

    for (const [mintAddr, depositInfo] of obligation.deposits.entries()) {
      const reserve = market.getReserveByMint(mintAddr);
      const symbol = reserve?.symbol ?? mintAddr.toString().slice(0, 6);
      reserves.push({
        mint: mintAddr.toString(),
        symbol,
        depositedAmount: depositInfo.amount ?? 0,
        depositedValueUsd: depositInfo.marketValueRefreshed ?? 0,
        borrowedAmount: 0,
        borrowedValueUsd: 0,
      });
    }

    for (const [mintAddr, borrowInfo] of obligation.borrows.entries()) {
      const existing = reserves.find((r) => r.mint === mintAddr.toString());
      if (existing) {
        existing.borrowedAmount = borrowInfo.amount ?? 0;
        existing.borrowedValueUsd = borrowInfo.marketValueRefreshed ?? 0;
      } else {
        const reserve = market.getReserveByMint(mintAddr);
        reserves.push({
          mint: mintAddr.toString(),
          symbol: reserve?.symbol ?? mintAddr.toString().slice(0, 6),
          depositedAmount: 0,
          depositedValueUsd: 0,
          borrowedAmount: borrowInfo.amount ?? 0,
          borrowedValueUsd: borrowInfo.marketValueRefreshed ?? 0,
        });
      }
    }

    const totalDepositedUsd = reserves.reduce(
      (s, r) => s + r.depositedValueUsd,
      0
    );
    const totalBorrowedUsd = reserves.reduce(
      (s, r) => s + r.borrowedValueUsd,
      0
    );
    const currentLtv =
      totalDepositedUsd > 0 ? (totalBorrowedUsd / totalDepositedUsd) * 100 : 0;

    const borrowLimit = obligation.stats?.borrowLimit ?? 0;
    const healthFactor =
      totalBorrowedUsd > 0 ? borrowLimit / totalBorrowedUsd : Infinity;

    return {
      owner,
      reserves,
      totalDepositedUsd,
      totalBorrowedUsd,
      currentLtv,
      liquidationLtv: 90, // Jito market eMode default
      healthFactor,
    };
  }

  /**
   * Scan all obligations on the market using on-chain data.
   * Uses batchGetAllObligationsForMarket for memory-efficient streaming.
   *
   * @param tag - Obligation type: 0=Vanilla, 1=Multiply, 3=Leverage. Default: all leveraged (1+3).
   * @param minBorrowUsd - Minimum borrow value to include (filters dust).
   * @param maxPositions - Stop after collecting this many positions.
   */
  async getAllPositions(
    minBorrowUsd: number = 1000,
    maxPositions: number = 500
  ): Promise<KaminoPosition[]> {
    const market = await this.loadMarket();
    const positions: KaminoPosition[] = [];

    // Scan both Multiply (tag=1) and Leverage (tag=3) positions
    for (const tag of [1, 3]) {
      if (positions.length >= maxPositions) break;

      console.log(`  [kamino] Scanning tag=${tag} obligations...`);
      let batchCount = 0;

      try {
        const generator = market.batchGetAllObligationsForMarket(tag);

        for await (const batch of generator) {
          batchCount++;

          for (const obligation of batch) {
            if (positions.length >= maxPositions) break;

            // Parse obligation into our format
            const parsed = this.parseObligation(obligation, market);
            if (!parsed) continue;

            // Filter by minimum borrow size
            if (parsed.totalBorrowedUsd < minBorrowUsd) continue;

            positions.push(parsed);
          }

          if (positions.length >= maxPositions) break;

          // Progress log every 10 batches
          if (batchCount % 10 === 0) {
            console.log(
              `  [kamino] Processed ${batchCount} batches, ${positions.length} positions so far`
            );
          }
        }
      } catch (err) {
        console.error(`  [kamino] Error scanning tag=${tag}:`, err);
      }

      console.log(
        `  [kamino] Tag=${tag}: ${batchCount} batches, ${positions.length} total positions`
      );
    }

    return positions;
  }

  /**
   * Parse a KaminoObligation into our normalized format.
   */
  private parseObligation(
    obligation: any,
    market: KaminoMarket
  ): KaminoPosition | null {
    try {
      const deposits = obligation.getDeposits?.() ?? [];
      const borrows = obligation.getBorrows?.() ?? [];

      if (deposits.length === 0 && borrows.length === 0) return null;

      const reserves: KaminoPosition["reserves"] = [];

      for (const dep of deposits) {
        const reserve = dep.reserveAddress
          ? market.getReserveByAddress?.(dep.reserveAddress)
          : null;
        reserves.push({
          mint: dep.mintAddress?.toString() ?? reserve?.getLiquidityMint?.()?.toString() ?? "unknown",
          symbol: reserve?.symbol ?? "?",
          depositedAmount: dep.amount?.toNumber?.() ?? dep.amount ?? 0,
          depositedValueUsd: dep.marketValueRefreshed?.toNumber?.() ?? dep.marketValueRefreshed ?? 0,
          borrowedAmount: 0,
          borrowedValueUsd: 0,
        });
      }

      for (const bor of borrows) {
        const reserve = bor.reserveAddress
          ? market.getReserveByAddress?.(bor.reserveAddress)
          : null;
        const mint = bor.mintAddress?.toString() ?? reserve?.getLiquidityMint?.()?.toString() ?? "unknown";
        const existing = reserves.find((r) => r.mint === mint);
        if (existing) {
          existing.borrowedAmount = bor.amount?.toNumber?.() ?? bor.amount ?? 0;
          existing.borrowedValueUsd = bor.marketValueRefreshed?.toNumber?.() ?? bor.marketValueRefreshed ?? 0;
        } else {
          reserves.push({
            mint,
            symbol: reserve?.symbol ?? "?",
            depositedAmount: 0,
            depositedValueUsd: 0,
            borrowedAmount: bor.amount?.toNumber?.() ?? bor.amount ?? 0,
            borrowedValueUsd: bor.marketValueRefreshed?.toNumber?.() ?? bor.marketValueRefreshed ?? 0,
          });
        }
      }

      const totalDepositedUsd = reserves.reduce((s, r) => s + r.depositedValueUsd, 0);
      const totalBorrowedUsd = reserves.reduce((s, r) => s + r.borrowedValueUsd, 0);

      // LTV and liquidation threshold from the obligation itself
      const currentLtv = obligation.loanToValue?.()?.toNumber?.() ?? (
        totalDepositedUsd > 0 ? totalBorrowedUsd / totalDepositedUsd : 0
      );
      const liquidationLtv = obligation.liquidationLtv?.()?.toNumber?.() ?? 0.9;

      const borrowLimit = obligation.refreshedStats?.borrowLimit ?? obligation.stats?.borrowLimit ?? 0;
      const healthFactor = totalBorrowedUsd > 0
        ? (typeof borrowLimit === "number" ? borrowLimit : borrowLimit.toNumber?.() ?? 0) / totalBorrowedUsd
        : Infinity;

      return {
        owner: obligation.state?.owner?.toString() ?? "unknown",
        reserves,
        totalDepositedUsd,
        totalBorrowedUsd,
        currentLtv: currentLtv * 100, // Convert to percentage
        liquidationLtv: liquidationLtv * 100,
        healthFactor,
      };
    } catch (err) {
      // Skip unparseable obligations
      return null;
    }
  }

  // --- Rate Monitoring ---

  /**
   * Get supply/borrow rates for a reserve.
   */
  async getRates(reserveSymbol: string): Promise<KaminoRates | null> {
    const market = await this.loadMarket();
    const reserve = market.getReserve(reserveSymbol);
    if (!reserve) return null;

    return {
      reserve: reserveSymbol,
      supplyApy: reserve.stats?.supplyInterestAPY ?? 0,
      borrowApy: reserve.stats?.borrowInterestAPY ?? 0,
      utilization: reserve.stats?.utilizationRatio ?? 0,
    };
  }

  // --- Loop Operations ---

  /**
   * Deposit JitoSOL as collateral.
   */
  async depositCollateral(amount: BN): Promise<string> {
    const market = await this.loadMarket();

    const action = await KaminoAction.buildDepositTxns(
      market,
      amount,
      JITOSOL_MINT,
      this.signer,
      new VanillaObligation(PROGRAM_ID),
      true,       // includeAtaIxs
      undefined,  // referrer
      DEFAULT_PRIORITY_FEE,
      true,       // addComputeBudget
      false       // addLookupTableIxs
    );

    return this.sendAction(action);
  }

  /**
   * Borrow SOL against deposited JitoSOL.
   */
  async borrowSol(amount: BN): Promise<string> {
    const market = await this.loadMarket();

    const action = await KaminoAction.buildBorrowTxns(
      market,
      amount,
      SOL_MINT,
      this.signer,
      new VanillaObligation(PROGRAM_ID),
      true,
      undefined,
      DEFAULT_PRIORITY_FEE,
      true,
      false
    );

    return this.sendAction(action);
  }

  /**
   * Repay borrowed SOL.
   */
  async repaySol(amount: BN): Promise<string> {
    const market = await this.loadMarket();
    const currentSlot = await this.rpc.getSlot().send();

    const action = await KaminoAction.buildRepayTxns(
      market,
      amount,
      SOL_MINT,
      this.signer,
      new VanillaObligation(PROGRAM_ID),
      true,
      undefined,
      currentSlot,
      this.signer,
      DEFAULT_PRIORITY_FEE,
      true,
      false
    );

    return this.sendAction(action);
  }

  /**
   * Withdraw JitoSOL collateral.
   */
  async withdrawCollateral(amount: BN): Promise<string> {
    const market = await this.loadMarket();

    const action = await KaminoAction.buildWithdrawTxns(
      market,
      amount,
      JITOSOL_MINT,
      this.signer,
      new VanillaObligation(PROGRAM_ID),
      true,
      undefined,
      DEFAULT_PRIORITY_FEE,
      true,
      false
    );

    return this.sendAction(action);
  }

  /**
   * Execute a full leverage loop:
   * Deposit JitoSOL → Borrow SOL → (swap SOL → JitoSOL externally) → repeat
   *
   * Each iteration increases leverage by borrowing against deposited JitoSOL.
   * The SOL → JitoSOL swap must be handled externally (via Jito stake pool
   * or Jupiter swap) between iterations.
   *
   * Returns the list of transaction signatures for each step.
   */
  async executeLoopStep(
    depositAmount: BN,
    borrowFraction: number // 0-1, e.g., 0.80 for 80% LTV
  ): Promise<{ depositSig: string; borrowSig: string; borrowedAmount: BN }> {
    // Step 1: Deposit JitoSOL
    const depositSig = await this.depositCollateral(depositAmount);
    console.log(`  Loop deposit: ${depositSig}`);

    // Wait for confirmation
    await new Promise((r) => setTimeout(r, 2000));

    // Step 2: Borrow SOL at fraction of deposit value
    // JitoSOL ≈ 1.1 SOL, so borrow slightly less than deposit in SOL terms
    const borrowAmount = new BN(
      Math.floor(depositAmount.toNumber() * borrowFraction)
    );
    const borrowSig = await this.borrowSol(borrowAmount);
    console.log(`  Loop borrow: ${borrowSig}`);

    return { depositSig, borrowSig, borrowedAmount: borrowAmount };
  }

  /**
   * Deleverage: Repay SOL → Withdraw JitoSOL → repeat
   */
  async executeDeleverageStep(
    repayAmount: BN,
    withdrawAmount: BN
  ): Promise<{ repaySig: string; withdrawSig: string }> {
    const repaySig = await this.repaySol(repayAmount);
    console.log(`  Deleverage repay: ${repaySig}`);

    await new Promise((r) => setTimeout(r, 2000));

    const withdrawSig = await this.withdrawCollateral(withdrawAmount);
    console.log(`  Deleverage withdraw: ${withdrawSig}`);

    return { repaySig, withdrawSig };
  }
}

// --- Factory ---

export function createKaminoClient(
  rpcUrl: string,
  wsUrl: string,
  signer: TransactionSigner,
  market: "jito" | "main" = "jito"
): KaminoClient {
  const marketAddress = market === "jito" ? JITO_MARKET : MAIN_MARKET;
  return new KaminoClient(rpcUrl, wsUrl, signer, marketAddress);
}
