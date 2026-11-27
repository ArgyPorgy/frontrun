import type { ChainKey } from "@frontrun/core";
import { fetchJson } from "../http";

/**
 * DefiLlama's free price API, keyless. It's the backup for a price DexScreener doesn't have, so a holding still
 * shows a value. It has no candles fine enough for charts, so it isn't used for those.
 */
const BASE = "https://coins.llama.fi";

/** DefiLlama's chain names. Chains it doesn't track are left out, and their tokens just stay unpriced. */
const LLAMA_CHAIN: Partial<Record<ChainKey, string>> = {
  base: "base",
  ethereum: "ethereum",
  arbitrum: "arbitrum",
  bsc: "bsc",
  hyperevm: "hyperliquid",
  solana: "solana",
};

/** A price older than this, or one DefiLlama itself isn't sure of, isn't used. */
const MAX_AGE_S = 3600;
const MIN_CONFIDENCE = 0.9;
const BATCH = 50;

/** Prices for "chain:address" keys, as USD strings. Keys it can't price are simply missing. */
export async function llamaPrices(keys: string[], now = Date.now()): Promise<Map<string, string>> {
  const asked = keys.flatMap((k) => {
    const [chain, address] = k.split(":") as [ChainKey, string];
    const slug = LLAMA_CHAIN[chain];
    return slug && address ? [{ key: k, id: `${slug}:${address}` }] : [];
  });
  const out = new Map<string, string>();
  for (let i = 0; i < asked.length; i += BATCH) {
    const batch = asked.slice(i, i + BATCH);
    const data = await fetchJson<{ coins?: Record<string, { price?: number; timestamp?: number; confidence?: number }> }>(
      `${BASE}/prices/current/${batch.map((b) => b.id).join(",")}`,
      { timeoutMs: 5_000 },
    );
    const coins = new Map(Object.entries(data.coins ?? {}).map(([id, c]) => [id.toLowerCase(), c]));
    for (const b of batch) {
      const c = coins.get(b.id.toLowerCase());
      if (!c?.price || c.price <= 0) continue;
      if ((c.confidence ?? 1) < MIN_CONFIDENCE) continue;
      if (c.timestamp && now / 1000 - c.timestamp > MAX_AGE_S) continue;
      out.set(b.key, String(c.price));
    }
  }
  return out;
}
