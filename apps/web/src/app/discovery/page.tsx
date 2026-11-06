"use client";

import { formatPct, type ChainKey, type TokenListItem } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { HomeDesktop } from "@/components/home-desktop";
import { CHAIN_OPTIONS, ThesisFeed } from "@/components/thesis-feed";
import { TokenRow } from "@/components/token-row";
import { TrackerFeed } from "@/components/tracker-feed";
import { Button, EmptyState, LinkButton, PillFilter, RowSkeletons, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";

type Tab = "trending" | "new" | "top" | "following" | "x" | "telegram";

const LIVE_ROWS = 20;

function Tape({ items }: { items: TokenListItem[] }) {
  if (items.length < 4) return null;
  const row = items.slice(0, 16);
  return (
    <div className="overflow-hidden border-y border-line/70 py-2" aria-hidden>
      <div className="animate-tape flex w-max gap-6 pl-4">
        {[...row, ...row].map((t, i) => (
          <span key={`${t.chain}:${t.address}:${i}`} className="num flex items-center gap-1.5 text-xs whitespace-nowrap">
            <span className="font-semibold">{t.symbol}</span>
            <span className={t.priceChangePct.h24 >= 0 ? "text-up" : "text-down"}>{formatPct(t.priceChangePct.h24)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Landing({ items }: { items: TokenListItem[] }) {
  const { login, mode } = useAuth();
  return (
    <section>
      <div className="px-4 pt-6 pb-5">
        <h1 className="max-w-md text-[28px] leading-[1.15] font-semibold tracking-tight">
          Any token. One USDC balance. Every thesis from someone who actually holds.
        </h1>
        <p className="mt-2 max-w-md text-muted">
          Buy on 8 chains from your balance on Arc in one tap. Every thesis shows the author&apos;s real position and whether they were right.
        </p>
        <Button onClick={login} className="mt-4 w-full md:w-auto md:px-8">
          {mode === "dev" ? "Sign in (dev mode)" : "Sign in with Google"}
        </Button>
      </div>
      <Tape items={items} />
    </section>
  );
}

function SetupNudge() {
  const me = useMe();
  if (!me.data) return null;
  if (me.data.onboarding === "deposit") {
    return (
      <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm">
          <span className="font-semibold">Add USDC to start.</span> <span className="text-muted">It's all you need to trade anything.</span>
        </p>
        <LinkButton href="/deposit" className="shrink-0 px-3 py-1.5 text-sm">
          Add funds
        </LinkButton>
      </div>
    );
  }
  if (me.data.onboarding === "enable_one_tap") {
    return (
      <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm">
          <span className="font-semibold">Turn on one-tap trading.</span> <span className="text-muted">No prompt on every trade.</span>
        </p>
        <LinkButton href="/onboarding" className="shrink-0 px-3 py-1.5 text-sm">
          Set up
        </LinkButton>
      </div>
    );
  }
  return null;
}

function useIsWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

export default function DiscoveryPage() {
  const wide = useIsWide();
  return wide ? <HomeDesktop /> : <HomeMobile />;
}

function HomeMobile() {
  const { status } = useAuth();
  const [tab, setTab] = useState<Tab>("trending");
  const [chain, setChain] = useState<ChainKey | "all">("all");

  const market = useQuery({
    queryKey: ["market", tab === "new" ? "new" : "trending", chain],
    queryFn: () => api.marketList({ tab: tab === "new" ? "new" : "trending", chain: chain === "all" ? undefined : chain }),
    refetchInterval: 30_000,
    retry: 4,
    retryDelay: (attempt) => Math.min(3000 * 2 ** attempt, 20_000),
  });
  const items = market.data?.items ?? [];

  return (
    <>
      {status === "out" && <Landing items={items} />}
      {status === "in" && <SetupNudge />}
      <div className="sticky top-[53px] z-10 bg-bg/95 pt-2 pb-2 backdrop-blur md:top-[53px]">
        <Segmented
          className="px-3"
          value={tab}
          onChange={setTab}
          options={[
            { value: "trending", label: "Trending" },
            { value: "new", label: "New" },
            { value: "top", label: "Top thesis" },
            { value: "following", label: "Following" },
            { value: "x", label: "X tracker" },
            { value: "telegram", label: "TG tracker" },
          ]}
        />
        {tab !== "x" && tab !== "telegram" && <PillFilter className="mt-2 px-4" value={chain} onChange={setChain} options={CHAIN_OPTIONS} />}
      </div>

      {tab === "x" || tab === "telegram" ? (
        <TrackerFeed source={tab} />
      ) : tab === "top" || tab === "following" ? (
        <ThesisFeed tab={tab} chain={chain} />
      ) : market.isLoading ? (
        <RowSkeletons />
      ) : items.length === 0 ? (
        <EmptyState
          title={market.isError ? "Market data is catching up" : "Nothing listed here yet"}
          body={market.isError ? "Lists refresh on their own in a moment." : "Lists fill in as data arrives. Try another chain or search for a token."}
          action={
            <Button variant="secondary" onClick={() => void market.refetch()}>
              Refresh
            </Button>
          }
        />
      ) : (
        <>
          <div className="divide-y divide-line/60">
            {items.map((t, i) => (
              <TokenRow key={`${t.chain}:${t.address}`} token={t} live={i < LIVE_ROWS} />
            ))}
          </div>
          <p className="px-4 py-3 text-center text-[11px] text-faint">
            {market.data?.attribution}. Boosted placements are paid for and labelled.
          </p>
        </>
      )}
    </>
  );
}
