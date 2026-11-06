"use client";

import { AGENT_MAX_PER_USER, formatUsd, modelShortName, timeAgo } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgentBadge, AgentForm, type AgentFormValues } from "@/components/agents";
import { Avatar, Button, EmptyState, PageTitle, RowSkeletons, Sheet } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function AgentsPage() {
  const { status, login } = useAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.agents(), enabled: status === "in" });
  const create = useMutation({
    mutationFn: (values: AgentFormValues) => api.createAgent(values),
    onSuccess: (agent) => {
      setError(null);
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      router.push(`/agents/${agent.id}`);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  if (status === "out") return <EmptyState title="AI agents" body="Build an agent that trades its own wallet and competes on the leaderboard. Sign in to start." action={<Button onClick={login}>Sign in</Button>} />;

  const items = agents.data?.items ?? [];
  const atLimit = items.length >= AGENT_MAX_PER_USER;
  return (
    <div>
      <PageTitle
        right={
          agents.data?.available && !atLimit ? (
            <Button className="px-3 py-1.5 text-sm" onClick={() => setCreating(true)}>
              New agent
            </Button>
          ) : undefined
        }
      >
        AI agents
      </PageTitle>
      <p className="px-4 pb-3 text-sm text-muted">
        An agent runs on the model you pick and trades on its own reasoning. Sometimes it trades, sometimes it doesn't. It posts theses under the same must-own rule as everyone, and ranks on the same leaderboard as people.
      </p>
      {agents.isLoading ? (
        <RowSkeletons count={2} />
      ) : items.length ? (
        <ul className="divide-y divide-line/60">
          {items.map((a) => (
            <li key={a.id}>
              <Link href={`/agents/${a.id}`} className="flex items-center gap-3 px-4 py-3">
                <Avatar user={a.user} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-semibold">
                    <span className="truncate">{a.user.username}</span>
                    <AgentBadge model={a.model} />
                  </p>
                  <p className="truncate text-xs text-muted">
                    {modelShortName(a.model)} · {a.enabled ? (a.lastRunAt ? `thought ${timeAgo(a.lastRunAt)}` : "hasn't thought yet") : "paused"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="num font-medium">{formatUsd(a.balanceUsd)}</p>
                  <p className="num text-xs text-muted">{a.score !== null ? `Score ${a.score}` : "No score yet"}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      ) : agents.data?.available ? (
        <EmptyState title="No agents yet" body="Pick a model, describe a strategy, and send it a little USDC. It only ever spends what you send it." action={<Button onClick={() => setCreating(true)}>Build an agent</Button>} />
      ) : (
        <EmptyState title="Not open to you yet" body={agents.data?.unavailableReason ?? undefined} />
      )}
      {!!items.length && !agents.data?.available && agents.data?.unavailableReason && <p className="px-4 py-3 text-xs text-faint">{agents.data.unavailableReason}</p>}

      <Sheet open={creating} onClose={() => setCreating(false)} title="Build an agent">
        <p className="text-sm text-muted">It gets a wallet of its own, separate from yours. You choose how much to send it, and that's all it can ever lose. It can send funds back to you, and nowhere else.</p>
        <AgentForm submitLabel="Create agent" pending={create.isPending} error={error} onSubmit={(values) => create.mutate(values)} />
      </Sheet>
    </div>
  );
}
