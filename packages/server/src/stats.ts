import { D, type ChainKey, type StatsBucket, type StatsTotals, type StatsView } from "@frontrun/core";
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db, schema } from "./db/client";
import { env } from "./env";
import { CHANNELS, publish, redis } from "./redis";

const t = schema.trades;
const CACHE_KEY = "stats:public";
/** Anyone can open the page, so a burst of visitors shouldn't turn into a burst of database queries. */
const CACHE_SECONDS = 5;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The day chart always has at least this much behind it, so a young app's chart still reads as a timeline. */
const MIN_DAYS = 30;
const MAX_DAYS = 730;
const RECENT_TRADES = 12;

const amount = sql`coalesce(case when ${t.side} = 'buy' then ${t.usdIn} else ${t.usdOut} end, 0)`;
const sumAmount = sql<string>`coalesce(sum(${amount}), 0)::text`;
const sumRevenue = sql<string>`coalesce(sum(${t.revenueUsd}), 0)::text`;
const tradeCount = sql<number>`count(*)::int`;

/** Only completed trades count. Paper trades only count on a paper copy of the app, so they never reach the real numbers. */
function completed(extra?: SQL) {
  return and(eq(t.status, "filled"), eq(t.isPaper, env().TRADING_MODE === "paper"), extra);
}

/** Lays rows out on a full timeline, so quiet hours and days show as gaps instead of disappearing. */
export function fillBuckets(rows: StatsBucket[], fromMs: number, toMs: number, stepMs: number): StatsBucket[] {
  const byTime = new Map(rows.map((r) => [new Date(r.at).getTime(), r]));
  const buckets: StatsBucket[] = [];
  for (let at = fromMs; at <= toMs; at += stepMs) {
    buckets.push(byTime.get(at) ?? { at: new Date(at).toISOString(), volumeUsd: "0", revenueUsd: "0", trades: 0 });
  }
  return buckets;
}

async function totals(extra?: SQL): Promise<StatsTotals & { firstAt: string | null }> {
  const [row] = await db()
    .select({
      volumeUsd: sumAmount,
      revenueUsd: sumRevenue,
      trades: tradeCount,
      traders: sql<number>`count(distinct ${t.userId})::int`,
      firstAt: sql<string | null>`to_char(min(${t.filledAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(t)
    .where(completed(extra));
  return row!;
}

async function buckets(format: string, extra?: SQL): Promise<StatsBucket[]> {
  const at = sql<string>`to_char(${t.filledAt} at time zone 'UTC', ${sql.raw(`'${format}'`)})`;
  return db().select({ at, volumeUsd: sumAmount, revenueUsd: sumRevenue, trades: tradeCount }).from(t).where(completed(extra)).groupBy(at);
}

async function computeStats(now: number): Promise<StatsView> {
  const hourEnd = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hourStart = hourEnd - 23 * HOUR_MS;
  const dayEnd = Math.floor(now / DAY_MS) * DAY_MS;
  const [allTime, last24h, hourlyRows, dailyRows, byChain, recent] = await Promise.all([
    totals(),
    totals(gte(t.filledAt, new Date(now - DAY_MS))),
    buckets('YYYY-MM-DD"T"HH24":00:00Z"', gte(t.filledAt, new Date(hourStart))),
    buckets('YYYY-MM-DD"T00:00:00Z"', gte(t.filledAt, new Date(dayEnd - (MAX_DAYS - 1) * DAY_MS))),
    db()
      .select({ chain: t.tokenChain, volumeUsd: sumAmount, revenueUsd: sumRevenue, trades: tradeCount })
      .from(t)
      .where(completed())
      .groupBy(t.tokenChain)
      .orderBy(sql`sum(${amount}) desc`),
    db()
      .select({
        id: t.id,
        side: t.side,
        amountUsd: sql<string>`${amount}::text`,
        filledAt: t.filledAt,
        chain: t.tokenChain,
        address: t.tokenAddr,
        symbol: schema.tokens.symbol,
        name: schema.tokens.name,
        imageUrl: schema.tokens.imageUrl,
      })
      .from(t)
      .leftJoin(schema.tokens, and(eq(schema.tokens.chain, t.tokenChain), eq(schema.tokens.address, t.tokenAddr)))
      .where(completed())
      .orderBy(desc(t.filledAt))
      .limit(RECENT_TRADES),
  ]);
  const { firstAt, ...allTimeTotals } = allTime;
  const { firstAt: _unused, ...last24hTotals } = last24h;
  const firstDay = firstAt ? Math.floor(new Date(firstAt).getTime() / DAY_MS) * DAY_MS : dayEnd;
  const dayStart = Math.max(Math.min(firstDay, dayEnd - (MIN_DAYS - 1) * DAY_MS), dayEnd - (MAX_DAYS - 1) * DAY_MS);
  return {
    updatedAt: new Date(now).toISOString(),
    firstTradeAt: firstAt,
    allTime: allTimeTotals,
    last24h: last24hTotals,
    hourly: fillBuckets(hourlyRows, hourStart, hourEnd, HOUR_MS),
    daily: fillBuckets(dailyRows, dayStart, dayEnd, DAY_MS),
    byChain: byChain.map((c) => ({ ...c, chain: c.chain as ChainKey })),
    // Who made a trade is left out on purpose: this page is public.
    recent: recent.map((r) => ({
      id: r.id,
      side: r.side,
      amountUsd: D(r.amountUsd).toFixed(),
      filledAt: r.filledAt!.toISOString(),
      token: { chain: r.chain as ChainKey, address: r.address, symbol: r.symbol ?? "?", name: r.name ?? "Unknown", imageUrl: r.imageUrl ?? null },
    })),
  };
}

export async function getPublicStats(): Promise<StatsView> {
  const cached = await redis().get(CACHE_KEY);
  if (cached) return JSON.parse(cached) as StatsView;
  const stats = await computeStats(Date.now());
  await redis().set(CACHE_KEY, JSON.stringify(stats), "EX", CACHE_SECONDS);
  return stats;
}

/** Called on every fill: the next read recomputes, and open dashboards are told to read. */
export async function statsChanged(): Promise<void> {
  await redis().del(CACHE_KEY);
  await publish(CHANNELS.stats, {});
}
