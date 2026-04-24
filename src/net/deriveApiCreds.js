/**
 * One-time helper script: derive Polymarket CLOB L2 API credentials.
 *
 * Usage:
 *   PRIVATE_KEY=0x... node src/net/deriveApiCreds.js
 *
 * The script prints POLY_API_KEY, POLY_API_SECRET, and POLY_API_PASSPHRASE
 * to stdout.  Copy them into your .env file.
 *
 * Optional env vars:
 *   LIVE_WALLET_TYPE   – 0 (EOA, default), 1 (POLY_PROXY), 2 (GNOSIS_SAFE)
 *   LIVE_PROXY_WALLET  – funder/proxy address (required for type 1 or 2)
 */

import { ClobClient, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error("Error: PRIVATE_KEY environment variable is not set.");
  console.error("Usage: PRIVATE_KEY=0x... node src/net/deriveApiCreds.js");
  process.exit(1);
}

const walletType = Number(process.env.LIVE_WALLET_TYPE ?? "0");
function toSignatureType(t) {
  switch (t) {
    case 1: return SignatureType.POLY_PROXY;
    case 2: return SignatureType.POLY_GNOSIS_SAFE;
    default: return SignatureType.EOA;
  }
}
const sigType = toSignatureType(walletType);

const signer = new Wallet(privateKey);
// @polymarket/clob-client detects ethers v5 signers via _signTypedData.
// ethers v6 renamed it to signTypedData — add the shim so the SDK recognises it.
if (typeof signer._signTypedData !== "function" && typeof signer.signTypedData === "function") {
  signer._signTypedData = (domain, types, value) => signer.signTypedData(domain, types, value);
}
const funderAddress = process.env.LIVE_PROXY_WALLET || signer.address;

console.log(`Wallet address : ${signer.address}`);
console.log(`Funder address : ${funderAddress}`);
console.log(`Signature type : ${walletType} (${["EOA", "POLY_PROXY", "GNOSIS_SAFE"][walletType] ?? "unknown"})`);
console.log("Deriving API credentials...\n");

const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, undefined, sigType, funderAddress);

try {
  const creds = await tempClient.createOrDeriveApiKey();
  console.log("Add these lines to your .env file:\n");
  console.log(`POLY_API_KEY=${creds.key}`);
  console.log(`POLY_API_SECRET=${creds.secret}`);
  console.log(`POLY_API_PASSPHRASE=${creds.passphrase}`);
  console.log("\nDone.");
} catch (err) {
  console.error("Failed to derive API credentials:", err?.message ?? err);
  process.exit(1);
}
