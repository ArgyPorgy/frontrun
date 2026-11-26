import { randomUUID } from "node:crypto";
import {
  D,
  perpLiquidationPrice,
  perpOrderProblem,
  perpPnlUsd,
  type PerpOpenInput,
  type PerpPositionView,
  type PerpSide,
} from "@frontrun/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  GeoRestrictedError,
  positionCollateral,
  positionLiquidationPrice,
  positionOpenPrice,
  positionSide,
  positionSl,
  positionTp,
  type Position,
} from "veranta-sdk";
import { db, schema } from "../db/client";
import { AppError, badRequest, conflict, notFound } from "../errors";
import { logger } from "../logger";
import { redis } from "../redis";
import { isPaperMode, signerStatus, usdcBalance } from "../trading/service";
import { loadSigningWallets, serverSigningConfigured } from "../trading/signer";
import { perpMarket, perpPrice, verantaReader } from "./markets";
import { verantaFor } from "./signer";

type Row = typeof schema.perpPositions.$inferSelect;
const LIVE_STATUSES = ["pending", "open", "closing"] as const;
/** Market orders may fill this far from the quoted price before the venue refuses them. */
const SLIPPAGE_PERCENT = 1;

function num(v: string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function feeUsd(sizeUsd: number, pct: number): number {
  return (sizeUsd * pct) / 100;
}

export function perpToView(
  row: Row,
  markPrice: number | null,
): PerpPositionView {
  const collateral = Number(row.collateralUsd);
  const entry = num(row.entryPrice);
  const live = row.status === "open" || row.status === "closing";
  let pnl: number | null = null;
  if (row.realizedPnlUsd !== null) pnl = Number(row.realizedPnlUsd);
  else if (live && entry && markPrice)
    pnl =
      perpPnlUsd(
        {
          side: row.side,
          collateralUsd: collateral,
          leverage: row.leverage,
          entryPrice: entry,
        },
        markPrice,
      ) - Number(row.feesUsd);
  return {
    id: row.id,
    market: {
      pairIndex: row.pairIndex,
      symbol: row.symbol,
      base: row.symbol.split("/")[0]!.replace(/_UPSIDE$/, ""),
      assetClass: row.assetClass as PerpPositionView["market"]["assetClass"],
    },
    side: row.side,
    status: row.status,
    collateralUsd: D(row.collateralUsd).toFixed(2),
    leverage: row.leverage,
    sizeUsd: D(row.collateralUsd).mul(row.leverage).toFixed(2),
    entryPrice: row.entryPrice,
    markPrice: live && markPrice ? String(markPrice) : null,
    liquidationPrice: row.liquidationPrice,
    takeProfit: row.takeProfit,
    stopLoss: row.stopLoss,
    pnlUsd: pnl === null ? null : pnl.toFixed(2),
    pnlPct: pnl === null || collateral <= 0 ? null : (pnl / collateral) * 100,
    closePrice: row.closePrice,
    openTx: row.openTx,
    closeTx: row.closeTx,
    isPaper: row.isPaper,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    openedAt: row.openedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

export async function listPerps(
  userId: string,
  opts: { status?: "open" | "closed" } = {},
): Promise<PerpPositionView[]> {
  const where =
    opts.status === "open"
      ? and(
          eq(schema.perpPositions.userId, userId),
          inArray(schema.perpPositions.status, [...LIVE_STATUSES]),
        )
      : opts.status === "closed"
        ? and(
            eq(schema.perpPositions.userId, userId),
            inArray(schema.perpPositions.status, [
              "closed",
              "liquidated",
              "cancelled",
              "failed",
            ]),
          )
        : eq(schema.perpPositions.userId, userId);
  const rows = await db()
    .select()
    .from(schema.perpPositions)
    .where(where)
    .orderBy(desc(schema.perpPositions.createdAt))
    .limit(100);
  const prices = new Map<number, number | null>();
  for (const i of new Set(
    rows
      .filter((r) =>
        LIVE_STATUSES.includes(r.status as (typeof LIVE_STATUSES)[number]),
      )
      .map((r) => r.pairIndex),
  ))
    prices.set(i, await perpPrice(i));
  return rows.map((r) => perpToView(r, prices.get(r.pairIndex) ?? null));
}

async function ownRow(userId: string, id: string): Promise<Row> {
  const row = await db().query.perpPositions.findFirst({
    where: and(
      eq(schema.perpPositions.id, id),
      eq(schema.perpPositions.userId, userId),
    ),
  });
  if (!row) throw notFound("That position");
  return row;
}

function friendlyPerpError(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof GeoRestrictedError)
    return "Veranta doesn't accept orders from this region right now.";
  const message = err instanceof Error ? err.message : String(err);
  if (/policy_violation/.test(message)) {
    logger.error(
      { err: message.slice(0, 200) },
      "ALERT: the signer policy refused a perp action",
    );
    return "This action isn't allowed for your wallet right now. Nothing was sent, and your funds are safe.";
  }
  if (/insufficient|exceeds balance/i.test(message))
    return "Not enough USDC for this.";
  if (/reverted/i.test(message)) return "The transaction reverted on-chain.";
  if (/slippage|deviation/i.test(message))
    return "The price moved too far before the order went in. Try again.";
  return message.length < 160
    ? message
    : "The perp order couldn't be completed.";
}

/** One open at a time per person, so a double tap can't open two positions. */
async function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const key = `perps:lock:${userId}`;
  const got = await redis().set(key, "1", "EX", 120, "NX");
  if (!got)
    throw conflict(
      "busy",
      "Another perp action is still going through. Give it a moment.",
    );
  try {
    return await fn();
  } finally {
    await redis().del(key);
  }
}

export async function openPerp(
  userId: string,
  input: PerpOpenInput,
  opts: { agentReason?: string } = {},
): Promise<PerpPositionView> {
  const market = await perpMarket(input.pairIndex);
  if (!market)
    throw badRequest("unknown_market", "That market isn't on Veranta.");
  const price = market.priceUsd;
  if (!price)
    throw conflict(
      "no_price",
      `There's no live price for ${market.symbol} right now.`,
    );
  const problem = perpOrderProblem(market, input, price);
  if (problem) throw badRequest("invalid_order", problem);
  const sizeUsd = input.collateralUsd * input.leverage;
  const openFee = feeUsd(sizeUsd, market.openFeePct);
  const balance = await usdcBalance(userId);
  if (D(balance.spendable).lt(input.collateralUsd))
    throw conflict(
      "insufficient_balance",
      `You have $${D(balance.spendable).toFixed(2)} USDC, and this needs $${input.collateralUsd.toFixed(2)}.`,
    );

  const base = {
    userId,
    pairIndex: market.pairIndex,
    symbol: market.symbol,
    assetClass: market.assetClass,
    side: input.side,
    collateralUsd: String(input.collateralUsd),
    leverage: input.leverage,
    takeProfit: input.takeProfit ? String(input.takeProfit) : null,
    stopLoss: input.stopLoss ? String(input.stopLoss) : null,
    agentReason: opts.agentReason ?? null,
  };

  if (isPaperMode()) {
    const row = await db().transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.perpPositions)
        .values({
          ...base,
          status: "open",
          isPaper: true,
          entryPrice: String(price),
          liquidationPrice: String(
            perpLiquidationPrice({
              side: input.side,
              leverage: input.leverage,
              entryPrice: price,
            }),
          ),
          feesUsd: openFee.toFixed(6),
          openedAt: new Date(),
        })
        .returning();
      await tx
        .update(schema.users)
        .set({
          paperBalanceUsd: sql`${schema.users.paperBalanceUsd} - ${input.collateralUsd}::numeric`,
        })
        .where(eq(schema.users.id, userId));
      return inserted!;
    });
    await audit(userId, "perp_opened", {
      id: row.id,
      symbol: market.symbol,
      side: input.side,
      collateralUsd: input.collateralUsd,
      leverage: input.leverage,
      paper: true,
    });
    return perpToView(row, price);
  }

  if (!serverSigningConfigured() || !(await signerStatus(userId)).active)
    throw conflict(
      "needs_one_tap",
      "Turn on one-tap trading first, so perp orders can be signed for you.",
    );
  return withLock(userId, async () => {
    const [row] = await db()
      .insert(schema.perpPositions)
      .values({ ...base, status: "pending", isPaper: false })
      .returning();
    const tradeId = randomUUID();
    try {
      const { client } = await verantaFor(userId, tradeId);
      const allowance = (await client.account.allowance()) as {
        allowance?: string;
      };
      if (
        BigInt(allowance.allowance ?? "0") <
        BigInt(Math.ceil(input.collateralUsd * 1e6))
      ) {
        await client.account.approveUsdc(input.collateralUsd, { wait: true });
      }
      const receipt = await client.trade.marketOpen(
        market.pairIndex,
        input.side,
        {
          collateral: input.collateralUsd,
          leverage: input.leverage,
          openPrice: price,
          takeProfit: input.takeProfit,
          stopLoss: input.stopLoss,
          slippagePercent: SLIPPAGE_PERCENT,
          wait: true,
        },
      );
      const [updated] = await db()
        .update(schema.perpPositions)
        .set({ openTx: receipt.txHash ?? null, feesUsd: openFee.toFixed(6) })
        .where(eq(schema.perpPositions.id, row!.id))
        .returning();
      await audit(userId, "perp_opened", {
        id: row!.id,
        symbol: market.symbol,
        side: input.side,
        collateralUsd: input.collateralUsd,
        leverage: input.leverage,
        tx: receipt.txHash,
      });
      // The venue fills on its next price update, usually within seconds. The sync picks it up from there.
      await syncUser(userId).catch(() => undefined);
      const fresh = await ownRow(userId, row!.id);
      return perpToView(fresh ?? updated!, price);
    } catch (err) {
      const message = friendlyPerpError(err);
      logger.warn(
        { userId, err: err instanceof Error ? err.message.slice(0, 300) : err },
        "perp open failed",
      );
      const [failed] = await db()
        .update(schema.perpPositions)
        .set({ status: "failed", error: message, closedAt: new Date() })
        .where(eq(schema.perpPositions.id, row!.id))
        .returning();
      return perpToView(failed!, price);
    }
  });
}

async function closePaper(
  row: Row,
  price: number,
  fraction: number,
  status: "closed" | "liquidated" = "closed",
): Promise<Row> {
  const market = await perpMarket(row.pairIndex);
  const collateral = Number(row.collateralUsd);
  const part = collateral * fraction;
  const entry = Number(row.entryPrice);
  const gross =
    status === "liquidated"
      ? -part
      : perpPnlUsd(
          {
            side: row.side,
            collateralUsd: part,
            leverage: row.leverage,
            entryPrice: entry,
          },
          price,
        );
  const closeFee =
    status === "liquidated"
      ? 0
      : feeUsd(part * row.leverage, market?.closeFeePct ?? 0.045);
  const openFeeShare = Number(row.feesUsd) * fraction;
  const payout = Math.max(0, part + gross - closeFee - openFeeShare);
  const realized = payout - part;
  return db().transaction(async (tx) => {
    await tx
      .update(schema.users)
      .set({
        paperBalanceUsd: sql`${schema.users.paperBalanceUsd} + ${payout.toFixed(6)}::numeric`,
      })
      .where(eq(schema.users.id, row.userId));
    if (fraction >= 0.9999) {
      const [done] = await tx
        .update(schema.perpPositions)
        .set({
          status,
          closePrice: String(price),
          realizedPnlUsd: (Number(row.realizedPnlUsd ?? 0) + realized).toFixed(
            6,
          ),
          feesUsd: (Number(row.feesUsd) + closeFee).toFixed(6),
          closedAt: new Date(),
        })
        .where(eq(schema.perpPositions.id, row.id))
        .returning();
      return done!;
    }
    // A partial close books its result on a closed slice and keeps the rest open.
    await tx.insert(schema.perpPositions).values({
      userId: row.userId,
      pairIndex: row.pairIndex,
      symbol: row.symbol,
      assetClass: row.assetClass,
      side: row.side,
      status: "closed",
      collateralUsd: part.toFixed(6),
      leverage: row.leverage,
      entryPrice: row.entryPrice,
      closePrice: String(price),
      realizedPnlUsd: realized.toFixed(6),
      feesUsd: (openFeeShare + closeFee).toFixed(6),
      isPaper: true,
      openedAt: row.openedAt,
      closedAt: new Date(),
    });
    const [rest] = await tx
      .update(schema.perpPositions)
      .set({
        collateralUsd: (collateral - part).toFixed(6),
        feesUsd: (Number(row.feesUsd) - openFeeShare).toFixed(6),
      })
      .where(eq(schema.perpPositions.id, row.id))
      .returning();
    return rest!;
  });
}

export async function closePerp(
  userId: string,
  id: string,
  percent = 100,
): Promise<PerpPositionView> {
  const row = await ownRow(userId, id);
  if (row.status !== "open")
    throw conflict("not_open", "That position isn't open.");
  const price = await perpPrice(row.pairIndex);
  if (!price)
    throw conflict(
      "no_price",
      `There's no live price for ${row.symbol} right now, so it can't be closed until its market reopens.`,
    );
  const fraction = Math.min(1, percent / 100);
  if (row.isPaper) {
    const after = await closePaper(row, price, fraction);
    await audit(userId, "perp_closed", { id, percent, paper: true });
    return perpToView(after, price);
  }
  if (row.venueIndex === null)
    throw conflict(
      "not_synced",
      "This position is still being confirmed on Veranta. Try again in a few seconds.",
    );
  return withLock(userId, async () => {
    try {
      const { client } = await verantaFor(userId, randomUUID());
      const receipt = await client.trade.marketClose(
        row.pairIndex,
        row.venueIndex!,
        {
          collateralToClose: Number(
            (Number(row.collateralUsd) * fraction).toFixed(6),
          ),
          wait: true,
        },
      );
      const [updated] = await db()
        .update(schema.perpPositions)
        .set(
          fraction >= 0.9999
            ? {
                status: "closing",
                closeTx: receipt.txHash ?? null,
                closePrice: String(price),
              }
            : { closeTx: receipt.txHash ?? null },
        )
        .where(eq(schema.perpPositions.id, id))
        .returning();
      await audit(userId, "perp_closed", { id, percent, tx: receipt.txHash });
      await syncUser(userId).catch(() => undefined);
      return perpToView((await ownRow(userId, id)) ?? updated!, price);
    } catch (err) {
      throw new AppError(422, "perp_failed", friendlyPerpError(err));
    }
  });
}

export async function updatePerpTpSl(
  userId: string,
  id: string,
  levels: { takeProfit?: number | null; stopLoss?: number | null },
): Promise<PerpPositionView> {
  const row = await ownRow(userId, id);
  if (row.status !== "open")
    throw conflict("not_open", "That position isn't open.");
  const price = await perpPrice(row.pairIndex);
  const tp =
    levels.takeProfit === undefined ? num(row.takeProfit) : levels.takeProfit;
  const sl =
    levels.stopLoss === undefined ? num(row.stopLoss) : levels.stopLoss;
  if (price) {
    const dir = row.side === "long" ? 1 : -1;
    if (tp && (tp - price) * dir <= 0)
      throw badRequest(
        "invalid_tp",
        "Take-profit has to be on the winning side of the current price.",
      );
    if (sl && (price - sl) * dir <= 0)
      throw badRequest(
        "invalid_sl",
        "Stop-loss has to be on the losing side of the current price.",
      );
  }
  if (!row.isPaper) {
    if (row.venueIndex === null)
      throw conflict(
        "not_synced",
        "This position is still being confirmed on Veranta.",
      );
    try {
      const { client } = await verantaFor(userId, randomUUID());
      await client.trade.updateTpSl(row.pairIndex, row.venueIndex, {
        takeProfit: tp ?? 0,
        stopLoss: sl ?? 0,
      });
    } catch (err) {
      throw new AppError(422, "perp_failed", friendlyPerpError(err));
    }
  }
  const [updated] = await db()
    .update(schema.perpPositions)
    .set({
      takeProfit: tp ? String(tp) : null,
      stopLoss: sl ? String(sl) : null,
    })
    .where(eq(schema.perpPositions.id, id))
    .returning();
  await audit(userId, "perp_tpsl", { id, takeProfit: tp, stopLoss: sl });
  return perpToView(updated!, price);
}

export async function updatePerpMargin(
  userId: string,
  id: string,
  action: "add" | "remove",
  amountUsd: number,
): Promise<PerpPositionView> {
  const row = await ownRow(userId, id);
  if (row.status !== "open")
    throw conflict("not_open", "That position isn't open.");
  const collateral = Number(row.collateralUsd);
  const next =
    action === "add" ? collateral + amountUsd : collateral - amountUsd;
  const market = await perpMarket(row.pairIndex);
  if (next <= 0)
    throw badRequest(
      "too_much",
      "That would take out all of the collateral. Close the position instead.",
    );
  const newLeverage = (collateral * row.leverage) / next;
  if (market && newLeverage > market.maxLeverage)
    throw badRequest(
      "too_much",
      `That would push leverage past ${market.maxLeverage}x.`,
    );
  if (action === "add") {
    const balance = await usdcBalance(userId);
    if (D(balance.spendable).lt(amountUsd))
      throw conflict("insufficient_balance", "Not enough USDC for that.");
  }
  const price = await perpPrice(row.pairIndex);
  if (!row.isPaper) {
    if (row.venueIndex === null)
      throw conflict(
        "not_synced",
        "This position is still being confirmed on Veranta.",
      );
    await withLock(userId, async () => {
      try {
        const { client } = await verantaFor(userId, randomUUID());
        if (action === "add") {
          const allowance = (await client.account.allowance()) as {
            allowance?: string;
          };
          if (
            BigInt(allowance.allowance ?? "0") <
            BigInt(Math.ceil(amountUsd * 1e6))
          )
            await client.account.approveUsdc(amountUsd, { wait: true });
        }
        await client.trade.updateMargin(
          row.pairIndex,
          row.venueIndex!,
          action === "add" ? "deposit" : "withdraw",
          amountUsd,
          { wait: true },
        );
      } catch (err) {
        throw new AppError(422, "perp_failed", friendlyPerpError(err));
      }
    });
  }
  const entry = Number(row.entryPrice);
  const [updated] = await db().transaction(async (tx) => {
    if (row.isPaper) {
      const delta = action === "add" ? -amountUsd : amountUsd;
      await tx
        .update(schema.users)
        .set({
          paperBalanceUsd: sql`${schema.users.paperBalanceUsd} + ${delta}::numeric`,
        })
        .where(eq(schema.users.id, userId));
    }
    return tx
      .update(schema.perpPositions)
      .set({
        collateralUsd: next.toFixed(6),
        leverage: newLeverage,
        liquidationPrice: entry
          ? String(
              perpLiquidationPrice({
                side: row.side,
                leverage: newLeverage,
                entryPrice: entry,
              }),
            )
          : row.liquidationPrice,
      })
      .where(eq(schema.perpPositions.id, id))
      .returning();
  });
  await audit(userId, "perp_margin", { id, action, amountUsd });
  if (!row.isPaper) await syncUser(userId).catch(() => undefined);
  return perpToView(updated!, price);
}

async function audit(
  userId: string,
  action: string,
  detail: Record<string, unknown>,
) {
  await db().insert(schema.auditLog).values({ userId, action, detail });
}

function venueSide(p: Position): PerpSide {
  return positionSide(p);
}

/**
 * Brings one person's live rows in line with what Veranta holds for their wallet: pending rows take the
 * position the venue opened, rows the venue no longer holds are closed, and levels follow the venue's.
 */
export async function syncUser(userId: string): Promise<void> {
  const rows = await db()
    .select()
    .from(schema.perpPositions)
    .where(
      and(
        eq(schema.perpPositions.userId, userId),
        eq(schema.perpPositions.isPaper, false),
        inArray(schema.perpPositions.status, [...LIVE_STATUSES]),
      ),
    );
  if (rows.length === 0) return;
  const wallets = await loadSigningWallets(userId);
  const data = await verantaReader().account.positions(
    wallets.evmAddress as `0x${string}`,
  );
  const venue = data.positions;
  const key = (p: { pairIndex: number; index: number }) =>
    `${p.pairIndex}:${p.index}`;
  const venueByKey = new Map(venue.map((p) => [key(p), p]));
  const claimed = new Set(
    rows
      .filter((r) => r.venueIndex !== null)
      .map((r) => `${r.pairIndex}:${r.venueIndex}`),
  );

  for (const row of rows) {
    if (row.venueIndex === null) {
      // A pending row takes the first unclaimed venue position on its market and side.
      const match = venue.find(
        (p) =>
          p.pairIndex === row.pairIndex &&
          venueSide(p) === row.side &&
          !claimed.has(key(p)),
      );
      if (match) {
        claimed.add(key(match));
        await db()
          .update(schema.perpPositions)
          .set({
            status: "open",
            venueIndex: match.index,
            entryPrice: String(positionOpenPrice(match)),
            collateralUsd: String(positionCollateral(match)),
            liquidationPrice: positionLiquidationPrice(match)
              ? String(positionLiquidationPrice(match))
              : null,
            takeProfit: positionTp(match)
              ? String(positionTp(match))
              : row.takeProfit,
            stopLoss: positionSl(match)
              ? String(positionSl(match))
              : row.stopLoss,
            openedAt: new Date(),
          })
          .where(eq(schema.perpPositions.id, row.id));
      } else if (Date.now() - row.createdAt.getTime() > 10 * 60_000) {
        // The venue never opened it. Veranta returns the collateral when an order can't fill.
        await db()
          .update(schema.perpPositions)
          .set({
            status: "cancelled",
            error:
              "Veranta didn't fill this order, so the collateral stayed in your wallet.",
            closedAt: new Date(),
          })
          .where(eq(schema.perpPositions.id, row.id));
      }
      continue;
    }
    const held = venueByKey.get(`${row.pairIndex}:${row.venueIndex}`);
    if (held) {
      await db()
        .update(schema.perpPositions)
        .set({
          status: row.status === "closing" ? "open" : row.status,
          collateralUsd: String(positionCollateral(held)),
          liquidationPrice: positionLiquidationPrice(held)
            ? String(positionLiquidationPrice(held))
            : row.liquidationPrice,
          takeProfit: positionTp(held) ? String(positionTp(held)) : null,
          stopLoss: positionSl(held) ? String(positionSl(held)) : null,
        })
        .where(eq(schema.perpPositions.id, row.id));
      continue;
    }
    // Gone from the venue: closed by the person, by take-profit or stop-loss, or liquidated.
    const price = num(row.closePrice) ?? (await perpPrice(row.pairIndex));
    const entry = Number(row.entryPrice);
    const liq = num(row.liquidationPrice);
    const dir = row.side === "long" ? 1 : -1;
    const liquidated =
      row.status !== "closing" &&
      liq !== null &&
      price !== null &&
      (liq - price) * dir >= 0;
    const tp = num(row.takeProfit);
    const sl = num(row.stopLoss);
    // Without the venue's fill price, a triggered take-profit or stop-loss is booked at its level.
    let exit = price;
    if (!liquidated && row.status !== "closing" && price !== null) {
      if (tp !== null && (price - tp) * dir >= 0) exit = tp;
      else if (sl !== null && (sl - price) * dir >= 0) exit = sl;
    }
    const collateral = Number(row.collateralUsd);
    const realized = liquidated
      ? -collateral
      : exit && entry
        ? perpPnlUsd(
            {
              side: row.side,
              collateralUsd: collateral,
              leverage: row.leverage,
              entryPrice: entry,
            },
            exit,
          ) -
          Number(row.feesUsd) -
          feeUsd(collateral * row.leverage, 0.045)
        : null;
    await db()
      .update(schema.perpPositions)
      .set({
        status: liquidated ? "liquidated" : "closed",
        closePrice: exit ? String(exit) : null,
        realizedPnlUsd: realized === null ? null : realized.toFixed(6),
        closedAt: new Date(),
      })
      .where(eq(schema.perpPositions.id, row.id));
  }
}

/** Worker: live rows follow the venue; paper rows hit their take-profit, stop-loss or liquidation here. */
export async function syncPerps(): Promise<{
  live: number;
  paperClosed: number;
}> {
  const users = await db()
    .selectDistinct({ userId: schema.perpPositions.userId })
    .from(schema.perpPositions)
    .where(
      and(
        eq(schema.perpPositions.isPaper, false),
        inArray(schema.perpPositions.status, [...LIVE_STATUSES]),
      ),
    );
  for (const { userId } of users) {
    await syncUser(userId).catch((err) =>
      logger.warn(
        { userId, err: err instanceof Error ? err.message.slice(0, 200) : err },
        "perp sync failed",
      ),
    );
  }
  const paper = await db()
    .select()
    .from(schema.perpPositions)
    .where(
      and(
        eq(schema.perpPositions.isPaper, true),
        eq(schema.perpPositions.status, "open"),
      ),
    );
  let paperClosed = 0;
  for (const row of paper) {
    const price = await perpPrice(row.pairIndex);
    if (!price) continue;
    const dir = row.side === "long" ? 1 : -1;
    const liq = num(row.liquidationPrice);
    const tp = num(row.takeProfit);
    const sl = num(row.stopLoss);
    if (liq !== null && (liq - price) * dir >= 0)
      await closePaper(row, price, 1, "liquidated");
    else if (tp !== null && (price - tp) * dir >= 0)
      await closePaper(row, tp, 1);
    else if (sl !== null && (sl - price) * dir >= 0)
      await closePaper(row, sl, 1);
    else continue;
    paperClosed += 1;
  }
  return { live: users.length, paperClosed };
}

/** Markets with open positions, so the price worker keeps them fresh as well as the featured ones. */
export async function openPerpMarkets(): Promise<number[]> {
  const rows = await db()
    .selectDistinct({ pairIndex: schema.perpPositions.pairIndex })
    .from(schema.perpPositions)
    .where(inArray(schema.perpPositions.status, [...LIVE_STATUSES]));
  return rows.map((r) => r.pairIndex);
}
