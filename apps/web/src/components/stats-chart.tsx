"use client";

import { formatCompactUsd, formatUsd, type StatsBucket } from "@frontrun/core";
import { useState } from "react";

const value = (b: StatsBucket, field: "volumeUsd" | "revenueUsd") => Number(b[field]);

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5]) if (v <= step * power) return step * power;
  return 10 * power;
}

function axisUsd(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1_000) return formatCompactUsd(n);
  return `$${Number(n.toPrecision(2))}`;
}

export function bucketLabel(at: string, hourly: boolean): string {
  const date = new Date(at);
  return hourly
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Keeps a label at the plot's edge from hanging off it. */
function edgeAlign(index: number, count: number): string {
  if (count <= 3) return "-translate-x-1/2";
  if (index < count * 0.2) return "translate-x-0";
  if (index >= count * 0.8) return "-translate-x-full";
  return "-translate-x-1/2";
}

/** One measure over time, as columns. Hovering or tapping a column shows its numbers. */
export function ColumnChart({ title, total, buckets, field, hourly }: { title: string; total: string; buckets: StatsBucket[]; field: "volumeUsd" | "revenueUsd"; hourly: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const values = buckets.map((b) => value(b, field));
  const highest = Math.max(0, ...values);
  const peak = highest > 0 ? values.indexOf(highest) : -1;
  const max = niceMax(highest);
  const count = buckets.length;
  const shown = active !== null ? buckets[active] : undefined;
  const xLabels = count > 2 ? [0, Math.floor((count - 1) / 2), count - 1] : buckets.map((_, i) => i);
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-sm font-medium text-muted">{title}</h2>
      <p className="num mt-0.5 text-xl font-semibold">{total}</p>
      <div className="mt-2 flex h-48 pt-6">
        <div className="relative w-10 shrink-0" aria-hidden>
          {[0, 0.5, 1].map((tick) => (
            <span key={tick} className="num absolute left-0 translate-y-1/2 text-[11px] text-faint" style={{ bottom: `${tick * 100}%` }}>
              {axisUsd(max * tick)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {[0, 0.5, 1].map((tick) => (
            <div key={tick} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${tick * 100}%` }} />
          ))}
          <div
            className="absolute inset-0 flex items-end gap-0.5"
            role="img"
            aria-label={`${title}, ${total}. A table of these numbers is below.`}
            onPointerLeave={() => setActive(null)}
          >
            {buckets.map((b, i) => {
              const v = values[i]!;
              const height = (v / max) * 100;
              return (
                <div
                  key={b.at}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => setActive(i)}
                  className={`relative flex h-full min-w-0 flex-1 items-end justify-center rounded-t ${active === i ? "bg-raised/70" : ""}`}
                >
                  {v > 0 && <div className="w-full max-w-6 rounded-t bg-signal" style={{ height: `max(2px, ${height}%)` }} />}
                  {i === peak && active === null && (
                    <span className={`num absolute left-1/2 text-[11px] font-medium whitespace-nowrap text-ink ${edgeAlign(i, count)}`} style={{ bottom: `calc(${height}% + 4px)` }}>
                      {formatUsd(v)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {highest === 0 && <p className="absolute inset-0 flex items-center justify-center text-xs text-faint">Nothing in this period yet</p>}
          {shown && (
            <div
              className={`pointer-events-none absolute -top-5 z-10 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg ${edgeAlign(active!, count)}`}
              style={{ left: `${((active! + 0.5) / count) * 100}%` }}
            >
              <p className="text-muted">{bucketLabel(shown.at, hourly)}</p>
              <p className="num font-semibold text-ink">{formatUsd(value(shown, field))}</p>
              <p className="num text-muted">
                {shown.trades} {shown.trades === 1 ? "trade" : "trades"}
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="relative ml-10 mt-1.5 h-4" aria-hidden>
        {xLabels.map((i) => (
          <span key={i} className={`absolute text-[11px] whitespace-nowrap text-faint ${edgeAlign(i, count)}`} style={{ left: `${((i + 0.5) / count) * 100}%` }}>
            {bucketLabel(buckets[i]!.at, hourly)}
          </span>
        ))}
      </div>
    </section>
  );
}
