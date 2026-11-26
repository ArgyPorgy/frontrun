/**
 * Technical indicators over OHLC candles, oldest first. Each returns one value per candle, null until it has
 * enough history. Veranta's candles carry no volume, so volume-based indicators (VWAP, OBV) aren't here:
 * anything that needs volume would be made up.
 */
export interface Ohlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

type Series = Array<number | null>;

export function sma(values: number[], period: number): Series {
  const out: Series = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    if (prev === null) {
      // Seeded with the simple average of the first period, as is usual.
      prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      prev = values[i]! * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

/** Wilder's smoothing, used by RSI, ATR and ADX. */
function wilder(values: number[], period: number, from = 0): Series {
  const out: Series = values.map(() => null);
  if (values.length - from < period) return out;
  let prev = values.slice(from, from + period).reduce((a, b) => a + b, 0) / period;
  out[from + period - 1] = prev;
  for (let i = from + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): Series {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const g = wilder(gains, period, 1);
  const l = wilder(losses, period, 1);
  return closes.map((_, i) => {
    const gi = g[i];
    const li = l[i];
    if (gi == null || li == null) return null;
    if (li === 0) return gi === 0 ? 50 : 100;
    return 100 - 100 / (1 + gi / li);
  });
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i]! - s[i]! : null));
  const start = line.findIndex((v) => v !== null);
  const sig: Series = line.map(() => null);
  if (start >= 0) {
    const tail = ema(line.slice(start) as number[], signal);
    tail.forEach((v, j) => (sig[start + j] = v));
  }
  const histogram = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i]! : null));
  return { line, signal: sig, histogram };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper: Series = [];
  const lower: Series = [];
  for (let i = 0; i < closes.length; i++) {
    const m = mid[i];
    if (m == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const window = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(window.reduce((a, v) => a + (v - m) ** 2, 0) / period);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  }
  return { middle: mid, upper, lower };
}

function trueRanges(c: Ohlc[]): number[] {
  return c.map((x, i) => {
    if (i === 0) return x.high - x.low;
    const pc = c[i - 1]!.close;
    return Math.max(x.high - x.low, Math.abs(x.high - pc), Math.abs(x.low - pc));
  });
}

export function atr(c: Ohlc[], period = 14): Series {
  return wilder(trueRanges(c), period);
}

export function stochastic(c: Ohlc[], period = 14, smooth = 3) {
  const k: Series = c.map((x, i) => {
    if (i < period - 1) return null;
    const w = c.slice(i - period + 1, i + 1);
    const hi = Math.max(...w.map((y) => y.high));
    const lo = Math.min(...w.map((y) => y.low));
    return hi === lo ? 50 : ((x.close - lo) / (hi - lo)) * 100;
  });
  const start = k.findIndex((v) => v !== null);
  const d: Series = k.map(() => null);
  if (start >= 0) sma(k.slice(start) as number[], smooth).forEach((v, j) => (d[start + j] = v));
  return { k, d };
}

export function adx(c: Ohlc[], period = 14) {
  const plusDm = [0];
  const minusDm = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i]!.high - c[i - 1]!.high;
    const down = c[i - 1]!.low - c[i]!.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const tr = wilder(trueRanges(c), period, 1);
  const pdm = wilder(plusDm, period, 1);
  const mdm = wilder(minusDm, period, 1);
  const plusDi: Series = c.map((_, i) => (tr[i] ? (100 * pdm[i]!) / tr[i]! : null));
  const minusDi: Series = c.map((_, i) => (tr[i] ? (100 * mdm[i]!) / tr[i]! : null));
  const dx = c.map((_, i) => {
    const p = plusDi[i];
    const m = minusDi[i];
    if (p == null || m == null || p + m === 0) return null;
    return (100 * Math.abs(p - m)) / (p + m);
  });
  const start = dx.findIndex((v) => v !== null);
  const value: Series = c.map(() => null);
  if (start >= 0) wilder(dx.slice(start) as number[], period).forEach((v, j) => (value[start + j] = v));
  return { adx: value, plusDi, minusDi };
}

const last = (s: Series): number | null => {
  for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i]!;
  return null;
};
const round = (n: number | null, dp = 4): number | null => (n === null ? null : Number(n.toPrecision(dp + 2)));

export interface IndicatorSnapshot {
  price: number;
  candles: number;
  sma20: number | null;
  sma50: number | null;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  macd: { line: number | null; signal: number | null; histogram: number | null; histogramRising: boolean | null };
  bollinger: { upper: number | null; middle: number | null; lower: number | null; percentB: number | null };
  atr14: number | null;
  atrPct: number | null;
  stochastic: { k: number | null; d: number | null };
  adx14: { adx: number | null; plusDi: number | null; minusDi: number | null };
  changePct: number | null;
}

/** The latest value of each indicator, in a form short enough to put in front of a model. */
export function indicatorSnapshot(c: Ohlc[]): IndicatorSnapshot | null {
  if (c.length < 2) return null;
  const closes = c.map((x) => x.close);
  const price = closes[closes.length - 1]!;
  const m = macd(closes);
  const hist = m.histogram.filter((v): v is number => v !== null);
  const bb = bollinger(closes);
  const up = last(bb.upper);
  const lo = last(bb.lower);
  const a = last(atr(c));
  const st = stochastic(c);
  const dx = adx(c);
  return {
    price,
    candles: c.length,
    sma20: round(last(sma(closes, 20))),
    sma50: round(last(sma(closes, 50))),
    ema20: round(last(ema(closes, 20))),
    ema50: round(last(ema(closes, 50))),
    rsi14: round(last(rsi(closes)), 2),
    macd: {
      line: round(last(m.line)),
      signal: round(last(m.signal)),
      histogram: round(last(m.histogram)),
      histogramRising: hist.length >= 2 ? hist[hist.length - 1]! > hist[hist.length - 2]! : null,
    },
    bollinger: {
      upper: round(up),
      middle: round(last(bb.middle)),
      lower: round(lo),
      percentB: up !== null && lo !== null && up !== lo ? round((price - lo) / (up - lo), 2) : null,
    },
    atr14: round(a),
    atrPct: a === null ? null : round((a / price) * 100, 2),
    stochastic: { k: round(last(st.k), 2), d: round(last(st.d), 2) },
    adx14: { adx: round(last(dx.adx), 2), plusDi: round(last(dx.plusDi), 2), minusDi: round(last(dx.minusDi), 2) },
    changePct: round(((price - closes[0]!) / closes[0]!) * 100, 2),
  };
}

export type SignalBias = "long" | "short" | "none";

export interface PerpSignal {
  bias: SignalBias;
  /** From -6 (strong short) to +6 (strong long). */
  score: number;
  reasons: string[];
  /** Levels the default strategy would use, from ATR: a stop 1.5 ATR away and a target 3 ATR away. */
  stopLoss: number | null;
  takeProfit: number | null;
}

/**
 * The default perp strategy: trade with the trend when momentum agrees, and not into an extreme. It's one
 * view of the data, not advice, and an agent's owner can write any strategy they like over it.
 *
 * - Trend: EMA20 against EMA50, and price against EMA50. ADX above 20 means the trend is worth trading.
 * - Momentum: MACD histogram's side and direction, RSI's side of 50.
 * - Don't chase: RSI past 75 or below 25, or price outside the Bollinger bands, counts against an entry.
 * - Crowding: if one side pays the other a funding rate well above normal, that side is crowded.
 * - Risk: stop 1.5 ATR away, target 3 ATR away, so each win is about twice each loss.
 */
export function defaultPerpSignal(s: IndicatorSnapshot, funding?: { long?: number; short?: number } | null): PerpSignal {
  const reasons: string[] = [];
  let score = 0;
  const { price, ema20, ema50, rsi14, macd: m, adx14, bollinger: bb, atr14 } = s;
  if (ema20 !== null && ema50 !== null) {
    if (ema20 > ema50 && price > ema50) {
      score += 2;
      reasons.push("Uptrend: EMA20 above EMA50, price above EMA50.");
    } else if (ema20 < ema50 && price < ema50) {
      score -= 2;
      reasons.push("Downtrend: EMA20 below EMA50, price below EMA50.");
    } else reasons.push("Mixed trend: the moving averages disagree.");
  } else reasons.push("Not enough history for the trend averages.");
  if (m.histogram !== null) {
    if (m.histogram > 0 && m.histogramRising !== false) {
      score += 1;
      reasons.push("MACD momentum positive.");
    } else if (m.histogram < 0 && m.histogramRising !== true) {
      score -= 1;
      reasons.push("MACD momentum negative.");
    }
  }
  if (rsi14 !== null) {
    if (rsi14 > 75) {
      score -= 1;
      reasons.push(`RSI ${rsi14.toFixed(0)}: overbought, a poor place to buy.`);
    } else if (rsi14 < 25) {
      score += 1;
      reasons.push(`RSI ${rsi14.toFixed(0)}: oversold, a poor place to sell.`);
    } else if (rsi14 >= 50) {
      score += 1;
      reasons.push(`RSI ${rsi14.toFixed(0)}: above 50.`);
    } else {
      score -= 1;
      reasons.push(`RSI ${rsi14.toFixed(0)}: below 50.`);
    }
  }
  if (bb.percentB !== null) {
    if (bb.percentB > 1) {
      score -= 1;
      reasons.push("Price above the upper Bollinger band: stretched.");
    } else if (bb.percentB < 0) {
      score += 1;
      reasons.push("Price below the lower Bollinger band: stretched.");
    }
  }
  if (funding?.long !== undefined && funding.short !== undefined) {
    // Veranta's rate, as it reports it: positive means that side pays. This far from zero, it's paying a lot to stay in.
    if (funding.long > 0.005) {
      score -= 1;
      reasons.push("Longs are paying a high funding rate: crowded long.");
    } else if (funding.short > 0.005) {
      score += 1;
      reasons.push("Shorts are paying a high funding rate: crowded short.");
    }
  }
  const trending = adx14.adx !== null && adx14.adx >= 20;
  if (adx14.adx !== null) reasons.push(trending ? `ADX ${adx14.adx.toFixed(0)}: trending.` : `ADX ${adx14.adx.toFixed(0)}: no clear trend, so no entry.`);
  const bias: SignalBias = !trending ? "none" : score >= 3 ? "long" : score <= -3 ? "short" : "none";
  const dir = bias === "long" ? 1 : bias === "short" ? -1 : 0;
  const stopLoss = dir && atr14 ? round(price - dir * 1.5 * atr14, 6) : null;
  const takeProfit = dir && atr14 ? round(price + dir * 3 * atr14, 6) : null;
  return { bias, score, reasons, stopLoss, takeProfit };
}
