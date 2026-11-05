import {
  CHAINS,
  D,
  chainByDexSlug,
  normalizeAddress,
  type ChainKey,
  type TokenSnapshot,
  type WindowStats,
} from "@frontrun/core";
import { fetchJson, HttpError, RateLimiter } from "../http";
import { logger } from "../logger";
import { redis } from "../redis";

const BASE = "https://api.dexscreener.com";

/** DexScreener's documented limits: pairs, tokens and search 300/min; profiles and boosts 60/min. */
export const dexLimiter = new RateLimiter(300, 5);
const boostLimiter = new RateLimiter(60, 2);
export const DEX_BATCH_SIZE = 30;

/**
 * The 300/min is per IP, so the budget is shared across every process through Redis. Over budget, a call
 * fails at once instead of queueing, and callers serve what they have cached.
 */
const DEX_PER_MINUTE = 280;
/** The price feed stops early, so a person opening a token can still get through. */
export const DEX_BACKGROUND_PER_MINUTE = 220;
const COOLDOWN_KEY = "dex:cooldown";
/** Its 429s say to retry after a second, so a longer pause would only starve the feed. */
const COOLDOWN_SECONDS = 5;

export type DexPriority = "interactive" | "background";

export class DexBusyError extends Error {
  constructor() {
    super("DexScreener budget is used up for now");
    this.name = "DexBusyError";
  }
}

async function takeBudget(priority: DexPriority) {
  const r = redis();
  if (await r.exists(COOLDOWN_KEY)) throw new DexBusyError();
  const windowKey = `dex:window:${Math.floor(Date.now() / 60_000)}`;
  const used = await r.incr(windowKey);
  if (used === 1) await r.expire(windowKey, 120);
  if (used > (priority === "background" ? DEX_BACKGROUND_PER_MINUTE : DEX_PER_MINUTE)) throw new DexBusyError();
}

async function dexFetch<T>(path: string, priority: DexPriority, timeoutMs: number): Promise<T> {
  await takeBudget(priority);
  await dexLimiter.acquire();
  try {
    return await fetchJson<T>(`${BASE}${path}`, { timeoutMs });
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      logger.warn({ path: path.split("?")[0]?.slice(0, 40), priority }, "DexScreener rate limit hit");
      await redis().set(COOLDOWN_KEY, "1", "EX", COOLDOWN_SECONDS);
      throw new DexBusyError();
    }
    throw err;
  }
}

interface DexTxns {
  buys?: number;
  sells?: number;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  txns?: Partial<Record<"m5" | "h1" | "h6" | "h24", DexTxns>>;
  volume?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  priceChange?: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

function windowOf<T>(read: (key: "m5" | "h1" | "h6" | "h24") => T): WindowStats<T> {
  return { m5: read("m5"), h1: read("h1"), h6: read("h6"), h24: read("h24") };
}

export function pairToSnapshot(chain: ChainKey, tokenAddress: string, pair: DexPair): TokenSnapshot {
  const isBase = normalizeAddress(chain, pair.baseToken.address) === normalizeAddress(chain, tokenAddress);
  const token = isBase ? pair.baseToken : pair.quoteToken;
  // DexScreener prices the pair's base token. When ours is the quote side, the USD price has to be
  // derived, and market cap and 24h change don't describe our token, so they stay unset.
  let priceUsd: string | null = pair.priceUsd ?? null;
  if (!isBase) priceUsd = null;
  return {
    chain,
    address: normalizeAddress(chain, tokenAddress),
    symbol: token.symbol,
    name: token.name,
    imageUrl: isBase ? (pair.info?.imageUrl ?? null) : null,
    priceUsd,
    marketCapUsd: isBase && pair.marketCap != null ? String(pair.marketCap) : null,
    fdvUsd: isBase && pair.fdv != null ? String(pair.fdv) : null,
    liquidityUsd: pair.liquidity?.usd != null ? String(pair.liquidity.usd) : null,
    volumeUsd: windowOf((k) => pair.volume?.[k] ?? 0),
    txns: windowOf((k) => ({ buys: pair.txns?.[k]?.buys ?? 0, sells: pair.txns?.[k]?.sells ?? 0 })),
    priceChangePct: windowOf((k) => (isBase ? (pair.priceChange?.[k] ?? 0) : 0)),
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    pairCreatedAt: pair.pairCreatedAt ?? null,
    updatedAt: Date.now(),
  };
}

/** The token's price is the deepest pool's price, and volume is summed across its pools. */
export function bestSnapshot(chain: ChainKey, tokenAddress: string, pairs: DexPair[]): TokenSnapshot | null {
  const addr = normalizeAddress(chain, tokenAddress);
  const asBase = pairs.filter((p) => normalizeAddress(chain, p.baseToken.address) === addr);
  const candidates = asBase.length ? asBase : pairs;
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  const snap = pairToSnapshot(chain, tokenAddress, best);
  const sum = (key: "m5" | "h1" | "h6" | "h24") => candidates.reduce((acc, p) => acc + (p.volume?.[key] ?? 0), 0);
  const sumTx = (key: "m5" | "h1" | "h6" | "h24", side: "buys" | "sells") =>
    candidates.reduce((acc, p) => acc + (p.txns?.[key]?.[side] ?? 0), 0);
  snap.volumeUsd = windowOf(sum);
  snap.txns = windowOf((k) => ({ buys: sumTx(k, "buys"), sells: sumTx(k, "sells") }));
  snap.liquidityUsd = best.liquidity?.usd != null ? String(best.liquidity.usd) : null;
  return snap;
}

export async function fetchTokens(chain: ChainKey, addresses: string[], priority: DexPriority = "interactive"): Promise<Map<string, TokenSnapshot>> {
  const result = new Map<string, TokenSnapshot>();
  if (!addresses.length) return result;
  if (addresses.length > DEX_BATCH_SIZE) throw new Error(`DexScreener takes at most ${DEX_BATCH_SIZE} addresses per call`);
  const slug = CHAINS[chain].dexSlug;
  const pairs = await dexFetch<DexPair[]>(`/tokens/v1/${slug}/${addresses.join(",")}`, priority, 5_000);
  for (const address of addresses) {
    const key = normalizeAddress(chain, address);
    const matching = (pairs ?? []).filter(
      (p) => normalizeAddress(chain, p.baseToken.address) === key || normalizeAddress(chain, p.quoteToken.address) === key,
    );
    const snap = bestSnapshot(chain, address, matching);
    if (snap) result.set(key, snap);
  }
  return result;
}

export async function searchPairs(query: string): Promise<TokenSnapshot[]> {
  const data = await dexFetch<{ pairs?: DexPair[] | null }>(`/latest/dex/search?q=${encodeURIComponent(query)}`, "interactive", 5_000);
  const seen = new Map<string, TokenSnapshot>();
  for (const pair of data.pairs ?? []) {
    const chain = chainByDexSlug(pair.chainId);
    if (!chain) continue;
    const key = `${chain.key}:${normalizeAddress(chain.key, pair.baseToken.address)}`;
    const snap = pairToSnapshot(chain.key, pair.baseToken.address, pair);
    const existing = seen.get(key);
    if (!existing || D(snap.liquidityUsd ?? 0).gt(existing.liquidityUsd ?? 0)) seen.set(key, snap);
  }
  return [...seen.values()];
}

export interface BoostedToken {
  chain: ChainKey;
  address: string;
  amount: number;
}

export async function fetchBoosts(): Promise<BoostedToken[]> {
  await boostLimiter.acquire();
  const data = await fetchJson<Array<{ chainId: string; tokenAddress: string; totalAmount?: number }>>(`${BASE}/token-boosts/top/v1`, { timeoutMs: 5_000 });
  return (data ?? []).flatMap((row) => {
    const chain = chainByDexSlug(row.chainId);
    return chain ? [{ chain: chain.key, address: normalizeAddress(chain.key, row.tokenAddress), amount: row.totalAmount ?? 0 }] : [];
  });
}
