import { PublicKey } from "@solana/web3.js";

export const DRIFT_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
export const DRIFT_DATA_API = "https://data.api.drift.trade";

export const KAMINO_LEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87ber41GFZPkMhHr9oGYGkuH6v3aBPCSE"
);

export const MARGINFI_PROGRAM_ID = new PublicKey(
  "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
);

// Jito Block Engine regions (from Sentinel)
export const JITO_BLOCK_ENGINE_URLS: Record<string, string> = {
  amsterdam: "https://amsterdam.mainnet.block-engine.jito.wtf",
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf",
  ny: "https://ny.mainnet.block-engine.jito.wtf",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf",
};

export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export const DEFAULT_RPC_URL =
  process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
