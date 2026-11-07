"use client";

import {
  AGENT_DAILY_MODEL_USD,
  AGENT_DEFAULT_DAILY_USD,
  AGENT_DEFAULT_THINK_MINUTES,
  AGENT_DEFAULT_TRADE_USD,
  AGENT_MAX_DAILY_USD,
  AGENT_MAX_TRADE_USD,
  AGENT_MIN_TRADE_USD,
  AGENT_THINK_MINUTES,
  D,
  isPositiveDecimal,
  modelShortName,
  type AgentModelView,
  type AgentView,
} from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Button, Segmented } from "./ui";

/** Marks an account as an AI agent wherever its name shows, so nobody mistakes one for a person. */
export function AgentBadge({ model }: { model?: string | null }) {
  if (!model) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-cyan/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan" title={`An AI agent running on ${model}`}>
      AI
    </span>
  );
}

export function thinkLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} min`;
  if (minutes === 60) return "Every hour";
  if (minutes < 1440) return `Every ${minutes / 60} hours`;
  return "Once a day";
}

function priceLabel(m: AgentModelView): string {
  if (m.free) return "Free";
  const fmt = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 0.1 ? n.toFixed(2) : n.toFixed(3));
  return `$${fmt(m.promptPrice)} / $${fmt(m.completionPrice)}`;
}

/** Roughly what one round of thinking costs: several model steps reading tool results. */
function roundCost(m: AgentModelView): number {
  return (m.promptPrice * 15_000 + m.completionPrice * 1_500) / 1_000_000;
}

function CheckDot({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 ${checked ? "border-signal bg-signal text-signal-ink" : "border-line"}`}>
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function ModelPicker({ value, onChange }: { value: string; onChange(id: string): void }) {
  const [view, setView] = useState<"suggested" | "open" | "all">("suggested");
  const [search, setSearch] = useState("");
  const models = useQuery({ queryKey: ["agent-models"], queryFn: () => api.agentModels(), staleTime: 600_000, retry: 1 });
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (models.data?.items ?? [])
      .filter((m) => (q ? true : view === "suggested" ? m.recommended : view === "open" ? m.openSource : true))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      .slice(0, 40);
  }, [models.data, search, view]);
  const selected = models.data?.items.find((m) => m.id === value);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-signal/60 bg-signal/10 px-3 py-2">
        <CheckDot checked />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{selected?.name ?? modelShortName(value)}</p>
          <p className="truncate text-xs text-muted">
            {selected ? `${selected.provider}${selected.openSource ? " · open source" : ""}` : "Selected"}
          </p>
        </div>
        {selected && <span className="num shrink-0 text-xs text-muted">{priceLabel(selected)}</span>}
      </div>
      <Segmented
        value={view}
        onChange={setView}
        options={[
          { value: "suggested", label: "Suggested" },
          { value: "open", label: "Open source" },
          { value: "all", label: `All ${models.data?.items.length ?? ""}` },
        ]}
      />
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        // Enter here means search, not create the agent.
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        placeholder="Search all models"
        aria-label="Search models"
        className="mt-2 w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-signal"
      />
      <ul className="mt-2 max-h-56 divide-y divide-line/60 overflow-y-auto rounded-xl border border-line">
        {models.isLoading && <li className="px-3 py-2 text-sm text-muted">Loading models…</li>}
        {models.isError && (
          <li className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-down">
            Couldn't load the models.
            <button type="button" onClick={() => void models.refetch()} className="shrink-0 font-semibold text-signal">
              Try again
            </button>
          </li>
        )}
        {!models.isLoading && !shown.length && !models.isError && <li className="px-3 py-2 text-sm text-muted">No model matches that.</li>}
        {shown.map((m) => (
          <li key={m.id}>
            <button type="button" aria-pressed={m.id === value} onClick={() => onChange(m.id)} className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-raised ${m.id === value ? "bg-signal/15" : ""}`}>
              <CheckDot checked={m.id === value} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.name}</span>
                <span className="block truncate text-xs text-faint">
                  {m.provider}
                  {m.openSource ? " · open source" : ""}
                </span>
              </span>
              <span className="num shrink-0 text-xs text-muted">{priceLabel(m)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-faint">Prices are per million tokens, in and out.</p>
      {selected && !selected.free && <p className="mt-1 text-xs text-muted">About ${roundCost(selected).toFixed(3)} per round of thinking on {selected.name}. One agent stops for the day at ${AGENT_DAILY_MODEL_USD} of model use.</p>}
    </div>
  );
}

export interface AgentFormValues {
  name: string;
  model: string;
  strategy: string;
  perTradeUsd: string;
  dailyLimitUsd: string;
  thinkEveryMinutes: number;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mt-4 block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

const inputClass = "w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none placeholder:text-faint focus:border-signal";

export function AgentForm({ agent, submitLabel, pending, error, onSubmit }: { agent?: AgentView; submitLabel: string; pending: boolean; error: string | null; onSubmit(values: AgentFormValues): void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(agent?.model ?? "anthropic/claude-haiku-5.5");
  const [strategy, setStrategy] = useState(agent?.strategy ?? "");
  const [perTradeUsd, setPerTradeUsd] = useState(agent?.perTradeUsd ?? AGENT_DEFAULT_TRADE_USD);
  const [dailyLimitUsd, setDailyLimitUsd] = useState(agent?.dailyLimitUsd ?? AGENT_DEFAULT_DAILY_USD);
  const [thinkEveryMinutes, setThinkEveryMinutes] = useState<number>(agent?.thinkEveryMinutes ?? AGENT_DEFAULT_THINK_MINUTES);

  const limitsOk =
    isPositiveDecimal(perTradeUsd) &&
    isPositiveDecimal(dailyLimitUsd) &&
    D(perTradeUsd).gte(AGENT_MIN_TRADE_USD) &&
    D(perTradeUsd).lte(AGENT_MAX_TRADE_USD) &&
    D(dailyLimitUsd).gte(perTradeUsd) &&
    D(dailyLimitUsd).lte(AGENT_MAX_DAILY_USD);
  const nameOk = !!agent || /^[a-zA-Z0-9_]{3,20}$/.test(name);
  const strategyOk = strategy.trim().length >= 10;
  const ready = nameOk && limitsOk && strategyOk && !!model;
  // A greyed-out button on its own doesn't say what it's waiting for.
  const waitingOn = !nameOk ? "Give it a name to continue: 3 to 20 letters, numbers or underscores." : !strategyOk ? "Write its strategy to continue: at least 10 characters." : null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) onSubmit({ name, model, strategy: strategy.trim(), perTradeUsd, dailyLimitUsd, thinkEveryMinutes });
      }}
    >
      {!agent && (
        <Field label="Name" hint="Its username. 3 to 20 letters, numbers or underscores. It shows on the leaderboard with an AI tag.">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="momentum_bot" className={inputClass} />
        </Field>
      )}
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium">Model</p>
        <ModelPicker value={model} onChange={setModel} />
      </div>
      <Field label="Strategy" hint="In your own words. It reads this every time it thinks.">
        <textarea value={strategy} onChange={(e) => setStrategy(e.target.value)} rows={4} maxLength={2000} placeholder="For example: look for rising volume and deep liquidity. Take profit around +40%, cut losers at -15%." className={`${inputClass} resize-none`} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Most per trade">
          <input value={perTradeUsd} onChange={(e) => setPerTradeUsd(e.target.value)} inputMode="decimal" className={`num ${inputClass}`} />
        </Field>
        <Field label="Most per day">
          <input value={dailyLimitUsd} onChange={(e) => setDailyLimitUsd(e.target.value)} inputMode="decimal" className={`num ${inputClass}`} />
        </Field>
      </div>
      {!limitsOk && (
        <p className="mt-1 text-xs text-down">
          Per trade has to be ${AGENT_MIN_TRADE_USD} to ${AGENT_MAX_TRADE_USD}. Per day has to be at least that, and at most ${AGENT_MAX_DAILY_USD}.
        </p>
      )}
      <Field label="How often it thinks" hint="It won't always trade. Each round it can decide to do nothing.">
        <select value={thinkEveryMinutes} onChange={(e) => setThinkEveryMinutes(Number(e.target.value))} className={inputClass}>
          {AGENT_THINK_MINUTES.map((m) => (
            <option key={m} value={m}>
              {thinkLabel(m)}
            </option>
          ))}
        </select>
      </Field>
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
      {waitingOn && <p className="mt-3 text-xs text-muted">{waitingOn}</p>}
      <Button type="submit" disabled={!ready || pending} className="mt-4 w-full">
        {pending ? "One moment…" : submitLabel}
      </Button>
    </form>
  );
}
