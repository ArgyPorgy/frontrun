import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { createHash } from "node:crypto";
import { AppError, DexBusyError, GeckoBusyError, HttpError, env, logger, redis } from "@frontrun/server";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { registerMarketRoutes } from "./routes/market";
import { registerMeRoutes } from "./routes/me";
import { registerSignerRoutes } from "./routes/signer";
import { registerSocialRoutes } from "./routes/social";
import { registerThesisRoutes } from "./routes/theses";
import { registerTradingRoutes } from "./routes/trading";
import { registerSystemRoutes } from "./routes/system";

/** Limits are per signed-in user when there's a token, and per IP otherwise. */
function rateKey(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth) return `t:${createHash("sha256").update(auth).digest("hex").slice(0, 24)}`;
  return `ip:${req.ip}`;
}

function geoBlocked(req: FastifyRequest): boolean {
  const list = env().GEO_BLOCKED_COUNTRIES.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!list.length) return false;
  const country = req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"] ?? req.headers["fly-client-country"];
  return typeof country === "string" && list.includes(country.toUpperCase());
}

export async function buildApp(): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: e.NODE_ENV === "test" ? false : { level: e.LOG_LEVEL, redact: ["req.headers.authorization"] },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } });
  await app.register(cors, {
    origin: e.APP_ORIGIN.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"],
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    redis: redis(),
    nameSpace: "rl:",
    keyGenerator: rateKey,
    errorResponseBuilder: (_req, ctx) => {
      const err = new AppError(429, "rate_limited", `Too many requests. Try again in ${ctx.after}.`);
      return err;
    },
  });

  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/health") || req.url.startsWith("/internal")) return;
    if (geoBlocked(req)) throw new AppError(451, "geo_blocked", "This service isn't available in your region.");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      const message = err.issues[0]?.message ?? "Invalid request.";
      reply.status(400).send({ error: { code: "invalid_request", message, details: err.issues } });
      return;
    }
    if (err instanceof GeckoBusyError || err instanceof DexBusyError) {
      reply.status(503).send({ error: { code: "market_data_busy", message: "Market data is catching up. Try again shortly." } });
      return;
    }
    if (err instanceof HttpError) {
      logger.warn({ url: req.url, upstream: err.message }, "upstream error");
      const status = err.status === 429 ? 503 : 502;
      reply.status(status).send({ error: { code: "upstream_error", message: "A data provider is having trouble. Try again shortly." } });
      return;
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      reply.status(statusCode).send({ error: { code: "bad_request", message: (err as Error).message } });
      return;
    }
    logger.error({ err, url: req.url }, "unhandled error");
    reply.status(500).send({ error: { code: "internal", message: "Something went wrong on our side." } });
  });

  await registerSystemRoutes(app);
  await registerMeRoutes(app);
  await registerMarketRoutes(app);
  await registerTradingRoutes(app);
  await registerSignerRoutes(app);
  await registerThesisRoutes(app);
  await registerSocialRoutes(app);
  return app;
}
