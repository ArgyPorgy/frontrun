import { APP_NAME, CAP_DEFAULTS, COPY_BUY_CAP_USD, FLASH_ALLOWANCE_ARC, ARC_USDC, type PublicConfig } from "@frontrun/core";
import { gaslessEnabled, db, env, providerAvailability, redis, schema, serverSigningConfigured } from "@frontrun/server";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

export async function registerSystemRoutes(app: FastifyInstance) {
  app.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      db().execute(sql`select 1`).then(() => true, () => false),
      redis().ping().then((r) => r === "PONG", () => false),
    ]);
    reply.status(dbOk && redisOk ? 200 : 503).send({ ok: dbOk && redisOk, db: dbOk, redis: redisOk });
  });

  app.get("/v1/config", async (): Promise<PublicConfig> => {
    const e = env();
    return {
      appName: APP_NAME,
      tradingMode: e.TRADING_MODE,
      authMode: e.AUTH_MODE,
      privyAppId: e.PRIVY_APP_ID ?? null,
      signerId: serverSigningConfigured() ? (e.PRIVY_SIGNER_ID ?? null) : null,
      gasless: gaslessEnabled(),
      policyIds: e.PRIVY_POLICY_IDS?.split(",").map((p) => p.trim()).filter(Boolean) ?? [],
      solanaPolicyIds: e.PRIVY_SOLANA_POLICY_IDS?.split(",").map((p) => p.trim()).filter(Boolean) ?? [],
      vapidPublicKey: e.VAPID_PUBLIC_KEY ?? null,
      integratorFeeBps: e.FLASH_INTEGRATOR_FEE_BPS,
      providers: providerAvailability(),
      caps: { perTradeUsd: CAP_DEFAULTS.perTradeUsd, dailyUsd: CAP_DEFAULTS.dailyUsd, grantDays: CAP_DEFAULTS.grantDays },
      copyBuyCapUsd: COPY_BUY_CAP_USD,
      flashSpender: FLASH_ALLOWANCE_ARC,
      bridgeUrlTemplate: `https://jumper.exchange/?toChain=5042&toToken=${ARC_USDC}&toAddress={address}`,
    };
  });

  /** Per-provider quote latency and fill rate, for the dashboards the plan calls for. */
  app.get("/internal/metrics", async (req, reply) => {
    const token = env().ADMIN_TOKEN;
    if (!token || req.headers["x-admin-token"] !== token) {
      reply.status(404).send({ error: { code: "not_found", message: "Not found." } });
      return;
    }
    const rows = await db()
      .select({
        provider: schema.providerEvents.provider,
        quotesOk: sql<number>`count(*) filter (where kind = 'quote_ok')::int`,
        quoteErrors: sql<number>`count(*) filter (where kind = 'quote_error')::int`,
        fills: sql<number>`count(*) filter (where kind = 'fill')::int`,
        fails: sql<number>`count(*) filter (where kind = 'fail')::int`,
        p50LatencyMs: sql<number>`percentile_cont(0.5) within group (order by latency_ms) filter (where kind = 'quote_ok')`,
        p95LatencyMs: sql<number>`percentile_cont(0.95) within group (order by latency_ms) filter (where kind = 'quote_ok')`,
      })
      .from(schema.providerEvents)
      .where(sql`created_at > now() - interval '24 hours'`)
      .groupBy(schema.providerEvents.provider);
    return { windowHours: 24, providers: rows };
  });
}
