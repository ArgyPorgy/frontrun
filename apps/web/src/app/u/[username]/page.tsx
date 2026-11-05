"use client";

import { D, formatPct, formatPrice, formatQty, formatUsd, type PositionView } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ThesisCard } from "@/components/thesis-card";
import { Avatar, Button, ChainBadge, EmptyState, LinkButton, Pct, RowSkeletons, Segmented, Sheet, Stat, TokenIcon } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";

function PositionRow({ p }: { p: PositionView }) {
  return (
    <Link href={`/token/${p.token.chain}/${p.token.address}`} className="flex items-center gap-3 px-4 py-3">
      <TokenIcon symbol={p.token.symbol} imageUrl={p.token.imageUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{p.token.symbol}</span>
          <ChainBadge chain={p.token.chain} />
        </div>
        <p className="num text-xs text-muted">
          {formatQty(p.qty)} @ {formatPrice(p.avgEntryUsd)}
        </p>
      </div>
      <div className="text-right">
        <p className="num font-medium">{formatUsd(p.valueUsd)}</p>
        <Pct value={p.returnPct} className="text-xs" />
      </div>
    </Link>
  );
}

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { status, login } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"theses" | "positions">("theses");
  const [menu, setMenu] = useState(false);

  const profile = useQuery({ queryKey: ["profile", username, status], queryFn: () => api.profile(username) });
  const theses = useQuery({ queryKey: ["theses", "user", username], queryFn: () => api.theses({ username, limit: 50 }) });
  const positions = useQuery({ queryKey: ["user-positions", username], queryFn: () => api.userPositions(username), enabled: tab === "positions" });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["profile", username] });
  const follow = useMutation({
    mutationFn: () => (profile.data?.isFollowing ? api.unfollow(username) : api.follow(username)),
    onSuccess: refresh,
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const block = useMutation({
    mutationFn: () => (profile.data?.isBlocked ? api.unblock(username) : api.block(username)),
    onSuccess: () => {
      setMenu(false);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["theses"] });
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const report = useMutation({
    mutationFn: () => api.report({ username, reason: "abuse" }),
    onSuccess: () => {
      setMenu(false);
      toast("Reported. Thanks for flagging it.");
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  if (profile.isLoading) return <RowSkeletons count={4} />;
  if (!profile.data) return <EmptyState title="User not found" />;
  const p = profile.data;
  const pnl = D(p.stats.allTimePnlUsd);

  return (
    <div>
      <section className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <Avatar user={p} size={60} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight">{p.username}</h1>
            <p className="num text-sm text-muted">
              {p.followers} followers · {p.following} following
            </p>
          </div>
          {p.isMe ? (
            <LinkButton href="/settings" variant="secondary" className="px-3 py-1.5 text-sm">
              Settings
            </LinkButton>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                variant={p.isFollowing ? "secondary" : "primary"}
                className="px-4 py-1.5 text-sm"
                disabled={follow.isPending || p.isBlocked}
                onClick={() => (status === "in" ? follow.mutate() : login())}
              >
                {p.isFollowing ? "Following" : "Follow"}
              </Button>
              <button onClick={() => setMenu(true)} aria-label="More" className="px-2 text-muted">
                ···
              </button>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 rounded-2xl bg-surface p-3">
          <Stat label="All-time PnL" value={<span className={pnl.lt(0) ? "text-down" : "text-up"}>{formatUsd(pnl.toFixed(), { sign: true })}</span>} />
          <Stat label="Win rate" value={p.stats.winRate !== null ? formatPct(p.stats.winRate, { sign: false }) : "—"} />
          <Stat
            label="Thesis accuracy"
            value={p.stats.accuracy !== null ? formatPct(p.stats.accuracy, { sign: false }) : "—"}
            sub={p.stats.resolved ? `${p.stats.right} of ${p.stats.resolved} right` : `${p.stats.theses} open`}
          />
        </div>
      </section>
      <Segmented
        className="px-3 pb-1"
        value={tab}
        onChange={setTab}
        options={[
          { value: "theses", label: `Theses ${p.stats.theses}` },
          { value: "positions", label: "Positions" },
        ]}
      />
      {tab === "theses" ? (
        theses.isLoading ? (
          <RowSkeletons count={3} />
        ) : theses.data?.items.length ? (
          <div className="divide-y divide-line/60">
            {theses.data.items.map((t) => (
              <ThesisCard key={t.id} thesis={t} />
            ))}
          </div>
        ) : (
          <EmptyState title="No theses yet" />
        )
      ) : positions.isLoading ? (
        <RowSkeletons count={3} />
      ) : positions.data?.open.length ? (
        <div className="divide-y divide-line/60">
          {positions.data.open.map((pos) => (
            <PositionRow key={pos.id} p={pos} />
          ))}
        </div>
      ) : (
        <EmptyState title="No open positions" />
      )}
      <Sheet open={menu} onClose={() => setMenu(false)}>
        <div className="flex flex-col gap-2">
          {status === "in" ? (
            <>
              <Button variant="secondary" onClick={() => report.mutate()} disabled={report.isPending}>
                Report {p.username}
              </Button>
              <Button variant="danger" onClick={() => block.mutate()} disabled={block.isPending}>
                {p.isBlocked ? "Unblock" : "Block"} {p.username}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={login}>
              Sign in
            </Button>
          )}
        </div>
      </Sheet>
    </div>
  );
}
