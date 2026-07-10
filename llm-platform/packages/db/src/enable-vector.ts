// Enable pgvector extension on Supabase before running migrations.
// Usage: pnpm db:enable-vector  (from llm-platform root)

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const isSupabase = databaseUrl.includes('supabase.com');

const sql = postgres(databaseUrl, {
  max: 1,
  prepare: false,
  ...(isSupabase ? { ssl: 'require' as const } : {}),
});

async function main() {
  console.log('Enabling pgvector extension...');
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  console.log('✅ pgvector extension enabled.');
  await sql.end();
}

main().catch((err) => {
  console.error('Failed to enable pgvector:', err);
  process.exit(1);
});
