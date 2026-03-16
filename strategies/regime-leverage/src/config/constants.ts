import { PublicKey } from "@solana/web3.js";

// Drift
export const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
export const DRIFT_DATA_API = "https://data.api.drift.trade";

// Kamino Lend
export const KAMINO_LEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87ber41GFZPkMhHr9oGYGkuH6v3aBPCSE"
);

// Token mints
export const JITO_SOL_MINT = new PublicKey(
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"
);
export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

// RPC
export const DEFAULT_RPC_URL =
  process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
