import type { ProviderId } from "@frontrun/core";
import { flashProvider } from "./flash";
import { lifiProvider } from "./lifi";
import { paperProvider } from "./paper";
import type { RouteProvider, RouteRequest } from "./types";
import { uniswapDirectProvider, uniswapProvider } from "./uniswap";

export const PROVIDERS: Record<ProviderId, RouteProvider> = {
  flash: flashProvider,
  uniswap: uniswapProvider,
  uniswap_direct: uniswapDirectProvider,
  lifi: lifiProvider,
  paper: paperProvider,
};

/** Arc: Uniswap against Flash. Other chains: Flash first, LI.FI as the fallback. */
export function providersFor(req: RouteRequest): RouteProvider[] {
  const order: ProviderId[] = req.chain === "arc" ? ["uniswap", "uniswap_direct", "flash"] : ["flash", "lifi"];
  return order.map((id) => PROVIDERS[id]).filter((p) => p.enabled() && p.supports(req));
}

export function providerAvailability(): Record<ProviderId, boolean> {
  return {
    flash: flashProvider.enabled(),
    uniswap: uniswapProvider.enabled(),
    uniswap_direct: uniswapDirectProvider.enabled(),
    lifi: lifiProvider.enabled(),
    paper: false,
  };
}

export * from "./types";
export * from "./flash";
export * from "./lifi";
export * from "./paper";
export * from "./uniswap";
