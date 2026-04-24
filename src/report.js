import fs from "node:fs";
import { CONFIG } from "./config.js";

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function formatUsd(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(digits)}`;
}

function formatPct(value, digits = 1) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function byTimestampAsc(a, b) {
  return String(a?.timestamp ?? "").localeCompare(String(b?.timestamp ?? ""));
}

function buildMarketSummaries(trades, results) {
  const resultByMarket = new Map(results.map((result) => [result.marketSlug, result]));
  const marketMap = new Map();

  for (const trade of [...trades].sort(byTimestampAsc)) {
    const slug = trade.marketSlug;
    if (!slug) continue;

    let summary = marketMap.get(slug);
    if (!summary) {
      summary = {
        marketSlug: slug,
        openedAt: null,
        settledAt: null,
        side: null,
        shares: null,
        strikePrice: null,
        entryPrice: null,
        probability: null,
        totalCost: null,
        lastMarkPrice: null,
        lastUnrealizedPnl: null,
        realizedPnl: null,
        winningSide: null,
        finalReferencePrice: null
      };
      marketMap.set(slug, summary);
    }

    if (trade.event === "OPEN") {
      summary.openedAt = trade.timestamp ?? summary.openedAt;
      summary.side = trade.side ?? summary.side;
      summary.shares = trade.shares ?? summary.shares;
      summary.strikePrice = trade.strikePrice ?? summary.strikePrice;
      summary.entryPrice = trade.entryPrice ?? summary.entryPrice;
      summary.probability = trade.probability ?? summary.probability;
      summary.totalCost = trade.totalCost ?? summary.totalCost;
    }

    if (trade.event === "MARK") {
      summary.lastMarkPrice = trade.markPrice ?? summary.lastMarkPrice;
      summary.lastUnrealizedPnl = trade.unrealizedPnl ?? summary.lastUnrealizedPnl;
    }

    if (trade.event === "SETTLE") {
      summary.settledAt = trade.timestamp ?? summary.settledAt;
      summary.realizedPnl = trade.realizedPnl ?? summary.realizedPnl;
      summary.winningSide = trade.winningSide ?? summary.winningSide;
      summary.finalReferencePrice = trade.finalReferencePrice ?? summary.finalReferencePrice;
    }

    const result = resultByMarket.get(slug);
    if (result) {
      summary.winningSide = result.winningSide ?? summary.winningSide;
      summary.finalReferencePrice = result.finalReferencePrice ?? summary.finalReferencePrice;
    }
  }

  return [...marketMap.values()].sort((a, b) => String(b.openedAt ?? "").localeCompare(String(a.openedAt ?? "")));
}

function summarizeTrades(trades, results) {
  const settles = trades.filter((trade) => trade.event === "SETTLE");
  const opens = trades.filter((trade) => trade.event === "OPEN");
  const latestCash = [...trades].reverse().find((trade) => Number.isFinite(trade.cashBalance))?.cashBalance ?? CONFIG.paper.startingCash;
  const totalRealizedPnl = settles.reduce((sum, trade) => sum + (Number(trade.realizedPnl) || 0), 0);
  const wins = settles.filter((trade) => (Number(trade.realizedPnl) || 0) > 0).length;
  const losses = settles.filter((trade) => (Number(trade.realizedPnl) || 0) < 0).length;
  const pushes = settles.length - wins - losses;
  const openMarkets = new Set(opens.map((trade) => trade.marketSlug));
  for (const settle of settles) {
    openMarkets.delete(settle.marketSlug);
  }

  const marketSummaries = buildMarketSummaries(trades, results);
  const bestTrade = settles.length ? [...settles].sort((a, b) => (Number(b.realizedPnl) || 0) - (Number(a.realizedPnl) || 0))[0] : null;
  const worstTrade = settles.length ? [...settles].sort((a, b) => (Number(a.realizedPnl) || 0) - (Number(b.realizedPnl) || 0))[0] : null;

  return {
    opens,
    settles,
    totalRealizedPnl,
    wins,
    losses,
    pushes,
    winRate: settles.length ? wins / settles.length : null,
    averagePnl: settles.length ? totalRealizedPnl / settles.length : null,
    latestCash,
    openMarkets,
    marketSummaries,
    bestTrade,
    worstTrade
  };
}

function printReport(summary) {
  console.log("Paper Trading Report");
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log("");
  console.log(`Opened trades: ${summary.opens.length}`);
  console.log(`Settled trades: ${summary.settles.length}`);
  console.log(`Open markets: ${summary.openMarkets.size}`);
  console.log(`Wins / losses / pushes: ${summary.wins} / ${summary.losses} / ${summary.pushes}`);
  console.log(`Win rate: ${formatPct(summary.winRate)}`);
  console.log(`Total realized PnL: ${formatUsd(summary.totalRealizedPnl)}`);
  console.log(`Average realized PnL: ${formatUsd(summary.averagePnl)}`);
  console.log(`Latest cash balance: ${formatUsd(summary.latestCash)}`);
  if (summary.bestTrade) {
    console.log(`Best trade: ${summary.bestTrade.marketSlug} ${formatUsd(Number(summary.bestTrade.realizedPnl) || 0)}`);
  }
  if (summary.worstTrade) {
    console.log(`Worst trade: ${summary.worstTrade.marketSlug} ${formatUsd(Number(summary.worstTrade.realizedPnl) || 0)}`);
  }

  console.log("");
  console.log("Per-market results");

  if (summary.marketSummaries.length === 0) {
    console.log("No paper-trade history found.");
    return;
  }

  for (const market of summary.marketSummaries) {
    const status = market.settledAt ? "SETTLED" : "OPEN";
    const pnl = market.settledAt ? formatUsd(Number(market.realizedPnl)) : formatUsd(Number(market.lastUnrealizedPnl));
    const outcome = market.winningSide ? ` winner=${market.winningSide}` : "";
    console.log(
      `- ${market.marketSlug} | ${status} | side=${market.side ?? "-"} | entry=${formatNumber(Number(market.entryPrice), 4)} | pnl=${pnl}${outcome}`
    );
  }
}

function main() {
  const trades = readJsonLines(CONFIG.logs.tradesPath);
  const results = readJsonLines(CONFIG.logs.resultsPath);

  if (trades.length === 0) {
    console.log("No paper trade log found yet.");
    console.log(`Expected file: ${CONFIG.logs.tradesPath}`);
    process.exit(0);
  }

  const summary = summarizeTrades(trades, results);
  printReport(summary);
}

main();
