import { D, type Numeric } from "./money";

export type ProviderId = "flash" | "uniswap" | "uniswap_direct" | "lifi" | "paper";

/** Once any quote is in, stop waiting for slower ones after this long. */
export const QUOTE_RACE_TIMEOUT_MS = 1500;
/**
 * If nothing has answered by the race window, keep waiting up to here rather than fail a trade that
 * has a route. Flash and LI.FI were both measured going past 1.5s under normal conditions.
 */
export const QUOTE_HARD_TIMEOUT_MS = 4500;

export const GUARDRAILS = {
  /** Reject buys above this price impact. */
  maxPriceImpact: 0.05,
  warnPriceImpact: 0.02,
  /** Reject buys larger than this share of pool liquidity. */
  maxPoolShare: 0.02,
  /**
   * How far a fill may fall below its quote. It's set wide enough that a one-tap order executes rather
   * than reverting when the price moves. Same-chain fills land in seconds. Cross-chain fills take about
   * 40 seconds, and Flash itself suggests 15% on those.
   */
  defaultSlippage: 0.05,
  crossChainSlippage: 0.2,
  /** Flash's own impact cap, left wide because the checks above run on the quote before anything is sent. */
  routePriceImpactCap: 0.5,
  /** How much worse an expired quote's replacement may be before the user is asked again. */
  requoteTolerance: 0.05,
} as const;

export const SCORE_WEIGHTS = {
  /** Cost of waiting: share of notional per second of ETA. */
  etaPenaltyPerSecond: 0.00002,
  /** A failed fill is worth half the notional in user pain. */
  failurePenaltyShare: 0.5,
} as const;

export interface ScoreInput {
  netOutputUsd: Numeric;
  notionalUsd: Numeric;
  etaSeconds: number;
  failureRate: number;
}

export function scoreQuote(q: ScoreInput): number {
  const notional = D(q.notionalUsd);
  const etaPenalty = notional.mul(SCORE_WEIGHTS.etaPenaltyPerSecond).mul(Math.max(q.etaSeconds, 0));
  const failurePenalty = notional.mul(q.failureRate).mul(SCORE_WEIGHTS.failurePenaltyShare);
  return D(q.netOutputUsd).sub(etaPenalty).sub(failurePenalty).toNumber();
}

/** Laplace smoothing, so one failure on a new provider doesn't read as a 100% failure rate. */
export function smoothedFailureRate(attempts: number, failures: number): number {
  return (failures + 1) / (attempts + 20);
}

export interface GuardrailInput {
  side: "buy" | "sell";
  notionalUsd: Numeric;
  priceImpact: number | null;
  poolLiquidityUsd: Numeric | null;
  riskFlagged: boolean;
  denylisted: boolean;
}

export type GuardrailCode =
  | "price_impact_high"
  | "price_impact_warn"
  | "size_over_pool_share"
  | "risk_flagged"
  | "token_denied";

export interface GuardrailIssue {
  code: GuardrailCode;
  message: string;
}

export interface GuardrailResult {
  /** The trade may not proceed at all. */
  blocked: GuardrailIssue[];
  /** The trade needs a visible confirm rather than one tap. */
  confirm: GuardrailIssue[];
  warnings: GuardrailIssue[];
}

/**
 * Buys get the hard limits. Sells never get a hard stop on impact, size or risk flags: a token that
 * turns bad after purchase must stay exitable, so those become a visible confirm instead.
 */
const SMALL_TRADE_USD = 10;

export function evaluateGuardrails(input: GuardrailInput): GuardrailResult {
  const result: GuardrailResult = { blocked: [], confirm: [], warnings: [] };
  const hard = input.side === "buy" ? result.blocked : result.confirm;

  if (input.denylisted) {
    (input.side === "buy" ? result.blocked : result.confirm).push({
      code: "token_denied",
      message: "This token is on the denylist.",
    });
  }
  if (input.riskFlagged) {
    hard.push({ code: "risk_flagged", message: "This token is flagged as high risk." });
  }
  if (input.priceImpact !== null) {
    const pct = (input.priceImpact * 100).toFixed(1);
    if (input.priceImpact > GUARDRAILS.maxPriceImpact) {
      // On a small trade this is mostly the route's fixed costs, with little at stake, so it's the
      // person's call. A thin pool is still stopped by the pool share check below.
      if (D(input.notionalUsd).lt(SMALL_TRADE_USD)) {
        result.confirm.push({ code: "price_impact_high", message: `Route costs would take ${pct}% of this small trade.` });
      } else {
        hard.push({ code: "price_impact_high", message: `Price impact is ${pct}%, above the 5% limit.` });
      }
    } else if (input.priceImpact > GUARDRAILS.warnPriceImpact) {
      result.warnings.push({ code: "price_impact_warn", message: `Price impact is ${pct}%.` });
    }
  }
  if (input.poolLiquidityUsd !== null && D(input.poolLiquidityUsd).gt(0)) {
    const share = D(input.notionalUsd).div(input.poolLiquidityUsd);
    if (share.gt(GUARDRAILS.maxPoolShare)) {
      hard.push({
        code: "size_over_pool_share",
        message: `This trade is ${share.mul(100).toFixed(1)}% of pool liquidity, above the 2% limit.`,
      });
    }
  }
  return result;
}

export function resolveSlippage(sameChain: boolean): number {
  return sameChain ? GUARDRAILS.defaultSlippage : GUARDRAILS.crossChainSlippage;
}

export type TradeStatus =
  | "awaiting_signature"
  | "pending"
  | "source_confirmed"
  | "filled"
  | "refunded"
  | "failed";

export const TERMINAL_STATUSES: TradeStatus[] = ["filled", "refunded", "failed"];

export const CAP_DEFAULTS = {
  perTradeUsd: "250",
  dailyUsd: "1000",
  grantDays: 30,
} as const;

export interface CapCheck {
  allowed: boolean;
  reason?: "per_trade" | "daily";
}

export function checkSpendCaps(input: {
  amountUsd: Numeric;
  spentTodayUsd: Numeric;
  perTradeCapUsd: Numeric;
  dailyCapUsd: Numeric;
}): CapCheck {
  const amount = D(input.amountUsd);
  if (amount.gt(input.perTradeCapUsd)) return { allowed: false, reason: "per_trade" };
  if (amount.add(input.spentTodayUsd).gt(input.dailyCapUsd)) return { allowed: false, reason: "daily" };
  return { allowed: true };
}

export type OrderType = "limit_buy" | "limit_sell" | "stop_buy" | "stop_loss" | "take_profit";

export function orderSide(type: OrderType): "buy" | "sell" {
  return type === "limit_buy" || type === "stop_buy" ? "buy" : "sell";
}

/** Whether the order waits for the price to fall to its trigger, or to rise to it. */
export function orderDirection(type: OrderType): "lower" | "upper" {
  return type === "limit_buy" || type === "stop_loss" ? "lower" : "upper";
}

export function triggerHit(direction: "lower" | "upper", trigger: Numeric, price: Numeric): boolean {
  return direction === "lower" ? D(price).lte(trigger) : D(price).gte(trigger);
}

/** An order set on the wrong side of the market would run straight away, which is never what was meant. */
export function triggerProblem(type: OrderType, trigger: Numeric, market: Numeric): string | null {
  if (orderDirection(type) === "lower") {
    if (D(trigger).lt(market)) return null;
    return type === "limit_buy" ? "A limit buy waits for a lower price, so set it below the current price." : "A stop-loss sits below the current price, so set it lower.";
  }
  if (D(trigger).gt(market)) return null;
  if (type === "stop_buy") return "A stop-buy waits for the price to rise, so set it above the current price.";
  return type === "take_profit" ? "A take-profit sits above the current price, so set it higher." : "A limit sell waits for a higher price, so set it above the current price.";
}
