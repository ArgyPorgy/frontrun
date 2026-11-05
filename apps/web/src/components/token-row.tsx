"use client";

import { D, formatCompactUsd, formatPrice, type TokenListItem } from "@frontrun/core";
import Link from "next/link";
import { useLivePrice } from "@/lib/socket";
import { ChainBadge, LiveNumber, Pct, TokenIcon } from "./ui";

/** `live` subscribes the row to the price feed. Only rows near the top of a list ask for it. */
export function TokenRow({ token, live }: { token: TokenListItem; live: boolean }) {
  return live ? <LiveRow token={token} /> : <RowBody token={token} />;
}

function LiveRow({ token }: { token: TokenListItem }) {
  const tick = useLivePrice(token.chain, token.address);
  return <RowBody token={token} priceUsd={tick?.priceUsd} change={tick?.priceChange24h} marketCap={tick?.marketCapUsd} />;
}

function RowBody({ token, priceUsd, change, marketCap }: { token: TokenListItem; priceUsd?: string; change?: number; marketCap?: string | null }) {
  const price = priceUsd ?? token.priceUsd;
  const pct = change ?? token.priceChangePct.h24;
  const cap = marketCap ?? token.marketCapUsd ?? token.fdvUsd;
  return (
    <Link href={`/token/${token.chain}/${token.address}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors active:bg-surface md:hover:bg-surface">
      <TokenIcon symbol={token.symbol} imageUrl={token.imageUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{token.symbol}</span>
          <ChainBadge chain={token.chain} />
          {token.thesisCount > 0 && (
            <span className="num rounded-md bg-signal/15 px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-signal" title={`${token.thesisCount} thesis`}>
              {token.thesisCount} thesis
            </span>
          )}
          {token.boosted && (
            <span className="rounded-md bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-warn" title="This placement is paid for on DexScreener">
              Boosted
            </span>
          )}
        </div>
        <p className="num mt-0.5 truncate text-xs text-muted">
          {formatCompactUsd(cap)} cap · {formatCompactUsd(token.volumeUsd.h24)} vol
        </p>
      </div>
      <div className="text-right">
        <LiveNumber value={formatPrice(price)} numeric={price ? D(price).toNumber() : null} className="block font-medium" />
        <Pct value={pct} className="text-xs" />
      </div>
    </Link>
  );
}
