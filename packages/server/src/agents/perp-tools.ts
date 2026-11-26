import { AGENT_PERP_MAX_LEVERAGE, D, checkSpendCaps, defaultPerpSignal, indicatorSnapshot, perpOrderProblem, type PerpAssetClass, type PerpPositionView } from "@frontrun/core";
import { AppError } from "../errors";
import { perpCandles, perpMarket, perpMarkets } from "../perps/markets";
import { closePerp, listPerps, openPerp, updatePerpTpSl } from "../perps/service";
import { signerStatus } from "../trading/service";
import type { ToolSpec } from "./models";
import type { ToolContext, ToolOutcome } from "./tools";

/** Open perps one agent may hold at once, so a model can't spread itself across every market. */
const MAX_OPEN_PERPS = 3;
const THESIS_MAX = 560;
const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
const ASSET_CLASSES: PerpAssetClass[] = ["equity", "crypto", "fx", "metal", "commodity", "index"];

export const PERP_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list_perp_markets",
      description:
        "Perp markets on Veranta, on Base: tokenized stocks first, then crypto, FX, metals and commodities. Each has its price, whether it's open now (stocks follow US market hours), the leverage range, the smallest position, open interest and funding. Filter by asset class or search by ticker.",
      parameters: {
        type: "object",
        properties: {
          assetClass: { type: "string", enum: ASSET_CLASSES },
          query: { type: "string", description: "A ticker or name, like NVDA or gold." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "perp_analysis",
      description:
        "Technical analysis of one perp market on one timeframe: SMA and EMA 20/50, RSI 14, MACD, Bollinger bands, ATR, stochastic and ADX, plus open interest, funding, and what the default trend-and-momentum strategy says (long, short or none, with its reasons and ATR-based stop and target). Volume isn't available, so there's no VWAP or OBV.",
      parameters: {
        type: "object",
        properties: {
          pairIndex: { type: "number", description: "The market's pairIndex from list_perp_markets." },
          timeframe: { type: "string", enum: TIMEFRAMES, description: "Candle size. 1h if unsure." },
        },
        required: ["pairIndex"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_perp",
      description: `Opens a long or short perp with your USDC as collateral. Collateral counts against your per-trade and daily limits. Leverage is capped at ${AGENT_PERP_MAX_LEVERAGE}x and the market's own maximum. A stop-loss is required. Position size (collateral times leverage) has to reach the market's minimum, usually $100. Your thesis is shown publicly on the position.`,
      parameters: {
        type: "object",
        properties: {
          pairIndex: { type: "number" },
          side: { type: "string", enum: ["long", "short"] },
          collateralUsd: { type: "number", description: "USDC to put up." },
          leverage: { type: "number" },
          stopLoss: { type: "number", description: "Price to close at a loss. Below the price for a long, above it for a short." },
          takeProfit: { type: "number", description: "Price to close at a profit. Optional." },
          thesis: { type: "string", description: `Why, in your own words, up to ${THESIS_MAX} characters. Shown publicly.` },
        },
        required: ["pairIndex", "side", "collateralUsd", "leverage", "stopLoss", "thesis"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_perp",
      description: "Closes all or part of one of your open perps at the market price, by the positionId get_portfolio returned.",
      parameters: {
        type: "object",
        properties: { positionId: { type: "string" }, percent: { type: "number", description: "Percent to close, up to 100." } },
        required: ["positionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_perp_tpsl",
      description: "Moves the take-profit or stop-loss on one of your open perps. A stop-loss can be moved, never removed.",
      parameters: {
        type: "object",
        properties: { positionId: { type: "string" }, takeProfit: { type: "number" }, stopLoss: { type: "number" } },
        required: ["positionId"],
      },
    },
  },
];

const PERP_TOOL_NAMES = new Set(PERP_TOOLS.map((t) => t.function.name));
export function isPerpTool(name: string): boolean {
  return PERP_TOOL_NAMES.has(name);
}

function num(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new AppError(400, "bad_number", `${name} has to be a positive number.`);
  return n;
}

function short(p: PerpPositionView) {
  return {
    positionId: p.id,
    market: p.market.symbol,
    pairIndex: p.market.pairIndex,
    side: p.side,
    status: p.status,
    collateralUsd: p.collateralUsd,
    leverage: p.leverage,
    entryPrice: p.entryPrice,
    markPrice: p.markPrice,
    liquidationPrice: p.liquidationPrice,
    takeProfit: p.takeProfit,
    stopLoss: p.stopLoss,
    pnlUsd: p.pnlUsd,
    pnlPct: p.pnlPct === null ? null : Math.round(p.pnlPct * 10) / 10,
  };
}

/** For the portfolio and the facts each round: open perps, in the shape the other perp tools take. */
export async function agentPerps(userId: string) {
  const open = await listPerps(userId, { status: "open" });
  return open.filter((p) => p.status === "open" || p.status === "pending" || p.status === "closing").map(short);
}

async function markets(args: Record<string, unknown>): Promise<ToolOutcome> {
  const assetClass = ASSET_CLASSES.includes(args.assetClass as PerpAssetClass) ? (args.assetClass as PerpAssetClass) : undefined;
  const query = typeof args.query === "string" ? args.query.slice(0, 32) : undefined;
  const items = await perpMarkets({ assetClass, query });
  return {
    result: {
      markets: items.slice(0, 25).map((m) => ({
        pairIndex: m.pairIndex,
        symbol: m.symbol,
        assetClass: m.assetClass,
        priceUsd: m.priceUsd,
        isOpen: m.isOpen,
        leverage: `${m.minLeverage}-${Math.min(m.maxLeverage, AGENT_PERP_MAX_LEVERAGE)}x for you`,
        minPositionUsd: m.minPositionUsd,
        openInterestUsd: { long: Math.round(m.openInterest.longUsd), short: Math.round(m.openInterest.shortUsd) },
        fundingRate: m.fundingRate,
      })),
    },
    summary: `Looked at perp markets${query ? ` for ${query}` : assetClass ? ` (${assetClass})` : ""}`,
    ok: true,
    acted: false,
  };
}

async function analysis(args: Record<string, unknown>): Promise<ToolOutcome> {
  const pairIndex = Math.floor(Number(args.pairIndex));
  const timeframe = TIMEFRAMES.includes(args.timeframe as (typeof TIMEFRAMES)[number]) ? (args.timeframe as string) : "1h";
  const market = await perpMarket(pairIndex);
  if (!market) throw new AppError(404, "unknown_market", "There's no perp market with that pairIndex.");
  const candles = await perpCandles(pairIndex, timeframe);
  const snapshot = indicatorSnapshot(candles);
  if (!snapshot || snapshot.candles < 60) {
    return { result: { error: "Not enough price history on that timeframe to read the indicators." }, summary: `Couldn't analyse ${market.symbol}`, ok: false, acted: false };
  }
  // The last candle's close can lag the live price a little, so the live one is shown beside it.
  const signal = defaultPerpSignal(snapshot, market.fundingRate);
  return {
    result: {
      market: market.symbol,
      pairIndex,
      timeframe,
      livePriceUsd: market.priceUsd,
      isOpen: market.isOpen,
      maxLeverageForYou: Math.min(market.maxLeverage, AGENT_PERP_MAX_LEVERAGE),
      minPositionUsd: market.minPositionUsd,
      openInterestUsd: { long: Math.round(market.openInterest.longUsd), short: Math.round(market.openInterest.shortUsd), cap: market.openInterest.maxUsd },
      fundingRate: market.fundingRate,
      indicators: snapshot,
      defaultStrategy: signal,
    },
    summary: `Analysed ${market.symbol} on ${timeframe}: the default strategy says ${signal.bias}`,
    ok: true,
    acted: false,
  };
}

async function open(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const pairIndex = Math.floor(Number(args.pairIndex));
  const side = args.side === "short" ? "short" : args.side === "long" ? "long" : null;
  if (!side) throw new AppError(400, "bad_side", "side has to be long or short.");
  const collateral = num(args.collateralUsd, "collateralUsd");
  const leverage = num(args.leverage, "leverage");
  const stopLoss = num(args.stopLoss, "stopLoss");
  const takeProfit = args.takeProfit === undefined || args.takeProfit === null ? undefined : num(args.takeProfit, "takeProfit");
  const thesis = typeof args.thesis === "string" ? args.thesis.replace(/https?:\/\/\S+/g, "").trim().slice(0, THESIS_MAX) : "";
  if (thesis.length < 10) throw new AppError(400, "bad_thesis", "Write why you're taking this trade in thesis.");

  const market = await perpMarket(pairIndex);
  if (!market) throw new AppError(404, "unknown_market", "There's no perp market with that pairIndex.");
  const refuse = (message: string): ToolOutcome => ({ result: { refused: message, nothingWasOpened: true }, summary: `Wanted to ${side} ${market.symbol}: ${message}`, ok: false, acted: false });

  if (leverage > AGENT_PERP_MAX_LEVERAGE) return refuse(`The most leverage you may use is ${AGENT_PERP_MAX_LEVERAGE}x.`);
  const problem = perpOrderProblem(market, { collateralUsd: collateral, leverage, side, takeProfit, stopLoss }, market.priceUsd);
  if (problem) return refuse(problem);
  const held = await agentPerps(ctx.user.id);
  if (held.length >= MAX_OPEN_PERPS) return refuse(`You already hold ${held.length} perps, the most at once. Close one first.`);

  // The owner's limits can't be talked past, whoever is asking.
  const signer = await signerStatus(ctx.user.id);
  const caps = checkSpendCaps({ amountUsd: collateral, spentTodayUsd: signer.spentTodayUsd, perTradeCapUsd: ctx.agent.perTradeUsd, dailyCapUsd: ctx.agent.dailyLimitUsd });
  if (!caps.allowed) return refuse(caps.reason === "per_trade" ? `That's over your per-trade limit of $${D(ctx.agent.perTradeUsd).toFixed()}.` : `That would pass your daily limit of $${D(ctx.agent.dailyLimitUsd).toFixed()}.`);

  if (ctx.budget.trades <= 0) throw new AppError(429, "run_limit", "That's the limit of trades in one round. Wait for the next one.");
  ctx.budget.trades -= 1;
  const placed = await openPerp(ctx.user.id, { pairIndex, side, collateralUsd: collateral, leverage, stopLoss, takeProfit }, { agentReason: thesis });
  const what = `${side} ${market.symbol} at ${leverage}x with $${D(collateral).toDecimalPlaces(2).toFixed()}`;
  if (placed.status === "failed") return { result: { ...short(placed), error: placed.error, nothingWasOpened: true }, summary: `Tried to open a ${what}: ${placed.error ?? "it failed"}`, ok: false, acted: false };
  const settling = placed.status === "pending";
  return {
    result: { ...short(placed), ...(settling ? { note: "Sent. Veranta fills it on its next price update, usually within seconds." } : {}) },
    summary: settling ? `Opening a ${what}` : `Opened a ${what}`,
    ok: true,
    acted: true,
    notify: { message: `${ctx.user.username} opened a ${what}` },
  };
}

async function ownOpen(ctx: ToolContext, id: unknown): Promise<PerpPositionView> {
  if (typeof id !== "string") throw new AppError(400, "bad_position", "Give the positionId from get_portfolio.");
  const open = await listPerps(ctx.user.id, { status: "open" });
  const p = open.find((x) => x.id === id);
  if (!p) throw new AppError(404, "unknown_position", "You have no open perp with that positionId.");
  return p;
}

async function close(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const p = await ownOpen(ctx, args.positionId);
  const percent = args.percent === undefined ? 100 : Math.min(num(args.percent, "percent"), 100);
  // A way out matters more than the round's budget, so closing doesn't spend it.
  const done = await closePerp(ctx.user.id, p.id, percent);
  const what = `${percent >= 100 ? "" : `${Math.round(percent)}% of `}its ${p.side} on ${p.market.symbol}`;
  return {
    result: short(done),
    summary: done.status === "closing" ? `Closing ${what}` : `Closed ${what}`,
    ok: true,
    acted: true,
    notify: { message: `${ctx.user.username} closed ${what}` },
  };
}

async function tpsl(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const p = await ownOpen(ctx, args.positionId);
  const takeProfit = args.takeProfit === undefined ? undefined : num(args.takeProfit, "takeProfit");
  const stopLoss = args.stopLoss === undefined ? undefined : num(args.stopLoss, "stopLoss");
  if (takeProfit === undefined && stopLoss === undefined) throw new AppError(400, "nothing_to_change", "Give a takeProfit, a stopLoss, or both.");
  const done = await updatePerpTpSl(ctx.user.id, p.id, { takeProfit, stopLoss });
  return { result: short(done), summary: `Set ${[takeProfit !== undefined && `take-profit ${takeProfit}`, stopLoss !== undefined && `stop-loss ${stopLoss}`].filter(Boolean).join(" and ")} on ${p.market.symbol}`, ok: true, acted: true };
}

export async function runPerpTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "list_perp_markets":
      return markets(args);
    case "perp_analysis":
      return analysis(args);
    case "open_perp":
      return open(ctx, args);
    case "close_perp":
      return close(ctx, args);
    default:
      return tpsl(ctx, args);
  }
}
