import { chainKeySchema, isValidAddress, normalizeAddress, timeframeSchema, type ChainKey } from "@frontrun/core";
import {
  GECKO_ATTRIBUTION,
  AppError,
  getCandles,
  getSnapshot,
  getTape,
  getTokenDetail,
  markActive,
  marketList,
  notFound,
  positionForToken,
  searchTokens,
} from "@frontrun/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth";

const tokenParams = z.object({ chain: chainKeySchema, address: z.string().min(16).max(64) });

function parseToken(params: unknown): { chain: ChainKey; address: string } {
  const { chain, address } = tokenParams.parse(params);
  if (!isValidAddress(chain, address)) throw new AppError(400, "invalid_address", "That isn't a valid token address.");
  return { chain, address: normalizeAddress(chain, address) };
}

export async function registerMarketRoutes(app: FastifyInstance) {
  app.get("/v1/market/tokens", async (req) => {
    const query = z.object({ tab: z.enum(["trending", "new"]).default("trending"), chain: chainKeySchema.optional() }).parse(req.query);
    return { items: await marketList(query.tab, query.chain), attribution: GECKO_ATTRIBUTION };
  });

  app.get("/v1/market/search", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const query = z.object({ q: z.string().min(1).max(80), chain: chainKeySchema.optional() }).parse(req.query);
    return { items: await searchTokens(query.q, query.chain) };
  });

  app.get("/v1/tokens/:chain/:address", async (req) => {
    const { chain, address } = parseToken(req.params);
    const detail = await getTokenDetail(chain, address, { allowStale: true });
    if (!detail) throw notFound("Token");
    await markActive(chain, address);
    return detail;
  });

  app.get("/v1/tokens/:chain/:address/candles", async (req) => {
    const { chain, address } = parseToken(req.params);
    const { tf } = z.object({ tf: timeframeSchema.default("15m") }).parse(req.query);
    const snap = await getSnapshot(chain, address, { allowStale: true });
    if (!snap?.pairAddress) return { candles: [], attribution: GECKO_ATTRIBUTION };
    return { candles: await getCandles(chain, snap.pairAddress, tf), attribution: GECKO_ATTRIBUTION };
  });

  app.get("/v1/tokens/:chain/:address/trades", async (req) => {
    const { chain, address } = parseToken(req.params);
    const snap = await getSnapshot(chain, address, { allowStale: true });
    if (!snap?.pairAddress) return { items: [] };
    return { items: await getTape(chain, snap.pairAddress) };
  });

  app.get("/v1/tokens/:chain/:address/position", async (req) => {
    const user = await requireUser(req);
    const { chain, address } = parseToken(req.params);
    return { position: await positionForToken(user.id, chain, address) };
  });
}
