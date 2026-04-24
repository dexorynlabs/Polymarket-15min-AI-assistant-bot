import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  extractStrikePrice,
  fetchClobPrice,
  fetchLiveEventsBySeriesId,
  fetchMarketBySlug,
  fetchOrderBook,
  flattenEventMarkets,
  pickLatestLiveMarket,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeEdge, decide } from "./engines/edge.js";
import { analyzeBinaryEntry, computeKellyStake, estimateEntryCost, estimateMarkPrice } from "./engines/executionCost.js";
import {
  createPaperTradingState,
  getOpenPaperPosition,
  markPaperPosition,
  openPaperPosition,
  settlePaperPosition,
  summarizePaperTrading
} from "./engines/paperTrader.js";
import {
  createLiveTradingState,
  getLivePosition,
  isDailyLimitHit,
  markLivePosition,
  openLivePosition,
  settleLivePosition,
  summarizeLiveTrading
} from "./engines/liveExecutor.js";
import { initClobClient } from "./net/clobClient.js";
import {
  classifySettlementSide,
  computeDrift,
  computeRealizedVolatility,
  computeSettlementProbability
} from "./engines/settlementProbability.js";
import { detectRegime } from "./engines/regime.js";
import { blendProbabilities, scoreDirection } from "./engines/probability.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeRsi, slopeLast } from "./indicators/rsi.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import {
  appendCsvRow,
  appendJsonLine,
  ensureDir,
  formatNumber,
  formatPct,
  getCandleWindowTiming,
  sleep
} from "./utils.js";

applyGlobalProxyFromEnv();

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

const SIGNAL_HEADER = [
  "timestamp",
  "market_slug",
  "time_left_min",
  "strike_price",
  "strike_source",
  "reference_price",
  "distance_to_strike",
  "realized_vol_pct_1m",
  "prob_up",
  "prob_down",
  "market_up",
  "market_down",
  "net_edge_up",
  "net_edge_down",
  "net_ev_up_usd",
  "net_ev_down_usd",
  "recommendation",
  "reason",
  "paper_open_positions",
  "paper_realized_pnl",
  "paper_unrealized_pnl"
];

const TRADE_HEADER = [
  "timestamp",
  "event",
  "market_slug",
  "side",
  "shares",
  "strike_price",
  "entry_price",
  "mark_price",
  "probability",
  "total_cost",
  "payout",
  "unrealized_pnl",
  "realized_pnl",
  "cash_balance"
];

const LIVE_TRADE_HEADER = [
  "timestamp",
  "event",
  "dry_run",
  "market_slug",
  "side",
  "token_id",
  "shares",
  "strike_price",
  "entry_price",
  "probability",
  "total_cost",
  "payout",
  "unrealized_pnl",
  "realized_pnl",
  "order_id"
];

const dumpedMarkets = new Set();
const marketCache = {
  market: null,
  fetchedAtMs: 0
};

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

function screenWidth() {
  const width = Number(process.stdout?.columns);
  return Number.isFinite(width) && width >= 40 ? width : 80;
}

function sepLine(ch = "─") {
  return `${ANSI.white}${ch.repeat(screenWidth())}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  return `${padLabel(String(label), LABEL_W)}${value}`;
}

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor((mins ?? 0) * 60));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatProbPct(probability, digits = 1) {
  if (!Number.isFinite(probability)) return "-";
  return `${(probability * 100).toFixed(digits)}%`;
}

function formatUsd(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(digits)}`;
}

function formatTokenPrice(price) {
  if (!Number.isFinite(price)) return "-";
  return `${(price * 100).toFixed(1)}c`;
}

function formatShares(value) {
  if (!Number.isFinite(value)) return "-";
  return formatNumber(value, 2);
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (!Number.isFinite(price)) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const previous = Number.isFinite(prevPrice) ? Number(prevPrice) : null;
  let color = ANSI.reset;
  let arrow = "";

  if (previous !== null && price !== previous) {
    color = price > previous ? ANSI.green : ANSI.red;
    arrow = price > previous ? " ↑" : " ↓";
  }

  return `${label}: ${color}${prefix}${formatNumber(price, decimals)}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (!Number.isFinite(delta) || !Number.isFinite(base) || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(value) {
  if (!Number.isFinite(value) || value === 0) return "NEUTRAL";
  return value > 0 ? "LONG" : "SHORT";
}

function narrativeFromSlope(value) {
  if (!Number.isFinite(value) || value === 0) return "NEUTRAL";
  return value > 0 ? "LONG" : "SHORT";
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const hour = now.getUTCHours();
  const inAsia = hour >= 0 && hour < 8;
  const inEurope = hour >= 7 && hour < 16;
  const inUs = hour >= 13 && hour < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function safeFileSlug(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function safeParseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeTimeMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "-";
  return reasons.slice(0, 2).join(", ");
}

function extractWinner(finalReferencePrice, strikePrice) {
  if (!Number.isFinite(finalReferencePrice) || !Number.isFinite(strikePrice)) {
    return { winningSide: null, isPush: false };
  }
  return {
    winningSide: finalReferencePrice > strikePrice ? "UP" : "DOWN",
    isPush: finalReferencePrice === strikePrice
  };
}

function maybeLogTradeEvent(event) {
  if (!event || !CONFIG.logs.enableTrades) return;
  appendJsonLine(CONFIG.logs.tradesPath, event);
  appendCsvRow(CONFIG.logs.tradesCsvPath, TRADE_HEADER, [
    event.timestamp,
    event.event,
    event.marketSlug,
    event.side,
    event.shares,
    event.strikePrice ?? null,
    event.entryPrice ?? null,
    event.markPrice ?? null,
    event.probability ?? null,
    event.totalCost ?? null,
    event.payout ?? null,
    event.unrealizedPnl ?? null,
    event.realizedPnl ?? null,
    event.cashBalance ?? null
  ]);
}

function maybeLogLiveTradeEvent(event) {
  if (!event) return;
  appendJsonLine(CONFIG.live.tradesPath, event);
  appendCsvRow(CONFIG.live.tradesCsvPath, LIVE_TRADE_HEADER, [
    event.timestamp,
    event.event,
    event.dryRun ? "1" : "0",
    event.marketSlug,
    event.side ?? null,
    event.tokenId ?? null,
    event.shares ?? null,
    event.strikePrice ?? null,
    event.entryPrice ?? null,
    event.probability ?? null,
    event.totalCost ?? null,
    event.payout ?? null,
    event.unrealizedPnl ?? null,
    event.realizedPnl ?? null,
    event.orderId ?? null
  ]);
}

function maybeDumpMarket(market) {
  if (!market) return;
  const slug = safeFileSlug(market.slug || market.id || "market");
  if (!slug || dumpedMarkets.has(slug)) return;
  dumpedMarkets.add(slug);
  ensureDir(CONFIG.logs.marketDumpDir);
  fs.writeFileSync(path.join(CONFIG.logs.marketDumpDir, `polymarket_market_${slug}.json`), JSON.stringify(market, null, 2), "utf8");
}

function syncTrackedMarketState({
  trackedMarketState,
  market,
  marketSlug,
  marketStartMs,
  settlementMs,
  currentPrice,
  referenceUpdatedAtMs,
  referenceSource,
  nowMs
}) {
  if (!marketSlug) return trackedMarketState;

  const next = trackedMarketState?.slug === marketSlug
    ? { ...trackedMarketState }
    : {
      slug: marketSlug,
      question: market?.question ?? null,
      strikePrice: null,
      strikeSource: null,
      strikeSetAtMs: null,
      marketStartMs,
      settlementMs,
      lastReferencePrice: null,
      lastReferenceAtMs: null,
      lastReferenceSource: null,
      resultLogged: false
    };

  next.question = market?.question ?? next.question;
  next.marketStartMs = marketStartMs ?? next.marketStartMs;
  next.settlementMs = settlementMs ?? next.settlementMs;

  const metadataStrike = extractStrikePrice(market);
  if (Number.isFinite(metadataStrike)) {
    next.strikePrice = metadataStrike;
    next.strikeSource = "market_metadata";
    next.strikeSetAtMs = next.strikeSetAtMs ?? nowMs;
  } else if (!Number.isFinite(next.strikePrice) && Number.isFinite(currentPrice) && (marketStartMs === null || nowMs >= marketStartMs)) {
    next.strikePrice = currentPrice;
    next.strikeSource = "latched_reference";
    next.strikeSetAtMs = nowMs;
  }

  if (Number.isFinite(currentPrice)) {
    next.lastReferencePrice = currentPrice;
    next.lastReferenceAtMs = referenceUpdatedAtMs ?? nowMs;
    next.lastReferenceSource = referenceSource ?? next.lastReferenceSource;
  }

  return next;
}

function finalizeTrackedMarket({ trackedMarketState, timestamp, paperState, liveState }) {
  if (!trackedMarketState?.slug || trackedMarketState.resultLogged) {
    return { trackedMarketState, resultRecord: null };
  }

  const finalReferencePrice = trackedMarketState.lastReferencePrice;
  const strikePrice = trackedMarketState.strikePrice;
  const { winningSide, isPush } = extractWinner(finalReferencePrice, strikePrice);

  const settlement = settlePaperPosition(paperState, {
    timestamp,
    marketSlug: trackedMarketState.slug,
    winningSide,
    finalReferencePrice
  });
  maybeLogTradeEvent(settlement.event);

  if (liveState?.enabled) {
    const liveSettlement = settleLivePosition(liveState, {
      timestamp,
      marketSlug: trackedMarketState.slug,
      winningSide,
      finalReferencePrice
    });
    maybeLogLiveTradeEvent(liveSettlement.event);
  }

  const resultRecord = {
    timestamp,
    marketSlug: trackedMarketState.slug,
    question: trackedMarketState.question,
    strikePrice,
    strikeSource: trackedMarketState.strikeSource,
    finalReferencePrice,
    winningSide,
    isPush,
    closeTimeMs: trackedMarketState.settlementMs,
    paperPositionSettled: settlement.settled,
    realizedPnl: settlement.position?.realizedPnl ?? null,
    livePositionSettled: liveState?.enabled ? getLivePosition(liveState, trackedMarketState.slug) !== null : null
  };

  if (CONFIG.logs.enableResults) {
    appendJsonLine(CONFIG.logs.resultsPath, resultRecord);
  }

  return {
    trackedMarketState: { ...trackedMarketState, resultLogged: true },
    resultRecord
  };
}

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);
  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();
  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = safeParseArray(market.outcomes);
  const outcomePrices = safeParseArray(market.outcomePrices);
  const clobTokenIds = safeParseArray(market.clobTokenIds);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]).toLowerCase();
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;
    if (label === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((value) => String(value).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((value) => String(value).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());
  const gammaUp = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaDown = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return { ok: false, reason: "missing_token_ids", market };
  }

  let upPrice = null;
  let downPrice = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upPrice = yesBuy;
    downPrice = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upPrice ?? gammaUp,
      down: downPrice ?? gammaDown
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});
  const paperState = createPaperTradingState(CONFIG.paper);
  const liveState = createLiveTradingState();

  if (CONFIG.live.enabled) {
    if (CONFIG.live.dryRun) {
      console.log("[live] DRY RUN mode — orders will be simulated, not sent to Polymarket.");
    } else {
      try {
        await initClobClient();
        console.log("[live] CLOB client initialized. Live trading is ACTIVE.");
      } catch (err) {
        console.warn(`[live] Failed to initialize CLOB client: ${err?.message ?? err}`);
        console.warn("[live] Falling back to paper-only mode for this session.");
        liveState.enabled = false;
      }
    }
  }

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let trackedMarketState = null;
  let lastOrderAttempt = null; // { timestamp, side, opened, reason, orderId, shares, entryPrice, totalCost }

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);
    const wsPrice = binanceStream.getLast()?.price ?? null;
    const polymarketWsTick = polymarketLiveStream.getLast();
    const chainlinkWsTick = chainlinkStream.getLast();

    try {
      const chainlinkPromise = Number.isFinite(polymarketWsTick?.price)
        ? Promise.resolve({ price: polymarketWsTick.price, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : Number.isFinite(chainlinkWsTick?.price)
          ? Promise.resolve({ price: chainlinkWsTick.price, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const nowMs = Date.now();
      const timestamp = new Date(nowMs).toISOString();
      const currentPrice = Number.isFinite(chainlink?.price) ? chainlink.price : null;
      const referenceUpdatedAtMs = Number.isFinite(chainlink?.updatedAt) ? chainlink.updatedAt : null;
      const referenceAgeMs = referenceUpdatedAtMs !== null ? Math.max(0, nowMs - referenceUpdatedAtMs) : null;
      const activeMarketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";

      if (trackedMarketState?.slug && activeMarketSlug && trackedMarketState.slug !== activeMarketSlug) {
        trackedMarketState = finalizeTrackedMarket({ trackedMarketState, timestamp, paperState, liveState }).trackedMarketState;
      }
      if (trackedMarketState?.slug && Number.isFinite(trackedMarketState.settlementMs) && nowMs >= trackedMarketState.settlementMs && !trackedMarketState.resultLogged) {
        trackedMarketState = finalizeTrackedMarket({ trackedMarketState, timestamp, paperState, liveState }).trackedMarketState;
      }

      const settlementMs = poly.ok ? safeTimeMs(poly.market?.endDate) : null;
      const settlementLeftMin = settlementMs !== null ? (settlementMs - nowMs) / 60_000 : null;
      const marketStartMs = poly.ok ? safeTimeMs(poly.market?.eventStartTime ?? poly.market?.startTime ?? poly.market?.startDate) : null;

      trackedMarketState = syncTrackedMarketState({
        trackedMarketState,
        market: poly.ok ? poly.market : null,
        marketSlug: activeMarketSlug,
        marketStartMs,
        settlementMs,
        currentPrice,
        referenceUpdatedAtMs,
        referenceSource: chainlink?.source ?? null,
        nowMs
      });

      if (poly.ok) {
        maybeDumpMarket(poly.market);
      }

      const strikePrice = trackedMarketState?.slug === activeMarketSlug ? trackedMarketState.strikePrice : null;
      const strikeSource = trackedMarketState?.slug === activeMarketSlug ? trackedMarketState.strikeSource : null;
      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;
      const spotPrice = Number.isFinite(wsPrice) ? wsPrice : lastPrice;
      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;

      const candles = klines1m;
      const closes = candles.map((candle) => candle.close);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1] ?? computeSessionVwap(candles);
      const vwapSlope = vwapSeries.length >= CONFIG.vwapSlopeLookbackMinutes
        ? (vwapNow - vwapSeries[vwapSeries.length - CONFIG.vwapSlopeLookbackMinutes]) / CONFIG.vwapSlopeLookbackMinutes
        : null;
      const vwapDist = Number.isFinite(vwapNow) ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const value = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
        if (value !== null) rsiSeries.push(value);
      }
      const rsiNow = rsiSeries[rsiSeries.length - 1] ?? null;
      const rsiSlope = slopeLast(rsiSeries, 3);
      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const heikenAshi = computeHeikenAshi(candles);
      const heikenState = countConsecutive(heikenAshi);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((sum, candle) => sum + candle.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((sum, candle) => sum + candle.volume, 0) / 6;
      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg
      });

      // ── Delta momentum (1m and 3m price changes) ─────────────────────────
      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = Number.isFinite(lastClose) && Number.isFinite(close1mAgo) ? lastClose - close1mAgo : null;
      const delta3m = Number.isFinite(lastClose) && Number.isFinite(close3mAgo) ? lastClose - close3mAgo : null;

      // ── Polymarket UP-token orderbook imbalance ───────────────────────────
      // (bidLiq - askLiq) / total — positive = more buyers (bullish), negative = more sellers
      const upBook = poly.ok ? poly.orderbook.up : null;
      const bookImbalanceUp =
        upBook?.bidLiquidity != null &&
        upBook?.askLiquidity != null &&
        (upBook.bidLiquidity + upBook.askLiquidity) > 0
          ? (upBook.bidLiquidity - upBook.askLiquidity) / (upBook.bidLiquidity + upBook.askLiquidity)
          : null;

      const priceForTa = closes.length ? closes[closes.length - 1] : currentPrice;
      const taScore = scoreDirection({
        price: priceForTa,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: heikenState.color,
        heikenCount: heikenState.count,
        failedVwapReclaim: undefined,
        delta1m,
        delta3m,
        bookImbalanceUp
      });
      const taDirection = taScore.rawUp > 0.5 ? "UP" : taScore.rawUp < 0.5 ? "DOWN" : null;

      const realizedVol = computeRealizedVolatility(candles, CONFIG.model.realizedVolLookbackMinutes);
      const drift = computeDrift(candles, CONFIG.model.driftLookbackMinutes);
      const settlementModel = computeSettlementProbability({
        currentPrice,
        strikePrice,
        timeLeftMin,
        realizedVol,
        driftPctPerMinute: drift.driftPctPerMinute ?? 0,
        minVolPct: CONFIG.model.minVolPctPerMinute,
        tailDf: CONFIG.model.tailDf
      });

      // ── Bayesian probability blend: TA score pulled into estimate ─────────
      // Blended value is what drives all edge, EV, and Kelly calculations.
      // Raw settlement model is preserved separately for diagnostic display.
      const { blendedProbUp, blendedProbDown } = blendProbabilities(
        settlementModel.probUp,
        taScore.rawUp,
        CONFIG.model.taProbWeight
      );

      // ── Kelly position sizing ─────────────────────────────────────────────
      // Compute allInPrice first (independent of stakeUsd), then derive the
      // half-Kelly stake for each side, bounded by [minStake, maxStake].
      const upCostEstimate = estimateEntryCost({
        marketPrice: marketUp,
        bookSummary: poly.ok ? poly.orderbook.up : null,
        stakeUsd: CONFIG.paper.stakeUsd,
        feeRate: CONFIG.execution.feeRate,
        slippageBps: CONFIG.execution.slippageBps
      });
      const downCostEstimate = estimateEntryCost({
        marketPrice: marketDown,
        bookSummary: poly.ok ? poly.orderbook.down : null,
        stakeUsd: CONFIG.paper.stakeUsd,
        feeRate: CONFIG.execution.feeRate,
        slippageBps: CONFIG.execution.slippageBps
      });

      const paperBankroll = Math.max(paperState.cash, CONFIG.kelly.minStakeUsd);
      const upStakeUsd = CONFIG.kelly.enabled
        ? computeKellyStake({
            probability: blendedProbUp,
            allInPrice: upCostEstimate.allInPrice,
            bankroll: paperBankroll,
            maxStake: CONFIG.paper.stakeUsd,
            minStake: CONFIG.kelly.minStakeUsd,
            kellyFraction: CONFIG.kelly.fraction
          })
        : CONFIG.paper.stakeUsd;
      const downStakeUsd = CONFIG.kelly.enabled
        ? computeKellyStake({
            probability: blendedProbDown,
            allInPrice: downCostEstimate.allInPrice,
            bankroll: paperBankroll,
            maxStake: CONFIG.paper.stakeUsd,
            minStake: CONFIG.kelly.minStakeUsd,
            kellyFraction: CONFIG.kelly.fraction
          })
        : CONFIG.paper.stakeUsd;

      const upAnalysis = analyzeBinaryEntry({
        side: "UP",
        probability: blendedProbUp,
        marketPrice: marketUp,
        bookSummary: poly.ok ? poly.orderbook.up : null,
        stakeUsd: upStakeUsd,
        feeRate: CONFIG.execution.feeRate,
        slippageBps: CONFIG.execution.slippageBps,
        maxSpread: CONFIG.execution.maxSpread,
        minLiquidityShares: CONFIG.execution.minLiquidityShares,
        priceAgeMs: referenceAgeMs,
        maxPriceAgeMs: CONFIG.execution.maxReferenceAgeMs,
        minNetEvUsd: CONFIG.execution.minNetEvUsd
      });
      const downAnalysis = analyzeBinaryEntry({
        side: "DOWN",
        probability: blendedProbDown,
        marketPrice: marketDown,
        bookSummary: poly.ok ? poly.orderbook.down : null,
        stakeUsd: downStakeUsd,
        feeRate: CONFIG.execution.feeRate,
        slippageBps: CONFIG.execution.slippageBps,
        maxSpread: CONFIG.execution.maxSpread,
        minLiquidityShares: CONFIG.execution.minLiquidityShares,
        priceAgeMs: referenceAgeMs,
        maxPriceAgeMs: CONFIG.execution.maxReferenceAgeMs,
        minNetEvUsd: CONFIG.execution.minNetEvUsd
      });

      const edge = computeEdge({
        modelUp: blendedProbUp,
        modelDown: blendedProbDown,
        marketYes: marketUp,
        marketNo: marketDown,
        upAnalysis,
        downAnalysis
      });

      const lastActivityMs = Math.max(paperState.lastTradeAtMs ?? 0, liveState.lastTradeAtMs ?? 0);
      const cooldownRemainingMs = lastActivityMs === 0
        ? 0
        : Math.max(0, CONFIG.execution.cooldownMs - (nowMs - lastActivityMs));
      let recommendation = decide({
        remainingMinutes: timeLeftMin,
        analysis: edge,
        cooldownRemainingMs,
        regime: regimeInfo.regime,
        allowedPhases: CONFIG.execution.allowedPhases,
        taDirection
      });
      if (Number.isFinite(settlementMs) && settlementMs <= nowMs) {
        recommendation = {
          action: "NO_TRADE",
          side: null,
          phase: recommendation.phase,
          reason: "market_closed",
          reasons: ["market_closed"]
        };
      }

      const openPosition = getOpenPaperPosition(paperState, activeMarketSlug);
      if (CONFIG.paper.enabled && recommendation.action === "ENTER" && poly.ok && !openPosition) {
        const chosen = recommendation.side === "UP" ? edge.up : edge.down;
        const opened = openPaperPosition(paperState, {
          timestamp,
          marketSlug: activeMarketSlug,
          question: poly.market?.question ?? null,
          side: recommendation.side,
          strikePrice,
          entryPrice: chosen.allInPrice,
          quotedPrice: chosen.entryPrice,
          shares: chosen.shares,
          totalCost: chosen.totalCost,
          probability: chosen.probability,
          closeTimeMs: settlementMs
        });
        maybeLogTradeEvent(opened.event);
      }

      const refreshedPosition = getOpenPaperPosition(paperState, activeMarketSlug);
      if (refreshedPosition) {
        const markPrice = estimateMarkPrice({
          marketPrice: refreshedPosition.side === "UP" ? marketUp : marketDown,
          bookSummary: refreshedPosition.side === "UP" ? poly.orderbook.up : poly.orderbook.down
        });
        const marked = markPaperPosition(paperState, {
          timestamp,
          marketSlug: activeMarketSlug,
          markPrice,
          probability: refreshedPosition.side === "UP" ? blendedProbUp : blendedProbDown
        });
        maybeLogTradeEvent(marked.event);
      }

      // ── Live execution ────────────────────────────────────────────────────
      if (liveState.enabled) {
        const openLivePos = getLivePosition(liveState, activeMarketSlug);
        if (recommendation.action === "ENTER" && poly.ok && !openLivePos && !isDailyLimitHit(liveState)) {
          const chosen = recommendation.side === "UP" ? edge.up : edge.down;
          const tokenId = recommendation.side === "UP" ? poly.tokens?.upTokenId : poly.tokens?.downTokenId;
          if (tokenId) {
            const attemptLog = {
              timestamp,
              event: "ORDER_ATTEMPT",
              dryRun: CONFIG.live.dryRun,
              marketSlug: activeMarketSlug,
              side: recommendation.side,
              tokenId,
              entryPrice: chosen.allInPrice,
              shares: chosen.shares,
              totalCost: chosen.totalCost
            };
            appendJsonLine(path.join(CONFIG.logs.dir, "live_order_attempts.jsonl"), attemptLog);

            const liveOpened = await openLivePosition(liveState, {
              timestamp,
              marketSlug: activeMarketSlug,
              question: poly.market?.question ?? null,
              side: recommendation.side,
              tokenId,
              tickSize: String(poly.market?.minimumTickSize ?? "0.01"),
              negRisk: Boolean(poly.market?.negRisk),
              strikePrice,
              entryPrice: chosen.allInPrice,
              quotedPrice: chosen.entryPrice,
              shares: chosen.shares,
              totalCost: chosen.totalCost,
              probability: chosen.probability,
              closeTimeMs: settlementMs
            });
            maybeLogLiveTradeEvent(liveOpened.event);

            lastOrderAttempt = {
              timestamp,
              side: recommendation.side,
              opened: liveOpened.opened,
              reason: liveOpened.reason,
              orderId: liveOpened.orderId ?? null,
              shares: liveOpened.position?.shares ?? chosen.shares,
              entryPrice: liveOpened.position?.entryPrice ?? chosen.allInPrice,
              totalCost: liveOpened.position?.totalCost ?? chosen.totalCost
            };
            // Apply cooldown on failed attempts so we don't hammer the API every second
            if (!liveOpened.opened) {
              liveState.lastTradeAtMs = Date.parse(timestamp) || Date.now();
            }

            const resultLog = {
              ...attemptLog,
              event: liveOpened.opened ? "ORDER_PLACED" : "ORDER_FAILED",
              opened: liveOpened.opened,
              reason: liveOpened.reason,
              orderId: liveOpened.orderId ?? null,
              sharesActual: liveOpened.position?.shares ?? null,
              totalCostActual: liveOpened.position?.totalCost ?? null
            };
            appendJsonLine(path.join(CONFIG.logs.dir, "live_order_attempts.jsonl"), resultLog);

            if (!liveOpened.opened) {
              const errorEntry = {
                timestamp,
                event: "ORDER_FAILED",
                marketSlug: activeMarketSlug,
                side: recommendation.side,
                reason: liveOpened.reason,
                entryPrice: chosen.allInPrice,
                shares: chosen.shares,
                totalCost: chosen.totalCost,
                dryRun: CONFIG.live.dryRun
              };
              console.error(`[live] Order failed: ${liveOpened.reason} (${activeMarketSlug} ${recommendation.side})`);
              appendJsonLine(path.join(CONFIG.logs.dir, "live_order_errors.jsonl"), errorEntry);
            }
          }
        }

        const refreshedLivePos = getLivePosition(liveState, activeMarketSlug);
        if (refreshedLivePos) {
          const liveMarkPrice = estimateMarkPrice({
            marketPrice: refreshedLivePos.side === "UP" ? marketUp : marketDown,
            bookSummary: refreshedLivePos.side === "UP" ? poly.orderbook.up : poly.orderbook.down
          });
          const liveMark = markLivePosition(liveState, {
            timestamp,
            marketSlug: activeMarketSlug,
            markPrice: liveMarkPrice,
            probability: refreshedLivePos.side === "UP" ? blendedProbUp : blendedProbDown
          });
          maybeLogLiveTradeEvent(liveMark.event);
        }
      }
      // ── End live execution ────────────────────────────────────────────────

      if (trackedMarketState?.slug === activeMarketSlug && Number.isFinite(settlementMs) && nowMs >= settlementMs && !trackedMarketState.resultLogged) {
        trackedMarketState = finalizeTrackedMarket({ trackedMarketState, timestamp, paperState, liveState }).trackedMarketState;
      }
      const paperSummary = summarizePaperTrading(paperState);
      const currentPosition = getOpenPaperPosition(paperState, activeMarketSlug);
      const liveSummary = summarizeLiveTrading(liveState);
      const currentLivePosition = getLivePosition(liveState, activeMarketSlug);

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";
      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const heikenNarrative = (heikenState.color ?? "").toLowerCase() === "green" ? "LONG" : (heikenState.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);
      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      // modelBias reflects blended probability — what the bot actually uses for decisions
      const modelBias = classifySettlementSide(blendedProbUp);

      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });
      const strikeDelta = Number.isFinite(currentPrice) && Number.isFinite(strikePrice) ? currentPrice - strikePrice : null;
      const strikeDeltaColor = strikeDelta === null ? ANSI.gray : strikeDelta > 0 ? ANSI.green : strikeDelta < 0 ? ANSI.red : ANSI.gray;
      const strikeDeltaText = strikeDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${strikeDeltaColor}${strikeDelta > 0 ? "+" : strikeDelta < 0 ? "-" : ""}$${Math.abs(strikeDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;

      const binanceLine = colorPriceLine({
        label: "BTC (Binance)",
        price: spotPrice,
        prevPrice: prevSpotPrice,
        decimals: 0,
        prefix: "$"
      });
      const binanceValue = binanceLine.split(": ")[1] ?? binanceLine;
      const rejectReasons = recommendation.action === "NO_TRADE"
        ? summarizeReasons(recommendation.reasons ?? [])
        : "-";

      const snapshotRecord = {
        timestamp,
        marketSlug: activeMarketSlug || null,
        question: poly.ok ? poly.market?.question ?? null : trackedMarketState?.question ?? null,
        tokenIds: poly.ok ? poly.tokens : null,
        startTimeMs: marketStartMs,
        endTimeMs: settlementMs,
        strikePrice,
        strikeSource,
        referencePrice: currentPrice,
        referenceSource: chainlink?.source ?? null,
        referenceAgeMs,
        binanceSpotPrice: spotPrice,
        timeLeftMin,
        distanceToStrike: settlementModel.distanceToStrike,
        distancePct: settlementModel.distancePct,
        realizedVolPct1m: realizedVol.sigmaPct1m,
        sigmaPrice: settlementModel.sigmaPrice,
        driftPctPerMinute: drift.driftPctPerMinute,
        modelBias,
        model: {
          probUp: blendedProbUp,
          probDown: blendedProbDown,
          rawProbUp: settlementModel.probUp,
          rawProbDown: settlementModel.probDown,
          projectedMean: settlementModel.projectedMean,
          zScore: settlementModel.zScore,
          taProbUp: taScore.rawUp,
          upStakeUsd,
          downStakeUsd
        },
        market: {
          up: marketUp,
          down: marketDown
        },
        candidates: {
          up: upAnalysis,
          down: downAnalysis
        },
        recommendation: {
          action: recommendation.action,
          side: recommendation.side,
          phase: recommendation.phase,
          strength: recommendation.strength ?? null,
          reason: recommendation.reason,
          reasons: recommendation.reasons ?? []
        },
        paper: {
          summary: paperSummary,
          currentPosition
        }
      };

      if (CONFIG.logs.enableSnapshots) {
        appendJsonLine(CONFIG.logs.snapshotsPath, snapshotRecord);
      }

      appendCsvRow(CONFIG.logs.signalsCsvPath, SIGNAL_HEADER, [
        timestamp,
        activeMarketSlug || "",
        Number.isFinite(timeLeftMin) ? timeLeftMin.toFixed(3) : "",
        strikePrice,
        strikeSource,
        currentPrice,
        settlementModel.distanceToStrike,
        realizedVol.sigmaPct1m,
        blendedProbUp,
        blendedProbDown,
        marketUp,
        marketDown,
        edge.edgeUp,
        edge.edgeDown,
        upAnalysis.netEvUsd,
        downAnalysis.netEvUsd,
        recommendation.action === "ENTER" ? `${recommendation.side}:${recommendation.phase}:${recommendation.strength}` : "NO_TRADE",
        recommendation.reason,
        paperSummary.openPositions,
        paperSummary.realizedPnl,
        paperSummary.unrealizedPnl
      ]);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : (trackedMarketState?.question ?? "-");
      const timeColor = timeLeftMin >= 10 ? ANSI.green : timeLeftMin >= 5 ? ANSI.yellow : ANSI.red;
      const modelValue = `${ANSI.green}UP${ANSI.reset} ${formatProbPct(blendedProbUp)} / ${ANSI.red}DOWN${ANSI.reset} ${formatProbPct(blendedProbDown)} (${modelBias}) ${ANSI.dim}raw: ${formatProbPct(settlementModel.probUp)}${ANSI.reset}`;
      const strikeLine = Number.isFinite(strikePrice)
        ? `$${formatNumber(strikePrice, 2)} (${strikeSource ?? "unknown"})`
        : `${ANSI.gray}-${ANSI.reset}`;
      const actionValue = recommendation.action === "ENTER"
        ? `${ANSI.green}${recommendation.side}${ANSI.reset} | EV ${formatUsd(recommendation.netEvUsd ?? 0)} | ${recommendation.strength}`
        : `${ANSI.gray}NO TRADE${ANSI.reset} | ${rejectReasons}`;
      const upCandidateValue = `p ${formatProbPct(upAnalysis.probability)} | ask ${formatTokenPrice(upAnalysis.entryPrice)} | all-in ${formatTokenPrice(upAnalysis.allInPrice)} | EV ${formatUsd(upAnalysis.netEvUsd)} | stake $${formatNumber(upStakeUsd, 2)}`;
      const downCandidateValue = `p ${formatProbPct(downAnalysis.probability)} | ask ${formatTokenPrice(downAnalysis.entryPrice)} | all-in ${formatTokenPrice(downAnalysis.allInPrice)} | EV ${formatUsd(downAnalysis.netEvUsd)} | stake $${formatNumber(downStakeUsd, 2)}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", `${heikenState.color ?? "-"} x${heikenState.count}`, heikenNarrative);
      const rsiArrow = Number.isFinite(rsiSlope) ? (rsiSlope > 0 ? "↑" : rsiSlope < 0 ? "↓" : "-") : "-";
      const rsiLine = formatNarrativeValue("RSI", `${formatNumber(rsiNow, 1)} ${rsiArrow}`, rsiNarrative);
      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);
      const deltaLine = `Delta 1/3Min: ${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const vwapLine = formatNarrativeValue("VWAP", `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`, vwapNarrative);
      const paperPositionLine = currentPosition
        ? `${currentPosition.side} ${formatShares(currentPosition.shares)} @ ${formatTokenPrice(currentPosition.entryPrice)} | mark ${formatTokenPrice(currentPosition.markPrice)} | uPnL ${formatUsd(currentPosition.unrealizedPnl)}`
        : `${ANSI.gray}none${ANSI.reset}`;
      const paperSummaryLine = `cash $${formatNumber(paperSummary.cash, 2)} | eq $${formatNumber(paperSummary.equity, 2)} | realized ${formatUsd(paperSummary.realizedPnl)} | unrealized ${formatUsd(paperSummary.unrealizedPnl)}`;
      const marketValue = `${ANSI.green}UP${ANSI.reset} ${formatTokenPrice(marketUp)}  |  ${ANSI.red}DOWN${ANSI.reset} ${formatTokenPrice(marketDown)}`;
      const liquidity = poly.ok ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null) : null;

      const liveModeLabel = !liveState.enabled
        ? `${ANSI.gray}disabled${ANSI.reset}`
        : liveSummary.dryRun
          ? `${ANSI.yellow}DRY RUN${ANSI.reset}`
          : `${ANSI.green}LIVE${ANSI.reset}`;
      const liveDailyBar = liveSummary.dailyLimitHit
        ? `${ANSI.red}LIMIT HIT${ANSI.reset}`
        : `daily loss ${formatUsd(-liveSummary.dailyLossUsd)} / ${formatUsd(-CONFIG.live.maxDailyLossUsd)}`;
      const livePositionLine = currentLivePosition
        ? `${currentLivePosition.side} ${formatShares(currentLivePosition.shares)} @ ${formatTokenPrice(currentLivePosition.entryPrice)} | mark ${formatTokenPrice(currentLivePosition.markPrice)} | uPnL ${formatUsd(currentLivePosition.unrealizedPnl)} | order ${currentLivePosition.orderId ?? "-"}`
        : `${ANSI.gray}none${ANSI.reset}`;
      const liveSummaryLine = liveState.enabled
        ? `realized ${formatUsd(liveSummary.realizedPnl)} | W/L ${liveSummary.wins}/${liveSummary.losses} | ${liveDailyBar}`
        : `${ANSI.gray}not enabled${ANSI.reset}`;
      const lastOrderLine = lastOrderAttempt === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : lastOrderAttempt.opened
          ? `${ANSI.green}PLACED${ANSI.reset} ${lastOrderAttempt.side} ${formatShares(lastOrderAttempt.shares)} @ ${formatTokenPrice(lastOrderAttempt.entryPrice)} | $${formatNumber(lastOrderAttempt.totalCost, 2)} | id ${lastOrderAttempt.orderId ?? "-"} | ${lastOrderAttempt.timestamp}`
          : `${ANSI.red}FAILED${ANSI.reset} ${lastOrderAttempt.side} — ${lastOrderAttempt.reason} | ${lastOrderAttempt.timestamp}`;

      const lines = [
        titleLine,
        kv("Market:", activeMarketSlug || trackedMarketState?.slug || "-"),
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        kv("Strike:", strikeLine),
        kv("Reference:", `${currentPriceValue} (${strikeDeltaText})`),
        "",
        sepLine(),
        "",
        kv("Model:", modelValue),
        kv("Distance:", Number.isFinite(settlementModel.distanceToStrike) ? `${formatUsd(settlementModel.distanceToStrike)} (${formatPct(settlementModel.distancePct, 2)})` : "-"),
        kv("Realized vol:", Number.isFinite(realizedVol.sigmaPct1m) ? `${formatPct(realizedVol.sigmaPct1m, 3)} / min` : "-"),
        kv("Drift:", Number.isFinite(drift.driftPctPerMinute) ? `${formatPct(drift.driftPctPerMinute, 3)} / min` : "-"),
        kv("Decision:", actionValue),
        kv("UP cand.:", upCandidateValue),
        kv("DOWN cand.:", downCandidateValue),
        "",
        sepLine(),
        "",
        kv("Polymarket:", marketValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        kv("Reference age:", referenceAgeMs !== null ? `${Math.round(referenceAgeMs)} ms` : "-"),
        kv("Binance:", binanceValue),
        "",
        sepLine(),
        "",
        kv("Paper pos.:", paperPositionLine),
        kv("Paper acct.:", paperSummaryLine),
        "",
        sepLine(),
        "",
        kv("Live mode:", liveModeLabel),
        kv("Live pos.:", livePositionLine),
        kv("Live acct.:", liveSummaryLine),
        kv("Last order:", lastOrderLine),
        "",
        sepLine(),
        "",
        kv("Regime:", regimeInfo.regime),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        "",
        sepLine(),
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        centerText(`${ANSI.dim}${ANSI.gray}DexorynLabs · Dexoryn${ANSI.reset}`, screenWidth())
      ].filter((line) => line !== null);

      renderScreen(lines.join("\n") + "\n");

      prevSpotPrice = Number.isFinite(spotPrice) ? spotPrice : prevSpotPrice;
      prevCurrentPrice = Number.isFinite(currentPrice) ? currentPrice : prevCurrentPrice;
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
