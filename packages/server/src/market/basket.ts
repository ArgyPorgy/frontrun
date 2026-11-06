import { D, type BasketToken, type ChainKey } from "@frontrun/core";
import { cachedJson } from "../redis";
import { getTokenDetail, marketList } from "./service";

const TRENDING_SLOTS = 6;

/** The mix on the landing page's ticker. Trending fills in around these. */
const CURATED: Array<{ group: BasketToken["group"]; chain: ChainKey; address: string; symbol?: string }> = [
  { group: "stock", chain: "robinhood", address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec" },
  { group: "crypto", chain: "ethereum", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", symbol: "BTC" },
  { group: "meme", chain: "ethereum", address: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
  { group: "stock", chain: "robinhood", address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d" },
  { group: "crypto", chain: "ethereum", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "ETH" },
  { group: "meme", chain: "solana", address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { group: "stock", chain: "robinhood", address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9" },
  { group: "crypto", chain: "solana", address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  { group: "meme", chain: "solana", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { group: "currency", chain: "ethereum", address: "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c" },
];

/** Puts one trending token after every few curated ones, so the groups stay mixed. */
export function mixBasket(curated: BasketToken[], trending: BasketToken[]): BasketToken[] {
  const out: BasketToken[] = [];
  let next = 0;
  curated.forEach((token, i) => {
    out.push(token);
    if ((i + 1) % 2 === 0 && next < trending.length) out.push(trending[next++]!);
  });
  return [...out, ...trending.slice(next)];
}

/** Only tokens with a real logo make it in. A token that can't be read right now just sits this round out. */
export async function tokenBasket(): Promise<{ items: BasketToken[] }> {
  return cachedJson("market:basket", 60, async () => {
    const details = await Promise.allSettled(CURATED.map((t) => getTokenDetail(t.chain, t.address, { allowStale: true })));
    const curated: BasketToken[] = [];
    details.forEach((result, i) => {
      const entry = CURATED[i]!;
      if (result.status !== "fulfilled" || !result.value?.imageUrl) return;
      const { symbol, imageUrl, priceChangePct } = result.value;
      curated.push({ group: entry.group, chain: entry.chain, address: entry.address, symbol: entry.symbol ?? symbol, imageUrl, change24h: D(priceChangePct.h24 ?? 0).toNumber() });
    });
    const taken = new Set(curated.map((t) => t.symbol.toUpperCase()));
    const listed = await marketList("trending", undefined).catch(() => []);
    const trending: BasketToken[] = [];
    for (const t of listed) {
      if (!t.imageUrl || taken.has(t.symbol.toUpperCase())) continue;
      taken.add(t.symbol.toUpperCase());
      trending.push({ group: "trending", chain: t.chain, address: t.address, symbol: t.symbol, imageUrl: t.imageUrl, change24h: t.priceChangePct.h24 });
      if (trending.length === TRENDING_SLOTS) break;
    }
    return { items: mixBasket(curated, trending) };
  });
}
