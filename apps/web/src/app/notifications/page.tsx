"use client";

import { timeAgo, type NotificationView } from "@frontrun/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";
import { Avatar, Button, EmptyState, PageTitle, RowSkeletons, TokenIcon } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

function hrefFor(n: NotificationView): string {
  if (n.thesisId) return `/thesis/${n.thesisId}`;
  if (n.token) return `/token/${n.token.chain}/${n.token.address}`;
  if (n.actor) return `/u/${n.actor.username}`;
  if (n.type === "deposit") return "/portfolio";
  return "/";
}

export default function NotificationsPage() {
  const { status, login } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["notifications"], queryFn: () => api.notifications(), enabled: status === "in" });
  const unread = query.data?.unread ?? 0;
  useEffect(() => {
    if (unread > 0) {
      void api.markNotificationsRead().then(() => queryClient.invalidateQueries({ queryKey: ["notifications"] }));
    }
  }, [unread, queryClient]);

  if (status === "out") return <EmptyState title="Notifications" body="Sign in to get alerts from people you follow." action={<Button onClick={login}>Sign in</Button>} />;
  return (
    <div>
      <PageTitle>Notifications</PageTitle>
      {query.isLoading ? (
        <RowSkeletons count={5} />
      ) : query.data?.items.length ? (
        <ul className="divide-y divide-line/60">
          {query.data.items.map((n) => (
            <li key={n.id}>
              <Link href={hrefFor(n)} className={`flex items-center gap-3 px-4 py-3 ${n.read ? "" : "bg-signal/5"}`}>
                {n.actor ? <Avatar user={n.actor} size={34} /> : n.token ? <TokenIcon symbol={n.token.symbol} imageUrl={n.token.imageUrl} size={34} /> : <span className="h-[34px] w-[34px] rounded-full bg-raised" />}
                <p className="min-w-0 flex-1 text-sm">{n.message}</p>
                <span className="num text-xs text-faint">{timeAgo(n.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing yet" body="Alerts from people you follow, fills and deposits show up here." />
      )}
    </div>
  );
}
