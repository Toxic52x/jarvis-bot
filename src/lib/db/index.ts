import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";
import { logger } from "../logger";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// node-postgres emits 'error' on the pool whenever an idle client hits a
// backend error (e.g. Neon dropping an idle connection) — without this
// listener that's an unhandled EventEmitter error and crashes the process.
pool.on("error", (err) => {
  logger.error(
    { err },
    "Unexpected Postgres pool error — a connection was lost, but the pool will recover",
  );
});

export const db = drizzle(pool, { schema });

/**
 * Run all pending Drizzle migrations.
 * @param migrationsFolder Absolute path to the migrations directory.
 *   Callers must supply this because the path must survive bundling.
 */
export async function runMigrations(migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}

export * from "./schema";
