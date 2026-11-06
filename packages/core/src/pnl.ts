import { D, Decimal, type Numeric } from "./money";

/**
 * Weighted-average-cost PnL, per the plan:
 *   realized   = proceeds - avg cost * qty sold
 *   unrealized = qty * live price - remaining cost
 * Cost uses the actual USDC spent, so fees and gas are already inside it.
 */
export interface PositionState {
  qty: string;
  costBasisUsd: string;
  realizedPnlUsd: string;
}

export const EMPTY_POSITION: PositionState = { qty: "0", costBasisUsd: "0", realizedPnlUsd: "0" };

/** Below this a position counts as closed, so sell rounding doesn't leave dust rows open. */
export const DUST_QTY = new Decimal("0.000000001");

export function applyBuy(state: PositionState, fill: { qty: Numeric; usdSpent: Numeric; feesUsd?: Numeric }): PositionState {
  const qty = D(fill.qty);
  if (qty.lte(0)) throw new Error("buy qty must be positive");
  return {
    qty: D(state.qty).add(qty).toFixed(),
    costBasisUsd: D(state.costBasisUsd).add(fill.usdSpent).add(fill.feesUsd ?? 0).toFixed(),
    realizedPnlUsd: state.realizedPnlUsd,
  };
}

export interface SellResult {
  state: PositionState;
  realizedDeltaUsd: string;
  closed: boolean;
}

export function applySell(state: PositionState, fill: { qty: Numeric; usdReceived: Numeric; feesUsd?: Numeric }): SellResult {
  const sold = D(fill.qty);
  if (sold.lte(0)) throw new Error("sell qty must be positive");
  const held = D(state.qty);
  const cost = D(state.costBasisUsd);
  // Selling more than we track means tokens arrived outside the app and reconciliation hasn't
  // caught up yet. The untracked part has no known cost, so it sits at zero until it does.
  const matched = Decimal.min(sold, held);
  const costOut = held.gt(0) ? cost.mul(matched).div(held) : D(0);
  const proceeds = D(fill.usdReceived).sub(fill.feesUsd ?? 0);
  const realizedDelta = proceeds.sub(costOut);
  let qtyLeft = held.sub(matched);
  let costLeft = cost.sub(costOut);
  const closed = qtyLeft.lt(DUST_QTY);
  if (closed) {
    qtyLeft = D(0);
    costLeft = D(0);
  }
  return {
    state: {
      qty: qtyLeft.toFixed(),
      costBasisUsd: costLeft.toFixed(),
      realizedPnlUsd: D(state.realizedPnlUsd).add(realizedDelta).toFixed(),
    },
    realizedDeltaUsd: realizedDelta.toFixed(),
    closed,
  };
}

export function unrealizedPnl(state: PositionState, priceUsd: Numeric): string {
  return D(state.qty).mul(priceUsd).sub(state.costBasisUsd).toFixed();
}

export function averageEntry(state: PositionState): string {
  const qty = D(state.qty);
  return qty.gt(0) ? D(state.costBasisUsd).div(qty).toFixed() : "0";
}

export function positionValue(state: PositionState, priceUsd: Numeric): string {
  return D(state.qty).mul(priceUsd).toFixed();
}

/** Which photo a shared result card gets: bigger moves earn bigger pictures. */
export type PnlCardTier = "exchange" | "lambo" | "moon" | "rough" | "boom" | "grill";

export function pnlCardTier(pct: number): PnlCardTier {
  if (pct >= 500) return "moon";
  if (pct >= 100) return "lambo";
  if (pct >= 0) return "exchange";
  if (pct <= -75) return "grill";
  if (pct <= -25) return "boom";
  return "rough";
}

/** A card's headline number: +84.0%, +424%, +1,240%, -12.4%. */
export function formatCardPct(pct: number): string {
  const size = Math.abs(pct);
  const digits = size < 100 ? size.toFixed(1) : Math.round(size).toLocaleString("en-US");
  return `${pct < 0 ? "\u2212" : "+"}${digits}%`;
}

export function returnPct(state: PositionState, priceUsd: Numeric): number {
  const cost = D(state.costBasisUsd);
  if (cost.lte(0)) return 0;
  return D(state.qty).mul(priceUsd).sub(cost).div(cost).mul(100).toNumber();
}

/**
 * Applies a reconciliation against the on-chain balance.
 * Transfers out shrink qty and cost pro rata with no realized PnL. Transfers in are booked at the
 * market price at detection, so a wallet deposit never shows up as instant profit.
 */
export function reconcile(state: PositionState, chainQty: Numeric, priceUsd: Numeric): PositionState {
  const held = D(state.qty);
  const onChain = D(chainQty);
  if (onChain.eq(held)) return state;
  if (onChain.lt(held)) {
    const ratio = held.gt(0) ? onChain.div(held) : D(0);
    return {
      qty: onChain.toFixed(),
      costBasisUsd: D(state.costBasisUsd).mul(ratio).toFixed(),
      realizedPnlUsd: state.realizedPnlUsd,
    };
  }
  return {
    qty: onChain.toFixed(),
    costBasisUsd: D(state.costBasisUsd).add(onChain.sub(held).mul(priceUsd)).toFixed(),
    realizedPnlUsd: state.realizedPnlUsd,
  };
}

/** Share of closed positions that made money, as a 0-100 number. */
export function winRate(closedRealized: Numeric[]): number | null {
  if (closedRealized.length === 0) return null;
  const wins = closedRealized.filter((r) => D(r).gt(0)).length;
  return (wins / closedRealized.length) * 100;
}

export interface PortfolioTotals {
  valueUsd: string;
  realizedUsd: string;
  unrealizedUsd: string;
  allTimeUsd: string;
}

export function portfolioTotals(
  open: Array<PositionState & { priceUsd: Numeric | null }>,
  closedRealized: Numeric[],
): PortfolioTotals {
  let value = D(0);
  let unrealized = D(0);
  let realized = D(0);
  for (const p of open) {
    realized = realized.add(p.realizedPnlUsd);
    // No price yet: show the position at cost rather than as a total loss.
    const price = p.priceUsd ?? (D(p.qty).gt(0) ? D(p.costBasisUsd).div(p.qty) : 0);
    value = value.add(D(p.qty).mul(price));
    unrealized = unrealized.add(D(p.qty).mul(price).sub(p.costBasisUsd));
  }
  for (const r of closedRealized) realized = realized.add(r);
  return {
    valueUsd: value.toFixed(),
    realizedUsd: realized.toFixed(),
    unrealizedUsd: unrealized.toFixed(),
    allTimeUsd: realized.add(unrealized).toFixed(),
  };
}
