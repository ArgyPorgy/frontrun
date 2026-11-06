import {
  D,
  LEADERBOARD_MIN_RESOLVED,
  REPUTATION_REGISTRY_ARC,
  reputationScore,
  type ClosedPositionStats,
  type LeaderboardGroup,
  type LeaderboardRow,
  type LeaderboardVersus,
  type Reputation,
  type ReputationComponents,
  type ReputationView,
} from "@frontrun/core";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { parseAbi, type Address } from "viem";
import { isThesisSpecificFailure, relayerEnabled, relayerWrite } from "./anchoring";
import { db, schema } from "./db/client";
import { logger } from "./logger";
import { isPaperMode } from "./trading/service";
import { toSummary } from "./users";

/**
 * Turns closed positions into one score, and writes it to Arc per wallet, so any other app or contract can
 * read a trader's record without asking us.
 */
export const REPUTATION_REGISTRY_ABI = parseAbi([
  "error NotRelayer()",
  "error ZeroAddress()",
  "error ScoreOutOfRange()",
  "function attest(address wallet, uint16 score, uint16 winRateBps, int32 avgReturnBps, uint16 avgDrawdownBps, uint32 avgHoldSeconds, uint16 feeBps, uint32 closedPositions)",
  "function scoreOf(address wallet) view returns (uint16 score, uint64 attestedAt)",
]);

type ScoreRow = typeof schema.reputationScores.$inferSelect;

const MAX_ATTEMPTS = 5;
const UINT16_MAX = 65_535;
const INT32_MAX = 2_147_483_647;

function toBps(pct: number, max: number, min = 0): number {
  return Math.min(Math.max(Math.round(pct * 100), min), max);
}

export function attestArgs(wallet: string, r: Pick<ScoreRow, "score" | "winRatePct" | "avgReturnPct" | "avgDrawdownPct" | "avgHoldSeconds" | "feePct" | "closed">) {
  return [
    wallet as Address,
    r.score,
    toBps(r.winRatePct, UINT16_MAX),
    toBps(r.avgReturnPct, INT32_MAX, -INT32_MAX),
    toBps(r.avgDrawdownPct, UINT16_MAX),
    Math.min(Math.max(r.avgHoldSeconds, 0), 4_294_967_295),
    toBps(r.feePct, UINT16_MAX),
    r.closed,
  ] as const;
}

/**
 * Every closed position with a verified thesis, once each, however many theses it had. A deleted thesis still
 * counts: otherwise anyone could tidy their losers away. The earliest thesis on a position sets its start.
 */
async function closedPositions(userId?: string): Promise<Map<string, ClosedPositionStats[]>> {
  const rows = await db()
    .select({
      userId: schema.theses.userId,
      positionId: schema.positions.id,
      closedAt: schema.positions.closedAt,
      ts: schema.theses.ts,
      priceAtPost: schema.theses.priceAtPost,
      low: schema.theses.lowPriceSincePost,
      priceAtResolve: schema.theses.priceAtResolve,
      returnPct: schema.theses.returnPct,
      outcome: schema.theses.outcome,
    })
    .from(schema.theses)
    .innerJoin(schema.users, eq(schema.users.id, schema.theses.userId))
    .innerJoin(
      schema.positions,
      and(
        eq(schema.positions.userId, schema.theses.userId),
        eq(schema.positions.tokenChain, schema.theses.tokenChain),
        eq(schema.positions.tokenAddr, schema.theses.tokenAddr),
        lte(schema.positions.openedAt, schema.theses.ts),
        gt(schema.positions.closedAt, schema.theses.ts),
      ),
    )
    .where(and(eq(schema.theses.verified, true), inArray(schema.theses.outcome, ["right", "wrong"]), eq(schema.users.isBanned, false), userId ? eq(schema.theses.userId, userId) : undefined))
    .orderBy(asc(schema.theses.ts));

  const first = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!first.has(row.positionId)) first.set(row.positionId, row);
  const ids = [...first.keys()];
  const fees = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const costs = await db().execute<{ id: string; fee: string | null; volume: string | null }>(sql`
      select p.id, sum(t.fee_usd) as fee, sum(coalesce(t.usd_in, 0) + coalesce(t.usd_out, 0)) as volume
      from positions p join trades t on t.user_id = p.user_id and t.token_chain = p.token_chain and t.token_addr = p.token_addr
      where p.id in ${batch} and t.status = 'filled' and t.filled_at >= p.opened_at and t.filled_at <= p.closed_at
      group by p.id
    `);
    for (const row of costs.rows) {
      const volume = D(row.volume ?? 0);
      fees.set(row.id, volume.gt(0) ? D(row.fee ?? 0).div(volume).mul(100).toNumber() : 0);
    }
  }

  const byUser = new Map<string, ClosedPositionStats[]>();
  for (const [positionId, row] of first) {
    const posted = D(row.priceAtPost);
    // Before lows were tracked, the only prices on record are the post and the sale, so this is the least it dipped.
    const low = D(row.low ?? (row.priceAtResolve && D(row.priceAtResolve).lt(posted) ? row.priceAtResolve : posted));
    const stats: ClosedPositionStats = {
      won: row.outcome === "right",
      returnPct: row.returnPct ?? 0,
      drawdownPct: posted.gt(0) && low.lt(posted) ? posted.sub(low).div(posted).mul(100).toNumber() : 0,
      holdSeconds: Math.round((row.closedAt!.getTime() - row.ts.getTime()) / 1000),
      feePct: fees.get(positionId) ?? 0,
    };
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), stats]);
  }
  return byUser;
}

function scoreValues(r: Reputation) {
  return {
    score: r.score,
    closed: r.closed,
    wins: r.wins,
    winRatePct: r.winRatePct,
    avgReturnPct: r.avgReturnPct,
    avgDrawdownPct: r.avgDrawdownPct,
    avgHoldSeconds: Math.round(r.avgHoldSeconds),
    feePct: r.feePct,
    components: r.components,
    computedAt: new Date(),
  };
}

/** Recomputes scores. Runs after every sale for that seller, and for everyone on a timer. */
export async function refreshReputation(opts: { userId?: string } = {}): Promise<number> {
  const byUser = await closedPositions(opts.userId);
  for (const [userId, positions] of byUser) {
    const reputation = reputationScore(positions);
    if (!reputation) continue;
    const values = scoreValues(reputation);
    await db()
      .insert(schema.reputationScores)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: schema.reputationScores.userId, set: values });
  }
  return byUser.size;
}

function toReputation(row: ScoreRow): Reputation {
  return {
    score: row.score,
    provisional: row.closed < LEADERBOARD_MIN_RESOLVED,
    closed: row.closed,
    wins: row.wins,
    winRatePct: row.winRatePct,
    avgReturnPct: row.avgReturnPct,
    avgDrawdownPct: row.avgDrawdownPct,
    avgHoldSeconds: row.avgHoldSeconds,
    feePct: row.feePct,
    components: row.components as ReputationComponents,
  };
}

function toView(row: ScoreRow, wallet: string | null): ReputationView {
  return {
    ...toReputation(row),
    wallet,
    registry: REPUTATION_REGISTRY_ARC,
    attestTx: row.attestTx,
    attestedAt: row.attestedAt?.toISOString() ?? null,
    computedAt: row.computedAt.toISOString(),
  };
}

export async function reputationOf(userId: string): Promise<ReputationView | null> {
  const row = await db().query.reputationScores.findFirst({ where: eq(schema.reputationScores.userId, userId) });
  if (!row) return null;
  const wallet = await db().query.wallets.findFirst({ where: and(eq(schema.wallets.userId, userId), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)) });
  return toView(row, wallet?.address ?? null);
}

/** For any app or bot: a wallet's score, with no account needed. */
export async function reputationByWallet(wallet: string): Promise<(ReputationView & { username: string }) | null> {
  const [row] = await db()
    .select({ score: schema.reputationScores, username: schema.users.username, address: schema.wallets.address })
    .from(schema.wallets)
    .innerJoin(schema.users, eq(schema.users.id, schema.wallets.userId))
    .innerJoin(schema.reputationScores, eq(schema.reputationScores.userId, schema.wallets.userId))
    .where(and(sql`lower(${schema.wallets.address}) = ${wallet.toLowerCase()}`, eq(schema.wallets.chainType, "evm"), eq(schema.users.isBanned, false)))
    .limit(1);
  return row ? { ...toView(row.score, row.address), username: row.username } : null;
}

export async function scoresFor(userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map();
  const rows = await db().select({ userId: schema.reputationScores.userId, score: schema.reputationScores.score }).from(schema.reputationScores).where(inArray(schema.reputationScores.userId, userIds));
  return new Map(rows.map((r) => [r.userId, r.score]));
}

/**
 * Ranked by the score. Someone with too short a record comes back in `provisional` rather than being hidden,
 * so they can see where they'd stand. Realized profit is shown but never ranks: being right matters more here
 * than being big.
 */
export async function leaderboard(limit = 50): Promise<{ items: LeaderboardRow[]; provisional: LeaderboardRow[]; versus: LeaderboardVersus }> {
  const rows = await db()
    .select({ score: schema.reputationScores, user: schema.users })
    .from(schema.reputationScores)
    .innerJoin(schema.users, eq(schema.users.id, schema.reputationScores.userId))
    .where(eq(schema.users.isBanned, false))
    .orderBy(desc(schema.reputationScores.score), desc(schema.reputationScores.closed))
    .limit(limit * 2);
  const ids = rows.map((r) => r.user.id);
  const realized = ids.length
    ? await db()
        .select({ userId: schema.positions.userId, total: sql<string>`sum(${schema.positions.realizedPnlUsd})` })
        .from(schema.positions)
        .where(inArray(schema.positions.userId, ids))
        .groupBy(schema.positions.userId)
    : [];
  const pnl = new Map(realized.map((r) => [r.userId, r.total]));
  const toRow = ({ score, user }: (typeof rows)[number], index: number): LeaderboardRow => ({
    rank: index + 1,
    user: toSummary(user),
    score: score.score,
    provisional: score.closed < LEADERBOARD_MIN_RESOLVED,
    components: score.components as ReputationComponents,
    avgDrawdownPct: score.avgDrawdownPct,
    avgHoldSeconds: score.avgHoldSeconds,
    accuracy: score.winRatePct,
    resolved: score.closed,
    right: score.wins,
    avgReturnPct: score.avgReturnPct,
    realizedPnlUsd: D(pnl.get(user.id) ?? 0).toFixed(),
  });
  const ranked = rows.filter((r) => r.score.closed >= LEADERBOARD_MIN_RESOLVED).slice(0, limit).map(toRow);
  const provisional = rows.filter((r) => r.score.closed < LEADERBOARD_MIN_RESOLVED).slice(0, limit).map(toRow);
  return { items: ranked, provisional, versus: await humansVersusAgents() };
}

/** Every scored human against every scored agent, however short their records so far. */
async function humansVersusAgents(): Promise<LeaderboardVersus> {
  const rows = await db()
    .select({
      isAgent: sql<boolean>`${schema.users.agentOwnerId} is not null`,
      traders: sql<number>`count(*)::int`,
      avgScore: sql<number>`avg(${schema.reputationScores.score})::float`,
      closed: sql<number>`sum(${schema.reputationScores.closed})::int`,
      wins: sql<number>`sum(${schema.reputationScores.wins})::int`,
      avgReturnPct: sql<number>`(sum(${schema.reputationScores.avgReturnPct} * ${schema.reputationScores.closed}) / nullif(sum(${schema.reputationScores.closed}), 0))::float`,
    })
    .from(schema.reputationScores)
    .innerJoin(schema.users, eq(schema.users.id, schema.reputationScores.userId))
    .where(eq(schema.users.isBanned, false))
    .groupBy(sql`${schema.users.agentOwnerId} is not null`);
  const group = (isAgent: boolean): LeaderboardGroup | null => {
    const row = rows.find((r) => r.isAgent === isAgent);
    if (!row || !row.closed) return null;
    return { traders: row.traders, avgScore: row.avgScore, winRatePct: (row.wins / row.closed) * 100, avgReturnPct: row.avgReturnPct, closed: row.closed };
  };
  return { humans: group(false), agents: group(true) };
}

/** Worker: writes changed scores to Arc, one at a time since they share the relayer's nonce. */
export async function publishReputation(limit = 5): Promise<number> {
  if (!REPUTATION_REGISTRY_ARC || !relayerEnabled() || isPaperMode()) return 0;
  const rows = await db()
    .select({ score: schema.reputationScores, wallet: schema.wallets.address })
    .from(schema.reputationScores)
    .innerJoin(schema.wallets, and(eq(schema.wallets.userId, schema.reputationScores.userId), eq(schema.wallets.chainType, "evm"), eq(schema.wallets.isEmbedded, true)))
    .where(
      and(
        lt(schema.reputationScores.attestAttempts, MAX_ATTEMPTS),
        or(
          isNull(schema.reputationScores.attestedScore),
          sql`${schema.reputationScores.attestedScore} <> ${schema.reputationScores.score}`,
          sql`${schema.reputationScores.attestedClosed} <> ${schema.reputationScores.closed}`,
        ),
      ),
    )
    .orderBy(asc(schema.reputationScores.computedAt))
    .limit(limit);
  for (const { score, wallet } of rows) {
    try {
      const txHash = await relayerWrite({ address: REPUTATION_REGISTRY_ARC as Address, abi: REPUTATION_REGISTRY_ABI, functionName: "attest", args: attestArgs(wallet, score) });
      await db()
        .update(schema.reputationScores)
        .set({ attestedScore: score.score, attestedClosed: score.closed, attestTx: txHash, attestedAt: new Date(), attestAttempts: 0 })
        .where(eq(schema.reputationScores.userId, score.userId));
      logger.info({ userId: score.userId, score: score.score, txHash }, "reputation attested on Arc");
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 200) : String(err);
      if (!isThesisSpecificFailure(err)) {
        logger.warn({ userId: score.userId, err: message }, "reputation attesting paused until the next run");
        break;
      }
      await db().update(schema.reputationScores).set({ attestAttempts: score.attestAttempts + 1 }).where(eq(schema.reputationScores.userId, score.userId));
      logger.warn({ userId: score.userId, err: message }, "reputation attest failed");
    }
  }
  return rows.length;
}
