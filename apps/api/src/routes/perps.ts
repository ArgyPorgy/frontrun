import {
  perpCloseSchema,
  perpMarginSchema,
  perpOpenSchema,
  perpTpSlSchema,
} from "@frontrun/core";
import {
  badRequest,
  closePerp,
  listPerps,
  notFound,
  openPerp,
  perpCandles,
  perpMarket,
  perpMarkets,
  updatePerpMargin,
  updatePerpTpSl,
} from "@frontrun/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTrader, requireUser } from "../auth";

const assetClasses = [
  "crypto",
  "equity",
  "fx",
  "metal",
  "commodity",
  "index",
  "other",
] as const;

/** Perpetuals on Veranta, on Base. Markets are public; positions belong to the signed-in person. */
export async function registerPerpRoutes(app: FastifyInstance) {
  app.get("/v1/perps/markets", async (req) => {
    const q = z
      .object({
        assetClass: z.enum(assetClasses).optional(),
        q: z.string().max(40).optional(),
      })
      .parse(req.query);
    return {
      items: await perpMarkets({ assetClass: q.assetClass, query: q.q }),
    };
  });

  app.get("/v1/perps/markets/:pairIndex", async (req) => {
    const { pairIndex } = z
      .object({ pairIndex: z.coerce.number().int().min(0) })
      .parse(req.params);
    const market = await perpMarket(pairIndex);
    if (!market) throw notFound("That market");
    return market;
  });

  app.get("/v1/perps/markets/:pairIndex/candles", async (req) => {
    const { pairIndex } = z
      .object({ pairIndex: z.coerce.number().int().min(0) })
      .parse(req.params);
    const { tf } = z
      .object({
        tf: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("15m"),
      })
      .parse(req.query);
    return { items: await perpCandles(pairIndex, tf) };
  });

  app.get("/v1/perps/positions", async (req) => {
    const user = await requireUser(req);
    const { status } = z
      .object({ status: z.enum(["open", "closed"]).optional() })
      .parse(req.query);
    return { items: await listPerps(user.id, { status }) };
  });

  app.post(
    "/v1/perps/positions",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const user = await requireTrader(req);
      return openPerp(user.id, perpOpenSchema.parse(req.body));
    },
  );

  app.post(
    "/v1/perps/positions/:id/close",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const user = await requireUser(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { percent } = perpCloseSchema.parse(req.body ?? {});
      return closePerp(user.id, id, percent);
    },
  );

  app.put("/v1/perps/positions/:id/tpsl", async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return updatePerpTpSl(user.id, id, perpTpSlSchema.parse(req.body));
  });

  app.post("/v1/perps/positions/:id/margin", async (req) => {
    const user = await requireTrader(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = perpMarginSchema.parse(req.body);
    if (!body.amountUsd) throw badRequest("invalid_amount", "Enter an amount.");
    return updatePerpMargin(user.id, id, body.action, body.amountUsd);
  });
}
