import { randomUUID } from "node:crypto";
import {
  ARC_GAS_RESERVE_USDC6,
  CAP_DEFAULTS,
  CHAINS,
  COPY_BUY_CAP_USD,
  D,
  Decimal,
  EMPTY_POSITION,
  GUARDRAILS,
  TERMINAL_STATUSES,
  applyBuy,
  applySell,
  checkSpendCaps,
  fromBaseUnits,
  normalizeAddress,
  resolveSlippage,
  tokenKey,
  type ChainKey,
  type ExecStep,
  type GuardrailIssue,
  type GuardrailResult,
  type PositionState,
  type ProviderId,
  type QuoteRequest,
  type QuoteView,
  type SignerStatus,
  type StepResult,
  type TokenRef,
  type TradeStatus,
  type TradeView,
} from "@frontrun/core";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema, type Db } from "../db/client";
import { env } from "../env";
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from "../errors";
import { HttpError } from "../http";
import { logger } from "../logger";
import { getSnapshot, getTokenDetail, rememberToken } from "../market/service";
import { notify } from "../notifications";
import { arcUsdcBalance, erc20Allowance, tokenBalance } from "../onchain";
import {
  PROVIDERS,
  paperFill,
  type ProviderQuote,
  type RouteRequest,
  type StatusUpdate,
} from "../providers";
import { CHANNELS, KEYS, publish, redis } from "../redis";
import { applyGuardrails, raceQuotes, withinTolerance, type RaceAlternative } from "../routing/engine";
import { FLASH_ALLOWANCE_ARC, ARC_USDC } from "@frontrun/core";
import { loadSigningWallets, performServerStep, serverSigningConfigured, solanaSigningConfigured, type SigningWallets } from "./signer";
import { gaslessEnabled } from "./sponsor";

/** How long a shown price stays good, and how long we keep the record for a one-time re-quote. */
const QUOTE_FRESH_MS = 30_000;
const QUOTE_RECORD_TTL_S = 180;
const MAX_STEPS = 10;
const UNSUBMITTED_TIMEOUT_MS = 2 * 60_000;

export interface QuoteRecord {
  id: string;
  userId: string;
  request: RouteRequest;
  winner: ProviderQuote;
  alternatives: RaceAlternative[];
  guardrails: GuardrailResult;
  token: TokenRef;
  tokenSafety: { liquidityUsd: string | null; riskFlagged: boolean; denylisted: boolean };
  copy: QuoteView["copy"];
  slippage: number;
  createdAt: number;
  expiresAt: number;
}

interface ExecState {
  request: RouteRequest;
  quote: ProviderQuote;
  completed: StepResult[];
  mode: "server" | "wallet" | "paper";
  pendingSteps: ExecStep[] | null;
  reQuoted: boolean;
  slippage: number;
}

export function isPaperMode(): boolean {
  return env().TRADING_MODE === "paper";
}

const gasReserve = () => fromBaseUnits(ARC_GAS_RESERVE_USDC6, CHAINS.arc.usdcDecimals);

export async function usdcBalance(userId: string): Promise<{ usdc: string; spendable: string; withdrawable: string }> {
  if (isPaperMode()) {
    const user = await db().query.users.findFirst({ where: eq(schema.users.id, userId) });
    const balance = user?.paperBalanceUsd ?? "0";
    return { usdc: D(balance).toFixed(), spendable: D(balance).toFixed(), withdrawable: D(balance).toFixed() };
  }
  const wallets = await loadSigningWallets(userId);
  const raw = await arcUsdcBalance(wallets.evmAddress);
  const usdc = fromBaseUnits(raw, CHAINS.arc.usdcDecimals);
  const afterReserve = Decimal.max(D(usdc).sub(gasReserve()), 0).toFixed();
  // Trades are sponsored, so they can use it all. A withdrawal is sent by the wallet and still pays its own gas.
  return { usdc, spendable: gaslessEnabled() ? usdc : afterReserve, withdrawable: afterReserve };
}

async function spentToday(userId: string): Promise<string> {
  const since = new Date(Date.now() - 86_400_000);
  const [row] = await db()
    .select({ total: sql<string>`coalesce(sum(${schema.trades.usdIn}), 0)` })
    .from(schema.trades)
    .where(
      and(
        eq(schema.trades.userId, userId),
        eq(schema.trades.side, "buy"),
        gt(schema.trades.createdAt, since),
        inArray(schema.trades.status, ["pending", "source_confirmed", "filled"]),
      ),
    );
  return row?.total ?? "0";
}

export async function activeGrant(userId: string) {
  return db().query.signerGrants.findFirst({
    where: and(eq(schema.signerGrants.userId, userId), isNull(schema.signerGrants.revokedAt)),
    orderBy: desc(schema.signerGrants.grantedAt),
  });
}

export async function signerStatus(userId: string): Promise<SignerStatus> {
  const grant = await activeGrant(userId);
  const spent = await spentToday(userId);
  const active = !!grant && grant.expiresAt.getTime() > Date.now();
  let flashApproved = !!grant?.approvalTx;
  if (!isPaperMode() && !flashApproved) {
    const wallets = await loadSigningWallets(userId).catch(() => null);
    if (wallets) {
      const allowance = await erc20Allowance("arc", ARC_USDC, wallets.evmAddress, FLASH_ALLOWANCE_ARC).catch(() => 0n);
      flashApproved = allowance > 0n;
    }
  }
  return {
    active,
    grantedAt: grant?.grantedAt.toISOString() ?? null,
    expiresAt: grant?.expiresAt.toISOString() ?? null,
    perTradeCapUsd: D(grant?.perTradeCapUsd ?? CAP_DEFAULTS.perTradeUsd).toFixed(),
    dailyCapUsd: D(grant?.dailyCapUsd ?? CAP_DEFAULTS.dailyUsd).toFixed(),
    spentTodayUsd: D(spent).toFixed(),
    flashApproved,
    approvalTx: grant?.approvalTx ?? null,
  };
}

function capIssue(reason: "per_trade" | "daily"): GuardrailIssue {
  return reason === "per_trade"
    ? { code: "size_over_pool_share", message: "This is above your per-trade limit for one-tap." }
    : { code: "size_over_pool_share", message: "This would pass your daily limit for one-tap." };
}

interface OneTapDecision {
  oneTap: boolean;
  confirmReasons: GuardrailIssue[];
  signerReady: boolean;
}

async function decideOneTap(record: QuoteRecord): Promise<OneTapDecision> {
  const confirmReasons = [...record.guardrails.confirm];
  const status = await signerStatus(record.userId);
  if (record.request.side === "buy" && status.active) {
    const caps = checkSpendCaps({
      amountUsd: record.request.notionalUsd,
      spentTodayUsd: status.spentTodayUsd,
      perTradeCapUsd: status.perTradeCapUsd,
      dailyCapUsd: status.dailyCapUsd,
    });
    if (!caps.allowed) confirmReasons.push(capIssue(caps.reason!));
  }
  const solanaOrigin = record.request.side === "sell" && record.request.chain === "solana";
  const signerReady = status.active && (isPaperMode() || (solanaOrigin ? solanaSigningConfigured() : serverSigningConfigured()));
  return { oneTap: signerReady && confirmReasons.length === 0 && record.guardrails.blocked.length === 0, confirmReasons, signerReady };
}

async function recordToView(record: QuoteRecord): Promise<QuoteView> {
  const { request: req, winner } = record;
  const decision = await decideOneTap(record);
  const isBuy = req.side === "buy";
  const out = D(winner.expectedOut);
  const price = isBuy
    ? out.gt(0)
      ? D(req.usdcIn!).div(out).toFixed()
      : req.priceUsd
    : D(req.qtyIn!).gt(0)
      ? out.div(req.qtyIn!).toFixed()
      : req.priceUsd;
  return {
    id: record.id,
    side: req.side,
    token: record.token,
    amountInUsd: req.notionalUsd,
    expectedQty: isBuy ? winner.expectedOut : req.qtyIn!,
    qtyIn: isBuy ? null : req.qtyIn!,
    expectedOutUsd: winner.netOutputUsd,
    priceUsd: price,
    feeUsd: winner.feeUsd,
    gasUsd: winner.gasUsd,
    etaSeconds: winner.etaSeconds,
    priceImpact: winner.priceImpact,
    slippage: record.slippage,
    warnings: record.guardrails.warnings,
    confirmReasons: decision.confirmReasons,
    blocked: record.guardrails.blocked,
    oneTap: decision.oneTap,
    expiresAt: record.expiresAt,
    route: {
      provider: winner.provider,
      crossChain: winner.crossChain,
      alternatives: record.alternatives.map(({ provider, netOutputUsd, error, latencyMs }) => ({ provider, netOutputUsd, error, latencyMs })),
      sponsoredSetup: winner.sponsoredSetup,
      needsSetup: winner.needsSetup,
    },
    copy: record.copy,
  };
}

async function openPosition(userId: string, chain: ChainKey, address: string, tx: Db = db()) {
  return tx.query.positions.findFirst({
    where: and(
      eq(schema.positions.userId, userId),
      eq(schema.positions.tokenChain, chain),
      eq(schema.positions.tokenAddr, normalizeAddress(chain, address)),
      isNull(schema.positions.closedAt),
    ),
  });
}

/** Trims to what the token can actually represent, so a provider never sees excess precision. */
function truncateToDecimals(qty: Decimal, decimals: number | null): string {
  return qty.toDecimalPlaces(decimals ?? 18, Decimal.ROUND_DOWN).toFixed();
}

export async function createQuote(userId: string, input: QuoteRequest): Promise<QuoteView> {
  const { chain, side } = input;
  const address = normalizeAddress(chain, input.address);
  const user = await db().query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw notFound("Account");

  const detail = await getTokenDetail(chain, address);
  if (!detail) throw notFound("Token");
  if (!detail.priceUsd) throw unprocessable("no_price", "This token has no live price right now.");

  const wallets = await loadSigningWallets(userId);
  if (chain === "solana" && !wallets.solanaAddress) {
    throw unprocessable("no_solana_wallet", "Your Solana wallet isn't ready yet. Try signing out and back in.");
  }

  let usdcIn: string | undefined;
  let qtyIn: string | undefined;
  let notionalUsd: string;
  let copy: QuoteView["copy"] = null;

  if (side === "buy") {
    let amount = D(input.amountUsd!);
    if (input.copyThesisId) {
      const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, input.copyThesisId) });
      if (!thesis) throw notFound("Thesis");
      // Copy-buys are capped so followers can't become one poster's exit liquidity.
      amount = Decimal.min(amount, COPY_BUY_CAP_USD);
      copy = { thesisId: thesis.id, authorEntry: thesis.authorAvgEntry, capUsd: COPY_BUY_CAP_USD };
    }
    // No minimum of our own. USDC just can't go below 6 decimals, and routes refuse what they can't serve.
    amount = amount.toDecimalPlaces(CHAINS.arc.usdcDecimals, Decimal.ROUND_DOWN);
    if (amount.lte(0)) throw badRequest("amount_too_small", "That's smaller than USDC can represent.");
    const balance = await usdcBalance(userId);
    if (amount.gt(balance.spendable)) {
      throw unprocessable("insufficient_balance", "You don't have enough USDC for this trade.", balance);
    }
    usdcIn = amount.toFixed();
    notionalUsd = usdcIn;
  } else {
    const position = await openPosition(userId, chain, address);
    if (!position) throw unprocessable("no_position", "You don't hold this token.");
    let held = D(position.qty);
    if (!isPaperMode()) {
      const owner = chain === "solana" ? wallets.solanaAddress! : wallets.evmAddress;
      const onChain = await tokenBalance(chain, address, owner).catch(() => null);
      if (onChain !== null) held = D(onChain);
    }
    const qty = input.sellPct === 100 ? held : held.mul(input.sellPct!).div(100);
    qtyIn = truncateToDecimals(qty, detail.decimals);
    if (D(qtyIn).lte(0)) throw unprocessable("no_position", "There's nothing to sell.");
    notionalUsd = D(qtyIn).mul(detail.priceUsd).toFixed();
  }

  const request: RouteRequest = {
    side,
    chain,
    address,
    decimals: detail.decimals,
    usdcIn,
    qtyIn,
    evmAddress: wallets.evmAddress,
    solanaAddress: wallets.solanaAddress,
    priceUsd: detail.priceUsd,
    notionalUsd,
  };
  const { winner, alternatives } = await raceQuotes(request, { liquidityUsd: detail.liquidityUsd });
  if (!winner) {
    const reason = alternatives.find((a) => a.error)?.error;
    logger.warn({ chain, address, side, reason }, "no route");
    const message = D(notionalUsd).lt(1) ? "No route can take an amount this small. Try a larger one." : "No route is available for this trade right now.";
    throw unprocessable("no_route", message, { alternatives });
  }
  const tokenSafety = {
    liquidityUsd: detail.liquidityUsd,
    riskFlagged: detail.riskFlagged,
    denylisted: false,
  };
  const token: TokenRef = { chain, address, symbol: detail.symbol, name: detail.name, imageUrl: detail.imageUrl };
  const now = Date.now();
  const record: QuoteRecord = {
    id: randomUUID(),
    userId,
    request,
    winner,
    alternatives,
    guardrails: applyGuardrails(request, winner, tokenSafety),
    token,
    tokenSafety,
    copy,
    slippage: resolveSlippage(!winner.crossChain),
    createdAt: now,
    expiresAt: now + QUOTE_FRESH_MS,
  };
  await redis().set(KEYS.quote(record.id), JSON.stringify(record), "EX", QUOTE_RECORD_TTL_S);
  await rememberToken(token, detail.decimals);
  return recordToView(record);
}

export function tradeToView(row: typeof schema.trades.$inferSelect, token: TokenRef): TradeView {
  const state = row.execState as ExecState | null;
  return {
    id: row.id,
    side: row.side,
    token,
    status: row.status,
    usdIn: row.usdIn,
    usdOut: row.usdOut,
    qty: row.qty,
    priceUsd: row.priceUsd,
    feeUsd: row.feeUsd,
    provider: row.provider as ProviderId,
    srcChain: row.srcChain as ChainKey,
    srcTx: row.srcTx,
    dstTx: row.dstTx,
    isPaper: row.isPaper,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    filledAt: row.filledAt?.toISOString() ?? null,
    pendingSteps: row.status === "awaiting_signature" ? (state?.pendingSteps ?? null) : null,
  };
}

export async function tokenRefFor(chain: string, address: string): Promise<TokenRef> {
  const row = await db().query.tokens.findFirst({ where: and(eq(schema.tokens.chain, chain), eq(schema.tokens.address, address)) });
  return {
    chain: chain as ChainKey,
    address,
    symbol: row?.symbol ?? "?",
    name: row?.name ?? "Unknown",
    imageUrl: row?.imageUrl ?? null,
  };
}

async function publishTrade(tradeId: string) {
  const row = await db().query.trades.findFirst({ where: eq(schema.trades.id, tradeId) });
  if (!row) return null;
  const view = tradeToView(row, await tokenRefFor(row.tokenChain, row.tokenAddr));
  await publish(CHANNELS.user(row.userId), { type: "trade", trade: view });
  return view;
}

async function audit(userId: string, action: string, detail: unknown) {
  await db().insert(schema.auditLog).values({ userId, action, detail: detail as object });
}

function friendlyFailure(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof HttpError) {
    if (err.status === 429) return "The trading venue is busy. Try again in a moment.";
    try {
      const parsed = JSON.parse(err.body) as { error?: { message?: string } | string; message?: string };
      const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
      if (message) return message;
    } catch {
      // Not JSON, so fall through to the generic message.
    }
    return "The trading venue rejected this order.";
  }
  if (err instanceof Error) {
    if (/insufficient funds/i.test(err.message)) return "Not enough balance to cover this and its gas.";
    if (/Refusing to sign/.test(err.message)) return err.message;
    // Gas estimation runs the trade without sending it, so this failure costs nothing.
    if (err.name === "EstimateGasExecutionError" || /estimate ?gas/i.test(err.message)) return "This trade would fail right now, so nothing was sent.";
    if (/reverted/i.test(err.message)) return "The transaction reverted on-chain.";
  }
  return "The trade couldn't be completed.";
}

export async function executeTrade(
  userId: string,
  input: { quoteId: string; idempotencyKey: string; confirmed?: boolean },
): Promise<TradeView> {
  const existing = await db().query.trades.findFirst({
    where: and(eq(schema.trades.userId, userId), eq(schema.trades.idempotencyKey, input.idempotencyKey)),
  });
  if (existing) return tradeToView(existing, await tokenRefFor(existing.tokenChain, existing.tokenAddr));

  const raw = await redis().get(KEYS.quote(input.quoteId));
  if (!raw) throw new AppError(410, "quote_expired", "That price expired. Get a new one and try again.");
  let record = JSON.parse(raw) as QuoteRecord;
  if (record.userId !== userId) throw forbidden();

  // Single use: a replayed quote id can't place a second order.
  const fresh = await redis().set(KEYS.quoteUsed(input.quoteId), "1", "EX", QUOTE_RECORD_TTL_S, "NX");
  if (!fresh) throw conflict("quote_used", "That quote was already used.");

  let reQuoted = false;
  if (Date.now() > record.expiresAt) {
    // Expired quote: re-quote once. If the price moved past tolerance, the user decides.
    const previousOut = record.winner.netOutputUsd;
    const next = await raceQuotes(record.request, { liquidityUsd: record.tokenSafety.liquidityUsd });
    if (!next.winner) throw unprocessable("no_route", "No route is available for this trade right now.");
    if (!withinTolerance(previousOut, next.winner.netOutputUsd, GUARDRAILS.requoteTolerance)) {
      throw conflict("price_moved", "The price moved. Check the new quote before trading.");
    }
    record = {
      ...record,
      winner: next.winner,
      alternatives: next.alternatives,
      guardrails: applyGuardrails(record.request, next.winner, record.tokenSafety),
    };
    reQuoted = true;
  }

  if (record.guardrails.blocked.length) {
    throw unprocessable("blocked", record.guardrails.blocked[0]!.message, { blocked: record.guardrails.blocked });
  }

  const decision = await decideOneTap(record);
  if (!decision.oneTap && !input.confirmed) {
    throw conflict("needs_confirm", decision.confirmReasons[0]?.message ?? "Confirm this trade to continue.", {
      reasons: decision.confirmReasons,
    });
  }

  const paper = isPaperMode();
  // Gas sponsorship runs through the server's signer, so a gasless trade always needs a live grant. A
  // trade over a cap has just been confirmed in the app, and it's signed the same way so it costs no gas.
  if (!paper && gaslessEnabled() && !decision.signerReady) {
    throw conflict("needs_one_tap", "Turn on one-tap trading to trade with no gas.");
  }
  const serverSigned = decision.oneTap || (gaslessEnabled() && decision.signerReady && !!input.confirmed);
  const mode: ExecState["mode"] = paper ? "paper" : serverSigned ? "server" : "wallet";
  const { request, winner } = record;
  const state: ExecState = { request, quote: winner, completed: [], mode, pendingSteps: null, reQuoted, slippage: record.slippage };
  const srcChain: ChainKey = request.side === "buy" ? "arc" : request.chain;

  const [trade] = await db()
    .insert(schema.trades)
    .values({
      userId,
      side: request.side,
      tokenChain: request.chain,
      tokenAddr: request.address,
      usdIn: request.side === "buy" ? request.usdcIn : null,
      qty: request.side === "sell" ? request.qtyIn : null,
      provider: winner.provider,
      srcChain,
      status: "pending",
      isPaper: paper,
      idempotencyKey: input.idempotencyKey,
      copiedThesisId: record.copy?.thesisId ?? null,
      execState: state,
    })
    .returning();
  if (!trade) throw new Error("Trade insert returned nothing.");

  await audit(userId, "trade_created", {
    tradeId: trade.id,
    side: request.side,
    chain: request.chain,
    token: request.address,
    notionalUsd: request.notionalUsd,
    provider: winner.provider,
    mode,
    confirmed: input.confirmed ?? false,
  });
  if (mode === "server") await flagUnusualVolume(userId, trade.id);

  if (paper) {
    await redis().set(`paper:fill:${trade.id}`, String(Date.now() + winner.etaSeconds * 1000), "EX", 600);
    return (await publishTrade(trade.id))!;
  }
  await drive(trade.id);
  return (await publishTrade(trade.id))!;
}

const UNUSUAL_TRADES_PER_MINUTE = 10;

/** A burst of server-signed trades is what a compromised key looks like, so it raises an alert. */
async function flagUnusualVolume(userId: string, tradeId: string) {
  const key = `signer:rate:${userId}`;
  const count = await redis().incr(key);
  if (count === 1) await redis().expire(key, 60);
  if (count > UNUSUAL_TRADES_PER_MINUTE) {
    logger.error({ userId, tradeId, count }, "ALERT: unusual server-signed trade volume");
    await audit(userId, "unusual_volume", { tradeId, tradesLastMinute: count });
  }
}

async function saveState(tradeId: string, patch: Partial<typeof schema.trades.$inferInsert>) {
  await db().update(schema.trades).set({ ...patch, updatedAt: new Date() }).where(eq(schema.trades.id, tradeId));
}

/** Moves a live trade forward until it's submitted, or until the wallet has to sign something. */
async function drive(tradeId: string): Promise<void> {
  const trade = await db().query.trades.findFirst({ where: eq(schema.trades.id, tradeId) });
  if (!trade) return;
  const state = trade.execState as ExecState;
  const provider = PROVIDERS[state.quote.provider];
  const wallets: SigningWallets | null = state.mode === "server" ? await loadSigningWallets(trade.userId) : null;

  try {
    for (let i = 0; i < MAX_STEPS; i++) {
      let next;
      try {
        next = await provider.advance({ tradeId, userId: trade.userId, request: state.request, quote: state.quote, completed: state.completed });
      } catch (err) {
        if (await tryRequoteOnce(err, state, tradeId)) continue;
        throw err;
      }
      if ("done" in next) {
        state.pendingSteps = null;
        await saveState(tradeId, {
          status: "pending",
          providerOrderId: next.done.providerOrderId ?? null,
          srcTx: next.done.srcTx ?? null,
          execState: state,
        });
        await audit(trade.userId, "trade_submitted", { tradeId, ...next.done });
        return;
      }
      if (state.mode === "wallet") {
        state.pendingSteps = next.steps;
        await saveState(tradeId, { status: "awaiting_signature", execState: state });
        return;
      }
      for (const step of next.steps) {
        const result = await performServerStep(wallets!, step, { userId: trade.userId, tradeId });
        state.completed.push(result);
        await audit(trade.userId, "signer_used", { tradeId, step: step.id, kind: step.kind, chain: step.chain, txHash: result.txHash ?? null });
        await saveState(tradeId, { execState: state });
      }
    }
    throw new Error("Too many signing steps.");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, tradeId }, "trade failed during execution");
    await saveState(tradeId, { status: "failed", error: friendlyFailure(err), execState: state });
    await db().insert(schema.providerEvents).values({ provider: state.quote.provider, kind: "fail" });
    await audit(trade.userId, "trade_failed", { tradeId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Expired at submit: one fresh quote at the same slippage, and only if the price still holds. */
async function tryRequoteOnce(err: unknown, state: ExecState, tradeId: string): Promise<boolean> {
  if (state.reQuoted) return false;
  if (!(err instanceof HttpError) || err.status >= 500 || !/expire|stale|deadline/i.test(err.body)) return false;
  const provider = PROVIDERS[state.quote.provider];
  const next = await provider.quote(state.request).catch(() => null);
  if (!next || !withinTolerance(state.quote.netOutputUsd, next.netOutputUsd, GUARDRAILS.requoteTolerance)) return false;
  state.quote = next;
  state.reQuoted = true;
  // Keep on-chain work like approvals, but anything signed against the old quote must be redone.
  state.completed = state.completed.filter((s) => !!s.txHash);
  await saveState(tradeId, { execState: state });
  return true;
}

/** Results for steps the wallet just signed. Picks the trade back up from where it paused. */
export async function submitWalletSteps(userId: string, tradeId: string, results: StepResult[]): Promise<TradeView> {
  const trade = await db().query.trades.findFirst({ where: and(eq(schema.trades.id, tradeId), eq(schema.trades.userId, userId)) });
  if (!trade) throw notFound("Trade");
  if (trade.status !== "awaiting_signature") throw conflict("not_awaiting", "This trade isn't waiting for a signature.");
  const state = trade.execState as ExecState;
  const expected = new Set((state.pendingSteps ?? []).map((s) => s.id));
  for (const result of results) {
    if (!expected.has(result.id)) throw badRequest("unknown_step", "That signature isn't for this trade.");
    state.completed.push(result);
  }
  state.pendingSteps = null;
  await saveState(tradeId, { status: "pending", execState: state });
  await drive(tradeId);
  return (await publishTrade(tradeId))!;
}

/** Applies a provider status to a trade. On a fill, updates the position exactly once. */
export async function applyStatus(tradeId: string, update: StatusUpdate): Promise<void> {
  const outcome = await db().transaction(async (tx) => {
    const [trade] = await tx.select().from(schema.trades).where(eq(schema.trades.id, tradeId)).for("update");
    if (!trade) return null;
    if (TERMINAL_STATUSES.includes(trade.status as TradeStatus)) return null;
    const terminal = TERMINAL_STATUSES.includes(update.status);
    const fields: Partial<typeof schema.trades.$inferInsert> = {
      status: update.status,
      updatedAt: new Date(),
      ...(update.srcTx ? { srcTx: update.srcTx } : {}),
      ...(update.dstTx ? { dstTx: update.dstTx } : {}),
      ...(update.error ? { error: update.error } : {}),
    };
    if (update.status === "filled") {
      if (!update.qty || D(update.qty).lte(0)) {
        fields.status = "failed";
        fields.error = "The fill reported no tokens.";
      } else {
        fields.qty = update.qty;
        fields.priceUsd = update.priceUsd ?? null;
        fields.feeUsd = update.feeUsd ?? null;
        fields.filledAt = new Date();
        fields.applied = true;
        if (update.usdIn) fields.usdIn = update.usdIn;
        if (update.usdOut) fields.usdOut = update.usdOut;
        await applyFillToPosition(tx as unknown as Db, trade, update);
      }
    }
    await tx.update(schema.trades).set(fields).where(eq(schema.trades.id, tradeId));
    return { trade, status: fields.status as TradeStatus, terminal };
  });
  if (!outcome) return;
  await publishTrade(tradeId);
  if (outcome.terminal) {
    await db()
      .insert(schema.providerEvents)
      .values({ provider: outcome.trade.provider, kind: outcome.status === "filled" ? "fill" : "fail" });
    await notifyTradeResult(outcome.trade, outcome.status);
  }
}

async function applyFillToPosition(tx: Db, trade: typeof schema.trades.$inferSelect, update: StatusUpdate) {
  const [row] = await tx
    .select()
    .from(schema.positions)
    .where(
      and(
        eq(schema.positions.userId, trade.userId),
        eq(schema.positions.tokenChain, trade.tokenChain),
        eq(schema.positions.tokenAddr, trade.tokenAddr),
        isNull(schema.positions.closedAt),
      ),
    )
    .for("update");
  const state: PositionState = row
    ? { qty: row.qty, costBasisUsd: row.costBasisUsd, realizedPnlUsd: row.realizedPnlUsd }
    : EMPTY_POSITION;

  if (trade.side === "buy") {
    const usdIn = update.usdIn ?? trade.usdIn ?? "0";
    const next = applyBuy(state, { qty: update.qty!, usdSpent: usdIn, feesUsd: update.extraCostUsd });
    if (row) {
      await tx.update(schema.positions).set({ qty: next.qty, costBasisUsd: next.costBasisUsd }).where(eq(schema.positions.id, row.id));
    } else {
      await tx.insert(schema.positions).values({
        userId: trade.userId,
        tokenChain: trade.tokenChain,
        tokenAddr: trade.tokenAddr,
        qty: next.qty,
        costBasisUsd: next.costBasisUsd,
      });
    }
    if (trade.isPaper) {
      await tx
        .update(schema.users)
        .set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} - ${usdIn}::numeric` })
        .where(eq(schema.users.id, trade.userId));
    }
    return;
  }
  const usdOut = update.usdOut ?? "0";
  if (row) {
    const result = applySell(state, { qty: update.qty!, usdReceived: usdOut, feesUsd: update.extraCostUsd });
    await tx
      .update(schema.positions)
      .set({
        qty: result.state.qty,
        costBasisUsd: result.state.costBasisUsd,
        realizedPnlUsd: result.state.realizedPnlUsd,
        ...(result.closed ? { closedAt: new Date() } : {}),
      })
      .where(eq(schema.positions.id, row.id));
  }
  if (trade.isPaper) {
    await tx
      .update(schema.users)
      .set({ paperBalanceUsd: sql`${schema.users.paperBalanceUsd} + ${usdOut}::numeric` })
      .where(eq(schema.users.id, trade.userId));
  }
}

async function notifyTradeResult(trade: typeof schema.trades.$inferSelect, status: TradeStatus) {
  const token = await tokenRefFor(trade.tokenChain, trade.tokenAddr);
  const verb = trade.side === "buy" ? "Bought" : "Sold";
  const message =
    status === "filled"
      ? `${verb} ${token.symbol}`
      : status === "refunded"
        ? `Your ${token.symbol} ${trade.side} was refunded`
        : `Your ${token.symbol} ${trade.side} didn't go through`;
  await notify(trade.userId, { type: "trade_update", message, tokenChain: trade.tokenChain, tokenAddr: trade.tokenAddr }, { push: true });
  if (status === "filled" && trade.copiedThesisId) {
    const thesis = await db().query.theses.findFirst({ where: eq(schema.theses.id, trade.copiedThesisId) });
    if (thesis && thesis.userId !== trade.userId) {
      await notify(thesis.userId, {
        type: "copy_buy",
        actorId: trade.userId,
        thesisId: thesis.id,
        message: `Someone bought ${token.symbol} from your thesis`,
        tokenChain: trade.tokenChain,
        tokenAddr: trade.tokenAddr,
      });
    }
  }
}

/** Run by the indexer: checks each in-flight trade with its provider. */
export async function pollActiveTrades(limit = 50): Promise<number> {
  const staleBefore = new Date(Date.now() - 2_000);
  const active = await db()
    .select()
    .from(schema.trades)
    .where(and(inArray(schema.trades.status, ["pending", "source_confirmed"]), or(lt(schema.trades.updatedAt, staleBefore), eq(schema.trades.isPaper, true))))
    .orderBy(schema.trades.updatedAt)
    .limit(limit);
  await Promise.all(
    active.map(async (trade) => {
      try {
        const state = trade.execState as ExecState;
        if (trade.isPaper) {
          const due = await redis().get(`paper:fill:${trade.id}`);
          if (due && Date.now() < Number(due)) return;
          if (trade.side === "buy") {
            const user = await db().query.users.findFirst({ where: eq(schema.users.id, trade.userId) });
            if (user && D(user.paperBalanceUsd).lt(trade.usdIn ?? 0)) {
              await applyStatus(trade.id, { status: "failed", error: "Not enough paper balance." });
              return;
            }
          }
          await applyStatus(trade.id, paperFill(state.request, state.quote));
          return;
        }
        if (!trade.providerOrderId && !trade.srcTx) {
          // Still being signed and submitted. The provider has nothing to report yet, and asking it would
          // mark a live trade as failed while its order goes out anyway. Only a stalled one gets closed.
          if (Date.now() - trade.updatedAt.getTime() > UNSUBMITTED_TIMEOUT_MS) {
            await applyStatus(trade.id, { status: "failed", error: "This trade couldn't be submitted." });
          }
          return;
        }
        const update = await PROVIDERS[state.quote.provider].status({
          request: state.request,
          quote: state.quote,
          providerOrderId: trade.providerOrderId,
          srcTx: trade.srcTx,
        });
        if (update.status !== trade.status || TERMINAL_STATUSES.includes(update.status)) {
          await applyStatus(trade.id, update);
        } else {
          await saveState(trade.id, {});
        }
      } catch (err) {
        logger.warn({ tradeId: trade.id, err: err instanceof Error ? err.message : err }, "status poll failed");
      }
    }),
  );
  return active.length;
}

export { getSnapshot, tokenKey };
