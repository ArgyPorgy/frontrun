"use client";

import { timeAgo, type NotificationView, type TradeView } from "@frontrun/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TradeCardSheet, earnsTradeCard } from "@/components/trade-card";
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

/** Icon for notifications that have no author or token — e.g. a USDC deposit landing. */
function NotificationGlyph({ type }: { type: NotificationView["type"] }) {
  const svg = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (type === "deposit") {
    return (
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-up/15 text-up">
        <svg {...svg} aria-hidden>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-raised text-muted">
      <svg {...svg} aria-hidden>
        <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
    </span>
  );
}

function NotificationBody({ n }: { n: NotificationView }) {
  return (
    <>
      {n.actor ? <Avatar user={n.actor} size={34} /> : n.token ? <TokenIcon symbol={n.token.symbol} imageUrl={n.token.imageUrl} size={34} /> : <NotificationGlyph type={n.type} />}
      <p className="min-w-0 flex-1 text-sm">{n.message}</p>
      <span className="num text-xs text-faint">{timeAgo(n.createdAt)}</span>
    </>
  );
}

export default function NotificationsPage() {
  const { status, login } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["notifications"], queryFn: () => api.notifications(), enabled: status === "in" });
  const unread = query.data?.unread ?? 0;
  const [openTrade, setOpenTrade] = useState<TradeView | null>(null);
  const router = useRouter();
  const openNotification = async (n: NotificationView) => {
    const trade = await api.trade(n.tradeId!);
    if (earnsTradeCard(trade)) setOpenTrade(trade);
    else router.push(hrefFor(n));
  };
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
              {n.tradeId ? (
                <button onClick={() => void openNotification(n)} className={`flex w-full items-center gap-3 px-4 py-3 text-left ${n.read ? "" : "bg-signal/5"}`}>
                  <NotificationBody n={n} />
                </button>
              ) : (
                <Link href={hrefFor(n)} className={`flex items-center gap-3 px-4 py-3 ${n.read ? "" : "bg-signal/5"}`}>
                  <NotificationBody n={n} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nothing yet" body="Alerts from people you follow, fills and deposits show up here." />
      )}
      <TradeCardSheet trade={openTrade} onClose={() => setOpenTrade(null)} />
    </div>
  );
}
