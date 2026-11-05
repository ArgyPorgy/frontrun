import {
  AUTO_HIDE_REPORT_COUNT,
  BODY_REJECTION_MESSAGES,
  D,
  LEADERBOARD_MIN_RESOLVED,
  NEW_ACCOUNT_HOURS,
  REPLY_MAX_LENGTH,
  THESIS_RESOLVE_HOURS,
  VERIFIED_MIN_USD,
  averageEntry,
  checkBody,
  normalizeAddress,
  resolveOutcome,
  returnSincePost,
  thesisRankScore,
  tokenKey,
  type ChainKey,
  type LeaderboardRow,
  type Page,
  type ReplyView,
  type ThesisView,
  type TokenRef,
} from "@frontrun/core";
import { and, asc, desc, eq, gte, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "./db/client";
import { AppError, badRequest, forbidden, notFound, unprocessable } from "./errors";
import { logger } from "./logger";
import { getPrices, getSnapshot, rememberToken } from "./market/service";
import { notify, notifyFollowers } from "./notifications";
import { tokenBalance } from "./onchain";
import { CHANNELS, publish, redis } from "./redis";
import { isPaperMode, tokenRefFor } from "./trading/service";
import { loadSigningWallets } from "./trading/signer";
import { toSummary, type UserRow } from "./users";

type ThesisRow = typeof schema.theses.$inferSelect;

async function viewerHidden(viewerId: string | null): Promise<string[]> {
  if (!viewerId) return [];
  const rows = await db()
    .select({ a: schema.blocks.blockerId, b: schema.blocks.blockedId })
    .from(schema.blocks)
    .where(or(eq(schema.blocks.blockerId, viewerId), eq(schema.blocks.blockedId, viewerId)));
  return rows.map((r) => (r.a === viewerId ? r.b : r.a));
}

async function toViews(rows: Array<{ thesis: ThesisRow; user: UserRow }>, viewerId: string | null): Promise<ThesisView[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.thesis.id);
  const liked = viewerId
    ? new Set(
        (
          await db()
            .select({ id: schema.likes.thesisId })
            .from(schema.likes)
            .where(and(eq(schema.likes.userId, viewerId), inArray(schema.likes.thesisId, ids)))
        ).map((l) => l.id),
      )
    : new Set<string>();
  const keys = [...new Set(rows.map((r) => tokenKey(r.thesis.tokenChain as ChainKey, r.thesis.tokenAddr)))];
  const prices = await getPrices(keys);
  const refs = new Map<string, TokenRef>();
  await Promise.all(
    keys.map(async (key) => {
      const [chain, address] = key.split(":") as [string, string];
      refs.set(key, await tokenRefFor(chain, address));
    }),
  );
  return rows.map(({ thesis, user }) => {
    const key = tokenKey(thesis.tokenChain as ChainKey, thesis.tokenAddr);
    const current = prices.get(key) ?? null;
    return {
      id: thesis.id,
      author: toSummary(user),
      token: refs.get(key)!,
      body: thesis.body,
      priceAtPost: D(thesis.priceAtPost).toFixed(),
      ts: thesis.ts.toISOString(),
      positionUsdAtPost: D(thesis.positionUsdAtPost).toFixed(),
      authorAvgEntry: thesis.authorAvgEntry ? D(thesis.authorAvgEntry).toFixed() : null,
      verified: thesis.verified,
      likeCount: thesis.likeCount,
      replyCount: thesis.replyCount,
      likedByMe: liked.has(thesis.id),
      outcome: thesis.outcome,
      // Resolved theses keep the return they were judged on. Open ones track the live price.
      returnPct: thesis.returnPct ?? (current ? returnSincePost(thesis.priceAtPost, current) : null),
      currentPriceUsd: current,
      anchor:
        thesis.anchorTx && thesis.anchorHash && thesis.anchoredAt
          ? { hash: thesis.anchorHash, txHash: thesis.anchorTx, anchoredAt: thesis.anchoredAt.toISOString() }
          : null,
    };
  });
}

/**
 * The verified badge means the author holds the token at post time, by our trade records AND the
 * chain. Taking the smaller of the two means a transferred-away position can't claim the badge, and
 * neither can tokens that were never bought here.
 */
async function positionAtPost(userId: string, chain: ChainKey, address: string, priceUsd: string) {
  const row = await db().query.positions.findFirst({
    where: and(eq(schema.positions.userId, userId), eq(schema.positions.tokenChain, chain), eq(schema.positions.tokenAddr, address), isNull(schema.positions.closedAt)),
  });
  if (!row) return { usd: "0", avgEntry: null as string | null, verified: false };
  let qty = D(row.qty);
  if (!isPaperMode()) {
    const wallets = await loadSigningWallets(userId);
    const owner = chain === "solana" ? wallets.solanaAddress : wallets.evmAddress;
    if (!owner) return { usd: "0", avgEntry: null, verified: false };
    const onChain = await tokenBalance(chain, address, owner).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err, chain, address }, "balance check failed");
      return null;
    });
    // If the chain can't be read, don't award the badge on our records alone.
    if (onChain === null) return { usd: "0", avgEntry: null, verified: false };
    qty = D(onChain).lt(qty) ? D(onChain) : qty;
  }
  const usd = qty.mul(priceUsd);
  const avgEntry = averageEntry({ qty: row.qty, costBasisUsd: row.costBasisUsd, realizedPnlUsd: row.realizedPnlUsd });
  return { usd: usd.toFixed(), avgEntry, verified: usd.gte(VERIFIED_MIN_USD) };
}

export async function createThesis(user: UserRow, input: { chain: ChainKey; address: string; body: string }): Promise<ThesisView> {
  const check = checkBody(input.body);
  if (!check.ok) throw badRequest(check.reason!, BODY_REJECTION_MESSAGES[check.reason!]);
  const address = normalizeAddress(input.chain, input.address);
  const snap = await getSnapshot(input.chain, address);
  if (!snap?.priceUsd) throw unprocessable("no_price", "This token has no live price, so a thesis can't be pinned to it.");

  await enforceNewAccountThrottle(user);
  await rememberToken(snap);

  const position = await positionAtPost(user.id, input.chain, address, snap.priceUsd);
  const now = new Date();
  const [thesis] = await db()
    .insert(schema.theses)
    .values({
      userId: user.id,
      tokenChain: input.chain,
      tokenAddr: address,
      body: check.body,
      priceAtPost: snap.priceUsd,
      ts: now,
      positionUsdAtPost: position.usd,
      authorAvgEntry: position.avgEntry,
      verified: position.verified,
      rankScore: thesisRankScore({ likeCount: 0, replyCount: 0, positionUsd: position.usd, verified: position.verified, ageHours: 0 }),
    })
    .returning();
  const [view] = await toViews([{ thesis: thesis!, user }], user.id);

  await publish(CHANNELS.theses, { type: "thesis", thesis: view });
  notifyFollowers(user.id, {
    type: "thesis_posted",
    actorId: user.id,
    thesisId: thesis!.id,
    tokenChain: input.chain,
    tokenAddr: address,
    message: `${user.username} posted a thesis on ${snap.symbol}`,
  }).catch((err) => logger.warn({ err: err instanceof Error ? err.message : err }, "follower fan-out failed"));
  return view!;
}

/** Posting stays unlimited for established accounts. New ones are throttled to slow spam. */
async function enforceNewAccountThrottle(user: UserRow) {
  const ageHours = (Date.now() - user.createdAt.getTime()) / 3_600_000;
  if (ageHours >= NEW_ACCOUNT_HOURS) return;
  const key = `throttle:thesis:${user.id}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, 3600);
  if (count > 5) throw new AppError(429, "new_account_throttled", "New accounts can post 5 theses an hour. Try again soon.");
}

export async function deleteThesis(userId: string, id: string) {
  const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, id) });
  if (!thesis || thesis.deletedAt) throw notFound("Thesis");
  if (thesis.userId !== userId) throw forbidden();
  await db().update(schema.theses).set({ deletedAt: new Date() }).where(eq(schema.theses.id, id));
}

export interface ListThesesInput {
  tab: "top" | "recent" | "following";
  chain?: ChainKey;
  address?: string;
  username?: string;
  minPosition?: number;
  sort?: "liked" | "recent";
  includeUnverified?: boolean;
  cursor?: string;
  limit: number;
}

export async function listTheses(input: ListThesesInput, viewerId: string | null): Promise<Page<ThesisView>> {
  const hiddenAuthors = await viewerHidden(viewerId);
  const conditions: SQL[] = [isNull(schema.theses.deletedAt), isNull(schema.theses.hiddenAt), eq(schema.users.isBanned, false)];
  if (input.chain) conditions.push(eq(schema.theses.tokenChain, input.chain));
  if (input.address && input.chain) conditions.push(eq(schema.theses.tokenAddr, normalizeAddress(input.chain, input.address)));
  if (input.minPosition) conditions.push(gte(schema.theses.positionUsdAtPost, String(input.minPosition)));
  if (hiddenAuthors.length) conditions.push(notInArray(schema.theses.userId, hiddenAuthors));
  if (input.username) conditions.push(sql`lower(${schema.users.username}) = ${input.username.toLowerCase()}`);

  // Feeds default to verified holders. Profiles and an explicit opt-in show everything.
  if (!input.includeUnverified && !input.username) conditions.push(eq(schema.theses.verified, true));

  if (input.tab === "following") {
    if (!viewerId) return { items: [], nextCursor: null };
    const followed = db().select({ id: schema.follows.followeeId }).from(schema.follows).where(eq(schema.follows.followerId, viewerId));
    conditions.push(inArray(schema.theses.userId, followed));
  }

  const byRecent = input.sort === "recent" || input.tab === "recent" || input.tab === "following" || !!input.username;
  const byLiked = input.sort === "liked";
  const offset = input.cursor && !byRecent ? Number(input.cursor) || 0 : 0;

  if (byRecent && !byLiked && input.cursor) {
    const [ts, id] = input.cursor.split("|");
    if (ts && id) {
      conditions.push(or(lt(schema.theses.ts, new Date(ts)), and(eq(schema.theses.ts, new Date(ts)), lt(schema.theses.id, id)))!);
    }
  }

  const query = db()
    .select({ thesis: schema.theses, user: schema.users })
    .from(schema.theses)
    .innerJoin(schema.users, eq(schema.theses.userId, schema.users.id))
    .where(and(...conditions))
    .limit(input.limit + 1);
  const rows = await (byLiked
    ? query.orderBy(desc(schema.theses.likeCount), desc(schema.theses.ts)).offset(offset)
    : byRecent
      ? query.orderBy(desc(schema.theses.ts), desc(schema.theses.id))
      : query.orderBy(desc(schema.theses.rankScore), desc(schema.theses.ts)).offset(offset));

  const page = rows.slice(0, input.limit);
  const items = await toViews(page, viewerId);
  let nextCursor: string | null = null;
  if (rows.length > input.limit) {
    if (byRecent && !byLiked) {
      const last = page[page.length - 1]!.thesis;
      nextCursor = `${last.ts.toISOString()}|${last.id}`;
    } else {
      nextCursor = String(offset + input.limit);
    }
  }
  return { items, nextCursor };
}

/** Every thesis pin for a token, for chart avatars. Not capped by the verified-only feed default. */
export async function thesisPins(chain: ChainKey, address: string, viewerId: string | null): Promise<ThesisView[]> {
  const { items } = await listTheses(
    { tab: "recent", chain, address, includeUnverified: true, limit: 50 },
    viewerId,
  );
  return items;
}

export async function getThesis(id: string, viewerId: string | null): Promise<ThesisView> {
  const [row] = await db()
    .select({ thesis: schema.theses, user: schema.users })
    .from(schema.theses)
    .innerJoin(schema.users, eq(schema.theses.userId, schema.users.id))
    .where(and(eq(schema.theses.id, id), isNull(schema.theses.deletedAt), isNull(schema.theses.hiddenAt)));
  if (!row) throw notFound("Thesis");
  const [view] = await toViews([row], viewerId);
  return view!;
}

async function refreshRank(thesisId: string) {
  const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, thesisId) });
  if (!thesis) return;
  await db()
    .update(schema.theses)
    .set({
      rankScore: thesisRankScore({
        likeCount: thesis.likeCount,
        replyCount: thesis.replyCount,
        positionUsd: thesis.positionUsdAtPost,
        verified: thesis.verified,
        ageHours: (Date.now() - thesis.ts.getTime()) / 3_600_000,
      }),
    })
    .where(eq(schema.theses.id, thesisId));
}

export async function likeThesis(user: UserRow, thesisId: string) {
  const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, thesisId) });
  if (!thesis || thesis.deletedAt || thesis.hiddenAt) throw notFound("Thesis");
  const [inserted] = await db().insert(schema.likes).values({ userId: user.id, thesisId }).onConflictDoNothing().returning();
  if (!inserted) return;
  await db().update(schema.theses).set({ likeCount: sql`${schema.theses.likeCount} + 1` }).where(eq(schema.theses.id, thesisId));
  await refreshRank(thesisId);
  if (thesis.userId !== user.id) {
    await notify(thesis.userId, {
      type: "thesis_liked",
      actorId: user.id,
      thesisId,
      tokenChain: thesis.tokenChain,
      tokenAddr: thesis.tokenAddr,
      message: `${user.username} liked your thesis`,
    });
  }
}

export async function unlikeThesis(userId: string, thesisId: string) {
  const removed = await db()
    .delete(schema.likes)
    .where(and(eq(schema.likes.userId, userId), eq(schema.likes.thesisId, thesisId)))
    .returning();
  if (!removed.length) return;
  await db().update(schema.theses).set({ likeCount: sql`greatest(${schema.theses.likeCount} - 1, 0)` }).where(eq(schema.theses.id, thesisId));
  await refreshRank(thesisId);
}

export async function createReply(user: UserRow, thesisId: string, body: string): Promise<ReplyView> {
  const check = checkBody(body, REPLY_MAX_LENGTH);
  if (!check.ok) throw badRequest(check.reason!, BODY_REJECTION_MESSAGES[check.reason!]);
  const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, thesisId) });
  if (!thesis || thesis.deletedAt || thesis.hiddenAt) throw notFound("Thesis");
  const blocked = await db().query.blocks.findFirst({
    where: and(eq(schema.blocks.blockerId, thesis.userId), eq(schema.blocks.blockedId, user.id)),
  });
  if (blocked) throw forbidden("You can't reply to this account.");
  const [reply] = await db().insert(schema.thesisReplies).values({ thesisId, userId: user.id, body: check.body }).returning();
  await db().update(schema.theses).set({ replyCount: sql`${schema.theses.replyCount} + 1` }).where(eq(schema.theses.id, thesisId));
  await refreshRank(thesisId);
  if (thesis.userId !== user.id) {
    await notify(thesis.userId, {
      type: "thesis_replied",
      actorId: user.id,
      thesisId,
      tokenChain: thesis.tokenChain,
      tokenAddr: thesis.tokenAddr,
      message: `${user.username} replied to your thesis`,
    });
  }
  return { id: reply!.id, thesisId, author: toSummary(user), body: reply!.body, createdAt: reply!.createdAt.toISOString() };
}

export async function deleteReply(userId: string, thesisId: string, replyId: string) {
  const reply = await db().query.thesisReplies.findFirst({ where: eq(schema.thesisReplies.id, replyId) });
  if (!reply || reply.thesisId !== thesisId || reply.deletedAt) throw notFound("Reply");
  if (reply.userId !== userId) throw forbidden();
  await db().update(schema.thesisReplies).set({ deletedAt: new Date() }).where(eq(schema.thesisReplies.id, replyId));
  await db().update(schema.theses).set({ replyCount: sql`greatest(${schema.theses.replyCount} - 1, 0)` }).where(eq(schema.theses.id, thesisId));
}

export async function listReplies(thesisId: string, viewerId: string | null): Promise<ReplyView[]> {
  const hidden = await viewerHidden(viewerId);
  const rows = await db()
    .select({ reply: schema.thesisReplies, user: schema.users })
    .from(schema.thesisReplies)
    .innerJoin(schema.users, eq(schema.thesisReplies.userId, schema.users.id))
    .where(
      and(
        eq(schema.thesisReplies.thesisId, thesisId),
        isNull(schema.thesisReplies.deletedAt),
        hidden.length ? notInArray(schema.thesisReplies.userId, hidden) : undefined,
      ),
    )
    .orderBy(asc(schema.thesisReplies.createdAt))
    .limit(200);
  return rows.map(({ reply, user }) => ({
    id: reply.id,
    thesisId,
    author: toSummary(user),
    body: reply.body,
    createdAt: reply.createdAt.toISOString(),
  }));
}

export async function report(
  reporterId: string,
  input: { thesisId?: string; targetUserId?: string; reason: string; note?: string },
) {
  await db()
    .insert(schema.reports)
    .values({ reporterId, thesisId: input.thesisId ?? null, targetUserId: input.targetUserId ?? null, reason: input.reason, note: input.note ?? null })
    .onConflictDoNothing();
  if (!input.thesisId) return;
  const [row] = await db()
    .select({ count: sql<number>`count(distinct ${schema.reports.reporterId})::int` })
    .from(schema.reports)
    .where(eq(schema.reports.thesisId, input.thesisId));
  if ((row?.count ?? 0) >= AUTO_HIDE_REPORT_COUNT) {
    // Pulled until a moderator reviews it, so a coordinated scam can't stay up while reports pile in.
    await db().update(schema.theses).set({ hiddenAt: new Date() }).where(and(eq(schema.theses.id, input.thesisId), isNull(schema.theses.hiddenAt)));
    logger.info({ thesisId: input.thesisId }, "thesis auto-hidden by reports");
  }
}

/** Accuracy is the headline, not PnL: being right matters more here than being big. */
export async function leaderboard(limit = 50): Promise<LeaderboardRow[]> {
  const realized = db()
    .select({
      userId: schema.positions.userId,
      total: sql<string>`sum(${schema.positions.realizedPnlUsd})`.as("total"),
    })
    .from(schema.positions)
    .groupBy(schema.positions.userId)
    .as("realized");
  const rows = await db()
    .select({
      user: schema.users,
      resolved: sql<number>`count(*)::int`,
      right: sql<number>`count(*) filter (where ${schema.theses.outcome} = 'right')::int`,
      avgReturn: sql<number>`coalesce(avg(${schema.theses.returnPct}), 0)::float`,
      realized: sql<string>`coalesce(max(${realized.total}), 0)`,
    })
    .from(schema.theses)
    .innerJoin(schema.users, eq(schema.theses.userId, schema.users.id))
    .leftJoin(realized, eq(realized.userId, schema.users.id))
    .where(
      and(
        isNull(schema.theses.deletedAt),
        isNull(schema.theses.hiddenAt),
        eq(schema.theses.verified, true),
        inArray(schema.theses.outcome, ["right", "wrong"]),
        eq(schema.users.isBanned, false),
      ),
    )
    .groupBy(schema.users.id)
    .having(sql`count(*) >= ${LEADERBOARD_MIN_RESOLVED}`)
    .orderBy(sql`count(*) filter (where ${schema.theses.outcome} = 'right')::float / count(*) desc`, sql`count(*) desc`)
    .limit(limit);
  return rows.map((row, i) => ({
    rank: i + 1,
    user: toSummary(row.user),
    accuracy: (row.right / row.resolved) * 100,
    resolved: row.resolved,
    right: row.right,
    avgReturnPct: row.avgReturn,
    realizedPnlUsd: D(row.realized).toFixed(),
  }));
}

/** Worker: judges theses that have reached their resolve time. */
export async function resolveDueTheses(limit = 100): Promise<number> {
  const cutoff = new Date(Date.now() - THESIS_RESOLVE_HOURS * 3_600_000);
  const due = await db()
    .select()
    .from(schema.theses)
    .where(and(eq(schema.theses.outcome, "pending"), isNull(schema.theses.deletedAt), lt(schema.theses.ts, cutoff)))
    .orderBy(asc(schema.theses.ts))
    .limit(limit);
  for (const thesis of due) {
    const snap = await getSnapshot(thesis.tokenChain as ChainKey, thesis.tokenAddr).catch(() => null);
    if (!snap?.priceUsd) continue;
    await db()
      .update(schema.theses)
      .set({
        outcome: resolveOutcome(thesis.priceAtPost, snap.priceUsd),
        priceAtResolve: snap.priceUsd,
        returnPct: returnSincePost(thesis.priceAtPost, snap.priceUsd),
        resolvedAt: new Date(),
      })
      .where(eq(schema.theses.id, thesis.id));
  }
  return due.length;
}

/**
 * A thesis also ends when its author sells out, at the price they got. It's what they actually did with
 * the call, and it means a closed trade never leaves a thesis showing as open. This finds them from the
 * positions, so it also catches a position that closed outside the app.
 */
export async function resolveClosedTheses(opts: { userId?: string; limit?: number } = {}): Promise<number> {
  const open = await db()
    .select()
    .from(schema.theses)
    .where(
      and(
        eq(schema.theses.outcome, "pending"),
        eq(schema.theses.verified, true),
        isNull(schema.theses.deletedAt),
        opts.userId ? eq(schema.theses.userId, opts.userId) : undefined,
        sql`not exists (
          select 1 from positions p
          where p.user_id = ${schema.theses.userId} and p.token_chain = ${schema.theses.tokenChain}
            and p.token_addr = ${schema.theses.tokenAddr} and p.closed_at is null
        )`,
      ),
    )
    .limit(opts.limit ?? 100);
  for (const thesis of open) {
    const sale = await db().query.trades.findFirst({
      where: and(
        eq(schema.trades.userId, thesis.userId),
        eq(schema.trades.tokenChain, thesis.tokenChain),
        eq(schema.trades.tokenAddr, thesis.tokenAddr),
        eq(schema.trades.side, "sell"),
        eq(schema.trades.status, "filled"),
      ),
      orderBy: desc(schema.trades.filledAt),
    });
    const price = sale?.priceUsd ?? (await getSnapshot(thesis.tokenChain as ChainKey, thesis.tokenAddr).catch(() => null))?.priceUsd;
    if (!price) continue;
    await db()
      .update(schema.theses)
      .set({
        outcome: resolveOutcome(thesis.priceAtPost, price),
        priceAtResolve: price,
        returnPct: returnSincePost(thesis.priceAtPost, price),
        resolvedAt: new Date(),
      })
      .where(eq(schema.theses.id, thesis.id));
  }
  return open.length;
}

/** Worker: keeps rank scores decaying, for theses recent enough to still be ranking. */
export async function refreshRankScores() {
  await db().execute(sql`
    update theses set rank_score = (
      (case when verified then 3 else 0 end)
      + log(1 + greatest(position_usd_at_post, 0))
      + log(2, 1 + like_count + reply_count * 2)
    ) / power(extract(epoch from now() - ts) / 3600 + 2, 1.2)
    where deleted_at is null and ts > now() - interval '14 days'
  `);
}
