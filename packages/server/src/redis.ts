import { Redis } from "ioredis";
import { env } from "./env";

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) client = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false });
  return client;
}

/** A separate connection, since a subscribed Redis client can't issue ordinary commands. */
export function newSubscriber(): Redis {
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis() {
  await client?.quit();
  client = undefined;
}

export const CHANNELS = {
  ticks: "chan:ticks",
  theses: "chan:theses",
  stats: "chan:stats",
  user: (userId: string) => `chan:user:${userId}`,
  userPattern: "chan:user:*",
} as const;

export const KEYS = {
  price: (tokenKey: string) => `price:${tokenKey}`,
  snapshot: (tokenKey: string) => `snap:${tokenKey}`,
  snapshotStale: (tokenKey: string) => `snap:stale:${tokenKey}`,
  activeTokens: "active:tokens",
  market: (tab: string, chain: string) => `market:${tab}:${chain}`,
  boosts: "market:boosts",
  candles: (poolKey: string, tf: string) => `candles:${poolKey}:${tf}`,
  tape: (poolKey: string) => `tape:${poolKey}`,
  tokenInfo: (tokenKey: string) => `tokeninfo:${tokenKey}`,
  quote: (id: string) => `quote:${id}`,
  quoteUsed: (id: string) => `quote:${id}:used`,
  onlineWallets: "online:wallets",
  lastBalance: (address: string) => `balance:${address}`,
} as const;

export async function cachedJson<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const r = redis();
  const hit = await r.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await load();
  await r.set(key, JSON.stringify(value), "EX", ttlSeconds);
  return value;
}

export async function publish(channel: string, message: unknown) {
  await redis().publish(channel, JSON.stringify(message));
}
