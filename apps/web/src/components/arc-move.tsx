"use client";

import { D, formatUsd, type ArcMoveView } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useConfig } from "@/lib/hooks";
import { Button } from "./ui";

const MOVABLE_FROM_USD = 1;

function Body({ view, moving, error, onMove, owner }: { view: ArcMoveView; moving: boolean; error: string | null; onMove(): void; owner: string }) {
  const pending = view.pending && !["filled", "failed", "refunded"].includes(view.pending.status) ? view.pending : null;
  if (pending) {
    return (
      <p className="text-sm">
        Moving {formatUsd(pending.amountUsd)} from Arc to Base. It usually lands within a minute, and {owner} balance updates on its own.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-sm">
        {owner === "your" ? "You have" : "It has"} <span className="num font-semibold">{formatUsd(view.arcUsdc)}</span> USDC on Arc. Balances live on Base now, so move it there to trade with it. No app fee.
      </p>
      <Button className="px-3 py-1.5 text-sm" disabled={moving} onClick={onMove}>
        {moving ? "Moving…" : "Move to Base"}
      </Button>
      {error && <p className="w-full text-sm text-down">{error}</p>}
    </div>
  );
}

function useArcMove(key: unknown[], read: () => Promise<ArcMoveView>, move: () => Promise<ArcMoveView>, enabled: boolean) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: key,
    queryFn: read,
    enabled,
    refetchInterval: (query) => (query.state.data?.pending && !["filled", "failed", "refunded"].includes(query.state.data.pending.status) ? 5000 : 60_000),
  });
  const run = useMutation({
    mutationFn: move,
    onSuccess: (view) => {
      queryClient.setQueryData(key, view);
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  return { status, run };
}

/** Shown to anyone who still has USDC on Arc from before Base became home. */
export function ArcMoveBanner() {
  const { status: auth } = useAuth();
  const config = useConfig();
  const { status, run } = useArcMove(["arc-move"], () => api.arcMove(), () => api.moveArcToBase(), auth === "in" && config.tradingMode === "live");
  const view = status.data;
  if (!view || (D(view.arcUsdc).lt(MOVABLE_FROM_USD) && !view.pending)) return null;
  return (
    <div className="border-b border-warn/30 bg-warn/10 px-4 py-2.5">
      <div className="mx-auto max-w-5xl">
        <Body view={view} moving={run.isPending} error={run.isError ? errorMessage(run.error) : null} onMove={() => run.mutate()} owner="your" />
      </div>
    </div>
  );
}

/** The same, for an agent's own wallet, on its console. */
export function AgentArcMove({ agentId }: { agentId: string }) {
  const config = useConfig();
  const { status, run } = useArcMove(["agents", agentId, "arc-move"], () => api.agentArcMove(agentId), () => api.moveAgentArcToBase(agentId), config.tradingMode === "live");
  const view = status.data;
  if (!view || (D(view.arcUsdc).lt(MOVABLE_FROM_USD) && !view.pending)) return null;
  return (
    <div className="mt-3 rounded-2xl border border-warn/30 bg-warn/10 p-3">
      <Body view={view} moving={run.isPending} error={run.isError ? errorMessage(run.error) : null} onMove={() => run.mutate()} owner="its" />
    </div>
  );
}
