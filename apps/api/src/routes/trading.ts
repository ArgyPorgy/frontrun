import { executeTradeSchema, isValidAddress, quoteRequestSchema, submitStepsSchema, type Page, type TradeView } from "@frontrun/core";
import {
  AppError,
  createQuote,
  db,
  executeTrade,
  notFound,
  schema,
  submitWalletSteps,
  tokenRefFor,
  tradeToView,
} from "@frontrun/server";
import { and, desc, eq, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth";

export async function registerTradingRoutes(app: FastifyInstance) {
  app.post("/v1/quotes", { config: { rateLimit: { max: 90, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const body = quoteRequestSchema.parse(req.body);
    if (!isValidAddress(body.chain, body.address)) throw new AppError(400, "invalid_address", "That isn't a valid token address.");
    return createQuote(user.id, body);
  });

  app.post("/v1/trades", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    return executeTrade(user.id, executeTradeSchema.parse(req.body));
  });

  app.post("/v1/trades/:id/steps", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { results } = submitStepsSchema.parse(req.body);
    return submitWalletSteps(user.id, id, results);
  });

  app.get("/v1/trades/:id", async (req) => {
    const user = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db().query.trades.findFirst({ where: and(eq(schema.trades.id, id), eq(schema.trades.userId, user.id)) });
    if (!row) throw notFound("Trade");
    return tradeToView(row, await tokenRefFor(row.tokenChain, row.tokenAddr));
  });

  app.get("/v1/trades", async (req): Promise<Page<TradeView>> => {
    const user = await requireUser(req);
    const { cursor } = z.object({ cursor: z.string().datetime().optional() }).parse(req.query);
    const rows = await db()
      .select()
      .from(schema.trades)
      .where(and(eq(schema.trades.userId, user.id), cursor ? lt(schema.trades.createdAt, new Date(cursor)) : undefined))
      .orderBy(desc(schema.trades.createdAt))
      .limit(31);
    const page = rows.slice(0, 30);
    return {
      items: await Promise.all(page.map(async (r) => tradeToView(r, await tokenRefFor(r.tokenChain, r.tokenAddr)))),
      nextCursor: rows.length > 30 ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  });
}
