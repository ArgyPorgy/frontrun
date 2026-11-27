import { lendingActionSchema } from "@frontrun/core";
import { findByUsername, lendingMarket, lendingMarkets, lendingSummary, listLendingActions, notFound, performLendingAction, previewLendingAction } from "@frontrun/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTrader, requireUser } from "../auth";

/** Lending on Base through Aave and Morpho. Markets are public, and so are positions, like every other position here. */
export async function registerLendingRoutes(app: FastifyInstance) {
  app.get("/v1/lending/markets", async () => ({ items: await lendingMarkets() }));

  app.get("/v1/lending/markets/:id", async (req) => {
    const { id } = z.object({ id: z.string().min(3).max(80) }).parse(req.params);
    const market = await lendingMarket(id);
    if (!market) throw notFound("That market");
    return market;
  });

  app.get("/v1/lending/me", async (req) => {
    const user = await requireUser(req);
    return lendingSummary(user.id);
  });

  app.get("/v1/lending/actions", async (req) => {
    const user = await requireUser(req);
    return { items: await listLendingActions(user.id) };
  });

  app.post("/v1/lending/preview", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireTrader(req);
    return previewLendingAction(user.id, lendingActionSchema.parse(req.body));
  });

  app.post("/v1/lending/actions", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const user = await requireTrader(req);
    return performLendingAction(user.id, lendingActionSchema.parse(req.body));
  });

  app.get("/v1/users/:username/lending", async (req) => {
    const { username } = z.object({ username: z.string().min(1).max(32) }).parse(req.params);
    const user = await findByUsername(username);
    if (!user || user.isBanned) throw notFound("User");
    const [summary, actions] = await Promise.all([lendingSummary(user.id), listLendingActions(user.id, 20)]);
    // The wallet's idle USDC and stock holdings stay private here. Lending positions and moves are public.
    return { positions: summary.positions, totalSuppliedUsd: summary.totalSuppliedUsd, totalBorrowedUsd: summary.totalBorrowedUsd, actions: actions.filter((a) => a.status === "done") };
  });
}
