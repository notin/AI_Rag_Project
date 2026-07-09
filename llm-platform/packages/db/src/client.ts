import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { getEnv } from '@app/shared';

const env = getEnv();

/**
 * Raw postgres.js connection — used by Drizzle and for migrations.
 * Max 10 connections; adjust if the worker pool needs more.
 */
const sql = postgres(env.DATABASE_URL, { max: 10 });

/**
 * Drizzle ORM instance — the single entry-point for all DB operations.
 * Schema is attached so relational queries and type inference work.
 */
export const db = drizzle(sql, { schema });

/**
 * Gracefully close the connection pool.
 * Call this in scripts/tests that need a clean shutdown.
 */
export async function closeDb() {
  await sql.end();
}
