import type { ChainKey, ExecStep, ProviderId, StepResult, TradeStatus } from "@frontrun/core";

export interface RouteRequest {
  side: "buy" | "sell";
  chain: ChainKey;
  address: string;
  decimals: number | null;
  /** USDC to spend, on buys. */
  usdcIn?: string;
  /** Tokens to sell, on sells. */
  qtyIn?: string;
  /** The user's EVM address: their Arc balance and their wallet on any other EVM chain. */
  evmAddress: string;
  solanaAddress: string | null;
  /** Live USD price of the token, used for value estimates and impact checks. */
  priceUsd: string;
  notionalUsd: string;
}

export interface ProviderQuote {
  provider: ProviderId;
  /** USD value the user ends up with, after fees and gas. Scoring runs on this. */
  netOutputUsd: string;
  /** Tokens on a buy, USDC on a sell. */
  expectedOut: string;
  feeUsd: string;
  gasUsd: string;
  etaSeconds: number;
  priceImpact: number | null;
  recommendedSlippage: number | null;
  crossChain: boolean;
  needsSetup: boolean;
  sponsoredSetup: boolean;
  riskFlagged?: boolean;
  latencyMs: number;
  /** Everything execution needs later. JSON-safe, with no secrets. */
  raw: unknown;
}

export interface ExecContext {
  tradeId: string;
  userId: string;
  request: RouteRequest;
  quote: ProviderQuote;
  completed: StepResult[];
}

export interface SubmitResult {
  providerOrderId?: string;
  srcTx?: string;
}

export type AdvanceResult = { steps: ExecStep[] } | { done: SubmitResult };

export interface StatusInput {
  request: RouteRequest;
  providerOrderId: string | null;
  srcTx: string | null;
  quote: ProviderQuote;
}

export interface StatusUpdate {
  status: TradeStatus;
  qty?: string;
  usdIn?: string;
  usdOut?: string;
  priceUsd?: string;
  /** Shown on the receipt. Part of usdIn/usdOut on all-in routes, so it isn't added to cost again. */
  feeUsd?: string;
  /** What the app itself earned on this fill. */
  revenueUsd?: string;
  /** Cost paid on top of usdIn or out of usdOut, like Arc gas on a direct swap. Goes into PnL. */
  extraCostUsd?: string;
  srcTx?: string;
  dstTx?: string;
  error?: string;
}

export interface RouteProvider {
  id: ProviderId;
  enabled(): boolean;
  /** Does this provider serve this route at all? */
  supports(req: RouteRequest): boolean;
  quote(req: RouteRequest, signal?: AbortSignal): Promise<ProviderQuote>;
  /** Given the steps finished so far, returns the next ones to sign, or the submitted order. */
  advance(ctx: ExecContext): Promise<AdvanceResult>;
  status(input: StatusInput): Promise<StatusUpdate>;
}

export function spentChain(req: Pick<RouteRequest, "side" | "chain">): ChainKey {
  return req.side === "buy" ? "arc" : req.chain;
}

export function isCrossChain(req: Pick<RouteRequest, "chain">): boolean {
  return req.chain !== "arc";
}

export function completedStep(ctx: ExecContext, id: string): StepResult | undefined {
  return ctx.completed.find((s) => s.id === id);
}

export function recipientOn(req: RouteRequest, chain: ChainKey): string {
  if (chain !== "solana") return req.evmAddress;
  if (!req.solanaAddress) throw new Error("This token is on Solana but the account has no Solana wallet yet.");
  return req.solanaAddress;
}
