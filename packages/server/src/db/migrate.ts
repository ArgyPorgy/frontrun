import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { env } from "../env";
import { db } from "./client";

function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled apps carry their migrations next to the bundle. In source they live with this package.
  const bundled = join(here, "drizzle");
  return existsSync(bundled) ? bundled : join(here, "../../drizzle");
}

/** Any fixed number works, as long as everything migrating this database uses the same one. */
const MIGRATION_LOCK = 7_204_517;

/**
 * The API and the workers both migrate on boot. Without a lock, a new migration runs twice at once and
 * the loser crashes on "column already exists". The lock lasts as long as this connection does.
 */
export async function runMigrations() {
  const lock = new pg.Client({ connectionString: env().DATABASE_URL });
  await lock.connect();
  try {
    await lock.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await migrate(db(), { migrationsFolder: migrationsFolder() });
  } finally {
    await lock.end();
  }
}
