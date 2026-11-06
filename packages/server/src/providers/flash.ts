import {
  ARC_USDC,
  CHAINS,
  D,
  Decimal,
  FLASH_ALLOWANCE_ARC,
  GUARDRAILS,
  PERMIT2,
  TWO_STEP_CONNECTORS,
  normalizeAddress,
  resolveSlippage,
  toBaseUnits,
  type ChainKey,
  type ExecStep,
} from "@frontrun/core";
import { and, eq, isNull } from "drizzle-orm";
import { decodeFunctionData, erc20Abi, type Hex } from "viem";
import { db, schema } from "../db/client";
import { env } from "../env";
import { fetchJson, HttpError, RateLimiter } from "../http";
import type { AdvanceResult, ExecContext, ProviderQuote, RouteProvider, RouteRequest, StatusInput, StatusUpdate } from "./types";
import { completedStep, isCrossChain, recipientOn, spentChain } from "./types";

const BASE = "https://flash.definitive.fi/v1";

/** Flash allows 5 requests per second per endpoint per key. */
const quoteLimiter = new RateLimiter(280, 5);
const orderLimiter = new RateLimiter(280, 5);
const statusLimiter = new RateLimiter(280, 5);

function headers() {
  return { "x-definitive-api-key": env().FLASH_API_KEY ?? "" };
}

export interface FlashQuoteRaw {
  quoteId: string;
  bridgeQuoteId?: string | null;
  from: { amount: string; notional: string };
  to: { amount: string; notional: string };
  fees: { estimatedFeeNotional: string };
  estimatedPriceImpact?: string | null;
  recommendedSlippage?: string | null;
  evm?: { approveTx?: { to: string; data: string } | null; permitTypedData?: string | null; orderTypedData?: string | null } | null;
  svm?: {
    orderMessage?: string;
    nonce?: string;
    deadline?: string;
    sponsoredDelegateTx?: string | null;
    delegateIx?: unknown;
    ataSetupIxs?: unknown[] | null;
  } | null;
  setupTxs?: string[] | null;
  /** Ours, not Flash's: the fee this quote was requested with. */
  feeBps?: number;
  topupRecovered?: boolean;
}

const MAX_INTEGRATOR_FEE_BPS = 1000;

async function unsettledTopupBps(ctx: ExecContext): Promise<number> {
  const rows = await db()
    .select({ costUsd: schema.gasTopups.costUsd })
    .from(schema.gasTopups)
    .where(and(eq(schema.gasTopups.tradeId, ctx.tradeId), isNull(schema.gasTopups.settledAt)));
  if (!rows.length) return 0;
  const cost = rows.reduce((sum, r) => sum.add(r.costUsd), D(0));
  const notional = D(ctx.request.notionalUsd);
  return notional.gt(0) ? Math.ceil(cost.div(notional).mul(10_000).toNumber()) : 0;
}

interface FlashParams {
  targetChain: string;
  contraChain: string;
  targetAsset: string;
  contraAsset: string;
  side: "buy" | "sell";
  qty: string;
  orderType: "market";
  funderAddress: string;
  recipientAddress?: string;
  maxSlippage: string;
  maxPriceImpact: string;
  flashIntegratorFeeBps?: string;
}

export function buildFlashParams(req: RouteRequest, feeBps: number): FlashParams {
  const crossChain = isCrossChain(req);
  const source = spentChain(req);
  const params: FlashParams = {
    targetChain: CHAINS[req.chain].flashSlug,
    contraChain: req.contra ? CHAINS[req.contra.chain].flashSlug : "arc",
    targetAsset: req.address,
    contraAsset: req.contra?.asset ?? ARC_USDC,
    side: req.side,
    qty: req.side === "buy" ? req.usdcIn! : req.qtyIn!,
    orderType: "market",
    funderAddress: recipientOn(req, source),
    maxSlippage: String(resolveSlippage(!crossChain)),
    maxPriceImpact: String(GUARDRAILS.routePriceImpactCap),
  };
  if (crossChain) {
    // The funds land on the side the user isn't spending from.
    params.recipientAddress = recipientOn(req, req.side === "buy" ? req.chain : "arc");
  }
  if (feeBps > 0) params.flashIntegratorFeeBps = String(feeBps);
  return params;
}

export interface FlashExpectations {
  funder: string;
  spentToken: string;
  /** Amount in the spent token's base units. Omitted when decimals aren't known. */
  fromAmount?: bigint;
  chainId: number;
}

/**
 * Trade sanity, run before anything is signed. The server holds signing power, so it never signs a
 * payload just because a provider returned it. The signed FlashOrder has no output floor and, on
 * cross-chain orders, its `recipient` is Flash's bridge address rather than the user, so the
 * recipient can't be pinned here and is pinned in the quote request instead.
 */
export function assertOrderMatches(typedDataJson: string, expected: FlashExpectations) {
  const typed = JSON.parse(typedDataJson) as {
    domain: { name?: string; chainId?: string | number; verifyingContract?: string };
    primaryType: string;
    message: { swapper?: string; fromToken?: string; fromAmount?: string };
  };
  const fail = (what: string) => {
    throw new Error(`Refusing to sign: ${what} doesn't match the quote.`);
  };
  if (typed.primaryType !== "FlashOrder") fail("order type");
  if (typed.domain.name !== "DefinitiveFlashAllowance") fail("signing domain");
  if (Number(typed.domain.chainId) !== expected.chainId) fail("chain");
  if (typed.message.swapper?.toLowerCase() !== expected.funder.toLowerCase()) fail("wallet");
  if (typed.message.fromToken?.toLowerCase() !== expected.spentToken.toLowerCase()) fail("spent token");
  if (expected.fromAmount !== undefined && BigInt(typed.message.fromAmount ?? 0) !== expected.fromAmount) fail("amount");
}

/** The approval must target the spent token and name only a known spender. */
export function assertApprovalMatches(tx: { to: string; data: string }, spentToken: string, knownSpenders: string[]) {
  if (tx.to.toLowerCase() !== spentToken.toLowerCase()) throw new Error("Refusing to sign: approval targets the wrong token.");
  const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex });
  if (decoded.functionName !== "approve") throw new Error("Refusing to sign: the setup call isn't an approval.");
  const spender = (decoded.args as readonly [string, bigint])[0].toLowerCase();
  if (!knownSpenders.some((s) => s.toLowerCase() === spender)) throw new Error("Refusing to sign: approval names an unknown spender.");
}

const KNOWN_SPENDERS = [FLASH_ALLOWANCE_ARC, PERMIT2];

function quoteToProvider(raw: FlashQuoteRaw, req: RouteRequest, latencyMs: number): ProviderQuote {
  const crossChain = isCrossChain(req);
  const source = spentChain(req);
  const hasEvmSetup = !!raw.evm?.approveTx;
  const hasSvmSetup = !!(raw.svm?.delegateIx || raw.svm?.sponsoredDelegateTx || raw.svm?.ataSetupIxs?.length);
  const received = raw.to.amount;
  // On a sell the output notional is USDC, so it's the same as the amount.
  return {
    provider: "flash",
    netOutputUsd: raw.to.notional,
    expectedOut: received,
    feeUsd: raw.fees?.estimatedFeeNotional ?? "0",
    gasUsd: "0",
    // Real cross-chain fills from Arc to Base have taken about 40 seconds.
    etaSeconds: crossChain ? 40 : 3,
    priceImpact: raw.estimatedPriceImpact != null ? Number(raw.estimatedPriceImpact) : null,
    recommendedSlippage: raw.recommendedSlippage != null ? Number(raw.recommendedSlippage) : null,
    crossChain,
    needsSetup: hasEvmSetup || hasSvmSetup,
    sponsoredSetup: source !== "arc" && CHAINS[source].privySponsored,
    latencyMs,
    raw,
  };
}

async function requestQuote(req: RouteRequest, feeBps: number, signal?: AbortSignal): Promise<FlashQuoteRaw> {
  await quoteLimiter.acquire();
  return fetchJson<FlashQuoteRaw>(`${BASE}/quote`, {
    method: "POST",
    headers: headers(),
    body: buildFlashParams(req, feeBps),
    timeoutMs: 4_000,
    signal,
  });
}

type Connector = NonNullable<(typeof TWO_STEP_CONNECTORS)[ChainKey]>;

export interface TwoStepLeg {
  request: RouteRequest;
  raw: FlashQuoteRaw;
  orderId?: string | null;
  fill?: StatusUpdate;
}

/** Stored as the quote's raw field. A trade through this has two Flash orders, one after the other. */
export interface TwoStepRoute {
  twoStep: true;
  connector: Connector;
  current: 0 | 1;
  legs: [TwoStepLeg, TwoStepLeg];
  /** Bumped by whoever moves the trade on, so a second copy of the workers can't send the same order. */
  revision: number;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}

export function isTwoStep(raw: unknown): raw is TwoStepRoute {
  return typeof raw === "object" && raw !== null && (raw as { twoStep?: unknown }).twoStep === true;
}

export function isNoBridgeRoute(err: unknown): boolean {
  return err instanceof HttpError && err.status === 404 && /no bridge routes/i.test(err.body);
}

/** A sell starts on the token's chain and a buy starts on Arc, so the bridge comes second and first respectively. */
export function firstLegRequest(req: RouteRequest, c: Connector): RouteRequest {
  if (req.side === "sell") return { ...req, contra: { chain: req.chain, asset: c.address, decimals: c.decimals } };
  return { ...req, address: c.address, decimals: c.decimals, priceUsd: "1" };
}

export function secondLegRequest(req: RouteRequest, c: Connector, connectorQty: string): RouteRequest {
  if (req.side === "sell") return { ...req, address: c.address, decimals: c.decimals, qtyIn: connectorQty, priceUsd: "1", notionalUsd: connectorQty };
  return { ...req, usdcIn: connectorQty, notionalUsd: connectorQty, contra: { chain: req.chain, asset: c.address, decimals: c.decimals } };
}

/** The app's fee goes on the step that touches Arc, which is how every other trade pays it. */
function legFeeBps(leg: RouteRequest): number {
  return isCrossChain(leg) ? env().FLASH_INTEGRATOR_FEE_BPS : 0;
}

/** Quotes one step, and keeps its fee so the order that follows signs for the same one. */
export async function quoteLeg(leg: RouteRequest, signal?: AbortSignal): Promise<FlashQuoteRaw> {
  const feeBps = legFeeBps(leg);
  return { ...(await requestQuote(leg, feeBps, signal)), feeBps };
}

/** The stablecoin a finished first step left in the wallet. */
export function connectorReceived(side: RouteRequest["side"], fill: StatusUpdate): string {
  return (side === "sell" ? fill.usdOut : fill.qty) ?? "0";
}

/** Puts the two fills together as the one trade the person placed. */
export function finishTwoStep(req: Pick<RouteRequest, "side">, first: StatusUpdate, last: StatusUpdate): StatusUpdate {
  const sell = req.side === "sell";
  const qty = sell ? first.qty : last.qty;
  const usd = sell ? last.usdOut : first.usdIn;
  return {
    status: "filled",
    qty,
    ...(sell ? { usdOut: usd } : { usdIn: usd }),
    priceUsd: qty && usd && D(qty).gt(0) ? D(usd).div(qty).toFixed() : undefined,
    feeUsd: D(first.feeUsd ?? 0).add(last.feeUsd ?? 0).toFixed(),
    revenueUsd: D(first.revenueUsd ?? 0).add(last.revenueUsd ?? 0).toFixed(),
    srcTx: first.srcTx,
    dstTx: last.dstTx ?? last.srcTx,
  };
}

async function quoteTwoStep(req: RouteRequest, c: Connector, started: number, signal?: AbortSignal): Promise<ProviderQuote> {
  const first = firstLegRequest(req, c);
  const firstRaw = await quoteLeg(first, signal);
  const qty = D(firstRaw.to.amount).toDecimalPlaces(c.decimals, Decimal.ROUND_DOWN).toFixed();
  const second = secondLegRequest(req, c, qty);
  const secondRaw = await quoteLeg(second, signal);
  const impact = (raw: FlashQuoteRaw) => Math.max(Number(raw.estimatedPriceImpact ?? 0), 0);
  const route: TwoStepRoute = {
    twoStep: true,
    connector: c,
    current: 0,
    legs: [
      { request: first, raw: firstRaw },
      { request: second, raw: secondRaw },
    ],
    revision: 0,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  };
  return {
    provider: "flash",
    netOutputUsd: secondRaw.to.notional,
    expectedOut: secondRaw.to.amount,
    feeUsd: D(firstRaw.fees?.estimatedFeeNotional ?? 0).add(secondRaw.fees?.estimatedFeeNotional ?? 0).toFixed(),
    gasUsd: "0",
    etaSeconds: 45,
    priceImpact: impact(firstRaw) + impact(secondRaw),
    recommendedSlippage: null,
    crossChain: true,
    needsSetup: !!firstRaw.evm?.approveTx || !!secondRaw.evm?.approveTx,
    sponsoredSetup: false,
    latencyMs: Date.now() - started,
    raw: route,
  };
}

export const flashProvider: RouteProvider = {
  id: "flash",
  enabled: () => !!env().FLASH_API_KEY,
  supports: () => true,

  async quote(req, signal) {
    const started = Date.now();
    try {
      const raw = await requestQuote(req, env().FLASH_INTEGRATOR_FEE_BPS, signal);
      return quoteToProvider(raw, req, Date.now() - started);
    } catch (err) {
      const connector = TWO_STEP_CONNECTORS[req.chain];
      if (!connector || !isNoBridgeRoute(err) || normalizeAddress(req.chain, req.address) === connector.address) throw err;
      return quoteTwoStep(req, connector, started, signal);
    }
  },

  async advance(ctx: ExecContext): Promise<AdvanceResult> {
    const route = ctx.quote.raw;
    if (!isTwoStep(route)) return advanceOrder(ctx);
    const leg = route.legs[route.current];
    const legCtx = { ...ctx, request: leg.request, quote: { ...ctx.quote, raw: leg.raw } };
    const result = await advanceOrder(legCtx);
    leg.raw = legCtx.quote.raw as FlashQuoteRaw;
    return result;
  },

  async status(input: StatusInput): Promise<StatusUpdate> {
    if (!input.providerOrderId) return { status: "failed", error: "No order id" };
    const funder = recipientOn(input.request, spentChain(input.request));
    await statusLimiter.acquire();
    const res = await fetchJson<FlashOrderDetail>(
      `${BASE}/orders/${input.providerOrderId}?funderAddress=${encodeURIComponent(funder)}`,
      { headers: headers(), timeoutMs: 6_000, retries: 1 },
    );
    return flashStatusToUpdate(res, input.request);
  },
};

async function advanceOrder(ctx: ExecContext): Promise<AdvanceResult> {
  const { request: req } = ctx;
  let raw = ctx.quote.raw as FlashQuoteRaw;
  const source = spentChain(req);
  const steps: ExecStep[] = [];

  if (CHAINS[source].type === "solana") {
    for (const [i, tx] of (raw.setupTxs ?? []).entries()) {
      const id = `setup-${i}`;
      if (!completedStep(ctx, id)) {
        // Rent and fees for these come from the funder unless Privy sponsors them.
        steps.push({ id, kind: "svm_tx", chain: "solana", label: "Set up token account", transactionBase64: tx, broadcast: true, sponsor: true });
        return { steps };
      }
    }
    if (raw.svm?.sponsoredDelegateTx && !completedStep(ctx, "delegate")) {
      steps.push({ id: "delegate", kind: "svm_tx", chain: "solana", label: "Authorize selling", transactionBase64: raw.svm.sponsoredDelegateTx, broadcast: false });
    }
    if (!completedStep(ctx, "order")) {
      if (!raw.svm?.orderMessage) throw new Error("The quote came back without an order to sign.");
      steps.push({ id: "order", kind: "svm_message", chain: "solana", label: "Sign order", message: raw.svm.orderMessage });
    }
    if (steps.length) return { steps };
  } else {
    const spentToken = req.side === "buy" ? (req.contra?.asset ?? ARC_USDC) : req.address;
    if (raw.evm?.approveTx && !completedStep(ctx, "approve")) {
      assertApprovalMatches(raw.evm.approveTx, spentToken, KNOWN_SPENDERS);
      steps.push({
        id: "approve",
        kind: "evm_tx",
        chain: source,
        label: "Approve once",
        to: raw.evm.approveTx.to,
        data: raw.evm.approveTx.data,
        waitForReceipt: true,
      });
      return { steps };
    }
    if (completedStep(ctx, "approve") && !raw.topupRecovered) {
      // If the approval needed a gas top-up, re-quote with the cost added to the integrator fee,
      // so it comes out of this sell's proceeds instead of a separate transfer from the user.
      const extraBps = await unsettledTopupBps(ctx);
      if (extraBps > 0) {
        const feeBps = Math.min(env().FLASH_INTEGRATOR_FEE_BPS + extraBps, MAX_INTEGRATOR_FEE_BPS);
        const fresh = await requestQuote(req, feeBps);
        raw = { ...fresh, feeBps, topupRecovered: true };
        ctx.quote.raw = raw;
        ctx.quote.netOutputUsd = fresh.to.notional;
        ctx.quote.expectedOut = fresh.to.amount;
        await db().update(schema.gasTopups).set({ settledAt: new Date() }).where(and(eq(schema.gasTopups.tradeId, ctx.tradeId), isNull(schema.gasTopups.settledAt)));
      } else {
        raw = { ...raw, topupRecovered: true };
        ctx.quote.raw = raw;
      }
    }
    if (raw.evm?.permitTypedData && !completedStep(ctx, "permit")) {
      steps.push({ id: "permit", kind: "evm_typed_data", chain: source, label: "Approve Permit2", typedData: raw.evm.permitTypedData });
    }
    if (!completedStep(ctx, "order")) {
      const typed = raw.evm?.orderTypedData;
      if (!typed) throw new Error("The quote came back without an order to sign.");
      assertOrderMatches(typed, {
        funder: req.evmAddress,
        spentToken,
        chainId: CHAINS[source].chainId!,
        fromAmount:
          req.side === "buy"
            ? toBaseUnits(req.usdcIn!, req.contra?.decimals ?? CHAINS.arc.usdcDecimals)
            : req.decimals !== null
              ? toBaseUnits(req.qtyIn!, req.decimals)
              : undefined,
      });
      steps.push({ id: "order", kind: "evm_typed_data", chain: source, label: "Sign order", typedData: typed });
    }
    if (steps.length) return { steps };
  }

  const signature = completedStep(ctx, "order")?.signature;
  if (!signature) throw new Error("Order signature is missing.");
  const permit = completedStep(ctx, "permit")?.signature;
  const delegate = completedStep(ctx, "delegate")?.signedTransaction;
  const body = {
    // The fee on the order has to equal the fee on the quote it signs.
    ...buildFlashParams(req, raw.feeBps ?? env().FLASH_INTEGRATOR_FEE_BPS),
    quoteId: raw.quoteId,
    ...(raw.bridgeQuoteId ? { bridgeQuoteId: raw.bridgeQuoteId } : {}),
    userSignature: signature,
    ...(CHAINS[source].type === "evm"
      ? {
          evmOrderTypedData: raw.evm?.orderTypedData,
          ...(permit ? { evmPermitTypedData: raw.evm?.permitTypedData, evmPermitSignature: permit } : {}),
        }
      : {
          svmNonce: raw.svm?.nonce,
          svmDeadline: raw.svm?.deadline,
          ...(delegate ? { svmSponsoredDelegateTx: delegate } : {}),
        }),
  };
  await orderLimiter.acquire();
  const res = await fetchJson<{ orderId: string }>(`${BASE}/order`, { method: "POST", headers: headers(), body, timeoutMs: 15_000 });
  return { done: { providerOrderId: res.orderId } };
}

export interface RestingOrderParams {
  targetChain: string;
  contraChain: string;
  targetAsset: string;
  contraAsset: string;
  side: "buy" | "sell";
  qty: string;
  orderType: "limit" | "stop-loss" | "take-profit" | "stop";
  funderAddress: string;
  maxPriceImpact: string;
  limitNotionalPrice?: string;
  triggers?: Array<{ notionalPrice: string; triggerType: "lower" | "upper" }>;
  flashIntegratorFeeBps?: string;
}

export async function requestRestingQuote(params: RestingOrderParams): Promise<FlashQuoteRaw> {
  await quoteLimiter.acquire();
  return fetchJson<FlashQuoteRaw>(`${BASE}/quote`, { method: "POST", headers: headers(), body: params, timeoutMs: 6_000 });
}

export async function submitRestingOrder(params: RestingOrderParams, raw: FlashQuoteRaw, signature: string, permitSignature?: string): Promise<string> {
  await orderLimiter.acquire();
  const res = await fetchJson<{ orderId: string }>(`${BASE}/order`, {
    method: "POST",
    headers: headers(),
    body: {
      ...params,
      quoteId: raw.quoteId,
      userSignature: signature,
      evmOrderTypedData: raw.evm?.orderTypedData,
      ...(permitSignature ? { evmPermitTypedData: raw.evm?.permitTypedData, evmPermitSignature: permitSignature } : {}),
    },
    timeoutMs: 15_000,
  });
  return res.orderId;
}

export async function getFlashOrder(orderId: string, funder: string): Promise<FlashOrderDetail> {
  await statusLimiter.acquire();
  return fetchJson<FlashOrderDetail>(`${BASE}/orders/${orderId}?funderAddress=${encodeURIComponent(funder)}`, { headers: headers(), timeoutMs: 6_000, retries: 1 });
}

export async function cancelFlashOrder(orderId: string, cancelMessage: string, userSignature: string): Promise<void> {
  await orderLimiter.acquire();
  await fetchJson(`${BASE}/orders/${orderId}/cancel`, { method: "POST", headers: headers(), body: { cancelMessage, userSignature }, timeoutMs: 10_000 });
}

export interface FlashOrderDetail {
  order: {
    status: string;
    closeReason: string | null;
    filled?: { targetAmount: string; contraAmount: string; averageNotionalPrice?: string; averagePrice?: string } | null;
  };
  fills?: Array<{ transactionId?: string | null; feeNotional?: string | null; status?: string }> | null;
}

const REASONS: Record<string, string> = {
  REASON_INSUFFICIENT_FUNDER_BALANCE: "The wallet didn't have enough balance when the order ran.",
  REASON_INSUFFICIENT_ASSET_BALANCE: "The wallet didn't have enough balance when the order ran.",
  REASON_MAXIMUM_SLIPPAGE_EXCEEDED: "The price moved past the slippage limit, so nothing was traded.",
  REASON_EXECUTION_COST_EXCEEDS_LIMIT: "Network costs were too high for this trade size. Try a larger amount.",
  REASON_ORDER_REJECTED_AT_VENUE: "The network was congested. Try again.",
  REASON_ORDER_EXPIRED: "The order timed out before it could fill. Nothing was spent. Try again.",
  REASON_PRICE_IMPACT_TOO_HIGH: "This trade would move the price too much, so nothing was traded.",
  REASON_INSUFFICIENT_LIQUIDITY: "There isn't enough liquidity for this trade, so nothing was traded.",
};

export function flashStatusToUpdate(res: FlashOrderDetail, req: Pick<RouteRequest, "side">): StatusUpdate {
  const { order, fills } = res;
  const txs = (fills ?? []).map((f) => f.transactionId).filter((t): t is string => !!t);
  const srcTx = txs[0];
  const dstTx = txs.length > 1 ? txs[txs.length - 1] : undefined;
  switch (order.status) {
    case "ORDER_STATUS_FILLED": {
      const qty = order.filled?.targetAmount;
      const contra = order.filled?.contraAmount;
      const fee = (fills ?? []).reduce((sum, f) => sum.add(f.feeNotional ?? 0), D(0)).toFixed();
      return {
        status: "filled",
        qty,
        ...(req.side === "buy" ? { usdIn: contra } : { usdOut: contra }),
        priceUsd: order.filled?.averageNotionalPrice ?? (qty && contra && D(qty).gt(0) ? D(contra).div(qty).toFixed() : undefined),
        feeUsd: fee,
        // A market fill reports only the integrator fee: it was 0 on every fill until the fee was switched on.
        revenueUsd: fee,
        srcTx,
        dstTx,
      };
    }
    case "ORDER_STATUS_CANCELLED":
    case "ORDER_STATUS_REJECTED":
    case "ORDER_STATUS_TERMINATED": {
      // If funds left the source chain and the order still closed, the provider refunds them there.
      const moved = txs.length > 0;
      return {
        status: moved ? "refunded" : "failed",
        error: REASONS[order.closeReason ?? ""] ?? (moved ? "The route failed and your funds are being returned." : "The order was not filled."),
        srcTx,
      };
    }
    case "ORDER_STATUS_PARTIALLY_FILLED":
      return { status: "source_confirmed", srcTx };
    default:
      return { status: txs.length ? "source_confirmed" : "pending", srcTx };
  }
}

export interface FlashAssetInfo {
  riskFlagged: boolean;
  decimals: number | null;
  holders: number | null;
  imageUrl: string | null;
  tradable: boolean;
}

/** Looks a token up by address. Flash's riskFlagged and decimals feed guardrails and the token page. */
export async function flashAsset(chain: ChainKey, address: string): Promise<FlashAssetInfo | null> {
  if (!env().FLASH_API_KEY) return null;
  try {
    const slug = CHAINS[chain].flashSlug;
    const data = await fetchJson<{ assets?: Array<{ address: string; decimals: number; holders: number; imageUrl: string; riskFlagged: boolean }> }>(
      `${BASE}/search?query=${encodeURIComponent(address)}&chain=${slug}&limit=5`,
      { headers: headers(), timeoutMs: 3_000 },
    );
    const key = normalizeAddress(chain, address);
    const asset = data.assets?.find((a) => normalizeAddress(chain, a.address) === key);
    if (!asset) return { riskFlagged: false, decimals: null, holders: null, imageUrl: null, tradable: false };
    return {
      riskFlagged: asset.riskFlagged,
      decimals: asset.decimals,
      holders: asset.holders,
      imageUrl: asset.imageUrl || null,
      tradable: true,
    };
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) throw err;
    return null;
  }
}

export interface FlashSearchHit {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  imageUrl: string;
  riskFlagged: boolean;
  price: string;
  liquidity: string;
  marketCap: string;
  volume24h: string;
  priceChange24h: string;
}

export async function flashSearch(query: string, chain?: ChainKey): Promise<FlashSearchHit[]> {
  if (!env().FLASH_API_KEY) return [];
  const slug = chain ? `&chain=${CHAINS[chain].flashSlug}` : "";
  try {
    const data = await fetchJson<{ assets?: FlashSearchHit[] }>(`${BASE}/search?query=${encodeURIComponent(query)}${slug}&limit=15`, {
      headers: headers(),
      timeoutMs: 2_500,
    });
    return data.assets ?? [];
  } catch {
    return [];
  }
}
