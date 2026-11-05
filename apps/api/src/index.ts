import { closeDb, closeRedis, env, logger, runMigrations } from "@frontrun/server";
import { buildApp } from "./app";
import { attachWebsocket } from "./ws";

async function main() {
  const e = env();
  await runMigrations();
  const app = await buildApp();
  await app.ready();
  const closeWs = await attachWebsocket(app);
  await app.listen({ port: e.API_PORT, host: "0.0.0.0" });
  logger.info({ port: e.API_PORT, tradingMode: e.TRADING_MODE, authMode: e.AUTH_MODE }, "api listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await closeWs();
    await app.close();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
