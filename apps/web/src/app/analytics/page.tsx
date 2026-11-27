"use client";

import { CHAINS, D, formatUsd, timeAgo, type StatsBucket, type StatsTotals, type StatsView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { bucketLabel, ColumnChart } from "@/components/stats-chart";
import { ChainLogo, EmptyState, PageTitle, RowSkeletons, Segmented, TokenIcon } from "@/components/ui";
import { api } from "@/lib/api";

type Range = "24h" | "7d" | "30d" | "all";

function bucketsFor(stats: StatsView, range: Range): StatsBucket[] {
  if (range === "24h") return stats.hourly;
  if (range === "7d") return stats.daily.slice(-7);
  if (range === "30d") return stats.daily.slice(-30);
  const first = stats.firstTradeAt ? `${stats.firstTradeAt.slice(0, 10)}T00:00:00.000Z` : null;
  const since = first ? stats.daily.filter((b) => new Date(b.at) >= new Date(first)) : [];
  return since.length ? since : stats.daily.slice(-30);
}

function sum(buckets: StatsBucket[], field: "volumeUsd" | "revenueUsd"): string {
  return buckets.reduce((total, b) => total.add(b[field]), D(0)).toFixed();
}

/** A number that catches the eye when it changes, and sits still until then. */
function LiveNumber({ text, className = "" }: { text: string; className?: string }) {
  const [seen, setSeen] = useState({ text, changes: 0 });
  if (seen.text !== text) setSeen({ text, changes: seen.changes + 1 });
  return (
    <span key={seen.changes} className={`num ${seen.changes ? "animate-flash-up" : ""} ${className}`}>
      {text}
    </span>
  );
}

function LiveBadge({ failing }: { failing: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
      <span className={`h-2 w-2 rounded-full ${failing ? "bg-warn" : "animate-pulse bg-up"}`} />
      {failing ? "Reconnecting" : "Live"}
    </span>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <LiveNumber text={value} className="mt-1 block text-xl font-semibold" />
    </div>
  );
}

function Headline({ label, totals, field }: { label: string; totals: StatsTotals; field: "volumeUsd" | "revenueUsd" }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 md:p-5">
      <p className="text-sm text-muted">{label}</p>
      <LiveNumber text={formatUsd(totals[field])} className="mt-1 block text-3xl font-semibold tracking-tight md:text-5xl" />
    </div>
  );
}

function ByChain({ stats }: { stats: StatsView }) {
  const top = Number(stats.byChain[0]?.volumeUsd ?? 0);
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-muted">Volume by chain</h2>
      <ul className="mt-3 space-y-3.5">
        {stats.byChain.map((c) => (
          <li key={c.chain}>
            <div className="flex items-center gap-2 text-sm">
              <ChainLogo chain={c.chain} size={16} />
              <span className="min-w-0 flex-1 truncate font-medium">{CHAINS[c.chain]?.name ?? c.chain}</span>
              <span className="num font-medium">{formatUsd(c.volumeUsd)}</span>
            </div>
            <div className="mt-1.5 h-1.5">
              <div className="h-full rounded-r bg-signal" style={{ width: `${top > 0 ? Math.max((Number(c.volumeUsd) / top) * 100, 1) : 0}%` }} />
            </div>
            <p className="num mt-1 text-xs text-muted">
              {c.trades} {c.trades === 1 ? "trade" : "trades"} · {formatUsd(c.revenueUsd)} earned
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentTrades({ stats }: { stats: StatsView }) {
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <h2 className="px-4 pt-4 pb-2 text-sm font-medium text-muted">Latest trades</h2>
      <ul className="divide-y divide-line/40">
        {stats.recent.map((r) => (
          <li key={r.id}>
            <Link href={`/token/${r.token.chain}/${r.token.address}`} className="flex items-center gap-2.5 px-4 py-2.5">
              <span className="relative shrink-0">
                <TokenIcon symbol={r.token.symbol} imageUrl={r.token.imageUrl} size={30} />
                <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-surface">
                  <ChainLogo chain={r.token.chain} size={13} />
                </span>
              </span>
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                <span className={r.side === "buy" ? "text-up" : "text-down"}>{r.side === "buy" ? "Bought" : "Sold"}</span> {r.token.symbol}
              </p>
              <span className="num text-sm font-medium">{formatUsd(r.amountUsd)}</span>
              <span className="w-8 text-right text-xs text-faint">{timeAgo(r.filledAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PeriodTable({ buckets, hourly }: { buckets: StatsBucket[]; hourly: boolean }) {
  const rows = buckets.filter((b) => b.trades > 0).reverse();
  return (
    <details className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-muted">View as a table</summary>
      {rows.length ? (
        <table className="mt-3 w-full text-left">
          <thead>
            <tr className="text-xs text-muted">
              <th className="pb-1.5 font-medium">{hourly ? "Hour" : "Day"}</th>
              <th className="pb-1.5 text-right font-medium">Volume</th>
              <th className="pb-1.5 text-right font-medium">Revenue</th>
              <th className="pb-1.5 text-right font-medium">Trades</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((b) => (
              <tr key={b.at} className="border-t border-line/40">
                <td className="py-1.5">{bucketLabel(b.at, hourly)}</td>
                <td className="py-1.5 text-right">{formatUsd(b.volumeUsd)}</td>
                <td className="py-1.5 text-right">{formatUsd(b.revenueUsd)}</td>
                <td className="py-1.5 text-right">{b.trades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-xs text-faint">Nothing in this period yet.</p>
      )}
    </details>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 pt-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-xs text-muted">{note}</p>
      </div>
      {children}
    </section>
  );
}

function BarList({ title, rows }: { title: string; rows: Array<{ label: string; value: string; detail: string }> }) {
  const top = Math.max(0, ...rows.map((r) => Number(r.value)));
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h3 className="text-sm font-medium text-muted">{title}</h3>
      {rows.length ? (
        <ul className="mt-3 space-y-3.5">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                <span className="num font-medium">{formatUsd(r.value)}</span>
              </div>
              <div className="mt-1.5 h-1.5">
                <div className="h-full rounded-r bg-signal" style={{ width: `${top > 0 ? Math.max((Number(r.value) / top) * 100, 1) : 0}%` }} />
              </div>
              <p className="num mt-1 text-xs text-muted">{r.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-faint">Nothing yet.</p>
      )}
    </section>
  );
}

function PerpsSection({ stats }: { stats: StatsView }) {
  const p = stats.perps;
  const buckets: StatsBucket[] = p.daily.map((d) => ({ at: d.at, volumeUsd: d.volumeUsd, revenueUsd: "0", trades: d.positions }));
  return (
    <Section title="Perps" note="Positions opened on Veranta through Front Run. Volume is position size, collateral times leverage, counted once when a position opens.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Perps volume" value={formatUsd(p.allTime.volumeUsd)} />
        <Tile label="Perps volume, 24h" value={formatUsd(p.last24h.volumeUsd)} />
        <Tile label="Open interest" value={formatUsd(p.openInterestUsd)} />
        <Tile label="Long / short" value={p.longPct === null ? "-" : `${Math.round(p.longPct)}% / ${Math.round(100 - p.longPct)}%`} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ColumnChart title="Perps volume, 30 days" total={formatUsd(sum(buckets, "volumeUsd"))} buckets={buckets} field="volumeUsd" hourly={false} />
        <BarList
          title="Top markets"
          rows={p.markets.map((m) => ({ label: m.symbol, value: m.volumeUsd, detail: `${m.positions} ${m.positions === 1 ? "position" : "positions"}` }))}
        />
      </div>
      <p className="text-xs text-muted">
        {p.allTime.positions.toLocaleString("en-US")} positions by {p.allTime.traders.toLocaleString("en-US")} traders, {formatUsd(p.allTime.realizedPnlUsd, { sign: true })} realized between them. {p.openPositions} open now.
      </p>
    </Section>
  );
}

function LendingSection({ stats }: { stats: StatsView }) {
  const l = stats.lending;
  return (
    <Section title="Lending" note="Moves made through Front Run on Aave and Morpho. Net is what went in minus what came out, before interest.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Net lent" value={formatUsd(l.netSuppliedUsd)} />
        <Tile label="Net borrowed" value={formatUsd(l.netBorrowedUsd)} />
        <Tile label="Lending moves" value={l.moves.toLocaleString("en-US")} />
        <Tile label="People lending" value={l.users.toLocaleString("en-US")} />
      </div>
      <BarList
        title="By market"
        rows={l.markets.map((m) => ({
          label: m.name,
          value: m.netSuppliedUsd,
          detail: `${m.moves} ${m.moves === 1 ? "move" : "moves"}${Number(m.netBorrowedUsd) > 0 ? ` · ${formatUsd(m.netBorrowedUsd)} borrowed` : ""}`,
        }))}
      />
    </Section>
  );
}

function AgentsSection({ stats }: { stats: StatsView }) {
  const a = stats.agents;
  return (
    <Section title="AI agents" note="What agents did on their own, with their owners' limits. Every agent's moves and reasons are public on its profile.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Active agents" value={a.traders.toLocaleString("en-US")} />
        <Tile label="Agent trades" value={a.spotTrades.toLocaleString("en-US")} />
        <Tile label="Agent perps" value={a.perpsOpened.toLocaleString("en-US")} />
        <Tile label="Agent lending moves" value={a.lendingMoves.toLocaleString("en-US")} />
      </div>
    </Section>
  );
}

/** Public, so anyone can see how the app is doing. A fill anywhere refreshes it straight away; the timer is a backstop. */
export default function AnalyticsPage() {
  const [range, setRange] = useState<Range>("7d");
  const query = useQuery({ queryKey: ["stats"], queryFn: () => api.stats(), refetchInterval: 15_000 });
  const stats = query.data;
  const buckets = stats ? bucketsFor(stats, range) : [];
  const hourly = range === "24h";
  return (
    <div>
      <PageTitle right={<LiveBadge failing={query.isError} />}>Analytics</PageTitle>
      {!stats ? (
        query.isError ? <EmptyState title="Analytics can't load right now" body="It'll try again on its own." /> : <RowSkeletons count={6} />
      ) : (
        <div className="space-y-3 px-4 pb-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Headline label="Total volume" totals={stats.allTime} field="volumeUsd" />
            <Headline label="Total revenue" totals={stats.allTime} field="revenueUsd" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Volume, 24h" value={formatUsd(stats.last24h.volumeUsd)} />
            <Tile label="Revenue, 24h" value={formatUsd(stats.last24h.revenueUsd)} />
            <Tile label="Trades" value={stats.allTime.trades.toLocaleString("en-US")} />
            <Tile label="Traders" value={stats.allTime.traders.toLocaleString("en-US")} />
          </div>
          <p className="text-xs text-muted">Volume is every completed spot buy and sell; perps and lending have their own sections below. Revenue is the app's own fee on those trades. Days are in UTC.</p>
          <Segmented
            value={range}
            onChange={setRange}
            options={[
              { value: "24h", label: "24H" },
              { value: "7d", label: "7D" },
              { value: "30d", label: "30D" },
              { value: "all", label: "All" },
            ]}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <ColumnChart title="Volume" total={formatUsd(sum(buckets, "volumeUsd"))} buckets={buckets} field="volumeUsd" hourly={hourly} />
            <ColumnChart title="Revenue" total={formatUsd(sum(buckets, "revenueUsd"))} buckets={buckets} field="revenueUsd" hourly={hourly} />
          </div>
          <PeriodTable buckets={buckets} hourly={hourly} />
          {stats.allTime.trades > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              <ByChain stats={stats} />
              <RecentTrades stats={stats} />
            </div>
          )}
          <PerpsSection stats={stats} />
          <LendingSection stats={stats} />
          <AgentsSection stats={stats} />
        </div>
      )}
    </div>
  );
}
