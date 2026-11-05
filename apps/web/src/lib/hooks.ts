"use client";

import type { PublicConfig } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { useAuth } from "./auth";

export const ConfigContext = createContext<PublicConfig | null>(null);

export function useConfig(): PublicConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig needs its provider");
  return config;
}

export function useMe() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    enabled: status === "in",
    staleTime: 10_000,
  });
}

export function useBalance() {
  const { status } = useAuth();
  return useQuery({
    queryKey: ["balance"],
    queryFn: () => api.balance(),
    enabled: status === "in",
    staleTime: 5_000,
  });
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function evmAddressOf(me: { wallets: Array<{ chainType: string; address: string; isEmbedded: boolean }> } | undefined): string | null {
  if (!me) return null;
  const evm = me.wallets.filter((w) => w.chainType === "evm");
  return (evm.find((w) => w.isEmbedded) ?? evm[0])?.address ?? null;
}

export function solanaAddressOf(me: { wallets: Array<{ chainType: string; address: string; isEmbedded: boolean }> } | undefined): string | null {
  if (!me) return null;
  const sol = me.wallets.filter((w) => w.chainType === "solana");
  return (sol.find((w) => w.isEmbedded) ?? sol[0])?.address ?? null;
}
