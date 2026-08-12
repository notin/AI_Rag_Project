import { config } from 'dotenv';
import { resolve } from 'path';
import { defineConfig } from 'drizzle-kit';

// Load .env from the monorepo root
config({ path: resolve(__dirname, '../../.env') });

export default defineConfig({
  out: './drizzle',
  // Both files, or drizzle-kit silently emits nothing for the graph tables.
  schema: ['./src/schema.ts', './src/graph/schema.ts'],
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
