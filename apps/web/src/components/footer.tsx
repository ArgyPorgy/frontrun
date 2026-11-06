"use client";

import { formatPct, formatPrice, type TokenListItem } from "@frontrun/core";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { TokenIcon } from "./ui";

function XGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.714 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

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
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-5 overflow-x-auto">
          {items.map((t) => (
            <Link
              key={`${t.chain}:${t.address}`}
              href={`/token/${t.chain}/${t.address}`}
              className="flex shrink-0 items-center gap-1.5 text-xs transition-opacity hover:opacity-80"
            >
              <TokenIcon symbol={t.symbol} imageUrl={t.imageUrl} size={16} />
              <span className="font-semibold">{t.symbol}</span>
              <span className="num text-muted">{formatPrice(t.priceUsd)}</span>
              <span className={`num ${t.priceChangePct.h24 >= 0 ? "text-up" : "text-down"}`}>{formatPct(t.priceChangePct.h24)}</span>
            </Link>
          ))}
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
            <XGlyph />
          </a>
        </div>
      </div>
    </footer>
  );
}
