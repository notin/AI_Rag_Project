// ─── Migration runner ───────────────────────────────────────────────────────
// Run with: pnpm db:migrate  (from llm-platform root)
// Applies all SQL files in the ./drizzle folder in order.

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load env before importing the DB client (getEnv runs at module init).
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const { migrate } = await import('drizzle-orm/postgres-js/migrator');
const { db, closeDb } = await import('./client.js');

async function main() {
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  await closeDb();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
