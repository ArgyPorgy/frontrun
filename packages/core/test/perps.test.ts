import { describe, expect, it } from "vitest";
import { perpLiquidationPrice, perpOrderProblem, perpPnlUsd } from "../src/perps";

const market = { symbol: "BTC/USD", minLeverage: 1, maxLeverage: 50, minPositionUsd: 100, isOpen: true };

describe("perps", () => {
  it("prices profit and loss by side and leverage", () => {
    expect(perpPnlUsd({ side: "long", collateralUsd: 100, leverage: 10, entryPrice: 100 }, 110)).toBeCloseTo(100);
    expect(perpPnlUsd({ side: "short", collateralUsd: 100, leverage: 10, entryPrice: 100 }, 110)).toBeCloseTo(-100);
    expect(perpPnlUsd({ side: "short", collateralUsd: 50, leverage: 2, entryPrice: 200 }, 180)).toBeCloseTo(10);
  });

  it("puts liquidation on the losing side, closer with more leverage", () => {
    expect(perpLiquidationPrice({ side: "long", leverage: 10, entryPrice: 100 })).toBeCloseTo(91);
    expect(perpLiquidationPrice({ side: "short", leverage: 10, entryPrice: 100 })).toBeCloseTo(109);
    expect(perpLiquidationPrice({ side: "long", leverage: 2, entryPrice: 100 })).toBeCloseTo(55);
  });

  it("refuses orders the venue would refuse", () => {
    expect(perpOrderProblem(market, { collateralUsd: 20, leverage: 5, side: "long" }, 100)).toBeNull();
    expect(perpOrderProblem(market, { collateralUsd: 10, leverage: 5, side: "long" }, 100)).toMatch(/smallest position/);
    expect(perpOrderProblem(market, { collateralUsd: 10, leverage: 60, side: "long" }, 100)).toMatch(/between 1x and 50x/);
    expect(perpOrderProblem({ ...market, isOpen: false }, { collateralUsd: 50, leverage: 5, side: "long" }, 100)).toMatch(/closed/);
  });

  it("checks take-profit and stop-loss sit on the right sides", () => {
    expect(perpOrderProblem(market, { collateralUsd: 50, leverage: 5, side: "long", takeProfit: 90 }, 100)).toMatch(/Take-profit/);
    expect(perpOrderProblem(market, { collateralUsd: 50, leverage: 5, side: "long", stopLoss: 110 }, 100)).toMatch(/Stop-loss/);
    expect(perpOrderProblem(market, { collateralUsd: 50, leverage: 5, side: "short", takeProfit: 90, stopLoss: 110 }, 100)).toBeNull();
  });
});
