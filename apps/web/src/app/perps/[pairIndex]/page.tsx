"use client";

import { formatPrice, type PerpPositionView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ASSET_LABELS,
  MarketHours,
  OrderPanel,
  PerpChart,
  PerpPositions,
  compactUsd,
} from "@/components/perps";
import { EmptyState, Skeleton, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function PerpMarketPage() {
  const params = useParams<{ pairIndex: string }>();
  const pairIndex = Number(params.pairIndex);
  const { status } = useAuth();
  const market = useQuery({
    queryKey: ["perp-market", pairIndex],
    queryFn: () => api.perpMarket(pairIndex),
    refetchInterval: 5000,
    enabled: Number.isInteger(pairIndex),
  });
  const positions = useQuery({
    queryKey: ["perp-positions", "open"],
    queryFn: () => api.perpPositions("open"),
    enabled: status === "in",
    refetchInterval: 5000,
  });

  if (market.isError)
    return (
      <EmptyState
        title="Market not found"
        body="That perp market isn't on Veranta."
        action={
          <Link href="/perps" className="text-signal">
            All perps
          </Link>
        }
      />
    );
  const m = market.data;
  if (!m) return <Skeleton className="m-4 h-96" />;

  const mine: PerpPositionView[] = (positions.data?.items ?? []).filter(
    (p) => p.market.pairIndex === pairIndex && p.status === "open",
  );
  const levels = mine.flatMap((p) => [
    ...(p.entryPrice
      ? [{ price: Number(p.entryPrice), label: "Entry", color: "#8d9299" }]
      : []),
    ...(p.liquidationPrice
      ? [{ price: Number(p.liquidationPrice), label: "Liq", color: "#eb5271" }]
      : []),
    ...(p.takeProfit
      ? [{ price: Number(p.takeProfit), label: "TP", color: "#35db98" }]
      : []),
    ...(p.stopLoss
      ? [{ price: Number(p.stopLoss), label: "SL", color: "#f0b44c" }]
      : []),
  ]);
  const oi = m.openInterest;
  const longShare =
    oi.longUsd + oi.shortUsd > 0
      ? (oi.longUsd / (oi.longUsd + oi.shortUsd)) * 100
      : 50;

  return (
    <div className="px-4 pt-3 pb-8">
      <Link href="/perps" className="text-sm text-muted">
        ← Perps
      </Link>
      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold">{m.symbol}</h1>
        <span className="num text-xl">
          {m.priceUsd ? formatPrice(m.priceUsd) : "-"}
        </span>
        <MarketHours open={m.isOpen} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Type" value={ASSET_LABELS[m.assetClass]} />
        <Stat label="Max leverage" value={`${m.maxLeverage}x`} />
        <Stat
          label="Open interest"
          value={compactUsd(oi.longUsd + oi.shortUsd)}
          sub={`${longShare.toFixed(0)}% long`}
        />
        <Stat label="Fee per side" value={`${m.openFeePct}%`} />
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <PerpChart pairIndex={pairIndex} levels={levels} />
        </div>
        {/* On phones the order panel follows the chart; on wide screens it sits beside both. */}
        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <OrderPanel key={m.pairIndex} market={m} />
        </div>
        <div className="min-w-0 lg:col-start-1">
          <h2 className="text-sm font-semibold">Your positions here</h2>
          {status === "in" ? <PerpPositions pairIndex={pairIndex} /> : <p className="py-3 text-sm text-muted">Sign in to see your positions.</p>}
        </div>
      </div>
    </div>
  );
}
