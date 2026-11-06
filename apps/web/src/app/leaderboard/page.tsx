"use client";

import { formatUsd, type LeaderboardRow } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Avatar, EmptyState, PageTitle, Pct, RowSkeletons } from "@/components/ui";
import { api } from "@/lib/api";

function Row({ row }: { row: LeaderboardRow }) {
  return (
    <li>
      <Link href={`/u/${row.user.username}`} className="flex items-center gap-3 px-4 py-3">
        <span className="num w-6 text-center text-sm text-muted">{row.provisional ? "–" : row.rank}</span>
        <Avatar user={row.user} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{row.user.username}</p>
          <p className="num text-xs text-muted">
            {row.right} of {row.resolved} in profit · avg <Pct value={row.avgReturnPct} />
          </p>
        </div>
        <div className="text-right">
          <p className={`num text-lg font-semibold ${row.provisional ? "text-muted" : "text-signal"}`}>{row.score}</p>
          <p className="num text-xs text-muted">{formatUsd(row.realizedPnlUsd, { sign: true })}</p>
        </div>
      </Link>
    </li>
  );
}

export default function LeaderboardPage() {
  const query = useQuery({ queryKey: ["leaderboard"], queryFn: () => api.leaderboard(), refetchInterval: 60_000 });
  const minResolved = query.data?.minResolved ?? 5;
  return (
    <div>
      <PageTitle>Reputation Score Leaderboard</PageTitle>
      <p className="px-4 pb-3 text-sm text-muted">
        A score out of 100 from closed positions: how often a verified thesis ended in profit, what it returned, and what it took to get there in drawdown, holding time and fees. It's written to Arc, so any app can read it. Takes {minResolved} closed positions to rank.
      </p>
      {query.isLoading ? (
        <RowSkeletons />
      ) : query.data?.items.length ? (
        <ol className="divide-y divide-line/60">
          {query.data.items.map((row) => (
            <Row key={row.user.id} row={row} />
          ))}
        </ol>
      ) : (
        <EmptyState title="No one has qualified yet" body="A thesis closes when its author sells out, so the board fills up as they do." />
      )}
      {!!query.data?.provisional.length && (
        <section className="mt-4">
          <h2 className="px-4 pb-1 text-sm font-semibold">Building a record</h2>
          <p className="px-4 pb-2 text-xs text-muted">Under {minResolved} closed positions so far, so these scores are provisional and don't rank yet.</p>
          <ul className="divide-y divide-line/60">
            {query.data.provisional.map((row) => (
              <Row key={row.user.id} row={row} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
