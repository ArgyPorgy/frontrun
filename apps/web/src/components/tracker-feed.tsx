"use client";

import { timeAgo, type ChainKey, type TrackerPostKind, type TrackerPostView, type TrackerSource } from "@frontrun/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Avatar, EmptyState, RowSkeletons } from "./ui";

const KIND_LABELS: Record<TrackerPostKind, string | null> = { post: null, quote: "Quote", reply: "Reply", repost: "Repost", follow: "Follow" };

const PAGE_SIZE = 40;

const X_FILTERS: Array<{ value: TrackerPostKind | null; label: string }> = [
  { value: null, label: "All" },
  { value: "post", label: "Posts" },
  { value: "reply", label: "Replies" },
  { value: "repost", label: "Reposts" },
  { value: "quote", label: "Quotes" },
  { value: "follow", label: "Follows" },
];

function shortToken(token: string): string {
  return token.startsWith("$") ? token : `${token.slice(0, 5)}…${token.slice(-4)}`;
}

function TrackerAvatar({ post }: { post: TrackerPostView }) {
  const [failed, setFailed] = useState(false);
  if (post.authorAvatar && !failed) {
    return (
      // Comes straight from X or Telegram, and each is a small one-off image.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={post.authorAvatar} alt="" width={34} height={34} loading="lazy" onError={() => setFailed(true)} className="shrink-0 rounded-full bg-raised object-cover" style={{ width: 34, height: 34 }} />
    );
  }
  return <Avatar user={{ username: post.authorName, avatarUrl: null }} size={34} />;
}

function TrackerCard({ post }: { post: TrackerPostView }) {
  const kind = KIND_LABELS[post.kind];
  return (
    <article className="flex gap-2.5 px-4 py-3">
      <TrackerAvatar post={post} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5">
          <span className="max-w-[60%] truncate text-sm font-semibold">{post.authorName}</span>
          {kind && <span className="rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted">{kind}</span>}
          <span className="ml-auto text-xs text-faint">{timeAgo(post.postedAt)}</span>
        </div>
        <p className="mt-0.5 text-xs text-muted">@{post.authorHandle}</p>
        <p className="mt-1 line-clamp-6 whitespace-pre-wrap break-words text-sm">{post.body}</p>
        {post.tokens.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {post.tokens.map((t) => (
              <Link key={t} href={`/search?q=${encodeURIComponent(t.replace(/^\$/, ""))}`} className="num rounded-md bg-signal/15 px-1.5 py-0.5 text-xs font-medium text-signal">
                {shortToken(t)}
              </Link>
            ))}
          </div>
        )}
        <a href={post.url} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-block text-xs text-muted underline underline-offset-2">
          {post.kind === "follow" ? "View profile" : post.source === "x" ? "View on X" : "View on Telegram"}
        </a>
      </div>
    </article>
  );
}

/** Live posts on X that mention this token's contract address. */
export function TokenTweetsPanel({ chain, address }: { chain: ChainKey; address: string }) {
  const query = useQuery({ queryKey: ["token-tweets", chain, address], queryFn: () => api.tokenTweets(chain, address), refetchInterval: 60_000, staleTime: 30_000 });
  const data = query.data;
  if (data && !data.configured) return null;
  return (
    <section aria-label="Posts on X about this token">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-3">
        <p className="text-sm font-semibold">On X</p>
        <p className="text-xs text-faint">Posts with this contract address</p>
      </div>
      {query.isLoading ? (
        <RowSkeletons />
      ) : data?.items.length ? (
        <div className="max-h-96 divide-y divide-line/60 overflow-y-auto">
          {data.items.map((post) => (
            <TrackerCard key={post.id} post={post} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-4 text-sm text-muted">{query.isError || data?.unavailable ? "X can't be read right now. This will try again shortly." : "No recent posts mention this contract address yet."}</p>
      )}
    </section>
  );
}

function TrackerPosts({ source, kind }: { source: TrackerSource; kind: TrackerPostKind | null }) {
  const query = useInfiniteQuery({
    queryKey: ["tracker", source, kind],
    queryFn: ({ pageParam }) => api.tracker(source, { before: pageParam, kind: kind ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.items.length < PAGE_SIZE ? undefined : last.items.at(-1)?.postedAt),
    refetchInterval: 20_000,
  });
  if (query.isLoading) return <RowSkeletons count={5} />;
  const posts = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (!posts.length) {
    if (query.data?.pages[0]?.configured === false) {
      return <EmptyState title="X tracker isn't connected yet" body="It starts as soon as its key is added to the server." />;
    }
    return kind === "follow" ? (
      <EmptyState title="No new follows yet" body="Each account's follows are checked a few times a day, and the first check only takes notes." />
    ) : (
      <EmptyState title="Nothing yet" body="New posts from tracked accounts land here within a few minutes." />
    );
  }
  return (
    <>
      <div className="divide-y divide-line/60">
        {posts.map((p) => (
          <TrackerCard key={p.id} post={p} />
        ))}
      </div>
      {query.hasNextPage && (
        <div className="p-3 text-center">
          <button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-muted hover:text-ink disabled:opacity-40">
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}

/** What the tracked accounts are up to. On X that's everything they do that can be read, and it can be narrowed by kind. */
export function TrackerFeed({ source }: { source: TrackerSource }) {
  const [kind, setKind] = useState<TrackerPostKind | null>(null);
  return (
    <>
      {source === "x" && (
        <div className="no-scrollbar flex gap-1.5 overflow-x-auto border-b border-line/60 px-3 py-2" role="group" aria-label="Filter by activity">
          {X_FILTERS.map((f) => (
            <button
              key={f.label}
              aria-pressed={kind === f.value}
              onClick={() => setKind(f.value)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${kind === f.value ? "bg-signal/15 text-signal" : "bg-raised text-muted hover:text-ink"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      <TrackerPosts source={source} kind={source === "x" ? kind : null} />
    </>
  );
}
