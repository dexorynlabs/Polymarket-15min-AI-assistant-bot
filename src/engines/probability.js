import { clamp } from "../utils.js";

/**
 * Score bullish vs bearish strength across all available TA signals.
 *
 * Additions vs original:
 *   delta1m / delta3m   — short-term momentum (both must agree to score)
 *   bookImbalanceUp     — Polymarket UP-token bid/ask depth imbalance:
 *                         positive = more buyers (bullish confirmation)
 *                         negative = more sellers (bearish confirmation)
 *                         Heavy one-sided pressure often precedes a fade,
 *                         so the signal acts as a mild crowd-sentiment input.
 */
export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim,
    delta1m,
    delta3m,
    bookImbalanceUp
  } = inputs;

  let up = 1;
  let down = 1;

  // ── VWAP position (+2 each side) ─────────────────────────────────────────
  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  // ── VWAP slope (+2 each side) ────────────────────────────────────────────
  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  // ── RSI level + slope (+2 each side) ─────────────────────────────────────
  if (rsi !== null && rsiSlope !== null) {
    if (rsi > 55 && rsiSlope > 0) up += 2;
    if (rsi < 45 && rsiSlope < 0) down += 2;
  }

  // ── MACD histogram expansion (+2) and line sign (+1) ─────────────────────
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  // ── Heiken Ashi consecutive candles (+1 each side, requires ≥2) ──────────
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  // ── Failed VWAP reclaim (strong bearish signal, +3 down) ─────────────────
  if (failedVwapReclaim === true) down += 3;

  // ── Delta momentum: both 1m and 3m must agree (+1 each side) ─────────────
  // Requires alignment of short-term and medium-term momentum to filter noise.
  if (Number.isFinite(delta1m) && Number.isFinite(delta3m)) {
    if (delta1m > 0 && delta3m > 0) up += 1;
    if (delta1m < 0 && delta3m < 0) down += 1;
  }

  // ── Polymarket UP-token book imbalance (+1 each side, threshold 0.25) ────
  // imbalanceUp = (bidLiq - askLiq) / (bidLiq + askLiq)  ∈ [-1, +1]
  // Positive → more buyers than sellers on the UP token (bullish)
  // Negative → more sellers than buyers on the UP token (bearish)
  if (Number.isFinite(bookImbalanceUp)) {
    if (bookImbalanceUp > 0.25) up += 1;
    if (bookImbalanceUp < -0.25) down += 1;
  }

  const rawUp = up / (up + down);
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}

/**
 * Bayesian blend of the statistical settlement model with the TA score.
 *
 * Rather than using TA as a hard veto, we mix TA direction into the
 * probability estimate itself. This means a strong TA signal genuinely
 * shifts the edge calculation, while a weak or neutral TA signal has
 * minimal impact.
 *
 * @param {number} modelProbUp  – settlement model probability of UP (0–1)
 * @param {number} taProbUp     – TA score rawUp (0–1); 0.5 = neutral
 * @param {number} taWeight     – TA share in the blend (0–1); default 0.25
 * @returns {{ blendedProbUp: number, blendedProbDown: number }}
 */
export function blendProbabilities(modelProbUp, taProbUp, taWeight = 0.25) {
  if (!Number.isFinite(modelProbUp)) return { blendedProbUp: null, blendedProbDown: null };

  // If TA score is unavailable fall back to pure model
  const taComponent = Number.isFinite(taProbUp) ? taProbUp : 0.5;
  const w = clamp(taWeight, 0, 1);
  const blendedProbUp = clamp((1 - w) * modelProbUp + w * taComponent, 0.001, 0.999);
  return { blendedProbUp, blendedProbDown: 1 - blendedProbUp };
}
