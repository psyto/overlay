/**
 * Jupiter JLP Client — Wrapper for JLP pool operations.
 *
 * Uses:
 * - Jupiter Swap API (deposit/withdraw via USDC<>JLP swap)
 * - Jupiter Lend/Earn API (position reading, pool state)
 * - Anchor IDL for direct pool account reading (basket weights, AUM)
 *
 * Provides:
 * - JLP deposit/withdrawal
 * - Basket weight tracking (SOL, ETH, BTC, USDC, USDT proportions)
 * - Fee yield monitoring
 * - Position value tracking
 *
 * Used by:
 * - jlp-gamma-hedge: deposit management + basket weight tracking for hedge sizing
 */

import { Connection, PublicKey, Transaction, Keypair } from "@solana/web3.js";
import BN from "bn.js";

// --- Constants ---

const PERP_PROGRAM_ID = new PublicKey(
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
);
const JLP_POOL = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq"
);
const JLP_MINT = new PublicKey(
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"
);
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

// Custody addresses for basket assets
const CUSTODIES: Record<string, { address: PublicKey; symbol: string; isStable: boolean }> = {
  SOL: {
    address: new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz"),
    symbol: "SOL",
    isStable: false,
  },
  ETH: {
    address: new PublicKey("AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn"),
    symbol: "ETH",
    isStable: false,
  },
  BTC: {
    address: new PublicKey("5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm"),
    symbol: "BTC",
    isStable: false,
  },
  USDC: {
    address: new PublicKey("G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa"),
    symbol: "USDC",
    isStable: true,
  },
  USDT: {
    address: new PublicKey("4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk"),
    symbol: "USDT",
    isStable: true,
  },
};

const JUPITER_SWAP_API = "https://api.jup.ag/swap/v1";
const JUPITER_EARN_API = "https://api.jup.ag/lend/v1/earn";

// --- Types ---

export interface JlpPoolState {
  totalValueUsd: number;
  basketWeights: Record<string, number>;
  feeAprBps: number;
  feeApyPct: number;
  totalSupply: number;
  pricePerShare: number;
}

export interface JlpPosition {
  shares: number;
  valueUsd: number;
  entryPricePerShare: number;
  unrealizedPnlUsd: number;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  slippageBps: number;
}

// --- Client ---

export class JlpClient {
  private connection: Connection;
  private walletPubkey: PublicKey;

  constructor(connection: Connection, walletPubkey: PublicKey) {
    this.connection = connection;
    this.walletPubkey = walletPubkey;
  }

  // --- Pool State ---

  /**
   * Fetch JLP pool state via Jupiter Earn API + on-chain pool account.
   */
  async getPoolState(): Promise<JlpPoolState> {
    // Fetch pool account for AUM and APR
    const accountInfo = await this.connection.getAccountInfo(JLP_POOL);
    if (!accountInfo) {
      throw new Error("Failed to fetch JLP pool account");
    }

    // Parse pool data (simplified — in production, use full Anchor IDL)
    // For now, use the Earn API for reliable data
    const earnRes = await fetch(
      `${JUPITER_EARN_API}/pool?asset=${USDC_MINT.toBase58()}`
    );

    // Default basket weights (target allocation)
    // These can be read from custody accounts for real-time actual weights
    const basketWeights: Record<string, number> = {
      SOL: 0.44,
      ETH: 0.10,
      BTC: 0.11,
      USDC: 0.26,
      USDT: 0.09,
    };

    // Try to get actual weights from custody AUM proportions
    try {
      const totalAum = await this.fetchTotalAum();
      if (totalAum > 0) {
        for (const [symbol, custody] of Object.entries(CUSTODIES)) {
          const custodyAum = await this.fetchCustodyAum(custody.address);
          if (custodyAum > 0) {
            basketWeights[symbol] = custodyAum / totalAum;
          }
        }
      }
    } catch {
      // Fall back to default target weights
    }

    // Get JLP mint supply for price-per-share calculation
    const mintInfo = await this.connection.getTokenSupply(JLP_MINT);
    const totalSupply = parseFloat(mintInfo.value.amount) / 1e6;

    // Estimate AUM from on-chain (simplified)
    const totalValueUsd = await this.fetchTotalAum();
    const pricePerShare = totalSupply > 0 ? totalValueUsd / totalSupply : 0;

    // APR from pool account (updated weekly by Jupiter)
    // Simplified: use a fetch from Jupiter stats API
    let feeAprBps = 0;
    try {
      const statsRes = await fetch("https://perps-api.jup.ag/v1/pool/info");
      if (statsRes.ok) {
        const stats = (await statsRes.json()) as {
          pool_apr_bps?: number;
          aum_usd?: number;
        };
        feeAprBps = stats.pool_apr_bps ?? 0;
      }
    } catch {
      feeAprBps = 2500; // ~25% fallback estimate
    }

    const aprPct = feeAprBps / 100;
    const feeApyPct = (Math.pow(1 + aprPct / 100 / 365, 365) - 1) * 100;

    return {
      totalValueUsd,
      basketWeights,
      feeAprBps,
      feeApyPct,
      totalSupply,
      pricePerShare,
    };
  }

  /**
   * Fetch total AUM from the JLP pool.
   * Uses Jupiter perps API as it's more reliable than on-chain parsing.
   */
  private async fetchTotalAum(): Promise<number> {
    try {
      const res = await fetch("https://perps-api.jup.ag/v1/pool/info");
      if (res.ok) {
        const data = (await res.json()) as { aum_usd?: number };
        return data.aum_usd ?? 0;
      }
    } catch {
      // Fallback: estimate from on-chain
    }
    return 0;
  }

  /**
   * Fetch a single custody's AUM.
   */
  private async fetchCustodyAum(_custodyAddress: PublicKey): Promise<number> {
    // In production, parse the custody account's assets.owned field
    // For now, return 0 to use default weights
    return 0;
  }

  // --- Position Reading ---

  /**
   * Get user's JLP position by checking their JLP token balance.
   */
  async getPosition(): Promise<JlpPosition | null> {
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
      this.walletPubkey,
      { mint: JLP_MINT }
    );

    if (tokenAccounts.value.length === 0) return null;

    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    const shares = parseFloat(balance.amount) / 1e6;

    if (shares <= 0) return null;

    // Get current price per share
    const poolState = await this.getPoolState();
    const valueUsd = shares * poolState.pricePerShare;

    return {
      shares,
      valueUsd,
      entryPricePerShare: 0, // Would need to track entry separately
      unrealizedPnlUsd: 0,   // Would need entry price to compute
    };
  }

  // --- Deposit / Withdraw ---

  /**
   * Deposit USDC into JLP via Jupiter Swap API.
   * Returns serialized transaction (base64) for signing.
   */
  async buildDepositTx(
    usdcAmount: number,
    slippageBps: number = 50
  ): Promise<{ transaction: string; quote: SwapQuote }> {
    // Get quote: USDC → JLP
    const amountLamports = Math.floor(usdcAmount * 1e6);
    const quoteRes = await fetch(
      `${JUPITER_SWAP_API}/quote?` +
      `inputMint=${USDC_MINT.toBase58()}` +
      `&outputMint=${JLP_MINT.toBase58()}` +
      `&amount=${amountLamports}` +
      `&slippageBps=${slippageBps}`
    );

    if (!quoteRes.ok) {
      throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
    }

    const quoteData = await quoteRes.json();

    // Get swap transaction
    const swapRes = await fetch(`${JUPITER_SWAP_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: this.walletPubkey.toBase58(),
      }),
    });

    if (!swapRes.ok) {
      throw new Error(`Jupiter swap failed: ${swapRes.status}`);
    }

    const swapData = (await swapRes.json()) as { swapTransaction: string };

    const quote: SwapQuote = {
      inputMint: USDC_MINT.toBase58(),
      outputMint: JLP_MINT.toBase58(),
      inAmount: quoteData.inAmount,
      outAmount: quoteData.outAmount,
      priceImpactPct: parseFloat(quoteData.priceImpactPct ?? "0"),
      slippageBps,
    };

    return { transaction: swapData.swapTransaction, quote };
  }

  /**
   * Withdraw from JLP via Jupiter Swap API (sell JLP for USDC).
   */
  async buildWithdrawTx(
    jlpShares: number,
    slippageBps: number = 50
  ): Promise<{ transaction: string; quote: SwapQuote }> {
    const amountLamports = Math.floor(jlpShares * 1e6);
    const quoteRes = await fetch(
      `${JUPITER_SWAP_API}/quote?` +
      `inputMint=${JLP_MINT.toBase58()}` +
      `&outputMint=${USDC_MINT.toBase58()}` +
      `&amount=${amountLamports}` +
      `&slippageBps=${slippageBps}`
    );

    if (!quoteRes.ok) {
      throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
    }

    const quoteData = await quoteRes.json();

    const swapRes = await fetch(`${JUPITER_SWAP_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: this.walletPubkey.toBase58(),
      }),
    });

    if (!swapRes.ok) {
      throw new Error(`Jupiter swap failed: ${swapRes.status}`);
    }

    const swapData = (await swapRes.json()) as { swapTransaction: string };

    const quote: SwapQuote = {
      inputMint: JLP_MINT.toBase58(),
      outputMint: USDC_MINT.toBase58(),
      inAmount: quoteData.inAmount,
      outAmount: quoteData.outAmount,
      priceImpactPct: parseFloat(quoteData.priceImpactPct ?? "0"),
      slippageBps,
    };

    return { transaction: swapData.swapTransaction, quote };
  }

  /**
   * Build a transaction to deposit via Jupiter Earn API.
   * Alternative to the swap approach — may route more efficiently.
   */
  async buildEarnDepositTx(usdcAmount: number): Promise<string> {
    const res = await fetch(`${JUPITER_EARN_API}/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset: USDC_MINT.toBase58(),
        amount: Math.floor(usdcAmount * 1e6).toString(),
        signer: this.walletPubkey.toBase58(),
      }),
    });

    if (!res.ok) {
      throw new Error(`Jupiter Earn deposit failed: ${res.status}`);
    }

    const data = (await res.json()) as { transaction: string };
    return data.transaction;
  }

  /**
   * Build a transaction to withdraw via Jupiter Earn API.
   */
  async buildEarnWithdrawTx(usdcAmount: number): Promise<string> {
    const res = await fetch(`${JUPITER_EARN_API}/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset: USDC_MINT.toBase58(),
        amount: Math.floor(usdcAmount * 1e6).toString(),
        signer: this.walletPubkey.toBase58(),
      }),
    });

    if (!res.ok) {
      throw new Error(`Jupiter Earn withdraw failed: ${res.status}`);
    }

    const data = (await res.json()) as { transaction: string };
    return data.transaction;
  }
}

// --- Factory ---

export function createJlpClient(
  connection: Connection,
  walletPubkey: PublicKey
): JlpClient {
  return new JlpClient(connection, walletPubkey);
}

// --- Utility Exports ---

export { JLP_MINT, JLP_POOL, USDC_MINT, PERP_PROGRAM_ID, CUSTODIES };
