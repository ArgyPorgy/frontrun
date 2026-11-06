"use client";

import { CHAINS, CHAIN_KEYS, type ChainKey, type ThesisView } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useSocket } from "@/lib/socket";
import { ThesisCard } from "./thesis-card";
import { Button, ChainLogo, EmptyState, RowSkeletons } from "./ui";

export const CHAIN_OPTIONS: Array<{ value: ChainKey | "all"; label: string; icon?: React.ReactNode }> = [
  { value: "all", label: "All chains" },
  ...CHAIN_KEYS.map((k) => ({ value: k as ChainKey | "all", label: CHAINS[k].name, icon: <ChainLogo chain={k} size={14} /> })),
];

export function ThesisFeed({ tab, chain, showLeaderboard = true }: { tab: "top" | "recent" | "following"; chain: ChainKey | "all"; showLeaderboard?: boolean }) {
  const { status, login } = useAuth();
  const { onThesis } = useSocket();
  const [extra, setExtra] = useState<ThesisView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<ThesisView[]>([]);
  const query = useQuery({
    queryKey: ["theses", "feed", tab, chain],
    queryFn: () => api.theses({ tab, chain: chain === "all" ? undefined : chain }),
    enabled: tab !== "following" || status === "in",
    refetchInterval: 60_000,
  });

  useEffect(() => {
    setExtra([]);
    setPages([]);
    setCursor(query.data?.nextCursor ?? null);
  }, [query.data]);

  useEffect(
    () =>
      onThesis((t) => {
        // Every new thesis surfaces live on the non-following feeds, verified or not, so a freshly
        // published one is visible at once (matching what the feed query now returns).
        if (tab !== "following" && (chain === "all" || t.token.chain === chain)) {
          setExtra((list) => (list.some((x) => x.id === t.id) ? list : [t, ...list].slice(0, 20)));
        }
      }),
    [onThesis, tab, chain],
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
      {tab === "top" && showLeaderboard && (
        <Link href="/leaderboard" className="mx-4 mt-3 flex items-center justify-between rounded-xl bg-raised px-3 py-2.5 text-sm">
          <span className="font-medium">Reputation Score Leaderboard</span>
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
