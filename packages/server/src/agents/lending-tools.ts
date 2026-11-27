import { D } from "@frontrun/core";
import { AppError } from "../errors";
import { lendingMarket, lendingMarkets } from "../lending/markets";
import { lendingSummary, performLendingAction } from "../lending/service";
import type { ToolSpec } from "./models";
import type { ToolContext, ToolOutcome } from "./tools";

const REASON_MAX = 560;

/**
 * Agents can put idle USDC to work and take it back. They don't borrow: a loan against stocks can be liquidated
 * while nobody is watching, and that's a call for a person to make.
 */
export const LENDING_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_lending_markets",
      description:
        "Where USDC can earn on Base right now: Aave, curated Morpho vaults, and Morpho markets that lend USDC to people borrowing against tokenized stocks (NVDA, TSLA, AAPL and others). Each has its lending APY, deposits and free liquidity. Stock markets pay more but hold less, and withdrawals wait when most of it is borrowed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_lending_positions",
      description: "What you have lent and where, what it's earning, and the USDC in your wallet that isn't lent.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "lend",
      description:
        "Lend USDC from your wallet into one market from list_lending_markets, to earn while it isn't trading. Lent USDC can't be traded until you withdraw it. Give a short public reason, shown on your profile.",
      parameters: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "The market's id, exactly as list_lending_markets returned it." },
          amountUsd: { type: "number", description: "USDC to lend." },
          reason: { type: "string", description: "Why here and why now, in a sentence or two. Shown publicly." },
        },
        required: ["marketId", "amountUsd", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "redeem_lending",
      description: "Take lent USDC back into your wallet, so it can trade again. Leave amountUsd out to withdraw everything from that market.",
      parameters: {
        type: "object",
        properties: {
          marketId: { type: "string", description: "The market's id, exactly as get_lending_positions returned it." },
          amountUsd: { type: "number", description: "USDC to withdraw. Leave out for all of it." },
          reason: { type: "string", description: "Why, in a sentence. Shown publicly." },
        },
        required: ["marketId"],
      },
    },
  },
];

const NAMES = new Set(LENDING_TOOLS.map((t) => t.function.name));
export function isLendingTool(name: string): boolean {
  return NAMES.has(name);
}

function cleanReason(raw: unknown, required: boolean): string | undefined {
  const text = typeof raw === "string" ? raw.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX) : "";
  if (required && text.length < 10) throw new AppError(400, "reason_needed", "Give a reason of at least a sentence. It's shown publicly next to the move.");
  return text || undefined;
}

function amountArg(raw: unknown): string {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new AppError(400, "invalid_amount", "amountUsd has to be a positive number.");
  return n.toFixed(6);
}

async function earningMarket(id: unknown) {
  if (typeof id !== "string") throw new AppError(400, "invalid_market", "marketId is required, exactly as list_lending_markets returned it.");
  const market = await lendingMarket(id);
  if (!market) throw new AppError(404, "unknown_market", "There's no lending market with that id. Call list_lending_markets.");
  return market;
}

/** Short shape for the model: enough to compare, nothing it has to parse around. */
function brief(m: Awaited<ReturnType<typeof lendingMarkets>>[number]) {
  return {
    marketId: m.id,
    name: m.name,
    venue: m.venue === "aave" ? "Aave" : m.venue === "morpho_vault" ? `Morpho vault (${m.curator})` : `Morpho stock market${m.ours ? " (made by Front Run)" : ""}`,
    lendApyPct: m.supplyApy === null ? null : Number(m.supplyApy.toFixed(2)),
    depositsUsd: m.totalSupplyUsd === null ? null : Math.round(m.totalSupplyUsd),
    freeLiquidityUsd: m.liquidityUsd === null ? null : Math.round(m.liquidityUsd),
    utilizationPct: m.utilization === null ? null : Math.round(m.utilization * 100),
  };
}

export async function runLendingTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "list_lending_markets": {
      const items = (await lendingMarkets()).map(brief);
      return { result: { markets: items, note: "Rates move with demand. Small stock markets can be hard to exit when most of their USDC is borrowed." }, summary: "Checked lending rates", ok: true, acted: false };
    }
    case "get_lending_positions": {
      const s = await lendingSummary(ctx.user.id);
      return {
        result: {
          walletUsdc: s.walletUsdc,
          totalLentUsd: s.totalSuppliedUsd,
          positions: s.positions.filter((p) => D(p.suppliedUsd).gt(0)).map((p) => ({ ...brief(p.market), lentUsd: p.suppliedUsd })),
        },
        summary: "Checked its lending",
        ok: true,
        acted: false,
      };
    }
    case "lend": {
      const market = await earningMarket(args.marketId);
      const amount = amountArg(args.amountUsd);
      const reason = cleanReason(args.reason, true);
      if (ctx.budget.trades <= 0) throw new AppError(429, "run_limit", "That's the limit of moves in one round. Wait for the next one.");
      ctx.budget.trades -= 1;
      const done = await performLendingAction(ctx.user.id, { marketId: market.id, action: "supply", amount }, { agentReason: reason });
      if (done.status === "failed") return { result: { refused: done.error, nothingWasLent: true }, summary: `Tried to lend $${D(amount).toFixed(2)} in ${market.name}: ${done.error}`, ok: false, acted: false };
      return {
        result: { lent: done.amount, market: market.name, lendApyPct: market.supplyApy, tx: done.txHash },
        summary: `Lent $${D(done.amount).toFixed(2)} in ${market.name}`,
        ok: true,
        acted: true,
        notify: { message: `${ctx.user.username} lent $${D(done.amount).toFixed(2)} USDC in ${market.name}` },
      };
    }
    default: {
      const market = await earningMarket(args.marketId);
      const all = args.amountUsd === undefined || args.amountUsd === null;
      const reason = cleanReason(args.reason, false);
      // Getting money back matters more than the round's budget, so withdrawing doesn't spend it.
      const done = await performLendingAction(ctx.user.id, { marketId: market.id, action: "withdraw", ...(all ? { max: true } : { amount: amountArg(args.amountUsd) }) }, { agentReason: reason });
      if (done.status === "failed") return { result: { refused: done.error }, summary: `Tried to withdraw from ${market.name}: ${done.error}`, ok: false, acted: false };
      return {
        result: { withdrew: done.amount, market: market.name, tx: done.txHash },
        summary: `Withdrew $${D(done.amount).toFixed(2)} from ${market.name}`,
        ok: true,
        acted: true,
        notify: { message: `${ctx.user.username} withdrew $${D(done.amount).toFixed(2)} USDC from ${market.name}` },
      };
    }
  }
}
