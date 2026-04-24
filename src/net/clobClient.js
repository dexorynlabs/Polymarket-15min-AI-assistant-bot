/**
 * Thin wrapper around @polymarket/clob-client.
 *
 * Only the subset of methods needed for live execution is exposed:
 *   initClobClient()       – validate env vars and build the SDK client
 *   placeLimitOrder(...)   – FOK limit buy for one outcome token
 *   cancelOrder(orderId)   – cancel an open order by ID
 *   getOpenOrders()        – list all open orders for this account
 *
 * The module keeps one singleton client instance; calling initClobClient()
 * again replaces it.  If initialization fails the caller receives a thrown
 * Error rather than a partially-initialized client.
 */

import { ClobClient, OrderType, Side, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { CONFIG } from "../config.js";

const CLOB_HOST = CONFIG.clobBaseUrl;
const CHAIN_ID = 137;

let _client = null;

function walletTypeToSignatureType(walletType) {
  switch (walletType) {
    case 1: return SignatureType.POLY_PROXY;
    case 2: return SignatureType.POLY_GNOSIS_SAFE;
    default: return SignatureType.EOA;
  }
}

/**
 * Build and cache the ClobClient singleton.
 * Must be called before any trading method.
 * Throws if required environment variables are missing.
 */
export async function initClobClient() {
  const privateKey = process.env.PRIVATE_KEY;
  const apiKey = process.env.POLY_API_KEY;
  const apiSecret = process.env.POLY_API_SECRET;
  const apiPassphrase = process.env.POLY_API_PASSPHRASE;

  if (!privateKey) throw new Error("PRIVATE_KEY env var is required for live trading");
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error(
      "POLY_API_KEY, POLY_API_SECRET, and POLY_API_PASSPHRASE env vars are required. " +
      "Run `node src/net/deriveApiCreds.js` to generate them."
    );
  }

  const signer = new Wallet(privateKey);
  // @polymarket/clob-client detects ethers v5 signers via _signTypedData.
  // ethers v6 renamed it to signTypedData — add the shim so the SDK recognises it.
  if (typeof signer._signTypedData !== "function" && typeof signer.signTypedData === "function") {
    signer._signTypedData = (domain, types, value) => signer.signTypedData(domain, types, value);
  }
  const sigType = walletTypeToSignatureType(CONFIG.live.walletType);
  const funderAddress = CONFIG.live.proxyWallet || signer.address;

  const creds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };

  _client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, sigType, funderAddress);
  return _client;
}

function requireClient() {
  if (!_client) throw new Error("ClobClient not initialized — call initClobClient() first");
  return _client;
}

/**
 * Place a limit buy order.
 * Use aggressionTicks to add ticks to the price for better fill rate.
 * Use orderType "FOK" for immediate fill-or-cancel; "GTC" to rest on the book.
 *
 * @param {string}  tokenId         – CLOB outcome token ID
 * @param {number}  price           – limit price (0–1, e.g. 0.62)
 * @param {number}  size            – number of shares to buy
 * @param {string}  tickSize        – tick size for the market (e.g. "0.01")
 * @param {boolean} negRisk         – true for multi-outcome markets
 * @param {number}  aggressionTicks – add this many ticks to price (default 0)
 * @param {string}  orderType       – "FOK" (fill-or-kill) or "GTC" (default)
 */
export async function placeLimitOrder(tokenId, price, size, tickSize = "0.01", negRisk = false, aggressionTicks = 0, orderType = "GTC") {
  const client = requireClient();
  const tick = Number.parseFloat(tickSize) || 0.01;
  const aggressivePrice = Math.min(0.9999, price + (aggressionTicks * tick));
  const type = String(orderType).toUpperCase() === "FOK" ? OrderType.FOK : OrderType.GTC;
  const response = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: aggressivePrice,
      size,
      side: Side.BUY,
    },
    { tickSize, negRisk },
    type
  );
  return response;
}

/**
 * Place a FOK (Fill or Kill) market buy order.
 * SDK calculates the price from the order book to fill the requested USD amount.
 * Typically fills more reliably than limit orders in fast-moving markets.
 *
 * @param {string}  tokenId  – CLOB outcome token ID
 * @param {number}  amountUsd – USD amount to spend (e.g. 25)
 * @param {string}  tickSize – tick size for the market (e.g. "0.01")
 * @param {boolean} negRisk  – true for multi-outcome markets
 */
export async function placeMarketOrder(tokenId, amountUsd, tickSize = "0.01", negRisk = false) {
  const client = requireClient();
  const response = await client.createAndPostMarketOrder(
    {
      tokenID: tokenId,
      amount: amountUsd,
      side: Side.BUY,
    },
    { tickSize, negRisk },
    OrderType.FOK
  );
  return response;
}

/**
 * Cancel an open order by its order ID.
 */
export async function cancelOrder(orderId) {
  const client = requireClient();
  return client.cancelOrder(orderId);
}

/**
 * Return all open orders for the authenticated account.
 */
export async function getOpenOrders() {
  const client = requireClient();
  return client.getOpenOrders();
}
