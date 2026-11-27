import type { Candle, ChainKey, Timeframe, TokenSnapshot } from "@frontrun/core";
import { redis } from "../redis";

/**
 * Our own candles, built from the prices the worker already reads from DexScreener every second for the tokens
 * people are watching (and the stock tokens, always). GeckoTerminal's free API allows only a handful of calls a
 * minute, so it now supplies a chart's older history, fetched rarely, and these keep the live edge moving.
 * They carry no volume: DexScreener only gives rolling totals, which can't be split into minutes honestly.
 */

const KEEP_SECONDS = 3 * 86_400;
const STEP: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

const key = (chain: ChainKey, pool: string) => `lc:${chain}:${pool.toLowerCase()}`;

/** Folds one price into its pool's current 1-minute candle. */
export async function recordTick(snap: Pick<TokenSnapshot, "chain" | "pairAddress" | "priceUsd">, now = Date.now()): Promise<void> {
  if (!snap.pairAddress || !snap.priceUsd) return;
  const price = Number(snap.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return;
  const r = redis();
  const k = key(snap.chain, snap.pairAddress);
  const minute = Math.floor(now / 60_000) * 60;
  const prev = await r.hget(k, String(minute));
  let next: string;
  if (prev) {
    const [o, h, l] = prev.split(",").map(Number) as [number, number, number];
    next = `${o},${Math.max(h, price)},${Math.min(l, price)},${price}`;
  } else {
    next = `${price},${price},${price},${price}`;
  }
  const pipeline = r.pipeline().hset(k, String(minute), next).expire(k, KEEP_SECONDS);
  // A new minute retires the one from three days ago, so the hash stays bounded.
  if (!prev) pipeline.hdel(k, String(minute - KEEP_SECONDS));
  await pipeline.exec();
}

/** Rolls 1-minute candles up into the timeframe asked for, oldest first. */
export function rollUp(minutes: Array<{ time: number; open: number; high: number; low: number; close: number }>, tf: Timeframe): Candle[] {
  const step = STEP[tf];
  const out = new Map<number, Candle>();
  for (const m of [...minutes].sort((a, b) => a.time - b.time)) {
    const bucket = Math.floor(m.time / step) * step;
    const c = out.get(bucket);
    if (!c) out.set(bucket, { time: bucket, open: m.open, high: m.high, low: m.low, close: m.close, volume: 0 });
    else {
      c.high = Math.max(c.high, m.high);
      c.low = Math.min(c.low, m.low);
      c.close = m.close;
    }
  }
  return [...out.values()];
}

export async function liveCandles(chain: ChainKey, pool: string, tf: Timeframe): Promise<Candle[]> {
  const raw = await redis().hgetall(key(chain, pool));
  const minutes = Object.entries(raw).map(([t, v]) => {
    const [open, high, low, close] = v.split(",").map(Number) as [number, number, number, number];
    return { time: Number(t), open, high, low, close };
  });
  return rollUp(minutes, tf);
}

/**
 * GeckoTerminal's history with our own candles laid over its newest end. Its last candle keeps its open and
 * volume and takes our high, low and close; newer ones are ours. If the two disagree on the price by a lot, the
 * chart is probably priced in the pool's other token, so ours are left out rather than mixed in.
 */
export function mergeCandles(history: Candle[], live: Candle[]): Candle[] {
  if (!live.length) return history;
  if (!history.length) return live;
  const last = history[history.length - 1]!;
  const lastLive = live[live.length - 1]!;
  if (last.close > 0 && Math.abs(lastLive.close / last.close - 1) > 0.25) return history;
  const out = history.slice();
  for (const c of live) {
    const tail = out[out.length - 1]!;
    if (c.time < tail.time) continue;
    if (c.time === tail.time) out[out.length - 1] = { ...tail, high: Math.max(tail.high, c.high), low: Math.min(tail.low, c.low), close: c.close };
    else out.push(c);
  }
  return out;
}
