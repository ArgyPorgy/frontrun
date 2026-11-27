import { D } from "./money";

/**
 * Coinbase's tokenized stocks on Base (the list is STOCK_TOKENS in lending.ts). Each token tracks one share,
 * and Chainlink publishes a "Coinbase <TICKER>" price for it. The tokens themselves trade around the clock in
 * Aerodrome and Uniswap pools; the share price only moves while Coinbase's 24/5 stock market is open.
 */

/** How far a trade's price may sit from the Chainlink share price before a buy is refused. */
export const STOCK_ORACLE_GAP = { block: 0.03, warn: 0.01 } as const;

export interface StockMarketStatus {
  open: boolean;
  /** When it next opens or closes, as an ISO time. */
  nextChange: string;
}

const HOUR = 3_600_000;

/** New York's offset from UTC at that moment, in hours (-4 in summer time, -5 in winter). */
function newYorkOffsetHours(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-]\d+)/.exec(name);
  return m ? Number(m[1]) : -5;
}

/**
 * Coinbase's stock market runs 24/5: from 8pm New York time on Sunday to 8pm on Friday. Holidays aren't
 * modelled, so on one of those the share price can sit still while this says open.
 */
export function stockMarketStatus(now: Date = new Date()): StockMarketStatus {
  const offset = newYorkOffsetHours(now);
  // Work in New York wall-clock time, then convert the boundary back.
  const local = new Date(now.getTime() + offset * HOUR);
  const day = local.getUTCDay();
  const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
  const startOfDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const at = (daysAhead: number, h: number) => {
    const wall = startOfDay + daysAhead * 24 * HOUR + h * HOUR;
    // The clocks may change before then, so use the offset in force at that time.
    return new Date(wall - newYorkOffsetHours(new Date(wall - offset * HOUR)) * HOUR).toISOString();
  };
  const closed = (day === 5 && hour >= 20) || day === 6 || (day === 0 && hour < 20);
  if (closed) {
    const daysToSunday = (7 - day) % 7;
    return { open: false, nextChange: at(daysToSunday, 20) };
  }
  const daysToFriday = (5 - day + 7) % 7;
  return { open: true, nextChange: at(daysToFriday, 20) };
}

/**
 * The price a quote pays (buy) or gets (sell) per token, against the share price. Positive means worse for the
 * trader: paying more than the share is worth, or getting less.
 */
export function stockPriceGap(side: "buy" | "sell", tradePriceUsd: string, oraclePriceUsd: string): number {
  const oracle = D(oraclePriceUsd);
  if (oracle.lte(0)) return 0;
  const diff = D(tradePriceUsd).sub(oracle).div(oracle).toNumber();
  return side === "buy" ? diff : -diff;
}

export interface StockView {
  ticker: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  imageUrl: string | null;
  /** Chainlink's share price. */
  sharePriceUsd: string | null;
  sharePriceUpdatedAt: string | null;
  /** What the token trades at in its pools right now. */
  priceUsd: string | null;
  priceChange24hPct: number | null;
  liquidityUsd: string | null;
  volume24hUsd: number | null;
  /** Can be borrowed against in a Morpho market on /lend. */
  lendable: boolean;
}

export interface StocksView {
  market: StockMarketStatus;
  stocks: StockView[];
}
