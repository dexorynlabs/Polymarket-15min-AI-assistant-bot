import fs from "node:fs";
import path from "node:path";
import {
  buildPaperPayload,
  parseJsonlContent,
  parsePaperTradesCsvContent,
  type ChartPoint,
  type HistoryRow
} from "@/lib/paperTrades";

function resolveLogPaths(cwd: string) {
  if (process.env.PAPER_TRADES_JSONL || process.env.PAPER_TRADES_CSV) {
    return {
      jsonlPath: process.env.PAPER_TRADES_JSONL || "",
      csvPath: process.env.PAPER_TRADES_CSV || ""
    };
  }

  const tryDirs = [path.join(cwd, "logs"), path.join(cwd, "..", "logs")];
  for (const dir of tryDirs) {
    const j = path.join(dir, "paper_trades.jsonl");
    const c = path.join(dir, "paper_trades.csv");
    if (fs.existsSync(j) || fs.existsSync(c)) {
      return { jsonlPath: j, csvPath: c };
    }
  }
  const fallback = path.join(cwd, "..", "logs");
  return {
    jsonlPath: path.join(fallback, "paper_trades.jsonl"),
    csvPath: path.join(fallback, "paper_trades.csv")
  };
}

export function loadPaperTradesFromProjectRoot(cwd: string) {
  const { jsonlPath, csvPath } = resolveLogPaths(cwd);

  if (jsonlPath && fs.existsSync(jsonlPath)) {
    const raw = fs.readFileSync(jsonlPath, "utf8");
    const events = parseJsonlContent(raw);
    if (events.length) return { ...buildPaperPayload(events, "jsonl"), pathUsed: jsonlPath };
  }

  if (csvPath && fs.existsSync(csvPath)) {
    const raw = fs.readFileSync(csvPath, "utf8");
    const events = parsePaperTradesCsvContent(raw);
    if (events.length) return { ...buildPaperPayload(events, "csv"), pathUsed: csvPath };
  }

  return {
    source: "none" as const,
    summary: {
      totalRealizedPnl: 0,
      settledCount: 0,
      openPositions: 0,
      wins: 0,
      losses: 0,
      latestCash: null,
      markTicks: 0
    },
    history: [] as HistoryRow[],
    chart: { cumulativeRealized: [] as ChartPoint[], equity: [] as ChartPoint[] },
    pathUsed: null as string | null
  };
}
