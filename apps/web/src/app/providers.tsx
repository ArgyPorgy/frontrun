"use client";

import { ApiError, type PublicConfig } from "@frontrun/core";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AppShell } from "@/components/shell";
import { Button } from "@/components/ui";
import { api } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { ConfigContext, useMe } from "@/lib/hooks";
import { SocketProvider } from "@/lib/socket";
import { ToastProvider } from "@/lib/toast";
import { TradeRunnerProvider } from "@/lib/trade";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
  });
}

/** Sends a new account through setup once, and keeps wallets in sync with the identity provider. */
function OnboardingGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (status !== "in") return;
    // On a first login Privy creates the wallets just after sign-in, so keep syncing until both
    // have arrived. Until then a trade would answer "wallet not ready".
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      const fresh = await api.syncMe().catch(() => null);
      if (stopped) return;
      if (fresh) queryClient.setQueryData(["me"], fresh);
      if ((fresh?.wallets.length ?? 0) < 2 && tries++ < 15) timer = setTimeout(() => void sync(), 2000);
    };
    void sync();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [status, queryClient]);

  useEffect(() => {
    if (status === "out") queryClient.removeQueries({ queryKey: ["me"] });
  }, [status, queryClient]);

  useEffect(() => {
    if (status === "in" && me.data?.onboarding === "profile" && pathname !== "/onboarding" && !pathname.startsWith("/legal")) {
      router.replace("/onboarding");
    }
  }, [status, me.data?.onboarding, pathname, router]);

  return <>{children}</>;
}

function ServiceWorker() {
  useEffect(() => {
    // Only in production builds: a dev service worker caches over hot reloads and causes confusion.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}

function Bootstrap({ children }: { children: ReactNode }) {
  const config = useQuery<PublicConfig>({
    queryKey: ["config"],
    queryFn: () => api.config(),
    staleTime: Infinity,
    retry: (count, err) => !(err instanceof ApiError && err.status === 451) && count < 4,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });

  if (config.error instanceof ApiError && config.error.status === 451) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-xl font-semibold">Not available in your region</h1>
          <p className="mt-2 text-muted">Front Run can&apos;t be used from your current location.</p>
        </div>
      </div>
    );
  }
  if (config.isError) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-xl font-semibold">Can&apos;t reach the server</h1>
          <p className="mt-2 text-muted">Check your connection and try again.</p>
          <Button className="mt-4" onClick={() => void config.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!config.data) return <div className="min-h-dvh" />;

  return (
    <ConfigContext.Provider value={config.data}>
      <ToastProvider>
        <AuthProvider config={config.data}>
          <SocketProvider>
            <TradeRunnerProvider>
              <OnboardingGate>
                <AppShell>{children}</AppShell>
              </OnboardingGate>
            </TradeRunnerProvider>
          </SocketProvider>
        </AuthProvider>
      </ToastProvider>
    </ConfigContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <ServiceWorker />
      <Bootstrap>{children}</Bootstrap>
    </QueryClientProvider>
  );
}
