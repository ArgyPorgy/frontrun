import {
  D,
  devLoginSchema,
  paperWithdrawSchema,
  pushSubscribeSchema,
  updateProfileSchema,
  type BalanceView,
} from "@frontrun/core";
import {
  AppError,
  buildMe,
  buildPortfolio,
  db,
  env,
  isPaperMode,
  listBlocks,
  paperDeposit,
  paperWithdraw,
  schema,
  updateProfile,
  usdcBalance,
} from "@frontrun/server";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ensureWallets, issueDevToken, requireUser } from "../auth";

async function balanceView(userId: string): Promise<BalanceView> {
  const b = await usdcBalance(userId);
  return { usdc: b.usdc, spendable: b.spendable, withdrawable: b.withdrawable, mode: isPaperMode() ? "paper" : "live" };
}

export async function registerMeRoutes(app: FastifyInstance) {
  app.post("/v1/auth/dev", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    if (env().AUTH_MODE !== "dev") throw new AppError(404, "not_found", "Not found.");
    const { handle } = devLoginSchema.parse(req.body);
    return { token: await issueDevToken(`dev:${handle.toLowerCase()}`) };
  });

  app.get("/v1/me", async (req) => {
    const user = await requireUser(req);
    const wallets = await db().select().from(schema.wallets).where(eq(schema.wallets.userId, user.id));
    if (!wallets.length) await ensureWallets(user);
    return buildMe(user);
  });

  app.post("/v1/me/sync", async (req) => {
    const user = await requireUser(req);
    await ensureWallets(user);
    return buildMe(user);
  });

  app.patch("/v1/me", async (req) => {
    const user = await requireUser(req);
    const patch = updateProfileSchema.parse(req.body);
    const updated = await updateProfile(user, patch);
    return buildMe(updated);
  });

  app.get("/v1/me/balance", async (req) => {
    const user = await requireUser(req);
    return balanceView(user.id);
  });

  app.get("/v1/me/blocks", async (req) => {
    const user = await requireUser(req);
    return { items: await listBlocks(user.id) };
  });

  app.get("/v1/portfolio", async (req) => {
    const user = await requireUser(req);
    return buildPortfolio(user.id);
  });

  app.post("/v1/push/subscribe", async (req, reply) => {
    const user = await requireUser(req);
    const body = pushSubscribeSchema.parse(req.body);
    await db()
      .insert(schema.pushSubscriptions)
      .values({ userId: user.id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
      .onConflictDoUpdate({ target: schema.pushSubscriptions.endpoint, set: { userId: user.id, p256dh: body.keys.p256dh, auth: body.keys.auth } });
    reply.status(204).send();
  });

  app.delete("/v1/push/subscribe", async (req, reply) => {
    const user = await requireUser(req);
    const { endpoint } = req.query as { endpoint?: string };
    if (endpoint) {
      await db().delete(schema.pushSubscriptions).where(and(eq(schema.pushSubscriptions.userId, user.id), eq(schema.pushSubscriptions.endpoint, endpoint)));
    }
    reply.status(204).send();
  });

  app.post("/v1/paper/deposit", async (req) => {
    if (!isPaperMode()) throw new AppError(404, "not_found", "Not found.");
    const user = await requireUser(req);
    await paperDeposit(user.id);
    return balanceView(user.id);
  });

  app.post("/v1/paper/withdraw", async (req) => {
    if (!isPaperMode()) throw new AppError(404, "not_found", "Not found.");
    const user = await requireUser(req);
    const body = paperWithdrawSchema.parse(req.body);
    await paperWithdraw(user.id, body.amountUsd);
    return balanceView(user.id);
  });
}
