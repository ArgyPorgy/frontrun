import { describe, expect, it } from "vitest";
import { perpPositionStats, reputationScore, type ClosedPositionStats } from "../src";

const opened = new Date("2026-11-20T14:00:00Z");
const hoursLater = (h: number) => new Date(opened.getTime() + h * 3_600_000);
const perp = (over: Partial<Parameters<typeof perpPositionStats>[0]> = {}) =>
  perpPositionStats({ side: "long", collateralUsd: 100, leverage: 5, entryPrice: 200, stopLoss: 190, realizedPnlUsd: 20, feesUsd: 0.45, openedAt: opened, closedAt: hoursLater(6), liquidated: false, ...over });

describe("perps in the record", () => {
  it("returns on collateral, with risk from the stop and leverage", () => {
    const s = perp();
    expect(s.won).toBe(true);
    expect(s.returnPct).toBeCloseTo(20);
    // A 5% stop at 5x puts a quarter of the collateral on the line.
    expect(s.drawdownPct).toBeCloseTo(25);
    expect(s.holdSeconds).toBe(6 * 3600);
    expect(s.feePct).toBeCloseTo(0.045);
    expect(s.kind).toBe("perp");
  });

  it("counts a short's stop above entry, and no stop as near-total risk", () => {
    expect(perp({ side: "short", stopLoss: 210 }).drawdownPct).toBeCloseTo(25);
    expect(perp({ stopLoss: null }).drawdownPct).toBe(90);
    // A stop on the wrong side of entry protects nothing.
    expect(perp({ stopLoss: 205 }).drawdownPct).toBe(90);
  });

  it("never reports less risk than was actually lost", () => {
    expect(perp({ realizedPnlUsd: -40 }).drawdownPct).toBeCloseTo(40);
    const liquidated = perp({ realizedPnlUsd: -100, liquidated: true });
    expect(liquidated.won).toBe(false);
    expect(liquidated.drawdownPct).toBe(100);
  });

  it("scores a mixed record and says how many were perps", () => {
    const spot: ClosedPositionStats = { won: true, returnPct: 12, drawdownPct: 5, holdSeconds: 86_400, feePct: 0.5 };
    const r = reputationScore([spot, perp(), perp({ realizedPnlUsd: -25 })])!;
    expect(r.closed).toBe(3);
    expect(r.perpsClosed).toBe(2);
    expect(r.wins).toBe(2);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("rewards a tight stop over none, all else equal", () => {
    const tight = reputationScore(Array.from({ length: 6 }, () => perp()))!;
    const loose = reputationScore(Array.from({ length: 6 }, () => perp({ stopLoss: null })))!;
    expect(tight.components.risk).toBeGreaterThan(loose.components.risk);
    expect(tight.score).toBeGreaterThan(loose.score);
  });
});
