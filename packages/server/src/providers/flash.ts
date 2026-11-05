import {
  ARC_USDC,
  CHAINS,
  D,
  FLASH_ALLOWANCE_ARC,
  GUARDRAILS,
  PERMIT2,
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
    contraChain: "arc",
    targetAsset: req.address,
    contraAsset: ARC_USDC,
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

export const flashProvider: RouteProvider = {
  id: "flash",
  enabled: () => !!env().FLASH_API_KEY,
  supports: () => true,

  async quote(req, signal) {
    const started = Date.now();
    const raw = await requestQuote(req, env().FLASH_INTEGRATOR_FEE_BPS, signal);
    return quoteToProvider(raw, req, Date.now() - started);
  },

  async advance(ctx: ExecContext): Promise<AdvanceResult> {
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
      const spentToken = req.side === "buy" ? ARC_USDC : req.address;
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
              ? toBaseUnits(req.usdcIn!, CHAINS.arc.usdcDecimals)
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
