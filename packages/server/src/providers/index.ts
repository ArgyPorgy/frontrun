import { HOME_CHAIN } from "@frontrun/core";
import type { ProviderId } from "@frontrun/core";
import { aeroProvider } from "./aero";
import { flashProvider } from "./flash";
import { lifiProvider } from "./lifi";
import { paperProvider } from "./paper";
import type { RouteProvider, RouteRequest } from "./types";
import { uniswapDirectProvider, uniswapProvider } from "./uniswap";

export const PROVIDERS: Record<ProviderId, RouteProvider> = {
  flash: flashProvider,
  uniswap: uniswapProvider,
  uniswap_direct: uniswapDirectProvider,
  aero: aeroProvider,
  lifi: lifiProvider,
  paper: paperProvider,
};

/** The home chain: Uniswap and Aero (stock tokens) against Flash, where the swap is the user's own transaction. Elsewhere: Flash, LI.FI as the fallback. */
export function providersFor(req: RouteRequest): RouteProvider[] {
  const order: ProviderId[] = req.chain === HOME_CHAIN && !req.contra ? ["uniswap", "aero", "flash"] : ["flash", "lifi"];
  return order.map((id) => PROVIDERS[id]).filter((p) => p.enabled() && p.supports(req));
}

export function providerAvailability(): Record<ProviderId, boolean> {
  return {
    flash: flashProvider.enabled(),
    uniswap: uniswapProvider.enabled(),
    uniswap_direct: uniswapDirectProvider.enabled(),
    aero: aeroProvider.enabled(),
    lifi: lifiProvider.enabled(),
    paper: false,
  };
}

export * from "./types";
export * from "./flash";
export * from "./lifi";
export * from "./paper";
export * from "./uniswap";
export * from "./aero";
