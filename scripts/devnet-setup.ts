/**
 * Devnet Setup — Initialize Drift account and get test USDC.
 *
 * Prerequisites:
 * 1. Have a devnet keypair (solana-keygen new -o devnet-keypair.json)
 * 2. Get devnet SOL: solana airdrop 2 <your-pubkey> --url devnet
 * 3. Set MANAGER_KEYPAIR_PATH in .env
 *
 * This script:
 * - Initializes a Drift user account on devnet
 * - Requests test USDC from Drift's devnet faucet
 * - Deposits USDC into Drift for trading
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize,
} from "@drift-labs/sdk";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const DRIFT_DEVNET_PROGRAM_ID = new PublicKey(
  "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
);
const DEVNET_RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";

function loadKeypair(): Keypair {
  const kpPath = process.env.MANAGER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("MANAGER_KEYPAIR_PATH not set in .env");
  const resolved = path.resolve(kpPath);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function main(): Promise<void> {
  console.log("=== Devnet Setup ===\n");

  const keypair = loadKeypair();
  const connection = new Connection(DEVNET_RPC, "confirmed");

  console.log(`RPC: ${DEVNET_RPC}`);
  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Check SOL balance
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`SOL balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.1 * 1e9) {
    console.log("\nInsufficient SOL. Run:");
    console.log(`  solana airdrop 2 ${keypair.publicKey.toBase58()} --url devnet`);
    return;
  }

  // Initialize Drift
  const sdkConfig = initialize({ env: "devnet" });

  const wallet = new Wallet(keypair);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_DEVNET_PROGRAM_ID,
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
    env: "devnet",
  });

  await driftClient.subscribe();
  console.log("\nDrift client connected (devnet).");

  // Check if user account exists
  try {
    const user = driftClient.getUser();
    const collateral = user.getTotalCollateral().toNumber() / 1e6;
    console.log(`Drift account exists. Collateral: $${collateral.toFixed(2)}`);

    if (collateral < 100) {
      console.log("\nLow collateral. Request devnet USDC:");
      console.log("  1. Go to https://beta.drift.trade (switch to devnet)");
      console.log("  2. Use the faucet to get test USDC");
      console.log("  3. Deposit USDC into your Drift account");
    }
  } catch {
    console.log("\nNo Drift account found. Initializing...");
    try {
      await driftClient.initializeUserAccount();
      console.log("Drift user account created.");
      console.log("\nNext steps:");
      console.log("  1. Go to https://beta.drift.trade (switch to devnet)");
      console.log("  2. Use the faucet to get test USDC");
      console.log("  3. Deposit USDC into your Drift account");
      console.log("  4. Run: npx ts-node scripts/devnet-jlp-hedge-test.ts");
    } catch (err) {
      console.error("Failed to initialize:", err);
    }
  }

  await driftClient.unsubscribe();
}

main().catch(console.error);
