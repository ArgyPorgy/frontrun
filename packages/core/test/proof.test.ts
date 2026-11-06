import { describe, expect, it } from "vitest";
import { applyFillToHeld, chainChange, heldBpsOf, liveBadge, positionEventLabel, reputationScore, type ClosedPositionStats, type HeldState, type ThesisLive } from "../src";

const held = (qty: string, bps = 10000, status: HeldState["status"] = "holding"): HeldState => ({ qty, bps, status });
const live = (over: Partial<ThesisLive>): ThesisLive => ({ status: "holding", heldPct: 100, exitPriceUsd: null, exitReturnPct: null, changedAt: null, proofTx: null, events: [], ...over });

describe("applyFillToHeld", () => {
  it("shows a partial sale as a trim of what was held at posting", () => {
    const change = applyFillToHeld(held("100"), { side: "sell", qty: "40", closedPosition: false }, "100");
    expect(change).toMatchObject({ action: "trim", status: "trimmed", bps: 6000, qty: "60" });
  });

  it("calls it an exit when the position closes, even if our numbers disagree", () => {
    const change = applyFillToHeld(held("100"), { side: "sell", qty: "30", closedPosition: true }, "100");
    expect(change).toMatchObject({ action: "exit", status: "exited", bps: 0, qty: "0" });
  });

  it("calls it an exit when only dust is left", () => {
    expect(applyFillToHeld(held("100"), { side: "sell", qty: "99.8", closedPosition: false }, "100").status).toBe("exited");
  });

  it("can't go below nothing when a sale is bigger than the record", () => {
    expect(applyFillToHeld(held("100"), { side: "sell", qty: "500", closedPosition: false }, "100")).toMatchObject({ status: "exited", qty: "0" });
  });

  it("still reads as holding after adding and then selling only the added part", () => {
    const added = applyFillToHeld(held("100"), { side: "buy", qty: "50", closedPosition: false }, "100");
    expect(added).toMatchObject({ action: "add", status: "holding", bps: 15000 });
    expect(applyFillToHeld(added, { side: "sell", qty: "50", closedPosition: false }, "100")).toMatchObject({ action: "trim", status: "holding", bps: 10000 });
  });

  it("goes back to holding after buying back what was sold", () => {
    const trimmed = applyFillToHeld(held("100"), { side: "sell", qty: "40", closedPosition: false }, "100");
    expect(applyFillToHeld(trimmed, { side: "buy", qty: "40", closedPosition: false }, "100")).toMatchObject({ status: "holding", bps: 10000 });
  });

  it("doesn't let a tiny start overflow what Arc can hold", () => {
    expect(heldBpsOf("1000000000", "0.000001")).toBe(1_000_000);
    expect(heldBpsOf("5", "0")).toBe(0);
  });
});

describe("chainChange", () => {
  it("ignores small differences from rounding or token fees", () => {
    expect(chainChange(held("100"), "98", "100")).toBeNull();
    expect(chainChange(held("100"), "100", "100")).toBeNull();
  });

  it("catches tokens leaving the wallet outside the app", () => {
    expect(chainChange(held("100"), "60", "100")).toMatchObject({ action: "moved", status: "moved", bps: 6000, qty: "60" });
    expect(chainChange(held("100"), "0", "100")).toMatchObject({ action: "moved", bps: 0 });
  });

  it("doesn't count extra tokens unless some had left first", () => {
    expect(chainChange(held("100"), "500", "100")).toBeNull();
    expect(chainChange(held("60", 6000, "moved"), "100", "100")).toMatchObject({ action: "add", status: "holding", bps: 10000 });
  });
});

describe("liveBadge", () => {
  it("says what the author holds, in the words on the badge", () => {
    expect(liveBadge(live({})).label).toBe("Holding 100%");
    expect(liveBadge(live({ status: "trimmed", heldPct: 60 })).label).toBe("Trimmed 40%");
    expect(liveBadge(live({ status: "exited", heldPct: 0, exitPriceUsd: "0.012", exitReturnPct: 38.4 })).label).toBe("Exited at $0.012, +38%");
    expect(liveBadge(live({ status: "moved", heldPct: 0 })).label).toBe("Left the wallet");
    expect(liveBadge(live({ status: "moved", heldPct: 75 })).label).toBe("Moved 25% out");
    expect(liveBadge(live({ status: "none", heldPct: 0 })).label).toBe("No position when posted");
  });

  it("colors an exit by whether it made money", () => {
    expect(liveBadge(live({ status: "exited", exitReturnPct: 12 })).tone).toBe("good");
    expect(liveBadge(live({ status: "exited", exitReturnPct: -12 })).tone).toBe("bad");
  });

  it("caps an added-to position at 100%", () => {
    expect(liveBadge(live({ heldPct: 150 })).label).toBe("Holding 100%");
  });

  it("describes each change in the history", () => {
    expect(positionEventLabel({ action: "trim", heldPct: 60 })).toBe("Sold down to 60%");
    expect(positionEventLabel({ action: "exit", heldPct: 0 })).toBe("Sold out");
    expect(positionEventLabel({ action: "add", heldPct: 150 })).toBe("Added to the position");
  });
});

describe("reputationScore", () => {
  const position = (over: Partial<ClosedPositionStats> = {}): ClosedPositionStats => ({ won: true, returnPct: 30, drawdownPct: 5, holdSeconds: 86_400, feePct: 0.5, ...over });
  const many = (n: number, over: Partial<ClosedPositionStats> = {}) => Array.from({ length: n }, () => position(over));

  it("has no score until something has closed", () => {
    expect(reputationScore([])).toBeNull();
  });

  it("keeps the score between 0 and 100, and its parts add up to it", () => {
    for (const set of [many(50), many(50, { won: false, returnPct: -100, drawdownPct: 90, holdSeconds: 10, feePct: 9 })]) {
      const r = reputationScore(set)!;
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(Math.round(Object.values(r.components).reduce((a, b) => a + b, 0))).toBe(r.score);
    }
  });

  it("doesn't let a couple of lucky trades beat a long record", () => {
    const lucky = reputationScore(many(2, { returnPct: 300 }))!;
    const steady = reputationScore(many(30))!;
    expect(lucky.provisional).toBe(true);
    expect(steady.provisional).toBe(false);
    expect(steady.score).toBeGreaterThan(lucky.score);
  });

  it("marks down the same result reached with more risk", () => {
    const calm = reputationScore(many(10, { drawdownPct: 5 }))!;
    const wild = reputationScore(many(10, { drawdownPct: 45 }))!;
    expect(calm.score).toBeGreaterThan(wild.score);
  });

  it("marks down flipping and high fees", () => {
    expect(reputationScore(many(10))!.score).toBeGreaterThan(reputationScore(many(10, { holdSeconds: 30 }))!.score);
    expect(reputationScore(many(10))!.score).toBeGreaterThan(reputationScore(many(10, { feePct: 3 }))!.score);
  });

  it("caps a single huge win so it can't carry a losing record", () => {
    const set = [position({ returnPct: 100_000 }), ...many(9, { won: false, returnPct: -40 })];
    const r = reputationScore(set)!;
    expect(r.avgReturnPct).toBeLessThan(0);
    expect(r.winRatePct).toBe(10);
    expect(r.score).toBeLessThan(50);
  });

  it("ranks a good record above a bad one", () => {
    expect(reputationScore(many(10))!.score).toBeGreaterThan(reputationScore(many(10, { won: false, returnPct: -30 }))!.score);
  });
});
