/**
 * Mint devnet USDC via Drift's TokenFaucet and deposit into Drift account.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  TokenFaucet,
  initialize,
} from "@drift-labs/sdk";
import BN from "bn.js";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const DEVNET_RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const USDC_MINT = new PublicKey("8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2");
const FAUCET_PROGRAM_ID = new PublicKey("V4v1mQiAdLz4qwckEb45WqHYceYizoib39cDBHSWfaB");
const DRIFT_PROGRAM_ID = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

function loadKeypair(): Keypair {
  const kpPath = process.env.MANAGER_KEYPAIR_PATH;
  if (!kpPath) throw new Error("MANAGER_KEYPAIR_PATH not set");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(kpPath), "utf-8")))
  );
}

async function main(): Promise<void> {
  console.log("=== Devnet Fund: Mint USDC + Deposit ===\n");

  const keypair = loadKeypair();
  const connection = new Connection(DEVNET_RPC, "confirmed");
  const wallet = new Wallet(keypair);

  console.log(`Wallet: ${keypair.publicKey.toBase58()}`);

  // Mint USDC via TokenFaucet
  console.log("\nMinting 10,000 devnet USDC...");
  const tokenFaucet = new TokenFaucet(
    connection,
    wallet,
    FAUCET_PROGRAM_ID,
    USDC_MINT
  );

  const amount = new BN(10_000 * 1e6); // 10,000 USDC
  const [ata, mintSig] = await tokenFaucet.createAssociatedTokenAccountAndMintTo(
    keypair.publicKey,
    amount
  );
  console.log(`Minted to ATA: ${ata.toBase58()}`);
  console.log(`TX: ${mintSig}`);

  // Init Drift client
  const sdkConfig = initialize({ env: "devnet" });
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    accountSubscription: { type: "polling", accountLoader },
    env: "devnet",
  });
  await driftClient.subscribe();

  // Deposit USDC into Drift
  console.log("\nDepositing 10,000 USDC into Drift...");
  const depositSig = await driftClient.deposit(
    amount,
    0, // USDC spot market index
    ata
  );
  console.log(`Deposit TX: ${depositSig}`);

  // Verify
  const user = driftClient.getUser();
  const collateral = user.getTotalCollateral().toNumber() / 1e6;
  console.log(`\nDrift collateral: $${collateral.toFixed(2)}`);
  console.log("Ready for testing!");

  await driftClient.unsubscribe();
}

main().catch(console.error);
