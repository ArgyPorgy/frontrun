"use client";

import {
  formatPrice,
  formatUsd,
  perpLiquidationPrice,
  perpOrderProblem,
  type PerpMarketView,
  type PerpPositionView,
  type PerpSide,
  type Timeframe,
} from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type UTCTimestamp,
} from "lightweight-charts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBalance, useConfig } from "@/lib/hooks";
import { Button, Segmented, Sheet } from "./ui";

export const ASSET_LABELS: Record<string, string> = {
  equity: "Stocks",
  crypto: "Crypto",
  fx: "FX",
  metal: "Metals",
  commodity: "Commodities",
  index: "Indices",
  other: "Other",
};

export function compactUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function MarketHours({ open }: { open: boolean }) {
  return open ? null : (
    <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted">
      Closed
    </span>
  );
}

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];

export function PerpChart({
  pairIndex,
  levels,
}: {
  pairIndex: number;
  levels: Array<{ price: number; label: string; color: string }>;
}) {
  const [tf, setTf] = useState<Timeframe>("15m");
  const el = useRef<HTMLDivElement>(null);
  const candles = useQuery({
    queryKey: ["perp-candles", pairIndex, tf],
    queryFn: () => api.perpCandles(pairIndex, tf),
    refetchInterval: 30_000,
  });
  const levelKey = levels.map((l) => `${l.label}:${l.price}`).join("|");

  useEffect(() => {
    const node = el.current;
    const items = candles.data?.items;
    if (!node || !items?.length) return;
    const chart = createChart(node, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8d9299",
        fontFamily: "var(--font-geist-mono), monospace",
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#14151a" },
        horzLines: { color: "#14151a" },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.12, bottom: 0.08 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#35db98",
      downColor: "#eb5271",
      borderVisible: false,
      wickUpColor: "#35db98",
      wickDownColor: "#eb5271",
      priceFormat: {
        type: "custom",
        minMove: 1e-8,
        formatter: (p: number) => formatPrice(p).replace("$", ""),
      },
    });
    series.setData(
      items.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    for (const l of levels)
      series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: l.label,
      });
    chart.timeScale().fitContent();
    return () => chart.remove();
    // levels are compared by value through levelKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles.data, levelKey]);

  return (
    <div>
      <Segmented
        options={TIMEFRAMES.map((t) => ({ value: t, label: t }))}
        value={tf}
        onChange={setTf}
      />
      <div ref={el} className="mt-2 h-72 w-full md:h-96">
        {!candles.data?.items?.length && (
          <p className="pt-24 text-center text-sm text-muted">
            {candles.isLoading
              ? "Loading chart…"
              : "No chart data for this market yet."}
          </p>
        )}
      </div>
    </div>
  );
}

function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function OrderPanel({ market }: { market: PerpMarketView }) {
  const { status, login } = useAuth();
  const config = useConfig();
  const balance = useBalance();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<PerpSide>("long");
  const [collateral, setCollateral] = useState("20");
  const [leverage, setLeverage] = useState(Math.min(5, market.maxLeverage));
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [done, setDone] = useState<PerpPositionView | null>(null);
  const open = useMutation({
    mutationFn: () =>
      api.openPerp({
        pairIndex: market.pairIndex,
        side,
        collateralUsd: Number(collateral),
        leverage,
        takeProfit: num(tp),
        stopLoss: num(sl),
      }),
    onSuccess: (p) => {
      setDone(p);
      void queryClient.invalidateQueries({ queryKey: ["perp-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
    },
  });

  const price = market.priceUsd;
  const collateralUsd = Number(collateral) || 0;
  const size = collateralUsd * leverage;
  const fee = (size * market.openFeePct) / 100;
  const problem = price
    ? perpOrderProblem(
        market,
        {
          collateralUsd,
          leverage,
          side,
          takeProfit: num(tp),
          stopLoss: num(sl),
        },
        price,
      )
    : "Waiting for a price.";
  const liq = price
    ? perpLiquidationPrice({ side, leverage, entryPrice: price })
    : null;
  const spendable = balance.data ? Number(balance.data.spendable) : null;
  const short = spendable !== null && collateralUsd > spendable;

  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        {(["long", "short"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`rounded-xl py-2 text-sm font-semibold capitalize ${side === s ? (s === "long" ? "bg-up text-bg" : "bg-down text-bg") : "bg-raised text-muted"}`}
          >
            {s}
          </button>
        ))}
      </div>
      <label
        className="mt-4 block text-xs text-muted"
        htmlFor="perp-collateral"
      >
        Collateral (USDC)
      </label>
      <input
        id="perp-collateral"
        inputMode="decimal"
        value={collateral}
        onChange={(e) => setCollateral(e.target.value.replace(/[^0-9.]/g, ""))}
        className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2"
      />
      {spendable !== null && (
        <p className="mt-1 text-xs text-muted">
          Available: {formatUsd(spendable)}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        <label htmlFor="perp-leverage">Leverage</label>
        <span className="num text-sm text-ink">{leverage}x</span>
      </div>
      <input
        id="perp-leverage"
        type="range"
        min={market.minLeverage}
        max={market.maxLeverage}
        step={1}
        value={leverage}
        onChange={(e) => setLeverage(Number(e.target.value))}
        className="mt-1 w-full accent-[var(--color-signal)]"
      />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted" htmlFor="perp-tp">
            Take-profit
          </label>
          <input
            id="perp-tp"
            inputMode="decimal"
            placeholder="Optional"
            value={tp}
            onChange={(e) => setTp(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted" htmlFor="perp-sl">
            Stop-loss
          </label>
          <input
            id="perp-sl"
            inputMode="decimal"
            placeholder="Optional"
            value={sl}
            onChange={(e) => setSl(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2 text-sm"
          />
        </div>
      </div>
      <dl className="mt-4 space-y-1 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted">Position size</dt>
          <dd className="num">{formatUsd(size)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Entry, about</dt>
          <dd className="num">{price ? formatPrice(price) : "-"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Liquidation, about</dt>
          <dd className="num text-down">{liq ? formatPrice(liq) : "-"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Veranta fee to open</dt>
          <dd className="num">{formatUsd(fee)}</dd>
        </div>
      </dl>
      {status !== "in" ? (
        <Button className="mt-4 w-full" onClick={login}>
          Sign in to trade
        </Button>
      ) : (
        <Button
          className="mt-4 w-full"
          disabled={!!problem || short || open.isPending}
          onClick={() => open.mutate()}
        >
          {open.isPending
            ? "Opening…"
            : `${side === "long" ? "Long" : "Short"} ${market.base}`}
        </Button>
      )}
      {(problem || short) && collateralUsd > 0 && (
        <p className="mt-2 text-xs text-muted">
          {short ? "That's more than your balance." : problem}
        </p>
      )}
      {open.isError && (
        <p className="mt-2 text-sm text-down">{errorMessage(open.error)}</p>
      )}
      {done && (
        <p
          className={`mt-2 text-sm ${done.status === "failed" ? "text-down" : "text-up"}`}
        >
          {done.status === "failed"
            ? done.error
            : done.status === "pending"
              ? "Sent. Veranta fills it on its next price update."
              : "Position open."}
        </p>
      )}
      <p className="mt-3 text-[11px] leading-snug text-faint">
        {config.tradingMode === "live"
          ? "Trades on Veranta, on Base, from your own wallet. Leverage magnifies losses: the position closes if losses reach most of its collateral."
          : "Paper trading: no real funds move. Prices are live from Veranta."}
      </p>
    </div>
  );
}

function PositionActions({ p }: { p: PerpPositionView }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [tp, setTp] = useState(
    p.takeProfit ? String(Number(p.takeProfit)) : "",
  );
  const [sl, setSl] = useState(p.stopLoss ? String(Number(p.stopLoss)) : "");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["perp-positions"] });
    void queryClient.invalidateQueries({ queryKey: ["balance"] });
  };
  const close = useMutation({
    mutationFn: (percent: number) => api.closePerp(p.id, percent),
    onSuccess: refresh,
  });
  const levels = useMutation({
    mutationFn: () =>
      api.updatePerpTpSl(p.id, {
        takeProfit: num(tp) ?? null,
        stopLoss: num(sl) ?? null,
      }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const err = close.error ?? levels.error;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          className="px-3 py-1 text-xs"
          disabled={close.isPending}
          onClick={() => close.mutate(50)}
        >
          Close half
        </Button>
        <Button
          variant="danger"
          className="px-3 py-1 text-xs"
          disabled={close.isPending}
          onClick={() => close.mutate(100)}
        >
          {close.isPending ? "Closing…" : "Close"}
        </Button>
        <Button
          variant="ghost"
          className="px-2 py-1 text-xs"
          onClick={() => setEditing(true)}
        >
          Edit TP/SL
        </Button>
      </div>
      {err && <p className="mt-1 text-xs text-down">{errorMessage(err)}</p>}
      <Sheet
        open={editing}
        onClose={() => setEditing(false)}
        title={`${p.market.symbol} take-profit and stop-loss`}
      >
        <div className="grid grid-cols-2 gap-2">
          <input
            aria-label="Take-profit"
            inputMode="decimal"
            placeholder="Take-profit"
            value={tp}
            onChange={(e) => setTp(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num rounded-xl border border-line bg-bg px-3 py-2"
          />
          <input
            aria-label="Stop-loss"
            inputMode="decimal"
            placeholder="Stop-loss"
            value={sl}
            onChange={(e) => setSl(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num rounded-xl border border-line bg-bg px-3 py-2"
          />
        </div>
        <p className="mt-2 text-xs text-muted">Leave one empty to remove it.</p>
        <Button
          className="mt-3 w-full"
          disabled={levels.isPending}
          onClick={() => levels.mutate()}
        >
          {levels.isPending ? "Saving…" : "Save"}
        </Button>
      </Sheet>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Filling",
  closing: "Closing",
  closed: "Closed",
  liquidated: "Liquidated",
  cancelled: "Not filled",
  failed: "Failed",
};

export function PerpPositionRow({
  p,
  actions = true,
}: {
  p: PerpPositionView;
  actions?: boolean;
}) {
  const pnl = p.pnlUsd === null ? null : Number(p.pnlUsd);
  const live = p.status === "open";
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/perps/${p.market.pairIndex}`} className="font-semibold">
            {p.market.symbol}
          </Link>
          <p className="text-xs">
            <span className={p.side === "long" ? "text-up" : "text-down"}>
              {p.side === "long" ? "Long" : "Short"}{" "}
              {p.leverage.toFixed(p.leverage % 1 ? 1 : 0)}x
            </span>
            <span className="text-muted">
              {" "}
              · {formatUsd(p.sizeUsd)} · {formatUsd(p.collateralUsd)} margin
            </span>
            {!live && (
              <span className="text-muted">
                {" "}
                · {STATUS_LABEL[p.status] ?? p.status}
              </span>
            )}
            {p.isPaper && <span className="text-faint"> · paper</span>}
          </p>
        </div>
        <div className="text-right">
          {pnl !== null && (
            <p
              className={`num font-medium ${pnl >= 0 ? "text-up" : "text-down"}`}
            >
              {formatUsd(pnl, { sign: true })}
            </p>
          )}
          {p.pnlPct !== null && (
            <p
              className={`num text-xs ${p.pnlPct >= 0 ? "text-up" : "text-down"}`}
            >
              {p.pnlPct >= 0 ? "+" : ""}
              {p.pnlPct.toFixed(1)}%
            </p>
          )}
        </div>
      </div>
      <p className="num mt-1 text-xs text-muted">
        Entry {p.entryPrice ? formatPrice(p.entryPrice) : "-"}
        {live && p.markPrice && <> · Mark {formatPrice(p.markPrice)}</>}
        {live && p.liquidationPrice && (
          <> · Liq {formatPrice(p.liquidationPrice)}</>
        )}
        {p.closePrice && !live && <> · Exit {formatPrice(p.closePrice)}</>}
        {p.takeProfit && live && <> · TP {formatPrice(p.takeProfit)}</>}
        {p.stopLoss && live && <> · SL {formatPrice(p.stopLoss)}</>}
      </p>
      {p.error && <p className="mt-1 text-xs text-down">{p.error}</p>}
      {p.openTx && (
        <a
          className="mt-1 inline-block text-xs text-muted underline"
          href={`https://basescan.org/tx/${p.closeTx ?? p.openTx}`}
          target="_blank"
          rel="noreferrer"
        >
          View on Basescan
        </a>
      )}
      {actions && live && <PositionActions p={p} />}
    </div>
  );
}

export function PerpPositions({
  pairIndex,
  status = "open",
}: {
  pairIndex?: number;
  status?: "open" | "closed";
}) {
  const { status: auth } = useAuth();
  const positions = useQuery({
    queryKey: ["perp-positions", status],
    queryFn: () => api.perpPositions(status),
    enabled: auth === "in",
    refetchInterval: status === "open" ? 5000 : 30_000,
  });
  if (auth !== "in") return null;
  const items = (positions.data?.items ?? []).filter(
    (p) => pairIndex === undefined || p.market.pairIndex === pairIndex,
  );
  if (positions.isLoading)
    return <p className="py-4 text-sm text-muted">Loading positions…</p>;
  if (items.length === 0)
    return (
      <p className="py-4 text-sm text-muted">
        {status === "open" ? "No open positions." : "No closed positions yet."}
      </p>
    );
  return (
    <div>
      {items.map((p) => (
        <PerpPositionRow key={p.id} p={p} />
      ))}
    </div>
  );
}
