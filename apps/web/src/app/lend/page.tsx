"use client";

import { formatUsd, type LendingAction, type LendingMarketView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DesksSwitch, LendingActionRow, LendingSheet, MarketRow, PositionCard } from "@/components/lending";
import { EmptyState, PageTitle, RowSkeletons, Segmented, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function LendPage() {
  const { status } = useAuth();
  const [tab, setTab] = useState<"earn" | "borrow" | "history">("earn");
  const [open, setOpen] = useState<{ market: LendingMarketView; action: LendingAction } | null>(null);
  const markets = useQuery({ queryKey: ["lending-markets"], queryFn: () => api.lendingMarkets(), refetchInterval: 60_000 });
  const me = useQuery({ queryKey: ["lending-me"], queryFn: () => api.lendingMe(), enabled: status === "in", refetchInterval: 30_000 });
  const history = useQuery({ queryKey: ["lending-actions"], queryFn: () => api.lendingActions(), enabled: status === "in" && tab === "history" });

  const all = markets.data?.items ?? [];
  const earn = [...all].sort((a, b) => (a.venue === "morpho_market" ? 1 : 0) - (b.venue === "morpho_market" ? 1 : 0));
  const borrow = all.filter((m) => m.venue === "morpho_market");
  const positions = me.data?.positions ?? [];
  const positionFor = (id: string) => positions.find((p) => p.market.id === id);

  return (
    <div>
      <PageTitle>Lend & borrow</PageTitle>
      <div className="px-4 pb-8">
        <DesksSwitch current="lend" />
        <p className="mb-4 text-sm text-muted">Earn on idle USDC with Aave and Morpho, or borrow USDC against tokenized stocks without selling them. All on Base, from your own wallet.</p>

        {status === "in" && me.data && (positions.length > 0 || me.data.stocks.length > 0) && (
          <section className="mb-6">
            <div className="mb-3 grid grid-cols-3 gap-3">
              <Stat label="Lent" value={formatUsd(me.data.totalSuppliedUsd)} />
              <Stat label="Collateral" value={formatUsd(me.data.totalCollateralUsd)} />
              <Stat label="Borrowed" value={formatUsd(me.data.totalBorrowedUsd)} />
            </div>
            <div className="space-y-2">
              {positions.map((p) => (
                <PositionCard key={p.market.id} p={p} onOpen={() => setOpen({ market: p.market, action: Number(p.borrowedUsd) > 0 ? "repay" : p.market.venue === "morpho_market" && Number(p.collateralQty) > 0 ? "borrow" : "withdraw" })} />
              ))}
            </div>
            {me.data.stocks.length > 0 && (
              <p className="mt-3 text-xs text-muted">
                In your wallet, ready to borrow against: {me.data.stocks.map((s) => `${Number(s.qty).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${s.symbol}${s.usd ? ` (${formatUsd(s.usd)})` : ""}`).join(", ")}
              </p>
            )}
          </section>
        )}

        <Segmented
          className="mb-3"
          options={[
            { value: "earn", label: "Earn" },
            { value: "borrow", label: "Borrow" },
            ...(status === "in" ? [{ value: "history" as const, label: "History" }] : []),
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === "history" ? (
          history.isLoading ? (
            <RowSkeletons count={4} />
          ) : history.data?.items.length ? (
            <div className="divide-y divide-line">
              {history.data.items.map((a) => (
                <LendingActionRow key={a.id} a={a} />
              ))}
            </div>
          ) : (
            <EmptyState title="Nothing yet" body="Lending moves you or your agents make show here." />
          )
        ) : markets.isLoading ? (
          <RowSkeletons />
        ) : markets.isError ? (
          <p className="py-8 text-center text-sm text-muted">Couldn't load rates. Try again in a moment.</p>
        ) : (
          <div className="divide-y divide-line">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 pb-2 text-xs text-faint">
              <span>Market</span>
              <span className="w-20 text-right">{tab === "earn" ? "Lend APY" : "Borrow APY"}</span>
              <span className="w-20 text-right">{tab === "earn" ? "Deposits" : "Free"}</span>
            </div>
            {(tab === "earn" ? earn : borrow).map((m) => (
              <MarketRow key={m.id} m={m} side={tab} onOpen={() => setOpen({ market: m, action: tab === "earn" ? "supply" : "supply_collateral" })} />
            ))}
          </div>
        )}
        {tab === "borrow" && (
          <p className="mt-4 text-xs leading-snug text-faint">
            Front Run created the TSLA, AMZN and MSFT markets on Morpho, using Morpho's own oracle factory and Chainlink's Coinbase price feeds, the same setup as Morpho's listed stock markets. New markets start with little USDC to borrow until people lend into them.
          </p>
        )}
      </div>
      {open && <LendingSheet market={open.market} position={positionFor(open.market.id)} summary={me.data} initial={open.action} onClose={() => setOpen(null)} />}
    </div>
  );
}
