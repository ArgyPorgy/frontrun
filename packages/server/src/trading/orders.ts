import { ARC_USDC, CHAINS, D, Decimal, FLASH_ALLOWANCE_ARC, GUARDRAILS, PERMIT2, orderDirection, orderSide, tokenKey, toBaseUnits, triggerHit, triggerProblem, normalizeAddress, type ChainKey, type ExecStep, type OrderType, type OrderView } from "@frontrun/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { AppError, conflict, notFound, unprocessable } from "../errors";
import { HttpError } from "../http";
import { logger } from "../logger";
import { getPricesFilled, getTokenDetail, markActive } from "../market/service";
import { notify } from "../notifications";
import { assertApprovalMatches, assertOrderMatches, cancelFlashOrder, flashStatusToUpdate, getFlashOrder, requestRestingQuote, submitRestingOrder, type RestingOrderParams } from "../providers/flash";
import { activeGrant, applyStatus, createQuote, executeTrade, isPaperMode, tokenRefFor, usdcBalance } from "./service";
import { authContext, loadSigningWallets, performServerStep, privy, serverSigningConfigured } from "./signer";

/**
 * Limit, stop-buy, stop-loss and take-profit orders. Flash only runs these on one chain at a time, and its
 * docs say cross-chain is market orders only, while every user's USDC lives on Arc. So there are two engines:
 *
 * - "flash": tokens on Arc rest on Flash itself, and fill even if this app is down.
 * - "app": tokens on other chains are watched here, and fire a normal market order through Flash when the
 *   trigger hits, so the money still comes from and returns to Arc. These need the workers to be running,
 *   and the fill price is the market's at that moment.
 */
export type OrderRow = typeof schema.orders.$inferSelect;

const MAX_ATTEMPTS = 5;
const RESTING_SPENDERS = [FLASH_ALLOWANCE_ARC, PERMIT2];
const CANCEL_PREFIX = "Definitive Flash v1 — Cancel Order";

function toView(row: OrderRow, token: OrderView["token"]): OrderView {
  return {
    id: row.id,
    type: row.type as OrderType,
    side: row.side as "buy" | "sell",
    token,
    amountUsd: row.amountUsd,
    sellPct: row.sellPct,
    triggerPriceUsd: row.triggerPriceUsd,
    status: row.status as OrderView["status"],
    error: row.error,
    tradeId: row.tradeId,
    restsOnChain: row.engine === "flash",
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** Same-chain, so Flash can hold it. Paper mode never talks to a venue, so it watches its own prices. */
function engineFor(chain: ChainKey): "flash" | "app" {
  return !isPaperMode() && chain === "arc" && !!env().FLASH_API_KEY ? "flash" : "app";
}

async function requireLiveSigner(userId: string) {
  if (isPaperMode()) return;
  const grant = await activeGrant(userId);
  if (!serverSigningConfigured() || !grant || grant.expiresAt.getTime() < Date.now()) {
    throw conflict("needs_one_tap", "Turn on one-tap trading to place orders.");
  }
}

function restingParams(row: OrderRow, qty: string, funder: string): RestingOrderParams {
  const price = row.triggerPriceUsd;
  const isLimit = row.type === "limit_buy" || row.type === "limit_sell";
  const flashType = isLimit ? "limit" : row.type === "stop_loss" ? "stop-loss" : row.type === "take_profit" ? "take-profit" : "stop";
  return {
    targetChain: "arc",
    contraChain: "arc",
    targetAsset: row.tokenAddr,
    contraAsset: ARC_USDC,
    side: row.side as "buy" | "sell",
    qty,
    orderType: flashType,
    funderAddress: funder,
    // A stop-loss has to get out, so it isn't held to the tighter limit a market buy gets.
    maxPriceImpact: String(GUARDRAILS.routePriceImpactCap),
    ...(isLimit ? { limitNotionalPrice: price } : { triggers: [{ notionalPrice: price, triggerType: orderDirection(row.type as OrderType) }] }),
    ...(env().FLASH_INTEGRATOR_FEE_BPS > 0 ? { flashIntegratorFeeBps: String(env().FLASH_INTEGRATOR_FEE_BPS) } : {}),
  };
}

async function placeOnFlash(row: OrderRow, qty: string, decimals: number | null): Promise<string> {
  const wallets = await loadSigningWallets(row.userId);
  const params = restingParams(row, qty, wallets.evmAddress);
  const raw = await requestRestingQuote(params);
  const spent = row.side === "buy" ? ARC_USDC : row.tokenAddr;
  const ctx = { userId: row.userId, tradeId: row.id };
  if (raw.evm?.approveTx) {
    assertApprovalMatches(raw.evm.approveTx, spent, RESTING_SPENDERS);
    const step: ExecStep = { id: "approve", kind: "evm_tx", chain: "arc", label: "Approve once", to: raw.evm.approveTx.to, data: raw.evm.approveTx.data, waitForReceipt: true };
    await performServerStep(wallets, step, ctx);
  }
  const permit = raw.evm?.permitTypedData
    ? await performServerStep(wallets, { id: "permit", kind: "evm_typed_data", chain: "arc", label: "Approve Permit2", typedData: raw.evm.permitTypedData }, ctx)
    : null;
  const typed = raw.evm?.orderTypedData;
  if (!typed) throw new Error("The quote came back without an order to sign.");
  assertOrderMatches(typed, {
    funder: wallets.evmAddress,
    spentToken: spent,
    chainId: CHAINS.arc.chainId!,
    fromAmount: row.side === "buy" ? toBaseUnits(qty, CHAINS.arc.usdcDecimals) : decimals !== null ? toBaseUnits(qty, decimals) : undefined,
  });
  const signed = await performServerStep(wallets, { id: "order", kind: "evm_typed_data", chain: "arc", label: "Sign order", typedData: typed }, ctx);
  return submitRestingOrder(params, raw, signed.signature!, permit?.signature);
}

export async function placeOrder(userId: string, input: { chain: ChainKey; address: string; type: OrderType; triggerPriceUsd: string; amountUsd?: string; sellPct?: number }): Promise<OrderView> {
  const address = normalizeAddress(input.chain, input.address);
  const side = orderSide(input.type);
  await requireLiveSigner(userId);
  const detail = await getTokenDetail(input.chain, address);
  if (!detail?.priceUsd) throw unprocessable("no_price", "This token has no live price right now.");
  const problem = triggerProblem(input.type, input.triggerPriceUsd, detail.priceUsd);
  if (problem) throw unprocessable("bad_trigger", problem);

  let qty: string;
  if (side === "buy") {
    const amount = D(input.amountUsd ?? 0).toDecimalPlaces(CHAINS.arc.usdcDecimals, Decimal.ROUND_DOWN);
    if (amount.lte(0)) throw unprocessable("amount_too_small", "Enter an amount to buy.");
    const balance = await usdcBalance(userId);
    if (amount.gt(balance.spendable)) throw unprocessable("insufficient_balance", "You don't have enough USDC for this order.", balance);
    qty = amount.toFixed();
  } else {
    const held = await db().query.positions.findFirst({
      where: and(eq(schema.positions.userId, userId), eq(schema.positions.tokenChain, input.chain), eq(schema.positions.tokenAddr, address), sql`${schema.positions.closedAt} is null`),
    });
    if (!held || D(held.qty).lte(0)) throw unprocessable("no_position", "You don't hold this token.");
    const pct = input.sellPct ?? 100;
    qty = (pct === 100 ? D(held.qty) : D(held.qty).mul(pct).div(100)).toDecimalPlaces(detail.decimals ?? 18, Decimal.ROUND_DOWN).toFixed();
  }

  const engine = engineFor(input.chain);
  const [row] = await db()
    .insert(schema.orders)
    .values({
      userId,
      tokenChain: input.chain,
      tokenAddr: address,
      type: input.type,
      side,
      amountUsd: side === "buy" ? qty : null,
      sellPct: side === "sell" ? (input.sellPct ?? 100) : null,
      triggerPriceUsd: input.triggerPriceUsd,
      engine,
      status: "open",
    })
    .returning();
  if (!row) throw new Error("Order insert returned nothing.");

  if (engine === "flash") {
    try {
      const providerOrderId = await placeOnFlash(row, qty, detail.decimals);
      await db().update(schema.orders).set({ providerOrderId, updatedAt: new Date() }).where(eq(schema.orders.id, row.id));
      row.providerOrderId = providerOrderId;
    } catch (err) {
      await db().update(schema.orders).set({ status: "failed", error: friendly(err), closedAt: new Date() }).where(eq(schema.orders.id, row.id));
      throw err instanceof AppError ? err : new AppError(422, "order_failed", friendly(err));
    }
  } else {
    await markActive(input.chain, address);
  }
  await db().insert(schema.auditLog).values({ userId, action: "order_placed", detail: { orderId: row.id, type: input.type, chain: input.chain, token: address, engine, triggerPriceUsd: input.triggerPriceUsd } });
  return toView(row, await tokenRefFor(input.chain, address));
}

export async function listOrders(userId: string, opts: { status?: "open" | "all"; chain?: ChainKey; address?: string } = {}): Promise<OrderView[]> {
  const rows = await db()
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.userId, userId),
        opts.status === "open" ? inArray(schema.orders.status, ["open", "triggered"]) : undefined,
        opts.chain ? eq(schema.orders.tokenChain, opts.chain) : undefined,
        opts.chain && opts.address ? eq(schema.orders.tokenAddr, normalizeAddress(opts.chain, opts.address)) : undefined,
      ),
    )
    .orderBy(desc(schema.orders.createdAt))
    .limit(100);
  return Promise.all(rows.map(async (r) => toView(r, await tokenRefFor(r.tokenChain, r.tokenAddr))));
}

export async function cancelOrder(userId: string, id: string): Promise<OrderView> {
  const row = await db().query.orders.findFirst({ where: and(eq(schema.orders.id, id), eq(schema.orders.userId, userId)) });
  if (!row) throw notFound("Order");
  if (row.status !== "open") throw conflict("not_open", "This order isn't open any more.");
  if (row.engine === "flash" && row.providerOrderId) {
    const wallets = await loadSigningWallets(userId);
    const message = `${CANCEL_PREFIX}\nOrder: ${row.providerOrderId}`;
    const { signature } = await privy().wallets().ethereum().signMessage(wallets.evmWalletId!, { message, authorization_context: authContext() });
    await cancelFlashOrder(row.providerOrderId, message, signature);
  }
  const [updated] = await db().update(schema.orders).set({ status: "cancelled", closedAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.orders.id, id), eq(schema.orders.status, "open"))).returning();
  if (!updated) throw conflict("not_open", "This order isn't open any more.");
  await db().insert(schema.auditLog).values({ userId, action: "order_cancelled", detail: { orderId: id } });
  return toView(updated, await tokenRefFor(row.tokenChain, row.tokenAddr));
}

function friendly(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof HttpError) {
    if (err.status === 429) return "The trading venue is busy. Try again in a moment.";
    try {
      const parsed = JSON.parse(err.body) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message.replace(/^flash order submission failed:\s*/i, "");
    } catch {
      // Not JSON, so fall through.
    }
    return "The trading venue refused this order.";
  }
  return err instanceof Error ? err.message.slice(0, 200) : "The order couldn't be placed.";
}

/** A brief outage or a venue hiccup shouldn't lose someone's stop-loss, so these get another try. */
function isTemporary(err: unknown): boolean {
  if (err instanceof AppError) return err.status >= 500 || err.code === "no_route" || err.code === "market_data_busy";
  return err instanceof HttpError ? err.status === 429 || err.status >= 500 : true;
}

async function closeWithFailure(row: OrderRow, reason: string) {
  await db().update(schema.orders).set({ status: "failed", error: reason, closedAt: new Date(), updatedAt: new Date() }).where(eq(schema.orders.id, row.id));
  const token = await tokenRefFor(row.tokenChain, row.tokenAddr);
  await notify(row.userId, { type: "trade_update", message: `Your ${token.symbol} order couldn't run: ${reason}`, tokenChain: row.tokenChain, tokenAddr: row.tokenAddr }, { push: true });
}

/** Worker: fires the orders this app is watching. Runs under a lease, so only one worker does it. */
export async function checkWatchedOrders(limit = 200): Promise<number> {
  const open = await db().select().from(schema.orders).where(and(eq(schema.orders.engine, "app"), eq(schema.orders.status, "open"))).orderBy(asc(schema.orders.createdAt)).limit(limit);
  if (!open.length) return 0;
  await Promise.all(open.map((o) => markActive(o.tokenChain as ChainKey, o.tokenAddr)));
  const prices = await getPricesFilled(open.map((o) => tokenKey(o.tokenChain as ChainKey, o.tokenAddr)));
  for (const row of open) {
    const price = prices.get(tokenKey(row.tokenChain as ChainKey, row.tokenAddr));
    if (!price || !triggerHit(orderDirection(row.type as OrderType), row.triggerPriceUsd, price)) continue;
    // Claiming first means a slow trade can never fire twice.
    const [claimed] = await db().update(schema.orders).set({ status: "triggered", updatedAt: new Date() }).where(and(eq(schema.orders.id, row.id), eq(schema.orders.status, "open"))).returning();
    if (!claimed) continue;
    logger.info({ orderId: row.id, type: row.type, price }, "order triggered");
    try {
      const quote = await createQuote(row.userId, {
        chain: row.tokenChain as ChainKey,
        address: row.tokenAddr,
        side: row.side as "buy" | "sell",
        ...(row.side === "buy" ? { amountUsd: row.amountUsd! } : { sellPct: row.sellPct ?? 100 }),
      });
      // Nobody's there to accept a high price impact, so a background buy stops rather than fill at it.
      const needsPerson = quote.confirmReasons.find((r) => r.attended);
      if (needsPerson) throw unprocessable("blocked", needsPerson.message);
      const trade = await executeTrade(row.userId, { quoteId: quote.id, idempotencyKey: `order:${row.id}:${row.attempts}`, confirmed: true });
      await db().update(schema.orders).set({ tradeId: trade.id, updatedAt: new Date() }).where(eq(schema.orders.id, row.id));
      if (trade.status === "failed") await closeWithFailure(row, trade.error ?? "The trade didn't go through.");
    } catch (err) {
      const attempts = row.attempts + 1;
      if (isTemporary(err) && attempts < MAX_ATTEMPTS) {
        logger.warn({ orderId: row.id, attempts, err: friendly(err) }, "order will try again");
        await db().update(schema.orders).set({ status: "open", attempts, updatedAt: new Date() }).where(eq(schema.orders.id, row.id));
      } else {
        await closeWithFailure(row, friendly(err));
      }
    }
  }
  return open.length;
}

/** Worker: checks the orders resting on Flash, and brings each fill into the normal trade records. */
export async function pollFlashOrders(limit = 100): Promise<number> {
  const open = await db().select().from(schema.orders).where(and(eq(schema.orders.engine, "flash"), eq(schema.orders.status, "open"))).orderBy(asc(schema.orders.updatedAt)).limit(limit);
  for (const row of open) {
    if (!row.providerOrderId) continue;
    try {
      const wallets = await loadSigningWallets(row.userId);
      const res = await getFlashOrder(row.providerOrderId, wallets.evmAddress);
      await db().update(schema.orders).set({ updatedAt: new Date() }).where(eq(schema.orders.id, row.id));
      if (res.order.status === "ORDER_STATUS_FILLED") {
        const [trade] = await db()
          .insert(schema.trades)
          .values({
            userId: row.userId,
            side: row.side,
            tokenChain: row.tokenChain,
            tokenAddr: row.tokenAddr,
            usdIn: row.amountUsd,
            provider: "flash",
            srcChain: "arc",
            status: "pending",
            isPaper: false,
            idempotencyKey: `order:${row.id}`,
            providerOrderId: row.providerOrderId,
            execState: { quote: { provider: "flash" }, request: {} },
          })
          .onConflictDoNothing()
          .returning();
        if (trade) {
          await db().update(schema.orders).set({ tradeId: trade.id, status: "triggered" }).where(eq(schema.orders.id, row.id));
          const update = flashStatusToUpdate(res, { side: row.side as "buy" | "sell" });
          // A resting order's reported fee also holds Flash's own, so the app's share comes from its rate.
          const filledUsd = update.usdIn ?? update.usdOut ?? "0";
          await applyStatus(trade.id, { ...update, revenueUsd: D(filledUsd).mul(env().FLASH_INTEGRATOR_FEE_BPS).div(10_000).toFixed() });
        }
      } else if (["ORDER_STATUS_CANCELLED", "ORDER_STATUS_REJECTED", "ORDER_STATUS_TERMINATED"].includes(res.order.status)) {
        await closeWithFailure(row, flashStatusToUpdate(res, { side: row.side as "buy" | "sell" }).error ?? "The order was closed.");
      }
    } catch (err) {
      logger.warn({ orderId: row.id, err: friendly(err) }, "order status check failed");
    }
  }
  return open.length;
}

