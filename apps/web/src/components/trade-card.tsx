"use client";

import { APP_NAME, D, explorerTxUrl, formatPct, formatPrice, formatQty, formatUsd, type TradeView } from "@frontrun/core";
import { useState } from "react";
import { Button, ChainLogo, Sheet, TokenIcon } from "./ui";

/** The card marks a closed position, or says why a trade failed. An open position has its own panel. */
export function earnsTradeCard(trade: TradeView): boolean {
  return trade.status === "failed" || trade.status === "refunded" || (trade.side === "sell" && trade.status === "filled" && trade.closedPosition);
}

function tradePnl(trade: TradeView): { usd: number; pct: number | null } | null {
  if (trade.pnlUsd === null || !trade.usdOut) return null;
  const usd = D(trade.pnlUsd).toNumber();
  const cost = D(trade.usdOut).toNumber() - usd;
  return { usd, pct: cost > 0 ? (usd / cost) * 100 : null };
}

function shareTrade(trade: TradeView, pnl: { usd: number; pct: number | null } | null) {
  const verb = trade.side === "buy" ? "Bought" : "Sold";
  const result = pnl ? ` ${formatUsd(pnl.usd, { sign: true })}${pnl.pct !== null ? ` (${formatPct(pnl.pct)})` : ""}` : "";
  const text = `${verb} $${trade.token.symbol}${result} on ${APP_NAME}`;
  const share = (navigator as Navigator & { share?: (data: ShareData) => Promise<void> }).share;
  if (share) void share.call(navigator, { text }).catch(() => {});
  else window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}

function FilledCard({ trade }: { trade: TradeView }) {
  const pnl = tradePnl(trade);
  const [details, setDetails] = useState(false);
  const isBuy = trade.side === "buy";
  const up = (pnl?.usd ?? 0) >= 0;
  return (
    <>
      <div className={`rounded-2xl border border-line p-4 ${pnl ? (up ? "bg-up/10" : "bg-down/10") : "bg-raised"}`}>
        <div className="flex items-center gap-2.5">
          <span className="relative shrink-0">
            <TokenIcon symbol={trade.token.symbol} imageUrl={trade.token.imageUrl} size={40} />
            <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-surface">
              <ChainLogo chain={trade.token.chain} size={16} />
            </span>
          </span>
          <div className="min-w-0">
            <p className="truncate font-semibold">
              {isBuy ? "Bought" : "Sold"} {trade.token.symbol}
            </p>
            <p className="truncate text-xs text-muted">{trade.token.name}</p>
          </div>
        </div>
        {pnl && (
          <div className="mt-4">
            <p className="text-xs text-muted">Realized PnL</p>
            <p className={`num mt-0.5 text-3xl font-semibold tracking-tight ${up ? "text-up" : "text-down"}`}>{formatUsd(pnl.usd, { sign: true })}</p>
            {pnl.pct !== null && <p className={`num text-sm font-medium ${up ? "text-up" : "text-down"}`}>{formatPct(pnl.pct)}</p>}
          </div>
        )}
        <dl className="num mt-4 space-y-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{isBuy ? "Spent" : "Received"}</dt>
            <dd>{formatUsd(isBuy ? trade.usdIn : trade.usdOut)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">{isBuy ? "Received" : "Sold"}</dt>
            <dd className="truncate">
              {formatQty(trade.qty)} {trade.token.symbol}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Price</dt>
            <dd>{formatPrice(trade.priceUsd)}</dd>
          </div>
        </dl>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button onClick={() => setDetails(!details)} className="text-sm text-muted underline underline-offset-2">
          {details ? "Hide details" : "Details"}
        </button>
        <button onClick={() => shareTrade(trade, pnl)} className="text-sm font-semibold text-signal">
          Share
        </button>
      </div>
      {details && (
        <dl className="num mt-2 space-y-1.5 text-xs text-muted">
          <div className="flex justify-between">
            <dt>Route</dt>
            <dd>{trade.provider}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Fees</dt>
            <dd>{formatUsd(trade.feeUsd)}</dd>
          </div>
          {trade.isPaper && (
            <div className="flex justify-between">
              <dt>Mode</dt>
              <dd>Paper fill</dd>
            </div>
          )}
          {trade.srcTx && (
            <div className="flex justify-between">
              <dt>Source tx</dt>
              <dd>
                <a className="underline" href={explorerTxUrl(trade.srcChain, trade.srcTx)} target="_blank" rel="noreferrer">
                  View
                </a>
              </dd>
            </div>
          )}
          {trade.dstTx && trade.dstTx !== trade.srcTx && (
            <div className="flex justify-between">
              <dt>Destination tx</dt>
              <dd>
                <a className="underline" href={explorerTxUrl(trade.side === "buy" ? trade.token.chain : "arc", trade.dstTx)} target="_blank" rel="noreferrer">
                  View
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}
    </>
  );
}

/** The result of one trade. It shows after a fill, and again from a notification. */
export function TradeCardSheet({ trade, onClose }: { trade: TradeView | null; onClose(): void }) {
  if (!trade) return null;
  const inProgress = trade.status !== "filled" && trade.status !== "failed" && trade.status !== "refunded";
  const title = trade.status === "refunded" ? "Refunded" : trade.status === "failed" ? "Didn't go through" : inProgress ? (trade.side === "buy" ? "Buying" : "Selling") : undefined;
  return (
    <Sheet open onClose={onClose} title={title ? `${title} ${trade.token.symbol}` : undefined}>
      {trade.status === "filled" ? <FilledCard trade={trade} /> : <p className="text-sm text-muted">{inProgress ? "This is still on its way." : (trade.error ?? "Nothing was traded.")}</p>}
      <Button onClick={onClose} variant="secondary" className="mt-4 w-full">
        Done
      </Button>
    </Sheet>
  );
}
