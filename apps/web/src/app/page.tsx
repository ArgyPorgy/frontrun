"use client";

import { CHAINS, CHAIN_KEYS, formatPct, type ChainKey, type ThesisView, type TokenListItem } from "@frontrun/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ThesisCard } from "@/components/thesis-card";
import { TokenRow } from "@/components/token-row";
import { Button, EmptyState, LinkButton, PillFilter, RowSkeletons, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";
import { useSocket } from "@/lib/socket";

type Tab = "trending" | "new" | "top" | "following";

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

function ThesisFeed({ tab, chain }: { tab: "top" | "following"; chain: ChainKey | "all" }) {
  const { status, login } = useAuth();
  const { onThesis } = useSocket();
  const queryClient = useQueryClient();
  const [extra, setExtra] = useState<ThesisView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<ThesisView[]>([]);
  const query = useQuery({
    queryKey: ["theses", "feed", tab, chain],
    queryFn: () => api.theses({ tab, chain: chain === "all" ? undefined : chain }),
    enabled: tab !== "following" || status === "in",
  });

  useEffect(() => {
    setExtra([]);
    setPages([]);
    setCursor(query.data?.nextCursor ?? null);
  }, [query.data]);

  useEffect(
    () =>
      onThesis((t) => {
        if (tab === "top" && t.verified && (chain === "all" || t.token.chain === chain)) {
          setExtra((list) => (list.some((x) => x.id === t.id) ? list : [t, ...list].slice(0, 20)));
        }
      }),
    [onThesis, tab, chain, queryClient],
  );

  if (tab === "following" && status !== "in") {
    return <EmptyState title="See thesis posts from people you follow" action={<Button onClick={login}>Sign in</Button>} />;
  }
  if (query.isLoading) return <RowSkeletons count={5} />;
  const seen = new Set(extra.map((t) => t.id));
  const items = [...extra, ...(query.data?.items ?? []).filter((t) => !seen.has(t.id)), ...pages];
  if (!items.length) {
    return tab === "following" ? (
      <EmptyState title="Nothing here yet" body="Follow people from their profiles, and their thesis posts land here." />
    ) : (
      <EmptyState title="No thesis posts yet" body="They come from verified holders. Buy a token and be the first to pin one." />
    );
  }
  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.theses({ tab, chain: chain === "all" ? undefined : chain, cursor });
    setPages((list) => [...list, ...next.items]);
    setCursor(next.nextCursor);
  };
  return (
    <div>
      {tab === "top" && (
        <Link href="/leaderboard" className="mx-4 mt-3 flex items-center justify-between rounded-xl bg-surface px-3 py-2.5 text-sm">
          <span className="font-medium">Accuracy leaderboard</span>
          <span className="text-muted">Who&apos;s actually right →</span>
        </Link>
      )}
      <div className="divide-y divide-line/60">
        {items.map((t) => (
          <ThesisCard key={t.id} thesis={t} />
        ))}
      </div>
      {cursor && (
        <div className="p-4 text-center">
          <Button variant="secondary" onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

const CHAIN_OPTIONS: Array<{ value: ChainKey | "all"; label: string }> = [
  { value: "all", label: "All chains" },
  ...CHAIN_KEYS.map((k) => ({ value: k as ChainKey | "all", label: CHAINS[k].name })),
];

export default function HomePage() {
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
          ]}
        />
        <PillFilter className="mt-2 px-4" value={chain} onChange={setChain} options={CHAIN_OPTIONS} />
      </div>

      {tab === "top" || tab === "following" ? (
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
