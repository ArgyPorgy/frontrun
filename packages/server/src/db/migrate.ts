import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./client";

function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Bundled apps carry their migrations next to the bundle. In source they live with this package.
  const bundled = join(here, "drizzle");
  return existsSync(bundled) ? bundled : join(here, "../../drizzle");
}

export async function runMigrations() {
  await migrate(db(), { migrationsFolder: migrationsFolder() });
}
