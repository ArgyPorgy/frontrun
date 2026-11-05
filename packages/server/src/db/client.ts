import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let instance: Db | undefined;

export function db(): Db {
  if (!instance) {
    pool = new pg.Pool({ connectionString: env().DATABASE_URL, max: 20, idleTimeoutMillis: 30_000 });
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
