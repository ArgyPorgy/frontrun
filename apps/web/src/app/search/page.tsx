"use client";

import { CHAINS, D, formatUsd, type ChainKey, type TraderResult } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CHAIN_OPTIONS } from "@/components/thesis-feed";
import { TokenRow } from "@/components/token-row";
import { Avatar, EmptyState, PillFilter, RowSkeletons } from "@/components/ui";
import { api } from "@/lib/api";
import { useDebounced } from "@/lib/hooks";

function SectionLabel({ children }: { children: string }) {
  return <p className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-faint uppercase">{children}</p>;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** A trader search result: a real profile preview with the headline activity from the DB. */
function TraderRow({ u }: { u: TraderResult }) {
  const bits = [plural(u.trades, "trade", "trades"), plural(u.theses, "thesis", "theses")];
  if (u.accuracy !== null) bits.push(`${Math.round(u.accuracy)}% accuracy`);
  if (u.followers > 0) bits.push(plural(u.followers, "follower", "followers"));
  const pnl = D(u.realizedPnlUsd);
  const pnlTone = pnl.gt(0) ? "text-up" : pnl.lt(0) ? "text-down" : "text-muted";
  return (
    <Link href={`/u/${u.username}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
      <Avatar user={u} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{u.username}</p>
        <p className="num mt-0.5 truncate text-xs text-muted">{bits.join("  ·  ")}</p>
      </div>
      {u.trades > 0 && (
        <div className="shrink-0 text-right">
          <p className={`num text-sm font-medium ${pnlTone}`}>{formatUsd(u.realizedPnlUsd, { sign: true })}</p>
          <p className="text-[11px] text-faint">realized</p>
        </div>
      )}
    </Link>
  );
}

export default function SearchPage() {
  const [text, setText] = useState("");
  const [chain, setChain] = useState<ChainKey | "all">("all");
  // Links from the trackers arrive with the token already filled in.
  useEffect(() => {
    const incoming = new URLSearchParams(window.location.search).get("q");
    if (incoming) setText(incoming);
  }, []);
  const q = useDebounced(text.trim(), 300);

  const tokens = useQuery({
    queryKey: ["search", "tokens", q, chain],
    queryFn: () => api.search(q, chain === "all" ? undefined : chain),
    enabled: q.length >= 2,
  });
  // Traders aren't tied to a chain, so the chain filter only narrows tokens — a trader match still
  // shows when a specific chain is selected.
  const traders = useQuery({
    queryKey: ["search", "users", q],
    queryFn: () => api.searchUsers(q),
    enabled: q.length >= 2,
  });
  // With no query typed, browse the live market list for the selected chain, so picking a chain shows
  // its tokens straight away. Same real data the Discover page uses — provider search alone misses some.
  const browse = useQuery({
    queryKey: ["search", "browse", chain],
    queryFn: () => api.marketList({ tab: "trending", chain: chain === "all" ? undefined : chain }),
    enabled: q.length < 2,
    refetchInterval: 30_000,
  });

  const tokenItems = tokens.data?.items ?? [];
  const traderItems = traders.data?.items ?? [];
  const browseItems = browse.data?.items ?? [];
  const loading = tokens.isLoading || traders.isLoading;
  const hasResults = tokenItems.length > 0 || traderItems.length > 0;

  return (
    <div>
      <div className="px-4 pt-3">
        <input
          autoFocus
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search tokens, CA, or traders"
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Search tokens and traders"
          className="w-full rounded-xl border border-line bg-surface px-4 py-3 outline-none focus:border-signal"
        />
      </div>
      <PillFilter className="mt-2 px-4 pb-2" value={chain} onChange={setChain} options={CHAIN_OPTIONS} />

      {q.length < 2 ? (
        browse.isLoading && !browseItems.length ? (
          <RowSkeletons count={8} />
        ) : browseItems.length ? (
          <section>
            <SectionLabel>{chain === "all" ? "Trending" : `Trending on ${CHAINS[chain].name}`}</SectionLabel>
            <div className="divide-y divide-line/60">
              {browseItems.map((t, i) => (
                <TokenRow key={`${t.chain}:${t.address}`} token={t} live={i < 10} />
              ))}
            </div>
            {browse.data?.attribution && <p className="px-4 py-3 text-center text-[11px] text-faint">{browse.data.attribution}</p>}
          </section>
        ) : (
          <EmptyState
            title="No tokens here yet"
            body="This chain's list is still filling in. Try another chain, or search by name, ticker or contract address."
            action={
              browse.isError ? (
                <button onClick={() => void browse.refetch()} className="rounded-xl bg-raised px-4 py-2 text-sm font-semibold text-ink">
                  Refresh
                </button>
              ) : undefined
            }
          />
        )
      ) : loading && !hasResults ? (
        <RowSkeletons count={6} />
      ) : !hasResults ? (
        <EmptyState title="No matches" body="Check the spelling, paste the contract address, or try a trader's username. Tokens flagged as high risk are left out." />
      ) : (
        <>
          {traderItems.length > 0 && (
            <section>
              <SectionLabel>Traders</SectionLabel>
              <div className="divide-y divide-line/60">
                {traderItems.map((u) => (
                  <TraderRow key={u.id} u={u} />
                ))}
              </div>
            </section>
          )}
          {tokenItems.length > 0 && (
            <section>
              {traderItems.length > 0 && <SectionLabel>Tokens</SectionLabel>}
              <div className="divide-y divide-line/60">
                {tokenItems.map((t, i) => (
                  <TokenRow key={`${t.chain}:${t.address}`} token={t} live={i < 10} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
