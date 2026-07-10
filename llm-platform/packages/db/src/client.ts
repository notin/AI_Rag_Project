import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { getEnv } from '@app/shared';

const env = getEnv();

const isSupabase = env.DATABASE_URL.includes('supabase.com');

/**
 * Raw postgres.js connection — used by Drizzle and for migrations.
 *
 * Pool / pooler settings:
 *   - prepare: false — required by Supabase's PgBouncer (transaction mode)
 *   - ssl: 'require' — only when DATABASE_URL points at Supabase
 *   - max: 5 — keep the pool small (Supabase free tier is connection-limited)
 */
const sql = postgres(env.DATABASE_URL, {
  max: 5,
  prepare: false,
  idle_timeout: 20,
  connect_timeout: 10,
  ...(isSupabase ? { ssl: 'require' as const } : {}),
});

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
