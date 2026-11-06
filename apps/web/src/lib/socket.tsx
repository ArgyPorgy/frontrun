"use client";

import { TERMINAL_STATUSES, tokenKey, type ChainKey, type NotificationView, type PriceTick, type ThesisLive, type ThesisView, type TradeView } from "@frontrun/core";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, getToken } from "./api";
import { useAuth } from "./auth";
import { useToast } from "./toast";

/** Puts a thesis's new position into whatever shape a cached query holds it: one thesis, a page, or pages of them. */
function withLive(data: unknown, thesisId: string, live: ThesisLive): unknown {
  if (Array.isArray(data)) return data.map((item) => withLive(item, thesisId, live));
  if (!data || typeof data !== "object") return data;
  const value = data as { id?: string; items?: unknown; pages?: unknown };
  if (value.id === thesisId) return { ...value, live };
  if (Array.isArray(value.items)) return { ...value, items: withLive(value.items, thesisId, live) };
  if (Array.isArray(value.pages)) return { ...value, pages: withLive(value.pages, thesisId, live) };
  return data;
}

/**
 * One socket for the whole app. Prices live in a small store outside React state, so a tick
 * re-renders only the rows showing that token and not everything on the page.
 */
class PriceStore {
  private prices = new Map<string, PriceTick>();
  private listeners = new Map<string, Set<() => void>>();

  get(key: string) {
    return this.prices.get(key);
  }

  set(key: string, tick: PriceTick) {
    this.prices.set(key, tick);
    this.listeners.get(key)?.forEach((l) => l());
  }

  subscribe(key: string, listener: () => void) {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
}

interface SocketValue {
  store: PriceStore;
  watch(chain: ChainKey, address: string): () => void;
  onThesis(listener: (t: ThesisView) => void): () => void;
  onTrade(listener: (t: TradeView) => void): () => void;
}

const SocketContext = createContext<SocketValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const socketRef = useRef<Socket | null>(null);
  const counts = useRef(new Map<string, { chain: ChainKey; address: string; count: number }>());
  const thesisListeners = useRef(new Set<(t: ThesisView) => void>());
  const tradeListeners = useRef(new Set<(t: TradeView) => void>());
  const store = useMemo(() => new PriceStore(), []);

  useEffect(() => {
    if (status === "loading") return;
    let cancelled = false;
    let socket: Socket | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    void (async () => {
      const token = status === "in" ? await getToken().catch(() => null) : null;
      if (cancelled) return;
      socket = io(API_URL, { auth: { token }, transports: ["websocket", "polling"] });
      socketRef.current = socket;

      socket.on("connect", () => {
        // Rooms don't survive a reconnect, so everything being watched gets resubscribed.
        for (const { chain, address } of counts.current.values()) socket?.emit("sub", { chain, address });
      });
      socket.on("tick", (tick: PriceTick) => store.set(tokenKey(tick.chain, tick.address), tick));
      socket.on("price", (p: { chain: ChainKey; address: string; priceUsd: string }) => {
        const key = tokenKey(p.chain, p.address);
        if (store.get(key)) return;
        store.set(key, { chain: p.chain, address: p.address, priceUsd: p.priceUsd, priceChange24h: null, liquidityUsd: null, marketCapUsd: null, volume24hUsd: 0, at: Date.now() });
      });
      socket.on("thesis", (t: ThesisView) => thesisListeners.current.forEach((l) => l(t)));
      socket.on("thesis_position", (e: { thesisId: string; live: ThesisLive }) => {
        for (const queryKey of [["theses"], ["pins"]]) {
          queryClient.setQueriesData({ queryKey }, (data: unknown) => withLive(data, e.thesisId, e.live));
        }
        // A sale can also judge the thesis, so the rest of it is fetched fresh once it's closed.
        if (e.live.status === "exited") void queryClient.invalidateQueries({ queryKey: ["theses"] });
      });
      socket.on("trade", (e: { trade: TradeView }) => {
        tradeListeners.current.forEach((l) => l(e.trade));
        // Only a final result changes these. Refetching earlier would bring a just-sold position back.
        if (!TERMINAL_STATUSES.includes(e.trade.status)) return;
        void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
        void queryClient.invalidateQueries({ queryKey: ["balance"] });
        void queryClient.invalidateQueries({ queryKey: ["position"] });
      });
      socket.on("agent", () => void queryClient.invalidateQueries({ queryKey: ["agents"] }));
      socket.on("stats", () => void queryClient.invalidateQueries({ queryKey: ["stats"] }));
      socket.on("balance", () => {
        void queryClient.invalidateQueries({ queryKey: ["balance"] });
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      });
      socket.on("notification", (e: { notification: NotificationView }) => {
        void queryClient.invalidateQueries({ queryKey: ["notifications"] });
        if (e.notification.type === "deposit" || e.notification.type === "thesis_posted" || e.notification.type === "thesis_position" || e.notification.type === "agent_action") toast(e.notification.message);
      });
      heartbeat = setInterval(() => socket?.emit("heartbeat"), 30_000);
    })();

    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      socket?.close();
      socketRef.current = null;
    };
  }, [queryClient, status, store, toast]);

  const value = useMemo<SocketValue>(
    () => ({
      store,
      watch(chain, address) {
        const key = tokenKey(chain, address);
        const existing = counts.current.get(key);
        if (existing) existing.count++;
        else {
          counts.current.set(key, { chain, address, count: 1 });
          socketRef.current?.emit("sub", { chain, address });
        }
        return () => {
          const entry = counts.current.get(key);
          if (!entry) return;
          entry.count--;
          if (entry.count === 0) {
            counts.current.delete(key);
            socketRef.current?.emit("unsub", { chain, address });
          }
        };
      },
      onThesis(listener) {
        thesisListeners.current.add(listener);
        return () => thesisListeners.current.delete(listener);
      },
      onTrade(listener) {
        tradeListeners.current.add(listener);
        return () => tradeListeners.current.delete(listener);
      },
    }),
    [store],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketValue {
  const value = useContext(SocketContext);
  if (!value) throw new Error("useSocket needs SocketProvider");
  return value;
}

/** Live tick for a token. Components re-render only when this token's price changes. */
export function useLivePrice(chain: ChainKey, address: string): PriceTick | undefined {
  const { store, watch } = useSocket();
  const key = tokenKey(chain, address);
  useEffect(() => watch(chain, address), [chain, address, watch]);
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.get(key),
    () => undefined,
  );
}
