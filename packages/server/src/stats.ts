import { D, type ChainKey, type LendingStats, type PerpStats, type StatsBucket, type StatsTotals, type StatsView } from "@frontrun/core";
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

const pp = schema.perpPositions;
/** Size at open. Partial closes split a position into slices that share its open time, and together they add back up. */
const perpSize = sql`${pp.collateralUsd} * ${pp.leverage}`;
function perpsCounted(extra?: SQL) {
  return and(sql`${pp.openedAt} is not null`, sql`${pp.status} not in ('failed', 'cancelled', 'pending')`, eq(pp.isPaper, env().TRADING_MODE === "paper"), extra);
}
const perpPositions = sql<number>`count(distinct (${pp.userId}, ${pp.pairIndex}, ${pp.openedAt}))::int`;

async function perpStats(now: number): Promise<PerpStats> {
  const dayEnd = Math.floor(now / DAY_MS) * DAY_MS;
  const dayStart = dayEnd - (MIN_DAYS - 1) * DAY_MS;
  const day = sql<string>`to_char(${pp.openedAt} at time zone 'UTC', 'YYYY-MM-DD"T00:00:00Z"')`;
  const [[all], [recent], [open], markets, daily] = await Promise.all([
    db()
      .select({
        volumeUsd: sql<string>`coalesce(sum(${perpSize}), 0)::text`,
        positions: perpPositions,
        traders: sql<number>`count(distinct ${pp.userId})::int`,
        realizedPnlUsd: sql<string>`coalesce(sum(${pp.realizedPnlUsd}), 0)::text`,
      })
      .from(pp)
      .where(perpsCounted()),
    db()
      .select({ volumeUsd: sql<string>`coalesce(sum(${perpSize}), 0)::text`, positions: perpPositions })
      .from(pp)
      .where(perpsCounted(gte(pp.openedAt, new Date(now - DAY_MS)))),
    db()
      .select({
        openInterestUsd: sql<string>`coalesce(sum(${perpSize}), 0)::text`,
        longUsd: sql<string>`coalesce(sum(case when ${pp.side} = 'long' then ${perpSize} else 0 end), 0)::text`,
        positions: sql<number>`count(*)::int`,
      })
      .from(pp)
      .where(perpsCounted(sql`${pp.status} in ('open', 'closing')`)),
    db()
      .select({ symbol: pp.symbol, volumeUsd: sql<string>`coalesce(sum(${perpSize}), 0)::text`, positions: perpPositions })
      .from(pp)
      .where(perpsCounted())
      .groupBy(pp.symbol)
      .orderBy(sql`sum(${perpSize}) desc`)
      .limit(8),
    db()
      .select({ at: day, volumeUsd: sql<string>`coalesce(sum(${perpSize}), 0)::text`, positions: perpPositions })
      .from(pp)
      .where(perpsCounted(gte(pp.openedAt, new Date(dayStart))))
      .groupBy(day),
  ]);
  const byDay = new Map(daily.map((d) => [new Date(d.at).getTime(), d]));
  const days: PerpStats["daily"] = [];
  for (let at = dayStart; at <= dayEnd; at += DAY_MS) {
    const d = byDay.get(at);
    days.push({ at: new Date(at).toISOString(), volumeUsd: d ? D(d.volumeUsd).toFixed(2) : "0", positions: d?.positions ?? 0 });
  }
  const oi = D(open!.openInterestUsd);
  return {
    allTime: { volumeUsd: D(all!.volumeUsd).toFixed(2), positions: all!.positions, traders: all!.traders, realizedPnlUsd: D(all!.realizedPnlUsd).toFixed(2) },
    last24h: { volumeUsd: D(recent!.volumeUsd).toFixed(2), positions: recent!.positions },
    openInterestUsd: oi.toFixed(2),
    openPositions: open!.positions,
    longPct: oi.gt(0) ? D(open!.longUsd).div(oi).mul(100).toNumber() : null,
    markets: markets.map((m) => ({ symbol: m.symbol, volumeUsd: D(m.volumeUsd).toFixed(2), positions: m.positions })),
    daily: days,
  };
}

const la = schema.lendingActions;
const signed = (plus: string, minus: string) => sql<string>`coalesce(sum(case when ${la.action} = ${plus} then ${la.amount} when ${la.action} = ${minus} then -${la.amount} else 0 end), 0)::text`;

async function lendingStats(): Promise<LendingStats> {
  const done = eq(la.status, "done");
  const [[all], markets] = await Promise.all([
    db().select({ moves: sql<number>`count(*)::int`, users: sql<number>`count(distinct ${la.userId})::int` }).from(la).where(done),
    db()
      .select({ name: la.marketName, venue: la.venue, supplied: signed("supply", "withdraw"), borrowed: signed("borrow", "repay"), moves: sql<number>`count(*)::int` })
      .from(la)
      .where(done)
      .groupBy(la.marketName, la.venue)
      .orderBy(sql`count(*) desc`),
  ]);
  // A full withdrawal includes the interest earned, so a market can net below zero. That shows as nothing left, not a negative.
  const rows = markets.map((m) => ({ name: m.name, venue: m.venue, netSuppliedUsd: (D(m.supplied).gt(0) ? D(m.supplied) : D(0)).toFixed(2), netBorrowedUsd: (D(m.borrowed).gt(0) ? D(m.borrowed) : D(0)).toFixed(2), moves: m.moves }));
  return {
    netSuppliedUsd: rows.reduce((a, m) => a.add(m.netSuppliedUsd), D(0)).toFixed(2),
    netBorrowedUsd: rows.reduce((a, m) => a.add(m.netBorrowedUsd), D(0)).toFixed(2),
    moves: all!.moves,
    users: all!.users,
    markets: rows,
  };
}

async function agentStats(): Promise<StatsView["agents"]> {
  const isAgent = sql`exists (select 1 from users u where u.id = user_id and u.agent_owner_id is not null)`;
  const [[spot], [perps], [lending], [traders]] = await Promise.all([
    db().select({ n: sql<number>`count(*)::int` }).from(t).where(completed(isAgent)),
    db().select({ n: perpPositions }).from(pp).where(perpsCounted(isAgent)),
    db().select({ n: sql<number>`count(*)::int` }).from(la).where(and(eq(la.status, "done"), isAgent)),
    db().execute<{ n: number }>(sql`
      select count(distinct user_id)::int as n from (
        select user_id from trades where status = 'filled' union
        select user_id from perp_positions where opened_at is not null union
        select user_id from lending_actions where status = 'done'
      ) a join users u on u.id = a.user_id where u.agent_owner_id is not null
    `).then((r) => r.rows),
  ]);
  return { traders: traders?.n ?? 0, spotTrades: spot!.n, perpsOpened: perps!.n, lendingMoves: lending!.n };
}

async function computeStats(now: number): Promise<StatsView> {
  const hourEnd = Math.floor(now / HOUR_MS) * HOUR_MS;
  const hourStart = hourEnd - 23 * HOUR_MS;
  const dayEnd = Math.floor(now / DAY_MS) * DAY_MS;
  const [allTime, last24h, hourlyRows, dailyRows, byChain, recent, perps, lending, agents] = await Promise.all([
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
    perpStats(now),
    lendingStats(),
    agentStats(),
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
    perps,
    lending,
    agents,
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
