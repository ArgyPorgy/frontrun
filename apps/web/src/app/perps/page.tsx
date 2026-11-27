"use client";

import { formatPrice, type PerpAssetClass } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { DesksSwitch } from "@/components/lending";
import {
  ASSET_LABELS,
  MarketHours,
  PerpPositions,
  compactUsd,
} from "@/components/perps";
import {
  PageTitle,
  PillFilter,
  RowSkeletons,
  Segmented,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useDebounced } from "@/lib/hooks";

type Filter = "all" | PerpAssetClass;
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "equity", label: "Stocks" },
  { value: "crypto", label: "Crypto" },
  { value: "fx", label: "FX" },
  { value: "metal", label: "Metals" },
  { value: "commodity", label: "Commodities" },
];

export default function PerpsPage() {
  const { status } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"markets" | "open" | "closed">("markets");
  const q = useDebounced(query.trim(), 250);
  const markets = useQuery({
    queryKey: ["perp-markets", filter, q],
    queryFn: () =>
      api.perpMarkets({
        assetClass: filter === "all" ? undefined : filter,
        q: q || undefined,
      }),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <PageTitle>Perps</PageTitle>
      <div className="px-4 pb-8">
        <DesksSwitch current="perps" />
        <p className="mb-4 text-sm text-muted">
          Long or short stocks, crypto, FX and metals with leverage. Settled in
          USDC on Base through Veranta.
        </p>
        {status === "in" && (
          <Segmented
            className="mb-4"
            options={[
              { value: "markets", label: "Markets" },
              { value: "open", label: "Positions" },
              { value: "closed", label: "History" },
            ]}
            value={tab}
            onChange={setTab}
          />
        )}
        {tab === "markets" ? (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search markets, like NVDA or ETH"
              aria-label="Search perp markets"
              className="mb-3 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
            />
            <PillFilter
              options={FILTERS}
              value={filter}
              onChange={setFilter}
              className="mb-3"
            />
            {markets.isLoading ? (
              <RowSkeletons />
            ) : (markets.data?.items ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">
                No markets match.
              </p>
            ) : (
              <div className="divide-y divide-line">
                <div className="grid grid-cols-[1fr_auto_auto] gap-3 pb-2 text-xs text-faint">
                  <span>Market</span>
                  <span className="w-24 text-right">Price</span>
                  <span className="hidden w-24 text-right sm:block">
                    Open interest
                  </span>
                </div>
                {markets.data!.items.map((m) => (
                  <Link
                    key={m.pairIndex}
                    href={`/perps/${m.pairIndex}`}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 py-3 hover:bg-surface"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {m.symbol} <MarketHours open={m.isOpen} />
                      </p>
                      <p className="text-xs text-muted">
                        {ASSET_LABELS[m.assetClass]} · up to {m.maxLeverage}x
                      </p>
                    </div>
                    <span className="num w-24 text-right text-sm">
                      {m.priceUsd ? formatPrice(m.priceUsd) : "-"}
                    </span>
                    <span className="num hidden w-24 text-right text-sm text-muted sm:block">
                      {compactUsd(
                        m.openInterest.longUsd + m.openInterest.shortUsd,
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : (
          <PerpPositions status={tab} />
        )}
      </div>
    </div>
  );
}
