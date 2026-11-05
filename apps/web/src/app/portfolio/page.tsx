"use client";

import { D, formatPrice, formatQty, formatUsd, portfolioTotals, timeAgo, type PositionView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button, ChainBadge, EmptyState, LinkButton, LiveNumber, PageTitle, Pct, RowSkeletons, Segmented, Stat, TokenIcon } from "@/components/ui";
import { OpenOrders } from "@/components/orders-list";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSocket } from "@/lib/socket";

/** Reports each open position's live price up to the page, so totals and rows stay in step. */
function useLivePrices(positions: PositionView[]) {
  const { store, watch } = useSocket();
  const [prices, setPrices] = useState<Record<string, string>>({});
  useEffect(() => {
    const cleanups = positions.flatMap((p) => {
      const key = `${p.token.chain}:${p.token.address}`;
      return [
        watch(p.token.chain, p.token.address),
        store.subscribe(key, () => {
          const tick = store.get(key);
          if (tick) setPrices((current) => (current[key] === tick.priceUsd ? current : { ...current, [key]: tick.priceUsd }));
        }),
      ];
    });
    return () => cleanups.forEach((c) => c());
  }, [positions, store, watch]);
  return prices;
}

function OpenRow({ p, price }: { p: PositionView; price: string | null }) {
  const value = price ? D(p.qty).mul(price) : null;
  const pnl = value ? value.sub(p.costBasisUsd) : null;
  const pct = pnl && D(p.costBasisUsd).gt(0) ? pnl.div(p.costBasisUsd).mul(100).toNumber() : null;
  return (
    <Link href={`/token/${p.token.chain}/${p.token.address}`} className="block px-4 py-3 active:bg-surface md:hover:bg-surface">
      <div className="flex items-center gap-3">
        <TokenIcon symbol={p.token.symbol} imageUrl={p.token.imageUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">{p.token.symbol}</span>
            <ChainBadge chain={p.token.chain} />
          </div>
          <p className="num text-xs text-muted">
            {formatQty(p.qty)} @ {formatPrice(p.avgEntryUsd)}
          </p>
        </div>
        <div className="text-right">
          <LiveNumber value={formatUsd(value?.toFixed())} numeric={value?.toNumber() ?? null} className="block font-medium" />
          <p className="num text-xs">
            <span className={pnl && pnl.lt(0) ? "text-down" : "text-up"}>{formatUsd(pnl?.toFixed(), { sign: true })}</span> <Pct value={pct} />
          </p>
        </div>
      </div>
      <div className="num mt-1.5 flex justify-between pl-12 text-xs text-faint">
        <span>Price {formatPrice(price)}</span>
        <span>Cost {formatUsd(p.costBasisUsd)}</span>
      </div>
    </Link>
  );
}

function ClosedRow({ p }: { p: PositionView }) {
  const realized = D(p.realizedPnlUsd);
  return (
    <Link href={`/token/${p.token.chain}/${p.token.address}`} className="flex items-center gap-3 px-4 py-3 active:bg-surface md:hover:bg-surface">
      <TokenIcon symbol={p.token.symbol} imageUrl={p.token.imageUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{p.token.symbol}</span>
          <ChainBadge chain={p.token.chain} />
        </div>
        <p className="text-xs text-muted">Closed {p.closedAt ? timeAgo(p.closedAt) : ""} ago</p>
      </div>
      <span className={`num font-medium ${realized.lt(0) ? "text-down" : "text-up"}`}>{formatUsd(realized.toFixed(), { sign: true })}</span>
    </Link>
  );
}

export default function PortfolioPage() {
  const { status, login } = useAuth();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const query = useQuery({ queryKey: ["portfolio"], queryFn: () => api.portfolio(), enabled: status === "in", refetchInterval: 30_000 });
  const open = useMemo(() => query.data?.open ?? [], [query.data]);
  const live = useLivePrices(open);

  const priceOf = (p: PositionView) => live[`${p.token.chain}:${p.token.address}`] ?? p.priceUsd;
  const totals = useMemo(() => {
    if (!query.data) return null;
    return portfolioTotals(
      open.map((p) => ({ qty: p.qty, costBasisUsd: p.costBasisUsd, realizedPnlUsd: p.realizedPnlUsd, priceUsd: priceOf(p) })),
      query.data.closed.map((c) => c.realizedPnlUsd),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live, query.data]);

  if (status === "out") {
    return <EmptyState title="Your portfolio lives here" body="Sign in to see positions and all-time PnL." action={<Button onClick={login}>Sign in</Button>} />;
  }
  if (query.isLoading || status === "loading") return <RowSkeletons />;
  if (!query.data || !totals) return <EmptyState title="Couldn't load your portfolio" action={<Button variant="secondary" onClick={() => void query.refetch()}>Retry</Button>} />;

  const allTime = D(totals.allTimeUsd);
  const netWorth = D(totals.valueUsd).add(query.data.cash.usdc);

  return (
    <div>
      <PageTitle right={<LinkButton href="/deposit" variant="secondary" className="px-3 py-1.5 text-sm">Add funds</LinkButton>}>Portfolio</PageTitle>
      <section className="px-4 pb-3">
        <p className="text-xs text-muted">Total value</p>
        <LiveNumber value={formatUsd(netWorth.toFixed())} numeric={netWorth.toNumber()} className="block text-[34px] leading-tight font-semibold" />
        <p className="num text-sm">
          <span className={allTime.lt(0) ? "text-down" : "text-up"}>{formatUsd(allTime.toFixed(), { sign: true })}</span>
          <span className="text-muted"> all time</span>
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-2xl bg-surface p-3">
          <Stat label="USDC" value={formatUsd(query.data.cash.usdc)} />
          <Stat label="Realized" value={<span className={D(totals.realizedUsd).lt(0) ? "text-down" : "text-up"}>{formatUsd(totals.realizedUsd, { sign: true })}</span>} />
          <Stat label="Unrealized" value={<span className={D(totals.unrealizedUsd).lt(0) ? "text-down" : "text-up"}>{formatUsd(totals.unrealizedUsd, { sign: true })}</span>} />
        </div>
      </section>
      <Segmented
        className="px-3 pb-1"
        value={tab}
        onChange={setTab}
        options={[
          { value: "open", label: `Open ${open.length}` },
          { value: "closed", label: `Closed ${query.data.closed.length}` },
        ]}
      />
      <OpenOrders showToken />
      {tab === "open" ? (
        open.length ? (
          <div className="divide-y divide-line/60">
            {open.map((p) => (
              <OpenRow key={p.id} p={p} price={priceOf(p)} />
            ))}
          </div>
        ) : (
          <EmptyState title="No open positions" body="Find a token you believe in and buy it in one tap." action={<LinkButton href="/">Browse trending</LinkButton>} />
        )
      ) : query.data.closed.length ? (
        <div className="divide-y divide-line/60">
          {query.data.closed.map((p) => (
            <ClosedRow key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <EmptyState title="Nothing closed yet" />
      )}
    </div>
  );
}
