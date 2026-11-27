import { afterEach, describe, expect, it, vi } from "vitest";
import { llamaPrices } from "../src/market/defillama";
import { mergeCandles, rollUp } from "../src/market/live-candles";

const m = (time: number, open: number, high: number, low: number, close: number) => ({ time, open, high, low, close });
const c = (time: number, close: number, volume = 10) => ({ time, open: close, high: close, low: close, close, volume });

describe("our own candles", () => {
  it("rolls minutes up into a timeframe", () => {
    const out = rollUp([m(960, 11, 12, 10.5, 11.5), m(900, 10, 11, 9, 10.5), m(1200, 11.5, 13, 11, 12)], "5m");
    expect(out).toEqual([
      { time: 900, open: 10, high: 12, low: 9, close: 11.5, volume: 0 },
      { time: 1200, open: 11.5, high: 13, low: 11, close: 12, volume: 0 },
    ]);
  });

  it("lays live candles over the newest end of the history", () => {
    const merged = mergeCandles([c(0, 100), c(60, 101)], [{ ...c(60, 103, 0), high: 104, low: 100.5 }, c(120, 102, 0)]);
    expect(merged).toHaveLength(3);
    // The last history candle keeps its open and volume and takes the live high, low and close.
    expect(merged[1]).toEqual({ time: 60, open: 101, high: 104, low: 100.5, close: 103, volume: 10 });
    expect(merged[2]!.close).toBe(102);
  });

  it("leaves live candles out when they price a different token", () => {
    const history = [c(0, 100), c(60, 101)];
    expect(mergeCandles(history, [c(120, 0.0099, 0)])).toBe(history);
  });

  it("shows live candles alone when there's no history", () => {
    expect(mergeCandles([], [c(60, 5, 0)])).toEqual([c(60, 5, 0)]);
  });
});

describe("DefiLlama prices", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prices what it can, and skips stale, unsure and untracked ones", async () => {
    const now = 1_795_800_000_000;
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          coins: {
            "base:0xaaa": { price: 1.5, timestamp: now / 1000 - 60, confidence: 0.99 },
            "base:0xbbb": { price: 2, timestamp: now / 1000 - 7200, confidence: 0.99 },
            "base:0xccc": { price: 3, timestamp: now / 1000 - 60, confidence: 0.5 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await llamaPrices(["base:0xaaa", "base:0xbbb", "base:0xccc", "arc:0xddd"], now);
    expect([...out.entries()]).toEqual([["base:0xaaa", "1.5"]]);
    // Arc isn't tracked by DefiLlama, so it isn't even asked for.
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toContain("0xddd");
  });
});
