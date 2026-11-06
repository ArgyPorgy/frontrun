import {
  COPY_DAILY_MAX_USD,
  COPY_MIN_USD,
  COPY_TRADE_MAX_USD,
  COPY_TRADING_BETA,
  D,
  Decimal,
  type ChainKey,
  type CopySettingInput,
  type CopySettingsView,
  type CopySettingView,
} from "@frontrun/core";
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { AppError, badRequest, conflict } from "../errors";
import { logger } from "../logger";
import { notify } from "../notifications";
import { follow, toSummary } from "../users";
import { createQuote, executeTrade, isPaperMode, signerStatus, tokenRefFor } from "./service";
import { gaslessEnabled } from "./sponsor";

/** A copy this long after the trader's fill would be chasing a price that's gone, so it's skipped. */
const COPY_MAX_AGE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

type Setting = typeof schema.copySettings.$inferSelect;
type Trade = typeof schema.trades.$inferSelect;

/** Only these accounts can turn copying on while it's being tried out with small amounts. */
export function copyTradingAvailable(username: string): boolean {
  return COPY_TRADING_BETA.includes(username.toLowerCase());
}

async function copiedSpendToday(followerId: string): Promise<Decimal> {
  const [row] = await db()
    .select({ total: sql<string>`coalesce(sum(${schema.trades.usdIn}), 0)` })
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.userId, followerId),
        eq(schema.trades.side, "buy"),
        isNotNull(schema.trades.copiedFromTradeId),
        gt(schema.trades.createdAt, new Date(Date.now() - DAY_MS)),
        inArray(schema.trades.status, ["pending", "source_confirmed", "filled"]),
      ),
    );
  return D(row?.total ?? 0);
}

export async function listCopySettings(user: { id: string; username: string }): Promise<CopySettingsView> {
  const rows = await db()
    .select({ setting: schema.copySettings, leader: schema.users })
    .from(schema.copySettings)
    .innerJoin(schema.users, eq(schema.copySettings.leaderId, schema.users.id))
    .where(eq(schema.copySettings.followerId, user.id));
  const items: CopySettingView[] = rows.map(({ setting, leader }) => ({
    leader: toSummary(leader),
    amountUsd: D(setting.amountUsd).toFixed(),
    dailyLimitUsd: D(setting.dailyLimitUsd).toFixed(),
    copySells: setting.copySells,
    enabled: setting.enabled,
  }));
  return { available: copyTradingAvailable(user.username), spentTodayUsd: (await copiedSpendToday(user.id)).toFixed(), items };
}

export async function saveCopySetting(user: { id: string; username: string }, username: string, input: CopySettingInput): Promise<CopySettingsView> {
  if (!copyTradingAvailable(user.username)) throw conflict("copy_not_available", "Copy trading isn't open to everyone yet.");
  const amount = D(input.amountUsd);
  const daily = D(input.dailyLimitUsd);
  if (amount.lt(COPY_MIN_USD) || amount.gt(COPY_TRADE_MAX_USD)) throw badRequest("copy_amount", `The amount per trade has to be between $${COPY_MIN_USD} and $${COPY_TRADE_MAX_USD}.`);
  if (daily.lt(amount) || daily.gt(COPY_DAILY_MAX_USD)) throw badRequest("copy_daily", `The daily limit has to be at least the amount per trade, and at most $${COPY_DAILY_MAX_USD}.`);
  if (input.enabled && !(await signerStatus(user.id)).active) throw conflict("needs_one_tap", "Turn on one-tap trading first, so copies can run while you're away.");

  // Copying someone means following them, and this is also what rules out copying yourself or someone who blocked you.
  const { target } = await follow(user.id, username);
  const values = { amountUsd: amount.toFixed(), dailyLimitUsd: daily.toFixed(), copySells: input.copySells, enabled: input.enabled, updatedAt: new Date() };
  await db()
    .insert(schema.copySettings)
    .values({ followerId: user.id, leaderId: target.id, ...values })
    .onConflictDoUpdate({ target: [schema.copySettings.followerId, schema.copySettings.leaderId], set: values });
  return listCopySettings(user);
}

export async function deleteCopySetting(user: { id: string; username: string }, leaderId: string): Promise<CopySettingsView> {
  await db().delete(schema.copySettings).where(and(eq(schema.copySettings.followerId, user.id), eq(schema.copySettings.leaderId, leaderId)));
  return listCopySettings(user);
}

function reasonFor(err: unknown): string {
  if (err instanceof AppError) return err.message;
  logger.warn({ err: err instanceof Error ? err.message : err }, "copy trade failed");
  return "The trade couldn't be placed.";
}

async function tell(setting: Setting, trade: Trade, message: string) {
  await notify(setting.followerId, { type: "copy_trade", actorId: setting.leaderId, tokenChain: trade.tokenChain, tokenAddr: trade.tokenAddr, message }, { push: true });
}

/** What a sale would leave of the position, as a share of what the trader held. */
async function soldShare(trade: Trade): Promise<Decimal> {
  if (trade.closedPosition) return D(100);
  const position = await db().query.positions.findFirst({
    where: and(eq(schema.positions.userId, trade.userId), eq(schema.positions.tokenChain, trade.tokenChain), eq(schema.positions.tokenAddr, trade.tokenAddr), isNull(schema.positions.closedAt)),
  });
  const sold = D(trade.qty ?? 0);
  const left = D(position?.qty ?? 0);
  return sold.add(left).gt(0) ? sold.div(sold.add(left)).mul(100) : D(0);
}

/** How much of this position came from copying this trader, so someone's own tokens are never sold for them. */
async function copiedQuantity(setting: Setting, trade: Trade, openedAt: Date): Promise<Decimal> {
  const rows = await db().execute<{ qty: string | null }>(sql`
    select sum(case when c.side = 'buy' then c.qty else -c.qty end) as qty
    from trades c join trades s on s.id = c.copied_from_trade_id
    where c.user_id = ${setting.followerId} and s.user_id = ${setting.leaderId}
      and c.token_chain = ${trade.tokenChain} and c.token_addr = ${trade.tokenAddr}
      and c.status = 'filled' and c.filled_at >= ${openedAt.toISOString()}::timestamptz - interval '1 minute'
  `);
  return Decimal.max(D(rows.rows[0]?.qty ?? 0), 0);
}

async function copyBuy(setting: Setting, trade: Trade, leaderName: string, symbol: string) {
  const left = D(setting.dailyLimitUsd).sub(await copiedSpendToday(setting.followerId));
  const amount = Decimal.min(setting.amountUsd, left);
  if (amount.lt(COPY_MIN_USD)) return tell(setting, trade, `Didn't copy ${leaderName}'s ${symbol} buy: you've reached your daily copy limit.`);

  const quote = await createQuote(setting.followerId, { chain: trade.tokenChain as ChainKey, address: trade.tokenAddr, side: "buy", amountUsd: amount.toFixed() });
  // Nobody's there to accept a warning, so anything that would ask a person to confirm is skipped.
  const stop = quote.blocked[0] ?? quote.confirmReasons[0];
  if (stop) return tell(setting, trade, `Didn't copy ${leaderName}'s ${symbol} buy: ${stop.message}`);
  if (!quote.oneTap) return tell(setting, trade, `Didn't copy ${leaderName}'s ${symbol} buy: this trade would need your signature.`);

  await executeTrade(setting.followerId, { quoteId: quote.id, idempotencyKey: `copy:${trade.id}:${setting.followerId}`, copiedFromTradeId: trade.id });
  return tell(setting, trade, `Copying ${leaderName}: buying ${symbol} with $${amount.toDecimalPlaces(2).toFixed()}.`);
}

async function copySell(setting: Setting, trade: Trade, leaderName: string, symbol: string) {
  if (!setting.copySells) return;
  const position = await db().query.positions.findFirst({
    where: and(eq(schema.positions.userId, setting.followerId), eq(schema.positions.tokenChain, trade.tokenChain), eq(schema.positions.tokenAddr, trade.tokenAddr), isNull(schema.positions.closedAt)),
  });
  if (!position || D(position.qty).lte(0)) return;
  const copied = await copiedQuantity(setting, trade, position.openedAt);
  if (copied.lte(0)) return;

  const share = await soldShare(trade);
  if (share.lte(0)) return;
  const target = copied.mul(share).div(100);
  const sellPct = Decimal.min(target.div(position.qty).mul(100), 100).toNumber();

  const quote = await createQuote(setting.followerId, { chain: trade.tokenChain as ChainKey, address: trade.tokenAddr, side: "sell", sellPct });
  // A way out matters more than a good price, so unlike a buy, a warning doesn't stop this.
  if (!quote.oneTap && !gaslessEnabled() && !isPaperMode()) return tell(setting, trade, `Didn't copy ${leaderName}'s ${symbol} sell: this trade would need your signature.`);
  await executeTrade(setting.followerId, { quoteId: quote.id, idempotencyKey: `copy:${trade.id}:${setting.followerId}`, confirmed: true, copiedFromTradeId: trade.id });
  return tell(setting, trade, `Copying ${leaderName}: selling ${sellPct >= 100 ? "your copied" : `${Math.round(share.toNumber())}% of your copied`} ${symbol}.`);
}

async function copyOne(setting: Setting, trade: Trade, leaderName: string, symbol: string) {
  try {
    if (!(await signerStatus(setting.followerId)).active) {
      return await tell(setting, trade, `Didn't copy ${leaderName}'s ${symbol} ${trade.side}: one-tap trading is off, so copying is paused.`);
    }
    if (trade.side === "buy") await copyBuy(setting, trade, leaderName, symbol);
    else await copySell(setting, trade, leaderName, symbol);
  } catch (err) {
    await tell(setting, trade, `Didn't copy ${leaderName}'s ${symbol} ${trade.side}: ${reasonFor(err)}`).catch(() => {});
  }
}

/**
 * Worker: places copies of fresh fills. A copy is never copied in turn, which is what stops two people
 * copying each other from trading in an endless loop.
 */
export async function runCopyTrades(limit = 20): Promise<number> {
  const due = await db()
    .select()
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.status, "filled"),
        isNull(schema.trades.copiedFromTradeId),
        isNull(schema.trades.copyProcessedAt),
        gt(schema.trades.filledAt, new Date(Date.now() - COPY_MAX_AGE_MS)),
      ),
    )
    .orderBy(schema.trades.filledAt)
    .limit(limit);
  let placed = 0;
  for (const trade of due) {
    // Claiming first means two workers can't copy the same fill twice.
    const claimed = await db().update(schema.trades).set({ copyProcessedAt: new Date() }).where(and(eq(schema.trades.id, trade.id), isNull(schema.trades.copyProcessedAt))).returning({ id: schema.trades.id });
    if (!claimed.length) continue;
    const settings = await db().select().from(schema.copySettings).where(and(eq(schema.copySettings.leaderId, trade.userId), eq(schema.copySettings.enabled, true)));
    if (!settings.length) continue;
    const leader = await db().query.users.findFirst({ where: eq(schema.users.id, trade.userId) });
    if (!leader || leader.isBanned) continue;
    const blocks = await db()
      .select({ a: schema.blocks.blockerId, b: schema.blocks.blockedId })
      .from(schema.blocks)
      .where(or(eq(schema.blocks.blockerId, trade.userId), eq(schema.blocks.blockedId, trade.userId)));
    const blocked = new Set(blocks.flatMap((b) => [b.a, b.b]));
    const { symbol } = await tokenRefFor(trade.tokenChain, trade.tokenAddr);
    for (const setting of settings) {
      if (blocked.has(setting.followerId)) continue;
      await copyOne(setting, trade, leader.username, symbol);
      placed += 1;
    }
  }
  return placed;
}
