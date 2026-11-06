"use client";

import { D, cleanAmountInput, formatCompactUsd, formatPrice, formatQty, formatUsd, parseAmountInput, type ChainKey, type PositionView, type TokenListItem } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLivePrice } from "@/lib/socket";
import { useToast } from "@/lib/toast";
import { useTradeRunner } from "@/lib/trade";
import { OpenOrders } from "./orders-list";
import { CHAIN_OPTIONS, ThesisFeed } from "./thesis-feed";
import { TrackerFeed } from "./tracker-feed";
import { Button, ChainLogo, EmptyState, LiveNumber, Pct, PillFilter, RowSkeletons, Segmented, TokenIcon } from "./ui";

const LIVE_ROWS = 20;
const QUICK_BUY_KEY = "frontrun.quickBuy";
const TABLE_COLUMNS = "grid-cols-[minmax(150px,1.6fr)_repeat(4,minmax(72px,1fr))_76px]";

function TokenWithChain({ symbol, imageUrl, chain, size = 34 }: { symbol: string; imageUrl: string | null; chain: ChainKey; size?: number }) {
  return (
    <span className="relative shrink-0">
      <TokenIcon symbol={symbol} imageUrl={imageUrl} size={size} />
      <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-surface">
        <ChainLogo chain={chain} size={Math.round(size * 0.42)} />
      </span>
    </span>
  );
}

function Panel({ title, right, children, className = "" }: { title?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
          <h2 className="font-semibold tracking-tight">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

function SocialPanel() {
  const [feed, setFeed] = useState<"thesis" | "x" | "telegram">("thesis");
  const [tab, setTab] = useState<"top" | "recent" | "following">("top");
  return (
    <Panel className="h-full">
      <div className="flex shrink-0 gap-1 border-b border-line/60 px-2 pt-2" role="tablist" aria-label="Feed">
        {(
          [
            { value: "x", label: "X tracker" },
            { value: "telegram", label: "TG tracker" },
            { value: "thesis", label: "Thesis feed" },
          ] as const
        ).map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={feed === f.value}
            onClick={() => setFeed(f.value)}
            className={`flex-1 border-b-2 px-1 pb-2 pt-1 text-sm font-semibold whitespace-nowrap transition-colors ${feed === f.value ? "border-signal text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {feed === "thesis" && (
        <Segmented
          className="shrink-0 px-3 py-2"
          value={tab}
          onChange={setTab}
          options={[
            { value: "top", label: "Top" },
            { value: "recent", label: "Latest" },
            { value: "following", label: "Following" },
          ]}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line/60">{feed === "thesis" ? <ThesisFeed tab={tab} chain="all" /> : <TrackerFeed source={feed} />}</div>
    </Panel>
  );
}

function SpotlightStrip({ items }: { items: TokenListItem[] }) {
  return (
    <div className="grid shrink-0 grid-cols-3 gap-2 xl:grid-cols-6">
      {items.slice(0, 6).map((t) => (
        <Link key={`${t.chain}:${t.address}`} href={`/token/${t.chain}/${t.address}`} className="min-w-0 rounded-xl border border-line bg-surface p-2.5 transition-colors hover:bg-raised">
          <div className="flex items-center gap-2">
            <TokenWithChain symbol={t.symbol} imageUrl={t.imageUrl} chain={t.chain} size={24} />
            <span className="truncate text-sm font-semibold">{t.symbol}</span>
          </div>
          <div className="num mt-1.5 flex items-center justify-between gap-1 text-xs">
            <span className="truncate text-muted">{formatCompactUsd(t.marketCapUsd ?? t.fdvUsd)}</span>
            <Pct value={t.priceChangePct.h24} />
          </div>
        </Link>
      ))}
    </div>
  );
}

function TokenTableRow({ token, live, onBuy, buying, amountLabel }: { token: TokenListItem; live: boolean; onBuy(t: TokenListItem): void; buying: boolean; amountLabel: string }) {
  return live ? <LiveRow token={token} onBuy={onBuy} buying={buying} amountLabel={amountLabel} /> : <RowBody token={token} onBuy={onBuy} buying={buying} amountLabel={amountLabel} />;
}

function LiveRow(props: { token: TokenListItem; onBuy(t: TokenListItem): void; buying: boolean; amountLabel: string }) {
  const tick = useLivePrice(props.token.chain, props.token.address);
  return <RowBody {...props} priceUsd={tick?.priceUsd} change={tick?.priceChange24h ?? undefined} marketCap={tick?.marketCapUsd} />;
}

function RowBody({ token, onBuy, buying, amountLabel, priceUsd, change, marketCap }: { token: TokenListItem; onBuy(t: TokenListItem): void; buying: boolean; amountLabel: string; priceUsd?: string; change?: number; marketCap?: string | null }) {
  const price = priceUsd ?? token.priceUsd;
  return (
    <div className={`relative grid ${TABLE_COLUMNS} items-center gap-2 px-4 py-2.5 transition-colors hover:bg-raised/60`}>
      <Link href={`/token/${token.chain}/${token.address}`} className="flex min-w-0 items-center gap-2.5 after:absolute after:inset-0">
        <TokenWithChain symbol={token.symbol} imageUrl={token.imageUrl} chain={token.chain} />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{token.symbol}</span>
          <span className="block truncate text-xs text-muted">{token.name}</span>
        </span>
      </Link>
      <LiveNumber value={formatPrice(price)} numeric={price ? D(price).toNumber() : null} className="text-right text-sm" />
      <span className="num text-right text-sm">{formatCompactUsd(marketCap ?? token.marketCapUsd ?? token.fdvUsd)}</span>
      <Pct value={change ?? token.priceChangePct.h24} className="text-right text-sm" />
      <span className="num text-right text-sm">{formatCompactUsd(token.volumeUsd.h24)}</span>
      <button
        onClick={() => onBuy(token)}
        disabled={buying}
        aria-label={`Buy ${amountLabel} of ${token.symbol}`}
        className="num relative z-10 flex h-8 items-center justify-center rounded-lg bg-up/15 text-xs font-semibold text-up transition-colors hover:bg-up hover:text-bg disabled:opacity-50"
      >
        {buying ? <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-up/30 border-t-up" /> : amountLabel}
      </button>
    </div>
  );
}

function TokensPanel({ items, isLoading, isError, attribution, tab, setTab, chain, setChain, onRefresh }: { items: TokenListItem[]; isLoading: boolean; isError: boolean; attribution?: string; tab: "trending" | "new"; setTab(t: "trending" | "new"): void; chain: ChainKey | "all"; setChain(c: ChainKey | "all"): void; onRefresh(): void }) {
  const { status, login } = useAuth();
  const { execute } = useTradeRunner();
  const { toast, dismiss } = useToast();
  const router = useRouter();
  const [amount, setAmount] = useState("25");
  const [buying, setBuying] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(QUICK_BUY_KEY);
      if (saved && parseAmountInput(saved)) setAmount(saved);
    } catch {
      // Private mode: the default stands.
    }
  }, []);

  const parsed = parseAmountInput(amount);
  const amountLabel = parsed ? formatUsd(parsed.toFixed()).replace(".00", "") : "Buy";

  const quickBuy = async (token: TokenListItem) => {
    if (status !== "in") return login();
    if (!parsed) return toast("Enter a quick buy amount first", { tone: "bad" });
    const key = `${token.chain}:${token.address}`;
    setBuying(key);
    // The quote can take a few seconds, and the press should answer at once.
    const pressKey = `quick:${key}`;
    toast(`Buying ${token.symbol}`, { key: pressKey, tone: "pending", sticky: true });
    try {
      const quote = await api.quote({ chain: token.chain, address: token.address, side: "buy", amountUsd: parsed.toFixed() });
      dismiss(pressKey);
      if (quote.blocked.length) {
        toast(quote.blocked[0]!.message, { tone: "bad" });
      } else if (!quote.oneTap) {
        // Anything that needs a look first goes where the details are.
        if (quote.confirmReasons[0]) toast(`${quote.confirmReasons[0].message} Check it before you buy.`, { tone: "bad" });
        router.push(`/token/${token.chain}/${token.address}`);
      } else {
        await execute(quote);
      }
    } catch (err) {
      dismiss(pressKey);
      toast(errorMessage(err), { tone: "bad" });
    } finally {
      setBuying(null);
    }
  };

  return (
    <Panel className="min-h-0 flex-1">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-2">
        <h2 className="font-semibold tracking-tight">Tokens</h2>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "trending", label: "Trending" },
            { value: "new", label: "New" },
          ]}
        />
        <label className="ml-auto flex h-8 items-center gap-1 rounded-lg bg-raised px-2.5 text-xs text-muted focus-within:outline-2 focus-within:outline-signal focus-within:outline-solid">
          Quick buy
          <span className="num ml-1 text-ink">$</span>
          <input
            value={amount}
            onChange={(e) => {
              const next = cleanAmountInput(e.target.value, 6);
              setAmount(next);
              try {
                localStorage.setItem(QUICK_BUY_KEY, next);
              } catch {
                // Private mode: it just won't be remembered.
              }
            }}
            inputMode="decimal"
            autoComplete="off"
            aria-label="Quick buy amount in dollars"
            className="amount-input num w-14 bg-transparent text-right text-sm font-medium text-ink"
          />
        </label>
      </header>
      <PillFilter className="shrink-0 px-4 pb-2" value={chain} onChange={setChain} options={CHAIN_OPTIONS} />
      <div className={`num grid shrink-0 ${TABLE_COLUMNS} gap-2 border-y border-line/60 px-4 py-1.5 text-xs text-faint`}>
        <span>Token</span>
        <span className="text-right">Price</span>
        <span className="text-right">Market cap</span>
        <span className="text-right">24h change</span>
        <span className="text-right">24h volume</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <RowSkeletons />
        ) : items.length === 0 ? (
          <EmptyState
            title={isError ? "Market data is catching up" : "Nothing listed here yet"}
            body={isError ? "Lists refresh on their own in a moment." : "Try another chain or search for a token."}
            action={
              <Button variant="secondary" onClick={onRefresh}>
                Refresh
              </Button>
            }
          />
        ) : (
          <>
            <div className="divide-y divide-line/40">
              {items.map((t, i) => (
                <TokenTableRow key={`${t.chain}:${t.address}`} token={t} live={i < LIVE_ROWS} onBuy={(token) => void quickBuy(token)} buying={buying === `${t.chain}:${t.address}`} amountLabel={amountLabel} />
              ))}
            </div>
            <p className="px-4 py-3 text-center text-[11px] text-faint">{attribution}. Boosted placements are paid for and labelled.</p>
          </>
        )}
      </div>
    </Panel>
  );
}

function PositionRow({ p }: { p: PositionView }) {
  const closed = !!p.closedAt;
  const value = closed ? p.realizedPnlUsd : p.valueUsd;
  const realizedUp = D(p.realizedPnlUsd).gte(0);
  return (
    <Link href={`/token/${p.token.chain}/${p.token.address}`} className="flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-raised/60">
      <TokenWithChain symbol={p.token.symbol} imageUrl={p.token.imageUrl} chain={p.token.chain} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{p.token.symbol}</span>
        <span className="num block truncate text-xs text-muted">{closed ? "Closed" : `${formatQty(p.qty)} ${p.token.symbol}`}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className={`num block text-sm font-medium ${closed ? (realizedUp ? "text-up" : "text-down") : ""}`}>{formatUsd(value, closed ? { sign: true } : {})}</span>
        {!closed && <Pct value={p.returnPct} className="block text-xs" />}
      </span>
    </Link>
  );
}

function PositionsPanel() {
  const { status, login } = useAuth();
  const [view, setView] = useState<"open" | "closed" | "orders">("open");
  const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: () => api.portfolio(), enabled: status === "in", refetchInterval: 30_000 });
  const rows = view === "open" ? portfolio.data?.open : view === "closed" ? portfolio.data?.closed : [];
  const allTime = portfolio.data ? D(portfolio.data.totals.allTimeUsd) : null;
  return (
    <Panel title="Your positions" className="h-full">
      <Segmented
        className="shrink-0 px-3 pb-2"
        value={view}
        onChange={setView}
        options={[
          { value: "open", label: "Open" },
          { value: "closed", label: "Closed" },
          { value: "orders", label: "Orders" },
        ]}
      />
      {status !== "in" ? (
        <EmptyState title="Your positions live here" body="Sign in to trade any token from one USDC balance." action={<Button onClick={login}>Sign in</Button>} />
      ) : portfolio.isLoading ? (
        <RowSkeletons count={4} />
      ) : (
        <>
          {allTime && (
            <div className="num flex shrink-0 items-center justify-between border-b border-line/60 px-4 pb-2 text-xs text-muted">
              <span>All-time PnL</span>
              <span className={allTime.gte(0) ? "text-up" : "text-down"}>{formatUsd(allTime.toFixed(), { sign: true })}</span>
            </div>
          )}
          <div className="min-h-0 flex-1 divide-y divide-line/40 overflow-y-auto">
            {view === "orders" ? <OpenOrders showToken empty={<EmptyState title="No open orders" body="Set a limit, stop or take-profit from any token page." />} /> : rows?.length ? rows.map((p) => <PositionRow key={p.id} p={p} />) : <EmptyState title={view === "open" ? "Nothing open yet" : "Nothing closed yet"} body={view === "open" ? "Quick buy a token to get started." : undefined} />}
          </div>
        </>
      )}
    </Panel>
  );
}

/** The wide layout: thesis feed on the left, tokens in the middle, positions on the right. */
export function HomeDesktop() {
  const [tab, setTab] = useState<"trending" | "new">("trending");
  const [chain, setChain] = useState<ChainKey | "all">("all");
  const market = useQuery({
    queryKey: ["market", tab, chain],
    queryFn: () => api.marketList({ tab, chain: chain === "all" ? undefined : chain }),
    refetchInterval: 30_000,
    retry: 4,
    retryDelay: (attempt) => Math.min(3000 * 2 ** attempt, 20_000),
  });
  const spotlight = useQuery({
    queryKey: ["market", "trending", "all"],
    queryFn: () => api.marketList({ tab: "trending" }),
    refetchInterval: 30_000,
  });
  const items = market.data?.items ?? [];
  return (
    <div className="grid h-[calc(100dvh-57px)] grid-cols-[minmax(280px,340px)_minmax(0,1fr)_minmax(260px,320px)] gap-3 p-3">
      <SocialPanel />
      <div className="flex min-h-0 min-w-0 flex-col gap-3">
        <SpotlightStrip items={spotlight.data?.items ?? []} />
        <TokensPanel items={items} isLoading={market.isLoading} isError={market.isError} attribution={market.data?.attribution} tab={tab} setTab={setTab} chain={chain} setChain={setChain} onRefresh={() => void market.refetch()} />
      </div>
      <PositionsPanel />
    </div>
  );
}

