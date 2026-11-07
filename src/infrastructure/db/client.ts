import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { schema } from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  driver: "pg" | "pglite";
  close(): Promise<void>;
}

/** backend/drizzle — resolves the same from src/ (vitest) and dist/ (node). */
export const MIGRATIONS_DIR = path.resolve(__dirname, "../../..", "drizzle");

export async function connectDb(opts: { driver: "pg" | "pglite"; url?: string; pgliteDir?: string }): Promise<DbHandle> {
  if (opts.driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = await PGlite.create(opts.pgliteDir ?? "memory://");
    return { db: drizzle(client, { schema }) as unknown as Db, driver: "pglite", close: () => client.close() };
  }
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({ connectionString: opts.url, max: 10 });
  return { db: drizzle(pool, { schema }) as unknown as Db, driver: "pg", close: () => pool.end() };
}

export async function migrateDb(handle: DbHandle): Promise<void> {
  if (handle.driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  }
}
