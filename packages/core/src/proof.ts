import { formatPrice } from "./format";
import { D, type Numeric } from "./money";

export type PositionAction = "add" | "trim" | "exit" | "moved";
export type PositionStatus = "holding" | "trimmed" | "exited" | "moved";

/** How each action is written in PositionLedger on Arc. */
export const POSITION_ACTION_CODES: Record<PositionAction, number> = { add: 1, trim: 2, exit: 3, moved: 4 };

export const HELD_BPS_FULL = 10_000;
/** Adding to a position can pass 100%. This keeps a dust-sized start from overflowing the record. */
const HELD_BPS_MAX = 1_000_000;
/** Selling all but this share counts as an exit, and rounding this close to full doesn't count as a trim. */
const DUST_BPS = 50;
/** A wallet's balance can differ a little from our records through rounding or token fees, which isn't a move. */
const CHAIN_TOLERANCE = 0.03;

export interface HeldState {
  qty: string;
  bps: number;
  status: PositionStatus;
}

export type HeldChange = HeldState & { action: PositionAction };

export function heldBpsOf(qty: Numeric, qtyAtPost: Numeric): number {
  const base = D(qtyAtPost);
  if (base.lte(0)) return 0;
  return Math.min(D(qty).div(base).mul(HELD_BPS_FULL).round().toNumber(), HELD_BPS_MAX);
}

/** What a fill does to the position a thesis was posted on. */
export function applyFillToHeld(state: HeldState, fill: { side: "buy" | "sell"; qty: Numeric; closedPosition: boolean }, qtyAtPost: Numeric): HeldChange {
  if (fill.side === "buy") {
    const qty = D(state.qty).add(fill.qty);
    const bps = heldBpsOf(qty, qtyAtPost);
    const full = bps >= HELD_BPS_FULL - DUST_BPS;
    return { qty: qty.toFixed(), bps, status: full ? "holding" : state.status === "moved" ? "moved" : "trimmed", action: "add" };
  }
  const left = D(state.qty).sub(fill.qty);
  const qty = left.lt(0) ? D(0) : left;
  const bps = heldBpsOf(qty, qtyAtPost);
  if (fill.closedPosition || bps <= DUST_BPS) return { qty: "0", bps: 0, status: "exited", action: "exit" };
  return { qty: qty.toFixed(), bps, status: bps >= HELD_BPS_FULL - DUST_BPS ? "holding" : "trimmed", action: "trim" };
}

/**
 * Compares the wallet with our records, which is what catches a sale made outside the app. It can't tell a
 * sale from a transfer, so it reports both as tokens having left. Tokens coming back only count after a move.
 */
export function chainChange(state: HeldState, chainQty: Numeric, qtyAtPost: Numeric): HeldChange | null {
  const chain = D(chainQty);
  const held = D(state.qty);
  if (chain.lt(held.mul(1 - CHAIN_TOLERANCE))) {
    return { qty: chain.toFixed(), bps: heldBpsOf(chain, qtyAtPost), status: "moved", action: "moved" };
  }
  if (state.status === "moved" && chain.gt(held.mul(1 + CHAIN_TOLERANCE))) {
    const bps = heldBpsOf(chain, qtyAtPost);
    return { qty: chain.toFixed(), bps, status: bps >= HELD_BPS_FULL - DUST_BPS ? "holding" : "moved", action: "add" };
  }
  return null;
}

export interface ThesisPositionEvent {
  id: string;
  action: PositionAction;
  heldPct: number;
  priceUsd: string | null;
  at: string;
  /** Set once this change is on Arc. */
  txHash: string | null;
}

/** The author's position right now. "none" means they held nothing when they posted. */
export interface ThesisLive {
  status: PositionStatus | "none";
  heldPct: number;
  exitPriceUsd: string | null;
  exitReturnPct: number | null;
  changedAt: string | null;
  /** The latest change that's on Arc. */
  proofTx: string | null;
  events: ThesisPositionEvent[];
}

export interface LiveBadge {
  label: string;
  tone: "good" | "warn" | "bad" | "muted";
  hint: string;
}

function wholePct(value: number): string {
  return `${Math.round(value)}%`;
}

export function liveBadge(live: ThesisLive): LiveBadge {
  switch (live.status) {
    case "holding":
      return { label: `Holding ${wholePct(Math.min(live.heldPct, 100))}`, tone: "good", hint: "The author still holds everything they had when they posted this." };
    case "trimmed":
      return { label: `Trimmed ${wholePct(100 - live.heldPct)}`, tone: "warn", hint: "The author has sold part of what they held when they posted this." };
    case "exited": {
      const at = live.exitPriceUsd ? ` at ${formatPrice(live.exitPriceUsd)}` : "";
      const rounded = live.exitReturnPct !== null ? Math.round(live.exitReturnPct) : null;
      const result = rounded !== null ? `, ${rounded > 0 ? "+" : ""}${rounded}%` : "";
      return { label: `Exited${at}${result}`, tone: (live.exitReturnPct ?? 0) > 0 ? "good" : "bad", hint: "The author has sold out of this position." };
    }
    case "moved":
      return {
        label: live.heldPct <= 0 ? "Left the wallet" : `Moved ${wholePct(100 - live.heldPct)} out`,
        tone: "bad",
        hint: "These tokens left the author's wallet outside the app. That could be a sale elsewhere or a transfer.",
      };
    default:
      return { label: "No position when posted", tone: "muted", hint: "The author didn't hold this token when they posted." };
  }
}

export function positionEventLabel(event: Pick<ThesisPositionEvent, "action" | "heldPct">): string {
  switch (event.action) {
    case "add":
      return event.heldPct > 100 ? "Added to the position" : `Back up to ${wholePct(event.heldPct)}`;
    case "trim":
      return `Sold down to ${wholePct(event.heldPct)}`;
    case "exit":
      return "Sold out";
    default:
      return event.heldPct <= 0 ? "Everything left the wallet" : `Down to ${wholePct(event.heldPct)}: tokens left the wallet`;
  }
}
