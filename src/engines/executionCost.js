import { clamp } from "../utils.js";

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function estimateEntryCost({
  marketPrice,
  bookSummary,
  stakeUsd,
  feeRate,
  slippageBps
}) {
  const quotedPrice = toFiniteNumber(marketPrice);
  const bestAsk = toFiniteNumber(bookSummary?.bestAsk);
  const spread = toFiniteNumber(bookSummary?.spread);
  const askLiquidity = toFiniteNumber(bookSummary?.askLiquidity);
  const entryPrice = bestAsk ?? quotedPrice;

  if (entryPrice === null || entryPrice <= 0 || !Number.isFinite(stakeUsd) || stakeUsd <= 0) {
    return {
      entryPrice: null,
      quotedPrice,
      bestAsk,
      spread,
      askLiquidity,
      feePerShare: null,
      slippagePerShare: null,
      allInPrice: null,
      shares: null,
      totalCost: null
    };
  }

  const feePerShare = entryPrice * Math.max(feeRate ?? 0, 0);
  const slippagePerShare = Math.max(entryPrice * Math.max(slippageBps ?? 0, 0) / 10_000, spread !== null ? spread * 0.25 : 0);
  const allInPrice = clamp(entryPrice + feePerShare + slippagePerShare, 0, 0.9999);
  const shares = stakeUsd / allInPrice;

  return {
    entryPrice,
    quotedPrice,
    bestAsk,
    spread,
    askLiquidity,
    feePerShare,
    slippagePerShare,
    allInPrice,
    shares,
    totalCost: shares * allInPrice
  };
}

export function analyzeBinaryEntry({
  side,
  probability,
  marketPrice,
  bookSummary,
  stakeUsd,
  feeRate,
  slippageBps,
  maxSpread,
  minLiquidityShares,
  priceAgeMs,
  maxPriceAgeMs,
  minNetEvUsd
}) {
  const entry = estimateEntryCost({ marketPrice, bookSummary, stakeUsd, feeRate, slippageBps });
  const reasons = [];

  if (!Number.isFinite(probability)) reasons.push("missing_probability");
  if (!Number.isFinite(entry.allInPrice)) reasons.push("missing_entry_price");
  if (priceAgeMs !== null && Number.isFinite(maxPriceAgeMs) && priceAgeMs > maxPriceAgeMs) reasons.push("stale_reference_price");
  if (entry.spread !== null && Number.isFinite(maxSpread) && entry.spread > maxSpread) reasons.push("spread_too_wide");
  if (entry.askLiquidity !== null && Number.isFinite(entry.shares) && entry.shares > entry.askLiquidity) reasons.push("insufficient_top_book_liquidity");
  if (entry.askLiquidity !== null && Number.isFinite(minLiquidityShares) && entry.askLiquidity < minLiquidityShares) reasons.push("book_liquidity_below_floor");

  const rawEdge = Number.isFinite(probability) && entry.entryPrice !== null ? probability - entry.entryPrice : null;
  const netEdge = Number.isFinite(probability) && entry.allInPrice !== null ? probability - entry.allInPrice : null;
  const expectedPayoutUsd = Number.isFinite(probability) && Number.isFinite(entry.shares) ? entry.shares * probability : null;
  const netEvUsd = expectedPayoutUsd !== null && entry.totalCost !== null ? expectedPayoutUsd - entry.totalCost : null;
  const roi = netEvUsd !== null && entry.totalCost ? netEvUsd / entry.totalCost : null;

  if (netEvUsd !== null && Number.isFinite(minNetEvUsd) && netEvUsd < minNetEvUsd) reasons.push("net_ev_below_threshold");

  return {
    side,
    probability,
    marketPrice: toFiniteNumber(marketPrice),
    ...entry,
    rawEdge,
    netEdge,
    expectedPayoutUsd,
    netEvUsd,
    roi,
    tradable: reasons.length === 0,
    reasons
  };
}

export function estimateMarkPrice({ marketPrice, bookSummary }) {
  const bestBid = toFiniteNumber(bookSummary?.bestBid);
  const fallback = toFiniteNumber(marketPrice);
  return bestBid ?? fallback;
}

/**
 * Kelly-criterion stake sizing for binary prediction markets.
 *
 * For a bet where you pay `allInPrice` per share and collect $1 per share
 * if you win, the full-Kelly fraction of bankroll to wager is:
 *
 *   f* = (p - allInPrice) / (1 - allInPrice)
 *
 * where p is the true win probability. We apply a safety multiplier
 * (`kellyFraction`, default 0.5 = half-Kelly) to reduce variance and
 * account for model error. The result is clamped to [minStake, maxStake].
 *
 * @param {number} probability    – estimated true win probability (0–1)
 * @param {number} allInPrice     – all-in cost per share including fees (0–1)
 * @param {number} bankroll       – available capital in USD
 * @param {number} maxStake       – hard cap on stake in USD
 * @param {number} minStake       – minimum stake in USD (default 0)
 * @param {number} kellyFraction  – fraction of full Kelly to use (default 0.5)
 * @returns {number} stake in USD
 */
export function computeKellyStake({
  probability,
  allInPrice,
  bankroll,
  maxStake,
  minStake = 0,
  kellyFraction = 0.5
}) {
  if (
    !Number.isFinite(probability) ||
    !Number.isFinite(allInPrice) ||
    !Number.isFinite(bankroll) ||
    allInPrice <= 0 ||
    allInPrice >= 1
  ) {
    return minStake;
  }

  const rawKelly = (probability - allInPrice) / (1 - allInPrice);
  if (rawKelly <= 0) return minStake;

  const stake = bankroll * rawKelly * kellyFraction;
  return Math.min(maxStake, Math.max(minStake, stake));
}
