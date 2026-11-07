"use client";

import { D, UNVERIFIED_CLAIM, formatPrice, formatQty, formatUsd, isPositiveDecimal, modelShortName, shortAddress, timeAgo, type AgentAction, type AgentDetailView, type AgentRunView } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AgentBadge, AgentForm, thinkLabel, type AgentFormValues } from "@/components/agents";
import { Avatar, Button, EmptyState, Pct, RowSkeletons, Segmented, Sheet, Stat, TokenIcon } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBalance, useConfig } from "@/lib/hooks";
import { useToast } from "@/lib/toast";

function MoneySheet({ agent, kind, onClose }: { agent: AgentDetailView; kind: "fund" | "withdraw" | null; onClose(): void }) {
  const { wallet } = useAuth();
  const config = useConfig();
  const balance = useBalance();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const max = kind === "fund" ? (balance.data?.withdrawable ?? "0") : agent.balanceUsd;
  const valid = isPositiveDecimal(amount) && D(amount).lte(max);
  const send = useMutation({
    mutationFn: async () => {
      if (kind === "withdraw") await api.withdrawFromAgent(agent.id, amount);
      else if (config.tradingMode === "paper") await api.fundAgentPaper(agent.id, amount);
      else await wallet.sendUsdc(agent.wallet.evm, amount);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
      setAmount("");
      onClose();
      toast(kind === "fund" ? "Sent to your agent" : "Sent back to your wallet", { tone: "good" });
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  return (
    <Sheet open={!!kind} onClose={onClose} title={kind === "fund" ? `Send USDC to ${agent.user.username}` : `Take USDC back from ${agent.user.username}`}>
      <p className="text-sm text-muted">{kind === "fund" ? "This is all it can trade with. Only send what you're fine with it losing." : "This goes to your own wallet, the only place it can go."}</p>
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2 focus-within:border-signal">
        <span className="text-muted">$</span>
        <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" aria-label="Amount" className="num min-w-0 flex-1 bg-transparent outline-none" />
        <button type="button" className="text-xs font-semibold text-signal" onClick={() => setAmount(D(max).toFixed())}>
          Max
        </button>
      </div>
      <p className="num mt-1 text-xs text-faint">{formatUsd(max)} available</p>
      <Button className="mt-3 w-full" disabled={!valid || send.isPending} onClick={() => send.mutate()}>
        {send.isPending ? "Sending…" : kind === "fund" ? "Send" : "Take back"}
      </Button>
    </Sheet>
  );
}

/** The app's own record of what happened, shown apart from the model's words because those can be wrong. */
function ActionRecord({ actions }: { actions: AgentAction[] }) {
  if (!actions.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {actions.map((a, i) => (
        <li key={i} className={`flex items-start gap-1.5 text-xs ${a.tool === UNVERIFIED_CLAIM ? "font-semibold text-down" : a.acted ? "font-medium text-signal" : "text-warn"}`}>
          <span aria-hidden>{a.acted ? "✓" : "✕"}</span>
          <span>{a.summary}</span>
        </li>
      ))}
    </ul>
  );
}

function Chat({ agent }: { agent: AgentDetailView }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const messages = useQuery({
    queryKey: ["agents", agent.id, "messages"],
    queryFn: () => api.agentMessages(agent.id),
    refetchInterval: (query) => (query.state.data?.items.some((m) => m.pending) ? 3000 : false),
  });
  const send = useMutation({
    mutationFn: () => api.sendAgentMessage(agent.id, body.trim()),
    onSuccess: (data) => {
      setBody("");
      queryClient.setQueryData(["agents", agent.id, "messages"], data);
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const items = messages.data?.items ?? [];
  const thinking = items.some((m) => m.pending);
  return (
    <section className="px-4 py-3">
      <h2 className="font-semibold">Talk to it</h2>
      <p className="text-xs text-muted">Ask why it did something, or tell it what to do: sell a position, set a stop-loss or a limit order. Your limits still apply.</p>
      {!!items.length && (
        <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto">
          {items.map((m) => (
            <li key={m.id} className={`flex ${m.role === "owner" ? "justify-end" : ""}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.role === "owner" ? "bg-signal/15" : "bg-surface"}`}>
                <p className="break-words whitespace-pre-wrap">{m.body}</p>
                <ActionRecord actions={m.actions} />
              </div>
            </li>
          ))}
          {thinking && <li className="text-xs text-muted">Thinking…</li>}
        </ul>
      )}
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) send.mutate();
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} placeholder="Set a stop-loss on your biggest position" aria-label="Message your agent" className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 outline-none focus:border-signal" />
        <Button type="submit" className="px-3 py-2 text-sm" disabled={!body.trim() || send.isPending}>
          Send
        </Button>
      </form>
    </section>
  );
}

function RunRow({ run }: { run: AgentRunView }) {
  const acted = run.actions.filter((a) => a.acted);
  const claim = run.actions.filter((a) => a.tool === UNVERIFIED_CLAIM);
  const looked = run.actions.filter((a) => !a.acted && a.tool !== UNVERIFIED_CLAIM);
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-2 text-xs text-faint">
        <span>
          {run.trigger === "chat" ? "You asked" : "On schedule"} · {timeAgo(run.createdAt)}
        </span>
        {run.costUsd > 0 && <span className="num">${run.costUsd.toFixed(4)}</span>}
      </div>
      {acted.map((a, i) => (
        <p key={i} className="mt-1 text-sm font-medium text-signal">
          {a.summary}
        </p>
      ))}
      {run.summary && <p className="mt-1 text-sm break-words whitespace-pre-wrap">{run.summary}</p>}
      {claim.map((a, i) => (
        <p key={i} className="mt-1 text-xs font-semibold text-down">
          {a.summary}
        </p>
      ))}
      {!run.finishedAt && <p className="mt-1 text-sm text-muted">Thinking…</p>}
      {run.error && <p className="mt-1 text-sm text-down">The model failed this round, so nothing was done.</p>}
      {!!looked.length && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted">
            {looked.length} {looked.length === 1 ? "step" : "steps"} along the way
          </summary>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">
            {looked.map((a, i) => (
              <li key={i} className={a.ok ? "" : "text-warn"}>
                {a.summary}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const { status, login } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"log" | "positions">("log");
  const [money, setMoney] = useState<"fund" | "withdraw" | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const agent = useQuery({ queryKey: ["agents", id], queryFn: () => api.agent(id), enabled: status === "in", refetchInterval: 30_000 });
  const runs = useQuery({ queryKey: ["agents", id, "runs"], queryFn: () => api.agentRuns(id), enabled: status === "in", refetchInterval: 15_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["agents", id] });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.updateAgent(id, { enabled }),
    onSuccess: refresh,
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const thinkNow = useMutation({
    mutationFn: () => api.runAgentNow(id),
    onSuccess: () => {
      refresh();
      toast("It'll think in a moment");
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const edit = useMutation({
    mutationFn: ({ model, strategy, perTradeUsd, dailyLimitUsd, thinkEveryMinutes }: AgentFormValues) => api.updateAgent(id, { model, strategy, perTradeUsd, dailyLimitUsd, thinkEveryMinutes }),
    onSuccess: () => {
      setEditError(null);
      setEditing(false);
      refresh();
    },
    onError: (err) => setEditError(errorMessage(err)),
  });

  if (status === "out") return <EmptyState title="AI agents" body="Sign in to see your agents." action={<Button onClick={login}>Sign in</Button>} />;
  if (agent.isLoading) return <RowSkeletons count={4} />;
  if (!agent.data) return <EmptyState title="Agent not found" body="Only its owner can open this page." />;
  const a = agent.data;
  const invested = a.portfolio.open.reduce((sum, p) => sum.add(p.valueUsd ?? 0), D(0));
  const waitingForFunds = D(a.balanceUsd).lt(1) && !a.portfolio.open.length;

  return (
    <div>
      <section className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <Avatar user={a.user} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight">
              <Link href={`/u/${a.user.username}`} className="truncate">
                {a.user.username}
              </Link>
              <AgentBadge model={a.model} />
            </h1>
            <p className="truncate text-sm text-muted">{modelShortName(a.model)}</p>
            <p className="text-xs text-faint">{a.enabled ? `${thinkLabel(a.thinkEveryMinutes)}${a.lastRunAt ? ` · last ${timeAgo(a.lastRunAt)}` : ""}` : "Paused. It still answers you, but won't think on its own."}</p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-2xl bg-surface p-3">
          <Stat label="USDC" value={formatUsd(a.balanceUsd)} />
          <Stat label="In positions" value={formatUsd(invested.toFixed())} />
          <Stat label="Score" value={a.score ?? "—"} sub={`${formatUsd(a.spentTodayUsd)} of ${formatUsd(a.dailyLimitUsd)} today`} />
        </div>
        {waitingForFunds && <p className="mt-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">It won't think until it has at least $1 to trade with. Send it some USDC to start.</p>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button onClick={() => setMoney("fund")}>Send USDC</Button>
          <Button variant="secondary" onClick={() => setMoney("withdraw")} disabled={D(a.balanceUsd).lte(0)}>
            Take back
          </Button>
          <Button variant="secondary" onClick={() => thinkNow.mutate()} disabled={!a.enabled || thinkNow.isPending || waitingForFunds}>
            Think now
          </Button>
          <Button variant="secondary" onClick={() => toggle.mutate(!a.enabled)} disabled={toggle.isPending}>
            {a.enabled ? "Pause" : "Resume"}
          </Button>
        </div>
        <div className="mt-3 rounded-2xl bg-surface p-3 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-medium">Strategy</p>
            <button className="text-signal" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
          <p className="mt-1 text-muted break-words whitespace-pre-wrap">{a.strategy}</p>
          <p className="num mt-2 text-faint">
            Up to {formatUsd(a.perTradeUsd)} a trade. Model use today ${a.modelCostTodayUsd.toFixed(3)}. Wallet {shortAddress(a.wallet.evm)}.
          </p>
        </div>
      </section>

      <div className="border-t border-line/70">
        <Chat agent={a} />
      </div>

      <div className="border-t border-line/70 pt-2">
        <Segmented
          className="px-3 pb-1"
          value={tab}
          onChange={setTab}
          options={[
            { value: "log", label: "Decision log" },
            { value: "positions", label: `Positions ${a.portfolio.open.length}` },
          ]}
        />
        {tab === "log" ? (
          runs.data?.items.length ? (
            <ul className="divide-y divide-line/60">
              {runs.data.items.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing yet" body="Each round of thinking shows here, including the rounds where it decides to do nothing." />
          )
        ) : (
          <div className="divide-y divide-line/60">
            {a.portfolio.open.map((p) => (
              <Link key={p.id} href={`/token/${p.token.chain}/${p.token.address}`} className="flex items-center gap-3 px-4 py-3">
                <TokenIcon symbol={p.token.symbol} imageUrl={p.token.imageUrl} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{p.token.symbol}</p>
                  <p className="num text-xs text-muted">
                    {formatQty(p.qty)} @ {formatPrice(p.avgEntryUsd)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="num font-medium">{formatUsd(p.valueUsd)}</p>
                  <Pct value={p.returnPct} className="text-xs" />
                </div>
              </Link>
            ))}
            {a.orders.map((o) => (
              <div key={o.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <TokenIcon symbol={o.token.symbol} imageUrl={o.token.imageUrl} />
                <p className="min-w-0 flex-1 truncate">
                  {o.type.replace("_", " ")} on {o.token.symbol}
                </p>
                <p className="num text-muted">at {formatPrice(o.triggerPriceUsd)}</p>
              </div>
            ))}
            {!a.portfolio.open.length && !a.orders.length && <EmptyState title="Nothing open" />}
          </div>
        )}
      </div>

      <MoneySheet agent={a} kind={money} onClose={() => setMoney(null)} />
      <Sheet open={editing} onClose={() => setEditing(false)} title="Change how it works">
        <AgentForm agent={a} submitLabel="Save" pending={edit.isPending} error={editError} onSubmit={(values) => edit.mutate(values)} />
      </Sheet>
    </div>
  );
}
