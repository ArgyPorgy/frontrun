import { createHash, randomBytes } from "node:crypto";
import {
  CAP_DEFAULTS,
  D,
  PAPER_STARTING_BALANCE_USD,
  accuracyPct,
  averageEntry,
  portfolioTotals,
  returnPct,
  tokenKey,
  unrealizedPnl,
  winRate,
  type ChainKey,
  type MeView,
  type OnboardingStep,
  type PortfolioView,
  type PositionView,
  type ProfileView,
  type TraderResult,
  type UserSummary,
  type WalletView,
} from "@frontrun/core";
import { and, desc, eq, inArray, isNotNull, isNull, sql, or } from "drizzle-orm";
import { db, schema } from "./db/client";
import { env } from "./env";
import { conflict, notFound } from "./errors";
import { getPricesFilled } from "./market/service";
import { fetchPrivyWallets, serverSigningConfigured } from "./trading/signer";
import { isPaperMode, signerStatus, tokenRefFor, usdcBalance } from "./trading/service";

export type UserRow = typeof schema.users.$inferSelect;

export function toSummary(user: Pick<UserRow, "id" | "username" | "avatarUrl">): UserSummary {
  return { id: user.id, username: user.username, avatarUrl: user.avatarUrl };
}

function placeholderUsername(): string {
  return `user_${randomBytes(5).toString("hex")}`;
}

/** Finds the account for an identity, creating it on first sight. */
export async function ensureUser(privyId: string): Promise<UserRow> {
  const found = await db().query.users.findFirst({ where: eq(schema.users.privyId, privyId) });
  if (found) return found;
  const [created] = await db()
    .insert(schema.users)
    .values({ privyId, username: placeholderUsername() })
    .onConflictDoNothing({ target: schema.users.privyId })
    .returning();
  if (created) return created;
  const raced = await db().query.users.findFirst({ where: eq(schema.users.privyId, privyId) });
  if (!raced) throw new Error("Failed to create the account.");
  return raced;
}

/** Stand-in wallets for dev auth. Deterministic but not real keys: they can only paper trade. */
export async function ensureDevWallets(user: UserRow) {
  const existing = await db().select().from(schema.wallets).where(eq(schema.wallets.userId, user.id));
  if (existing.length >= 2) return;
  const hash = createHash("sha256").update(user.privyId).digest("hex");
  const evm = `0x${hash.slice(0, 40)}`;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const sol = Array.from({ length: 44 }, (_, i) => alphabet[parseInt(hash.slice(i % 60, (i % 60) + 2), 16) % alphabet.length]).join("");
  await db()
    .insert(schema.wallets)
    .values([
      { userId: user.id, chainType: "evm", address: evm, isEmbedded: true },
      { userId: user.id, chainType: "solana", address: sol, isEmbedded: true },
    ])
    .onConflictDoNothing();
}

/** Copies the user's wallets from Privy. Addresses and wallet ids are never taken from the client. */
export async function syncWalletsFromPrivy(user: UserRow): Promise<{ delegated: boolean }> {
  const wallets = await fetchPrivyWallets(user.privyId);
  for (const w of wallets) {
    await db()
      .insert(schema.wallets)
      .values({ userId: user.id, chainType: w.chainType, address: w.address, isEmbedded: w.isEmbedded, privyWalletId: w.privyWalletId })
      .onConflictDoUpdate({
        target: [schema.wallets.chainType, schema.wallets.address],
        set: { userId: user.id, isEmbedded: w.isEmbedded, privyWalletId: w.privyWalletId },
      });
  }
  return { delegated: wallets.some((w) => w.chainType === "evm" && w.isEmbedded && w.delegated) };
}

async function followCounts(userId: string) {
  const [followers] = await db().select({ c: sql<number>`count(*)::int` }).from(schema.follows).where(eq(schema.follows.followeeId, userId));
  const [following] = await db().select({ c: sql<number>`count(*)::int` }).from(schema.follows).where(eq(schema.follows.followerId, userId));
  return { followers: followers?.c ?? 0, following: following?.c ?? 0 };
}

export async function buildMe(user: UserRow): Promise<MeView> {
  const walletRows = await db().select().from(schema.wallets).where(eq(schema.wallets.userId, user.id));
  const wallets: WalletView[] = walletRows.map((w) => ({ chainType: w.chainType, address: w.address, isEmbedded: w.isEmbedded }));
  const signer = await signerStatus(user.id);
  const counts = await followCounts(user.id);
  const balance = walletRows.length ? await usdcBalance(user.id).catch(() => ({ usdc: "0", spendable: "0", withdrawable: "0" })) : { usdc: "0", spendable: "0" };
  const [traded] = await db().select({ c: sql<number>`count(*)::int` }).from(schema.trades).where(eq(schema.trades.userId, user.id));
  let onboarding: OnboardingStep = "done";
  if (!user.usernameSet) onboarding = "profile";
  else if (D(balance.usdc).lte(0) && !traded?.c) onboarding = "deposit";
  // The Flash approval isn't part of this: the first trade that needs it sends it.
  else if (!signer.active) onboarding = "enable_one_tap";
  return {
    ...toSummary(user),
    createdAt: user.createdAt.toISOString(),
    wallets,
    onboarding,
    signer,
    ...counts,
    paperBalanceUsd: isPaperMode() ? D(user.paperBalanceUsd).toFixed() : null,
  };
}

export async function updateProfile(user: UserRow, patch: { username?: string; avatarUrl?: string | null }): Promise<UserRow> {
  if (patch.username && patch.username.toLowerCase() !== user.username.toLowerCase()) {
    const taken = await db().query.users.findFirst({ where: sql`lower(${schema.users.username}) = ${patch.username.toLowerCase()}` });
    if (taken) throw conflict("username_taken", "That username is taken.");
  }
  const [updated] = await db()
    .update(schema.users)
    .set({
      ...(patch.username ? { username: patch.username, usernameSet: true } : {}),
      ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
    })
    .where(eq(schema.users.id, user.id))
    .returning();
  return updated!;
}

export async function findByUsername(username: string): Promise<UserRow | undefined> {
  return db().query.users.findFirst({ where: sql`lower(${schema.users.username}) = ${username.toLowerCase()}` });
}

/**
 * Finds trader profiles by username for the search bar, each with the headline activity that makes it
 * a real preview — filled trades, theses, followers, thesis accuracy and realized PnL. Case-insensitive
 * substring match over real (username-set), non-banned accounts; exact and prefix matches rank first.
 * Stats come from a handful of grouped aggregates over the matched ids, so there's no per-row fan-out.
 */
export async function searchUsers(query: string, limit = 8): Promise<TraderResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  // Escape LIKE wildcards in the user's text so "%" or "_" can't widen the match.
  const term = q.replace(/[\\%_]/g, "\\$&");
  const matched = await db()
    .select({ id: schema.users.id, username: schema.users.username, avatarUrl: schema.users.avatarUrl })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.isBanned, false),
        eq(schema.users.usernameSet, true),
        sql`lower(${schema.users.username}) like lower(${`%${term}%`})`,
      ),
    )
    .orderBy(
      sql`case when lower(${schema.users.username}) = lower(${q}) then 0 when lower(${schema.users.username}) like lower(${`${term}%`}) then 1 else 2 end`,
      sql`length(${schema.users.username})`,
    )
    .limit(limit);
  if (!matched.length) return [];

  const ids = matched.map((u) => u.id);
  const [tradeRows, thesisRows, followerRows, pnlRows] = await Promise.all([
    db()
      .select({ userId: schema.trades.userId, n: sql<number>`count(*) filter (where ${schema.trades.status} = 'filled')::int` })
      .from(schema.trades)
      .where(inArray(schema.trades.userId, ids))
      .groupBy(schema.trades.userId),
    db()
      .select({
        userId: schema.theses.userId,
        n: sql<number>`count(*)::int`,
        right: sql<number>`count(*) filter (where ${schema.theses.outcome} = 'right')::int`,
        resolved: sql<number>`count(*) filter (where ${schema.theses.outcome} <> 'pending')::int`,
      })
      .from(schema.theses)
      .where(and(inArray(schema.theses.userId, ids), isNull(schema.theses.deletedAt)))
      .groupBy(schema.theses.userId),
    db()
      .select({ followeeId: schema.follows.followeeId, n: sql<number>`count(*)::int` })
      .from(schema.follows)
      .where(inArray(schema.follows.followeeId, ids))
      .groupBy(schema.follows.followeeId),
    db()
      .select({ userId: schema.positions.userId, pnl: sql<string>`coalesce(sum(${schema.positions.realizedPnlUsd}), 0)` })
      .from(schema.positions)
      .where(inArray(schema.positions.userId, ids))
      .groupBy(schema.positions.userId),
  ]);

  const trades = new Map(tradeRows.map((r) => [r.userId, r.n]));
  const theses = new Map(thesisRows.map((r) => [r.userId, r]));
  const followers = new Map(followerRows.map((r) => [r.followeeId, r.n]));
  const pnl = new Map(pnlRows.map((r) => [r.userId, r.pnl]));

  return matched.map((u) => {
    const t = theses.get(u.id);
    return {
      ...toSummary(u),
      trades: trades.get(u.id) ?? 0,
      theses: t?.n ?? 0,
      followers: followers.get(u.id) ?? 0,
      accuracy: accuracyPct(t?.right ?? 0, t?.resolved ?? 0),
      realizedPnlUsd: D(pnl.get(u.id) ?? "0").toFixed(),
    };
  });
}

async function positionToView(row: typeof schema.positions.$inferSelect, price: string | null): Promise<PositionView> {
  const token = await tokenRefFor(row.tokenChain, row.tokenAddr);
  const state = { qty: row.qty, costBasisUsd: row.costBasisUsd, realizedPnlUsd: row.realizedPnlUsd };
  const open = !row.closedAt;
  return {
    id: row.id,
    token,
    qty: D(row.qty).toFixed(),
    costBasisUsd: D(row.costBasisUsd).toFixed(),
    avgEntryUsd: averageEntry(state),
    realizedPnlUsd: D(row.realizedPnlUsd).toFixed(),
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    priceUsd: price,
    marketCapUsd: null,
    valueUsd: open && price ? D(row.qty).mul(price).toFixed() : null,
    unrealizedPnlUsd: open && price ? unrealizedPnl(state, price) : null,
    returnPct: open && price ? returnPct(state, price) : null,
  };
}

async function loadPositions(userId: string) {
  const rows = await db()
    .select()
    .from(schema.positions)
    .where(eq(schema.positions.userId, userId))
    .orderBy(desc(schema.positions.openedAt));
  const open = rows.filter((r) => !r.closedAt);
  const closed = rows.filter((r) => r.closedAt);
  const prices = await getPricesFilled(open.map((r) => tokenKey(r.tokenChain as ChainKey, r.tokenAddr)));
  return {
    openRows: open,
    closedRows: closed,
    open: await Promise.all(open.map((r) => positionToView(r, prices.get(tokenKey(r.tokenChain as ChainKey, r.tokenAddr)) ?? null))),
    closed: await Promise.all(closed.map((r) => positionToView(r, null))),
    prices,
  };
}

export async function buildPortfolio(userId: string): Promise<PortfolioView> {
  const { openRows, closedRows, open, closed, prices } = await loadPositions(userId);
  const totals = portfolioTotals(
    openRows.map((r) => ({
      qty: r.qty,
      costBasisUsd: r.costBasisUsd,
      realizedPnlUsd: r.realizedPnlUsd,
      priceUsd: prices.get(tokenKey(r.tokenChain as ChainKey, r.tokenAddr)) ?? null,
    })),
    closedRows.map((r) => r.realizedPnlUsd),
  );
  const balance = await usdcBalance(userId);
  return {
    totals,
    cash: {
      usdc: balance.usdc,
      spendable: balance.spendable,
      withdrawable: balance.withdrawable,
      mode: isPaperMode() ? "paper" : "live",
    },
    open,
    closed,
    winRate: winRate(closedRows.map((r) => r.realizedPnlUsd)),
  };
}

export async function publicPositions(userId: string) {
  const { open, closed } = await loadPositions(userId);
  return { open, closed };
}

export async function positionForToken(userId: string, chain: ChainKey, address: string): Promise<PositionView | null> {
  const row = await db().query.positions.findFirst({
    where: and(eq(schema.positions.userId, userId), eq(schema.positions.tokenChain, chain), eq(schema.positions.tokenAddr, address), isNull(schema.positions.closedAt)),
  });
  if (!row) return null;
  const prices = await getPricesFilled([tokenKey(chain, address)]);
  return positionToView(row, prices.get(tokenKey(chain, address)) ?? null);
}

export async function buildProfile(username: string, viewerId: string | null): Promise<ProfileView> {
  const user = await findByUsername(username);
  if (!user || user.isBanned) throw notFound("User");
  const { openRows, closedRows, prices } = await loadPositions(user.id);
  const totals = portfolioTotals(
    openRows.map((r) => ({
      qty: r.qty,
      costBasisUsd: r.costBasisUsd,
      realizedPnlUsd: r.realizedPnlUsd,
      priceUsd: prices.get(tokenKey(r.tokenChain as ChainKey, r.tokenAddr)) ?? null,
    })),
    closedRows.map((r) => r.realizedPnlUsd),
  );
  const [stats] = await db()
    .select({
      theses: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) filter (where ${schema.theses.outcome} <> 'pending')::int`,
      right: sql<number>`count(*) filter (where ${schema.theses.outcome} = 'right')::int`,
    })
    .from(schema.theses)
    .where(and(eq(schema.theses.userId, user.id), isNull(schema.theses.deletedAt)));
  const [trades] = await db()
    .select({ n: sql<number>`count(*) filter (where ${schema.trades.status} = 'filled')::int` })
    .from(schema.trades)
    .where(eq(schema.trades.userId, user.id));
  const counts = await followCounts(user.id);
  let isFollowing = false;
  let isBlocked = false;
  if (viewerId && viewerId !== user.id) {
    isFollowing = !!(await db().query.follows.findFirst({ where: and(eq(schema.follows.followerId, viewerId), eq(schema.follows.followeeId, user.id)) }));
    isBlocked = !!(await db().query.blocks.findFirst({ where: and(eq(schema.blocks.blockerId, viewerId), eq(schema.blocks.blockedId, user.id)) }));
  }
  return {
    ...toSummary(user),
    createdAt: user.createdAt.toISOString(),
    ...counts,
    isFollowing,
    isBlocked,
    isMe: viewerId === user.id,
    stats: {
      allTimePnlUsd: totals.allTimeUsd,
      realizedUsd: totals.realizedUsd,
      winRate: winRate(closedRows.map((r) => r.realizedPnlUsd)),
      trades: trades?.n ?? 0,
      theses: stats?.theses ?? 0,
      resolved: stats?.resolved ?? 0,
      right: stats?.right ?? 0,
      accuracy: accuracyPct(stats?.right ?? 0, stats?.resolved ?? 0),
    },
  };
}

export async function follow(followerId: string, username: string) {
  const target = await findByUsername(username);
  if (!target) throw notFound("User");
  if (target.id === followerId) throw conflict("self_follow", "You can't follow yourself.");
  const blocked = await db().query.blocks.findFirst({ where: and(eq(schema.blocks.blockerId, target.id), eq(schema.blocks.blockedId, followerId)) });
  if (blocked) throw conflict("blocked", "You can't follow this account.");
  const [row] = await db().insert(schema.follows).values({ followerId, followeeId: target.id }).onConflictDoNothing().returning();
  return { target, created: !!row };
}

export async function unfollow(followerId: string, username: string) {
  const target = await findByUsername(username);
  if (!target) throw notFound("User");
  await db().delete(schema.follows).where(and(eq(schema.follows.followerId, followerId), eq(schema.follows.followeeId, target.id)));
  // Copying someone depends on following them.
  await db().delete(schema.copySettings).where(and(eq(schema.copySettings.followerId, followerId), eq(schema.copySettings.leaderId, target.id)));
}

export async function block(blockerId: string, username: string) {
  const target = await findByUsername(username);
  if (!target) throw notFound("User");
  if (target.id === blockerId) throw conflict("self_block", "You can't block yourself.");
  await db().insert(schema.blocks).values({ blockerId, blockedId: target.id }).onConflictDoNothing();
  // A block ends the follow in both directions.
  await db().delete(schema.follows).where(and(eq(schema.follows.followerId, blockerId), eq(schema.follows.followeeId, target.id)));
  await db().delete(schema.follows).where(and(eq(schema.follows.followerId, target.id), eq(schema.follows.followeeId, blockerId)));
  await db().delete(schema.copySettings).where(or(and(eq(schema.copySettings.followerId, blockerId), eq(schema.copySettings.leaderId, target.id)), and(eq(schema.copySettings.followerId, target.id), eq(schema.copySettings.leaderId, blockerId))));
}

export async function unblock(blockerId: string, username: string) {
  const target = await findByUsername(username);
  if (!target) throw notFound("User");
  await db().delete(schema.blocks).where(and(eq(schema.blocks.blockerId, blockerId), eq(schema.blocks.blockedId, target.id)));
}

export async function listBlocks(userId: string) {
  const rows = await db()
    .select({ id: schema.users.id, username: schema.users.username, avatarUrl: schema.users.avatarUrl })
    .from(schema.blocks)
    .innerJoin(schema.users, eq(schema.blocks.blockedId, schema.users.id))
    .where(eq(schema.blocks.blockerId, userId));
  return rows;
}

/** Records the signer grant, after verifying with Privy that the wallet really delegated. */
export async function grantSigner(user: UserRow, caps: { perTradeCapUsd?: string; dailyCapUsd?: string }) {
  // Real login with paper fills has no signer to verify until one is configured.
  if (env().AUTH_MODE === "privy" && (!isPaperMode() || serverSigningConfigured())) {
    const { delegated } = await syncWalletsFromPrivy(user);
    if (!delegated) throw conflict("not_delegated", "The wallet hasn't approved the app signer yet.");
  }
  const expiresAt = new Date(Date.now() + CAP_DEFAULTS.grantDays * 86_400_000);
  const previous = await db().query.signerGrants.findFirst({
    where: and(eq(schema.signerGrants.userId, user.id), isNotNull(schema.signerGrants.approvalTx)),
    orderBy: desc(schema.signerGrants.grantedAt),
  });
  await db()
    .update(schema.signerGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.signerGrants.userId, user.id), isNull(schema.signerGrants.revokedAt)));
  await db().insert(schema.signerGrants).values({
    userId: user.id,
    perTradeCapUsd: caps.perTradeCapUsd ?? previous?.perTradeCapUsd ?? CAP_DEFAULTS.perTradeUsd,
    dailyCapUsd: caps.dailyCapUsd ?? previous?.dailyCapUsd ?? CAP_DEFAULTS.dailyUsd,
    expiresAt,
    approvalTx: previous?.approvalTx ?? null,
  });
  await db().insert(schema.auditLog).values({ userId: user.id, action: "signer_granted", detail: { expiresAt, ...caps } });
}

export async function revokeSigner(userId: string) {
  await db()
    .update(schema.signerGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.signerGrants.userId, userId), isNull(schema.signerGrants.revokedAt)));
  await db().insert(schema.auditLog).values({ userId, action: "signer_revoked", detail: {} });
}

export async function updateCaps(userId: string, caps: { perTradeCapUsd: string; dailyCapUsd: string }) {
  const updated = await db()
    .update(schema.signerGrants)
    .set(caps)
    .where(and(eq(schema.signerGrants.userId, userId), isNull(schema.signerGrants.revokedAt)))
    .returning();
  if (!updated.length) throw conflict("no_grant", "Turn on one-tap trading first.");
  await db().insert(schema.auditLog).values({ userId, action: "caps_updated", detail: caps });
}

/** Paper accounts start empty so the deposit step still gets exercised. This funds them. */
export async function paperDeposit(userId: string) {
  await db()
    .update(schema.users)
    .set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} + ${PAPER_STARTING_BALANCE_USD}::numeric` })
    .where(eq(schema.users.id, userId));
}

export async function paperWithdraw(userId: string, amountUsd: string) {
  const [updated] = await db()
    .update(schema.users)
    .set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} - ${amountUsd}::numeric` })
    .where(and(eq(schema.users.id, userId), sql`${schema.users.paperBalanceUsd} >= ${amountUsd}::numeric`))
    .returning();
  if (!updated) throw conflict("insufficient_balance", "You don't have that much to withdraw.");
}
