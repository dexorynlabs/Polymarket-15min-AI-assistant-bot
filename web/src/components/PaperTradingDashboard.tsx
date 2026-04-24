"use client";

import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type ApiPayload = {
  source: string;
  summary: {
    totalRealizedPnl: number;
    settledCount: number;
    openPositions: number;
    wins: number;
    losses: number;
    latestCash: number | null;
    markTicks: number;
  };
  history: Array<{
    timestamp: string;
    action: "Buy" | "Settle";
    marketSlug: string;
    side: string;
    shares: number | null;
    priceNote: string;
    cost: number | null;
    payout: number | null;
    realizedPnl: number | null;
    cashBalance: number | null;
    winningSide: string | null;
    strikePrice: number | null;
  }>;
  chart: {
    cumulativeRealized: Array<{ t: string; ms: number; value: number }>;
    equity: Array<{ t: string; ms: number; value: number }>;
  };
  pathUsed: string | null;
  error?: string;
};

function fmtUsd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "" : "−";
  return `${sign}$${Math.abs(n).toFixed(digits)}`;
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch {
    return iso;
  }
}

export function PaperTradingDashboard() {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch("/api/trades", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: ApiPayload & { error?: string }) => {
        if (j.error) setErr(j.error);
        else {
          setErr(null);
          setData(j);
        }
      })
      .catch(() => setErr("Request failed"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const combined = data
    ? (() => {
        const eqPts = data.chart.equity;
        const cumPts = data.chart.cumulativeRealized;
        const msSet = new Set<number>();
        for (const p of eqPts) msSet.add(p.ms);
        for (const p of cumPts) msSet.add(p.ms);
        const timeline = [...msSet].sort((a, b) => a - b);
        const eqMap = new Map(eqPts.map((p) => [p.ms, p.value]));
        const cumMap = new Map(cumPts.map((p) => [p.ms, p.value]));
        let fillCum = 0;
        return timeline.map((ms) => {
          if (cumMap.has(ms)) fillCum = cumMap.get(ms)!;
          return {
            ms,
            t: new Date(ms).toISOString(),
            equity: eqMap.has(ms) ? eqMap.get(ms)! : (null as number | null),
            cum: fillCum
          };
        });
      })()
    : [];

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-8 text-zinc-400">
        Loading paper trading data…
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/30 p-6 text-red-200">
        {err}
      </div>
    );
  }

  if (!data || data.source === "none") {
    return (
      <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-6 text-amber-100">
        <p className="font-medium">No paper trades found.</p>
        <p className="mt-2 text-sm text-amber-200/80">
          Run the bot from the repo root so it writes{" "}
          <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">
            logs/paper_trades.jsonl
          </code>{" "}
          (or{" "}
          <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">
            logs/paper_trades.csv
          </code>
          ), then refresh.           Start the dashboard from the{" "}
          <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">web</code> folder:{" "}
          <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-xs">npm run dev</code>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-2 border-b border-zinc-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
            Paper trading
          </h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">
            Source: {data.source} · {data.pathUsed ?? "—"}
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="self-start rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Realized PnL" value={fmtUsd(data.summary.totalRealizedPnl)} accent />
        <Stat label="Cash (latest)" value={fmtUsd(data.summary.latestCash)} />
        <Stat
          label="Settled / open"
          value={`${data.summary.settledCount} / ${data.summary.openPositions}`}
        />
        <Stat label="W / L" value={`${data.summary.wins} / ${data.summary.losses}`} />
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
        <h2 className="mb-1 text-sm font-medium text-zinc-300">Equity &amp; cumulative realized</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Green area: account equity (cash + open position value). Orange line: cumulative realized
          PnL at each settlement. Mark ticks in log: {data.summary.markTicks.toLocaleString()}.
        </p>
        <div className="h-[340px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={combined} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                dataKey="ms"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ms) =>
                  new Date(ms).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit"
                  })
                }
                stroke="#71717a"
                fontSize={11}
              />
              <YAxis
                yAxisId="left"
                stroke="#22c55e"
                fontSize={11}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#fb923c"
                fontSize={11}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
              />
              <Tooltip
                contentStyle={{
                  background: "#18181b",
                  border: "1px solid #3f3f46",
                  borderRadius: "8px"
                }}
                labelFormatter={(_label, payload) => {
                  const row = payload?.[0]?.payload as { t?: string } | undefined;
                  return row?.t ? fmtTime(row.t) : "";
                }}
                formatter={(value, name) => {
                  const n =
                    typeof value === "number"
                      ? value
                      : typeof value === "string"
                        ? parseFloat(value)
                        : Number(value);
                  return [fmtUsd(Number.isFinite(n) ? n : 0), String(name)];
                }}
              />
              <Legend />
              <Area
                yAxisId="left"
                type="stepAfter"
                dataKey="equity"
                name="Equity"
                stroke="#22c55e"
                fill="rgba(34, 197, 94, 0.15)"
                connectNulls
              />
              <Line
                yAxisId="right"
                type="stepAfter"
                dataKey="cum"
                name="Cum. realized"
                stroke="#fb923c"
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-300">Buy / settle history</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2.5 font-medium">Time</th>
                <th className="px-3 py-2.5 font-medium">Action</th>
                <th className="px-3 py-2.5 font-medium">Market</th>
                <th className="px-3 py-2.5 font-medium">Side</th>
                <th className="px-3 py-2.5 text-right font-medium">Shares</th>
                <th className="px-3 py-2.5 font-medium">Note</th>
                <th className="px-3 py-2.5 text-right font-medium">Cost</th>
                <th className="px-3 py-2.5 text-right font-medium">Payout</th>
                <th className="px-3 py-2.5 text-right font-medium">Realized</th>
                <th className="px-3 py-2.5 text-right font-medium">Cash</th>
              </tr>
            </thead>
            <tbody className="text-zinc-200">
              {data.history.map((row, i) => (
                <tr
                  key={`${row.timestamp}-${row.action}-${i}`}
                  className="border-b border-zinc-800/80 hover:bg-zinc-900/40"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-400">
                    {fmtTime(row.timestamp)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        row.action === "Buy"
                          ? "rounded bg-emerald-950/80 px-2 py-0.5 text-emerald-300"
                          : "rounded bg-violet-950/80 px-2 py-0.5 text-violet-200"
                      }
                    >
                      {row.action}
                    </span>
                  </td>
                  <td className="max-w-[200px] truncate px-3 py-2 font-mono text-xs" title={row.marketSlug}>
                    {row.marketSlug}
                  </td>
                  <td className="px-3 py-2">{row.side}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {row.shares != null ? row.shares.toFixed(2) : "—"}
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-2 text-xs text-zinc-400" title={row.priceNote}>
                    {row.priceNote}
                    {row.winningSide ? ` · winner ${row.winningSide}` : ""}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmtUsd(row.cost)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmtUsd(row.payout)}</td>
                  <td
                    className={`px-3 py-2 text-right font-mono text-xs ${
                      row.realizedPnl != null && row.realizedPnl >= 0
                        ? "text-emerald-400"
                        : row.realizedPnl != null
                          ? "text-red-400"
                          : ""
                    }`}
                  >
                    {fmtUsd(row.realizedPnl)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                    {fmtUsd(row.cashBalance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  accent
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        accent
          ? "border-emerald-900/50 bg-emerald-950/20"
          : "border-zinc-800 bg-zinc-950/60"
      }`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div
        className={`mt-1 font-mono text-lg ${
          accent ? "text-emerald-300" : "text-zinc-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
