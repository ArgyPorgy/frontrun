"use client";

import {
  LENDING_MIN_HEALTH,
  formatPrice,
  formatUsd,
  lendingHealthFactor,
  timeAgo,
  type LendingAction,
  type LendingActionView,
  type LendingMarketView,
  type LendingPositionView,
  type LendingSummaryView,
} from "@frontrun/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { compactUsd } from "./perps";
import { Button, Segmented, Sheet } from "./ui";

export function apy(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(2)}%`;
}

export function HealthBadge({ value }: { value: number | null }) {
  if (value === null) return null;
  const tone = value < 1.1 ? "text-down" : value < LENDING_MIN_HEALTH + 0.25 ? "text-warn" : "text-up";
  return <span className={`num text-xs font-medium ${tone}`}>Health {value >= 100 ? "99+" : value.toFixed(2)}</span>;
}

/** Stocks, perps and lending sit side by side, so each page links to the others. */
export function DesksSwitch({ current }: { current: "stocks" | "perps" | "lend" }) {
  return (
    <div className="mb-4 flex gap-1" role="navigation" aria-label="Desks">
      {(
        [
          ["stocks", "/stocks", "Stocks"],
          ["perps", "/perps", "Perps"],
          ["lend", "/lend", "Lend & borrow"],
        ] as const
      ).map(([key, href, label]) => (
        <Link
          key={key}
          href={href}
          aria-current={current === key ? "page" : undefined}
          className={`rounded-full px-3.5 py-1.5 text-sm font-medium ${current === key ? "bg-ink text-bg" : "text-muted hover:text-ink"}`}
        >
          {label}
        </Link>
      ))}
    </div>
  );
}

export function MarketRow({ m, side, onOpen }: { m: LendingMarketView; side: "earn" | "borrow"; onOpen(): void }) {
  return (
    <button type="button" onClick={onOpen} className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 py-3 text-left hover:bg-surface">
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-medium">
          <span className="truncate">{m.name}</span>
          {m.ours && <span className="shrink-0 rounded-full border border-signal/50 px-1.5 py-px text-[10px] text-signal">Ours</span>}
        </p>
        <p className="truncate text-xs text-muted">
          {m.venue === "aave" ? "Aave" : m.venue === "morpho_vault" ? `Morpho vault by ${m.curator}` : `Morpho${m.collateral?.priceUsd ? ` · ${m.collateral.ticker} ${formatUsd(m.collateral.priceUsd)}` : ""}`}
          {side === "borrow" && m.lltv !== null ? ` · max LTV ${(m.lltv * 100).toFixed(1)}%` : ""}
        </p>
      </div>
      <span className={`num w-20 text-right text-sm ${side === "earn" ? "text-up" : ""}`}>{apy(side === "earn" ? m.supplyApy : m.borrowApy)}</span>
      <span className="num w-20 text-right text-sm text-muted">{m.liquidityUsd !== null && side === "borrow" ? compactUsd(m.liquidityUsd) : m.totalSupplyUsd !== null ? compactUsd(m.totalSupplyUsd) : "-"}</span>
    </button>
  );
}

const ACTION_LABELS: Record<LendingAction, string> = {
  supply: "Lend",
  withdraw: "Withdraw",
  supply_collateral: "Post collateral",
  withdraw_collateral: "Take back",
  borrow: "Borrow",
  repay: "Repay",
};

export function actionSentence(a: LendingActionView): string {
  const amount = a.asset === "USDC" ? formatUsd(a.amount) : `${Number(a.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${a.asset}`;
  const verb = { supply: "Lent", withdraw: "Withdrew", supply_collateral: "Posted", withdraw_collateral: "Took back", borrow: "Borrowed", repay: "Repaid" }[a.action];
  return `${verb} ${amount} ${a.action === "borrow" || a.action === "withdraw" || a.action === "withdraw_collateral" ? "from" : "in"} ${a.marketName}`;
}

/** The sheet for every move in one market. Earning markets offer lend and withdraw; stock markets add the borrowing side. */
export function LendingSheet({
  market,
  position,
  summary,
  initial,
  onClose,
}: {
  market: LendingMarketView;
  position: LendingPositionView | undefined;
  summary: LendingSummaryView | undefined;
  initial: LendingAction;
  onClose(): void;
}) {
  const { status, login } = useAuth();
  const queryClient = useQueryClient();
  const stock = market.venue === "morpho_market";
  const actions: LendingAction[] = stock ? ["supply_collateral", "borrow", "repay", "withdraw_collateral", "supply", "withdraw"] : ["supply", "withdraw"];
  const [action, setAction] = useState<LendingAction>(initial);
  const [amount, setAmount] = useState("");
  const [max, setMax] = useState(false);
  const [done, setDone] = useState<LendingActionView | null>(null);
  const run = useMutation({
    mutationFn: () => api.lend({ marketId: market.id, action, amount: max ? undefined : amount, max: max || undefined }),
    onSuccess: (r) => {
      setDone(r);
      setAmount("");
      setMax(false);
      void queryClient.invalidateQueries({ queryKey: ["lending-me"] });
      void queryClient.invalidateQueries({ queryKey: ["lending-actions"] });
      void queryClient.invalidateQueries({ queryKey: ["lending-markets"] });
      void queryClient.invalidateQueries({ queryKey: ["balance"] });
    },
  });

  const token = market.collateral;
  const price = token?.priceUsd ?? null;
  const lltv = market.lltv ?? 0;
  const walletStock = summary?.stocks.find((s) => s.ticker === token?.ticker);
  const isToken = action === "supply_collateral" || action === "withdraw_collateral";
  const available: { value: string; label: string } | null = (() => {
    switch (action) {
      case "supply":
        return summary ? { value: summary.walletUsdc, label: `${formatUsd(summary.walletUsdc)} USDC in your wallet` } : null;
      case "withdraw":
        return position ? { value: position.suppliedUsd, label: `${formatUsd(position.suppliedUsd)} supplied` } : { value: "0", label: "Nothing supplied yet" };
      case "supply_collateral":
        return { value: walletStock?.qty ?? "0", label: `${walletStock ? Number(walletStock.qty).toLocaleString(undefined, { maximumFractionDigits: 6 }) : "0"} ${token?.symbol} in your wallet` };
      case "withdraw_collateral":
        return position?.maxWithdrawCollateral ? { value: position.maxWithdrawCollateral, label: `Up to ${Number(position.maxWithdrawCollateral).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${token?.symbol} can come out safely` } : { value: "0", label: `No ${token?.symbol} posted` };
      case "borrow":
        return position?.maxBorrowUsd ? { value: position.maxBorrowUsd, label: `Up to ${formatUsd(position.maxBorrowUsd)} more, keeping health above ${LENDING_MIN_HEALTH}` } : { value: "0", label: `Post ${token?.symbol} first` };
      case "repay":
        return position ? { value: position.borrowedUsd, label: `${formatUsd(position.borrowedUsd)} owed` } : { value: "0", label: "No loan" };
    }
  })();

  // Health after the move, worked out here so the number moves as you type.
  const n = max ? Number(available?.value ?? 0) : Number(amount) || 0;
  const collateralQty = Number(position?.collateralQty ?? 0);
  const borrowed = Number(position?.borrowedUsd ?? 0);
  let after: number | null = null;
  if (stock && price) {
    const qty = collateralQty + (action === "supply_collateral" ? n : action === "withdraw_collateral" ? -n : 0);
    const debt = Math.max(0, borrowed + (action === "borrow" ? n : action === "repay" ? -n : 0));
    after = lendingHealthFactor(qty * price, debt, lltv);
  }
  const tooRisky = (action === "borrow" || action === "withdraw_collateral") && after !== null && after < LENDING_MIN_HEALTH;

  return (
    <Sheet open onClose={onClose} title={market.name}>
      <p className="text-sm text-muted">
        {market.venue === "aave"
          ? "Supply USDC to Aave and earn what borrowers pay. Withdraw any time there's free liquidity."
          : market.venue === "morpho_vault"
            ? `A Morpho vault: ${market.curator} spreads its USDC across vetted Morpho markets. Withdraw any time.`
            : `Borrow USDC against ${token?.symbol}, Coinbase's tokenized ${token?.name} stock, or lend USDC to people who do. Prices come from Chainlink's Coinbase ${token?.ticker} feed.${market.ours ? " Front Run created this market on Morpho." : ""}`}
      </p>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted">Lend APY</dt>
          <dd className="num text-up">{apy(market.supplyApy)}</dd>
        </div>
        {stock && (
          <div>
            <dt className="text-muted">Borrow APY</dt>
            <dd className="num">{apy(market.borrowApy)}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted">{stock ? "Free to borrow" : "Deposits"}</dt>
          <dd className="num">{stock ? compactUsd(market.liquidityUsd ?? 0) : market.totalSupplyUsd !== null ? compactUsd(market.totalSupplyUsd) : "-"}</dd>
        </div>
      </dl>
      {position && (
        <div className="mt-3 rounded-xl bg-bg p-3 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {Number(position.suppliedUsd) > 0 && <span>Lent {formatUsd(position.suppliedUsd)}</span>}
            {Number(position.collateralQty) > 0 && (
              <span>
                Collateral {Number(position.collateralQty).toLocaleString(undefined, { maximumFractionDigits: 6 })} {token?.symbol}
                {position.collateralUsd ? ` (${formatUsd(position.collateralUsd)})` : ""}
              </span>
            )}
            {Number(position.borrowedUsd) > 0 && <span>Owed {formatUsd(position.borrowedUsd)}</span>}
            <HealthBadge value={position.healthFactor} />
          </div>
          {position.liquidationPrice && <p className="mt-1 text-muted">Liquidated if {token?.ticker} falls to {formatPrice(position.liquidationPrice)}</p>}
        </div>
      )}
      <Segmented
        className="mt-4"
        options={actions.map((a) => ({ value: a, label: stock && a === "supply" ? "Lend USDC" : ACTION_LABELS[a] }))}
        value={action}
        onChange={(a) => {
          setAction(a);
          setAmount("");
          setMax(false);
          setDone(null);
        }}
      />
      <label className="mt-4 block text-xs text-muted" htmlFor="lend-amount">
        Amount ({isToken ? token?.symbol : "USDC"})
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id="lend-amount"
          inputMode="decimal"
          value={max ? "Max" : amount}
          onChange={(e) => {
            setMax(false);
            setAmount(e.target.value.replace(/[^0-9.]/g, ""));
          }}
          className="num w-full rounded-xl border border-line bg-bg px-3 py-2"
        />
        <Button variant="secondary" type="button" onClick={() => setMax(true)}>
          Max
        </Button>
      </div>
      {available && <p className="mt-1 text-xs text-muted">{available.label}</p>}
      {after !== null && (action === "borrow" || action === "withdraw_collateral" || action === "repay" || action === "supply_collateral") && n > 0 && (
        <p className="mt-2 text-xs">
          Health after: <HealthBadge value={after} />
        </p>
      )}
      {status !== "in" ? (
        <Button className="mt-4 w-full" onClick={login}>
          Sign in to lend
        </Button>
      ) : (
        <Button className="mt-4 w-full" disabled={run.isPending || tooRisky || (!max && !(Number(amount) > 0))} onClick={() => run.mutate()}>
          {run.isPending ? "Sending…" : `${ACTION_LABELS[action]}${max ? " max" : ""}`}
        </Button>
      )}
      {tooRisky && <p className="mt-2 text-xs text-down">That would take health below {LENDING_MIN_HEALTH}. Borrow less or post more collateral.</p>}
      {run.isError && <p className="mt-2 text-sm text-down">{errorMessage(run.error)}</p>}
      {done && <p className={`mt-2 text-sm ${done.status === "failed" ? "text-down" : "text-up"}`}>{done.status === "failed" ? done.error : `Done. ${actionSentence(done)}.`}</p>}
      <p className="mt-3 text-[11px] leading-snug text-faint">
        From your own wallet on Base, gas paid by Front Run. {stock ? "A loan is liquidated if its health falls to 1: part of the collateral is sold to repay it, with a penalty. Stock prices only update during US market hours, so they can gap at the open." : "Lending carries smart-contract risk, and withdrawals wait if every dollar is lent out."}
      </p>
    </Sheet>
  );
}

export function PositionCard({ p, onOpen }: { p: LendingPositionView; onOpen?: () => void }) {
  const m = p.market;
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})} className={`block w-full rounded-xl border border-line p-3 text-left ${onOpen ? "hover:bg-surface" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-medium">{m.name}</p>
        <HealthBadge value={p.healthFactor} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {Number(p.suppliedUsd) > 0 && (
          <span>
            Lent <span className="num text-ink">{formatUsd(p.suppliedUsd)}</span> at <span className="text-up">{apy(m.supplyApy)}</span>
          </span>
        )}
        {Number(p.collateralQty) > 0 && (
          <span>
            Collateral <span className="num text-ink">{p.collateralUsd ? formatUsd(p.collateralUsd) : `${p.collateralQty} ${m.collateral?.symbol}`}</span>
          </span>
        )}
        {Number(p.borrowedUsd) > 0 && (
          <span>
            Owed <span className="num text-ink">{formatUsd(p.borrowedUsd)}</span> at {apy(m.borrowApy)}
          </span>
        )}
        {p.liquidationPrice && <span>Liquidation {formatPrice(p.liquidationPrice)}</span>}
      </div>
    </Tag>
  );
}

export function LendingActionRow({ a }: { a: LendingActionView }) {
  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <p className={`text-sm ${a.status === "failed" ? "text-muted line-through" : ""}`}>{actionSentence(a)}</p>
        <span className="shrink-0 text-xs text-faint">{timeAgo(a.createdAt)}</span>
      </div>
      {a.reason && <p className="mt-1.5 rounded-lg bg-surface px-2.5 py-1.5 text-xs break-words whitespace-pre-wrap text-muted">{a.reason}</p>}
      {a.error && <p className="mt-1 text-xs text-down">{a.error}</p>}
      {a.txHash && (
        <a href={`https://basescan.org/tx/${a.txHash}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-faint underline">
          View on Basescan
        </a>
      )}
    </div>
  );
}
