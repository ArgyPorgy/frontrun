import {
  AUTO_HIDE_REPORT_COUNT,
  BODY_REJECTION_MESSAGES,
  D,
  LEADERBOARD_MIN_RESOLVED,
  NEW_ACCOUNT_HOURS,
  REPLY_MAX_LENGTH,
  VERIFIED_MIN_USD,
  averageEntry,
  checkBody,
  normalizeAddress,
  resolveOutcome,
  returnSincePost,
  thesisRankScore,
  tokenKey,
  type ChainKey,
  type Page,
  type ReplyView,
  type ThesisView,
  type TokenRef,
} from "@frontrun/core";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "./db/client";
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from "./errors";
import { logger } from "./logger";
import { getPrices, getSnapshot, rememberToken } from "./market/service";
import { notify, notifyFollowers } from "./notifications";
import { tokenBalance } from "./onchain";
import { positionEventsFor, toThesisLive } from "./position-proof";
import { refreshReputation, scoresFor } from "./reputation";
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
  const [events, scores] = await Promise.all([positionEventsFor(ids), scoresFor([...new Set(rows.map((r) => r.user.id))])]);
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
      live: toThesisLive(thesis, events.get(thesis.id) ?? []),
      authorScore: scores.get(user.id) ?? null,
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
  if (!row) return { usd: "0", qty: null as string | null, avgEntry: null as string | null, verified: false };
  let qty = D(row.qty);
  if (!isPaperMode()) {
    const wallets = await loadSigningWallets(userId);
    const owner = chain === "solana" ? wallets.solanaAddress : wallets.evmAddress;
    if (!owner) return { usd: "0", qty: null, avgEntry: null, verified: false };
    const onChain = await tokenBalance(chain, address, owner).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err, chain, address }, "balance check failed");
      return null;
    });
    // If the chain can't be read, don't award the badge on our records alone.
    if (onChain === null) return { usd: "0", qty: null, avgEntry: null, verified: false };
    qty = D(onChain).lt(qty) ? D(onChain) : qty;
  }
  const usd = qty.mul(priceUsd);
  const avgEntry = averageEntry({ qty: row.qty, costBasisUsd: row.costBasisUsd, realizedPnlUsd: row.realizedPnlUsd });
  return { usd: usd.toFixed(), qty: qty.toFixed(), avgEntry, verified: usd.gte(VERIFIED_MIN_USD) };
}

export async function createThesis(user: UserRow, input: { chain: ChainKey; address: string; body: string }, opts: { mustHold?: boolean } = {}): Promise<ThesisView> {
  const check = checkBody(input.body);
  if (!check.ok) throw badRequest(check.reason!, BODY_REJECTION_MESSAGES[check.reason!]);
  const address = normalizeAddress(input.chain, input.address);
  const snap = await getSnapshot(input.chain, address);
  if (!snap?.priceUsd) throw unprocessable("no_price", "This token has no live price, so a thesis can't be pinned to it.");

  await enforceNewAccountThrottle(user);
  await rememberToken(snap);

  const position = await positionAtPost(user.id, input.chain, address, snap.priceUsd);
  if (opts.mustHold && !position.verified) throw conflict("must_hold", "You can only post a thesis on a token you hold.");
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
      qtyAtPost: position.verified ? position.qty : null,
      heldQty: position.verified ? position.qty : null,
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

  // Every published thesis is visible in the feed. The verified badge and rank weighting still mark
  // out holders, and deleted/hidden/banned content is already filtered above, so unverified posts
  // show up (ranked lower) rather than vanishing.

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

/**
 * A thesis ends when the position it was posted on is sold out, and it's judged on the profit its author
 * realized on that position. Until then it stays open: there's no timer, and a price move alone never
 * counts. A position that left the wallet with no sale has realized nothing, so its thesis stays open too.
 */
export async function resolveClosedTheses(opts: { userId?: string; limit?: number } = {}): Promise<number> {
  const open = await db()
    .select({ id: schema.theses.id, userId: schema.theses.userId, chain: schema.theses.tokenChain, address: schema.theses.tokenAddr, openedAt: schema.positions.openedAt, closedAt: schema.positions.closedAt })
    .from(schema.theses)
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
    // A deleted thesis is still judged, since deleting one mustn't be a way out of a loss on the reputation score.
    .where(and(eq(schema.theses.outcome, "pending"), eq(schema.theses.verified, true), opts.userId ? eq(schema.theses.userId, opts.userId) : undefined))
    .limit(opts.limit ?? 100);
  for (const thesis of open) {
    const [sold] = await db()
      .select({
        pnl: sql<string | null>`sum(${schema.trades.pnlUsd})`,
        usdOut: sql<string | null>`sum(${schema.trades.usdOut})`,
        qty: sql<string | null>`sum(${schema.trades.qty})`,
      })
      .from(schema.trades)
      .where(
        and(
          eq(schema.trades.userId, thesis.userId),
          eq(schema.trades.tokenChain, thesis.chain),
          eq(schema.trades.tokenAddr, thesis.address),
          eq(schema.trades.side, "sell"),
          eq(schema.trades.status, "filled"),
          gte(schema.trades.createdAt, thesis.openedAt),
          lte(schema.trades.filledAt, thesis.closedAt!),
        ),
      );
    if (!sold?.pnl || !sold.usdOut || !sold.qty) continue;
    const cost = D(sold.usdOut).sub(sold.pnl);
    await db()
      .update(schema.theses)
      .set({
        outcome: resolveOutcome(sold.pnl),
        priceAtResolve: D(sold.usdOut).div(sold.qty).toFixed(),
        returnPct: cost.gt(0) ? D(sold.pnl).div(cost).mul(100).toNumber() : 0,
        resolvedAt: new Date(),
      })
      .where(eq(schema.theses.id, thesis.id));
  }
  // The seller's score moves with this. Everyone else's waits for the worker's pass.
  if (opts.userId && open.length) await refreshReputation({ userId: opts.userId });
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
