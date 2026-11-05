import {
  CHAINS,
  CHAIN_KEYS,
  D,
  computeRiskFlags,
  normalizeAddress,
  tokenKey,
  type Candle,
  type ChainKey,
  type PriceTick,
  type TapeTrade,
  type Timeframe,
  type TokenDetail,
  type TokenListItem,
  type TokenSnapshot,
} from "@frontrun/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { flashAsset, flashSearch, type FlashSearchHit } from "../providers/flash";
import { KEYS, redis } from "../redis";
import { fetchBoosts, fetchTokens, searchPairs } from "./dexscreener";
import {
  GECKO_ATTRIBUTION,
  fetchCandles,
  fetchPoolMakers,
  fetchTape,
  fetchTokenInfo,
  geckoSaturated,
  newPools,
  trendingPools,
  type GeckoPriority,
  type GeckoTokenInfo,
} from "./geckoterminal";

export { GECKO_ATTRIBUTION };

const SNAPSHOT_TTL_SECONDS = 20;
const SNAPSHOT_STALE_TTL_SECONDS = 600;
const ACTIVE_WINDOW_MS = 120_000;

/** A client is watching this token, so the price worker should keep it fresh. */
export async function markActive(chain: ChainKey, address: string) {
  await redis().zadd(KEYS.activeTokens, Date.now(), tokenKey(chain, address));
}

export async function activeTokenKeys(limit: number): Promise<string[]> {
  const r = redis();
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  await r.zremrangebyscore(KEYS.activeTokens, 0, cutoff);
  return r.zrevrange(KEYS.activeTokens, 0, limit - 1);
}

export async function writeSnapshot(snap: TokenSnapshot) {
  const key = tokenKey(snap.chain, snap.address);
  const pipeline = redis().pipeline();
  pipeline.set(KEYS.snapshot(key), JSON.stringify(snap), "EX", SNAPSHOT_TTL_SECONDS);
  pipeline.set(KEYS.snapshotStale(key), JSON.stringify(snap), "EX", SNAPSHOT_STALE_TTL_SECONDS);
  if (snap.priceUsd) pipeline.set(KEYS.price(key), snap.priceUsd, "EX", 3600);
  await pipeline.exec();
}

export function snapshotToTick(snap: TokenSnapshot): PriceTick | null {
  if (!snap.priceUsd) return null;
  return {
    chain: snap.chain,
    address: snap.address,
    priceUsd: snap.priceUsd,
    priceChange24h: snap.priceChangePct.h24,
    liquidityUsd: snap.liquidityUsd,
    marketCapUsd: snap.marketCapUsd,
    volume24hUsd: snap.volumeUsd.h24,
    at: snap.updatedAt,
  };
}

/**
 * allowStale is for showing a page: a rate limit or an outage shouldn't take it down while a recent
 * snapshot is on hand. Anything that locks in a price, like a trade or a thesis, must leave it off.
 */
export async function getSnapshot(chain: ChainKey, address: string, opts: { allowStale?: boolean } = {}): Promise<TokenSnapshot | null> {
  const key = tokenKey(chain, address);
  const hit = await redis().get(KEYS.snapshot(key));
  if (hit) return JSON.parse(hit) as TokenSnapshot;
  let fresh: Map<string, TokenSnapshot>;
  try {
    fresh = await fetchTokens(chain, [address]);
  } catch (err) {
    const stale = opts.allowStale ? await redis().get(KEYS.snapshotStale(key)) : null;
    if (stale) return JSON.parse(stale) as TokenSnapshot;
    throw err;
  }
  const snap = fresh.get(normalizeAddress(chain, address)) ?? null;
  if (snap) {
    await writeSnapshot(snap);
    await rememberToken(snap);
  }
  return snap;
}

/** Latest known prices, for pricing portfolios and feeds without calling a provider per row. */
export async function getPrices(keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!keys.length) return out;
  const values = await redis().mget(keys.map(KEYS.price));
  values.forEach((v, i) => {
    if (v) out.set(keys[i]!, v);
  });
  return out;
}

/** Prices for token keys, fetching whichever aren't cached. */
export async function getPricesFilled(keys: string[]): Promise<Map<string, string>> {
  const prices = await getPrices(keys);
  const missing = keys.filter((k) => !prices.has(k));
  const byChain = new Map<ChainKey, string[]>();
  for (const key of missing) {
    const [chain, address] = key.split(":") as [ChainKey, string];
    byChain.set(chain, [...(byChain.get(chain) ?? []), address]);
  }
  await Promise.all(
    [...byChain.entries()].map(async ([chain, addresses]) => {
      for (let i = 0; i < addresses.length; i += 30) {
        const batch = addresses.slice(i, i + 30);
        const snaps = await fetchTokens(chain, batch).catch(() => new Map<string, TokenSnapshot>());
        for (const snap of snaps.values()) {
          await writeSnapshot(snap);
          if (snap.priceUsd) prices.set(tokenKey(chain, snap.address), snap.priceUsd);
        }
      }
    }),
  );
  return prices;
}

export async function rememberToken(snap: Pick<TokenSnapshot, "chain" | "address" | "symbol" | "name" | "imageUrl">, decimals?: number | null) {
  await db()
    .insert(schema.tokens)
    .values({ chain: snap.chain, address: snap.address, symbol: snap.symbol, name: snap.name, imageUrl: snap.imageUrl, decimals: decimals ?? null })
    .onConflictDoUpdate({
      target: [schema.tokens.chain, schema.tokens.address],
      set: {
        symbol: snap.symbol,
        name: snap.name,
        ...(snap.imageUrl ? { imageUrl: snap.imageUrl } : {}),
        ...(decimals != null ? { decimals } : {}),
      },
    });
}

interface CachedTokenInfo {
  gecko: GeckoTokenInfo | null;
  flash: Awaited<ReturnType<typeof flashAsset>>;
  makers?: { buyers24h: number; sellers24h: number } | null;
}

async function tokenInfo(chain: ChainKey, address: string, pool: string | null): Promise<CachedTokenInfo> {
  const key = KEYS.tokenInfo(tokenKey(chain, address));
  const hit = await redis().get(key);
  if (hit) return JSON.parse(hit) as CachedTokenInfo;
  const [gecko, flash, makers] = await Promise.all([
    fetchTokenInfo(chain, address).catch(() => null),
    flashAsset(chain, address).catch(() => null),
    pool ? fetchPoolMakers(chain, pool).catch(() => null) : null,
  ]);
  const info = { gecko, flash, makers };
  // A miss from a busy provider is only remembered briefly, so holder data shows up soon after.
  await redis().set(key, JSON.stringify(info), "EX", gecko ? 600 : 45);
  return info;
}

export async function thesisCounts(keys: Array<{ chain: string; address: string }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!keys.length) return out;
  const rows = await db()
    .select({ chain: schema.theses.tokenChain, address: schema.theses.tokenAddr, count: sql<number>`count(*)::int` })
    .from(schema.theses)
    .where(
      and(
        inArray(schema.theses.tokenAddr, keys.map((k) => k.address)),
        isNull(schema.theses.deletedAt),
        isNull(schema.theses.hiddenAt),
      ),
    )
    .groupBy(schema.theses.tokenChain, schema.theses.tokenAddr);
  for (const row of rows) out.set(`${row.chain}:${row.address}`, row.count);
  return out;
}

export async function getTokenDetail(chain: ChainKey, address: string, opts: { allowStale?: boolean } = {}): Promise<TokenDetail | null> {
  const snap = await getSnapshot(chain, address, opts);
  if (!snap) return null;
  const [info, stored, counts] = await Promise.all([
    tokenInfo(chain, address, snap.pairAddress),
    db().query.tokens.findFirst({ where: and(eq(schema.tokens.chain, chain), eq(schema.tokens.address, normalizeAddress(chain, address))) }),
    thesisCounts([{ chain, address: snap.address }]),
  ]);
  const decimals = info.flash?.decimals ?? info.gecko?.decimals ?? stored?.decimals ?? null;
  if (decimals !== null && stored?.decimals == null) await rememberToken(snap, decimals);
  const flashFlagged = info.flash?.riskFlagged ?? false;
  const honeypot = info.gecko?.isHoneypot ?? null;
  const risk = computeRiskFlags({
    flashRiskFlagged: flashFlagged,
    liquidityUsd: snap.liquidityUsd,
    volume24hUsd: snap.volumeUsd.h24,
    pairCreatedAt: snap.pairCreatedAt,
    top10HolderPct: info.gecko?.top10Pct ?? null,
    buys24h: snap.txns.h24.buys,
    sells24h: snap.txns.h24.sells,
  });
  if (honeypot) {
    risk.unshift({ code: "flash_flagged", label: "Honeypot", severity: "high", detail: "GeckoTerminal reports this token may not be sellable." });
  }
  const holderCount = info.gecko?.holderCount ?? info.flash?.holders ?? null;
  return {
    ...snap,
    imageUrl: snap.imageUrl ?? info.gecko?.imageUrl ?? info.flash?.imageUrl ?? stored?.imageUrl ?? null,
    decimals,
    holders: {
      count: holderCount,
      top10Pct: info.gecko?.top10Pct ?? null,
      source: info.gecko?.holderCount != null ? "geckoterminal" : info.flash?.holders != null ? "flash" : null,
    },
    makers: info.makers ?? null,
    risk,
    riskFlagged: flashFlagged || honeypot === true || (stored?.denylisted ?? false),
    isHoneypot: honeypot,
    thesisCount: counts.get(`${chain}:${snap.address}`) ?? 0,
    tradable: info.flash?.tradable ?? true,
  };
}

/** Serves candles with a stale fallback, so a rate-limited provider degrades instead of failing. */
export async function getCandles(chain: ChainKey, pool: string, tf: Timeframe): Promise<Candle[]> {
  const r = redis();
  const key = KEYS.candles(`${chain}:${pool}`, tf);
  const ttl: Record<Timeframe, number> = { "1m": 15, "5m": 30, "15m": 45, "1h": 60, "4h": 60, "1d": 60 };
  const freshKey = `${key}:fresh`;
  const [cached, fresh] = await r.mget(key, freshKey);
  if (cached && fresh) return JSON.parse(cached) as Candle[];
  if (cached && (await geckoSaturated())) return JSON.parse(cached) as Candle[];
  try {
    const candles = await fetchCandles(chain, pool, tf);
    await r.set(key, JSON.stringify(candles), "EX", 3600);
    await r.set(freshKey, "1", "EX", ttl[tf]);
    return candles;
  } catch (err) {
    if (cached) return JSON.parse(cached) as Candle[];
    throw err;
  }
}

export async function getTape(chain: ChainKey, pool: string): Promise<TapeTrade[]> {
  const r = redis();
  const key = KEYS.tape(`${chain}:${pool}`);
  const freshKey = `${key}:fresh`;
  const [cached, fresh] = await r.mget(key, freshKey);
  if (cached && fresh) return JSON.parse(cached) as TapeTrade[];
  if (cached && (await geckoSaturated())) return JSON.parse(cached) as TapeTrade[];
  try {
    const tape = await fetchTape(chain, pool);
    await r.set(key, JSON.stringify(tape), "EX", 600);
    await r.set(freshKey, "1", "EX", 15);
    return tape;
  } catch (err) {
    if (cached) return JSON.parse(cached) as TapeTrade[];
    throw err;
  }
}

export type MarketTab = "trending" | "new";

export async function refreshMarketList(tab: MarketTab, chain: ChainKey, priority: GeckoPriority = "background"): Promise<TokenSnapshot[]> {
  const list = tab === "trending" ? await trendingPools(chain, priority) : await newPools(chain, priority);
  await redis().set(KEYS.market(tab, chain), JSON.stringify(list), "EX", 900);
  const pipeline = redis().pipeline();
  for (const snap of list) {
    const key = tokenKey(snap.chain, snap.address);
    if (snap.priceUsd) pipeline.set(KEYS.price(key), snap.priceUsd, "EX", 3600);
  }
  await pipeline.exec();
  return list;
}

export async function refreshBoosts() {
  const boosts = await fetchBoosts();
  await redis().set(KEYS.boosts, JSON.stringify(boosts.map((b) => `${b.chain}:${b.address}`)), "EX", 900);
}

async function decorate(list: TokenSnapshot[]): Promise<TokenListItem[]> {
  const boostsRaw = await redis().get(KEYS.boosts);
  const boosted = new Set<string>(boostsRaw ? (JSON.parse(boostsRaw) as string[]) : []);
  const counts = await thesisCounts(list.map((t) => ({ chain: t.chain, address: t.address })));
  return list.map((t) => ({
    ...t,
    boosted: boosted.has(`${t.chain}:${t.address}`),
    thesisCount: counts.get(`${t.chain}:${t.address}`) ?? 0,
  }));
}

async function loadList(tab: MarketTab, chain: ChainKey): Promise<TokenSnapshot[]> {
  const cached = await redis().get(KEYS.market(tab, chain));
  return cached ? (JSON.parse(cached) as TokenSnapshot[]) : [];
}

/** Interleaves chains so Arc leads and one busy chain can't fill the whole list. */
function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const list of lists) {
      const item = list[i];
      if (item) {
        out.push(item);
        any = true;
        if (out.length >= limit) break;
      }
    }
    if (!any) break;
  }
  return out;
}

export async function marketList(tab: MarketTab, chain?: ChainKey): Promise<TokenListItem[]> {
  const chains = chain ? [chain] : CHAIN_KEYS;
  let lists = await Promise.all(chains.map((c) => loadList(tab, c)));
  if (lists.every((l) => l.length === 0)) {
    // Cold start before the worker's first pass: load one chain on demand so the page isn't empty.
    const first = chain ?? "arc";
    lists = [await refreshMarketList(tab, first, "interactive").catch(() => [])];
  }
  return decorate(interleave(lists, 60));
}

function flashHitToSnapshot(hit: FlashSearchHit, chain: ChainKey): TokenSnapshot {
  const empty = { m5: 0, h1: 0, h6: 0, h24: 0 };
  const noTx = { buys: 0, sells: 0 };
  return {
    chain,
    address: normalizeAddress(chain, hit.address),
    symbol: hit.symbol,
    name: hit.name,
    imageUrl: hit.imageUrl || null,
    priceUsd: D(hit.price).gt(0) ? hit.price : null,
    marketCapUsd: D(hit.marketCap).gt(0) ? hit.marketCap : null,
    fdvUsd: null,
    liquidityUsd: D(hit.liquidity).gt(0) ? hit.liquidity : null,
    volumeUsd: { ...empty, h24: Number(hit.volume24h) || 0 },
    txns: { m5: noTx, h1: noTx, h6: noTx, h24: noTx },
    priceChangePct: { ...empty, h24: (Number(hit.priceChange24h) || 0) * 100 },
    pairAddress: null,
    dexId: null,
    pairCreatedAt: null,
    updatedAt: Date.now(),
  };
}

export async function searchTokens(query: string, chain?: ChainKey): Promise<TokenListItem[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const [dex, flash] = await Promise.all([searchPairs(q).catch(() => []), flashSearch(q, chain)]);
  const merged = new Map<string, TokenSnapshot>();
  for (const snap of dex) {
    if (chain && snap.chain !== chain) continue;
    if (!(snap.chain in CHAINS)) continue;
    merged.set(tokenKey(snap.chain, snap.address), snap);
  }
  for (const hit of flash) {
    // Flash marks scam-pattern tokens. Search leaves them out, as the plan asks.
    if (hit.riskFlagged) {
      const c = CHAIN_KEYS.find((k) => CHAINS[k].flashSlug === hit.chain);
      if (c) merged.delete(tokenKey(c, hit.address));
      continue;
    }
    const c = CHAIN_KEYS.find((k) => CHAINS[k].flashSlug === hit.chain);
    if (!c) continue;
    const key = tokenKey(c, hit.address);
    if (!merged.has(key)) merged.set(key, flashHitToSnapshot(hit, c));
  }
  const ranked = [...merged.values()].sort((a, b) => D(b.liquidityUsd ?? 0).cmp(a.liquidityUsd ?? 0));
  return decorate(ranked.slice(0, 30));
}
