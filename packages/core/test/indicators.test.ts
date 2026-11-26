import { describe, expect, it } from "vitest";
import { adx, atr, bollinger, defaultPerpSignal, ema, indicatorSnapshot, macd, rsi, sma, stochastic, type Ohlc } from "../src";

const candles = (closes: number[]): Ohlc[] => closes.map((c, i) => ({ time: i, open: c, high: c + 1, low: c - 1, close: c }));

describe("indicators", () => {
  it("averages", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3);
    expect(e[4]).toBeCloseTo(4);
  });

  it("RSI matches Wilder's worked example", () => {
    // The classic 14-period example closes; the first RSI is about 70.46.
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const r = rsi(closes, 14);
    expect(r[13]).toBeNull();
    expect(r[14]!).toBeCloseTo(70.46, 1);
    expect(rsi([1, 2, 3, 4, 5, 6], 3).at(-1)).toBe(100);
  });

  it("MACD, Bollinger, ATR, stochastic and ADX on a steady rise", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const c = candles(closes);
    const m = macd(closes);
    expect(m.line.at(-1)!).toBeGreaterThan(0);
    expect(m.histogram.at(-1)!).toBeCloseTo(0, 6);
    const bb = bollinger(closes);
    expect(bb.middle.at(-1)).toBeCloseTo(169.5);
    expect(bb.upper.at(-1)!).toBeGreaterThan(bb.middle.at(-1)!);
    expect(atr(c).at(-1)!).toBeCloseTo(2, 1);
    expect(stochastic(c).k.at(-1)!).toBeGreaterThan(90);
    const d = adx(c);
    expect(d.adx.at(-1)!).toBeGreaterThan(50);
    expect(d.plusDi.at(-1)!).toBeGreaterThan(d.minusDi.at(-1)!);
  });

  it("the default strategy goes with a clean trend and stays out of a flat market", () => {
    // Trends with pullbacks, so RSI isn't pinned at an extreme the strategy refuses to chase.
    const up = indicatorSnapshot(candles(Array.from({ length: 120 }, (_, i) => 150 + i * 0.25 + Math.sin(i / 5) * 4)))!;
    const s = defaultPerpSignal(up);
    expect(s.bias).toBe("long");
    expect(s.stopLoss!).toBeLessThan(up.price);
    expect(s.takeProfit!).toBeGreaterThan(up.price);
    const down = indicatorSnapshot(candles(Array.from({ length: 120 }, (_, i) => 150 - i * 0.2 + Math.sin(i / 3) * 2)))!;
    expect(defaultPerpSignal(down).bias).toBe("short");
    const flat = indicatorSnapshot(candles(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 2) * 0.3)))!;
    const f = defaultPerpSignal(flat);
    expect(f.bias).toBe("none");
    expect(f.stopLoss).toBeNull();
    const chased = indicatorSnapshot(candles(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 0.8)))!;
    expect(chased.rsi14!).toBeGreaterThan(75);
    expect(defaultPerpSignal(chased).bias).toBe("none");
  });

  it("crowded funding counts against that side", () => {
    const up = indicatorSnapshot(candles(Array.from({ length: 120 }, (_, i) => 150 + i * 0.25 + Math.sin(i / 5) * 4)))!;
    expect(defaultPerpSignal(up, { long: 0.02, short: -0.02 }).score).toBe(defaultPerpSignal(up).score - 1);
  });
});
