// ─── Migration runner ───────────────────────────────────────────────────────
// Run with: pnpm db:migrate  (from llm-platform root)
//
// Applies SQL files from ./drizzle in journal order using a single postgres.js
// connection. Avoids drizzle-orm's migrator import, which OOMs under tsx on
// some Windows/Node setups when talking to Supabase's transaction pooler.

import { createHash } from 'crypto';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const databaseUrl: string = process.env.DATABASE_URL ?? '';
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const isSupabase = databaseUrl.includes('supabase.com');
const migrationsFolder = resolve(__dirname, '../drizzle');

type Journal = {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

async function main() {
  console.log('Connecting...');
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    ...(isSupabase ? { ssl: 'require' as const } : {}),
  });

  try {
    // Same ledger table drizzle-orm's migrator uses, so tools stay compatible.
    await sql`
      CREATE SCHEMA IF NOT EXISTS drizzle
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `;

    const journal = JSON.parse(
      readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as Journal;

    const applied = await sql<{ hash: string }[]>`
      SELECT hash FROM drizzle.__drizzle_migrations
    `;
    const appliedHashes = new Set(applied.map((r) => r.hash));

    for (const entry of journal.entries) {
      const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
      const body = readFileSync(sqlPath, 'utf8');
      const hash = createHash('sha256').update(body).digest('hex');

      if (appliedHashes.has(hash)) {
        console.log(`⏭  ${entry.tag} (already applied)`);
        continue;
      }

      console.log(`▶  ${entry.tag}`);
      const statements = body
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await sql.unsafe(statement);
      }

      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
      console.log(`✅ ${entry.tag}`);
    }

    console.log('Migrations complete.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
