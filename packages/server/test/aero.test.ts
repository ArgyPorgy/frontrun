import { AERO_BASE } from "@frontrun/core";
import { describe, expect, it } from "vitest";
import { assertAeroSwap } from "../src/providers/aero";
import { comparableNetUsd } from "../src/routing/engine";
import type { ProviderQuote, RouteRequest } from "../src/providers/types";

const wallet = "0x1111111111111111111111111111111111111111";
const req: RouteRequest = { side: "buy", chain: "base", address: "0xb20000000000000000000078ee7ce2fe4908108c", decimals: 8, usdcIn: "5000", evmAddress: wallet, solanaAddress: null, priceUsd: "153", notionalUsd: "5000" };
const quote = (over: Partial<ProviderQuote>): ProviderQuote => ({ provider: "flash", netOutputUsd: "0", expectedOut: "0", feeUsd: "0", gasUsd: "0", etaSeconds: 2, priceImpact: null, recommendedSlippage: null, crossChain: false, needsSetup: false, sponsoredSetup: false, latencyMs: 1, raw: null, ...over });

describe("valuing quotes alike", () => {
  it("values a buy by the tokens it delivers, not the route's own price", () => {
    // Flash says its tokens are worth more, but Aero delivers more of them.
    const flash = quote({ provider: "flash", netOutputUsd: "4969.75", expectedOut: "32.37051" });
    const aero = quote({ provider: "aero", netOutputUsd: "4959.60", expectedOut: "32.430057" });
    expect(Number(comparableNetUsd(req, aero))).toBeGreaterThan(Number(comparableNetUsd(req, flash)));
  });

  it("takes off gas the user pays, and values a sale in USDC", () => {
    expect(comparableNetUsd(req, quote({ expectedOut: "10", gasUsd: "0.5" }))).toBe("1529.5");
    expect(comparableNetUsd({ ...req, side: "sell", usdcIn: undefined, qtyIn: "1" }, quote({ expectedOut: "152.4" }))).toBe("152.4");
  });

  it("leaves cross-chain quotes as the route valued them", () => {
    expect(comparableNetUsd(req, quote({ crossChain: true, netOutputUsd: "4900", expectedOut: "40" }))).toBe("4900");
  });
});

describe("Aero swap sanity", () => {
  it("only signs a call to Aero's router that pays this wallet", () => {
    const data = `0xac9650d8${"00".repeat(40)}${wallet.slice(2)}${"00".repeat(8)}`;
    expect(() => assertAeroSwap({ to: AERO_BASE.swapRouter, data }, wallet)).not.toThrow();
    expect(() => assertAeroSwap({ to: "0x6fF5693b99212Da76ad316178A184AB56D299b43", data }, wallet)).toThrow(/Aero's router/);
    expect(() => assertAeroSwap({ to: AERO_BASE.swapRouter, data: "0xac9650d8" }, wallet)).toThrow(/pay this wallet/);
  });
});
