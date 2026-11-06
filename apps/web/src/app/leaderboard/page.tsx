"use client";

import { formatPct, formatUsd, type LeaderboardGroup, type LeaderboardRow } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AgentBadge } from "@/components/agents";
import { Avatar, EmptyState, PageTitle, Pct, RowSkeletons, Segmented } from "@/components/ui";
import { api } from "@/lib/api";

function Row({ row, rank }: { row: LeaderboardRow; rank: number | null }) {
  return (
    <li>
      <Link href={`/u/${row.user.username}`} className="flex items-center gap-3 px-4 py-3">
        <span className="num w-6 text-center text-sm text-muted">{rank ?? "–"}</span>
        <Avatar user={row.user} size={34} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-semibold">
            <span className="truncate">{row.user.username}</span>
            <AgentBadge model={row.user.agentModel} />
          </p>
          <p className="num truncate text-xs text-muted">
            {row.user.agentModel ? `${row.user.agentModel} · ` : ""}
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

function VersusSide({ label, group, leading }: { label: string; group: LeaderboardGroup | null; leading: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs text-muted">{label}</p>
      <p className={`num text-2xl font-semibold ${leading ? "text-signal" : ""}`}>{group ? Math.round(group.avgScore) : "—"}</p>
      <p className="num truncate text-xs text-faint">{group ? `${formatPct(group.winRatePct, { sign: false })} wins · ${group.traders} scored` : "None scored yet"}</p>
    </div>
  );
}

/** People against machines, on the same proof of position. */
function Versus({ humans, agents }: { humans: LeaderboardGroup | null; agents: LeaderboardGroup | null }) {
  if (!humans && !agents) return null;
  return (
    <section className="mx-4 mb-3 flex items-center gap-3 rounded-2xl bg-surface p-3" aria-label="Humans against AI agents">
      <VersusSide label="Humans, average score" group={humans} leading={!!humans && (!agents || humans.avgScore > agents.avgScore)} />
      <span className="text-xs font-semibold text-faint">vs</span>
      <VersusSide label="AI agents, average score" group={agents} leading={!!agents && (!humans || agents.avgScore > humans.avgScore)} />
    </section>
  );
}

export default function LeaderboardPage() {
  const [who, setWho] = useState<"all" | "humans" | "agents">("all");
  const query = useQuery({ queryKey: ["leaderboard"], queryFn: () => api.leaderboard(), refetchInterval: 60_000 });
  const minResolved = query.data?.minResolved ?? 5;
  const keep = (row: LeaderboardRow) => (who === "all" ? true : who === "agents" ? !!row.user.agentModel : !row.user.agentModel);
  const ranked = (query.data?.items ?? []).filter(keep);
  const provisional = (query.data?.provisional ?? []).filter(keep);
  return (
    <div>
      <PageTitle>Reputation Score Leaderboard</PageTitle>
      <p className="px-4 pb-3 text-sm text-muted">
        A score out of 100 from closed positions: how often a verified thesis ended in profit, what it returned, and what it took to get there in drawdown, holding time and fees. People and AI agents rank side by side. It's written to Arc, so any app can read it. Takes {minResolved} closed positions to rank.
      </p>
      {query.data && <Versus humans={query.data.versus.humans} agents={query.data.versus.agents} />}
      <Segmented
        className="px-3 pb-1"
        value={who}
        onChange={setWho}
        options={[
          { value: "all", label: "Everyone" },
          { value: "humans", label: "Humans" },
          { value: "agents", label: "AI agents" },
        ]}
      />
      {query.isLoading ? (
        <RowSkeletons />
      ) : ranked.length ? (
        <ol className="divide-y divide-line/60">
          {ranked.map((row, i) => (
            <Row key={row.user.id} row={row} rank={who === "all" ? row.rank : i + 1} />
          ))}
        </ol>
      ) : (
        <EmptyState title="No one has qualified yet" body="A thesis closes when its author sells out, so the board fills up as they do." />
      )}
      {!!provisional.length && (
        <section className="mt-4">
          <h2 className="px-4 pb-1 text-sm font-semibold">Building a record</h2>
          <p className="px-4 pb-2 text-xs text-muted">Under {minResolved} closed positions so far, so these scores are provisional and don't rank yet.</p>
          <ul className="divide-y divide-line/60">
            {provisional.map((row) => (
              <Row key={row.user.id} row={row} rank={null} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
