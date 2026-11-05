import {
  CHAINS,
  normalizeAddress,
  type Candle,
  type ChainKey,
  type TapeTrade,
  type Timeframe,
  type TokenSnapshot,
} from "@frontrun/core";
import { env } from "../env";
import { fetchJson, HttpError } from "../http";
import { redis } from "../redis";

export const GECKO_ATTRIBUTION = "Data from GeckoTerminal";

/**
 * GeckoTerminal is the tightest limit we have. Keyless calls start getting 429s after only a handful
 * in a minute, so without a key the budget is small and shared across every process through Redis.
 * A free CoinGecko Demo key allows 100 calls a minute on the same data, and paid plans go higher.
 * Over budget, a call fails at once instead of queueing, and callers serve what they have cached.
 */
function geckoConfig() {
  const e = env();
  if (!e.COINGECKO_API_KEY) {
    return { base: "https://api.geckoterminal.com/api/v2", headers: {} as Record<string, string>, perMinute: 5, backgroundPerMinute: 3, refreshMs: 30_000 };
  }
  return e.COINGECKO_PLAN === "pro"
    ? { base: "https://pro-api.coingecko.com/api/v3/onchain", headers: { "x-cg-pro-api-key": e.COINGECKO_API_KEY }, perMinute: 400, backgroundPerMinute: 200, refreshMs: 1_500 }
    : { base: "https://api.coingecko.com/api/v3/onchain", headers: { "x-cg-demo-api-key": e.COINGECKO_API_KEY }, perMinute: 80, backgroundPerMinute: 40, refreshMs: 3_000 };
}

export function geckoPlan(): "keyless" | "demo" | "pro" {
  const e = env();
  return e.COINGECKO_API_KEY ? e.COINGECKO_PLAN : "keyless";
}

/** How often the worker refreshes one market list, paced so lists leave room for charts. */
export function geckoRefreshMs(): number {
  return geckoConfig().refreshMs;
}

const COOLDOWN_KEY = "gecko:cooldown";
const COOLDOWN_SECONDS = 60;

export class GeckoBusyError extends Error {
  constructor() {
    super("GeckoTerminal budget is used up for now");
    this.name = "GeckoBusyError";
  }
}

export type GeckoPriority = "interactive" | "background";

async function takeBudget(priority: GeckoPriority) {
  const r = redis();
  if (await r.exists(COOLDOWN_KEY)) throw new GeckoBusyError();
  const { perMinute, backgroundPerMinute } = geckoConfig();
  const windowKey = `gecko:window:${Math.floor(Date.now() / 60_000)}`;
  const used = await r.incr(windowKey);
  if (used === 1) await r.expire(windowKey, 120);
  // Background refreshes stop early, so a person opening a chart can still get through.
  const limit = priority === "background" ? backgroundPerMinute : perMinute;
  if (used > limit) throw new GeckoBusyError();
}

export async function geckoSaturated(): Promise<boolean> {
  const r = redis();
  if (await r.exists(COOLDOWN_KEY)) return true;
  const used = Number((await r.get(`gecko:window:${Math.floor(Date.now() / 60_000)}`)) ?? 0);
  return used >= geckoConfig().perMinute;
}

async function gecko<T>(path: string, priority: GeckoPriority = "interactive"): Promise<T> {
  await takeBudget(priority);
  const { base, headers } = geckoConfig();
  try {
    return await fetchJson<T>(`${base}${path}`, { headers, timeoutMs: 10_000 });
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      await redis().set(COOLDOWN_KEY, "1", "EX", COOLDOWN_SECONDS);
      throw new GeckoBusyError();
    }
    throw err;
  }
}

interface GeckoPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    pool_created_at?: string | null;
    base_token_price_usd?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    price_change_percentage?: Partial<Record<"m5" | "h1" | "h6" | "h24", string | null>>;
    transactions?: Partial<Record<"m5" | "h1" | "h6" | "h24", { buys?: number; sells?: number }>>;
    volume_usd?: Partial<Record<"m5" | "h1" | "h6" | "h24", string | null>>;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

interface GeckoIncluded {
  id: string;
  type: string;
  attributes: { address: string; name: string; symbol: string; image_url?: string | null; decimals?: number };
}

function poolToSnapshot(chain: ChainKey, pool: GeckoPool, included: Map<string, GeckoIncluded>): TokenSnapshot {
  const a = pool.attributes;
  const baseId = pool.relationships.base_token.data.id;
  const address = baseId.slice(baseId.indexOf("_") + 1);
  const token = included.get(baseId)?.attributes;
  const [symbolFromName] = a.name.split(" / ");
  const num = (v: string | null | undefined) => Number(v ?? 0) || 0;
  const window = (k: "m5" | "h1" | "h6" | "h24") => k;
  return {
    chain,
    address: normalizeAddress(chain, address),
    symbol: token?.symbol ?? symbolFromName ?? "?",
    name: token?.name ?? symbolFromName ?? "?",
    imageUrl: token?.image_url && token.image_url !== "missing.png" ? token.image_url : null,
    priceUsd: a.base_token_price_usd ?? null,
    marketCapUsd: a.market_cap_usd ?? null,
    fdvUsd: a.fdv_usd ?? null,
    liquidityUsd: a.reserve_in_usd ?? null,
    volumeUsd: {
      m5: num(a.volume_usd?.[window("m5")]),
      h1: num(a.volume_usd?.[window("h1")]),
      h6: num(a.volume_usd?.[window("h6")]),
      h24: num(a.volume_usd?.[window("h24")]),
    },
    txns: {
      m5: { buys: a.transactions?.m5?.buys ?? 0, sells: a.transactions?.m5?.sells ?? 0 },
      h1: { buys: a.transactions?.h1?.buys ?? 0, sells: a.transactions?.h1?.sells ?? 0 },
      h6: { buys: a.transactions?.h6?.buys ?? 0, sells: a.transactions?.h6?.sells ?? 0 },
      h24: { buys: a.transactions?.h24?.buys ?? 0, sells: a.transactions?.h24?.sells ?? 0 },
    },
    priceChangePct: {
      m5: num(a.price_change_percentage?.m5),
      h1: num(a.price_change_percentage?.h1),
      h6: num(a.price_change_percentage?.h6),
      h24: num(a.price_change_percentage?.h24),
    },
    pairAddress: a.address,
    dexId: pool.relationships.dex.data.id,
    pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    updatedAt: Date.now(),
  };
}

async function poolList(chain: ChainKey, path: string, priority: GeckoPriority): Promise<TokenSnapshot[]> {
  const slug = CHAINS[chain].geckoSlug;
  const data = await gecko<{ data?: GeckoPool[]; included?: GeckoIncluded[] }>(
    `/networks/${slug}/${path}?include=base_token,quote_token&page=1`,
    priority,
  );
  const included = new Map((data.included ?? []).map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: TokenSnapshot[] = [];
  for (const pool of data.data ?? []) {
    const snap = poolToSnapshot(chain, pool, included);
    // USDC itself shows up as a base token on some pools, and it isn't something to discover.
    if (seen.has(snap.address) || normalizeAddress(chain, CHAINS[chain].usdc ?? "") === snap.address) continue;
    seen.add(snap.address);
    out.push(snap);
  }
  return out;
}

export const trendingPools = (chain: ChainKey, priority: GeckoPriority = "interactive") => poolList(chain, "trending_pools", priority);
export const newPools = (chain: ChainKey, priority: GeckoPriority = "interactive") => poolList(chain, "new_pools", priority);

const TF: Record<Timeframe, { unit: "minute" | "hour" | "day"; aggregate: number }> = {
  "1m": { unit: "minute", aggregate: 1 },
  "5m": { unit: "minute", aggregate: 5 },
  "15m": { unit: "minute", aggregate: 15 },
  "1h": { unit: "hour", aggregate: 1 },
  "4h": { unit: "hour", aggregate: 4 },
  "1d": { unit: "day", aggregate: 1 },
};

export async function fetchCandles(chain: ChainKey, pool: string, tf: Timeframe, limit = 500): Promise<Candle[]> {
  const { unit, aggregate } = TF[tf];
  const slug = CHAINS[chain].geckoSlug;
  const data = await gecko<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
    `/networks/${slug}/pools/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=${limit}&currency=usd&token=base`,
  );
  const rows = data.data?.attributes?.ohlcv_list ?? [];
  // The API returns newest first; charts need oldest first.
  return rows
    .map(([time, open, high, low, close, volume]) => ({
      time: time!,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume ?? 0,
    }))
    .sort((a, b) => a.time - b.time);
}

interface GeckoTrade {
  id: string;
  attributes: {
    block_timestamp: string;
    tx_hash: string;
    tx_from_address: string;
    kind: "buy" | "sell";
    volume_in_usd?: string;
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd?: string;
    price_to_in_usd?: string;
  };
}

export async function fetchTape(chain: ChainKey, pool: string, limit = 40): Promise<TapeTrade[]> {
  const slug = CHAINS[chain].geckoSlug;
  const data = await gecko<{ data?: GeckoTrade[] }>(`/networks/${slug}/pools/${pool}/trades`);
  return (data.data ?? []).slice(0, limit).map((t) => {
    const a = t.attributes;
    const isBuy = a.kind === "buy";
    return {
      id: t.id,
      time: Date.parse(a.block_timestamp),
      side: a.kind,
      usd: Number(a.volume_in_usd ?? 0),
      priceUsd: Number(isBuy ? a.price_to_in_usd : a.price_from_in_usd) || 0,
      qty: Number(isBuy ? a.to_token_amount : a.from_token_amount) || 0,
      maker: a.tx_from_address,
      txHash: a.tx_hash,
    };
  });
}

export interface GeckoTokenInfo {
  decimals: number | null;
  holderCount: number | null;
  top10Pct: number | null;
  isHoneypot: boolean | null;
  imageUrl: string | null;
}

export async function fetchTokenInfo(chain: ChainKey, address: string): Promise<GeckoTokenInfo> {
  const slug = CHAINS[chain].geckoSlug;
  const data = await gecko<{
    data?: {
      attributes?: {
        decimals?: number;
        image_url?: string | null;
        is_honeypot?: boolean | string | null;
        holders?: { count?: number; distribution_percentage?: { top_10?: string } };
      };
    };
  }>(`/networks/${slug}/tokens/${address}/info`, "background");
  const a = data.data?.attributes;
  const top10 = a?.holders?.distribution_percentage?.top_10;
  const honeypot = a?.is_honeypot;
  return {
    decimals: a?.decimals ?? null,
    holderCount: a?.holders?.count ?? null,
    top10Pct: top10 ? Number(top10) : null,
    isHoneypot: honeypot === true || honeypot === "yes" ? true : honeypot === false || honeypot === "no" ? false : null,
    imageUrl: a?.image_url && a.image_url !== "missing.png" ? a.image_url : null,
  };
}

export async function fetchPoolMakers(chain: ChainKey, pool: string): Promise<{ buyers24h: number; sellers24h: number } | null> {
  const slug = CHAINS[chain].geckoSlug;
  const data = await gecko<{ data?: { attributes?: { transactions?: { h24?: { buyers?: number; sellers?: number } } } } }>(
    `/networks/${slug}/pools/${pool}`,
    "background",
  );
  const h24 = data.data?.attributes?.transactions?.h24;
  if (h24?.buyers == null || h24.sellers == null) return null;
  return { buyers24h: h24.buyers, sellers24h: h24.sellers };
}
