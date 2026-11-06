import { LEADERBOARD_MIN_RESOLVED } from "./thesis";

/** What one closed position contributes. Several theses on one position count once. */
export interface ClosedPositionStats {
  won: boolean;
  /** Realized return on the position, after what the trades cost. */
  returnPct: number;
  /** How far the price fell below the author's posted price while they held. */
  drawdownPct: number;
  holdSeconds: number;
  /** What the trades cost, as a share of the money that moved through them. */
  feePct: number;
}

/** Points out of 100. These add up to the score. */
export const REPUTATION_WEIGHTS = { win: 35, return: 30, risk: 20, hold: 8, fees: 7 } as const;
export type ReputationComponents = Record<keyof typeof REPUTATION_WEIGHTS, number>;

export interface Reputation {
  score: number;
  provisional: boolean;
  closed: number;
  wins: number;
  winRatePct: number;
  avgReturnPct: number;
  avgDrawdownPct: number;
  avgHoldSeconds: number;
  feePct: number;
  components: ReputationComponents;
}

/** How many closed positions it takes for the record to count as much as the neutral starting point. */
const SAMPLE_PRIOR = 5;
/** One lucky 100x shouldn't outweigh a whole record, so returns are capped before averaging. */
const RETURN_CAP_PCT = 300;
/** An average return this big earns about three quarters of the return points. */
const RETURN_SCALE_PCT = 50;
/** An average dip this deep earns no risk points. */
const DRAWDOWN_FLOOR_PCT = 50;
/** Holding this long earns all the hold points. Scaled by log, so the first hours matter most. */
const HOLD_FULL_SECONDS = 72 * 3600;
/** Costs this high earn no fee points. */
const FEE_CEILING_PCT = 3;

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The trader's score out of 100. Win rate says how often they were right, return says how much it paid,
 * and drawdown, holding time and fees say what it took to get there. A short record is pulled toward the
 * middle, so a couple of lucky trades can't top the board. Null means nothing has closed yet.
 */
export function reputationScore(positions: ClosedPositionStats[]): Reputation | null {
  const closed = positions.length;
  if (!closed) return null;
  const wins = positions.filter((p) => p.won).length;
  const avgReturnPct = average(positions.map((p) => clamp(p.returnPct, -100, RETURN_CAP_PCT)));
  const avgDrawdownPct = average(positions.map((p) => Math.max(p.drawdownPct, 0)));
  const avgHoldSeconds = average(positions.map((p) => Math.max(p.holdSeconds, 0)));
  const feePct = average(positions.map((p) => Math.max(p.feePct, 0)));

  const confidence = closed / (closed + SAMPLE_PRIOR);
  const towardMiddle = (raw: number) => 0.5 + (raw - 0.5) * confidence;

  const win = (wins + SAMPLE_PRIOR / 2) / (closed + SAMPLE_PRIOR);
  const ret = 0.5 + 0.5 * Math.tanh((avgReturnPct * confidence) / RETURN_SCALE_PCT);
  const risk = towardMiddle(1 - clamp(avgDrawdownPct / DRAWDOWN_FLOOR_PCT, 0, 1));
  const hold = towardMiddle(clamp(Math.log1p(avgHoldSeconds) / Math.log1p(HOLD_FULL_SECONDS), 0, 1));
  const fees = towardMiddle(1 - clamp(feePct / FEE_CEILING_PCT, 0, 1));

  const components: ReputationComponents = {
    win: win * REPUTATION_WEIGHTS.win,
    return: ret * REPUTATION_WEIGHTS.return,
    risk: risk * REPUTATION_WEIGHTS.risk,
    hold: hold * REPUTATION_WEIGHTS.hold,
    fees: fees * REPUTATION_WEIGHTS.fees,
  };
  const score = Math.round(components.win + components.return + components.risk + components.hold + components.fees);
  return {
    score: clamp(score, 0, 100),
    provisional: closed < LEADERBOARD_MIN_RESOLVED,
    closed,
    wins,
    winRatePct: (wins / closed) * 100,
    avgReturnPct,
    avgDrawdownPct,
    avgHoldSeconds,
    feePct,
    components,
  };
}

/** A score on someone's profile, with where to check it. */
export interface ReputationView extends Reputation {
  wallet: string | null;
  registry: string;
  attestTx: string | null;
  attestedAt: string | null;
  computedAt: string;
}

/** Selector of ReputationRegistry.scoreOf(address), so a browser can read it with a plain eth_call. */
export const SCORE_OF_SELECTOR = "0x133af456";
