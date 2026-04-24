export const TRADE_HEADER = [
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
] as const;

export type PaperEvent =
  | {
      event: "OPEN";
      timestamp: string;
      marketSlug: string;
      side: string;
      shares: number;
      strikePrice: number | null;
      entryPrice: number | null;
      quotedPrice: number | null;
      probability: number | null;
      totalCost: number | null;
      cashBalance: number | null;
    }
  | {
      event: "MARK";
      timestamp: string;
      marketSlug: string;
      side: string;
      shares: number;
      markPrice: number | null;
      probability: number | null;
      unrealizedPnl: number | null;
      cashBalance: number | null;
    }
  | {
      event: "SETTLE";
      timestamp: string;
      marketSlug: string;
      side: string;
      winningSide: string | null;
      shares: number;
      finalReferencePrice: number | null;
      payout: number | null;
      realizedPnl: number | null;
      cashBalance: number | null;
    };

export type HistoryRow = {
  timestamp: string;
  action: "Buy" | "Settle";
  marketSlug: string;
  side: string;
  shares: number | null;
  priceNote: string;
  cost: number | null;
  payout: number | null;
  realizedPnl: number | null;
  unrealizedAtClose: number | null;
  cashBalance: number | null;
  winningSide: string | null;
  strikePrice: number | null;
};

export type ChartPoint = { t: string; ms: number; value: number };

function num(s: string | number | undefined | null): number | null {
  if (s === undefined || s === null || s === "") return null;
  const n = typeof s === "number" ? s : Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseJsonlContent(raw: string): PaperEvent[] {
  const events: PaperEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      const e = normalizeFromJson(o);
      if (e) events.push(e);
    } catch {
      /* skip bad line */
    }
  }
  return events;
}

function normalizeFromJson(o: Record<string, unknown>): PaperEvent | null {
  const event = o.event;
  const timestamp = String(o.timestamp ?? "");
  const marketSlug = String(o.marketSlug ?? "");
  if (!timestamp || !marketSlug) return null;

  if (event === "OPEN") {
    return {
      event: "OPEN",
      timestamp,
      marketSlug,
      side: String(o.side ?? ""),
      shares: Number(o.shares) || 0,
      strikePrice: num(o.strikePrice as string | number | undefined),
      entryPrice: num(o.entryPrice as string | number | undefined),
      quotedPrice: num(o.quotedPrice as string | number | undefined),
      probability: num(o.probability as string | number | undefined),
      totalCost: num(o.totalCost as string | number | undefined),
      cashBalance: num(o.cashBalance as string | number | undefined)
    };
  }
  if (event === "MARK") {
    return {
      event: "MARK",
      timestamp,
      marketSlug,
      side: String(o.side ?? ""),
      shares: Number(o.shares) || 0,
      markPrice: num(o.markPrice as string | number | undefined),
      probability: num(o.probability as string | number | undefined),
      unrealizedPnl: num(o.unrealizedPnl as string | number | undefined),
      cashBalance: num(o.cashBalance as string | number | undefined)
    };
  }
  if (event === "SETTLE") {
    return {
      event: "SETTLE",
      timestamp,
      marketSlug,
      side: String(o.side ?? ""),
      winningSide: o.winningSide != null ? String(o.winningSide) : null,
      shares: Number(o.shares) || 0,
      finalReferencePrice: num(o.finalReferencePrice as string | number | undefined),
      payout: num(o.payout as string | number | undefined),
      realizedPnl: num(o.realizedPnl as string | number | undefined),
      cashBalance: num(o.cashBalance as string | number | undefined)
    };
  }
  return null;
}

function parseCsvLine(line: string): string[] {
  return line.split(",");
}

function rowToEvent(cols: string[]): PaperEvent | null {
  if (cols.length < 14) return null;
  const event = cols[1];
  const timestamp = cols[0];
  const marketSlug = cols[2];
  if (event === "OPEN") {
    return {
      event: "OPEN",
      timestamp,
      marketSlug,
      side: cols[3],
      shares: num(cols[4]) ?? 0,
      strikePrice: num(cols[5]),
      entryPrice: num(cols[6]),
      quotedPrice: null,
      probability: num(cols[8]),
      totalCost: num(cols[9]),
      cashBalance: num(cols[13])
    };
  }
  if (event === "MARK") {
    return {
      event: "MARK",
      timestamp,
      marketSlug,
      side: cols[3],
      shares: num(cols[4]) ?? 0,
      markPrice: num(cols[7]),
      probability: num(cols[8]),
      unrealizedPnl: num(cols[11]),
      cashBalance: num(cols[13])
    };
  }
  if (event === "SETTLE") {
    return {
      event: "SETTLE",
      timestamp,
      marketSlug,
      side: cols[3],
      winningSide: null,
      shares: num(cols[4]) ?? 0,
      finalReferencePrice: null,
      payout: num(cols[10]),
      realizedPnl: num(cols[12]),
      cashBalance: num(cols[13])
    };
  }
  return null;
}

export function parsePaperTradesCsvContent(raw: string): PaperEvent[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  let start = 0;
  if (lines[0].includes("timestamp") && lines[0].includes("event")) start = 1;
  const out: PaperEvent[] = [];
  for (let i = start; i < lines.length; i++) {
    const e = rowToEvent(parseCsvLine(lines[i]));
    if (e) out.push(e);
  }
  return out;
}

function byTime(a: PaperEvent, b: PaperEvent) {
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function buildPaperPayload(events: PaperEvent[], source: "jsonl" | "csv") {
  const sorted = [...events].sort(byTime);
  const costByMarket = new Map<string, number>();
  let totalRealized = 0;
  let wins = 0;
  let losses = 0;
  const settledSlugs = new Set<string>();
  const openSlugs = new Set<string>();

  const history: HistoryRow[] = [];

  for (const e of sorted) {
    if (e.event === "OPEN") {
      if (e.totalCost != null) costByMarket.set(e.marketSlug, e.totalCost);
      openSlugs.add(e.marketSlug);
      history.push({
        timestamp: e.timestamp,
        action: "Buy",
        marketSlug: e.marketSlug,
        side: e.side,
        shares: e.shares,
        priceNote:
          e.entryPrice != null
            ? `@ ${e.entryPrice.toFixed(4)}`
            : e.quotedPrice != null
              ? `@ ~${e.quotedPrice.toFixed(4)}`
              : "—",
        cost: e.totalCost,
        payout: null,
        realizedPnl: null,
        unrealizedAtClose: null,
        cashBalance: e.cashBalance,
        winningSide: null,
        strikePrice: e.strikePrice
      });
    } else if (e.event === "SETTLE") {
      settledSlugs.add(e.marketSlug);
      openSlugs.delete(e.marketSlug);
      const rp = e.realizedPnl ?? 0;
      totalRealized += rp;
      if (rp > 0) wins += 1;
      else if (rp < 0) losses += 1;
      history.push({
        timestamp: e.timestamp,
        action: "Settle",
        marketSlug: e.marketSlug,
        side: e.side,
        shares: e.shares,
        priceNote:
          e.finalReferencePrice != null ? `ref ${e.finalReferencePrice.toFixed(2)}` : "—",
        cost: null,
        payout: e.payout,
        realizedPnl: e.realizedPnl,
        unrealizedAtClose: null,
        cashBalance: e.cashBalance,
        winningSide: e.winningSide,
        strikePrice: null
      });
    }
  }

  const latestCash =
    [...sorted].reverse().find((x) => x.cashBalance != null)?.cashBalance ?? null;

  const cumulativeRealized: ChartPoint[] = [];
  let cum = 0;
  const firstTs = sorted[0]?.timestamp;
  if (firstTs) {
    cumulativeRealized.push({ t: firstTs, ms: new Date(firstTs).getTime(), value: 0 });
  }
  for (const e of sorted) {
    if (e.event !== "SETTLE") continue;
    cum += e.realizedPnl ?? 0;
    cumulativeRealized.push({
      t: e.timestamp,
      ms: new Date(e.timestamp).getTime(),
      value: cum
    });
  }

  const equityRaw: ChartPoint[] = [];
  for (const e of sorted) {
    const ms = new Date(e.timestamp).getTime();
    if (e.event === "OPEN") {
      const c = e.cashBalance;
      const tc = e.totalCost;
      if (c != null && tc != null) {
        equityRaw.push({ t: e.timestamp, ms, value: c + tc });
      }
    } else if (e.event === "MARK") {
      const c = e.cashBalance;
      const u = e.unrealizedPnl;
      const tc = costByMarket.get(e.marketSlug);
      if (c != null && u != null && tc != null) {
        equityRaw.push({ t: e.timestamp, ms, value: c + u + tc });
      }
    } else if (e.event === "SETTLE") {
      const c = e.cashBalance;
      if (c != null) equityRaw.push({ t: e.timestamp, ms, value: c });
    }
  }

  const equity = downsample(equityRaw, 2500);

  history.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    source,
    summary: {
      totalRealizedPnl: totalRealized,
      settledCount: settledSlugs.size,
      openPositions: openSlugs.size,
      wins,
      losses,
      latestCash,
      markTicks: sorted.filter((x) => x.event === "MARK").length
    },
    history,
    chart: {
      cumulativeRealized,
      equity
    }
  };
}
