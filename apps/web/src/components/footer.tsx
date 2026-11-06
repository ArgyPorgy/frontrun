"use client";

import { formatPct, formatPrice, type TokenListItem } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { XLogo } from "./brand";
import { TokenIcon } from "./ui";

/** A persistent status bar: a live price ticker on one side, system status, legal and socials on the other.
 *  Desktop only — the phone already has the bottom tab bar. */
export function Footer() {
  const market = useQuery({
    queryKey: ["market", "trending", "all"],
    queryFn: () => api.marketList({ tab: "trending" }),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const items: TokenListItem[] = (market.data?.items ?? []).slice(0, 14);
  const healthy = !market.isError;

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 hidden border-t border-line/70 bg-bg/95 backdrop-blur md:block">
      <div className="flex h-10 items-center gap-6 px-4">
        <div className="tape-hover min-w-0 flex-1 overflow-hidden">
          {/* Two copies back to back, so the strip loops with no gap. */}
          <div className="animate-tape flex w-max items-center">
            {[0, 1].map((copy) => (
              <div key={copy} aria-hidden={copy === 1 ? true : undefined} className="flex shrink-0 items-center">
                {items.map((t) => (
                  <Link
                    key={`${t.chain}:${t.address}`}
                    href={`/token/${t.chain}/${t.address}`}
                    tabIndex={copy === 1 ? -1 : undefined}
                    className="mr-5 flex shrink-0 items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
                  >
                    <TokenIcon symbol={t.symbol} imageUrl={t.imageUrl} size={16} eager />
                    <span className="font-semibold">{t.symbol}</span>
                    <span className="num text-muted">{formatPrice(t.priceUsd)}</span>
                    <span className={`num ${t.priceChangePct.h24 >= 0 ? "text-up" : "text-down"}`}>{formatPct(t.priceChangePct.h24)}</span>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3.5 text-xs text-muted">
          <span className="flex items-center gap-1.5" title={healthy ? "Systems operational" : "Market data is catching up"}>
            <span className={`h-1.5 w-1.5 rounded-full ${healthy ? "bg-up" : "bg-warn"}`} />
            {healthy ? "Stable" : "Degraded"}
          </span>
          <span aria-hidden className="text-line">
            |
          </span>
          <Link href="/legal/privacy" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/legal/terms" className="hover:text-ink">
            Terms
          </Link>
          <Link href="/legal/risk" className="hover:text-ink">
            Risk
          </Link>
          <a
            href="https://x.com/tryfrontrun"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="frontrun on X"
            className="flex items-center text-muted hover:text-ink"
          >
            <XLogo size={15} />
          </a>
        </div>
      </div>
    </footer>
  );
}
