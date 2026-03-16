import { PublicKey } from "@solana/web3.js";

export const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
export const DRIFT_DATA_API = "https://data.api.drift.trade";

// Jupiter
export const JLP_POOL_ADDRESS = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWKIYHBijfFEE1TVgn73Ug"
);

// Sigma VolSwap
export const VOLSWAP_PROGRAM_ID = new PublicKey(
  "FGjwkx9XxzJZvgybXTtDjsWJgCuhXwNJTthFwhfj8nPS"
);

// Token mints
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const DEFAULT_RPC_URL =
  process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
