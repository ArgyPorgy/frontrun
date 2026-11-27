"use client";

import { STOCK_ORACLE_GAP, formatPrice, formatUsd, stockPriceGap, stockToken, type StockMarketStatus, type StockView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { compactUsd } from "./perps";
import { Pct, TokenIcon } from "./ui";

export function useStocks(enabled = true) {
  return useQuery({ queryKey: ["stocks"], queryFn: () => api.stocks(), refetchInterval: 30_000, enabled });
}

/** "Fri 8 PM" in New York time, which is how the stock market keeps its hours. */
export function newYorkTime(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).replace(":00", "")} ET`;
}

export function MarketStatusPill({ market }: { market: StockMarketStatus }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${market.open ? "bg-up/10 text-up" : "bg-surface text-muted"}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${market.open ? "bg-up" : "bg-faint"}`} />
      {market.open ? `Market open · closes ${newYorkTime(market.nextChange)}` : `Market closed · opens ${newYorkTime(market.nextChange)}`}
    </span>
  );
}

function gapPct(s: StockView): number | null {
  if (!s.priceUsd || !s.sharePriceUsd) return null;
  return stockPriceGap("buy", s.priceUsd, s.sharePriceUsd) * 100;
}

export function StockRow({ s, held }: { s: StockView; held?: { qty: string; valueUsd: string | null } }) {
  const gap = gapPct(s);
  return (
    <Link href={`/token/base/${s.address}`} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-3 hover:bg-surface">
      <div className="flex min-w-0 items-center gap-3">
        <TokenIcon symbol={s.symbol} imageUrl={s.imageUrl} size={36} />
        <div className="min-w-0">
          <p className="truncate font-medium">{s.name}</p>
          <p className="truncate text-xs text-muted">
            {s.ticker}
            {held ? (
              ` · you hold ${held.valueUsd ? compactUsd(Number(held.valueUsd)) : Number(held.qty).toLocaleString("en-US", { maximumFractionDigits: 4 })}`
            ) : s.liquidityUsd ? (
              <span className="hidden sm:inline"> · {compactUsd(Number(s.liquidityUsd))} in pools</span>
            ) : null}
          </p>
        </div>
      </div>
      <div className="w-28 whitespace-nowrap text-right">
        <p className="num font-medium">{formatPrice(s.priceUsd)}</p>
        <p className={`num text-xs ${gap !== null && Math.abs(gap) > STOCK_ORACLE_GAP.warn * 100 ? "text-warn" : "text-faint"}`}>
          {s.sharePriceUsd ? `share ${formatUsd(s.sharePriceUsd)}` : "share -"}
        </p>
      </div>
      <div className="w-16 text-right">
        <Pct value={s.priceChange24hPct} className="text-sm" />
      </div>
    </Link>
  );
}

/** On a stock token's own page: what it is, and the share price it should sit near. */
export function StockNote({ chain, address }: { chain: string; address: string }) {
  const def = chain === "base" ? stockToken(address) : undefined;
  const stocks = useStocks(!!def);
  if (!def) return null;
  const s = stocks.data?.stocks.find((x) => x.ticker === def.ticker);
  const gap = s ? gapPct(s) : null;
  return (
    <section className="mx-4 my-2 rounded-2xl bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Tokenized {def.name} stock</p>
        {stocks.data && <MarketStatusPill market={stocks.data.market} />}
      </div>
      <p className="mt-1.5 text-xs leading-snug text-muted">
        Coinbase&apos;s token for one {def.name} share, on Base.
        {s?.sharePriceUsd ? (
          <>
            {" "}
            The share price is <span className="num text-ink">{formatUsd(s.sharePriceUsd)}</span> on Chainlink
            {gap !== null ? `, and the token trades ${Math.abs(gap) < 0.05 ? "at it" : `${Math.abs(gap).toFixed(2)}% ${gap > 0 ? "above" : "below"} it`}` : ""}.
          </>
        ) : null}{" "}
        A buy more than {STOCK_ORACLE_GAP.block * 100}% above the share price is refused.
        {s?.lendable ? (
          <>
            {" "}
            You can borrow USDC against it on{" "}
            <Link href="/lend" className="font-medium text-signal">
              Lend
            </Link>
            .
          </>
        ) : null}
      </p>
    </section>
  );
}
