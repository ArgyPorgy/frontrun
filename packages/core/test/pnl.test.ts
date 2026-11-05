import { describe, expect, it } from "vitest";
import {
  EMPTY_POSITION,
  applyBuy,
  applySell,
  averageEntry,
  portfolioTotals,
  reconcile,
  returnPct,
  unrealizedPnl,
  winRate,
} from "../src/pnl";
import { D } from "../src/money";

describe("weighted average cost", () => {
  it("averages cost across buys", () => {
    let p = applyBuy(EMPTY_POSITION, { qty: 100, usdSpent: 100 });
    p = applyBuy(p, { qty: 100, usdSpent: 300 });
    expect(p.qty).toBe("200");
    expect(p.costBasisUsd).toBe("400");
    expect(averageEntry(p)).toBe("2");
  });

  it("includes fees in cost", () => {
    const p = applyBuy(EMPTY_POSITION, { qty: 10, usdSpent: 100, feesUsd: 1 });
    expect(p.costBasisUsd).toBe("101");
  });

  it("realizes proceeds minus average cost of the qty sold", () => {
    let p = applyBuy(EMPTY_POSITION, { qty: 100, usdSpent: 100 });
    p = applyBuy(p, { qty: 100, usdSpent: 300 });
    const sell = applySell(p, { qty: 50, usdReceived: 150 });
    // avg cost $2, so 50 cost $100 and proceeds were $150
    expect(sell.realizedDeltaUsd).toBe("50");
    expect(sell.state.qty).toBe("150");
    expect(sell.state.costBasisUsd).toBe("300");
    expect(sell.closed).toBe(false);
  });

  it("subtracts sell fees from proceeds", () => {
    const p = applyBuy(EMPTY_POSITION, { qty: 10, usdSpent: 10 });
    const sell = applySell(p, { qty: 10, usdReceived: 20, feesUsd: 1 });
    expect(sell.realizedDeltaUsd).toBe("9");
  });

  it("closes the position on a full sell and leaves no dust", () => {
    const p = applyBuy(EMPTY_POSITION, { qty: "3.33", usdSpent: 10 });
    const sell = applySell(p, { qty: "3.33", usdReceived: 5 });
    expect(sell.closed).toBe(true);
    expect(sell.state.qty).toBe("0");
    expect(sell.state.costBasisUsd).toBe("0");
    expect(sell.realizedDeltaUsd).toBe("-5");
  });

  it("does not lose realized PnL across partial sells", () => {
    let p = applyBuy(EMPTY_POSITION, { qty: 3, usdSpent: 10 });
    for (let i = 0; i < 3; i++) p = applySell(p, { qty: 1, usdReceived: 4 }).state;
    expect(D(p.realizedPnlUsd).toDecimalPlaces(8).toNumber()).toBe(2);
    expect(p.qty).toBe("0");
  });

  it("treats tokens sold beyond the tracked qty as zero cost", () => {
    const p = applyBuy(EMPTY_POSITION, { qty: 10, usdSpent: 10 });
    const sell = applySell(p, { qty: 15, usdReceived: 30 });
    expect(sell.realizedDeltaUsd).toBe("20");
    expect(sell.closed).toBe(true);
  });

  it("rejects non-positive fills", () => {
    expect(() => applyBuy(EMPTY_POSITION, { qty: 0, usdSpent: 1 })).toThrow();
    expect(() => applySell(EMPTY_POSITION, { qty: -1, usdReceived: 1 })).toThrow();
  });
});

describe("unrealized", () => {
  it("is qty at live price minus remaining cost", () => {
    const p = applyBuy(EMPTY_POSITION, { qty: 100, usdSpent: 100 });
    expect(unrealizedPnl(p, 1.5)).toBe("50");
    expect(returnPct(p, 1.5)).toBe(50);
  });
});

describe("reconcile", () => {
  const base = applyBuy(EMPTY_POSITION, { qty: 100, usdSpent: 200 });

  it("leaves a matching balance alone", () => {
    expect(reconcile(base, 100, 5)).toBe(base);
  });

  it("shrinks cost pro rata on a transfer out, with no realized PnL", () => {
    const r = reconcile(base, 50, 5);
    expect(r.qty).toBe("50");
    expect(r.costBasisUsd).toBe("100");
    expect(r.realizedPnlUsd).toBe("0");
  });

  it("books a transfer in at market so it can't show as instant profit", () => {
    const r = reconcile(base, 110, 5);
    expect(r.qty).toBe("110");
    expect(r.costBasisUsd).toBe("250");
    expect(unrealizedPnl(r, 5)).toBe(unrealizedPnl(base, 5));
  });
});

describe("portfolio totals", () => {
  it("sums realized, unrealized and value", () => {
    const open = applyBuy(EMPTY_POSITION, { qty: 10, usdSpent: 100 });
    const totals = portfolioTotals([{ ...open, realizedPnlUsd: "5", priceUsd: 20 }], ["-3", "8"]);
    expect(totals.valueUsd).toBe("200");
    expect(totals.unrealizedUsd).toBe("100");
    expect(totals.realizedUsd).toBe("10");
    expect(totals.allTimeUsd).toBe("110");
  });

  it("values a position with no price at cost, not at zero", () => {
    const open = applyBuy(EMPTY_POSITION, { qty: 10, usdSpent: 100 });
    const totals = portfolioTotals([{ ...open, priceUsd: null }], []);
    expect(totals.valueUsd).toBe("100");
    expect(totals.unrealizedUsd).toBe("0");
  });
});

describe("win rate", () => {
  it("returns null with no closed positions", () => {
    expect(winRate([])).toBeNull();
  });
  it("counts positive closes", () => {
    expect(winRate(["10", "-5", "0", "1"])).toBe(50);
  });
});
