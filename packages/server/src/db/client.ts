import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import { logger } from "../logger";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let instance: Db | undefined;

export function db(): Db {
  if (!instance) {
    pool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 20, idleTimeoutMillis: 30_000 });
    // The pool drops a broken idle connection and opens another when it's next needed, but with no listener the error takes the whole process down.
    pool.on("error", (err: NodeJS.ErrnoException) => logger.warn({ code: err.code, err: err.message }, "Database connection lost"));
    instance = drizzle(pool, { schema });
  }
  return instance;
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
  instance = undefined;
}

export { schema };
