"use client";

import {
  ApiError,
  BUY_PRESETS_USD,
  D,
  SELL_PRESETS_PCT,
  cleanAmountInput,
  formatPct,
  orderDirection,
  triggerProblem,
  type OrderType,
  formatPrice,
  formatQty,
  formatUsd,
  parseAmountInput,
  type PositionView,
  type QuoteView,
  type ThesisView,
  type TokenDetail,
} from "@frontrun/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBalance, useConfig, useDebounced, useMe } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { useTradeRunner } from "@/lib/trade";
import { ORDER_LABELS } from "./orders-list";
import { Button, Sheet } from "./ui";

type Side = "buy" | "sell";

const USD_DECIMALS = 6;
const PCT_DECIMALS = 2;

function PresetButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`num h-9 flex-1 rounded-lg text-sm font-medium transition-colors disabled:opacity-30 ${active ? "bg-ink text-bg" : "bg-raised text-ink"}`}
    >
      {children}
    </button>
  );
}

function ConfirmSheet({
  quote,
  onConfirm,
  onClose,
  busy,
}: {
  quote: QuoteView | null;
  onConfirm(): void;
  onClose(): void;
  busy: boolean;
}) {
  if (!quote) return null;
  const isBuy = quote.side === "buy";
  return (
    <Sheet open onClose={onClose} title={`${isBuy ? "Buy" : "Sell"} ${quote.token.symbol}`}>
      <dl className="num space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted">{isBuy ? "You spend" : "You sell"}</dt>
          <dd>{isBuy ? formatUsd(quote.amountInUsd) : `${formatQty(quote.qtyIn)} ${quote.token.symbol}`}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">You get about</dt>
          <dd>{isBuy ? `${formatQty(quote.expectedQty)} ${quote.token.symbol}` : formatUsd(quote.expectedOutUsd)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Price</dt>
          <dd>{formatPrice(quote.priceUsd)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Max slippage</dt>
          <dd>{(quote.slippage * 100).toFixed(0)}%</dd>
        </div>
        {D(quote.feeUsd).gt(0) && (
          <div className="flex justify-between">
            <dt className="text-muted">Fee</dt>
            <dd>{formatUsd(quote.feeUsd)}</dd>
          </div>
        )}
        {quote.priceImpact !== null && (
          <div className="flex justify-between">
            <dt className="text-muted">Price impact</dt>
            <dd>{(quote.priceImpact * 100).toFixed(2)}%</dd>
          </div>
        )}
      </dl>
      {quote.copy && (
        <div className="mt-3 rounded-xl bg-raised p-3 text-sm">
          <p className="font-medium">Copying a thesis</p>
          <p className="num mt-0.5 text-muted">
            Author&apos;s entry {quote.copy.authorEntry ? formatPrice(quote.copy.authorEntry) : "not known"} vs your {formatPrice(quote.priceUsd)}. Copy buys are capped at ${quote.copy.capUsd}.
          </p>
        </div>
      )}
      {quote.confirmReasons.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl bg-warn/10 p-3 text-sm text-warn">
          {quote.confirmReasons.map((r) => (
            <li key={r.message}>{r.message}</li>
          ))}
        </ul>
      )}
      <Button onClick={onConfirm} disabled={busy} className="mt-4 w-full">
        {busy ? "Working…" : `Confirm ${isBuy ? "buy" : "sell"}`}
      </Button>
      {!quote.oneTap && quote.confirmReasons.length === 0 && (
        <p className="mt-3 text-center text-xs text-muted">
          <Link href="/settings" className="underline">
            Turn on one-tap trading
          </Link>{" "}
          to skip this step.
        </p>
      )}
    </Sheet>
  );
}

/**
 * The thumb zone: Buy or Sell, an amount, one button. Presets fill the amount field, and any number can
 * be typed into it. With one-tap on, that one press executes. A live quote refreshes behind it so the
 * button always shows what the trade would actually do.
 */
export function TradeBar({
  token,
  position,
  copyThesis,
  onClearCopy,
}: {
  token: TokenDetail;
  position: PositionView | null;
  copyThesis: ThesisView | null;
  onClearCopy(): void;
}) {
  const { status, login, wallet } = useAuth();
  const config = useConfig();
  const me = useMe();
  const balance = useBalance();
  const queryClient = useQueryClient();
  const { execute } = useTradeRunner();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("buy");
  // The amount field's text: dollars on a buy, percent of the position on a sell.
  const [buyText, setBuyText] = useState("25");
  const [sellText, setSellText] = useState("100");
  const [confirming, setConfirming] = useState<QuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const canSell = !!position && D(position.qty).gt(0);
  const [mode, setMode] = useState<OrderType | "market">("market");
  const [triggerText, setTriggerText] = useState("");
  const [placing, setPlacing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (side === "sell" && !canSell) setSide("buy");
  }, [canSell, side]);

  useEffect(() => {
    if (copyThesis) {
      setSide("buy");
      setMode("market");
    }
  }, [copyThesis]);

  const chooseSide = (next: Side) => {
    setSide(next);
    setMode("market");
  };

  const chooseMode = (next: OrderType | "market") => {
    setMode(next);
    if (next === "market" || !token.priceUsd) return;
    // A starting point on the right side of the market, ready to adjust.
    const offset = orderDirection(next) === "lower" ? "0.9" : next === "take_profit" ? "1.25" : "1.1";
    setTriggerText(D(token.priceUsd).mul(offset).toSignificantDigits(6).toFixed());
  };

  const spendable = balance.data ? D(balance.data.spendable) : null;
  const hasFunds = spendable !== null && spendable.gt(0);
  const text = side === "buy" ? buyText : sellText;
  const amount = parseAmountInput(text);
  const overBalance = side === "buy" && amount !== null && spendable !== null && amount.gt(spendable);

  // Typing shouldn't quote on every key. Until it settles, the old quote is for a different amount, so
  // nothing below may show it or trade on it.
  const typed = amount?.toFixed() ?? null;
  const settledAmount = useDebounced(typed, 350);
  const settled = settledAmount === typed;

  const quoteKey = ["quote", token.chain, token.address, side, settledAmount, copyThesis?.id];
  const isMarket = mode === "market";
  const quoteEnabled = isMarket && status === "in" && settled && !!settledAmount && !overBalance && (side === "sell" ? canSell : hasFunds);
  const quote = useQuery({
    queryKey: quoteKey,
    queryFn: () =>
      api.quote({
        chain: token.chain,
        address: token.address,
        side,
        ...(side === "buy" ? { amountUsd: settledAmount! } : { sellPct: Number(settledAmount) }),
        ...(copyThesis ? { copyThesisId: copyThesis.id } : {}),
      }),
    enabled: quoteEnabled,
    refetchInterval: 12_000,
    retry: false,
    staleTime: 0,
  });

  const run = useCallback(
    async (q: QuoteView, confirmed: boolean) => {
      setBusy(true);
      try {
        const result = await execute(q, { confirmed });
        if (result.needsConfirm) {
          setConfirming(q);
          return;
        }
        if (result.expired) {
          // Quotes are single use, so the old one goes and the fresh one needs a new press.
          await queryClient.invalidateQueries({ queryKey: ["quote"] });
          setConfirming(null);
          return;
        }
        setConfirming(null);
        onClearCopy();
        await queryClient.invalidateQueries({ queryKey: ["quote"] });
      } finally {
        setBusy(false);
      }
    },
    [execute, onClearCopy, queryClient],
  );

  const q = settled ? quote.data : undefined;
  // Gas is paid through the app's signer, so that's the one thing to switch on before a first trade.
  const needsOneTap = status === "in" && config.gasless && config.tradingMode === "live" && !!me.data && !me.data.signer.active;

  const enableOneTap = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      if (config.signerId) await wallet.addSigner();
      await api.grantSigner({});
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setEnableError(errorMessage(err));
    } finally {
      setEnabling(false);
    }
  };

  const trigger = parseAmountInput(triggerText);
  const triggerIssue = !isMarket && trigger && token.priceUsd ? triggerProblem(mode, trigger.toFixed(), token.priceUsd) : null;

  const placeOrder = async () => {
    if (isMarket || !amount || !trigger) return;
    setPlacing(true);
    try {
      await api.createOrder({
        chain: token.chain,
        address: token.address,
        type: mode,
        triggerPriceUsd: trigger.toFixed(),
        ...(side === "buy" ? { amountUsd: amount.toFixed() } : { sellPct: amount.toNumber() }),
      });
      toast(`${ORDER_LABELS[mode]} placed`, { tone: "good" });
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      setMode("market");
    } catch (err) {
      toast(errorMessage(err), { tone: "bad" });
    } finally {
      setPlacing(false);
    }
  };

  const press = () => {
    if (status !== "in") {
      login();
      return;
    }
    if (!isMarket) {
      void placeOrder();
      return;
    }
    if (!q || q.blocked.length) return;
    // A copy buy always stops at the confirm sheet, so the author's entry sits next to your price.
    if (q.oneTap && !q.copy) void run(q, false);
    else setConfirming(q);
  };

  const quoteError = !settled || overBalance ? null : quote.error instanceof ApiError ? quote.error.message : quote.error ? errorMessage(quote.error) : null;
  const blocked = q?.blocked[0]?.message;
  const needsFunds = status === "in" && side === "buy" && balance.isSuccess && !hasFunds;

  const label =
    status !== "in"
      ? "Sign in to trade"
      : !amount
        ? "Enter an amount"
        : !isMarket
          ? !trigger
            ? "Enter a price"
            : `Place ${ORDER_LABELS[mode].toLowerCase()}`
          : side === "buy"
            ? `Buy ${formatUsd(q?.amountInUsd ?? amount.toFixed())}`
            : `Sell ${amount.toFixed()}%`;

  const changeAmount = (raw: string) => {
    if (side === "buy") {
      setBuyText(cleanAmountInput(raw, USD_DECIMALS));
      return;
    }
    const cleaned = cleanAmountInput(raw, PCT_DECIMALS);
    setSellText(parseAmountInput(cleaned)?.gt(100) ? "100" : cleaned);
  };

  let subline: string | null = null;
  if (!isMarket && trigger && !triggerIssue && amount && !overBalance) {
    const away = token.priceUsd ? ` (${formatPct(trigger.div(token.priceUsd).sub(1).mul(100).toNumber())})` : "";
    const what = side === "buy" ? `Buys ${formatUsd(amount.toFixed())}` : `Sells ${amount.toFixed()}%`;
    subline = `${what} ${orderDirection(mode) === "lower" ? "if the price falls to" : "if the price rises to"} ${formatPrice(trigger.toFixed())}${away}`;
  } else if (triggerIssue) subline = triggerIssue;
  else if (blocked) subline = blocked;
  else if (overBalance) {
    subline = `You can spend up to ${formatUsd(spendable!.toFixed())}.`;
  } else if (quoteError) subline = quoteError;
  else if (q) {
    const out = side === "buy" ? `≈ ${formatQty(q.expectedQty)} ${token.symbol}` : `≈ ${formatUsd(q.expectedOutUsd)}`;
    const impact = q.priceImpact !== null && q.priceImpact >= 0.001 ? ` · ${(q.priceImpact * 100).toFixed(1)}% impact` : "";
    subline = `${out}${impact}`;
  } else if (amount && (quote.isFetching || !settled) && status === "in") subline = "Finding the best route…";

  return (
    <>
      <div className="pad-bottom fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+56px)] z-20 border-t border-line bg-bg/95 backdrop-blur md:static md:bottom-auto md:rounded-2xl md:border md:bg-surface md:pb-0">
        <div className="mx-auto max-w-5xl px-3 pt-2 pb-2.5">
          {copyThesis && (
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-signal">Copying {copyThesis.author.username}&apos;s thesis</span>
              <button onClick={onClearCopy} className="text-muted">
                Cancel
              </button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <div className="flex shrink-0 rounded-lg bg-raised p-0.5" role="tablist" aria-label="Side">
              <button role="tab" aria-selected={side === "buy"} onClick={() => chooseSide("buy")} className={`h-8 rounded-md px-3 text-sm font-semibold ${side === "buy" ? "bg-up text-bg" : "text-muted"}`}>
                Buy
              </button>
              <button
                role="tab"
                aria-selected={side === "sell"}
                disabled={!canSell}
                onClick={() => chooseSide("sell")}
                className={`h-8 rounded-md px-3 text-sm font-semibold disabled:opacity-30 ${side === "sell" ? "bg-down text-bg" : "text-muted"}`}
              >
                Sell
              </button>
            </div>
            <label className="flex h-9 min-w-0 flex-1 items-center gap-1 rounded-lg bg-raised px-3 focus-within:outline-2 focus-within:outline-signal focus-within:outline-solid">
              {side === "buy" && (
                <span aria-hidden className="num text-sm text-muted">
                  $
                </span>
              )}
              {/* 16px text stops iOS zooming the page when this takes focus. */}
              <input
                value={text}
                onChange={(e) => changeAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                aria-label={side === "buy" ? "Amount to buy, in dollars" : "Percent of your position to sell"}
                className="amount-input num w-full min-w-0 bg-transparent text-right text-base font-medium placeholder:text-faint"
              />
              {side === "sell" && (
                <span aria-hidden className="num text-sm text-muted">
                  %
                </span>
              )}
            </label>
          </div>
          {!copyThesis && (
            <div className="no-scrollbar mt-1.5 flex gap-1 overflow-x-auto" role="tablist" aria-label="Order type">
              {(side === "buy" ? (["market", "limit_buy", "stop_buy"] as const) : (["market", "limit_sell", "stop_loss", "take_profit"] as const)).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => chooseMode(m)}
                  className={`h-7 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors ${mode === m ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}
                >
                  {m === "market" ? "Market" : m === "limit_buy" || m === "limit_sell" ? "Limit" : ORDER_LABELS[m]}
                </button>
              ))}
            </div>
          )}
          {!isMarket && (
            <label className="mt-1.5 flex h-9 items-center gap-1 rounded-lg bg-raised px-3 focus-within:outline-2 focus-within:outline-signal focus-within:outline-solid">
              <span className="text-xs text-muted">Price</span>
              <span aria-hidden className="num ml-auto text-sm text-muted">
                $
              </span>
              <input
                value={triggerText}
                onChange={(e) => setTriggerText(cleanAmountInput(e.target.value, 18))}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                aria-label="Order price in dollars"
                className="amount-input num w-full min-w-0 max-w-[60%] bg-transparent text-right text-base font-medium placeholder:text-faint"
              />
            </label>
          )}
          <div className="mt-1.5 flex gap-1">
            {side === "buy" ? (
              <>
                {BUY_PRESETS_USD.map((v) => (
                  <PresetButton key={v} active={!!amount?.eq(v)} onClick={() => setBuyText(String(v))}>
                    ${v}
                  </PresetButton>
                ))}
                <PresetButton active={!!amount && !!spendable && amount.eq(spendable)} disabled={!hasFunds} onClick={() => setBuyText(spendable!.toDecimalPlaces(USD_DECIMALS).toFixed())}>
                  Max
                </PresetButton>
              </>
            ) : (
              SELL_PRESETS_PCT.map((v) => (
                <PresetButton key={v} active={!!amount?.eq(v)} onClick={() => setSellText(String(v))}>
                  {v}%
                </PresetButton>
              ))
            )}
          </div>

          {needsOneTap && !needsFunds ? (
            <button onClick={() => void enableOneTap()} disabled={enabling} className="mt-2 w-full rounded-xl bg-signal py-3 font-semibold text-signal-ink disabled:opacity-40">
              {enabling ? "Turning on…" : "Turn on one-tap to trade"}
            </button>
          ) : needsFunds ? (
            <Link href="/deposit" className="mt-2 block rounded-xl bg-signal py-3 text-center font-semibold text-signal-ink">
              Add USDC to trade
            </Link>
          ) : (
            <button
              onClick={press}
              disabled={busy || placing || (status === "in" && (isMarket ? !q || !!blocked : !amount || !trigger || !!triggerIssue || overBalance))}
              className={`mt-2 w-full rounded-xl py-3 font-semibold transition-opacity disabled:opacity-40 ${
                side === "buy" ? "bg-up text-bg" : "bg-down text-bg"
              }`}
            >
              {busy || placing ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-bg/30 border-t-bg" />
                  {placing ? "Placing…" : side === "buy" ? "Buying…" : "Selling…"}
                </span>
              ) : (
                label
              )}
            </button>
          )}
          <p className={`num mt-1 min-h-4 text-center text-xs ${blocked || quoteError || overBalance || enableError || triggerIssue ? "text-down" : "text-muted"}`}>
            {enableError ?? subline ?? (status === "in" && balance.data ? `${formatUsd(balance.data.usdc)} USDC available` : "")}
          </p>
        </div>
      </div>
      <ConfirmSheet quote={confirming} busy={busy} onClose={() => setConfirming(null)} onConfirm={() => confirming && void run(confirming, true)} />
    </>
  );
}
