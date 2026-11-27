"use client";

import { D, formatUsd, stockToken } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { DesksSwitch } from "@/components/lending";
import { MarketStatusPill, StockRow, useStocks } from "@/components/stocks";
import { PageTitle, RowSkeletons, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function StocksPage() {
  const { status } = useAuth();
  const stocks = useStocks();
  const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: () => api.portfolio(), enabled: status === "in", refetchInterval: 30_000 });

  const holdings = (portfolio.data?.open ?? []).filter((p) => p.token.chain === "base" && stockToken(p.token.address));
  const heldBy = new Map(holdings.map((p) => [p.token.address.toLowerCase(), p]));
  const value = holdings.reduce((a, p) => a.add(p.valueUsd ?? 0), D(0));
  const unrealized = holdings.reduce((a, p) => a.add(p.unrealizedPnlUsd ?? 0), D(0));

  return (
    <div>
      <PageTitle>Stocks</PageTitle>
      <div className="px-4 pb-8">
        <DesksSwitch current="stocks" />
        <p className="mb-3 text-sm text-muted">
          Tokenized shares from Coinbase, on Base. Each token tracks one share. Buy with USDC from your own wallet, hold them like any token, or borrow USDC against them on{" "}
          <Link href="/lend" className="font-medium text-signal">
            Lend
          </Link>
          .
        </p>
        {stocks.data && (
          <div className="mb-4">
            <MarketStatusPill market={stocks.data.market} />
          </div>
        )}

        {holdings.length > 0 && (
          <div className="mb-5 grid grid-cols-2 gap-3">
            <Stat label="Your stocks" value={formatUsd(value.toFixed(2))} sub={`${holdings.length} ${holdings.length === 1 ? "stock" : "stocks"}`} />
            <Stat label="Unrealized" value={<span className={unrealized.lt(0) ? "text-down" : "text-up"}>{formatUsd(unrealized.toFixed(2), { sign: true })}</span>} />
          </div>
        )}

        {stocks.isLoading ? (
          <RowSkeletons count={8} />
        ) : stocks.isError || !stocks.data ? (
          <p className="py-8 text-center text-sm text-muted">Couldn&apos;t load stocks. Try again in a moment.</p>
        ) : (
          <div className="divide-y divide-line">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 pb-2 text-xs text-faint">
              <span>Stock</span>
              <span className="w-28 text-right">Price</span>
              <span className="w-16 text-right">24h</span>
            </div>
            {stocks.data.stocks.map((s) => {
              const p = heldBy.get(s.address.toLowerCase());
              return <StockRow key={s.ticker} s={s} held={p ? { qty: p.qty, valueUsd: p.valueUsd } : undefined} />;
            })}
          </div>
        )}

        <p className="mt-5 text-xs leading-snug text-faint">
          Price is what the token trades at in its pools on Aerodrome and Uniswap. Share is Chainlink&apos;s Coinbase price for the stock itself. A buy more than 3% above the share price is refused. The stock market runs 24 hours a day, Sunday 8 PM to Friday 8 PM New York time; on weekends the tokens still trade, but can drift from the share price. Not for US persons.
        </p>
      </div>
    </div>
  );
}
