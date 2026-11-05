"use client";

import { formatPct, formatUsd } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Avatar, EmptyState, PageTitle, Pct, RowSkeletons } from "@/components/ui";
import { api } from "@/lib/api";

export default function LeaderboardPage() {
  const query = useQuery({ queryKey: ["leaderboard"], queryFn: () => api.leaderboard(), refetchInterval: 60_000 });
  return (
    <div>
      <PageTitle>Accuracy leaderboard</PageTitle>
      <p className="px-4 pb-3 text-sm text-muted">
        Ranked by how often a verified thesis called it, at the author's sale price or 24 hours later, not by who has the most money. Takes {query.data?.minResolved ?? 5} resolved theses to qualify.
      </p>
      {query.isLoading ? (
        <RowSkeletons />
      ) : query.data?.items.length ? (
        <ol className="divide-y divide-line/60">
          {query.data.items.map((row) => (
            <li key={row.user.id}>
              <Link href={`/u/${row.user.username}`} className="flex items-center gap-3 px-4 py-3">
                <span className="num w-6 text-center text-sm text-muted">{row.rank}</span>
                <Avatar user={row.user} size={34} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{row.user.username}</p>
                  <p className="num text-xs text-muted">
                    {row.right} of {row.resolved} right · avg <Pct value={row.avgReturnPct} />
                  </p>
                </div>
                <div className="text-right">
                  <p className="num text-lg font-semibold text-signal">{formatPct(row.accuracy, { sign: false })}</p>
                  <p className="num text-xs text-muted">{formatUsd(row.realizedPnlUsd, { sign: true })}</p>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title="No one has qualified yet" body="A thesis closes when its author sells out, or 24 hours after posting, so the board fills up as they do." />
      )}
    </div>
  );
}
