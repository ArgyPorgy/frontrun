import { HOME_CHAIN, STOCK_MARKETS, STOCK_TOKENS, normalizeAddress, stockMarketStatus, stockToken, type StockView, type StocksView } from "@frontrun/core";
import { parseAbi, type Address } from "viem";
import { logger } from "./logger";
import { getSnapshot } from "./market/service";
import { evmClient } from "./onchain";
import { cachedJson } from "./redis";

const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

export interface SharePrice {
  priceUsd: string;
  updatedAt: string;
}

/** Chainlink's "Coinbase <TICKER>" price for every stock token, keyed by ticker. Cached briefly. */
export async function sharePrices(): Promise<Record<string, SharePrice>> {
  return cachedJson("stocks:share-prices", 30, async () => {
    const client = evmClient(HOME_CHAIN);
    const calls = STOCK_TOKENS.flatMap((t) => [
      { address: t.feed as Address, abi: FEED_ABI, functionName: "latestRoundData" as const },
      { address: t.feed as Address, abi: FEED_ABI, functionName: "decimals" as const },
    ]);
    const results = await client.multicall({ contracts: calls, allowFailure: true });
    const out: Record<string, SharePrice> = {};
    STOCK_TOKENS.forEach((t, i) => {
      const round = results[i * 2];
      const decimals = results[i * 2 + 1];
      if (round?.status !== "success" || decimals?.status !== "success") return;
      const [, answer, , updatedAt] = round.result as readonly [bigint, bigint, bigint, bigint, bigint];
      if (answer <= 0n) return;
      const d = Number(decimals.result);
      const whole = answer / 10n ** BigInt(d);
      const frac = (answer % 10n ** BigInt(d)).toString().padStart(d, "0");
      out[t.ticker] = { priceUsd: `${whole}.${frac}`, updatedAt: new Date(Number(updatedAt) * 1000).toISOString() };
    });
    return out;
  });
}

/** The share price for a stock token on the home chain, or null for anything else. */
export async function sharePriceFor(chain: string, address: string): Promise<SharePrice | null> {
  if (chain !== HOME_CHAIN) return null;
  const token = stockToken(address);
  if (!token) return null;
  const prices = await sharePrices().catch((err) => {
    logger.warn({ err }, "couldn't read stock share prices");
    return {} as Record<string, SharePrice>;
  });
  return prices[token.ticker] ?? null;
}

const LENDABLE = new Set(STOCK_MARKETS.map((m) => m.ticker));

/** Every Coinbase stock token: share price, pool price and liquidity, and whether the market is open. */
export async function stocksView(): Promise<StocksView> {
  const [prices, snaps] = await Promise.all([
    sharePrices().catch((err) => {
      logger.warn({ err }, "couldn't read stock share prices");
      return {} as Record<string, SharePrice>;
    }),
    Promise.all(STOCK_TOKENS.map((t) => getSnapshot(HOME_CHAIN, normalizeAddress(HOME_CHAIN, t.address), { allowStale: true }).catch(() => null))),
  ]);
  const stocks: StockView[] = STOCK_TOKENS.map((t, i) => {
    const snap = snaps[i];
    const share = prices[t.ticker];
    return {
      ticker: t.ticker,
      symbol: t.symbol,
      name: t.name,
      address: normalizeAddress(HOME_CHAIN, t.address),
      decimals: t.decimals,
      imageUrl: snap?.imageUrl ?? null,
      sharePriceUsd: share?.priceUsd ?? null,
      sharePriceUpdatedAt: share?.updatedAt ?? null,
      priceUsd: snap?.priceUsd ?? null,
      priceChange24hPct: snap?.priceChangePct?.h24 ?? null,
      liquidityUsd: snap?.liquidityUsd ?? null,
      volume24hUsd: snap?.volumeUsd?.h24 ?? null,
      lendable: LENDABLE.has(t.ticker),
    };
  });
  // Deepest pools first: that's where a buy gets the best price.
  stocks.sort((a, b) => Number(b.liquidityUsd ?? 0) - Number(a.liquidityUsd ?? 0));
  return { market: stockMarketStatus(), stocks };
}
