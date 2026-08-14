import { config } from 'dotenv';
import { resolve } from 'path';
import { defineConfig } from 'drizzle-kit';

// Load .env from the monorepo root
config({ path: resolve(__dirname, '../../.env') });

export default defineConfig({
  out: './drizzle',
  // Both files, or drizzle-kit silently emits nothing for the graph tables.
  // Built output, not src: drizzle-kit loads the schema through CJS require and
  // cannot map a `.js` specifier back onto a `.ts` file. Run `pnpm build` first.
  schema: ['./dist/schema.js', './dist/graph/schema.js'],
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
