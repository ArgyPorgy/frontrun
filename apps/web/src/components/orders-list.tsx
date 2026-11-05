"use client";

import { formatPrice, formatUsd, type ChainKey, type OrderType, type OrderView } from "@frontrun/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { ChainLogo, TokenIcon } from "./ui";

export const ORDER_LABELS: Record<OrderType, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  stop_buy: "Stop buy",
  stop_loss: "Stop loss",
  take_profit: "Take profit",
};

function OrderRow({ order, showToken }: { order: OrderView; showToken: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(order.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast("Order cancelled");
    },
    onError: (err) => toast(errorMessage(err), { tone: "bad" }),
  });
  const amount = order.side === "buy" ? formatUsd(order.amountUsd) : `${order.sellPct ?? 100}%`;
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      {showToken && (
        <Link href={`/token/${order.token.chain}/${order.token.address}`} className="relative shrink-0">
          <TokenIcon symbol={order.token.symbol} imageUrl={order.token.imageUrl} size={30} />
          <span className="absolute -right-1 -bottom-1 rounded-full ring-2 ring-surface">
            <ChainLogo chain={order.token.chain} size={13} />
          </span>
        </Link>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          <span className={order.side === "buy" ? "text-up" : "text-down"}>{ORDER_LABELS[order.type]}</span>
          {showToken ? ` ${order.token.symbol}` : ""}
        </p>
        <p className="num truncate text-xs text-muted">
          {amount} at {formatPrice(order.triggerPriceUsd)}
        </p>
      </div>
      {order.status === "open" ? (
        <button onClick={() => cancel.mutate()} disabled={cancel.isPending} className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-muted hover:text-ink disabled:opacity-40">
          {cancel.isPending ? "Cancelling…" : "Cancel"}
        </button>
      ) : (
        <span className="shrink-0 text-xs text-muted">Running…</span>
      )}
    </div>
  );
}

/** Open orders, for one token or across all of them. It renders nothing until there's something to show. */
export function OpenOrders({ chain, address, showToken = false, empty }: { chain?: ChainKey; address?: string; showToken?: boolean; empty?: React.ReactNode }) {
  const { status } = useAuth();
  const query = useQuery({
    queryKey: ["orders", "open", chain, address],
    queryFn: () => api.orders({ status: "open", chain, address }),
    enabled: status === "in",
    refetchInterval: 15_000,
  });
  const items = query.data?.items ?? [];
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <div className="divide-y divide-line/40">
      {items.map((o) => (
        <OrderRow key={o.id} order={o} showToken={showToken} />
      ))}
    </div>
  );
}
