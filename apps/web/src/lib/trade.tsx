"use client";

import { ApiError, D, TERMINAL_STATUSES, type ChainKey, type PortfolioView, type QuoteView, type TradeView } from "@frontrun/core";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TradeCardSheet } from "@/components/trade-card";
import { api, errorMessage } from "./api";
import { useAuth } from "./auth";
import { useSocket } from "./socket";
import { useToast } from "./toast";

export interface TradeRequest {
  chain: ChainKey;
  address: string;
  side: "buy" | "sell";
  amountUsd?: string;
  sellPct?: number;
  copyThesisId?: string;
}

function newKey(): string {
  return crypto.randomUUID();
}

interface TradeRunner {
  execute(quote: QuoteView, opts?: { confirmed?: boolean }): Promise<{ needsConfirm?: boolean; expired?: boolean; trade?: TradeView }>;
}

const TradeRunnerContext = createContext<TradeRunner | null>(null);

/**
 * Runs one trade from tap to fill. It keeps the toast and receipt current, signs in the wallet when
 * the backend says it has to, and re-quotes once on an expired price. It lives above the pages, so a
 * trade is still tracked after leaving the token page.
 */
export function TradeRunnerProvider({ children }: { children: ReactNode }) {
  const { wallet } = useAuth();
  const { toast, dismiss, rekey } = useToast();
  const { onTrade } = useSocket();
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<TradeView | null>(null);
  const watching = useRef(new Set<string>());
  const claimed = useRef(new Set<string>());

  const describe = useCallback((t: TradeView) => {
    switch (t.status) {
      case "filled":
        return `${t.side === "buy" ? "Bought" : "Sold"} ${t.token.symbol}`;
      case "refunded":
        return `${t.side === "buy" ? "Buy" : "Sell"} refunded`;
      case "failed":
        return t.error ?? `Your ${t.token.symbol} ${t.side} didn't go through`;
      case "awaiting_signature":
        return `Check your wallet to sign`;
      default:
        return `${t.side === "buy" ? "Buying" : "Selling"} ${t.token.symbol}`;
    }
  }, []);

  const showStatus = useCallback(
    (t: TradeView) => {
      const terminal = TERMINAL_STATUSES.includes(t.status);
      // Once "Bought" is showing, only the real result may change it.
      if (!terminal && claimed.current.has(t.id)) return;
      toast(describe(t), {
        key: `trade:${t.id}`,
        tone: t.status === "filled" ? "good" : t.status === "failed" || t.status === "refunded" ? "bad" : "pending",
        sticky: !terminal,
      });
      if (terminal) {
        watching.current.delete(t.id);
        claimed.current.delete(t.id);
        setReceipt(t);
        void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
        void queryClient.invalidateQueries({ queryKey: ["balance"] });
        void queryClient.invalidateQueries({ queryKey: ["position"] });
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      }
    },
    [describe, queryClient, toast],
  );

  useEffect(
    () =>
      onTrade((t) => {
        if (watching.current.has(t.id)) showStatus(t);
      }),
    [onTrade, showStatus],
  );

  // The websocket drives updates, but a dropped socket shouldn't leave a toast stuck on "Buying".
  useEffect(() => {
    const timer = setInterval(() => {
      for (const id of watching.current) {
        api.trade(id).then(
          (t) => {
            if (watching.current.has(t.id) && TERMINAL_STATUSES.includes(t.status)) showStatus(t);
          },
          () => {},
        );
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [showStatus]);

  /**
   * Shows the result as soon as the venue has accepted the order. Real fills take from a few seconds up
   * to about 40, so this always lands well before the chain confirms, and the app feels instant. If the
   * order later fails, the toast and the card correct themselves.
   */
  const claimAhead = useCallback(
    (trade: TradeView, quote: QuoteView) => {
      if (TERMINAL_STATUSES.includes(trade.status) || trade.status === "awaiting_signature") return;
      claimed.current.add(trade.id);
      toast(`${trade.side === "buy" ? "Bought" : "Sold"} ${trade.token.symbol}`, { key: `trade:${trade.id}`, tone: "good" });
      if (trade.side !== "sell") return;
      // A full sale leaves the position straight away too. A failure refetches it, which puts it back.
      const { chain, address } = trade.token;
      const key = ["position", chain, address];
      const held = queryClient.getQueryData<{ position: { qty: string } | null }>(key)?.position;
      if (!held || !quote.qtyIn || D(quote.qtyIn).lt(D(held.qty).mul("0.999"))) return;
      queryClient.setQueryData(key, { position: null });
      queryClient.setQueryData<PortfolioView>(["portfolio"], (p) => (p ? { ...p, open: p.open.filter((o) => o.token.chain !== chain || o.token.address !== address) } : p));
    },
    [queryClient, toast],
  );

  const signInWallet = useCallback(
    async (initial: TradeView): Promise<TradeView> => {
      let trade = initial;
      while (trade.status === "awaiting_signature" && trade.pendingSteps?.length) {
        const results = [];
        for (const step of trade.pendingSteps) results.push(await wallet.runStep(step));
        trade = await api.submitSteps(trade.id, results);
      }
      return trade;
    },
    [wallet],
  );

  /** Executes a quote the user has already seen. Returns needsConfirm if it can't be one tap. */
  const execute = useCallback<TradeRunner["execute"]>(
    async (quote, opts = {}) => {
      // This shows at the press, before the server has answered.
      const startKey = `trade-start:${quote.id}`;
      let tradeId: string | null = null;
      toast(`${quote.side === "buy" ? "Buying" : "Selling"} ${quote.token.symbol}`, { key: startKey, tone: "pending", sticky: true });
      try {
        const started = await api.executeTrade({ quoteId: quote.id, idempotencyKey: newKey(), confirmed: opts.confirmed });
        tradeId = started.id;
        rekey(startKey, `trade:${started.id}`);
        watching.current.add(started.id);
        showStatus(started);
        const trade = await signInWallet(started);
        showStatus(trade);
        claimAhead(trade, quote);
        return { trade };
      } catch (err) {
        dismiss(tradeId ? `trade:${tradeId}` : startKey);
        if (tradeId) watching.current.delete(tradeId);
        if (err instanceof ApiError && err.code === "needs_confirm") return { needsConfirm: true };
        if (err instanceof ApiError && (err.code === "quote_expired" || err.code === "price_moved" || err.code === "quote_used")) {
          return { expired: true };
        }
        toast(errorMessage(err), { tone: "bad" });
        return {};
      }
    },
    [claimAhead, dismiss, rekey, showStatus, signInWallet, toast],
  );

  const value = useMemo<TradeRunner>(() => ({ execute }), [execute]);

  return (
    <TradeRunnerContext.Provider value={value}>
      {children}
      <TradeCardSheet trade={receipt} onClose={() => setReceipt(null)} />
    </TradeRunnerContext.Provider>
  );
}

export function useTradeRunner(): TradeRunner {
  const value = useContext(TradeRunnerContext);
  if (!value) throw new Error("useTradeRunner needs TradeRunnerProvider");
  return value;
}
