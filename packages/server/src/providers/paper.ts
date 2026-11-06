import { D } from "@frontrun/core";
import type { ProviderQuote, RouteProvider, RouteRequest, StatusUpdate } from "./types";
import { isCrossChain } from "./types";

/**
 * Used only in paper mode, when no real provider can quote a route. It estimates from the live price
 * and pool depth, so paper trading still works with no provider keys. In paper mode real quotes win
 * whenever they exist, and every fill, whichever provider quoted it, is simulated.
 */
export function syntheticQuote(req: RouteRequest, liquidityUsd: string | null): ProviderQuote {
  const notional = D(req.notionalUsd);
  const liquidity = D(liquidityUsd ?? 0);
  const impact = liquidity.gt(0) ? Math.min(notional.div(liquidity.mul(2)).toNumber(), 0.5) : 0.01;
  const feeRate = 0.003;
  const net = notional.mul(1 - impact - feeRate);
  const price = D(req.priceUsd);
  return {
    provider: "paper",
    netOutputUsd: net.toFixed(),
    expectedOut: req.side === "buy" ? (price.gt(0) ? net.div(price).toFixed() : "0") : net.toFixed(),
    feeUsd: notional.mul(feeRate).toFixed(),
    gasUsd: "0",
    etaSeconds: isCrossChain(req) ? 4 : 1,
    priceImpact: impact,
    recommendedSlippage: null,
    crossChain: isCrossChain(req),
    needsSetup: false,
    sponsoredSetup: false,
    latencyMs: 0,
    raw: { synthetic: true },
  };
}

/** Fills at exactly what the winning quote promised. */
export function paperFill(req: RouteRequest, quote: ProviderQuote): StatusUpdate {
  const out = D(quote.expectedOut);
  if (req.side === "buy") {
    return {
      status: "filled",
      qty: out.toFixed(),
      usdIn: req.usdcIn,
      priceUsd: out.gt(0) ? D(req.usdcIn!).div(out).toFixed() : undefined,
      feeUsd: quote.feeUsd,
      revenueUsd: quote.feeUsd,
    };
  }
  return {
    status: "filled",
    qty: req.qtyIn,
    usdOut: out.toFixed(),
    priceUsd: D(req.qtyIn!).gt(0) ? out.div(req.qtyIn!).toFixed() : undefined,
    feeUsd: quote.feeUsd,
    revenueUsd: quote.feeUsd,
  };
}

export const paperProvider: RouteProvider = {
  id: "paper",
  enabled: () => true,
  supports: () => true,
  quote: async () => {
    throw new Error("Paper quotes are built by the engine.");
  },
  advance: async () => ({ done: {} }),
  status: async () => ({ status: "pending" }),
};
