"use client";

import {
  ApiError,
  D,
  POSITION_TIERS,
  explorerTokenUrl,
  formatCompactUsd,
  formatCount,
  formatPrice,
  formatQty,
  formatUsd,
  isChainKey,
  shortAddress,
  timeAgo,
  type ChainKey,
  type ThesisView,
  type TokenDetail,
  type WindowStats,
} from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PriceChart } from "@/components/chart";
import { ThesisCard, ThesisComposer } from "@/components/thesis-card";
import { TradeBar } from "@/components/trade-bar";
import { Button, ChainBadge, CopyButton, EmptyState, LiveNumber, Pct, PillFilter, RowSkeletons, Segmented, Sheet, Skeleton, Stat, TokenIcon } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLivePrice, useSocket } from "@/lib/socket";

type WindowKey = keyof WindowStats<number>;

function StatsPanel({ token }: { token: TokenDetail }) {
  const [window, setWindow] = useState<WindowKey>("h24");
  const txns = token.txns[window];
  const total = txns.buys + txns.sells;
  const buyShare = total ? (txns.buys / total) * 100 : 50;
  return (
    <section className="px-4 py-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Market cap" value={formatCompactUsd(token.marketCapUsd ?? token.fdvUsd)} />
        <Stat label="Liquidity" value={formatCompactUsd(token.liquidityUsd)} />
        <Stat label="Holders" value={formatCount(token.holders.count)} />
      </div>
      <PillFilter
        className="mt-3"
        value={window}
        onChange={setWindow}
        options={[
          { value: "m5", label: "5m" },
          { value: "h1", label: "1h" },
          { value: "h6", label: "6h" },
          { value: "h24", label: "24h" },
        ]}
      />
      <div className="mt-2 grid grid-cols-3 gap-3">
        <Stat label="Volume" value={formatCompactUsd(token.volumeUsd[window])} />
        <Stat label="Change" value={<Pct value={token.priceChangePct[window]} />} />
        <Stat label="Makers 24h" value={token.makers ? formatCount(token.makers.buyers24h + token.makers.sellers24h) : "—"} />
      </div>
      <div className="mt-3">
        <div className="num flex justify-between text-xs">
          <span className="text-up">{formatCount(txns.buys)} buys</span>
          <span className="text-down">{formatCount(txns.sells)} sells</span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-down/60" role="img" aria-label={`${buyShare.toFixed(0)}% buys`}>
          <div className="bg-up" style={{ width: `${buyShare}%` }} />
        </div>
      </div>
    </section>
  );
}

function RiskFlags({ token }: { token: TokenDetail }) {
  const [open, setOpen] = useState(false);
  if (!token.risk.length) return null;
  return (
    <section className="px-4 pb-1">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex flex-wrap items-center gap-1.5 text-left">
        {token.risk.map((f) => (
          <span key={f.code + f.label} className={`rounded-md px-2 py-0.5 text-xs font-medium ${f.severity === "high" ? "bg-down/15 text-down" : "bg-warn/15 text-warn"}`}>
            {f.label}
          </span>
        ))}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-sm text-muted">
          {token.risk.map((f) => (
            <li key={f.code + f.label}>{f.detail}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PositionCard({ chain, address, symbol, onPost }: { chain: ChainKey; address: string; symbol: string; onPost(): void }) {
  const { status } = useAuth();
  const tick = useLivePrice(chain, address);
  const position = useQuery({
    queryKey: ["position", chain, address],
    queryFn: () => api.myPosition(chain, address),
    enabled: status === "in",
  });
  const p = position.data?.position;
  if (!p) return null;
  const price = tick?.priceUsd ?? p.priceUsd;
  const value = price ? D(p.qty).mul(price) : null;
  const pnl = value ? value.sub(p.costBasisUsd) : null;
  const pct = pnl && D(p.costBasisUsd).gt(0) ? pnl.div(p.costBasisUsd).mul(100).toNumber() : null;
  return (
    <section className="mx-4 my-2 rounded-2xl bg-surface p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Your position</p>
        <button onClick={onPost} className="text-sm font-semibold text-signal">
          Post thesis
        </button>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-3">
        <Stat label="Value" value={formatUsd(value?.toFixed())} sub={`${formatQty(p.qty)} ${symbol}`} />
        <Stat label="Avg entry" value={formatPrice(p.avgEntryUsd)} />
        <Stat label="PnL" value={<span className={pnl && pnl.lt(0) ? "text-down" : "text-up"}>{formatUsd(pnl?.toFixed(), { sign: true })}</span>} sub={<Pct value={pct} />} />
      </div>
    </section>
  );
}

function ThesisPanel({
  chain,
  address,
  onCopyBuy,
  focusId,
}: {
  chain: ChainKey;
  address: string;
  onCopyBuy(t: ThesisView): void;
  focusId: string | null;
}) {
  const [min, setMin] = useState<number>(0);
  const [sort, setSort] = useState<"liked" | "recent">("liked");
  const query = useQuery({
    queryKey: ["theses", "token", chain, address, min, sort],
    queryFn: () => api.theses({ chain, address, minPosition: min || undefined, sort, includeUnverified: min === 0 }),
  });
  const refs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (focusId) refs.current.get(focusId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusId, query.data]);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <PillFilter
          value={min}
          onChange={setMin}
          options={[{ value: 0, label: "All" }, ...POSITION_TIERS.map((t) => ({ value: t as number, label: t >= 1000 ? "$1K+" : `$${t}+` }))]}
        />
        <button onClick={() => setSort(sort === "liked" ? "recent" : "liked")} className="shrink-0 text-xs font-medium text-muted">
          {sort === "liked" ? "Most liked" : "Most recent"} ↓
        </button>
      </div>
      {query.isLoading ? (
        <RowSkeletons count={3} />
      ) : query.data?.items.length ? (
        <div className="divide-y divide-line/60">
          {query.data.items.map((t) => (
            <div
              key={t.id}
              ref={(el) => {
                if (el) refs.current.set(t.id, el);
                else refs.current.delete(t.id);
              }}
              className={focusId === t.id ? "bg-signal/5" : ""}
            >
              <ThesisCard thesis={t} showToken={false} onCopyBuy={onCopyBuy} />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={min ? "None at this position size" : "No thesis on this token yet"} body="Hold it and pin the first one to the chart." />
      )}
    </div>
  );
}

function TapePanel({ chain, address }: { chain: ChainKey; address: string }) {
  const query = useQuery({
    queryKey: ["tape", chain, address],
    queryFn: () => api.tape(chain, address),
    refetchInterval: 20_000,
    retry: 2,
  });
  if (query.isLoading) return <RowSkeletons count={5} />;
  if (!query.data?.items.length) return <EmptyState title={query.isError ? "Trade data is catching up" : "No recent trades"} />;
  return (
    <table className="num w-full text-xs">
      <thead className="text-faint">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Age</th>
          <th className="py-2 text-right font-medium">USD</th>
          <th className="py-2 text-right font-medium">Price</th>
          <th className="px-4 py-2 text-right font-medium">Maker</th>
        </tr>
      </thead>
      <tbody>
        {query.data.items.map((t) => (
          <tr key={t.id} className="border-t border-line/40">
            <td className="px-4 py-1.5 text-muted">{timeAgo(t.time)}</td>
            <td className={`py-1.5 text-right ${t.side === "buy" ? "text-up" : "text-down"}`}>{formatUsd(t.usd)}</td>
            <td className="py-1.5 text-right">{formatPrice(t.priceUsd)}</td>
            <td className="px-4 py-1.5 text-right text-muted">{shortAddress(t.maker)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HoldersPanel({ token }: { token: TokenDetail }) {
  const { count, top10Pct, source } = token.holders;
  return (
    <section className="px-4 py-4">
      {count === null && top10Pct === null ? (
        <p className="text-sm text-muted">Holder data isn&apos;t available for this token yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Holders" value={formatCount(count)} />
            <Stat label="Top 10 hold" value={top10Pct !== null ? `${top10Pct.toFixed(1)}%` : "—"} />
          </div>
          {top10Pct !== null && (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised" role="img" aria-label={`Top 10 wallets hold ${top10Pct.toFixed(0)}%`}>
              <div className={top10Pct > 50 ? "h-full bg-down" : "h-full bg-signal"} style={{ width: `${Math.min(top10Pct, 100)}%` }} />
            </div>
          )}
          {source && <p className="mt-2 text-xs text-faint">Source: {source === "geckoterminal" ? "GeckoTerminal" : "Flash"}</p>}
        </>
      )}
      <a href={explorerTokenUrl(token.chain, token.address)} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-muted underline underline-offset-2">
        View on explorer
      </a>
    </section>
  );
}

function TokenScreen({ chain, address }: { chain: ChainKey; address: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const { status, login } = useAuth();
  const { onThesis } = useSocket();
  const [tab, setTab] = useState<"theses" | "trades" | "holders">("theses");
  const [composer, setComposer] = useState(false);
  const [copyThesis, setCopyThesis] = useState<ThesisView | null>(null);
  const [pinSheet, setPinSheet] = useState<ThesisView | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [newPins, setNewPins] = useState<ThesisView[]>([]);

  const token = useQuery({
    queryKey: ["token", chain, address],
    queryFn: () => api.token(chain, address),
    refetchInterval: 30_000,
  });
  const pins = useQuery({
    queryKey: ["pins", chain, address],
    queryFn: () => api.theses({ chain, address, includeUnverified: true, tab: "recent", limit: 50 }),
    refetchInterval: 60_000,
  });
  const position = useQuery({
    queryKey: ["position", chain, address],
    queryFn: () => api.myPosition(chain, address),
    enabled: status === "in",
  });
  const tick = useLivePrice(chain, address);

  const copyId = params.get("copy");
  const copyTarget = useQuery({
    queryKey: ["thesis", copyId],
    queryFn: () => api.thesis(copyId!),
    enabled: !!copyId,
  });
  useEffect(() => {
    if (copyTarget.data) setCopyThesis(copyTarget.data);
  }, [copyTarget.data]);

  useEffect(
    () =>
      onThesis((t) => {
        if (t.token.chain === chain && t.token.address === address) setNewPins((list) => [t, ...list.filter((x) => x.id !== t.id)]);
      }),
    [onThesis, chain, address],
  );

  const allPins = useMemo(() => {
    const seen = new Set(newPins.map((p) => p.id));
    return [...newPins, ...(pins.data?.items ?? []).filter((p) => !seen.has(p.id))];
  }, [newPins, pins.data]);

  if (token.isLoading) {
    return (
      <div className="p-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="mt-4 h-72 w-full" />
      </div>
    );
  }
  if (!token.data) {
    // A 503 means market data is briefly limited, which says nothing about whether the token exists.
    if (token.error instanceof ApiError && token.error.status !== 404) {
      return <EmptyState title="Market data is catching up" body="This token should load in a moment." action={<Button variant="secondary" disabled={token.isFetching} onClick={() => void token.refetch()}>Try again</Button>} />;
    }
    return <EmptyState title="Token not found" body="We couldn't find live market data for this address." action={<Button variant="secondary" onClick={() => router.back()}>Go back</Button>} />;
  }
  const t = token.data;
  const price = tick?.priceUsd ?? t.priceUsd;
  const change = tick?.priceChange24h ?? t.priceChangePct.h24;

  return (
    <div className="pb-48 md:grid md:grid-cols-[1fr_360px] md:gap-4 md:p-4 md:pb-4">
      <div className="min-w-0">
        <header className="flex items-start gap-2 px-3 pt-3">
          <button onClick={() => router.back()} aria-label="Back" className="flex h-9 w-7 items-center text-muted">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <TokenIcon symbol={t.symbol} imageUrl={t.imageUrl} size={38} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-lg leading-tight font-semibold">{t.symbol}</h1>
              <ChainBadge chain={t.chain} />
            </div>
            <div className="flex items-center gap-1.5">
              <p className="truncate text-xs text-muted">{t.name}</p>
              <CopyButton text={t.address} label={shortAddress(t.address)} className="num px-1.5 py-0 text-[10px] text-muted" />
            </div>
          </div>
          <div className="text-right">
            <LiveNumber value={formatPrice(price)} numeric={price ? D(price).toNumber() : null} className="block text-lg font-semibold" />
            <Pct value={change} className="text-sm" />
          </div>
        </header>

        <div className="mt-2">
          <PriceChart
            chain={chain}
            address={address}
            pins={allPins}
            onOpenPin={(pin) => {
              setPinSheet(pin);
            }}
          />
        </div>

        <RiskFlags token={t} />
        <PositionCard chain={chain} address={address} symbol={t.symbol} onPost={() => setComposer(true)} />
        <StatsPanel token={t} />

        <div className="flex items-center justify-between border-t border-line/70 px-3 pt-2">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "theses", label: `Thesis${t.thesisCount ? ` ${t.thesisCount}` : ""}` },
              { value: "trades", label: "Trades" },
              { value: "holders", label: "Holders" },
            ]}
          />
          {tab === "theses" && (
            <button onClick={() => (status === "in" ? setComposer(true) : login())} className="shrink-0 pr-1 text-sm font-semibold text-signal">
              + Post
            </button>
          )}
        </div>
        {tab === "theses" && (
          <ThesisPanel
            chain={chain}
            address={address}
            focusId={focusId}
            onCopyBuy={(thesis) => {
              if (status !== "in") login();
              else setCopyThesis(thesis);
            }}
          />
        )}
        {tab === "trades" && <TapePanel chain={chain} address={address} />}
        {tab === "holders" && <HoldersPanel token={t} />}
      </div>

      <aside className="md:sticky md:top-20 md:self-start">
        <TradeBar token={t} position={position.data?.position ?? null} copyThesis={copyThesis} onClearCopy={() => setCopyThesis(null)} />
      </aside>

      <ThesisComposer open={composer} onClose={() => setComposer(false)} chain={chain} address={address} symbol={t.symbol} />

      <Sheet open={!!pinSheet} onClose={() => setPinSheet(null)}>
        {pinSheet && (
          <div className="-mx-4">
            <ThesisCard
              thesis={pinSheet}
              showToken={false}
              onCopyBuy={(thesis) => {
                setPinSheet(null);
                if (status !== "in") login();
                else setCopyThesis(thesis);
              }}
            />
            <div className="px-4 pt-1">
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  setTab("theses");
                  setFocusId(pinSheet.id);
                  setPinSheet(null);
                }}
              >
                Show in thesis list
              </Button>
              <Link href={`/thesis/${pinSheet.id}`} className="mt-2 block text-center text-sm text-muted underline underline-offset-2">
                Open thesis and replies
              </Link>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}

export default function TokenPage() {
  const params = useParams<{ chain: string; address: string }>();
  if (!isChainKey(params.chain)) {
    return <EmptyState title="Unknown chain" />;
  }
  return (
    <Suspense>
      <TokenScreen chain={params.chain} address={params.chain === "solana" ? params.address : params.address.toLowerCase()} />
    </Suspense>
  );
}
