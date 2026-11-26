import type { PerpAssetClass, PerpMarketView } from "@frontrun/core";
import { Veranta } from "veranta-sdk";
import { logger } from "../logger";
import { cachedJson, redis } from "../redis";

/**
 * Veranta's market catalog and prices. Read-only calls, so one shared client with no signer serves them.
 * Prices come one market at a time from Veranta's Pyth feed, so a worker keeps the featured ones warm.
 */
let reader: Veranta | undefined;
export function verantaReader(): Veranta {
  reader ??= new Veranta({ network: "mainnet" });
  return reader;
}

const PRICE_KEY = (pairIndex: number) => `perps:price:${pairIndex}`;
const PRICE_TTL_SECONDS = 60;

/** Tokenized-stock season on Base, so stocks lead, then the crypto, FX and metals people expect. */
const FEATURED_EQUITIES = [
  "NVDA",
  "TSLA",
  "AAPL",
  "META",
  "GOOGL",
  "AMZN",
  "MSFT",
  "COIN",
  "MSTR",
  "HOOD",
  "PLTR",
  "AMD",
  "SPY",
  "QQQ",
  "CRCL",
];
const FEATURED_CRYPTO = 12;
const FEATURED_FX = 6;

function assetClass(raw: string | undefined, symbol: string): PerpAssetClass {
  switch ((raw ?? "").toLowerCase()) {
    case "crypto":
      return "crypto";
    case "equity":
      return "equity";
    case "fx":
      return "fx";
    case "metal":
      return "metal";
    case "commodity":
      return "commodity";
    default:
      return /US\d+|SPX|NDX|JP225/.test(symbol) ? "index" : "other";
  }
}

interface RawPair {
  index: number;
  from: string;
  to: string;
  leverages?: { minLeverage?: number; maxLeverage?: number };
  minLevPosUSDC?: number;
  openFeeP?: number;
  closeFeeP?: number;
  feed?: {
    feedId?: string;
    attributes?: { symbol?: string; assetType?: string; isOpen?: boolean };
  };
  isPairListed?: boolean;
  openInterest?: { long?: number; short?: number };
  pairMaxOI?: number;
}

interface Catalog {
  markets: Array<Omit<PerpMarketView, "priceUsd"> & { feedSymbol: string }>;
}

async function loadCatalog(): Promise<Catalog> {
  const pairs = await verantaReader().markets.pairs();
  const markets = [...pairs.values()]
    .map((p) => p as unknown as RawPair)
    .filter((p) => p.isPairListed !== false && p.leverages?.maxLeverage)
    .map((p) => {
      const symbol = `${p.from}/${p.to}`;
      return {
        pairIndex: p.index,
        symbol,
        base: p.from.replace(/_UPSIDE$/, ""),
        assetClass: assetClass(p.feed?.attributes?.assetType, symbol),
        minLeverage: p.leverages?.minLeverage ?? 1,
        maxLeverage: p.leverages?.maxLeverage ?? 1,
        minPositionUsd: p.minLevPosUSDC ?? 100,
        isOpen: p.feed?.attributes?.isOpen ?? true,
        openFeePct: p.openFeeP ?? 0.045,
        closeFeePct: p.closeFeeP ?? 0.045,
        openInterest: {
          longUsd: p.openInterest?.long ?? 0,
          shortUsd: p.openInterest?.short ?? 0,
          maxUsd: p.pairMaxOI ?? null,
        },
        feedSymbol: p.feed?.attributes?.symbol ?? symbol,
      };
    });
  return { markets };
}

/** The catalog changes rarely, but market hours flip, so it's cached briefly. */
async function catalog(): Promise<Catalog> {
  return cachedJson("perps:catalog", 60, loadCatalog);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export async function perpPrice(pairIndex: number): Promise<number | null> {
  const cached = await redis().get(PRICE_KEY(pairIndex));
  if (cached) return Number(cached);
  try {
    const price = await verantaReader().markets.price(pairIndex);
    if (Number.isFinite(price) && price > 0) {
      await redis().set(
        PRICE_KEY(pairIndex),
        String(price),
        "EX",
        PRICE_TTL_SECONDS,
      );
      return price;
    }
  } catch (err) {
    logger.debug(
      { pairIndex, err: err instanceof Error ? err.message : err },
      "no perp price",
    );
  }
  return null;
}

export async function perpMarket(
  pairIndex: number,
): Promise<PerpMarketView | null> {
  const { markets } = await catalog();
  const m = markets.find((x) => x.pairIndex === pairIndex);
  if (!m) return null;
  const price = await perpPrice(pairIndex);
  const { feedSymbol: _feed, ...view } = m;
  return { ...view, priceUsd: price };
}

type CatalogMarket = Catalog["markets"][number];
function featuredIndexes(markets: Catalog["markets"]): number[] {
  const total = (m: CatalogMarket) =>
    m.openInterest.longUsd + m.openInterest.shortUsd;
  const byOi = (a: CatalogMarket, b: CatalogMarket) => total(b) - total(a);
  const equities = FEATURED_EQUITIES.flatMap((t) =>
    markets
      .filter((m) => m.assetClass === "equity" && m.base === t)
      .slice(0, 1),
  );
  const crypto = markets
    .filter((m) => m.assetClass === "crypto" && !m.symbol.includes("_UPSIDE"))
    .sort(byOi)
    .slice(0, FEATURED_CRYPTO);
  const fx = markets
    .filter((m) => m.assetClass === "fx")
    .sort(byOi)
    .slice(0, FEATURED_FX);
  const metals = markets.filter(
    (m) => m.assetClass === "metal" || m.assetClass === "commodity",
  );
  return [...equities, ...crypto, ...fx, ...metals].map((m) => m.pairIndex);
}

/** The markets shown first: stocks, then crypto, FX, metals and commodities. Others come from search. */
export async function perpMarkets(
  opts: { assetClass?: PerpAssetClass; query?: string } = {},
): Promise<PerpMarketView[]> {
  const { markets } = await catalog();
  const q = opts.query?.trim().toLowerCase();
  const chosen = q
    ? markets
        .filter(
          (m) =>
            m.symbol.toLowerCase().includes(q) ||
            m.base.toLowerCase().includes(q),
        )
        .slice(0, 40)
    : featuredIndexes(markets).map((i) =>
        markets.find((m) => m.pairIndex === i)!,
      );
  const filtered = opts.assetClass
    ? chosen.filter((m) => m.assetClass === opts.assetClass)
    : chosen;
  const cached = await redis().mget(
    filtered.map((m) => PRICE_KEY(m.pairIndex)),
  );
  // Anything the worker hasn't warmed yet is fetched now, in parallel, so a list never shows blanks for long.
  const prices = await Promise.all(
    filtered.map((m, i) =>
      cached[i] ? Number(cached[i]) : withTimeout(perpPrice(m.pairIndex), 2500),
    ),
  );
  return filtered.map((m, i) => {
    const { feedSymbol: _feed, ...view } = m;
    return { ...view, priceUsd: prices[i] ?? null };
  });
}

/** Worker: refreshes prices for the featured markets and any with open positions. */
export async function refreshPerpPrices(extra: number[] = []): Promise<number> {
  const { markets } = await catalog();
  const indexes = [...new Set([...featuredIndexes(markets), ...extra])];
  let done = 0;
  for (let i = 0; i < indexes.length; i += 8) {
    await Promise.all(
      indexes.slice(i, i + 8).map(async (pairIndex) => {
        try {
          const price = await verantaReader().markets.price(pairIndex);
          if (Number.isFinite(price) && price > 0) {
            await redis().set(
              PRICE_KEY(pairIndex),
              String(price),
              "EX",
              PRICE_TTL_SECONDS,
            );
            done += 1;
          }
        } catch {
          // Closed markets have no live price. They keep their last one until it expires.
        }
      }),
    );
  }
  return done;
}

export interface PerpCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const RESOLUTIONS: Record<string, { res: string; seconds: number }> = {
  "1m": { res: "1", seconds: 60 },
  "5m": { res: "5", seconds: 300 },
  "15m": { res: "15", seconds: 900 },
  "1h": { res: "60", seconds: 3600 },
  "4h": { res: "240", seconds: 14_400 },
  "1d": { res: "1D", seconds: 86_400 },
};

export async function perpCandles(
  pairIndex: number,
  timeframe: string,
): Promise<PerpCandle[]> {
  const { markets } = await catalog();
  const m = markets.find((x) => x.pairIndex === pairIndex);
  const tf = RESOLUTIONS[timeframe] ?? RESOLUTIONS["15m"]!;
  if (!m) return [];
  return cachedJson(
    `perps:candles:${pairIndex}:${timeframe}`,
    Math.min(tf.seconds, 60),
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const raw = (await verantaReader().markets.candles(
        m.feedSymbol,
        tf.res,
        now - tf.seconds * 300,
        now,
      )) as Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
      }>;
      return (Array.isArray(raw) ? raw : []).map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
    },
  );
}
