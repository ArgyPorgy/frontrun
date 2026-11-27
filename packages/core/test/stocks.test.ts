import { describe, expect, it } from "vitest";
import { evaluateGuardrails, stockMarketStatus, stockPriceGap } from "../src";

describe("stock market hours", () => {
  it("is open on a weekday and closes Friday 8 PM New York time", () => {
    // Friday 27 Nov 2026, 11:00 UTC is 6 AM in New York (winter time, UTC-5).
    const s = stockMarketStatus(new Date("2026-11-27T11:00:00Z"));
    expect(s.open).toBe(true);
    expect(s.nextChange).toBe("2026-11-28T01:00:00.000Z");
  });

  it("is closed from Friday evening until Sunday 8 PM", () => {
    expect(stockMarketStatus(new Date("2026-11-28T01:30:00Z")).open).toBe(false);
    const sat = stockMarketStatus(new Date("2026-11-28T15:00:00Z"));
    expect(sat.open).toBe(false);
    expect(sat.nextChange).toBe("2026-11-30T01:00:00.000Z");
    expect(stockMarketStatus(new Date("2026-11-30T00:59:00Z")).open).toBe(false);
    expect(stockMarketStatus(new Date("2026-11-30T01:00:00Z")).open).toBe(true);
  });

  it("follows summer time", () => {
    // Friday 3 July 2026, New York is UTC-4, so 8 PM is midnight UTC.
    expect(stockMarketStatus(new Date("2026-07-03T23:59:00Z")).open).toBe(true);
    expect(stockMarketStatus(new Date("2026-07-04T00:01:00Z")).open).toBe(false);
  });

  it("uses the new offset when the clocks change before it reopens", () => {
    // Summer time starts at 2 AM on Sunday 14 March 2027, before the 8 PM open.
    expect(stockMarketStatus(new Date("2027-03-13T12:00:00Z")).nextChange).toBe("2027-03-15T00:00:00.000Z");
  });
});

describe("share price check", () => {
  const base = { side: "buy" as const, notionalUsd: "100", priceImpact: 0.001, poolLiquidityUsd: "1000000", riskFlagged: false, denylisted: false };

  it("measures the gap as worse for the trader", () => {
    expect(stockPriceGap("buy", "103", "100")).toBeCloseTo(0.03);
    expect(stockPriceGap("sell", "97", "100")).toBeCloseTo(0.03);
    expect(stockPriceGap("buy", "99", "100")).toBeCloseTo(-0.01);
  });

  it("refuses a buy far above the share price and lets a sale go with a confirm", () => {
    const buy = evaluateGuardrails({ ...base, stock: { sharePriceUsd: "100", tradePriceUsd: "104", marketOpen: true } });
    expect(buy.blocked.map((b) => b.code)).toContain("stock_price_gap");
    const sell = evaluateGuardrails({ ...base, side: "sell", stock: { sharePriceUsd: "100", tradePriceUsd: "96", marketOpen: true } });
    expect(sell.blocked).toHaveLength(0);
    expect(sell.confirm.map((b) => b.code)).toContain("stock_price_gap");
  });

  it("warns on a small gap and when the market is closed", () => {
    const r = evaluateGuardrails({ ...base, stock: { sharePriceUsd: "100", tradePriceUsd: "101.5", marketOpen: false } });
    expect(r.blocked).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toEqual(["stock_price_gap_warn", "stock_market_closed"]);
  });

  it("passes a buy at the share price with nothing to say", () => {
    const r = evaluateGuardrails({ ...base, stock: { sharePriceUsd: "155.73", tradePriceUsd: "155.65", marketOpen: true } });
    expect([...r.blocked, ...r.confirm, ...r.warnings]).toHaveLength(0);
  });
});
