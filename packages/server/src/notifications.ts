import type { ChainKey, NotificationView, UserSummary } from "@frontrun/core";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import webpush from "web-push";
import { db, schema } from "./db/client";
import { env } from "./env";
import { logger } from "./logger";
import { CHANNELS, publish } from "./redis";

export interface NotifyInput {
  type: NotificationView["type"];
  message: string;
  actorId?: string | null;
  thesisId?: string | null;
  tradeId?: string | null;
  tokenChain?: string | null;
  tokenAddr?: string | null;
}

let vapidConfigured = false;
function pushReady(): boolean {
  const e = env();
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(e.VAPID_SUBJECT, e.VAPID_PUBLIC_KEY, e.VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  }
  return true;
}

function pushUrl(input: NotifyInput): string {
  if (input.thesisId) return `/thesis/${input.thesisId}`;
  if (input.tokenChain && input.tokenAddr) return `/token/${input.tokenChain}/${input.tokenAddr}`;
  return "/";
}

async function sendPush(userIds: string[], input: NotifyInput) {
  if (!pushReady() || !userIds.length) return;
  const subs = await db().select().from(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, userIds));
  const payload = JSON.stringify({ title: "Front Run", body: input.message, url: pushUrl(input) });
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404 and 410 mean the browser dropped this subscription for good.
        if (status === 404 || status === 410) {
          await db().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
        } else {
          logger.warn({ status }, "push failed");
        }
      }
    }),
  );
}

async function rowToView(row: typeof schema.notifications.$inferSelect, actor: UserSummary | null): Promise<NotificationView> {
  let token: NotificationView["token"] = null;
  if (row.tokenChain && row.tokenAddr) {
    const t = await db().query.tokens.findFirst({ where: and(eq(schema.tokens.chain, row.tokenChain), eq(schema.tokens.address, row.tokenAddr)) });
    token = {
      chain: row.tokenChain as ChainKey,
      address: row.tokenAddr,
      symbol: t?.symbol ?? "?",
      name: t?.name ?? "",
      imageUrl: t?.imageUrl ?? null,
    };
  }
  return {
    id: row.id,
    type: row.type as NotificationView["type"],
    actor,
    thesisId: row.thesisId,
    tradeId: row.tradeId,
    token,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    read: !!row.readAt,
  };
}

export async function notify(userId: string, input: NotifyInput, opts: { push?: boolean } = {}) {
  const [row] = await db()
    .insert(schema.notifications)
    .values({
      userId,
      type: input.type,
      message: input.message,
      actorId: input.actorId ?? null,
      thesisId: input.thesisId ?? null,
      tradeId: input.tradeId ?? null,
      tokenChain: input.tokenChain ?? null,
      tokenAddr: input.tokenAddr ?? null,
    })
    .returning();
  if (!row) return;
  let actor: UserSummary | null = null;
  if (row.actorId) {
    const u = await db().query.users.findFirst({ where: eq(schema.users.id, row.actorId) });
    if (u) actor = { id: u.id, username: u.username, avatarUrl: u.avatarUrl };
  }
  await publish(CHANNELS.user(userId), { type: "notification", notification: await rowToView(row, actor) });
  if (opts.push) await sendPush([userId], input);
}

/** Fan-out when someone posts. Runs after the post has returned, so a big following can't slow it. */
export async function notifyFollowers(authorId: string, input: NotifyInput) {
  const followers = await db()
    .select({ id: schema.follows.followerId })
    .from(schema.follows)
    .where(eq(schema.follows.followeeId, authorId));
  if (!followers.length) return;
  const blockedBy = await db()
    .select({ id: schema.blocks.blockerId })
    .from(schema.blocks)
    .where(eq(schema.blocks.blockedId, authorId));
  const blocked = new Set(blockedBy.map((b) => b.id));
  const ids = followers.map((f) => f.id).filter((id) => !blocked.has(id));
  for (let i = 0; i < ids.length; i += 200) {
    await Promise.all(ids.slice(i, i + 200).map((id) => notify(id, input)));
  }
  await sendPush(ids, input);
}

export async function listNotifications(userId: string, limit = 50) {
  const rows = await db()
    .select({ n: schema.notifications, u: schema.users })
    .from(schema.notifications)
    .leftJoin(schema.users, eq(schema.notifications.actorId, schema.users.id))
    .where(eq(schema.notifications.userId, userId))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit);
  const items = await Promise.all(
    rows.map(({ n, u }) => rowToView(n, u ? { id: u.id, username: u.username, avatarUrl: u.avatarUrl } : null)),
  );
  const [unread] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
  return { items, unread: unread?.count ?? 0 };
}

export async function markAllRead(userId: string) {
  await db()
    .update(schema.notifications)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
}
