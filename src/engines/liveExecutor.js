/**
 * Live execution engine.
 *
 * Mirrors the paperTrader.js API but places real orders on Polymarket's CLOB.
 * Strategy: try market order (FOK) first for reliable fills; fall back to limit order
 * with price aggression if market order fails (e.g. insufficient liquidity).
 *   - Enforces a daily loss cap (resets at UTC midnight).
 *   - Enforces a maximum concurrent open-positions cap.
 *   - Dry-run mode (CONFIG.live.dryRun) logs intent without sending orders.
 */

import { CONFIG } from "../config.js";
import { placeLimitOrder, placeMarketOrder } from "../net/clobClient.js";

const USDC_DECIMALS = 6;

// ─── State ────────────────────────────────────────────────────────────────────

export function createLiveTradingState() {
  return {
    enabled: CONFIG.live.enabled,
    cash: 0,
    realizedPnl: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    dailyLossUsd: 0,
    dailyResetDate: todayUtc(),
    lastTradeAtMs: null,
    positions: {},     // keyed by marketSlug — live position objects
    openOrderIds: {}   // keyed by marketSlug — CLOB order IDs
  };
}

export function getLivePosition(state, marketSlug) {
  if (!state || !marketSlug) return null;
  return state.positions[marketSlug] ?? null;
}

// ─── Daily loss cap ──────────────────────────────────────────────────────────

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function maybeResetDailyLoss(state) {
  const today = todayUtc();
  if (state.dailyResetDate !== today) {
    state.dailyLossUsd = 0;
    state.dailyResetDate = today;
  }
}

export function isDailyLimitHit(state) {
  maybeResetDailyLoss(state);
  return state.dailyLossUsd >= CONFIG.live.maxDailyLossUsd;
}

// ─── Open a live position ────────────────────────────────────────────────────

/**
 * Open a live position on the CLOB.
 *
 * @param {object} state        – live trading state from createLiveTradingState()
 * @param {object} params
 *   timestamp      {string}  – ISO timestamp
 *   marketSlug     {string}
 *   question       {string|null}
 *   side           {"UP"|"DOWN"}
 *   tokenId        {string}  – CLOB outcome token ID
 *   tickSize       {string}  – market tick size, e.g. "0.01"
 *   negRisk        {boolean} – true for multi-outcome markets
 *   strikePrice    {number|null}
 *   entryPrice     {number}  – all-in price per share (0–1)
 *   quotedPrice    {number}  – raw ask price (before fees/slippage)
 *   shares         {number}  – number of shares to buy
 *   totalCost      {number}  – USD total cost
 *   probability    {number|null}
 *   closeTimeMs    {number|null}
 *
 * @returns {object} { opened, reason, position, event, orderId }
 */
export async function openLivePosition(state, {
  timestamp,
  marketSlug,
  question,
  side,
  tokenId,
  tickSize,
  negRisk,
  strikePrice,
  entryPrice,
  quotedPrice,
  shares,
  totalCost,
  probability,
  closeTimeMs
}) {
  if (!state?.enabled) return { opened: false, reason: "disabled", position: null, event: null, orderId: null };

  if (!marketSlug || !side || !tokenId || !Number.isFinite(entryPrice) || !Number.isFinite(shares) || !Number.isFinite(totalCost)) {
    return { opened: false, reason: "invalid_order", position: null, event: null, orderId: null };
  }

  if (state.positions[marketSlug]) {
    return { opened: false, reason: "position_exists", position: state.positions[marketSlug], event: null, orderId: null };
  }

  maybeResetDailyLoss(state);
  if (state.dailyLossUsd >= CONFIG.live.maxDailyLossUsd) {
    return { opened: false, reason: "daily_loss_limit", position: null, event: null, orderId: null };
  }

  const openCount = Object.keys(state.positions).length;
  if (openCount >= CONFIG.live.maxOpenPositions) {
    return { opened: false, reason: "max_positions_reached", position: null, event: null, orderId: null };
  }

  const safeShares = parseFloat(Math.min(shares, CONFIG.live.maxStakeUsd / entryPrice).toFixed(4));
  const safeCost = parseFloat((safeShares * entryPrice).toFixed(6));
  const amountUsd = Math.min(safeCost, CONFIG.live.maxStakeUsd);

  let orderId = null;
  let filled = false;
  let fillPrice = entryPrice;
  let actualShares = safeShares;
  let actualCost = safeCost;
  let lastResponse = null;

  if (CONFIG.live.dryRun) {
    orderId = `dry-run-${Date.now()}`;
    filled = true;
  } else {
    let lastError = null;

    function captureApiError(response) {
      if (response?.error != null) {
        const errMsg = typeof response.error === "string" ? response.error : JSON.stringify(response.error);
        lastError = lastError ?? new Error(errMsg);
        lastResponse = response;
      }
    }

    if (CONFIG.live.useMarketOrder) {
      try {
        const response = await placeMarketOrder(tokenId, amountUsd, tickSize, negRisk ?? false);
        lastResponse = response;
        captureApiError(response);
        if (!response?.error) {
          const status = String(response?.status ?? "").toUpperCase();
          if (status === "MATCHED" && response?.orderID) {
            orderId = response.orderID;
            filled = true;
            if (response.takingAmount != null && response.makingAmount != null) {
              actualShares = Number(response.takingAmount) / 10 ** USDC_DECIMALS;
              actualCost = Number(response.makingAmount) / 10 ** USDC_DECIMALS;
              fillPrice = actualCost > 0 ? actualCost / actualShares : entryPrice;
            }
          }
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (!filled && CONFIG.live.limitAggressionTicks >= 0) {
      try {
        const response = await placeLimitOrder(
          tokenId,
          entryPrice,
          safeShares,
          tickSize,
          negRisk ?? false,
          CONFIG.live.limitAggressionTicks,
          "FOK"
        );
        lastResponse = response;
        captureApiError(response);
        if (!response?.error) {
          orderId = response?.orderID ?? response?.order_id ?? null;
          const status = String(response?.status ?? "").toUpperCase();
          filled = status === "MATCHED";
          if (filled && response?.takingAmount != null && response?.makingAmount != null) {
            actualShares = Number(response.takingAmount) / 10 ** USDC_DECIMALS;
            actualCost = Number(response.makingAmount) / 10 ** USDC_DECIMALS;
            fillPrice = actualCost > 0 ? actualCost / actualShares : entryPrice;
          }
        }
      } catch (err) {
        lastError = lastError ?? err;
      }
    }

    if (!filled && lastError) {
      const msg = lastError?.message ?? String(lastError);
      return { opened: false, reason: `order_failed:${msg}`, position: null, event: null, orderId: null };
    }
  }

  if (!filled) {
    const apiError = lastResponse?.error;
    const errDetail = apiError != null
      ? (typeof apiError === "string" ? apiError : JSON.stringify(apiError))
      : (lastResponse?.status ? `status=${lastResponse.status}` : "");
    const reason = errDetail ? `order_not_filled:${errDetail}` : "order_not_filled";
    return { opened: false, reason, position: null, event: null, orderId: null };
  }

  const position = {
    marketSlug,
    question: question ?? null,
    side,
    tokenId,
    strikePrice: Number.isFinite(strikePrice) ? strikePrice : null,
    entryPrice: fillPrice,
    quotedPrice: Number.isFinite(quotedPrice) ? quotedPrice : null,
    shares: actualShares,
    totalCost: actualCost,
    probability: Number.isFinite(probability) ? probability : null,
    closeTimeMs: Number.isFinite(closeTimeMs) ? closeTimeMs : null,
    openedAt: timestamp,
    updatedAt: timestamp,
    orderId,
    dryRun: CONFIG.live.dryRun,
    markPrice: fillPrice,
    markValue: actualShares * fillPrice,
    unrealizedPnl: (actualShares * fillPrice) - actualCost
  };

  state.positions[marketSlug] = position;
  state.openOrderIds[marketSlug] = orderId;
  state.tradeCount += 1;
  state.lastTradeAtMs = Date.parse(timestamp) || Date.now();

  const event = {
    timestamp,
    event: "LIVE_OPEN",
    dryRun: CONFIG.live.dryRun,
    marketSlug,
    side,
    tokenId,
    shares: actualShares,
    strikePrice: position.strikePrice,
    entryPrice: fillPrice,
    quotedPrice: position.quotedPrice,
    probability: position.probability,
    totalCost: actualCost,
    orderId
  };

  return { opened: true, reason: "opened", position, event, orderId };
}

// ─── Mark a live position (MTM update) ───────────────────────────────────────

export function markLivePosition(state, { timestamp, marketSlug, markPrice, probability }) {
  const position = getLivePosition(state, marketSlug);
  if (!position || !Number.isFinite(markPrice)) return { marked: false, position: null, event: null };

  position.markPrice = markPrice;
  position.markValue = position.shares * markPrice;
  position.unrealizedPnl = position.markValue - position.totalCost;
  position.updatedAt = timestamp;
  if (Number.isFinite(probability)) position.probability = probability;

  return {
    marked: true,
    position,
    event: {
      timestamp,
      event: "LIVE_MARK",
      dryRun: CONFIG.live.dryRun,
      marketSlug,
      side: position.side,
      shares: position.shares,
      markPrice,
      probability: position.probability,
      unrealizedPnl: position.unrealizedPnl
    }
  };
}

// ─── Settle a live position ───────────────────────────────────────────────────

export function settleLivePosition(state, { timestamp, marketSlug, winningSide, finalReferencePrice }) {
  const position = getLivePosition(state, marketSlug);
  if (!position || !winningSide) return { settled: false, position: null, event: null };

  const payout = position.side === winningSide ? position.shares : 0;
  const realizedPnl = payout - position.totalCost;

  state.realizedPnl += realizedPnl;
  state.wins += realizedPnl >= 0 ? 1 : 0;
  state.losses += realizedPnl < 0 ? 1 : 0;

  if (realizedPnl < 0) {
    state.dailyLossUsd += Math.abs(realizedPnl);
  }

  delete state.positions[marketSlug];
  delete state.openOrderIds[marketSlug];

  return {
    settled: true,
    position: {
      ...position,
      closedAt: timestamp,
      winningSide,
      finalReferencePrice: Number.isFinite(finalReferencePrice) ? finalReferencePrice : null,
      payout,
      realizedPnl
    },
    event: {
      timestamp,
      event: "LIVE_SETTLE",
      dryRun: CONFIG.live.dryRun,
      marketSlug,
      side: position.side,
      winningSide,
      shares: position.shares,
      finalReferencePrice: Number.isFinite(finalReferencePrice) ? finalReferencePrice : null,
      payout,
      realizedPnl,
      orderId: position.orderId
    }
  };
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summarizeLiveTrading(state) {
  const positions = Object.values(state?.positions ?? {});
  const markedValue = positions.reduce((sum, p) => sum + (Number.isFinite(p.markValue) ? p.markValue : 0), 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + (Number.isFinite(p.unrealizedPnl) ? p.unrealizedPnl : 0), 0);

  return {
    enabled: Boolean(state?.enabled),
    dryRun: CONFIG.live.dryRun,
    realizedPnl: state?.realizedPnl ?? 0,
    unrealizedPnl,
    equity: markedValue,
    openPositions: positions.length,
    tradeCount: state?.tradeCount ?? 0,
    wins: state?.wins ?? 0,
    losses: state?.losses ?? 0,
    dailyLossUsd: state?.dailyLossUsd ?? 0,
    dailyLossLimit: CONFIG.live.maxDailyLossUsd,
    dailyLimitHit: (state?.dailyLossUsd ?? 0) >= CONFIG.live.maxDailyLossUsd
  };
}
