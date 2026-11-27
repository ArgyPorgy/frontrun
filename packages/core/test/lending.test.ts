import { describe, expect, it } from "vitest";
import {
  LENDING_MIN_HEALTH,
  STOCK_MARKETS,
  STOCK_TOKENS,
  aaveRayToApy,
  lendingActionSchema,
  lendingHealthFactor,
  lendingLiquidationPrice,
  lendingMaxBorrow,
  lendingMaxCollateralOut,
  ratePerSecondToApy,
  stockMarketParams,
  stockToken,
} from "../src";

describe("lending math", () => {
  it("health factor and liquidation price agree", () => {
    // 2 shares at $150 with a 62.5% LLTV can carry $187.50 of debt before liquidation.
    expect(lendingHealthFactor(300, 100, 0.625)).toBeCloseTo(1.875);
    expect(lendingHealthFactor(300, 0, 0.625)).toBeNull();
    const liq = lendingLiquidationPrice(2, 100, 0.625)!;
    expect(liq).toBeCloseTo(80);
    expect(lendingHealthFactor(2 * liq, 100, 0.625)).toBeCloseTo(1);
  });

  it("max borrow stops at the safety margin", () => {
    const room = lendingMaxBorrow(300, 0, 0.625);
    expect(room).toBeCloseTo(150);
    expect(lendingHealthFactor(300, room, 0.625)).toBeCloseTo(LENDING_MIN_HEALTH);
    expect(lendingMaxBorrow(300, 200, 0.625)).toBe(0);
  });

  it("collateral out keeps the loan above the margin", () => {
    expect(lendingMaxCollateralOut(2, 150, 0, 0.625)).toBe(2);
    const out = lendingMaxCollateralOut(2, 150, 100, 0.625);
    expect(lendingHealthFactor((2 - out) * 150, 100, 0.625)).toBeCloseTo(LENDING_MIN_HEALTH);
    expect(lendingMaxCollateralOut(2, 150, 200, 0.625)).toBe(0);
  });

  it("converts protocol rates to yearly percentages", () => {
    // 5% a year continuously compounded, as Morpho's per-second wad rate.
    const perSecond = BigInt(Math.round((Math.log(1.05) / 31_536_000) * 1e18));
    expect(ratePerSecondToApy(perSecond)).toBeCloseTo(5, 3);
    // Aave quotes APR in ray; 4.377% APR compounds to about 4.47%.
    expect(aaveRayToApy(43_773_209_916_931_971_471_685_033n)).toBeCloseTo(4.474, 2);
  });
});

describe("stock markets", () => {
  it("every market points at a known stock token with a sane LLTV", () => {
    for (const m of STOCK_MARKETS) {
      const p = stockMarketParams(m);
      expect(stockToken(m.ticker)?.address).toBe(p.collateralToken);
      expect(Number(m.lltv) / 1e18).toBeGreaterThan(0.5);
      expect(Number(m.lltv) / 1e18).toBeLessThan(0.8);
    }
    expect(new Set(STOCK_MARKETS.map((m) => m.id)).size).toBe(STOCK_MARKETS.length);
    expect(STOCK_MARKETS.filter((m) => m.ours).map((m) => m.ticker).sort()).toEqual(["AMZN", "MSFT", "TSLA"]);
  });

  it("finds tokens by ticker, symbol or address", () => {
    const nvda = STOCK_TOKENS[0]!;
    expect(stockToken("nvda")).toBe(nvda);
    expect(stockToken("NVDAc")).toBe(nvda);
    expect(stockToken(nvda.address.toLowerCase())).toBe(nvda);
    expect(stockToken("DOGE")).toBeUndefined();
  });

  it("needs an amount unless it's everything", () => {
    expect(lendingActionSchema.safeParse({ marketId: "aave-usdc", action: "supply" }).success).toBe(false);
    expect(lendingActionSchema.safeParse({ marketId: "aave-usdc", action: "supply", amount: "0" }).success).toBe(false);
    expect(lendingActionSchema.safeParse({ marketId: "aave-usdc", action: "supply", amount: "12.5" }).success).toBe(true);
    expect(lendingActionSchema.safeParse({ marketId: "aave-usdc", action: "withdraw", max: true }).success).toBe(true);
  });
});
