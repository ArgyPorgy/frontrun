"use client";

import { timeAgo, type TrackerPostView, type TrackerSource } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { Avatar, EmptyState, RowSkeletons } from "./ui";

const KIND_LABELS: Record<TrackerPostView["kind"], string | null> = { post: null, quote: "Quote", reply: "Reply", repost: "Repost" };

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
          {post.source === "x" ? "View on X" : "View on Telegram"}
        </a>
      </div>
    </article>
  );
}

/** What crypto's loudest accounts are saying, kept to posts that name a token or are about crypto. */
export function TrackerFeed({ source }: { source: TrackerSource }) {
  const query = useQuery({
    queryKey: ["tracker", source],
    queryFn: () => api.tracker(source),
    refetchInterval: 20_000,
  });
  if (query.isLoading) return <RowSkeletons count={5} />;
  if (!query.data?.items.length) {
    return query.data?.configured === false ? (
      <EmptyState title="X tracker isn't connected yet" body="It starts as soon as an X API token is added to the server." />
    ) : (
      <EmptyState title="Nothing yet" body="New posts from tracked channels land here within a few minutes." />
    );
  }
  return (
    <div className="divide-y divide-line/60">
      {query.data.items.map((p) => (
        <TrackerCard key={p.id} post={p} />
      ))}
    </div>
  );
}
