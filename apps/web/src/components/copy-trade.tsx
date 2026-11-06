"use client";

import { COPY_DEFAULT_AMOUNT_USD, COPY_DEFAULT_DAILY_USD, COPY_TRADE_MAX_USD, formatUsd, isPositiveDecimal, type CopySettingView, type UserSummary } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { Avatar, Button, Sheet } from "./ui";

export function useCopySettings() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["copy-settings"], queryFn: () => api.copySettings(), enabled: status === "in" });
}

const FIELD = "num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-ink outline-none focus:border-signal";

/** Asks how much to put into each copied trade, and shows what copying can and can't do. */
export function CopySheet({ leader, current, open, onClose }: { leader: UserSummary; current: CopySettingView | null; open: boolean; onClose(): void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [amount, setAmount] = useState(COPY_DEFAULT_AMOUNT_USD);
  const [daily, setDaily] = useState(COPY_DEFAULT_DAILY_USD);
  const [copySells, setCopySells] = useState(true);

  useEffect(() => {
    if (!open) return;
    setAmount(current?.amountUsd ?? COPY_DEFAULT_AMOUNT_USD);
    setDaily(current?.dailyLimitUsd ?? COPY_DEFAULT_DAILY_USD);
    setCopySells(current?.copySells ?? true);
  }, [open, current]);

  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: ["copy-settings"] });
    void queryClient.invalidateQueries({ queryKey: ["profile", leader.username] });
    onClose();
    toast(message, { tone: "good" });
  };
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.saveCopySetting(leader.username, { amountUsd: amount, dailyLimitUsd: daily, copySells, enabled }),
    onSuccess: (_, enabled) => done(enabled ? `Copying ${leader.username}` : `Paused copying ${leader.username}`),
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const stop = useMutation({
    mutationFn: () => api.deleteCopySetting(leader.username),
    onSuccess: () => done(`Stopped copying ${leader.username}`),
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const valid = isPositiveDecimal(amount) && isPositiveDecimal(daily);
  const busy = save.isPending || stop.isPending;

  return (
    <Sheet open={open} onClose={onClose} title={`Copy ${leader.username}`}>
      <p className="text-sm text-muted">When {leader.username} buys, your account buys the same token with your own money.</p>
      <label className="mt-3 block text-sm text-muted">
        Amount per trade (USD, up to {COPY_TRADE_MAX_USD})
        <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} className={FIELD} />
      </label>
      <label className="mt-3 block text-sm text-muted">
        Daily limit (USD)
        <input value={daily} inputMode="decimal" onChange={(e) => setDaily(e.target.value)} className={FIELD} />
      </label>
      <label className="mt-3 flex items-center justify-between gap-3 text-sm">
        <span>
          Copy their sells too
          <span className="block text-xs text-muted">Sells the same share of what you copied, and never your own tokens.</span>
        </span>
        <input type="checkbox" checked={copySells} onChange={(e) => setCopySells(e.target.checked)} className="h-5 w-5 shrink-0 accent-signal" />
      </label>
      <div role="note" className="mt-3 rounded-xl bg-warn/10 p-3 text-xs text-warn">
        <p>Copies fill after {leader.username}&apos;s trade, usually at a worse price. {leader.username} can sell before you, and you can lose what you put in.</p>
        <p className="mt-1">Buys over 5% price impact, or on risk-flagged tokens, are skipped and you&apos;re told why.</p>
      </div>
      <Button onClick={() => save.mutate(true)} disabled={!valid || busy} className="mt-3 w-full">
        {current?.enabled ? "Save" : `Start copying ${leader.username}`}
      </Button>
      {current && (
        <div className="mt-2 flex gap-2">
          {current.enabled && (
            <Button variant="secondary" onClick={() => save.mutate(false)} disabled={!valid || busy} className="flex-1">
              Pause
            </Button>
          )}
          <Button variant="secondary" onClick={() => stop.mutate()} disabled={busy} className="flex-1">
            Stop copying
          </Button>
        </div>
      )}
    </Sheet>
  );
}

/** Everyone you're copying, on the settings page. */
export function CopySection() {
  const copy = useCopySettings();
  const [editing, setEditing] = useState<CopySettingView | null>(null);
  if (!copy.data?.available) return null;
  return (
    <section className="mt-5 px-4">
      <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Copy trading</h2>
      <div className="divide-y divide-line/60 rounded-2xl bg-surface">
        {copy.data.items.length === 0 ? (
          <p className="p-3 text-sm text-muted">Open someone&apos;s profile and press Copy to start.</p>
        ) : (
          copy.data.items.map((item) => (
            <div key={item.leader.id} className="flex items-center gap-3 p-3">
              <Link href={`/u/${item.leader.username}`}>
                <Avatar user={item.leader} size={34} />
              </Link>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{item.leader.username}</p>
                <p className="num text-xs text-muted">
                  {item.enabled ? `${formatUsd(item.amountUsd)} a trade · ${formatUsd(item.dailyLimitUsd)} a day` : "Paused"}
                </p>
              </div>
              <Button variant="secondary" className="px-3 py-1.5 text-sm" onClick={() => setEditing(item)}>
                Edit
              </Button>
            </div>
          ))
        )}
      </div>
      <p className="num mt-1.5 px-1 text-xs text-faint">{formatUsd(copy.data.spentTodayUsd)} copied in the last 24 hours</p>
      {editing && <CopySheet leader={editing.leader} current={editing} open onClose={() => setEditing(null)} />}
    </section>
  );
}
