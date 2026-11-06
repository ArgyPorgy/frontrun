"use client";

import {
  APP_NAME,
  BODY_REJECTION_MESSAGES,
  THESIS_MAX_LENGTH,
  checkBody,
  explorerTxUrl,
  formatCompactUsd,
  formatPrice,
  liveBadge,
  positionEventLabel,
  positionTier,
  timeAgo,
  type ChainKey,
  type ThesisView,
} from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, APP_URL, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useMe } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { AgentBadge } from "./agents";
import { Avatar, Button, ChainBadge, Pct, Sheet, TokenIcon } from "./ui";

export function VerifiedBadge({ positionUsd }: { positionUsd: string }) {
  const tier = positionTier(positionUsd);
  return (
    <span className="num inline-flex items-center gap-1 rounded-md bg-signal/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-normal text-signal" title="Holds this token, checked against the chain when posting">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden>
        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {tier ? `$${tier >= 1000 ? "1K" : tier}+` : "Holder"}
    </span>
  );
}

function OutcomeBadge({ thesis }: { thesis: ThesisView }) {
  if (thesis.outcome === "pending") return <Pct value={thesis.returnPct} className="text-xs" />;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${thesis.outcome === "right" ? "text-up" : "text-down"}`}>
      {thesis.outcome === "right" ? "Called it" : "Missed"} <Pct value={thesis.returnPct} />
    </span>
  );
}

const BADGE_TONES = {
  good: "bg-up/15 text-up",
  warn: "bg-warn/15 text-warn",
  bad: "bg-down/15 text-down",
  muted: "bg-raised text-muted",
} as const;

/** What the author holds right now. Keyed on the value, so it visibly flips when a sale lands. */
export function LivePositionBadge({ thesis }: { thesis: ThesisView }) {
  const badge = liveBadge(thesis.live);
  return (
    <span key={badge.label} title={badge.hint} className={`num inline-flex animate-badge-flip items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${BADGE_TONES[badge.tone]}`}>
      {thesis.live.status !== "none" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />}
      {badge.label}
    </span>
  );
}

/** Every change to the position since posting, with its record on Arc. */
export function PositionHistory({ thesis }: { thesis: ThesisView }) {
  if (thesis.live.status === "none") return null;
  return (
    <section className="border-t border-line/70 px-4 py-3">
      <h2 className="text-sm font-semibold">Position since posting</h2>
      <ol className="mt-2 space-y-2 text-sm">
        <li className="flex items-baseline justify-between gap-3">
          <span>Posted holding {formatCompactUsd(thesis.positionUsdAtPost)} at {formatPrice(thesis.priceAtPost)}</span>
          <span className="flex shrink-0 items-baseline gap-2 text-xs text-faint">
            {timeAgo(thesis.ts)}
            {thesis.anchor && (
              <a href={explorerTxUrl("arc", thesis.anchor.txHash)} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2">
                Arc
              </a>
            )}
          </span>
        </li>
        {thesis.live.events.map((event) => (
          <li key={event.id} className="flex items-baseline justify-between gap-3">
            <span>
              {positionEventLabel(event)}
              {event.priceUsd && <span className="num text-muted"> at {formatPrice(event.priceUsd)}</span>}
            </span>
            <span className="flex shrink-0 items-baseline gap-2 text-xs text-faint">
              {timeAgo(event.at)}
              {event.txHash ? (
                <a href={explorerTxUrl("arc", event.txHash)} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2">
                  Arc
                </a>
              ) : (
                <span>Writing to Arc</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {!thesis.live.events.length && <p className="mt-2 text-xs text-faint">Nothing has changed since this was posted. Any sale will show here and on Arc.</p>}
    </section>
  );
}

export function shareThesis(thesis: ThesisView) {
  const url = `${APP_URL}/thesis/${thesis.id}`;
  const text = `${thesis.body.slice(0, 180)}${thesis.body.length > 180 ? "…" : ""}\n\n$${thesis.token.symbol} at ${formatPrice(thesis.priceAtPost)} on ${APP_NAME}`;
  const share = (navigator as Navigator & { share?: (data: ShareData) => Promise<void> }).share;
  if (share) {
    void share.call(navigator, { text, url }).catch(() => {});
  } else {
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, "_blank", "noopener");
  }
}

export function ThesisCard({
  thesis,
  showToken = true,
  onCopyBuy,
}: {
  thesis: ThesisView;
  showToken?: boolean;
  onCopyBuy?: (thesis: ThesisView) => void;
}) {
  const { status, login } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const me = useMe();
  const [liked, setLiked] = useState(thesis.likedByMe);
  const [likes, setLikes] = useState(thesis.likeCount);
  const [menu, setMenu] = useState(false);

  // Re-sync to the server's values whenever the feed refetches this thesis, so the count stays
  // correct (and keeps a like made elsewhere, or by someone else) instead of freezing at mount.
  useEffect(() => {
    setLiked(thesis.likedByMe);
    setLikes(thesis.likeCount);
  }, [thesis.id, thesis.likedByMe, thesis.likeCount]);

  const toggleLike = useMutation({
    mutationFn: () => (liked ? api.unlikeThesis(thesis.id) : api.likeThesis(thesis.id)),
    onMutate: () => {
      setLiked(!liked);
      setLikes(likes + (liked ? -1 : 1));
    },
    onError: (err) => {
      setLiked(liked);
      setLikes(likes);
      toast(errorMessage(err), { tone: "bad" });
    },
    onSettled: () => {
      // Pull the authoritative count/flag back from the server once the write lands, so the
      // optimistic value can't drift and navigating back (or a refresh) shows the same number.
      // This prefix covers the feed, the single-thesis view and profiles alike.
      void queryClient.invalidateQueries({ queryKey: ["theses"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteThesis(thesis.id),
    onSuccess: () => {
      setMenu(false);
      void queryClient.invalidateQueries({ queryKey: ["theses"] });
      toast("Thesis deleted");
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  const report = useMutation({
    mutationFn: () => api.report({ thesisId: thesis.id, reason: "scam" }),
    onSuccess: () => {
      setMenu(false);
      toast("Reported. Thanks for flagging it.");
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  const block = useMutation({
    mutationFn: () => api.block(thesis.author.username),
    onSuccess: () => {
      setMenu(false);
      void queryClient.invalidateQueries({ queryKey: ["theses"] });
      toast(`Blocked ${thesis.author.username}`);
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });

  const mine = me.data?.id === thesis.author.id;

  return (
    <article className="px-4 py-3">
      <div className="flex gap-2.5">
        <Link href={`/u/${thesis.author.username}`} aria-label={thesis.author.username}>
          <Avatar user={thesis.author} size={34} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Link href={`/u/${thesis.author.username}`} className="font-semibold">
              {thesis.author.username}
            </Link>
            <AgentBadge model={thesis.author.agentModel} />
            {thesis.verified && <VerifiedBadge positionUsd={thesis.positionUsdAtPost} />}
            {thesis.authorScore !== null && (
              <span className="num rounded-md bg-raised px-1.5 py-0.5 text-[10px] font-semibold text-cyan" title="This author's reputation score, out of 100">
                {thesis.authorScore}
              </span>
            )}
            <span className="text-xs text-faint">{timeAgo(thesis.ts)}</span>
            <button onClick={() => setMenu(true)} aria-label="More" className="ml-auto px-1 text-faint">
              ···
            </button>
          </div>
          <Link href={`/thesis/${thesis.id}`} className="mt-0.5 block whitespace-pre-wrap break-words">
            {thesis.body}
          </Link>
          {showToken && (
            <Link href={`/token/${thesis.token.chain}/${thesis.token.address}`} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1">
              <TokenIcon symbol={thesis.token.symbol} imageUrl={thesis.token.imageUrl} size={18} />
              <span className="text-sm font-medium">{thesis.token.symbol}</span>
              <ChainBadge chain={thesis.token.chain} />
            </Link>
          )}
          <div className="num mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <LivePositionBadge thesis={thesis} />
            {thesis.live.proofTx && (
              <a href={explorerTxUrl("arc", thesis.live.proofTx)} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2" title="This change to the author's position is recorded on Arc">
                Proof on Arc
              </a>
            )}
            <span>Posted at {formatPrice(thesis.priceAtPost)}</span>
            {thesis.verified && <span>With {formatCompactUsd(thesis.positionUsdAtPost)}</span>}
            <OutcomeBadge thesis={thesis} />
            {thesis.anchor && (
              <a href={explorerTxUrl("arc", thesis.anchor.txHash)} target="_blank" rel="noreferrer" className="text-signal underline underline-offset-2" title="This thesis's hash is recorded on Arc, so it can't be changed after the fact">
                Anchored on Arc
              </a>
            )}
          </div>
          <div className="mt-2 flex items-center gap-5 text-sm text-muted">
            <button
              onClick={() => (status === "in" ? toggleLike.mutate() : login())}
              aria-pressed={liked}
              className={`flex items-center gap-1 ${liked ? "text-signal" : ""}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.3 3 4.8 6.5 4.8c2.2 0 3.9 1.2 5.5 3.2 1.6-2 3.3-3.2 5.5-3.2 3.5 0 5.6 3.5 4.1 7C19.5 16.4 12 21 12 21z" strokeLinejoin="round" />
              </svg>
              <span className="num">{likes}</span>
              <span className="sr-only">likes</span>
            </button>
            <Link href={`/thesis/${thesis.id}`} className="flex items-center gap-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.4A8.5 8.5 0 1 1 21 12z" strokeLinejoin="round" />
              </svg>
              <span className="num">{thesis.replyCount}</span>
              <span className="sr-only">replies</span>
            </Link>
            <button onClick={() => shareThesis(thesis)} className="flex items-center gap-1">
              Share
            </button>
            {!mine && (
              <button
                onClick={() => (onCopyBuy ? onCopyBuy(thesis) : (window.location.href = `/token/${thesis.token.chain}/${thesis.token.address}?copy=${thesis.id}`))}
                className="ml-auto rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink"
              >
                Copy buy
              </button>
            )}
          </div>
        </div>
      </div>

      <Sheet open={menu} onClose={() => setMenu(false)}>
        <div className="flex flex-col gap-2">
          {mine ? (
            <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Delete thesis
            </Button>
          ) : status === "in" ? (
            <>
              <Button variant="secondary" onClick={() => report.mutate()} disabled={report.isPending}>
                Report as scam or spam
              </Button>
              <Button variant="danger" onClick={() => block.mutate()} disabled={block.isPending}>
                Block {thesis.author.username}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={login}>
              Sign in to report
            </Button>
          )}
          <p className="mt-1 text-center text-xs text-faint">A thesis is an opinion, not financial advice.</p>
        </div>
      </Sheet>
    </article>
  );
}

export function ThesisComposer({
  open,
  onClose,
  chain,
  address,
  symbol,
}: {
  open: boolean;
  onClose(): void;
  chain: ChainKey;
  address: string;
  symbol: string;
}) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const position = useQuery({
    queryKey: ["position", chain, address],
    queryFn: () => api.myPosition(chain, address),
    enabled: open,
  });
  const post = useMutation({
    mutationFn: () => api.createThesis({ chain, address, body }),
    onSuccess: () => {
      setBody("");
      setError(null);
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["theses"] });
      void queryClient.invalidateQueries({ queryKey: ["pins", chain, address] });
      toast("Pinned to the chart", { tone: "good" });
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = () => {
    const check = checkBody(body);
    if (!check.ok) {
      setError(BODY_REJECTION_MESSAGES[check.reason!]);
      return;
    }
    post.mutate();
  };
  const held = position.data?.position;
  return (
    <Sheet open={open} onClose={onClose} title={`Your thesis on ${symbol}`}>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        placeholder="Why this token, why now?"
        className="w-full resize-none rounded-xl border border-line bg-bg p-3 outline-none focus:border-signal"
      />
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className={held ? "text-signal" : "text-muted"}>
          {held ? `Verified holder: ${formatCompactUsd(held.valueUsd)} position` : "You don't hold this, so it posts without the verified badge"}
        </span>
        <span className={`num ${body.length > THESIS_MAX_LENGTH ? "text-down" : "text-faint"}`}>
          {body.length}/{THESIS_MAX_LENGTH}
        </span>
      </div>
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <p className="mt-3 text-xs text-faint">
        The price and your position lock when you post. You can delete a thesis later, but not edit it. A thesis is an opinion, not financial advice.
      </p>
      <Button onClick={submit} disabled={post.isPending || !body.trim()} className="mt-3 w-full">
        {post.isPending ? "Posting…" : "Pin to chart"}
      </Button>
    </Sheet>
  );
}
