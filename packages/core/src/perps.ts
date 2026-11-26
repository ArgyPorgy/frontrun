import { z } from "zod";

/** Perpetuals run on Veranta, on Base: margined in USDC, priced by Pyth, settled on-chain. */
export type PerpSide = "long" | "short";
export type PerpAssetClass =
  "crypto" | "equity" | "fx" | "metal" | "commodity" | "index" | "other";
export type PerpStatus =
  | "pending"
  | "open"
  | "closing"
  | "closed"
  | "liquidated"
  | "cancelled"
  | "failed";

export interface PerpMarketView {
  pairIndex: number;
  /** As the venue names it, e.g. "BTC/USD". */
  symbol: string;
  base: string;
  assetClass: PerpAssetClass;
  minLeverage: number;
  maxLeverage: number;
  /** Smallest position, collateral times leverage, in USD. */
  minPositionUsd: number;
  priceUsd: number | null;
  /** Long and short open interest, and the cap, in USD. */
  openInterest: { longUsd: number; shortUsd: number; maxUsd: number | null };
  /** Stocks and FX follow their market's hours. Closed means no new trades until it reopens. */
  isOpen: boolean;
  /** Fee on each side of the trade, as a percent of position size. */
  openFeePct: number;
  closeFeePct: number;
  /** Veranta's funding rate for each side, as it reports it. Positive means that side pays. Null if it gave none. */
  fundingRate: { long: number; short: number } | null;
}

export interface PerpPositionView {
  id: string;
  market: Pick<PerpMarketView, "pairIndex" | "symbol" | "base" | "assetClass">;
  side: PerpSide;
  status: PerpStatus;
  collateralUsd: string;
  leverage: number;
  sizeUsd: string;
  entryPrice: string | null;
  markPrice: string | null;
  liquidationPrice: string | null;
  takeProfit: string | null;
  stopLoss: string | null;
  /** Live while open, realized once closed. */
  pnlUsd: string | null;
  pnlPct: number | null;
  closePrice: string | null;
  openTx: string | null;
  closeTx: string | null;
  isPaper: boolean;
  error: string | null;
  /** An agent's public reason for opening it. */
  reason: string | null;
  createdAt: string;
  openedAt: string | null;
  closedAt: string | null;
}

export const perpOpenSchema = z.object({
  pairIndex: z.number().int().min(0),
  side: z.enum(["long", "short"]),
  collateralUsd: z.number().positive().max(100_000),
  leverage: z.number().positive().max(1000),
  takeProfit: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
});
export type PerpOpenInput = z.infer<typeof perpOpenSchema>;
export const perpCloseSchema = z.object({
  percent: z.number().gt(0).max(100).default(100),
});
export const perpTpSlSchema = z.object({
  takeProfit: z.number().positive().nullable().optional(),
  stopLoss: z.number().positive().nullable().optional(),
});
export const perpMarginSchema = z.object({
  action: z.enum(["add", "remove"]),
  amountUsd: z.number().positive().max(100_000),
});

/** Positions are liquidated when losses reach this share of collateral. */
export const PERP_LIQUIDATION_LOSS = 0.9;

function direction(side: PerpSide): 1 | -1 {
  return side === "long" ? 1 : -1;
}

/** Profit or loss before fees, in USD. */
export function perpPnlUsd(
  p: {
    side: PerpSide;
    collateralUsd: number;
    leverage: number;
    entryPrice: number;
  },
  price: number,
): number {
  if (p.entryPrice <= 0) return 0;
  return (
    p.collateralUsd *
    p.leverage *
    ((price - p.entryPrice) / p.entryPrice) *
    direction(p.side)
  );
}

/** The price at which losses reach the liquidation threshold. An estimate: the venue's own value wins when known. */
export function perpLiquidationPrice(p: {
  side: PerpSide;
  leverage: number;
  entryPrice: number;
}): number {
  return (
    p.entryPrice *
    (1 - (direction(p.side) * PERP_LIQUIDATION_LOSS) / p.leverage)
  );
}

/** Why an order can't go, or null if it can. */
export function perpOrderProblem(
  market: Pick<
    PerpMarketView,
    "minLeverage" | "maxLeverage" | "minPositionUsd" | "isOpen" | "symbol"
  >,
  order: {
    collateralUsd: number;
    leverage: number;
    side: PerpSide;
    takeProfit?: number;
    stopLoss?: number;
  },
  price: number | null,
): string | null {
  if (!market.isOpen)
    return `${market.symbol} is closed right now. It trades during its market's hours.`;
  if (
    order.leverage < market.minLeverage ||
    order.leverage > market.maxLeverage
  )
    return `Leverage on ${market.symbol} has to be between ${market.minLeverage}x and ${market.maxLeverage}x.`;
  if (order.collateralUsd * order.leverage < market.minPositionUsd)
    return `The smallest position on ${market.symbol} is $${market.minPositionUsd} (collateral times leverage).`;
  if (price !== null) {
    const dir = direction(order.side);
    if (order.takeProfit !== undefined && (order.takeProfit - price) * dir <= 0)
      return "Take-profit has to be on the winning side of the current price.";
    if (order.stopLoss !== undefined && (price - order.stopLoss) * dir <= 0)
      return "Stop-loss has to be on the losing side of the current price.";
  }
  return null;
}

/** Veranta's contracts on Base, from its transaction builder. Orders go to the router; USDC is approved to storage. */
export const VERANTA_BASE = {
  tradingRouter: "0x44914408af82bC9983bbb330e3578E1105e11d4e",
  tradingStorage: "0x8a311D7048c35985aa31C131B9A13e03a5f7422d",
} as const;
